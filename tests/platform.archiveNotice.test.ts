import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import { archiveNoticeMail } from "../platform/convex/archiveNotice";
import { ARCHIVE_DAY, archiveStatus } from "../platform/convex/lib/coldArchiveCore";
import { activateCatalogPlan } from "../platform/convex/lib/planCore";
import {
  person,
  platformTest,
  usePlatformEnvironment,
  type PlatformTest,
} from "./helpers/platform";

/**
 * The notice before the cold custody of an open organization (ADR 0009, decisions of
 * 29/10/2026): eligibility, the one e-mail to owners and admins, "Manter ativa" and renewal. Open
 * organizations still stop at the notice. Organizations, people and addresses are synthetic.
 */
usePlatformEnvironment({
  siteUrl: "http://localhost:5197",
  convexSiteUrl: "http://127.0.0.1:3253",
  secret: "synthetic-archive-notice",
  now: Date.UTC(2026, 9, 29, 12),
});
beforeEach(() => vi.stubEnv("FNFE_COLD_ARCHIVE", "enabled"));

/** An open organization idle for 100 days, on Free or on a paid plan ending at `endsAt`. */
async function organization(
  t: PlatformTest,
  options: { paidEndsAt?: number; sandboxOnly?: boolean; idleDays?: number } = {},
) {
  const idle = Date.now() - (options.idleDays ?? 100) * ARCHIVE_DAY;
  return t.run(async (ctx) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const organizationId = await ctx.db.insert("organizations", {
      name: `Aberta ${suffix}`,
      slug: `aberta-${suffix}`,
      ownerCount: 1,
      memberCount: 1,
      createdAt: idle,
      updatedAt: idle,
    });
    const paid = options.paidEndsAt !== undefined;
    await ctx.db.insert("usagePlans", {
      organizationId,
      catalogTier: paid ? "intermediate" : "free",
      name: paid ? "Intermediário" : "Gratuito",
      startsAt: 0,
      endsAt: paid ? options.paidEndsAt! : null,
      limits: { imports: 100, captures: 0, registry: 0, bytes: 1e8, deliveries: 0 },
      concurrency: 1,
      version: 1,
      updatedAt: idle,
    });
    // A Production total: the organization did not only use Sandbox.
    if (!options.sandboxOnly)
      await ctx.db.insert("usageTotals", {
        organizationId,
        environment: "production",
        period: "2026-01",
        metric: "imports",
        committed: 1,
        reserved: 0,
        updatedAt: idle,
        startedAt: idle,
      });
    return organizationId;
  });
}
const notice = (t: PlatformTest, organizationId: Id<"organizations">, key = "synthetic-notice-1") =>
  t.mutation(internal.coldArchive.notice, { organizationId, key });
const run = (t: PlatformTest, organizationId: Id<"organizations">) =>
  t.run((ctx) => archiveStatus(ctx, organizationId));
const mailbox = (t: PlatformTest) =>
  t.run(async (ctx) =>
    (await ctx.db.query("developmentMail").collect())
      .filter((mail) => mail.type === "archive-notice")
      .map(({ email, otp }) => ({ email, runId: otp }))
      .sort((a, b) => a.email.localeCompare(b.email)),
  );
const email = (t: PlatformTest, membershipId: Id<"memberships">) =>
  t.run(async (ctx) => (await ctx.db.get("memberships", membershipId))!.email);

