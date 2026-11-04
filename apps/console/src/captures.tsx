import { UsageErrorNotice, UsageGuidance, isUsageCode, type UsageOrg } from "./usage-errors";
import { integrationRecordMessage } from "./company-context";
import { useDeployment } from "./deployment";
import { RefusedFiles } from "./refused-files";
import { FiscalCapture, SupportReferences, type ReleaseStatus } from "./fiscal-capture";
import {
  UNEXPLAINED_STOP,
  captureFailureText,
  captureMessage,
  captureQuota,
  stopMessage,
  forOrigin,
  integrationResume,
  captureSituation,
  queryOutcome,
} from "./capture-messages";
import { usageAudience } from "./usage-messages";
import { useProductEnvironment } from "./product-environment";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useQuery } from "./convex-query";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { ActionFailure, CopyButton, OriginLabel, useNow } from "./product-components";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import { formatDate, formatDateRange, formatDateTime, formatShortDateTime } from "./format";
import {
  Button,
  buttonClass,
  Callout,
  Card,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  DisabledReason,
  Disclosure,
  EmptyState,
  FormField,
  Input,
  Textarea,
  controlProps,
  Skeleton,
  SkeletonBlock,
  StatusBadge,
} from "./ui";

/** Failure of an action other than a quota or plan refusal. */
function actionError(e: unknown, production: boolean) {
  const code = e instanceof ConvexError ? String(e.data?.code) : "";
  return (
    integrationRecordMessage(e) ??
    captureFailureText(code, production) ??
    "Não foi possível concluir a ação. Confira seu acesso e tente novamente."
  );
}
const date = (time: number | null) =>
  time ? new Date(time).toLocaleString("pt-BR") : "Ainda não ocorreu";
type Scope = {
  organizationId: Id<"organizations">;
  companyId: Id<"companies">;
  environment: "sandbox" | "production";
};
/** An action started straight from its button; pausing and transferring go through a dialog. */
type DirectAction = "activate" | "sync" | "resume";
/** A refusal of a direct action, and whether it came from the transfer form. */
type Failure = { error: unknown; transfer: boolean };
type Stream = NonNullable<FunctionReturnType<typeof api.captures.get>>;
const running = (operationState: string | null) =>
  !!operationState && !["succeeded", "failed", "paused"].includes(operationState);
/**
 * A query sent and not answered yet. Before the call the source window is reserved for an hour,
 * in case the answer is lost; that time is not the next query while the answer may still come.
 */
export function queryInFlight(
  stream: Pick<Stream, "operationState" | "lastAttemptAt" | "lastSuccessAt">,
) {
  return (
    running(stream.operationState) &&
    !!stream.lastAttemptAt &&
    stream.lastAttemptAt > (stream.lastSuccessAt ?? 0)
  );
}
/**
 * How far the company's queue at the source was read, or `null` before the first answer. The
 * NSU stays in the technical details (#432).
 */
export function queueStatus(
  stream: Pick<Stream, "checkpoint" | "sourceMaxNsu" | "state"> & Partial<Pick<Stream, "origin">>,
): string | null {
  if (!stream.sourceMaxNsu) return null;
  if (stream.checkpoint >= stream.sourceMaxNsu) return "Em dia";
  // Only the integration resumes its capture (#607).
  if (stream.state === "paused")
    return stream.origin && stream.origin.kind !== "console"
      ? `Ainda há documentos para receber. ${integrationResume(stream.origin.integration)}`
      : "Ainda há documentos para receber. Retome a captura para recebê-los.";
  return stream.state === "attention"
    ? "Ainda há documentos para receber."
    : "Ainda há documentos para receber. A captura continua lendo.";
}
/** Why "Sincronizar" waits, or `null` when it can be asked now. */
export function syncBlock(
  stream: Pick<Stream, "nextAllowedAt" | "operationState"> &
    Partial<Pick<Stream, "lastAttemptAt" | "lastSuccessAt">>,
  now: number,
): string | null {
  if (
    queryInFlight({
      operationState: stream.operationState,
      lastAttemptAt: stream.lastAttemptAt ?? null,
      lastSuccessAt: stream.lastSuccessAt ?? null,
    })
  )
    return "Uma consulta à fonte está em andamento; o resultado aparece aqui quando terminar.";
  // Then the source's window: a step waiting for it is also "in progress", but the time is what
  // the person needs.
  if (stream.nextAllowedAt > now)
    return `A fonte só aceita a próxima consulta a partir de ${date(stream.nextAllowedAt)}. O botão é liberado nesse horário.`;
  if (running(stream.operationState))
    return "Uma consulta já está em andamento; o resultado aparece aqui quando terminar.";
  return null;
}
/** The Freecorps general stop (#424): the stream stays active and comes back by itself. */
const haltedStream = (stream: Stream) =>
  stream.state === "active" && stream.code === "CAPTURE_FISCAL_HALTED";
/** Waiting for new terms (#428): the stream stays active and comes back once they are accepted. */
const termsStream = (stream: Stream) =>
  stream.state === "active" && stream.code === "CAPTURE_TERMS_PENDING";
/**
 * The capture's situation in one badge: the same words for the panel, the announcement and, for
 * the fiscal capture, the list of companies and the company's header (#433).
 */
