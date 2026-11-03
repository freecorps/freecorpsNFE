import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import { ARCHIVE_DAY } from "../platform/convex/lib/coldArchiveCore";
import { sandboxClosureMail } from "../platform/convex/sandboxClosure";
import { termEndsAt } from "../platform/convex/lib/annualTerms";
import { insertTerm } from "../platform/convex/lib/planTerms";
import {
  person,
  platformTest,
  usePlatformEnvironment,
  type PlatformTest,
} from "./helpers/platform";

/**
 * ADR 0009, decision 2 of 29/10/2026: the notice and the closure by Freecorps of an open
 * organization that only ever had Sandbox and is idle for 90 days. Organizations, people and
 * addresses are synthetic.
 */
usePlatformEnvironment({
  siteUrl: "http://localhost:5198",
  convexSiteUrl: "http://127.0.0.1:3254",
  secret: "synthetic-sandbox-closure",
  now: Date.UTC(2026, 9, 29, 12),
});
beforeEach(() => vi.stubEnv("FNFE_COLD_ARCHIVE", "enabled"));

/** An open organization idle for `idleDays`, Sandbox-only unless `production`. */
async function organization(
  t: PlatformTest,
  options: { production?: boolean; idleDays?: number; plan?: "free" | "paid" | "none" } = {},
) {
  const idle = Date.now() - (options.idleDays ?? 100) * ARCHIVE_DAY;
  return t.run(async (ctx) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const organizationId = await ctx.db.insert("organizations", {
      name: `Sandbox ${suffix}`,
      slug: `sandbox-${suffix}`,
      ownerCount: 1,
      memberCount: 1,
      createdAt: idle,
      updatedAt: idle,
    });
    const plan = options.plan ?? "free";
    if (plan !== "none")
      await ctx.db.insert("usagePlans", {
        organizationId,
        catalogTier: plan === "paid" ? "intermediate" : "free",
        name: plan === "paid" ? "Intermediário" : "Gratuito",
        startsAt: 0,
        endsAt: plan === "paid" ? Date.now() + 60 * ARCHIVE_DAY : null,
        limits: { imports: 100, captures: 0, registry: 0, bytes: 1e8, deliveries: 0 },
        concurrency: 1,
        version: 1,
        updatedAt: idle,
      });
    if (options.production) await production(ctx, organizationId, idle);
    return organizationId;
  });
}
/** A Production total: the organization did not only use Sandbox. */
const production = (
  ctx: Parameters<Parameters<PlatformTest["run"]>[0]>[0],
  organizationId: Id<"organizations">,
  at: number,
) =>
  ctx.db.insert("usageTotals", {
    organizationId,
    environment: "production",
    period: "2026-01",
    metric: "imports",
    committed: 1,
    reserved: 0,
    updatedAt: at,
    startedAt: at,
  });

const notice = (t: PlatformTest, organizationId: Id<"organizations">, key = "sandbox-notice-1") =>
  t.mutation(internal.sandboxClosure.notice, { organizationId, key });
const row = (t: PlatformTest, noticeId: Id<"sandboxClosureNotices">) =>
  t.run(async (ctx) => (await ctx.db.get("sandboxClosureNotices", noticeId))!);
const closure = (t: PlatformTest, organizationId: Id<"organizations">) =>
  t.run((ctx) =>
    ctx.db
      .query("organizationClosures")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .unique(),
  );
const mailbox = (t: PlatformTest) =>
  t.run(async (ctx) =>
    (await ctx.db.query("developmentMail").collect())
      .filter((mail) => mail.type === "sandbox-closure-notice")
      .map(({ email, otp }) => ({ email, noticeId: otp }))
      .sort((a, b) => a.email.localeCompare(b.email)),
  );
const email = (t: PlatformTest, membershipId: Id<"memberships">) =>
  t.run(async (ctx) => (await ctx.db.get("memberships", membershipId))!.email.toLowerCase());

