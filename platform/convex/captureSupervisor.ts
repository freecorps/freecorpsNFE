import { v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { deliverMail } from "./lib/accountMail";
import { certificateHead } from "./lib/certificateAccess";
import {
  ALERT_MAIL_HOURLY_LIMIT,
  SUPERVISION_INTERVAL,
  captureAlertDestination,
  raiseCaptureAlert,
  superviseCompany,
  supervisionFindings,
} from "./lib/captureSupervision";
import {
  CAPTURE_HOUR,
  captureAlertDelivery,
  captureAlertKind,
  captureState,
} from "./lib/captureValues";
import { baseEnvironment } from "./lib/environmentAccess";
import {
  captureFiscalHalted,
  captureRelease,
  fiscalCaptureEnabled,
} from "./lib/fiscalCaptureRelease";
import { DAY } from "./lib/operationalAudit";
import { closureOf } from "./lib/organizationClosure";

/**
 * The periodic check of a released company's production capture (#422,
 * `lib/captureSupervision.ts`). Each run consumes its generation, records what it finds as
 * Freecorps alerts (once per finding) and schedules the next run; a duplicate or stale run finds
 * another generation and does nothing. Withdrawn, purged, closed or off the hosted site, the
 * company stops being checked until a new release arms it again.
 *
 * The evaluation runs as a subtransaction (`evaluate`) with its own limits: an unexpected record,
 * a parse error or a read past the cap rolls back only it. The run still schedules the next one
 * and records the failure as a `capture_supervisor_error` log line and one `supervisor` alert per
 * failing streak, so the chain never stops in silence.
 */
export const check = internalMutation({
  args: { companyId: v.id("companies"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { companyId, generation }) => {
    const row = await ctx.db
      .query("captureSupervision")
      .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
      .unique();
    if (!row || row.generation !== generation) return null;
    const now = Date.now();
    const next = generation + 1;
    let outcome: "stop" | "checked" | "failed";
    let error = "";
    try {
      outcome = await ctx.runMutation(
        internal.captureSupervisor.evaluate,
        { companyId, organizationId: row.organizationId, now },
        { transactionLimits: EVALUATION_LIMITS },
      );
    } catch (thrown) {
      outcome = "failed";
      error = redactedError(thrown);
    }
    if (outcome === "stop") {
      await ctx.db.patch("captureSupervision", row._id, {
        generation: next,
        scheduledId: undefined,
        checkedAt: now,
        failingSince: undefined,
      });
      return null;
    }
    const scheduledId = await ctx.scheduler.runAfter(
      SUPERVISION_INTERVAL,
      internal.captureSupervisor.check,
      { companyId, generation: next },
    );
    const failingSince = outcome === "failed" ? (row.failingSince ?? generation) : undefined;
    await ctx.db.patch("captureSupervision", row._id, {
      generation: next,
      scheduledId,
      checkedAt: now,
      failingSince,
    });
    if (failingSince === undefined) return null;
    const signal = {
      organizationId: row.organizationId,
      companyId,
      generation,
      failingSince,
    };
    console.error(JSON.stringify({ type: "capture_supervisor_error", ...signal, error }));
    try {
      await ctx.runMutation(internal.captureSupervisor.reportFailure, signal);
    } catch (thrown) {
      console.error(
        JSON.stringify({
          type: "capture_supervisor_error",
          ...signal,
          stage: "alert",
          error: redactedError(thrown),
        }),
      );
    }
    return null;
  },
});

/** What one evaluation may consume, far above a company's few records, below the run's budget. */
const EVALUATION_LIMITS = {
  documentsRead: 1000,
  documentsWritten: 50,
  functionsScheduled: 20,
};
/** The error of a failed run for the log: one bounded line, with any CNPJ-shaped digits masked. */
function redactedError(thrown: unknown) {
  const message = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
  return message
    .replace(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g, "[cnpj]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

/**
 * The evaluation of one run of `check`, called only by it as a subtransaction: `stop` when the
 * company is no longer supervised; otherwise it raises the alerts of what it finds.
 */
export const evaluate = internalMutation({
  args: { companyId: v.id("companies"), organizationId: v.id("organizations"), now: v.number() },
  returns: v.union(v.literal("stop"), v.literal("checked")),
  handler: async (ctx, { companyId, organizationId, now }) => {
    const company = await ctx.db.get("companies", companyId);
    const release = company ? await captureRelease(ctx, company) : null;
    if (
      !company ||
      company.organizationId !== organizationId ||
      !release?.released ||
      baseEnvironment() !== "sandbox" ||
      (await closureOf(ctx, company.organizationId))
    )
      return "stop";
    for (const finding of await supervisionFindings(ctx, company, now))
      await raiseCaptureAlert(ctx, company, finding);
    return "checked";
  },
});

/** The alert of a failing check: one per streak of failed runs, which `failingSince` names. */
export const reportFailure = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    generation: v.number(),
    failingSince: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { organizationId, companyId, failingSince }) => {
    await raiseCaptureAlert(
      ctx,
      { _id: companyId, organizationId },
      {
        kind: "supervisor",
        key: `supervisor:${companyId}:${failingSince}`,
        code: "SUPERVISION_FAILED",
      },
    );
    return null;
  },
});

/** Companies the internal view reads, far above the releases expected. */
const SURVEY_LIMIT = 100;
/** Recent alerts shown per company. */
const SURVEY_ALERTS = 10;
const surveyAlert = v.object({
  kind: captureAlertKind,
  code: v.union(v.string(), v.null()),
  days: v.union(v.number(), v.null()),
  delivery: captureAlertDelivery,
  createdAt: v.number(),
});
const surveyCompany = v.object({
  organizationId: v.id("organizations"),
  companyId: v.id("companies"),
  name: v.string(),
  release: v.union(v.literal("released"), v.literal("withdrawn"), v.literal("blocked")),
  minIntervalHours: v.number(),
  releaseUpdatedAt: v.number(),
  stream: v.union(
    v.null(),
    v.object({
      id: v.id("captureStreams"),
      state: captureState,
      code: v.union(v.string(), v.null()),
      lastSuccessAt: v.union(v.number(), v.null()),
      lastAttemptAt: v.union(v.number(), v.null()),
      nextAllowedAt: v.number(),
      operationState: v.union(v.string(), v.null()),
      recovering: v.boolean(),
    }),
  ),
  certificate: v.union(v.null(), v.object({ own: v.boolean(), notAfter: v.number() })),
  supervision: v.object({
    armed: v.boolean(),
    checkedAt: v.union(v.number(), v.null()),
    /** The last runs failed to evaluate the company (`capture_supervisor_error`). */
    failing: v.boolean(),
  }),
  alerts: v.array(surveyAlert),
  /** Why part of the company could not be read, or null. */
  error: v.union(v.string(), v.null()),
});
const surveyValue = v.object({
  deployment: v.object({
    captureFiscal: v.boolean(),
    transport: v.boolean(),
    halted: v.boolean(),
    alertDestination: v.union(v.literal("email"), v.literal("unconfigured")),
  }),
  companies: v.array(surveyCompany),
  truncated: v.boolean(),
  /** Released companies whose check this call armed, because none was scheduled. */
  armed: v.number(),
  /** Alerts of the last 30 days on the deployment, by kind and code: the metric. */
  recent: v.array(v.object({ kind: captureAlertKind, code: v.string(), count: v.number() })),
  /** Alerts of the same 30 days whose e-mail the hourly ceiling held back. */
  suppressed: v.number(),
  recentPartial: v.boolean(),
});
const RECENT_LIMIT = 1000;

/**
 * Internal view of the site's fiscal capture for Freecorps (#422), read by
 * `scripts/deploy/capture-release.mjs list`: each company that has a release record (released, withdrawn
 * or blocked) with its stream, last query, code, certificate, interval and recent alerts, plus the
 * deployment switches. It is a mutation for one reason: a released company without a scheduled
 * check (released before the supervisor existed, for instance) gets it armed here. It never
 * queries the source nor changes a release, a stream or a customer record. Ids and the company's
 * name; never the CNPJ.
 */
export const survey = internalMutation({
  args: {},
  returns: surveyValue,
  handler: async (ctx) => {
    const now = Date.now();
    const releases = await ctx.db.query("captureReleases").take(SURVEY_LIMIT + 1);
    const companies: Infer<typeof surveyCompany>[] = [];
    let armed = 0;
    for (const release of releases.slice(0, SURVEY_LIMIT)) {
      const company = await ctx.db.get("companies", release.companyId);
      if (!company || company.organizationId !== release.organizationId) continue;
      if (
        release.released &&
        baseEnvironment() === "sandbox" &&
        !(await closureOf(ctx, company.organizationId)) &&
        (await superviseCompany(ctx, company))
      )
        armed++;
      // One company's unexpected record must not take the list down with it: what failed to
      // read is shown empty, with the error, and the other companies are listed.
      let stream: Doc<"captureStreams"> | null = null;
      let op: Doc<"operations"> | null = null;
      let cert: Doc<"certificates"> | null = null;
      let supervision: Doc<"captureSupervision"> | null = null;
      let scheduled = false;
      let alerts: Doc<"captureAlerts">[] = [];
      let error: string | null = null;
      try {
        supervision = await ctx.db
          .query("captureSupervision")
          .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
          .unique();
        const job = supervision?.scheduledId
          ? await ctx.db.system.get("_scheduled_functions", supervision.scheduledId)
          : null;
        scheduled = job?.state.kind === "pending" || job?.state.kind === "inProgress";
        alerts = await ctx.db
          .query("captureAlerts")
          .withIndex("by_companyId_and_createdAt", (q) => q.eq("companyId", company._id))
          .order("desc")
          .take(SURVEY_ALERTS);
        stream = await ctx.db
          .query("captureStreams")
          .withIndex("by_companyId_environment", (q) =>
            q.eq("companyId", company._id).eq("environment", "production"),
          )
          .first();
        op = stream?.operationId ? await ctx.db.get("operations", stream.operationId) : null;
        const head = await certificateHead(ctx, company._id);
        cert = head?.activeId ? await ctx.db.get("certificates", head.activeId) : null;
      } catch (thrown) {
        error = redactedError(thrown);
      }
      companies.push({
        organizationId: company.organizationId,
        companyId: company._id,
        name: company.name,
        release: release.released ? "released" : release.blocked ? "blocked" : "withdrawn",
        minIntervalHours: release.minIntervalHours,
        releaseUpdatedAt: release.updatedAt,
        stream:
          stream && stream.organizationId === company.organizationId
            ? {
                id: stream._id,
                state: stream.state,
                code: stream.code ?? null,
                lastSuccessAt: stream.lastSuccessAt ?? null,
                lastAttemptAt: stream.lastAttemptAt ?? null,
                nextAllowedAt: stream.nextAllowedAt,
                operationState: op?.state ?? null,
                recovering: !!stream.recovery,
              }
            : null,
        certificate: cert?.metadata
          ? {
              own:
                cert.companyId === company._id &&
                cert.state === "active" &&
                cert.metadata.cnpj === company.cnpj,
              notAfter: cert.metadata.notAfter,
            }
          : null,
        supervision: {
          armed: scheduled,
          checkedAt: supervision?.checkedAt ?? null,
          failing: supervision?.failingSince !== undefined,
        },
        alerts: alerts.map((alert) => ({
          kind: alert.kind,
          code: alert.code ?? null,
          days: alert.days ?? null,
          delivery: alert.delivery,
          createdAt: alert.createdAt,
        })),
        error,
      });
    }
    const recentRows = await ctx.db
      .query("captureAlerts")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", now - 30 * DAY))
      .take(RECENT_LIMIT + 1);
    const counts = new Map<
      string,
      { kind: Doc<"captureAlerts">["kind"]; code: string; count: number }
    >();
    let suppressed = 0;
    for (const alert of recentRows.slice(0, RECENT_LIMIT)) {
      if (alert.delivery === "suppressed") suppressed++;
      const code = alert.code ?? (alert.days !== undefined ? `${alert.days}d` : "");
      const key = `${alert.kind}:${code}`;
      const entry = counts.get(key) ?? { kind: alert.kind, code, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
    return {
      deployment: {
        captureFiscal: fiscalCaptureEnabled(),
        transport: process.env.FNFE_CAPTURE_TRANSPORT === "sefaz",
        halted: await captureFiscalHalted(ctx),
        alertDestination: captureAlertDestination()
          ? ("email" as const)
          : ("unconfigured" as const),
      },
      companies,
      truncated: releases.length > SURVEY_LIMIT,
      armed,
      recent: [...counts.values()].sort((a, b) => b.count - a.count),
      suppressed,
      recentPartial: recentRows.length > RECENT_LIMIT,
    };
  },
});

const mailAlert = v.object({
  kind: captureAlertKind,
  code: v.union(v.string(), v.null()),
  days: v.union(v.number(), v.null()),
  streamState: v.union(captureState, v.null()),
  organizationId: v.id("organizations"),
  companyId: v.id("companies"),
  streamId: v.union(v.id("captureStreams"), v.null()),
  createdAt: v.number(),
});

/**
 * Takes an alert's e-mail for delivery, once: only a `pending` alert, and only while the
 * deployment handed fewer than `ALERT_MAIL_HOURLY_LIMIT` e-mails to the provider in the last hour;
 * past that it is `suppressed`, still logged and listed. A mass event (the transport removed for
 * every company, say) is one line per company in the log, not a mailbox flood.
 */
export const claimAlert = internalMutation({
  args: { alertId: v.id("captureAlerts") },
  returns: v.union(v.null(), mailAlert),
  handler: async (ctx, { alertId }) => {
    const alert = await ctx.db.get("captureAlerts", alertId);
    if (alert?.delivery !== "pending") return null;
    // The destination removed between the alert and its turn: it stays listed and logged.
    if (!captureAlertDestination()) {
      await ctx.db.patch("captureAlerts", alertId, { delivery: "unconfigured" });
      return null;
    }
    const now = Date.now();
    const recent = await ctx.db
      .query("captureAlerts")
      .withIndex("by_sentAt", (q) => q.gt("sentAt", now - CAPTURE_HOUR))
      .take(ALERT_MAIL_HOURLY_LIMIT);
    if (recent.length >= ALERT_MAIL_HOURLY_LIMIT) {
      await ctx.db.patch("captureAlerts", alertId, { delivery: "suppressed" });
      console.warn(
        JSON.stringify({ type: "capture_alert_delivery", alertId, delivery: "suppressed" }),
      );
      return null;
    }
    await ctx.db.patch("captureAlerts", alertId, { delivery: "sending", sentAt: now });
    return {
      kind: alert.kind,
      code: alert.code ?? null,
      days: alert.days ?? null,
      streamState: alert.streamState ?? null,
      organizationId: alert.organizationId,
      companyId: alert.companyId,
      streamId: alert.streamId ?? null,
      createdAt: alert.createdAt,
    };
  },
});

export const finishAlert = internalMutation({
  args: {
    alertId: v.id("captureAlerts"),
    delivery: v.union(v.literal("sent"), v.literal("failed"), v.literal("uncertain")),
  },
  returns: v.null(),
  handler: async (ctx, { alertId, delivery }) => {
    const alert = await ctx.db.get("captureAlerts", alertId);
    if (alert?.delivery === "sending") await ctx.db.patch("captureAlerts", alertId, { delivery });
    return null;
  },
});

const kindTitle: Record<Doc<"captureAlerts">["kind"], string> = {
  attention: "Captura em atenção",
  stalled: "Captura ativa parada",
  quiet: "Captura sem consulta",
  gap: "Lacuna perto de 90 dias",
  certificate: "Certificado A1 vencendo",
  supervisor: "Verificação da captura falhou",
};
/** The text of an alert e-mail: ids, codes and dates, never the CNPJ or the company's name. */
export function alertMail(alert: Infer<typeof mailAlert>) {
  const date = new Date(alert.createdAt).toISOString();
  const detail =
    alert.kind === "quiet"
      ? `Sem consulta respondida há ${alert.days} dias. A fonte suspende a geração de NSU de um CNPJ sem consulta por 60 dias.`
      : alert.kind === "gap"
        ? `Lacuna aberta há ${alert.days} dias desde a última consulta. A fonte guarda cada documento por 90 dias.`
        : alert.kind === "certificate"
          ? alert.days === 0
            ? "A empresa não tem A1 próprio ativo e válido."
            : `O A1 da empresa vence em até ${alert.days} dias.`
          : alert.kind === "stalled"
            ? "O stream está ativo, mas a operação dele não avança."
            : alert.kind === "supervisor"
              ? "A verificação periódica da empresa falhou. Ela continua agendada; o motivo está no log capture_supervisor_error."
              : "O stream foi para atenção.";
  const subject = `[Freecorps Fiscal] ${kindTitle[alert.kind]}${alert.code ? `: ${alert.code}` : ""}`;
  const text = [
    detail,
    "",
    `Tipo: ${alert.kind}`,
    `Código: ${alert.code ?? "-"}`,
    `Situação do stream: ${alert.streamState ?? "-"}`,
    `Organização: ${alert.organizationId}`,
    `Empresa: ${alert.companyId}`,
    `Stream: ${alert.streamId ?? "-"}`,
    `Registrado em: ${date}`,
    "",
    "Confira a lista com o workflow capture-fiscal.yml, operação list, e siga docs/operacao/captura-fiscal.md.",
  ].join("\n");
  return { subject, text };
}

/**
 * Sends an alert's e-mail once. A timeout or an unreadable answer is `uncertain` and is not sent
 * again: the provider may have accepted it, and the alert stays in the list either way.
 */
export const deliver = internalAction({
  args: { alertId: v.id("captureAlerts") },
  returns: v.null(),
  handler: async (ctx, { alertId }) => {
    const alert: Infer<typeof mailAlert> | null = await ctx.runMutation(
      internal.captureSupervisor.claimAlert,
      { alertId },
    );
    if (!alert) return null;
    const destination = captureAlertDestination();
    if (!destination) {
      await ctx.runMutation(internal.captureSupervisor.finishAlert, {
        alertId,
        delivery: "failed",
      });
      return null;
    }
    const { subject, text } = alertMail(alert);
    const delivery = await sendAlertMail(destination, subject, text, `capture-alert/${alertId}`);
    if (delivery !== "sent")
      console.warn(JSON.stringify({ type: "capture_alert_delivery", alertId, delivery }));
    await ctx.runMutation(internal.captureSupervisor.finishAlert, { alertId, delivery });
    return null;
  },
});

/**
 * Hands one e-mail to Ember Mail: `sent` once it accepted the message, `failed` on a refusal (4xx),
 * `uncertain` on a timeout, a 5xx or no answer, since it may have accepted it. No retry, as before:
 * an uncertain alert is not sent again. The idempotency key still makes a repeated call of the same
 * alert one e-mail in the service.
 */
async function sendAlertMail(
  destination: NonNullable<ReturnType<typeof captureAlertDestination>>,
  subject: string,
  text: string,
  idempotencyKey: string,
): Promise<"sent" | "failed" | "uncertain"> {
  return await deliverMail(
    destination,
    {
      from: destination.from,
      name: "Freecorps Fiscal · Operação",
      to: destination.to,
      subject,
      text,
      idempotencyKey,
    },
    { timeoutMs: 15_000, retries: 0 },
  );
}

/** The text of the test e-mail: the run that sent it, nothing of a company. */
export function testAlertMail(
  run: { operator: string; runId: string; runAttempt: number },
  at: number,
) {
  return {
    subject: `[Freecorps Fiscal] Teste do alerta da captura: run ${run.runId}/${run.runAttempt}`,
    text: [
      "Este é um e-mail de teste do alerta da captura fiscal. Nenhuma empresa está em alerta.",
      "",
      `Run: ${run.runId}, tentativa ${run.runAttempt}`,
      `Disparado por: ${run.operator}`,
      `Enviado em: ${new Date(at).toISOString()}`,
      "",
      'Registre o horário de chegada conforme docs/operacao/captura-fiscal.md, seção "Testar o e-mail dos alertas".',
    ].join("\n"),
  };
}

/**
 * The test of the alert e-mail (#463), called only by `scripts/deploy/capture-release.mjs alert_test`:
 * one e-mail to `FNFE_CAPTURE_ALERT_EMAIL` through the same provider call as an alert, so its
 * arrival proves the destination without an alert of a real company. It reads and writes no
 * record, queries no source and changes no capture; the hourly ceiling of the alerts does not
 * count it, and each run attempt sends at most one. A timeout is `uncertain` and is not sent
 * again. The log line carries the run, never the addresses.
 */
export const sendTestAlert = internalAction({
  args: {
    operator: v.string(),
    actor: v.optional(v.string()),
    runId: v.string(),
    runAttempt: v.number(),
  },
  returns: v.object({
    alertDestination: v.union(v.literal("email"), v.literal("unconfigured")),
    recipients: v.number(),
    delivery: v.union(v.literal("sent"), v.literal("failed"), v.literal("uncertain"), v.null()),
    sentAt: v.union(v.number(), v.null()),
  }),
  handler: async (_ctx, run) => {
    const destination = captureAlertDestination();
    const line = { type: "capture_alert_test", runId: run.runId, runAttempt: run.runAttempt };
    if (!destination) {
      console.warn(JSON.stringify({ ...line, delivery: "unconfigured" }));
      return {
        alertDestination: "unconfigured" as const,
        recipients: 0,
        delivery: null,
        sentAt: null,
      };
    }
    const sentAt = Date.now();
    const { subject, text } = testAlertMail(run, sentAt);
    // One test e-mail per run attempt: the key keeps a retry of this call from sending a second.
    const delivery = await sendAlertMail(
      destination,
      subject,
      text,
      `capture-alert-test/${run.runId}/${run.runAttempt}`,
    );
    console.warn(JSON.stringify({ ...line, delivery, recipients: destination.to.length }));
    return {
      alertDestination: "email" as const,
      recipients: destination.to.length,
      delivery,
      sentAt,
    };
  },
});
