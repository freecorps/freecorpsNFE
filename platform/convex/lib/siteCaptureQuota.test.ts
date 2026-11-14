import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../_generated/api";
import { capturePlan, person } from "../../../tests/helpers/platform";
import { fixture as corpus } from "../../../tests/helpers/nfe-corpus";
import { hashApiKey } from "./apiKeyCrypto";
import { distributionXml } from "../../../tests/helpers/distribution";
import { recordUsage, requireQuota } from "./usageCore";
import { publicError } from "./publicErrors";
import { ConvexError } from "convex/values";
import { PLATFORM_PLANS } from "./planCatalog";
import { usagePeriod } from "./usageValues";
import {
  development,
  site,
  stub,
  siteFixture,
  respond,
  streamOf,
} from "../../../tests/helpers/siteCapture";
import {
  type Fixture,
  attentionEvents,
  opOf,
  consoleStart,
  cycle,
  claimAt,
  renew,
  scheduledResume,
} from "../../../tests/helpers/siteCaptureContinuity";

vi.mock("../buildInfo", () => ({ buildSha: "a".repeat(40) }));

beforeEach(() => {
  vi.useFakeTimers();
  stub(development);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/**
 * #418: a production capture never stops in silence. Each pause turns the stream to attention,
 * with its code and one `connection.attention_required`; the next queries follow the company's
 * release and its current A1, not the person who clicked "Iniciar"; a quota pause comes back by
 * itself when the quota does.
 */
describe("continuidade da captura em Produção", () => {
  const plan = (
    f: Fixture,
    captures: number,
    expectedVersion: number,
    endsAt: number | null = Date.UTC(2027, 11, 31),
    periodAnchor?: number,
  ) =>
    f.t.mutation(internal.usage.assignPlan, {
      organizationId: f.scope.organizationId,
      name: "Plano sintético",
      startsAt: Date.UTC(2026, 0, 1),
      endsAt,
      ...(periodAnchor === undefined ? {} : { periodAnchor }),
      limits: { imports: null, bytes: 1e12, captures, registry: null, deliveries: null },
      concurrency: 2,
      actor: "test",
      reason: "cota sintética",
      expectedVersion,
    });
  /** A quota of one capture, spent by the first query: the second pauses in attention. */
  async function exhausted(endsAt?: number | null, periodAnchor?: number) {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const f = await siteFixture();
    await plan(f, 1, 1, endsAt, periodAnchor);
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    const token = await claimAt(f, next);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
    expect(await opOf(f, next)).toMatchObject({ state: "paused", code: "QUOTA_EXCEEDED" });
    expect(await streamOf(f, streamId)).toMatchObject({
      state: "attention",
      code: "QUOTA_EXCEEDED",
    });
    expect(await attentionEvents(f)).toHaveLength(1);
    return { f, streamId, paused: next };
  }

  it("cota esgotada: atenção com webhook; no período seguinte a captura volta sozinha", async () => {
    const { f, streamId, paused } = await exhausted();
    const resume = (await scheduledResume(f))!;
    expect(resume.at).toBe(Date.UTC(2026, 10, 1));
    // Early, nothing changes.
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    expect(await streamOf(f, streamId)).toMatchObject({ state: "attention" });
    vi.setSystemTime(resume.at);
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active" });
    expect(stream.operationId).not.toBe(paused);
    const token = await claimAt(f, stream.operationId!);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).not.toBeNull();
    // The same check run again resumes nothing more.
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    expect((await streamOf(f, streamId)).operationId).toBe(stream.operationId);
    expect(await attentionEvents(f)).toHaveLength(1);
  });

  // ADR 0012: an anchored plan's quota resets on its anniversary, not on the civil 1st.
  it("plano ancorado: cota esgotada retoma no aniversário da âncora", async () => {
    const anchor = Date.UTC(2025, 11, 15, 14, 30);
    const { f, streamId, paused } = await exhausted(undefined, anchor);
    const resume = (await scheduledResume(f))!;
    expect(resume.at).toBe(Date.UTC(2026, 10, 15, 14, 30));
    vi.setSystemTime(Date.UTC(2026, 10, 1));
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    expect(await streamOf(f, streamId)).toMatchObject({ state: "attention" });
    vi.setSystemTime(resume.at);
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active" });
    expect(stream.operationId).not.toBe(paused);
  });

  // #429: a plan without an end (the permanent free tier) keeps the monthly quota: a capture
  // paused by it resumes in the next period, with that month's units only. The many-month term
  // is proved in platform/convex/usage.test.ts.
  it("plano sem vencimento: cota esgotada retoma no mês seguinte, sem acumular cota", async () => {
    const { f, streamId, paused } = await exhausted(null);
    const resume = (await scheduledResume(f))!;
    expect(resume.at).toBe(Date.UTC(2026, 10, 1));
    vi.setSystemTime(resume.at);
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active" });
    expect(stream.operationId).not.toBe(paused);
    // November's single unit is spent; the next query pauses again instead of using a unit left
    // over from October, and waits for December.
    const next = await cycle(f, streamId, stream.operationId!);
    const token = await claimAt(f, next);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
    expect(await opOf(f, next)).toMatchObject({ state: "paused", code: "QUOTA_EXCEEDED" });
    expect(await streamOf(f, streamId)).toMatchObject({
      state: "attention",
      code: "QUOTA_EXCEEDED",
    });
    const pending = await f.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (r) => r.name.includes("resumeEligible") && r.state.kind === "pending",
      ),
    );
    expect(pending.map((r) => r.scheduledTime)).toContain(Date.UTC(2026, 11, 1));
  });

  // #429: the same plan limit is counted in each environment's own balance.
  it("cota esgotada no sandbox não pausa a captura em produção", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const f = await siteFixture();
    await plan(f, 2, 1);
    for (const key of ["sandbox-query-1", "sandbox-query-2"])
      await f.t.run((ctx) => recordUsage(ctx, f.scope.organizationId, "sandbox", "captures", key));
    await expect(
      f.t.run((ctx) => requireQuota(ctx, f.scope.organizationId, "sandbox", "captures")),
    ).rejects.toThrow("QUOTA_EXCEEDED");
    // The first cycle spends production's first unit; the second query still has its own.
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    const token = await claimAt(f, next);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).not.toBeNull();
    expect(await streamOf(f, streamId)).toMatchObject({ state: "active" });
    // Each environment's balance is the sum of its lanes (#559).
    const totals = await f.t.run((ctx) => ctx.db.query("usageTotals").collect());
    const committed = (environment: string) =>
      totals
        .filter((row) => row.metric === "captures" && row.environment === environment)
        .reduce((sum, row) => sum + row.committed, 0);
    expect({ sandbox: committed("sandbox"), production: committed("production") }).toEqual({
      sandbox: 2,
      production: 2,
    });
  });

  it("cota esgotada em produção não bloqueia o sandbox", async () => {
    const { f } = await exhausted();
    await expect(
      f.t.run((ctx) => requireQuota(ctx, f.scope.organizationId, "production", "captures")),
    ).rejects.toThrow("QUOTA_EXCEEDED");
    // Throws QUOTA_EXCEEDED if the sandbox shared production's balance.
    await f.t.run((ctx) => requireQuota(ctx, f.scope.organizationId, "sandbox", "captures"));
  });

  it("cota restabelecida por novo plano: a captura volta sem esperar o período", async () => {
    const { f, streamId } = await exhausted();
    await plan(f, 10, 2);
    const resume = (await scheduledResume(f))!;
    expect(resume.at).toBeLessThanOrEqual(Date.now());
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active" });
    const token = await claimAt(f, stream.operationId!);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).not.toBeNull();
  });

  // ADR 0010, decisions 10 and 11: the free tier caps Production by 100 new notes a month, one per
  // company and access key, instead of its 100 capture queries, which stay the sandbox's quota.
  describe("cota de notas do Gratuito", () => {
    /** A site fixture under the free tier's catalog limits, with `notes` already counted. */
    async function freeTier(notes: number, now = Date.UTC(2026, 9, 23, 12)) {
      vi.setSystemTime(now);
      const f = await siteFixture({ plan: false });
      await capturePlan(f.t, f.scope.organizationId, PLATFORM_PLANS.free.limits);
      await f.t.run(async (ctx) => {
        for (let i = 0; i < notes; i++)
          await recordUsage(
            ctx,
            f.scope.organizationId,
            "production",
            "documents",
            `earlier:${i}`,
            1,
            true,
          );
      });
      return f;
    }
    /** New notes of the month in Production, as Uso e limites shows them. */
    async function notes(f: Fixture) {
      const owner = await person(f.t, f.scope.organizationId, "owner");
      const view = await owner.query(api.usage.overview, {
        organizationId: f.scope.organizationId,
        period: usagePeriod(Date.now()),
        contextKey: "test",
      });
      const row = view.environments.production.find((r) => r.metric === "documents")!;
      return row.committed + row.reserved;
    }
    /** What the capture panel and the Início say of the production stream. */
    async function shown(f: Fixture) {
      const owner = await person(f.t, f.scope.organizationId, "owner");
      const stream = (await owner.query(api.captures.get, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "production",
      }))!;
      const item = (
        await owner.query(api.consoleHome.summary, {
          organizationId: f.scope.organizationId,
          monthStart: Date.now() - 86_400_000,
          asOf: Date.now(),
          contextKey: "notes",
        })
      ).pending.find((entry) => entry.kind === "capture-attention");
      return { stream, item };
    }
    /** Every `documents.capture` the checkpoint created, run by the worker. */
    async function processReceived(f: Fixture) {
      for (const envelope of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect())) {
        const op = await opOf(f, envelope.operationId!);
        vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
        await f.t.action(internal.operationWorker.run, {
          operationId: op._id,
          generation: op.generation,
        });
        expect(await opOf(f, op._id)).toMatchObject({ state: "succeeded" });
      }
    }

    it("com 99 notas a consulta sai; com 100 a seguinte pausa e volta no mês seguinte", async () => {
      const f = await freeTier(99);
      // The queries themselves no longer count against the free tier in Production.
      await f.t.run(async (ctx) => {
        for (let i = 0; i < 100; i++)
          await recordUsage(ctx, f.scope.organizationId, "production", "captures", `q:${i}`);
      });
      const { streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      await f.t.run((ctx) =>
        recordUsage(ctx, f.scope.organizationId, "production", "documents", "earlier:99", 1, true),
      );
      const token = await claimAt(f, next);
      expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
      expect(await opOf(f, next)).toMatchObject({ state: "paused", code: "QUOTA_EXCEEDED" });
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "attention",
        code: "QUOTA_EXCEEDED",
      });
      // The panel and the Início name the notes limit.
      const paused = await shown(f);
      expect(paused.stream).toMatchObject({ countsNotes: true, notesQuota: true });
      expect(paused.item).toMatchObject({ code: "QUOTA_EXCEEDED", notesQuota: true });
      // The sandbox stays outside the notes: its own 100 queries still admit.
      await f.t.run((ctx) => requireQuota(ctx, f.scope.organizationId, "sandbox", "captures"));
      const resume = (await scheduledResume(f))!;
      expect(resume.at).toBe(Date.UTC(2026, 10, 1));
      vi.setSystemTime(resume.at);
      await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
      const stream = await streamOf(f, streamId);
      expect(stream).toMatchObject({ state: "active" });
      const again = await claimAt(f, stream.operationId!);
      expect(await f.t.mutation(internal.captureProcessing.prepare, again!)).not.toBeNull();
    });

    it("parada por outra cota no Gratuito, a captura não diz que foi a de notas", async () => {
      const f = await freeTier(10);
      // The month's bytes leave less than the 18 MiB a query reserves.
      await f.t.run((ctx) =>
        recordUsage(
          ctx,
          f.scope.organizationId,
          "production",
          "bytes",
          "earlier:bytes",
          PLATFORM_PLANS.free.limits.bytes - 1,
          true,
        ),
      );
      const { streamId, operationId } = await consoleStart(f);
      const token = await claimAt(f, operationId);
      expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({ code: "QUOTA_EXCEEDED" });
      const { stream, item } = await shown(f);
      expect(stream.countsNotes).toBe(true);
      expect(stream.notesQuota).toBeUndefined();
      expect(item).toMatchObject({ code: "QUOTA_EXCEEDED", countsNotes: true });
      expect(item?.notesQuota).toBeUndefined();
    });

    it("pausada pelas notas no fim de outubro, continua marcada em novembro até retomar", async () => {
      const f = await freeTier(100, Date.UTC(2026, 9, 31, 22));
      const { streamId, operationId } = await consoleStart(f);
      const token = await claimAt(f, operationId);
      expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "attention",
        code: "QUOTA_EXCEEDED",
      });
      expect((await shown(f)).stream).toMatchObject({ notesQuota: true });
      // November has no notes yet, but the pause was October's: no resume ran, so it still says why.
      vi.setSystemTime(Date.UTC(2026, 10, 1, 1));
      expect(await streamOf(f, streamId)).toMatchObject({ state: "attention" });
      expect((await shown(f)).stream).toMatchObject({ countsNotes: true, notesQuota: true });
    });

    it("a consulta admitida com 99 notas entra inteira; resumo, XML e evento da mesma chave contam uma", async () => {
      const f = await freeTier(99);
      const { streamId, operationId } = await consoleStart(f);
      const token = await f.claim(operationId);
      await respond(
        f,
        token,
        distributionXml({
          environment: "1",
          envelopes: [
            { nsu: 1, xml: corpus("summary-authorized") },
            { nsu: 2, xml: corpus("invoice-authorized"), schema: "procNFe_v4.00.xsd" },
            { nsu: 3, xml: corpus("event-110111"), schema: "procEventoNFe_v1.00.xsd" },
            // Another access key: a second new note of the same answer.
            { nsu: 4, xml: corpus("invoice-alphanumeric"), schema: "procNFe_v4.00.xsd" },
          ],
        }),
      );
      expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
      await processReceived(f);
      const docs = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
      expect(docs).toHaveLength(2);
      expect(await notes(f)).toBe(101);
      // The completion of each processing delivered again (the workpool's callback is at least
      // once) publishes nothing new and counts no note. Reprocessing a captured document is an
      // import purpose, which the site never serves in Production (`environmentServed`).
      for (const envelope of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
        await f.t.mutation(internal.importProcessing.published, {
          operationId: envelope.operationId!,
        });
      expect(await notes(f)).toBe(101);
      const owner = await person(f.t, f.scope.organizationId, "owner");
      await expect(
        owner.mutation(api.documents.reprocess, {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          environment: "production",
          documentId: docs[0]!._id,
          key: "reprocess-captured",
        }),
      ).rejects.toThrow("NOT_FOUND");
      expect(await notes(f)).toBe(101);
      // Still active: the console knows the plan counts notes, but nothing stopped on them yet.
      const active = (await shown(f)).stream;
      expect(active.countsNotes).toBe(true);
      expect(active.notesQuota).toBeUndefined();
      const next = (await streamOf(f, streamId)).operationId!;
      const again = await claimAt(f, next);
      expect(await f.t.mutation(internal.captureProcessing.prepare, again!)).toBeNull();
      expect(await opOf(f, next)).toMatchObject({ state: "paused", code: "QUOTA_EXCEEDED" });
      expect((await shown(f)).stream).toMatchObject({ countsNotes: true, notesQuota: true });
    });
  });

  // #429: production capture requires the organization's plan with finite quotas, the free tier
  // included; the sandbox keeps metering without one.
  const written = (f: Fixture) =>
    f.t.run(async (ctx) => ({
      streams: (await ctx.db.query("captureStreams").collect()).length,
      operations: (await ctx.db.query("operations").collect()).length,
      usage: (await ctx.db.query("usageEvents").collect()).length,
    }));
  it("sem plano, Produção recusa ativar no console e pela API sem gravar nada; o sandbox segue", async () => {
    const f = await siteFixture({ plan: false });
    await expect(consoleStart(f)).rejects.toThrow("PLAN_REQUIRED");
    await expect(f.command("production", "activate")).rejects.toThrow("PLAN_REQUIRED");
    expect(await written(f)).toEqual({ streams: 0, operations: 0, usage: 0 });
    // The sandbox, without a plan, is admitted and metered as before.
    await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { environment: "sandbox" }));
    const sandbox = await f.command("sandbox", "activate");
    expect(
      await f.t.mutation(internal.captureProcessing.prepare, await f.claim(sandbox.operationId)),
    ).not.toBeNull();
    expect(await opOf(f, sandbox.operationId)).toMatchObject({
      environment: "sandbox",
      state: "running",
    });
    const metered = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
    expect(metered.map((e) => [e.environment, e.metric])).toEqual(
      expect.arrayContaining([["sandbox", "captures"]]),
    );
    expect(publicError(new ConvexError({ code: "PLAN_REQUIRED" }))).toMatchObject({
      status: 403,
      error: { code: "SCOPE_DENIED", message: expect.stringContaining("exige um plano") },
    });
  });

  it.each([
    ["consultas", { captures: null }],
    ["bytes", { bytes: null }],
  ] as const)("plano sem cota finita de %s não admite a captura em Produção", async (_, limits) => {
    const f = await siteFixture({ plan: false });
    await capturePlan(f.t, f.scope.organizationId, limits);
    await expect(consoleStart(f)).rejects.toThrow("PLAN_REQUIRED");
    await expect(f.command("production", "activate")).rejects.toThrow("PLAN_REQUIRED");
    expect(await written(f)).toEqual({ streams: 0, operations: 0, usage: 0 });
  });

  it("plano vencido recusa com PLAN_INACTIVE; o plano vigente admite a consulta", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const f = await siteFixture({ plan: false });
    await f.t.mutation(internal.usage.assignPlan, {
      organizationId: f.scope.organizationId,
      name: "Piloto encerrado",
      startsAt: Date.UTC(2026, 0, 1),
      endsAt: Date.UTC(2026, 5, 1),
      limits: { imports: null, bytes: 1e12, captures: 10, registry: null, deliveries: null },
      concurrency: 2,
      actor: "test",
      reason: "piloto sintético",
      expectedVersion: 0,
    });
    await expect(consoleStart(f)).rejects.toThrow("PLAN_INACTIVE");
    expect(await written(f)).toEqual({ streams: 0, operations: 0, usage: 0 });
    await capturePlan(f.t, f.scope.organizationId, {}, 1);
    const { operationId } = await consoleStart(f);
    const token = await claimAt(f, operationId);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).not.toBeNull();
  });

  it("o plano de outra organização não admite a captura desta", async () => {
    const f = await siteFixture({ plan: false });
    vi.unstubAllEnvs();
    stub(development);
    const other = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash: await hashApiKey(`fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "b")}`),
      suffix: crypto.randomUUID(),
    });
    vi.unstubAllEnvs();
    stub(site);
    expect(other.organizationId).not.toBe(f.scope.organizationId);
    await capturePlan(f.t, other.organizationId);
    await expect(consoleStart(f)).rejects.toThrow("PLAN_REQUIRED");
    await expect(f.command("production", "activate")).rejects.toThrow("PLAN_REQUIRED");
  });

  it("plano trocado por um sem cotas pausa a consulta seguinte; só um novo plano a retoma", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const f = await siteFixture();
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    await capturePlan(f.t, f.scope.organizationId, { captures: null }, 1);
    const token = await claimAt(f, next);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
    expect(await opOf(f, next)).toMatchObject({ state: "paused", code: "PLAN_REQUIRED" });
    const paused = await streamOf(f, streamId);
    expect(paused).toMatchObject({ state: "attention", code: "PLAN_REQUIRED" });
    expect(await attentionEvents(f)).toHaveLength(1);
    // Neither time nor a person brings it back while the plan has no quota.
    expect(await scheduledResume(f)).toBeNull();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    await expect(
      owner.mutation(api.captures.control, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "production",
        action: "resume",
        expectedVersion: paused.version,
      }),
    ).rejects.toThrow("PLAN_REQUIRED");
    await capturePlan(f.t, f.scope.organizationId, {}, 2);
    const resume = (await scheduledResume(f))!;
    expect(resume.at).toBeLessThanOrEqual(Date.now());
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active" });
    expect(stream.operationId).not.toBe(next);
    const again = await claimAt(f, stream.operationId!);
    expect(await f.t.mutation(internal.captureProcessing.prepare, again!)).not.toBeNull();
    expect(await attentionEvents(f)).toHaveLength(1);
  });

  it("consulta incerta já admitida reconcilia mesmo com o plano sem cotas, sem nova cobrança", async () => {
    const f = await siteFixture();
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    const token = await f.claim(next);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token)).not.toBeNull();
    await renew(f);
    await f.t.mutation(internal.operations.recordOutcome, {
      ...token,
      outcome: { kind: "uncertain", code: "CAPTURE_CHANGED" },
    });
    expect(await opOf(f, next)).toMatchObject({ state: "paused", uncertain: true });
    const charged = (await opOf(f, next)).usageCaptureKey;
    expect(charged).toBeDefined();
    await capturePlan(f.t, f.scope.organizationId, { captures: null, bytes: null }, 1);
    const events = async () =>
      (await f.t.run((ctx) => ctx.db.query("usageEvents").collect())).filter(
        (e) => e.metric === "captures",
      ).length;
    const before = await events();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    await owner.mutation(api.captures.control, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "production",
      action: "resume",
      expectedVersion: (await streamOf(f, streamId)).version,
    });
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active", mode: "consNSU" });
    // At the source window, so `prepare` reaches the usage check.
    vi.setSystemTime(Math.max(Date.now(), stream.nextAllowedAt));
    const resumed = (await claimAt(f, stream.operationId!))!;
    expect(await f.t.mutation(internal.captureProcessing.prepare, resumed)).toMatchObject({
      mode: "consNSU",
    });
    expect(await opOf(f, stream.operationId!)).toMatchObject({ usageCaptureKey: charged });
    expect(await f.t.mutation(internal.certificateUse.authorize, resumed)).not.toBeNull();
    expect(await events()).toBe(before);
  });
});