describe("Elegibilidade de organização aberta (decisões de 29/10/2026)", () => {
  it("Gratuito: aviso só depois de 90 dias sem atividade", async () => {
    const t = platformTest();
    const organizationId = await organization(t, { idleDays: 89 });
    await expect(notice(t, organizationId)).rejects.toThrow("ARCHIVE_FREE_ACTIVE");
    vi.advanceTimersByTime(ARCHIVE_DAY);
    await notice(t, organizationId);
    expect(await run(t, organizationId)).toMatchObject({
      state: "notice",
      reason: "free_inactive",
      eligibleAt: Date.now() + 30 * ARCHIVE_DAY,
    });
  });

  it("plano pago: aviso logo no fim do período pago, nunca antes", async () => {
    const t = platformTest();
    const organizationId = await organization(t, { paidEndsAt: Date.now() + ARCHIVE_DAY });
    await expect(notice(t, organizationId)).rejects.toThrow("ARCHIVE_PAID_ACTIVE");
    vi.advanceTimersByTime(ARCHIVE_DAY - 1);
    await expect(notice(t, organizationId)).rejects.toThrow("ARCHIVE_PAID_ACTIVE");
    vi.advanceTimersByTime(1);
    // Only one hot month after the paid period: the notice's.
    await notice(t, organizationId);
    expect(await run(t, organizationId)).toMatchObject({
      state: "notice",
      reason: "paid_expired",
      planVersion: 1,
      eligibleAt: Date.now() + 30 * ARCHIVE_DAY,
    });
  });

  it.each([{}, { paidEndsAt: Date.UTC(2026, 5, 1) }])(
    "organização só com Sandbox não recebe aviso nem run (%o)",
    async (options) => {
      const t = platformTest();
      const organizationId = await organization(t, { ...options, sandboxOnly: true });
      await expect(notice(t, organizationId)).rejects.toThrow("ARCHIVE_SANDBOX_ONLY");
      expect(await run(t, organizationId)).toBeNull();
    },
  );
});

describe("Aviso por e-mail aos proprietários e administradores", () => {
  it("cria o run e envia um e-mail por owner ou admin ativo, nunca duas vezes", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const owner = await person(t, organizationId, "owner");
    const admin = await person(t, organizationId, "admin");
    await person(t, organizationId, "viewer");
    await person(t, organizationId, "developer");
    await person(t, organizationId, "operator");
    const runId = await notice(t, organizationId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const expected = [await email(t, owner.membershipId), await email(t, admin.membershipId)]
      .map((address) => ({ email: address.toLowerCase(), runId }))
      .sort((a, b) => a.email.localeCompare(b.email));
    expect(await mailbox(t)).toEqual(expected);
    expect((await run(t, organizationId))?.noticeMail).toMatchObject({
      state: "sent",
      recipients: 2,
      confirmed: 2,
      withheld: 0,
    });
    // A repeated notice, and a repeated send, find the claimed row: nothing goes out again.
    expect(await notice(t, organizationId)).toBe(runId);
    await t.action(internal.archiveNotice.deliver, { runId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await mailbox(t)).toEqual(expected);
  });

  it("o operador retoma um envio perdido antes da reserva, sem repetir mensagem", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const owner = await person(t, organizationId, "owner");
    const runId = await notice(t, organizationId);
    // The scheduled send is lost before it claims the row.
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect())
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    });
    expect(await t.query(internal.archiveNotice.mailStatus, { before: Date.now() + 1 })).toEqual([
      { runId, organizationId, mail: "pending", state: "notice", noticeAt: Date.now() },
    ]);
    // Too recent: the original send may still be on its way.
    expect(await t.mutation(internal.archiveNotice.resumePending, {})).toEqual({ resumed: 0 });
    vi.advanceTimersByTime(61 * 60_000);
    // Two resumes racing: only one claim succeeds.
    expect(await t.mutation(internal.archiveNotice.resumePending, {})).toEqual({ resumed: 1 });
    expect(await t.mutation(internal.archiveNotice.resumePending, {})).toEqual({ resumed: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await mailbox(t)).toEqual([
      { email: (await email(t, owner.membershipId)).toLowerCase(), runId },
    ]);
    expect((await run(t, organizationId))?.noticeMail?.state).toBe("sent");
    expect(await t.mutation(internal.archiveNotice.resumePending, {})).toEqual({ resumed: 0 });
    expect(await t.query(internal.archiveNotice.mailStatus, { before: Date.now() })).toEqual([]);
  });

  it("um envio em `sending` aparece para o operador e nunca é retomado", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    await person(t, organizationId, "owner");
    const runId = await notice(t, organizationId);
    const claimedAt = Date.now();
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect())
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      const current = (await ctx.db.get("coldArchiveRuns", runId))!;
      await ctx.db.patch("coldArchiveRuns", runId, {
        noticeMail: { ...current.noticeMail!, state: "sending", claimedAt },
      });
    });
    vi.advanceTimersByTime(61 * 60_000);
    expect(await t.mutation(internal.archiveNotice.resumePending, {})).toEqual({ resumed: 0 });
    expect(await t.query(internal.archiveNotice.mailStatus, { before: Date.now() })).toEqual([
      expect.objectContaining({ runId, mail: "sending", claimedAt }),
    ]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await mailbox(t)).toEqual([]);
  });

  it("sem e-mail de contas, registra o aviso sem envio", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    await person(t, organizationId, "owner");
    for (const [key, value] of Object.entries({
      APP_ENV: "validation",
      EMAIL_MODE: "disabled",
      SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
      CONVEX_SITE_URL: "https://modest-seal-118.convex.site",
      CLOUDFLARE_EMAIL_API_TOKEN: "",
      ACCOUNT_EMAIL_FROM: "",
      ACCOUNT_EMAIL_RECIPIENTS: "",
    }))
      vi.stubEnv(key, value);
    await notice(t, organizationId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await run(t, organizationId))?.noticeMail?.state).toBe("skipped");
    expect(await mailbox(t)).toEqual([]);
  });

  it("o texto diz a data de Brasília, o efeito, a perda na fonte e a ação", () => {
    const base = {
      organization: "Aberta",
      slug: "aberta",
      // 26/11/2026 at 23:30 in Brasília.
      eligibleAt: Date.UTC(2026, 10, 27, 2, 30),
      siteUrl: "https://console.example.invalid/app",
    };
    const free = archiveNoticeMail({ ...base, reason: "free_inactive" });
    expect(free.subject).toContain("26/11/2026");
    expect(free.text).toContain("Manter ativa");
    expect(free.text).toContain("https://console.example.invalid/app/aberta");
    expect(free.text).toContain("não na hora");
    expect(free.text).toContain("captura de NF-e fica parada");
    const paid = archiveNoticeMail({ ...base, reason: "paid_expired" });
    expect(paid.text).toContain("Uso e limites, na seção Cobrança");
    expect(paid.text).toContain("https://console.example.invalid/app/aberta/usage");
  });
});

