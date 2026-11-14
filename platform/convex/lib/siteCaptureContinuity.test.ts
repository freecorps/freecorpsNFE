import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../_generated/api";
import { person } from "../../../tests/helpers/platform";
import { fixture as corpus } from "../../../tests/helpers/nfe-corpus";
import { distributionXml } from "../../../tests/helpers/distribution";
import {
  development,
  stub,
  siteFixture,
  respond,
  streamOf,
} from "../../../tests/helpers/siteCapture";
import {
  attentionEvents,
  opOf,
  headOf,
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
  it("renovação do A1 da própria empresa: a consulta seguinte usa o certificado novo", async () => {
    const f = await siteFixture();
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    const renewed = await renew(f);
    const token = await claimAt(f, next);
    expect(token).not.toBeNull();
    expect((await opOf(f, next)).certificate?.id).toBe(renewed);
    expect((await f.t.mutation(internal.certificateUse.authorize, token!))?._id).toBe(renewed);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).not.toBeNull();
    expect(await streamOf(f, streamId)).toMatchObject({ state: "active" });
    expect(await attentionEvents(f)).toHaveLength(0);
  });

  it("A1 ativo de outro CNPJ ou vencido não passa: a captura entra em atenção", async () => {
    for (const change of ["foreign", "expired"] as const) {
      vi.unstubAllEnvs();
      stub(development);
      const f = await siteFixture();
      const { streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      if (change === "foreign") await renew(f, "99888777000166");
      else {
        const head = await headOf(f);
        const due = (await opOf(f, next)).nextAttemptAt;
        await f.t.run(async (ctx) => {
          const cert = (await ctx.db.get("certificates", head.activeId!))!;
          await ctx.db.patch("certificates", cert._id, {
            metadata: { ...cert.metadata!, notAfter: due - 1 },
          });
        });
      }
      expect(await claimAt(f, next), change).toBeNull();
      expect(await opOf(f, next)).toMatchObject({
        state: "paused",
        code: "CERTIFICATE_UNAVAILABLE",
      });
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "attention",
        code: "CERTIFICATE_UNAVAILABLE",
      });
      expect(await attentionEvents(f)).toHaveLength(1);
    }
  });

  it("um A1 válido da empresa ativado depois da atenção retoma a captura sozinho", async () => {
    const f = await siteFixture();
    const { owner, streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    const expired = await headOf(f);
    await f.t.run(async (ctx) => {
      await ctx.db.patch("certificates", expired.activeId!, { state: "expired" });
      await ctx.db.patch("certificateHeads", expired._id, { activeId: undefined });
    });
    expect(await claimAt(f, next)).toBeNull();
    expect((await streamOf(f, streamId)).code).toBe("CERTIFICATE_UNAVAILABLE");
    expect(await scheduledResume(f)).toBeNull();
    // The owner uploads the renewed A1; the vault validates it and makes it active.
    const uploaded = await f.t.run(async (ctx) => {
      const old = (await ctx.db.get("certificates", expired.latestId!))!;
      const { _id, _creationTime, metadata, ...copy } = old;
      const id = await ctx.db.insert("certificates", {
        ...copy,
        version: expired.nextVersion,
        state: "validating",
        membershipId: owner.membershipId,
        membershipVersion: 1,
      });
      await ctx.db.patch("certificateHeads", expired._id, {
        latestId: id,
        nextVersion: expired.nextVersion + 1,
      });
      return { id, metadata: { ...metadata!, notAfter: Date.now() + 365 * 86400_000 } };
    });
    await f.t.mutation(internal.certificates.finish, uploaded);
    const resume = (await scheduledResume(f))!;
    expect(resume).not.toBeNull();
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active" });
    const token = await claimAt(f, stream.operationId!);
    expect((await f.t.mutation(internal.certificateUse.authorize, token!))?._id).toBe(uploaded.id);
  });

  it("troca de papel e saída de quem iniciou não param as consultas seguintes", async () => {
    for (const change of ["viewer", "removed"] as const) {
      vi.unstubAllEnvs();
      stub(development);
      const f = await siteFixture();
      const { owner, streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      await f.t.run(async (ctx) => {
        const membership = (await ctx.db.get("memberships", owner.membershipId))!;
        await ctx.db.patch("memberships", membership._id, {
          ...(change === "viewer"
            ? { role: "viewer" as const }
            : {
                state: "removed" as const,
                companyAccessEpoch: (membership.companyAccessEpoch ?? 0) + 1,
              }),
          version: membership.version + 1,
        });
      });
      const token = await claimAt(f, next);
      expect(token, change).not.toBeNull();
      expect(await f.t.mutation(internal.certificateUse.authorize, token!)).not.toBeNull();
      // The documents of that query are processed under the same release.
      expect(await f.t.mutation(internal.operations.beginEffect, token!)).toBe(true);
      await respond(
        f,
        token!,
        distributionXml({
          environment: "1",
          envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
        }),
      );
      const [envelope] = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
      expect(envelope?.operationId, change).toBeDefined();
      const child = await opOf(f, envelope!.operationId!);
      expect(
        await f.t.mutation(internal.operations.claim, {
          operationId: child._id,
          generation: child.generation,
        }),
      ).not.toBeNull();
      expect(await attentionEvents(f)).toHaveLength(0);
    }
  });

  it("a liberação continua cortando: retirar e liberar de novo não ressuscita a consulta", async () => {
    const f = await siteFixture();
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    await f.setRelease(false);
    await f.setRelease(true);
    expect(await claimAt(f, next)).toBeNull();
    expect(await opOf(f, next)).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
    expect(await streamOf(f, streamId)).toMatchObject({
      state: "attention",
      code: "ACCESS_REVOKED",
    });
  });

  it("A1 renovado com a consulta já enviada: atenção ACCESS_REVOKED e a retomada reconcilia com o A1 novo (#425)", async () => {
    const f = await siteFixture();
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    // The worker has the vault's answer and the request left (`beginEffect`, stage `calling`).
    const token = await f.claim(next);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token)).not.toBeNull();
    const renewed = await renew(f);
    expect(
      await f.t.mutation(internal.operations.recordOutcome, {
        ...token,
        outcome: { kind: "uncertain", code: "CAPTURE_CHANGED" },
      }),
    ).toBe(false);
    expect(await opOf(f, next)).toMatchObject({
      state: "paused",
      code: "ACCESS_REVOKED",
      uncertain: true,
    });
    const stopped = await streamOf(f, streamId);
    expect(stopped).toMatchObject({ state: "attention", code: "ACCESS_REVOKED" });
    expect(await attentionEvents(f)).toHaveLength(1);
    expect(await scheduledResume(f)).toBeNull();
    const operator = await person(f.t, f.scope.organizationId, "operator", {
      companyId: f.scope.companyId,
    });
    await operator.mutation(api.captures.control, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "production",
      action: "resume",
      expectedVersion: stopped.version,
    });
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active", mode: "consNSU" });
    const resumed = await claimAt(f, stream.operationId!);
    expect((await f.t.mutation(internal.certificateUse.authorize, resumed!))?._id).toBe(renewed);
  });

  it("mudar o intervalo não corta a consulta agendada, não a antecipa e um maior a adia (#432)", async () => {
    const f = await siteFixture();
    const { owner, streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    const answered = await streamOf(f, streamId);
    expect(answered.nextAllowedAt).toBe(answered.lastSuccessAt! + 3_600_000);
    const release = () =>
      f.t.run(
        async (ctx) =>
          (await ctx.db
            .query("captureReleases")
            .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
            .unique())!,
      );
    const pinned = (await release()).version;
    // More than a page of rows without an answer since then (#494): the end of the queue the
    // answer reached still counts.
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 24; i++)
        await ctx.db.insert("captureAudit", {
          streamId,
          organizationId: answered.organizationId,
          action: "fiscal_halt_deferred",
          actor: "system",
          checkpoint: answered.checkpoint,
          createdAt: Date.now(),
        });
    });
    const change = (minIntervalHours: number) =>
      owner.mutation(api.captureRelease.updateInterval, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        minIntervalHours,
      });
    // Longer: the stream waiting at the end of the queue waits the new interval.
    expect(await change(6)).toEqual({
      minIntervalHours: 6,
      changed: true,
      nextAllowedAt: answered.lastSuccessAt! + 6 * 3_600_000,
    });
    expect((await streamOf(f, streamId)).nextAllowedAt).toBe(
      answered.lastSuccessAt! + 6 * 3_600_000,
    );
    // Shorter: nothing comes earlier than it was going to.
    expect(await change(2)).toMatchObject({ changed: true, nextAllowedAt: null });
    expect((await streamOf(f, streamId)).nextAllowedAt).toBe(
      answered.lastSuccessAt! + 6 * 3_600_000,
    );
    // The release keeps the version the queued query pinned: it is not cut.
    expect((await release()).version).toBe(pinned);
    // At its old time the queued query wakes, finds the window ahead and sends nothing.
    const early = await f.claim(next);
    expect(Date.now()).toBeLessThan(answered.lastSuccessAt! + 6 * 3_600_000);
    expect(await f.t.mutation(internal.captureProcessing.prepare, early)).toMatchObject({
      waitUntil: answered.lastSuccessAt! + 6 * 3_600_000,
    });
    expect((await streamOf(f, streamId)).lastAttemptAt).toBe(answered.lastAttemptAt);
  });

  it("quem iniciou perde o papel antes da primeira consulta: atenção com um único webhook", async () => {
    const f = await siteFixture();
    const { owner, streamId, operationId } = await consoleStart(f);
    expect(await attentionEvents(f)).toHaveLength(0);
    await f.t.run(async (ctx) => {
      const membership = (await ctx.db.get("memberships", owner.membershipId))!;
      await ctx.db.patch("memberships", membership._id, {
        role: "viewer",
        version: membership.version + 1,
      });
    });
    const before = await opOf(f, operationId);
    expect(await claimAt(f, operationId)).toBeNull();
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "attention", code: "ACCESS_REVOKED" });
    const events = await attentionEvents(f);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.body)).toMatchObject({
      environment: "production",
      resource: { type: "connection", id: streamId, version: stream.version },
    });
    // A late dispatch or watchdog of the paused attempt adds nothing.
    await f.t.mutation(internal.operations.claim, { operationId, generation: before.generation });
    await f.t.mutation(internal.operations.recoverOne, { operationId });
    expect(await attentionEvents(f)).toHaveLength(1);
    expect((await streamOf(f, streamId)).version).toBe(stream.version);
  });

  it("captura iniciada por chave continua com a chave, e revogar a chave corta", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const next = await cycle(f, stream.id, stream.operationId);
    expect(await opOf(f, next)).toMatchObject({ sourceKeyId: f.scope.keyId });
    expect((await opOf(f, next)).sourceCaptureReleaseId).toBeUndefined();
    const after = await cycle(f, stream.id, next);
    expect(await opOf(f, after)).toMatchObject({ sourceKeyId: f.scope.keyId });
    await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
    expect(await claimAt(f, after)).toBeNull();
    expect(await opOf(f, after)).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
    expect(await streamOf(f, stream.id)).toMatchObject({
      state: "attention",
      code: "ACCESS_REVOKED",
    });
    expect(await attentionEvents(f)).toHaveLength(1);
  });

  it("operação de pessoa fora do projeto do console mantém a pessoa como origem", async () => {
    // `operations.reserve` never records this today; the rule stays the same as in
    // `executionAllowed`, so such a continuation is not switched to a source it would refuse.
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const owner = await person(f.t, f.scope.organizationId, "owner");
    await f.t.run(async (ctx) => {
      const membership = (await ctx.db.get("memberships", owner.membershipId))!;
      await ctx.db.patch("operations", stream.operationId, {
        sourceKeyId: undefined,
        sourceMembershipId: membership._id,
        sourceAccessVersion: `manager:${membership.version}`,
      });
    });
    const next = await cycle(f, stream.id, stream.operationId);
    const child = await opOf(f, next);
    expect(child).toMatchObject({ sourceMembershipId: owner.membershipId });
    expect(child.sourceCaptureReleaseId).toBeUndefined();
    expect(await claimAt(f, next)).not.toBeNull();
  });
});