function situation(stream: Stream | null) {
  return captureSituation(
    !stream
      ? "none"
      : haltedStream(stream)
        ? "halted"
        : termsStream(stream)
          ? "terms"
          : stream.state,
  );
}
/** "22/10 14:03 (respondida)": the last query, answered or not, in one value (#432). */
export function lastQuery(
  stream: Pick<Stream, "lastAttemptAt" | "lastSuccessAt" | "operationState">,
  now: number,
) {
  const attempt = stream.lastAttemptAt,
    success = stream.lastSuccessAt;
  if (!attempt && !success) return "Ainda não ocorreu";
  if (attempt && attempt > (success ?? 0)) {
    const sent = formatShortDateTime(attempt, now);
    if (queryInFlight({ ...stream, lastAttemptAt: attempt, lastSuccessAt: success }))
      return `${sent} (em andamento)`;
    return success
      ? `${sent} (não respondida); a última respondida foi em ${formatShortDateTime(success, now)}`
      : `${sent} (não respondida)`;
  }
  return `${formatShortDateTime(success!, now)} (respondida)`;
}
/** The value of "Próxima consulta automática"; a stopped capture has none (#431, #432). */
function nextQuery(stream: Stream, now: number, production: boolean) {
  if (stream.state === "paused") return "Nenhuma: consultas automáticas pausadas";
  if (stream.state === "attention")
    return production && resumesByItself(stream.code)
      ? "Nenhuma: a captura volta sozinha quando a causa for resolvida"
      : "Nenhuma: consultas automáticas paradas até alguém agir";
  if (haltedStream(stream)) return "Quando a Freecorps liberar de novo a captura fiscal";
  if (termsStream(stream)) return "Depois do aceite dos novos termos";
  if (queryInFlight(stream)) return "Consulta em andamento";
  if (stream.nextAllowedAt <= now)
    return running(stream.operationState) ? "Na fila, a qualquer momento" : "A qualquer momento";
  return formatShortDateTime(stream.nextAllowedAt, now);
}
/** Production attentions the server resumes by itself once their cause is gone (#418). */
const resumesByItself = (code: string | null) =>
  !!code &&
  [
    "QUOTA_EXCEEDED",
    "PLAN_INACTIVE",
    "PLAN_REQUIRED",
    "CAPACITY_INVENTORY_REQUIRED",
    "CERTIFICATE_UNAVAILABLE",
  ].includes(code);
/** The reason next to the badge of a capture that keeps going. */
function activeReason(stream: Stream, production: boolean) {
  const source = production ? "a Receita" : "a fonte de teste";
  if (queryInFlight(stream))
    return `Consulta ${production ? "à Receita" : "à fonte de teste"} em andamento; o resultado aparece aqui quando ela responder.`;
  if (!stream.lastAttemptAt && !stream.lastSuccessAt && running(stream.operationState))
    return `Primeira consulta na fila; o resultado aparece aqui quando ${source} responder.`;
  const message = captureMessage(stream.code, production, captureQuota(stream));
  if (message && stream.code && !["PAUSED_BY_USER", "TRANSFERRED"].includes(stream.code))
    return message.todo?.startsWith("Nada") ? `${message.reason} ${message.todo}` : message.reason;
  return `Consulta ${source} automaticamente.`;
}
/** The reason and "O que fazer" of a capture in attention, the Freecorps cut included (#601). */
const attentionMessage = (
  stream: Pick<Stream, "code"> &
    Partial<Pick<Stream, "freecorpsCut" | "notesQuota" | "countsNotes">>,
  production: boolean,
) => stopMessage(stream, production) ?? UNEXPLAINED_STOP;
/**
 * "Retomar captura" of a stopped capture (#432, `CaptureAction`): the main button when resuming
 * is what makes it go on; a secondary one when the cause is elsewhere (the Freecorps, the plan,
 * an environment without a source) and the server, which accepts the resume, would only stop
 * again; none without a usable A1, which the server refuses; and waiting for its time while the
 * Receita's block of a 656 lasts, which the server also refuses.
 */
export function resumeOffer(
  stream: Pick<Stream, "state" | "code" | "certificateState" | "nextAllowedAt"> &
    Partial<Pick<Stream, "freecorpsCut">>,
  production: boolean,
  now: number,
): "main" | "secondary" | "later" | "none" {
  if (stream.state === "active") return "none";
  if (stream.state === "paused") return "main";
  const { action } = attentionMessage(stream, production);
  if (action === "certificate") return stream.certificateState === "active" ? "main" : "none";
  if (action === "support" || action === "usage" || action === "environment") return "secondary";
  return stream.code === "SOURCE_CONSUMPTION_BLOCKED" && stream.nextAllowedAt > now
    ? "later"
    : "main";
}
/** A value for support in mono; its absence in words, since it is not a value. */
/** Longest reason for accepting a loss; the server (`captures.acceptGap`) holds the same limit. */
const GAP_REASON_MAX = 500;
const technical = (value: string | null, absent: string) =>
  value ? <span className="ui-mono">{value}</span> : absent;
/** The first button still enabled in `area`: where the focus goes when a button left. */
const firstEnabledButton = (area: HTMLElement | null) =>
  area?.querySelector<HTMLButtonElement>("button:not([disabled])") ?? null;

/** One group of the panel (#432): Agenda, Volume, Certificado and the last queries (#433). */
function CaptureGroup({
  title,
  children,
  footer,
  className,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div
      role="group"
      aria-labelledby={id}
      className={className ? `capture-group ${className}` : "capture-group"}
    >
      <p id={id} className="capture-group__title">
        {title}
      </p>
      {children}
      {footer}
    </div>
  );
}

/**
 * One capture, Sandbox or Produção: its situation, agenda, volume and certificate, the actions
 * and, collapsed at the end, the rare ones. The stream comes from `Captures`, which also says the
 * changes of situation out loud, once for the page.
 */