describe("Elegibilidade da organização só com Sandbox", () => {
  it("aviso só depois de 90 dias sem atividade, em qualquer plano ou sem plano", async () => {
    const t = platformTest();
    const organizationId = await organization(t, { idleDays: 89 });
    await expect(notice(t, organizationId)).rejects.toThrow("SANDBOX_CLOSURE_ACTIVE");
    vi.advanceTimersByTime(ARCHIVE_DAY);
    const noticeId = await notice(t, organizationId);
    expect(await row(t, noticeId)).toMatchObject({
      state: "notice",
      version: 1,
      noticeAt: Date.now(),
      closeAt: Date.now() + 30 * ARCHIVE_DAY,
    });
    const withoutPlan = await organization(t, { plan: "none" });
    await notice(t, withoutPlan, "sandbox-notice-2");
    // No cold archive run: the early purge of the closure still reaches it.
    expect(await t.run((ctx) => ctx.db.query("coldArchiveRuns").collect())).toEqual([]);
  });

  it("recusa organização com Produção, com plano pago em vigor, encerrada ou com o gate desligado", async () => {
    const t = platformTest();
    await expect(notice(t, await organization(t, { production: true }))).rejects.toThrow(
      "SANDBOX_CLOSURE_PRODUCTION",
    );
    await expect(notice(t, await organization(t, { plan: "paid" }))).rejects.toThrow(
      "SANDBOX_CLOSURE_PAID_PLAN",
    );
    // An annual term scheduled for next month, with no plan row yet.
    const scheduled = await organization(t, { plan: "none" });
    await t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: scheduled,
        tier: "intermediate",
        firstPeriod: Date.UTC(2026, 10, 1),
        endsAt: termEndsAt(Date.UTC(2026, 10, 1)),
        source: "pix",
        references: ["synthetic-sandbox-term"],
        paidCents: 149000,
        purchasedAt: Date.now(),
        segments: [],
        state: "scheduled",
      }),
    );
    await expect(notice(t, scheduled)).rejects.toThrow("SANDBOX_CLOSURE_PAID_PLAN");
    const closed = await organization(t);
    const owner = await person(t, closed, "owner");
    const slug = await t.run(async (ctx) => (await ctx.db.get("organizations", closed))!.slug);
    await owner.mutation(api.organizationClosure.close, {
      organizationId: closed,
      confirmation: slug,
    });
    await expect(notice(t, closed)).rejects.toThrow("SANDBOX_CLOSURE_CLOSED");
    vi.stubEnv("FNFE_COLD_ARCHIVE", "");
    await expect(notice(t, await organization(t))).rejects.toThrow("ARCHIVE_DISABLED");
    expect(await t.run((ctx) => ctx.db.query("sandboxClosureNotices").collect())).toEqual([]);
  });

  it("é idempotente pela chave e recusa um segundo aviso pendente", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const noticeId = await notice(t, organizationId);
    expect(await notice(t, organizationId)).toBe(noticeId);
    await expect(notice(t, organizationId, "sandbox-notice-2")).rejects.toThrow(
      "SANDBOX_CLOSURE_NOTICE_EXISTS",
    );
    await expect(notice(t, await organization(t))).rejects.toThrow("SANDBOX_CLOSURE_KEY_REUSED");
  });
});

