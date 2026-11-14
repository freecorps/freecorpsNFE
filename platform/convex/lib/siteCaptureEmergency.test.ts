import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { person } from "../../../tests/helpers/platform";
import { fixture as corpus } from "../../../tests/helpers/nfe-corpus";
import { hashApiKey } from "./apiKeyCrypto";
import { CAPTURE_TERMS_VERSION } from "./fiscalCaptureRelease";
import * as certificateRuntime from "./certificateRuntime";
import { distributionXml, nsu } from "../../../tests/helpers/distribution";
import {
  development,
  site,
  stub,
  siteFixture,
  respond,
  streamOf,
} from "../../../tests/helpers/siteCapture";

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
 * #424, from end to end on the site profile: the Freecorps emergency stops a capture that is
 * running, the unblock only lifts the block, and the capture comes back only through a new
 * release and a person, from the NSU where it stopped. Repeating the stop or the unblock never
 * touches the stream, the operation or the webhooks again.
 */
describe("parada, desbloqueio e retomada pela Freecorps (#424)", () => {
  type Fixture = Awaited<ReturnType<typeof siteFixture>>;
  const run = {
    operator: "ana-freecorps",
    reason: "Ensaio sintético da emergência",
    runId: "4242",
    runAttempt: 1,
  };
  const freecorps = (f: Fixture, kind: "emergency_withdraw" | "unblock") =>
    f.t.mutation(internal.captureRelease.set, { companyId: f.scope.companyId, kind, ...run });
  const opOf = (f: Fixture, id: Id<"operations">) =>
    f.t.run(async (ctx) => (await ctx.db.get("operations", id))!);
  const releaseOf = (f: Fixture) =>
    f.t.run(
      async (ctx) =>
        (await ctx.db
          .query("captureReleases")
          .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
          .unique())!,
    );
  /** What a stop or an unblock may touch besides the release: stream, operation and webhooks. */
  const effects = (f: Fixture, streamId: Id<"captureStreams">, operationId: Id<"operations">) =>
    f.t.run(async (ctx) => ({
      stream: await ctx.db.get("captureStreams", streamId),
      operation: await ctx.db.get("operations", operationId),
      events: (await ctx.db.query("outboxEvents").collect()).map((e) => e.type),
      audit: (await ctx.db.query("captureAudit").collect()).map((a) => a.action),
    }));
  /**
   * The owner starts the production capture in the console; the first query receives NSU 1 and
   * 2 of the 4 the source has, so the stream schedules the next query right away.
   */
  async function capturing() {
    const f = await siteFixture();
    const owner = await person(f.t, f.scope.organizationId, "owner", {
      companyId: f.scope.companyId,
    });
    const view = await owner.mutation(api.captures.activate, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "production",
    });
    const token = await f.claim(view.operationId!);
    await respond(
      f,
      token,
      distributionXml({
        environment: "1",
        max: 4,
        envelopes: [
          { nsu: 1, xml: corpus("summary-authorized") },
          { nsu: 2, xml: corpus("invoice-authorized") },
        ],
      }),
    );
    expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
    const stream = await streamOf(f, view.id);
    expect(stream).toMatchObject({ state: "active", checkpoint: nsu(2) });
    expect(stream.operationId).not.toBe(view.operationId);
    return { f, owner, streamId: view.id, next: stream.operationId! };
  }

  it("a emergência para a captura em andamento; repetir só registra de novo", async () => {
    const { f, streamId, next } = await capturing();
    const transport = vi.spyOn(certificateRuntime, "transportWithCertificate");
    try {
      expect(await freecorps(f, "emergency_withdraw")).toMatchObject({
        released: false,
        blocked: true,
      });
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "paused",
        code: "CAPTURE_RELEASE_WITHDRAWN",
        checkpoint: nsu(2),
      });
      expect(await opOf(f, next)).toMatchObject({
        state: "paused",
        code: "CAPTURE_RELEASE_WITHDRAWN",
      });
      const stopped = await effects(f, streamId, next);
      expect(stopped.events.filter((type) => type === "connection.release_withdrawn")).toHaveLength(
        1,
      );
      expect(stopped.audit.filter((action) => action === "release_withdrawn")).toHaveLength(1);
      // The scheduled query never runs: the operation is no longer claimable.
      const op = await opOf(f, next);
      vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
      expect(
        await f.t.mutation(internal.operations.claim, {
          operationId: next,
          generation: op.generation,
        }),
      ).toBeNull();
      // A second dispatch is a new line of the history, never a second stop.
      const version = (await releaseOf(f)).version;
      expect(await freecorps(f, "emergency_withdraw")).toMatchObject({
        released: false,
        blocked: true,
        version: version + 1,
      });
      expect(await effects(f, streamId, next)).toEqual(stopped);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      transport.mockRestore();
    }
  });

  it("o desbloqueio só tira o bloqueio; repetir é recusado sem gravar nada", async () => {
    const { f, owner, streamId, next } = await capturing();
    await freecorps(f, "emergency_withdraw");
    const ids = { organizationId: f.scope.organizationId, companyId: f.scope.companyId };
    const enable = () =>
      owner.mutation(api.captureRelease.enable, {
        ...ids,
        minIntervalHours: 1,
        terms: CAPTURE_TERMS_VERSION,
      });
    await expect(enable()).rejects.toThrow("CAPTURE_RELEASE_BLOCKED");
    const blocked = await effects(f, streamId, next);
    expect(await freecorps(f, "unblock")).toMatchObject({ released: false, blocked: false });
    expect(await effects(f, streamId, next)).toEqual(blocked);
    expect(await owner.query(api.captureRelease.status, ids)).toMatchObject({
      state: "withdrawn",
      blocked: false,
    });
    const release = await releaseOf(f);
    const history = await f.t.run((ctx) => ctx.db.query("captureReleaseEvents").collect());
    await expect(freecorps(f, "unblock")).rejects.toThrow("CAPTURE_RELEASE_NOT_BLOCKED");
    expect(await releaseOf(f)).toEqual(release);
    expect(await f.t.run((ctx) => ctx.db.query("captureReleaseEvents").collect())).toEqual(history);
    expect(await effects(f, streamId, next)).toEqual(blocked);
  });

  it("a retomada vem de nova liberação e de uma pessoa, do mesmo NSU, sem lacuna", async () => {
    const { f, owner, streamId, next } = await capturing();
    await freecorps(f, "emergency_withdraw");
    await freecorps(f, "unblock");
    const ids = { organizationId: f.scope.organizationId, companyId: f.scope.companyId };
    const { version } = await owner.mutation(api.captureRelease.enable, {
      ...ids,
      minIntervalHours: 1,
      terms: CAPTURE_TERMS_VERSION,
    });
    // A new release resumes nothing by itself: the stream waits for a person.
    const paused = await streamOf(f, streamId);
    expect(paused).toMatchObject({ state: "paused", code: "CAPTURE_RELEASE_WITHDRAWN" });
    expect(paused.operationId).toBe(next);
    const resumed = await owner.mutation(api.captures.control, {
      ...ids,
      environment: "production",
      action: "resume",
      expectedVersion: paused.version,
    });
    expect(resumed).toMatchObject({ state: "active" });
    const stream = await streamOf(f, streamId);
    expect(stream.operationId).not.toBe(next);
    expect(JSON.parse((await opOf(f, stream.operationId!)).request)).toMatchObject({
      previousOperationId: next,
    });
    // The query asks from the NSU where the capture stopped and receives what came after it.
    const token = await f.claim(stream.operationId!);
    await respond(
      f,
      token,
      distributionXml({
        environment: "1",
        max: 4,
        envelopes: [
          { nsu: 3, xml: corpus("summary-authorized") },
          { nsu: 4, xml: corpus("invoice-authorized") },
        ],
      }),
    );
    expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
    const batches = await f.t.run((ctx) => ctx.db.query("captureBatches").collect());
    expect(batches.map((b) => [b.requestNsu, b.lastNsu])).toEqual([
      [nsu(0), nsu(2)],
      [nsu(2), nsu(4)],
    ]);
    const envelopes = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
    expect(envelopes.map((e) => e.nsu).sort()).toEqual([1, 2, 3, 4].map(nsu));
    const after = await streamOf(f, streamId);
    expect(after).toMatchObject({ state: "active", checkpoint: nsu(4) });
    // The queries the stream schedules from now on run under the new release.
    expect(await opOf(f, after.operationId!)).toMatchObject({
      sourceAccessVersion: `release:${version}`,
    });
  });

  it("só gestor libera de novo; quem só lê não retoma; outra organização não alcança", async () => {
    const { f, streamId } = await capturing();
    await freecorps(f, "emergency_withdraw");
    await freecorps(f, "unblock");
    const ids = { organizationId: f.scope.organizationId, companyId: f.scope.companyId };
    const member = (role: "admin" | "operator" | "developer" | "viewer") =>
      person(f.t, f.scope.organizationId, role, { companyId: f.scope.companyId });
    type Member = Awaited<ReturnType<typeof member>>;
    const enable = (who: Member) =>
      who.mutation(api.captureRelease.enable, {
        ...ids,
        minIntervalHours: 1,
        terms: CAPTURE_TERMS_VERSION,
      });
    for (const role of ["operator", "developer", "viewer"] as const)
      await expect(enable(await member(role))).rejects.toThrow("SCOPE_DENIED");
    // The owner of another organization, in the same deployment, built with the local proof.
    vi.unstubAllEnvs();
    stub(development);
    const outsider = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash: await hashApiKey(`fnfe_${"z".repeat(43)}`),
      suffix: crypto.randomUUID(),
    });
    stub(site);
    const stranger = await person(f.t, outsider.organizationId, "owner");
    await expect(enable(stranger)).rejects.toThrow("ACCESS_DENIED");
    expect((await releaseOf(f)).released).toBe(false);
    await enable(await member("admin"));
    const resume = async (who: Member) =>
      who.mutation(api.captures.control, {
        ...ids,
        environment: "production",
        action: "resume",
        expectedVersion: (await streamOf(f, streamId)).version,
      });
    await expect(resume(await member("viewer"))).rejects.toThrow("SCOPE_DENIED");
    await expect(resume(stranger)).rejects.toThrow("ACCESS_DENIED");
    expect(await streamOf(f, streamId)).toMatchObject({ state: "paused" });
    expect(await resume(await member("operator"))).toMatchObject({ state: "active" });
  });
});