function Capture({
  scope,
  stream,
  writable,
  manager,
  owner,
  org,
  off,
  focusStart = false,
  onStartFocused,
  quiet = false,
}: {
  scope: Scope;
  stream: Stream | null;
  writable: boolean;
  manager: boolean;
  /** Only the owner accepts a fiscal loss (#442, owner's decision of 26/10/2026). */
  owner: boolean;
  org: UsageOrg;
  /**
   * Production whose fiscal capture is off now (withdrawn, suspended by the Freecorps or not
   * offered by the deployment): the release line above says why and what stays.
   */
  off?: boolean;
  /** Right after the release (#432): "Iniciar captura fiscal" takes the focus. */
  focusStart?: boolean;
  onStartFocused?: () => void;
  /**
   * Another part of the screen has the main button (the interval being changed, or Produção
   * above the Sandbox): this capture's main action shows as a secondary one, so the screen keeps
   * one (DESIGN.md).
   */
  quiet?: boolean;
}) {
  const production = scope.environment === "production";
  const main = quiet ? "secondary" : "primary";
  // Sandbox and production share the page: ids per instance.
  const id = useId();
  const activate = useMutation(api.captures.activate),
    control = useMutation(api.captures.control),
    release = useMutation(api.captures.release),
    accept = useMutation(api.captures.acceptGap);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<Failure | null>(null),
    [token, setToken] = useState(""),
    [accepting, setAccepting] = useState(false),
    [reason, setReason] = useState(""),
    [pausing, setPausing] = useState(false);
  const actions = useRef<HTMLDivElement>(null),
    statusLine = useRef<HTMLParagraphElement>(null),
    start = useRef<HTMLButtonElement>(null),
    reasonField = useRef<HTMLTextAreaElement>(null),
    /**
     * After starting or resuming, the button that was pressed leaves with the old state: the
     * focus goes to the next action once the server's new version arrives (the version the
     * action saw, or -1 before a capture existed).
     */
    refocus = useRef<number | null>(null);
  const now = useNow(stream?.nextAllowedAt ?? null);
  // Once the release reached this capture (it can act now), the focus goes to the button that
  // starts or resumes it, if there is one; either way the request is spent.
  useEffect(() => {
    if (!focusStart || !writable) return;
    start.current?.focus();
    onStartFocused?.();
  }, [focusStart, writable, stream, onStartFocused]);
  useEffect(() => {
    if (refocus.current === null || busy || !stream || stream.version === refocus.current) return;
    refocus.current = null;
    (firstEnabledButton(actions.current) ?? statusLine.current)?.focus();
  });
  /** Sends the action; resolves with the refusal, or `null` once the server accepted it. */
  async function run(action: DirectAction | "pause" | "release", transferToken?: string) {
    setFailure(null);
    setToken("");
    try {
      if (action === "activate")
        // Any code goes to the server, even an empty one: it refuses, never starts a capture.
        await activate({ ...scope, ...(transferToken !== undefined ? { transferToken } : {}) });
      else if (stream && action === "release")
        setToken((await release({ ...scope, expectedVersion: stream.version })).token);
      else if (stream && action !== "release")
        await control({ ...scope, action, expectedVersion: stream.version });
      return null;
    } catch (e) {
      return e;
    }
  }
  /**
   * A direct action: its buttons wait, and a refusal shows next to them, with the focus. The
   * error itself is kept: a quota or plan refusal becomes the notice for the person's role.
   */
  async function act(action: DirectAction, transferToken?: string) {
    setBusy(true);
    const seen = stream?.version ?? -1;
    const error = await run(action, transferToken);
    if (!error && action !== "sync") refocus.current = seen;
    setBusy(false);
    if (error) setFailure({ error, transfer: transferToken !== undefined });
  }
  /** A confirmed action: the dialog waits for the server and keeps a refusal inside it. */
  async function confirm(action: "pause" | "release") {
    const error = await run(action);
    return error ? actionError(error, production) : "";
  }
  /** The dialog's confirmation: the range it showed, the version it read and the reason. */
  async function acceptGap(lost: { from: string; to: string }) {
    if (!stream) return "";
    try {
      await accept({ ...scope, expectedVersion: stream.version, ...lost, reason: reason.trim() });
      return "";
    } catch (e) {
      // The role may have changed while the dialog was open: here the denial is the owner's rule.
      if (e instanceof ConvexError && e.data?.code === "ACCESS_DENIED")
        return "Somente o Proprietário pode aceitar a perda. Nada foi aceito.";
      return actionError(e, production);
    }
  }
  const notice = (shown: Failure | null) =>
    shown ? (
      <UsageErrorNotice
        error={shown.error}
        org={org}
        fallback={actionError(shown.error, production)}
        announce={false}
      />
    ) : null;
  if (!stream)
    return (
      <div className="ui-stack">
        <EmptyState
          icon={production ? "info" : "download"}
          headingLevel={3}
          title={
            production
              ? writable
                ? "Falta um passo: Iniciar captura fiscal"
                : "A captura fiscal está ativada, mas ainda não começou."
              : "A captura ainda não foi ativada para esta empresa."
          }
          description={
            writable
              ? production
                ? "Ao iniciar, a captura consulta a Receita com o certificado A1 da empresa e lê as NF-e destinadas a ela. A Receita guarda cada nota por 90 dias: as mais antigas podem não chegar. O resultado da primeira consulta aparece aqui quando a Receita responder."
                : "Ative a consulta no sandbox. A empresa precisa de um certificado A1 ativo."
              : production
                ? "Quem opera documentos (Operador, Administrador ou Proprietário) inicia a captura."
                : "Quem opera documentos (Operador, Administrador ou Proprietário) ativa a captura."
          }
          actions={
            writable ? (
              <Button
                ref={start}
                variant={main}
                loading={busy}
                loadingLabel={production ? "Iniciando…" : "Ativando…"}
                onClick={() => void act("activate")}
              >
                {production ? "Iniciar captura fiscal" : "Ativar captura no sandbox"}
              </Button>
            ) : null
          }
        />
        <ActionFailure failure={failure?.transfer ? null : failure}>
          {notice(failure)}
        </ActionFailure>
        {manager && (
          <ReceiveTransfer
            id={`${id}-transfer`}
            busy={busy}
            failure={failure?.transfer ? failure : null}
            act={act}
          >
            {notice(failure)}
          </ReceiveTransfer>
        )}
      </div>
    );
  // A stream activated by an integration is followed here and controlled by the integration.
  const controlled = stream.origin.kind === "console";
  const blocked = syncBlock(stream, now);
  const queue = queueStatus(stream);
  // Part of a gap the source no longer has, waiting for the owner's decision (#419, #442).
  const lost = stream.state === "attention" ? (stream.gap?.lost ?? null) : null;
  // The loss is the owner's decision, also on an integration's capture (#442): the one action
  // the console offers there; the rest stays with the integration.
  const decides = !!lost && owner;
  const reasonLength = reason.trim().length;
  const reasonError =
    reasonLength > GAP_REASON_MAX
      ? `Use até ${GAP_REASON_MAX} caracteres. Retire ${reasonLength - GAP_REASON_MAX}.`
      : undefined;
  const paused = stream.state === "paused";
  const badge = situation(stream);
  const resume = resumeOffer(stream, production, now);
  const certificateTab = {
    to: "/app/$organizationSlug/companies/$companyId",
    params: { organizationSlug: org.slug, companyId: scope.companyId },
    search: { aba: "certificado" },
  } as const;
  // After a dialog, the button that opened it may have gone with the new state (Pausar becomes
  // Retomar): the focus goes to the next action, or to the capture's status.
  const afterDialog = () => firstEnabledButton(actions.current) ?? statusLine.current;
  return (
    <div className="ui-stack">
      <div role="group" aria-labelledby={`${id}-situation`} className="capture-situation">
        <p id={`${id}-situation`} className="capture-group__title">
          Situação
        </p>
        <p ref={statusLine} tabIndex={-1} className="capture-situation__line">
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
          {stream.state === "active" ? (
            <span className="capture-situation__reason">{activeReason(stream, production)}</span>
          ) : null}
          <span className="capture-situation__origin">
            <OriginLabel origin={stream.origin} />
          </span>
        </p>
        <SituationNotice
          stream={stream}
          production={production}
          org={org}
          off={off}
          lost={lost}
          owner={owner}
          controlled={controlled}
        />
      </div>
      {stream.gap?.accepted.length ? <AcceptedGaps accepted={stream.gap.accepted} /> : null}
      {writable && !controlled && !decides ? (
        <Callout tone="info">{integrationCapture(stream.origin)}</Callout>
      ) : null}
      {writable && (controlled || decides) && (
        <div ref={actions} className="ui-actions">
          {stream.state === "active" ? (
            <>
              <Button
                variant={main}
                disabled={busy || !!blocked}
                aria-describedby={blocked ? `${id}-sync-reason` : undefined}
                onClick={() => void act("sync")}
              >
                Sincronizar
              </Button>
              <Button disabled={busy} onClick={() => setPausing(true)}>
                Pausar captura
              </Button>
            </>
          ) : lost ? (
            owner ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setReason("");
                  setAccepting(true);
                }}
              >
                Aceitar a perda e continuar
              </Button>
            ) : null
          ) : (
            <>
              {/* The fix is in Certificado: the way there is the main action. */}
              {stream.state === "attention" &&
              attentionMessage(stream, production).action === "certificate" &&
              resume === "none" ? (
                <Link className={buttonClass({ variant: main })} {...certificateTab}>
                  Ver certificado
                </Link>
              ) : null}
              {resume !== "none" ? (
                <Button
                  ref={start}
                  variant={resume === "secondary" ? "secondary" : main}
                  disabled={busy || resume === "later"}
                  aria-describedby={resume === "later" ? `${id}-resume-reason` : undefined}
                  onClick={() => void act("resume")}
                >
                  Retomar captura
                </Button>
              ) : null}
            </>
          )}
        </div>
      )}
      {writable && controlled && stream.state === "active" && blocked ? (
        <DisabledReason id={`${id}-sync-reason`}>{blocked}</DisabledReason>
      ) : null}
      {writable && controlled && resume === "later" ? (
        <DisabledReason id={`${id}-resume-reason`}>
          {`A Receita só aceita uma nova consulta deste CNPJ a partir de ${formatShortDateTime(stream.nextAllowedAt, now)}. O botão é liberado nesse horário.`}
        </DisabledReason>
      ) : null}
      <ActionFailure failure={failure}>{notice(failure)}</ActionFailure>
      <div className="capture-groups">
        <CaptureGroup title="Agenda">
          <DescriptionList
            items={[
              { term: "Última consulta", value: lastQuery(stream, now) },
              {
                term: "Próxima consulta automática",
                value: nextQuery(stream, now, production),
              },
            ]}
          />
        </CaptureGroup>
        <CaptureGroup
          title="Volume"
          footer={<DocumentLinks scope={scope} org={org} production={production} />}
        >
          <DescriptionList
            items={[
              {
                term: "Documentos recebidos da fonte",
                value: (
                  <span className="capture-number">{stream.received.toLocaleString("pt-BR")}</span>
                ),
              },
              {
                term: "Fila na fonte",
                value: queue ?? "Sem informação até a primeira consulta respondida",
              },
              ...(stream.gap?.recovering
                ? [
                    {
                      term: "Recuperação",
                      value: `Buscando ${records(stream.gap.recovering.count)} que faltaram na sequência, até 6 por hora (3 por hora no dia seguinte a um bloqueio da Receita).`,
                    },
                  ]
                : []),
            ]}
          />
        </CaptureGroup>
        <CaptureGroup title="Certificado">
          <p className="capture-certificate">
            <span>
              {stream.certificateState === "active"
                ? stream.certificateExpiresAt
                  ? `A1 válido até ${formatDate(stream.certificateExpiresAt)}`
                  : "A1 válido"
                : stream.certificateState === "expired" && stream.certificateExpiresAt
                  ? `A1 vencido em ${formatDate(stream.certificateExpiresAt)}`
                  : stream.certificateState === "missing"
                    ? "Nenhum certificado A1 ativo"
                    : "Confira a validade e a ativação do A1"}
            </span>
            <Link className="ui-link" {...certificateTab}>
              Ver certificado
            </Link>
          </p>
        </CaptureGroup>
        <CaptureGroup title="Últimas consultas" className="capture-history">
          <QueryHistory
            scope={scope}
            org={org}
            production={production}
            notes={!!stream.countsNotes}
            now={now}
          />
        </CaptureGroup>
      </div>
      {lost ? (
        <ConfirmDialog
          open={accepting}
          onOpenChange={setAccepting}
          title={`Aceitar a perda de ${records(lost.count)}?`}
          description={`A captura volta a ler do primeiro registro que a Receita ainda tem${controlled ? "" : `, na ${integrationName(stream.origin)}, com a chave dela`}. ${lossOutcome(production)}; a decisão não pode ser desfeita e fica registrada com o seu nome e o motivo.`}
          confirmLabel="Aceitar a perda"
          busyLabel="Registrando…"
          settleMs={350}
          initialFocus={() => reasonField.current}
          confirmDisabled={reasonLength === 0 || !!reasonError}
          onConfirm={() => acceptGap({ from: lost.from, to: lost.to })}
          returnFocusTo={afterDialog}
        >
          <div className="ui-stack">
            <DescriptionList items={lostItems(lost)} />
            <FormField
              id={`${id}-reason`}
              label="Motivo"
              help={`Por que a empresa aceita perder essas notas. ${reasonLength} de ${GAP_REASON_MAX} caracteres.`}
              error={reasonError}
            >
              <Textarea
                ref={reasonField}
                {...controlProps(`${id}-reason`, reasonError, true)}
                rows={3}
                required
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </FormField>
          </div>
        </ConfirmDialog>
      ) : null}
      <ConfirmDialog
        open={pausing}
        onOpenChange={setPausing}
        title="Pausar a captura?"
        description="As consultas automáticas param e nenhum documento novo chega até alguém retomar a captura. Os documentos recebidos continuam disponíveis. Uma consulta já enviada não é desfeita."
        confirmLabel="Pausar captura"
        busyLabel="Pausando…"
        tone="primary"
        settleMs={350}
        onConfirm={() => confirm("pause")}
        returnFocusTo={afterDialog}
      />
      <Disclosure summary="Detalhes técnicos (para o suporte)">
        <p className="ui-help">
          NSU persistido: <span className="ui-mono">{stream.checkpoint}</span>. Último NSU devolvido
          pela fonte: {technical(stream.sourceCursor, "não informado")}. Maior NSU disponível na
          fonte: {technical(stream.sourceMaxNsu, "não informado")}.
        </p>
        <DescriptionList
          items={[
            {
              term: "Operação",
              value: stream.operationId ? (
                <span className="gestao-reference">
                  <code>{stream.operationId}</code>
                  <CopyButton value={stream.operationId} label="Copiar id da operação" iconOnly />
                </span>
              ) : (
                "Nenhuma"
              ),
            },
            { term: "Código", value: technical(stream.code, "Nenhum") },
          ]}
        />
      </Disclosure>
      {writable && controlled && manager ? (
        <CaptureTransfer
          paused={paused}
          token={token}
          clearToken={() => setToken("")}
          onConfirm={() => confirm("release")}
        />
      ) : null}
    </div>
  );
}