describe("E-mail do aviso", () => {
  it("um e-mail por owner ou admin ativo, nunca duas vezes", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const owner = await person(t, organizationId, "owner");
    const admin = await person(t, organizationId, "admin");
    await person(t, organizationId, "viewer");
    await person(t, organizationId, "developer");
    const noticeId = await notice(t, organizationId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const expected = [
      { email: await email(t, owner.membershipId), noticeId },
      { email: await email(t, admin.membershipId), noticeId },
    ].sort((a, b) => a.email.localeCompare(b.email));
    expect(await mailbox(t)).toEqual(expected);
    expect((await row(t, noticeId)).noticeMail).toMatchObject({
      state: "sent",
      recipients: 2,
      confirmed: 2,
      withheld: 0,
    });
    // A repeated notice, and a repeated send, find the claimed row: nothing goes out again.
    expect(await notice(t, organizationId)).toBe(noticeId);
    await t.action(internal.sandboxClosure.deliver, { noticeId });
    await t.mutation(internal.sandboxClosure.resumePending, { olderThanMinutes: 0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await mailbox(t)).toEqual(expected);
    expect(await t.query(internal.sandboxClosure.mailStatus, { before: Date.now() + 1 })).toEqual(
      [],
    );
  });

  it("o operador retoma um envio perdido antes da reserva", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const owner = await person(t, organizationId, "owner");
    const noticeId = await notice(t, organizationId);
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect())
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    });
    expect(await t.query(internal.sandboxClosure.mailStatus, { before: Date.now() + 1 })).toEqual([
      { noticeId, organizationId, mail: "pending", state: "notice", noticeAt: Date.now() },
    ]);
    expect(await t.mutation(internal.sandboxClosure.resumePending, {})).toEqual({ resumed: 0 });
    vi.advanceTimersByTime(61 * 60_000);
    expect(await t.mutation(internal.sandboxClosure.resumePending, {})).toEqual({ resumed: 1 });
    expect(await t.mutation(internal.sandboxClosure.resumePending, {})).toEqual({ resumed: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await mailbox(t)).toEqual([{ email: await email(t, owner.membershipId), noticeId }]);
    expect((await row(t, noticeId)).noticeMail.state).toBe("sent");
  });

  it("o texto diz a organização, a data de Brasília, o porquê, o que é apagado e a ação", () => {
    const mail = sandboxClosureMail({
      organization: "Sandbox",
      slug: "sandbox",
      // 26/11/2026 at 23:30 in Brasília.
      closeAt: Date.UTC(2026, 10, 27, 2, 30),
      siteUrl: "https://console.example.invalid/app",
    });
    expect(mail.subject).toBe("A organização Sandbox será encerrada a partir de 26/11/2026");
    expect(mail.text).toContain("só tem dados de Sandbox e está há 90 dias sem atividade");
    expect(mail.text).toContain("não têm validade fiscal");
    expect(mail.text).toContain("exportação fica disponível por 30 dias");
    expect(mail.text).toContain("A conta de cada pessoa continua");
    expect(mail.text).toContain('"Manter ativa"');
    expect(mail.text).toContain("https://console.example.invalid/app/sandbox");
  });
});