describe("Manter ativa e renovação", () => {
  it("owner ou admin mantém ativa; viewer e outra organização são recusados", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const admin = await person(t, organizationId, "admin");
    const viewer = await person(t, organizationId, "viewer");
    const other = await organization(t);
    const outsider = await person(t, other, "owner");
    const runId = await notice(t, organizationId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Every member sees the notice; only owners and admins act.
    expect(await viewer.query(api.archiveNotice.status, { organizationId })).toMatchObject({
      runId,
      state: "notice",
      reason: "free_inactive",
      canAct: false,
    });
    expect(await admin.query(api.archiveNotice.status, { organizationId })).toMatchObject({
      canAct: true,
    });
    await expect(
      viewer.mutation(api.archiveNotice.keepActive, { organizationId, runId }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      outsider.mutation(api.archiveNotice.keepActive, { organizationId, runId }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(outsider.query(api.archiveNotice.status, { organizationId })).rejects.toThrow(
      "ACCESS_DENIED",
    );
    // Its own organization does not reach another one's notice.
    await expect(
      outsider.mutation(api.archiveNotice.keepActive, { organizationId: other, runId }),
    ).rejects.toThrow("ARCHIVE_NOTICE_NOT_FOUND");
    expect((await run(t, organizationId))?.state).toBe("notice");

    await admin.mutation(api.archiveNotice.keepActive, { organizationId, runId });
    expect(await run(t, organizationId)).toMatchObject({
      state: "hot",
      version: 2,
      noticeEnded: { by: "keep_active", at: Date.now() },
    });
    // Repeating it changes nothing.
    await admin.mutation(api.archiveNotice.keepActive, { organizationId, runId });
    const audit = await t.run((ctx) =>
      ctx.db
        .query("organizationAudit")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .collect(),
    );
    expect(audit.filter((row) => row.action === "organization.kept-active")).toHaveLength(1);
    expect(await viewer.query(api.archiveNotice.status, { organizationId })).toBeNull();
    // It counts as activity: the 90 days start over.
    await expect(notice(t, organizationId, "synthetic-notice-2")).rejects.toThrow(
      "ARCHIVE_FREE_ACTIVE",
    );
    vi.advanceTimersByTime(90 * ARCHIVE_DAY);
    await notice(t, organizationId, "synthetic-notice-2");
    expect((await run(t, organizationId))?.state).toBe("notice");
  });

  it("sem aviso, manter ativa é recusado", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const owner = await person(t, organizationId, "owner");
    const other = await organization(t);
    const runId = await notice(t, other);
    await expect(
      owner.mutation(api.archiveNotice.keepActive, { organizationId, runId }),
    ).rejects.toThrow("ARCHIVE_NOTICE_NOT_FOUND");
    expect(await owner.query(api.archiveNotice.status, { organizationId })).toBeNull();
  });

  it("arquivamento em curso recusa manter ativa com ORGANIZATION_ARCHIVING", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const owner = await person(t, organizationId, "owner");
    const runId = await notice(t, organizationId);
    await t.run((ctx) => ctx.db.patch("coldArchiveRuns", runId, { state: "frozen" }));
    await expect(
      owner.mutation(api.archiveNotice.keepActive, { organizationId, runId }),
    ).rejects.toThrow("ORGANIZATION_ARCHIVING");
    expect((await run(t, organizationId))?.state).toBe("frozen");
  });

  it("plano pago: só a renovação encerra o aviso, na mesma transação", async () => {
    const t = platformTest();
    const organizationId = await organization(t, { paidEndsAt: Date.now() });
    const owner = await person(t, organizationId, "owner");
    const runId = await notice(t, organizationId);
    await expect(
      owner.mutation(api.archiveNotice.keepActive, { organizationId, runId }),
    ).rejects.toThrow("PLAN_RENEWAL_REQUIRED");
    await t.run(async (ctx) => {
      await ctx.db.insert("platformPlanSettings", {
        key: "platform",
        enabled: true,
        version: 1,
        filesBytes: 1e12,
        databaseBytes: 1e12,
        custodyCents: 1e9,
        freeMonthlyCents: 1e9,
        allocatedFilesBytes: 0,
        allocatedDatabaseBytes: 0,
        allocatedCustodyCents: 0,
        allocatedFreeMonthlyCents: 0,
        admissionsUntil: Date.now() + ARCHIVE_DAY,
        evidence: "synthetic-archive-notice",
        updatedAt: Date.now(),
      });
      await ctx.db.insert("capacityAccounts", {
        organizationId,
        ready: true,
        phase: 0,
        cursor: null,
        updatedAt: Date.now(),
      });
      await activateCatalogPlan(
        ctx,
        organizationId,
        "intermediate",
        Date.now(),
        Date.now() + 30 * ARCHIVE_DAY,
        1,
        "synthetic",
        "Renovação sintética",
      );
    });
    expect(await run(t, organizationId)).toMatchObject({
      state: "hot",
      version: 2,
      noticeEnded: { by: "plan", at: Date.now() },
    });
    // The old fence no longer freezes anything.
    await expect(t.mutation(internal.coldArchive.freeze, { runId, version: 1 })).rejects.toThrow(
      "ARCHIVE_STALE_FENCE",
    );
  });

  it("a organização aberta só congela depois dos 30 dias do aviso", async () => {
    const t = platformTest();
    const organizationId = await organization(t, { paidEndsAt: Date.now() });
    const runId = await notice(t, organizationId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await expect(t.mutation(internal.coldArchive.freeze, { runId, version: 1 })).rejects.toThrow(
      "ARCHIVE_NOTICE_PENDING",
    );
    expect((await run(t, organizationId))?.state).toBe("notice");
    // Ela volta pela reidratação com IDs novos (ADR 0009, §5); o fluxo segue atrás do gate.
    vi.advanceTimersByTime(30 * ARCHIVE_DAY);
    await t.mutation(internal.coldArchive.freeze, { runId, version: 1 });
    expect((await run(t, organizationId))?.state).toBe("frozen");
  });
});

describe("Leitura de documentos fiscais no console como atividade (#641)", () => {
  const updatedAt = (t: PlatformTest, organizationId: Id<"organizations">) =>
    t.run(async (ctx) => (await ctx.db.get("organizations", organizationId))!.updatedAt);

  it("a leitura de qualquer membro ativo adia o aviso por 90 dias", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const viewer = await person(t, organizationId, "viewer");
    await viewer.mutation(api.archiveNotice.markFiscalRead, { organizationId });
    await expect(notice(t, organizationId)).rejects.toThrow("ARCHIVE_FREE_ACTIVE");
    vi.advanceTimersByTime(90 * ARCHIVE_DAY - 1);
    await expect(notice(t, organizationId)).rejects.toThrow("ARCHIVE_FREE_ACTIVE");
    vi.advanceTimersByTime(1);
    await notice(t, organizationId);
    expect((await run(t, organizationId))?.state).toBe("notice");
  });

  it("grava no máximo uma marca por organização a cada dia", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const owner = await person(t, organizationId, "owner");
    await owner.mutation(api.archiveNotice.markFiscalRead, { organizationId });
    const first = Date.now();
    expect(await updatedAt(t, organizationId)).toBe(first);
    vi.advanceTimersByTime(ARCHIVE_DAY - 1);
    // Sessions last an hour: other people read the next day.
    const operator = await person(t, organizationId, "operator");
    const viewer = await person(t, organizationId, "viewer");
    await operator.mutation(api.archiveNotice.markFiscalRead, { organizationId });
    await viewer.mutation(api.archiveNotice.markFiscalRead, { organizationId });
    expect(await updatedAt(t, organizationId)).toBe(first);
    vi.advanceTimersByTime(1);
    await operator.mutation(api.archiveNotice.markFiscalRead, { organizationId });
    expect(await updatedAt(t, organizationId)).toBe(first + ARCHIVE_DAY);
  });

  it("membro de outra organização não conta", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const outsider = await person(t, await organization(t), "owner");
    const idle = await updatedAt(t, organizationId);
    await expect(
      outsider.mutation(api.archiveNotice.markFiscalRead, { organizationId }),
    ).rejects.toThrow("ACCESS_DENIED");
    expect(await updatedAt(t, organizationId)).toBe(idle);
    await notice(t, organizationId);
    expect((await run(t, organizationId))?.state).toBe("notice");
  });

  it("organização em custódia recusa a marca, como recusa a leitura", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const owner = await person(t, organizationId, "owner");
    const runId = await notice(t, organizationId);
    await t.run((ctx) => ctx.db.patch("coldArchiveRuns", runId, { state: "frozen" }));
    const idle = await updatedAt(t, organizationId);
    await expect(
      owner.mutation(api.archiveNotice.markFiscalRead, { organizationId }),
    ).rejects.toThrow("ORGANIZATION_ARCHIVED");
    expect(await updatedAt(t, organizationId)).toBe(idle);
  });

  it("uma leitura durante o aviso faz o congelamento recusar a organização", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const idle = await organization(t);
    const runId = await notice(t, organizationId);
    const idleRunId = await notice(t, idle);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The read does not end the notice; the freeze evaluates eligibility again and refuses.
    vi.advanceTimersByTime(29 * ARCHIVE_DAY);
    // Sessions last an hour: the reader signs in on the day of the read.
    const viewer = await person(t, organizationId, "viewer");
    await viewer.mutation(api.archiveNotice.markFiscalRead, { organizationId });
    expect((await run(t, organizationId))?.state).toBe("notice");
    vi.advanceTimersByTime(ARCHIVE_DAY);
    await expect(t.mutation(internal.coldArchive.freeze, { runId, version: 1 })).rejects.toThrow(
      "ARCHIVE_FREE_ACTIVE",
    );
    expect((await run(t, organizationId))?.state).toBe("notice");
    // Without a read, the other organization freezes once the notice ends.
    await t.mutation(internal.coldArchive.freeze, { runId: idleRunId, version: 1 });
    expect((await run(t, idle))?.state).toBe("frozen");
  });
});