/**
 * The way from the capture to what it received (#433): the documents of its environment and,
 * when there are any, the notes that arrived only as the summary, counted by the server.
 */
function DocumentLinks({
  scope,
  org,
  production,
}: {
  scope: Scope;
  org: UsageOrg;
  production: boolean;
}) {
  const summaries = useQuery(api.documents.summaryCount, scope);
  const search = { company: scope.companyId, env: scope.environment };
  return (
    <ul className="capture-links">
      <li>
        <Link
          className="ui-link"
          to="/app/$organizationSlug/documents"
          params={{ organizationSlug: org.slug }}
          search={search}
        >
          {production ? "Ver documentos em Produção" : "Ver documentos no Sandbox"}
        </Link>
      </li>
      {summaries?.count ? (
        <li>
          <Link
            className="ui-link"
            to="/app/$organizationSlug/documents"
            params={{ organizationSlug: org.slug }}
            search={{ ...search, completeness: "summary" }}
          >
            {`Ver notas só com resumo (${summaries.count.toLocaleString("pt-BR")}${summaries.more ? "+" : ""})`}
          </Link>
        </li>
      ) : null}
    </ul>
  );
}
/**
 * The last queries to the source (#433): when, what came back and how many documents, newest
 * first, from `captures.history`. Each query sent counts in the plan's limit, so the list also
 * shows how the capture spends it.
 */