describe("Manter ativa", () => {
  it("owner ou admin mantém ativa; viewer e outra organização são recusados", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const admin = await person(t, organizationId, "admin");
    const viewer = await person(t, organizationId, "viewer");
    const other = await organization(t);
    const outsider = await person(t, other, "owner");
    const noticeId = await notice(t, organizationId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await viewer.query(api.sandboxClosure.status, { organizationId })).toEqual({
      noticeId,
      closeAt: Date.now() + 30 * ARCHIVE_DAY,
      canAct: false,
    });
    expect(await admin.query(api.sandboxClosure.status, { organizationId })).toMatchObject({
      canAct: true,
    });
    await expect(
      viewer.mutation(api.sandboxClosure.keepActive, { organizationId, noticeId }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      outsider.mutation(api.sandboxClosure.keepActive, { organizationId, noticeId }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(outsider.query(api.sandboxClosure.status, { organizationId })).rejects.toThrow(
      "ACCESS_DENIED",
    );
    // Its own organization does not reach another one's notice.
    await expect(
      outsider.mutation(api.sandboxClosure.keepActive, { organizationId: other, noticeId }),
    ).rejects.toThrow("SANDBOX_CLOSURE_NOTICE_NOT_FOUND");
    expect((await row(t, noticeId)).state).toBe("notice");

    await admin.mutation(api.sandboxClosure.keepActive, { organizationId, noticeId });
    expect(await row(t, noticeId)).toMatchObject({
      state: "kept_active",
      version: 2,
      keptActiveAt: Date.now(),
    });
    await admin.mutation(api.sandboxClosure.keepActive, { organizationId, noticeId });
    const audit = await t.run((ctx) =>
      ctx.db
        .query("organizationAudit")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .collect(),
    );
    expect(audit.filter((entry) => entry.action === "organization.kept-active")).toHaveLength(1);
    expect(await viewer.query(api.sandboxClosure.status, { organizationId })).toBeNull();

    // The closure finds the notice ended and closes nothing.
    vi.advanceTimersByTime(30 * ARCHIVE_DAY);
    expect(await t.mutation(internal.sandboxClosure.close, { noticeId, version: 1 })).toMatchObject(
      { state: "kept_active" },
    );
    expect(await closure(t, organizationId)).toBeNull();
    // It counts as activity: the 90 days start over.
    await expect(notice(t, organizationId, "sandbox-notice-2")).rejects.toThrow(
      "SANDBOX_CLOSURE_ACTIVE",
    );
    vi.advanceTimersByTime(60 * ARCHIVE_DAY);
    await notice(t, organizationId, "sandbox-notice-2");
  });
});

describe("Encerramento pela Freecorps", () => {
  it("antes de closeAt recusa; depois encerra uma vez, como o encerramento do owner", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const noticeId = await notice(t, organizationId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.advanceTimersByTime(30 * ARCHIVE_DAY - 1);
    await expect(
      t.mutation(internal.sandboxClosure.close, { noticeId, version: 1 }),
    ).rejects.toThrow("SANDBOX_CLOSURE_NOTICE_PENDING");
    expect(await t.query(internal.sandboxClosure.due, { before: Date.now() })).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(await t.query(internal.sandboxClosure.due, { before: Date.now() + 1 })).toEqual([
      { noticeId, organizationId, version: 1, closeAt: Date.now() },
    ]);

    const closed = await t.mutation(internal.sandboxClosure.close, { noticeId, version: 1 });
    const started = await closure(t, organizationId);
    expect(started).toMatchObject({
      state: "closing",
      requestedAt: Date.now(),
      requestedBy: "freecorps:sandbox-inactive",
    });
    expect(closed).toEqual({ state: "closed", closureId: started!._id });
    expect(await row(t, noticeId)).toMatchObject({
      state: "closed",
      version: 2,
      closureId: started!._id,
    });
    const audit = await t.run((ctx) =>
      ctx.db
        .query("organizationAudit")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .collect(),
    );
    expect(
      audit.filter((entry) => entry.action === "organization.closure-requested"),
    ).toMatchObject([{ actorUserId: "operator:freecorps", target: organizationId }]);
    // The organization is closed for its members, as after the owner's closure.
    const viewer = await person(t, organizationId, "viewer");
    await expect(viewer.query(api.sandboxClosure.status, { organizationId })).rejects.toThrow(
      "ORGANIZATION_CLOSED",
    );

    // A second call is a no-op.
    expect(await t.mutation(internal.sandboxClosure.close, { noticeId, version: 1 })).toEqual(
      closed,
    );
    expect(await t.mutation(internal.sandboxClosure.close, { noticeId, version: 2 })).toEqual(
      closed,
    );
    expect(await t.run((ctx) => ctx.db.query("organizationClosures").collect())).toHaveLength(1);

    // The closure purge follows, with the early removal of Sandbox data: the notice goes too.
    // Fake timers clamp delays above 2^31 ms to 1 ms: step through the jobs due at the end of the
    // export window, as the closure suite does, instead of running every future guard check.
    vi.setSystemTime(started!.exportUntil + 1);
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(1);
      await t.finishInProgressScheduledFunctions();
    }
    expect(await closure(t, organizationId)).toMatchObject({ state: "purged", sandboxOnly: true });
    expect(await t.run((ctx) => ctx.db.query("sandboxClosureNotices").collect())).toEqual([]);
  });

  it("atividade depois do aviso cancela e não encerra", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const noticeId = await notice(t, organizationId);
    vi.advanceTimersByTime(ARCHIVE_DAY);
    await t.run((ctx) =>
      // A download: REST traffic counts as activity.
      ctx.db.insert("capacityEvents", {
        organizationId,
        key: "synthetic-download",
        metric: "downloadsBytes",
        period: "2026-10",
        quantity: 1,
        remaining: 0,
        state: "committed",
        updatedAt: Date.now(),
      }),
    );
    vi.advanceTimersByTime(30 * ARCHIVE_DAY);
    await expect(
      t.mutation(internal.sandboxClosure.close, { noticeId, version: 1 }),
    ).resolves.toEqual({ state: "cancelled", cancelled: "activity" });
    expect(await row(t, noticeId)).toMatchObject({ state: "cancelled", version: 2 });
    expect(await closure(t, organizationId)).toBeNull();
    // Repeating it changes nothing.
    await expect(
      t.mutation(internal.sandboxClosure.close, { noticeId, version: 2 }),
    ).resolves.toEqual({ state: "cancelled", cancelled: "activity" });
  });

  it("organização que ganha dados de Produção durante o aviso não é encerrada", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const noticeId = await notice(t, organizationId);
    vi.advanceTimersByTime(30 * ARCHIVE_DAY);
    // Recorded with an old date: Production cancels even without activity.
    await t.run((ctx) => production(ctx, organizationId, Date.now() - 200 * ARCHIVE_DAY));
    await expect(
      t.mutation(internal.sandboxClosure.close, { noticeId, version: 1 }),
    ).resolves.toEqual({ state: "cancelled", cancelled: "production" });
    expect(await closure(t, organizationId)).toBeNull();
  });
});