function QueryHistory({
  scope,
  org,
  production,
  notes,
  now,
}: {
  scope: Scope;
  org: UsageOrg;
  production: boolean;
  /** The plan counts new notes, not queries (`countsNotes`). */
  notes: boolean;
  now: number;
}) {
  const history = useQuery(api.captures.history, scope);
  // The newest query answers "is it working?"; the earlier ones open on request.
  const [all, setAll] = useState(false);
  // Not a live region: the page keeps one, for the situation (#432).
  if (history === undefined)
    return (
      <div className="ui-stack" aria-busy="true">
        <span className="ui-visually-hidden">Carregando as últimas consultas…</span>
        <Skeleton />
        <Skeleton width="60%" />
      </div>
    );
  const manager = usageAudience(org) === "manager";
  return (
    <>
      <p className="ui-help">
        {notes
          ? "Cada nota nova recebida em Produção conta no limite de notas do plano; as consultas não contam."
          : production
            ? "Cada consulta enviada à Receita conta no limite de consultas do plano."
            : "Cada consulta enviada à fonte de teste conta no limite de consultas do plano."}{" "}
        {manager ? (
          <Link
            className="ui-link"
            to="/app/$organizationSlug/usage"
            params={{ organizationSlug: org.slug }}
          >
            Ver o consumo em Uso e limites
          </Link>
        ) : null}
      </p>
      <DataTable
        label="Últimas consultas"
        rows={history.slice(0, all ? undefined : 1).map((entry, index) => ({ ...entry, index }))}
        rowKey={(entry) => `${entry.at}-${entry.index}`}
        empty={<p className="ui-help">Nenhuma consulta ainda.</p>}
        columns={[
          {
            key: "at",
            header: "Hora",
            primary: true,
            cell: (entry) => (
              <time className="capture-number" dateTime={new Date(entry.at).toISOString()}>
                {formatShortDateTime(entry.at, now)}
              </time>
            ),
          },
          {
            key: "result",
            header: "Resultado",
            cell: (entry) => {
              const { result, detail } = queryOutcome(entry, production);
              return (
                <>
                  <span>{result}</span>
                  {entry.kind === "recovery" ? (
                    <span className="fiscal-note">Busca de um registro que faltou</span>
                  ) : null}
                  {detail ? <span className="fiscal-note">{detail}</span> : null}
                </>
              );
            },
          },
          {
            key: "documents",
            header: "Documentos recebidos",
            align: "end",
            cell: (entry) => (
              <span className="capture-number">
                {entry.documents === null ? "—" : entry.documents.toLocaleString("pt-BR")}
              </span>
            ),
          },
        ]}
      />
      {history.length > 1 ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={all}
            onClick={() => setAll((open) => !open)}
          >
            {all
              ? "Mostrar só a última consulta"
              : history.length === 2
                ? "Mostrar a consulta anterior"
                : `Mostrar as ${history.length - 1} consultas anteriores`}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** "integração “ERP Serra”", or the integration without a name. */
/**
 * Who manages an integration's capture: the integration, except the loss, which the owner accepts
 * here (#442). Not `integrationManaged`, which says the console changes nothing of the record.
 */
const integrationCapture = (origin: Stream["origin"]) =>
  `${origin.integration ? `Criada pela integração ${origin.integration}` : "Criada por uma integração"}: sincronizar, pausar, retomar e transferir ficam com a integração. Aqui, só o Proprietário aceita perdas.`;
const integrationName = (origin: Stream["origin"]) =>
  origin.integration ? `integração “${origin.integration}”` : "integração que a ativou";

/**
 * What the badge does not say by itself, right below it (#432): the reason and "O que fazer" of
 * an attention, the pause, a capture received from another organization, or a part of the
 * history the Receita no longer has. With the fiscal capture off, nothing: the release line at
 * the top of the card says it (#424).
 */
function SituationNotice({
  stream,
  production,
  org,
  off,
  lost,
  owner,
  controlled,
}: {
  stream: Stream;
  production: boolean;
  org: UsageOrg;
  off?: boolean;
  lost: LostGap | null;
  owner: boolean;
  controlled: boolean;
}) {
  // The release line above already says why the capture is off and what stays: one notice (#424).
  // Neither the pause's notice, which would ask to resume, nor the stream's code repeats it.
  if (off) return null;
  if (lost)
    return (
      <LostGapNotice
        lost={lost}
        production={production}
        todo={
          !owner
            ? "Somente o Proprietário decide aceitar a perda e continuar."
            : controlled
              ? "Se não há outro jeito de receber essas notas, aceite a perda para a captura continuar."
              : `Esta captura é da ${integrationName(stream.origin)}. Se não há outro jeito de receber essas notas, aceite a perda: a captura continua na integração, com a chave dela.`
        }
      />
    );
  if (stream.state === "paused") {
    if (stream.code === "TRANSFERRED")
      return (
        <Explained
          tone="info"
          message={forOrigin(
            captureMessage(stream.code, production, captureQuota(stream))!,
            stream.origin,
          )}
        />
      );
    return (
      <Callout tone="warning">
        Captura pausada: as consultas automáticas estão paradas e nenhum documento novo chega. Os
        documentos recebidos continuam disponíveis.
      </Callout>
    );
  }
  if (stream.state !== "attention") return null;
  // On an integration's capture, the integration resumes (#607).
  const message = forOrigin(attentionMessage(stream, production), stream.origin);
  // Quota and plan: the reason by the person's role, with the way to Uso e limites.
  return (
    <Explained
      tone="warning"
      message={message}
      reason={
        !isUsageCode(stream.code) ? undefined : captureQuota(stream) !== "queries" &&
          stream.code === "QUOTA_EXCEEDED" ? (
          // On a plan that counts notes, say whether the notes stopped it, then the guidance.
          <>
            {message.reason} <UsageGuidance code={stream.code} org={org} />
          </>
        ) : (
          <UsageGuidance code={stream.code} org={org} />
        )
      }
    />
  );
}
/** The reason, then "O que fazer: …", in one notice. */
function Explained({
  tone,
  message,
  reason,
}: {
  tone: "info" | "warning";
  message: { reason: string; todo?: string };
  reason?: ReactNode;
}) {
  return (
    <Callout tone={tone}>
      <p>{reason ?? message.reason}</p>
      {message.todo ? (
        <p>
          <strong>O que fazer:</strong> {message.todo}
        </p>
      ) : null}
    </Callout>
  );
}

/**
 * Receiving a stream another organization paused for transfer (#431): rare, so collapsed under
 * the empty state, for whoever manages the organization.
 */
function ReceiveTransfer({
  id,
  busy,
  failure,
  act,
  children,
}: {
  id: string;
  busy: boolean;
  failure: Failure | null;
  act: (action: "activate", transferToken: string) => Promise<void>;
  /** The refusal's notice, next to the button. */
  children: ReactNode;
}) {
  return (
    <Disclosure summary="Recebendo uma captura de outra organização?">
      <form
        className="ui-form"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const input = new FormData(form).get("transfer");
          const value = typeof input === "string" ? input : "";
          form.reset();
          void act("activate", value);
        }}
      >
        <div className="company-form-grid">
          <div data-span={3}>
            <FormField
              id={id}
              label="Código de transferência"
              help="O código que a organização de origem gerou em “Transferir esta captura para outra organização”."
            >
              <Input
                id={id}
                name="transfer"
                type="password"
                autoComplete="off"
                required
                aria-describedby={`${id}-help`}
              />
            </FormField>
          </div>
        </div>
        <div className="ui-actions">
          <Button type="submit" disabled={busy}>
            Receber transferência
          </Button>
        </div>
        <ActionFailure failure={failure}>{children}</ActionFailure>
      </form>
    </Disclosure>
  );
}
/**
 * Handing the stream to another organization (#431): rare, so collapsed at the end of the
 * capture, and confirmed first. The server pauses the capture and answers a code shown once, in
 * place of the button; hiding the code brings the button back. A paused capture stays paused, so
 * the words do not promise to pause it.
 */
function CaptureTransfer({
  paused,
  token,
  clearToken,
  onConfirm,
}: {
  paused: boolean;
  token: string;
  clearToken: () => void;
  onConfirm: () => Promise<string>;
}) {
  const [confirming, setConfirming] = useState(false);
  const opener = useRef<HTMLButtonElement>(null),
    code = useRef<HTMLDivElement>(null),
    hiding = useRef(false);
  // "Ocultar código" leaves with the code: the focus goes back to the button.
  useEffect(() => {
    if (token || !hiding.current) return;
    hiding.current = false;
    opener.current?.focus();
  }, [token]);
  return (
    <Disclosure summary="Transferir esta captura para outra organização">
      <p className="ui-help">
        {paused
          ? "Gera um código, válido por 15 minutos, para outra organização continuar do mesmo ponto."
          : "Pausa a captura aqui e gera um código, válido por 15 minutos, para outra organização continuar do mesmo ponto."}
      </p>
      {token ? (
        // Takes the focus when the dialog closes: the button that opened it gave way to the code.
        <div
          ref={code}
          tabIndex={-1}
          role="group"
          aria-label="Código de transferência"
          className="fiscal-submit-reason"
        >
          <Callout
            tone="success"
            title="Código de transferência"
            actions={
              <>
                <CopyButton value={token} label="Copiar código" />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    hiding.current = true;
                    clearToken();
                  }}
                >
                  Ocultar código
                </Button>
              </>
            }
          >
            <p>
              Código exibido uma vez, válido por 15 minutos. Entregue ao responsável autorizado da
              organização de destino.
            </p>
            <code className="company-secret">{token}</code>
          </Callout>
        </div>
      ) : (
        <div>
          <Button ref={opener} onClick={() => setConfirming(true)}>
            {paused ? "Autorizar transferência" : "Pausar e autorizar transferência"}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Transferir esta captura para outra organização?"
        description={`${paused ? "A captura continua pausada nesta organização" : "A captura fica pausada nesta organização"} e o código aparece uma vez só. Quem administra a outra organização tem 15 minutos para usá-lo e continuar do mesmo ponto. Se o código não for usado, retome a captura aqui.`}
        confirmLabel={paused ? "Gerar código" : "Pausar e gerar código"}
        busyLabel="Gerando o código…"
        tone="primary"
        settleMs={350}
        onConfirm={onConfirm}
        returnFocusTo={() => code.current ?? opener.current}
      />
    </Disclosure>
  );
}
type LostGap = NonNullable<Stream["gap"]["lost"]>;
/**
 * NSUs of the source's queue, in words. An NSU is one record: a summary, a full NF-e or an event
 * (cancellation, correction letter, manifestation); and a 137 also covers an NSU the source never
 * generated (NT 2014.002 v1.40, §3.6). So a range of NSU is "up to" that many notes or events.
 */
const records = (count: number) =>
  `até ${count.toLocaleString("pt-BR")} ${count === 1 ? "nota ou evento" : "notas ou eventos"}`;
/** What happens to the lost records: the same words in the notice and the dialog. */
const consequence = (production: boolean) =>
  production
    ? "Essas notas e eventos não chegarão pela captura e não entrarão em Produção, que guarda só o que a captura recebe da Receita."
    : "Essas notas e eventos não chegarão pela captura. No Sandbox, o XML de uma nota pode ser importado em Importar XML.";
/** The same consequence, short, for the dialog: the notice above it already explains why. */
const lossOutcome = (production: boolean) =>
  production
    ? "Essas notas e eventos não entrarão em Produção"
    : "Essas notas e eventos não chegarão pela captura";
/** NSU without the leading zeros the source pads them with. */
const shortNsu = (nsu: string) => nsu.replace(/^0+(?=\d)/, "");
function lostItems(lost: LostGap, period = true) {
  return [
    ...(period && lost.quietSince && lost.detectedAt
      ? [
          {
            term: "Sem consulta à Receita",
            value: formatDateRange(lost.quietSince, lost.detectedAt, true),
          },
        ]
      : []),
    { term: "Fora da Receita", value: records(lost.count) },
    {
      term: "Referência na fila",
      value: (
        <span className="ui-mono">
          NSU {shortNsu(lost.from)} a {shortNsu(lost.to)}
        </span>
      ),
    },
  ];
}
/**
 * A gap the source no longer has (#419), in plain words: the quiet period, what is gone, what it
 * means and what to do. The action is in the capture's action row.
 */
function LostGapNotice({
  lost,
  production,
  todo,
}: {
  lost: LostGap;
  production: boolean;
  todo: string;
}) {
  return (
    <Callout tone="warning" title="Parte do histórico não está mais na Receita">
      <p>
        {lost.quietSince && lost.detectedAt
          ? `A captura ficou sem consultar a Receita ${formatDateRange(lost.quietSince, lost.detectedAt)}. `
          : null}
        A Receita guarda cada registro por 90 dias, e {records(lost.count)} da fila da empresa já
        saíram de lá.
      </p>
      <p>{consequence(production)}</p>
      <DescriptionList items={lostItems(lost, false)} />
      <p>
        <strong>O que fazer:</strong> {todo}
      </p>
    </Callout>
  );
}
/** Losses already accepted: who, when, how much and why, after the capture went on. */
function AcceptedGaps({ accepted }: { accepted: Stream["gap"]["accepted"] }) {
  return (
    <div className="ui-stack">
      <p className="ui-help">Histórico limitado por decisão registrada:</p>
      <ul className="ui-help">
        {accepted.map((gap) => (
          <li key={`${gap.from}-${gap.acceptedAt}`}>
            {formatDateTime(gap.acceptedAt)}: {gap.acceptedBy ?? "Uma pessoa da organização"}{" "}
            aceitou a perda de {records(gap.count)} (
            <span className="ui-mono">
              NSU {shortNsu(gap.from)} a {shortNsu(gap.to)}
            </span>
            ).
            {gap.reason ? (
              <>
                {" "}
                Motivo: <q className="capture-accepted__reason">{gap.reason}</q>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The one live region of the page (#432): it says a change of situation of either capture (the
 * badge, and the reason of an attention), never the other updates of the stream. The first
 * situation is on the screen already and is not said.
 */
function useSituationAnnouncement(
  entries: Array<{ label: string; stream: Stream | null; production: boolean } | null>,
) {
  const keyed = entries.map((entry) => {
    if (!entry) return null;
    const badge = situation(entry.stream);
    // The Freecorps cut over (#601) changes the reason without changing the code: said too.
    const attention =
      entry.stream?.state === "attention"
        ? `${entry.stream.code ?? ""}${entry.stream.freecorpsCut ? "|cut" : ""}`
        : "";
    const reason =
      entry.stream?.state === "attention"
        ? (stopMessage(entry.stream, entry.production)?.reason ?? "")
        : "";
    return {
      key: `${badge.label}|${attention}`,
      text: `${entry.label}: ${badge.label}.${reason ? ` ${reason}` : ""}`,
    };
  });
  const signature = keyed.map((entry) => entry?.key ?? "-").join("§");
  const previous = useRef<string[] | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const keys = signature.split("§");
    if (previous.current) {
      const said = keyed.filter(
        (entry, index) =>
          entry && previous.current![index] !== "-" && previous.current![index] !== keys[index],
      );
      if (said.length) setMessage(said.map((entry) => entry!.text).join(" "));
    }
    previous.current = keys;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keyed` follows `signature`.
  }, [signature]);
  return message;
}

/**
 * The stream as the panel shows it: from `termsDeadline` on, an active production stream waits
 * for the new terms (#428, `CAPTURE_TERMS_PENDING`). The server returns the deadline instead of
 * the code, because its query never reads the clock (#45); the console compares it with its own.
 */
function useTermsDeadline(stream: Stream | null | undefined): Stream | null | undefined {
  const deadline = stream?.termsDeadline ?? null;
  const now = useNow(deadline);
  const pending = deadline !== null && now >= deadline;
  return useMemo(() => {
    if (!stream || !pending) return stream;
    const { notesQuota: _quota, ...rest } = stream;
    return { ...rest, code: "CAPTURE_TERMS_PENDING", freecorpsCut: false };
  }, [stream, pending]);
}

/**
 * The capture tab (#432), in the environment chosen in the shell (ADR 0007, §1). Sandbox: the test
 * capture, and, while the company never used Produção but the deployment offers it, the card
 * that releases it; releasing moves the console to Produção. Produção: the company's release and
 * capture, and what it kept without a recognized document; a company that never had it says so.
 */
export function Captures({ org, companyId }: { org: Organization; companyId: Id<"companies"> }) {
  // The console controls the company's stream, whichever project activated it; no grant.
  const canRead = org.role !== "developer";
  const ids = { organizationId: org.id, companyId };
  const release = useQuery(api.captureRelease.status, canRead ? ids : "skip");
  // Produção exists once the deployment offers it or the company used it. Before the first
  // release there is no production stream, and the server does not serve that environment.
  const production = !!release && (release.available || release.state !== "none");
  const used = !!release && release.state !== "none";
  const [justEnabled, setJustEnabled] = useState(false);
  const deployment = useDeployment();
  const { environment: chosen, offered, choose } = useProductEnvironment();
  // A production deployment (#50) keeps its own page: there is no Produção beside it.
  const inProduction = deployment.environment !== "production" && chosen === "production";
  const productionStream = useTermsDeadline(
    useQuery(
      api.captures.get,
      canRead && used && inProduction ? { ...ids, environment: "production" } : "skip",
    ),
  );
  // Each environment reads only its own stream.
  const sandboxStream = useQuery(
    api.captures.get,
    canRead && !inProduction ? { ...ids, environment: "sandbox" } : "skip",
  );
  const message = useSituationAnnouncement([
    inProduction && production && (!used || productionStream !== undefined)
      ? { label: "Captura fiscal (Produção)", stream: productionStream ?? null, production: true }
      : null,
    sandboxStream !== undefined && !inProduction
      ? { label: "Captura de teste (Sandbox)", stream: sandboxStream, production: false }
      : null,
  ]);
  if (!canRead)
    return (
      <Card title="Captura de NF-e">
        <Callout tone="info">
          A captura pelo console exige papel de Leitura, Operador, Administrador ou Proprietário.
          Desenvolvedores acompanham as conexões pelas integrações.
        </Callout>
      </Card>
    );
  if (
    release === undefined ||
    (!inProduction && sandboxStream === undefined) ||
    (inProduction && used && productionStream === undefined)
  )
    return (
      <Card title="Captura de NF-e">
        <SkeletonBlock label="Carregando captura…" />
      </Card>
    );
  const productionCard = (
    <ProductionCard
      org={org}
      companyId={companyId}
      release={release}
      stream={productionStream ?? null}
      justEnabled={justEnabled}
      onEnabled={() => setJustEnabled(true)}
      onStartFocused={() => setJustEnabled(false)}
    />
  );
  if (inProduction)
    return (
      <>
        <p role="status" className="ui-visually-hidden">
          {message}
        </p>
        {production ? (
          productionCard
        ) : (
          <Card title="Captura fiscal (Produção)">
            <Callout tone="info">
              A captura fiscal não está disponível para esta empresa. Troque para o Sandbox na
              lateral para usar a captura de teste.
            </Callout>
          </Card>
        )}
        {/* What the capture kept without a recognized document, in Produção: the import page
            reads the deployment's environment, so these are listed here, and Documentos points
            here. */}
        {used ? <RefusedFiles org={org} scope={{ ...ids, environment: "production" }} /> : null}
      </>
    );
  return (
    <>
      <p role="status" className="ui-visually-hidden">
        {message}
      </p>
      {/* Produção offered and never used: it is released inside Produção, never from here. */}
      {production && !used && offered?.includes("production") ? (
        <Callout
          tone="info"
          title="Captura fiscal em Produção"
          headingLevel={3}
          actions={<Button onClick={() => choose("production")}>Trocar para Produção</Button>}
        >
          A captura fiscal lê na Receita as NF-e reais da empresa e é ativada em Produção. Esta
          página mostra só o Sandbox.
        </Callout>
      ) : null}
      <Card
        title="Captura de teste (Sandbox)"
        description="Consulta de teste das NF-e destinadas à empresa, sem validade fiscal. A fonte pode entregar só o resumo de uma nota, sem os itens. A captura não manifesta; enviar um certificado não ativa a captura."
      >
        <Capture
          key={`sandbox-${companyId}`}
          scope={{ ...ids, environment: "sandbox" }}
          stream={sandboxStream ?? null}
          writable={org.capabilities.operateDocuments}
          manager={org.capabilities.manageOrganization}
          owner={org.role === "owner"}
          org={org}
        />
      </Card>
    </>
  );
}

/**
 * Produção (ADR 0007): the company's release on top, as a form or a summary line, then its
 * capture, which starts here and, once the release is withdrawn, stays for reading only.
 */
function ProductionCard({
  org,
  companyId,
  release,
  stream,
  justEnabled,
  onEnabled,
  onStartFocused,
}: {
  org: Organization;
  companyId: Id<"companies">;
  release: ReleaseStatus;
  stream: Stream | null;
  justEnabled: boolean;
  onEnabled: () => void;
  onStartFocused: () => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  // While the interval is being changed, saving it is the card's main action.
  const [editing, setEditing] = useState(false);
  const released = release.state === "released";
  return (
    <Card
      title="Captura fiscal (Produção)"
      titleRef={title}
      description="Lê na Receita as NF-e em que a empresa é destinatária, com o certificado A1 dela. Os documentos ficam em Documentos › Produção, separados do Sandbox. A Receita pode entregar só o resumo de uma nota, sem os itens; a captura não manifesta."
    >
      <div className="ui-stack capture-production">
        <FiscalCapture
          organizationId={org.id}
          companyId={companyId}
          status={release}
          onEnabled={onEnabled}
          title={title}
          hasStream={!!stream}
          onEditingChange={setEditing}
        />
        {/* Turned off and never started, there is nothing to read: the line above says it. */}
        {released || stream ? (
          <div className="capture-production__panel">
            <Capture
              key={`production-${companyId}`}
              scope={{ organizationId: org.id, companyId, environment: "production" }}
              stream={stream}
              writable={released && org.capabilities.operateDocuments}
              manager={released && org.capabilities.manageOrganization}
              owner={released && org.role === "owner"}
              org={org}
              off={!released}
              focusStart={justEnabled}
              onStartFocused={onStartFocused}
              quiet={editing}
            />
          </div>
        ) : null}
        <SupportReferences organizationId={org.id} companyId={companyId} />
      </div>
    </Card>
  );
}
