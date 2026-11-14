import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { person } from "../../../tests/helpers/platform";
import { hashApiKey } from "./apiKeyCrypto";
import * as siteCapture from "./siteCapture";
import { SITE_CAPTURE_ACTION } from "./siteCapture";
import { CAPTURE_TERMS_VERSION } from "./fiscalCaptureRelease";
import * as certificateRuntime from "./certificateRuntime";
import * as certificateAccess from "./certificateAccess";
import { distributionXml, nsu } from "../../../tests/helpers/distribution";
import {
  development,
  site,
  stub,
  siteFixture,
  rest,
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
  /**
   * #425: the runbook's general cut by variable. A query whose turn comes during the cut stops in
   * attention with a webhook and a Freecorps alert; putting the variables back, or lifting the
   * general stop, resumes nothing; a person's "Retomar captura" goes on from the checkpoint.
   */
  describe("corte geral por variável e religar (#425)", () => {
    const halt = (f: Fixture, kind: "halt" | "resume") =>
      f.t.mutation(internal.captureRelease.setHalt, {
        kind,
        operator: "ana-freecorps",
        reason: "Parada sintética de todas as empresas",
        runId: "425",
        runAttempt: 1,
      });
    /**
     * The capture as the console reads it (`captures.get`), by a person of the organization: a
     * new owner by default, since the clock of these tests outlives a session.
     */
    const consoleView = async (f: Fixture, who?: Awaited<ReturnType<typeof person>>) =>
      (await (who ?? (await person(f.t, f.scope.organizationId, "owner"))).query(api.captures.get, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "production",
      }))!;
    const home = (who: Awaited<ReturnType<typeof person>>, organizationId: Id<"organizations">) =>
      who.query(api.consoleHome.summary, {
        organizationId,
        monthStart: Date.now() - 86_400_000,
        asOf: Date.now(),
        contextKey: "601",
      });
    const alertsOf = (f: Fixture) =>
      f.t.run(async (ctx) =>
        (await ctx.db.query("captureAlerts").collect()).map((a) => [a.kind, a.code]),
      );
    const cuts = [
      { cut: ["FNFE_CAPTURE_TRANSPORT"], code: "FISCAL_TRANSPORT_DISABLED", claimed: true },
      { cut: ["FNFE_CAPTURE_FISCAL"], code: "ACCESS_REVOKED", claimed: false },
      {
        cut: ["FNFE_CAPTURE_FISCAL", "FNFE_CAPTURE_TRANSPORT"],
        code: "ACCESS_REVOKED",
        claimed: false,
      },
    ];
    it.each(cuts)("sem $cut: atenção $code, um webhook, e religar não retoma", async (c) => {
      const f = await siteFixture();
      const { streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      const checkpoint = (await streamOf(f, streamId)).checkpoint;
      for (const name of c.cut) vi.stubEnv(name, undefined);
      // The query's turn comes during the cut.
      const token = await claimAt(f, next);
      expect(token !== null).toBe(c.claimed);
      if (token) expect(await f.t.mutation(internal.captureProcessing.prepare, token)).toBeNull();
      expect(await opOf(f, next)).toMatchObject({
        state: "paused",
        code: c.code,
        uncertain: false,
      });
      const stopped = await streamOf(f, streamId);
      expect(stopped).toMatchObject({ state: "attention", code: c.code, checkpoint });
      expect(await attentionEvents(f)).toHaveLength(1);
      expect(await alertsOf(f)).toEqual([["attention", c.code]]);
      // Variables back, and even the general stop's resume: nothing comes back by itself.
      stub(site);
      await halt(f, "halt");
      await halt(f, "resume");
      vi.setSystemTime(Date.now() + 25 * 3_600_000);
      expect(await scheduledResume(f)).toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "attention",
        code: c.code,
        version: stopped.version,
        operationId: next,
      });
      expect(await opOf(f, next)).toMatchObject({ state: "paused", code: c.code });
      // The console tells the cut apart (#601): the same code, marked by the server.
      const operator = await person(f.t, f.scope.organizationId, "operator", {
        companyId: f.scope.companyId,
      });
      expect(await consoleView(f, operator)).toMatchObject({ code: c.code, freecorpsCut: true });
      // "Retomar captura" in the console, by anyone who operates the company (a session of now):
      // the next query asks from the same checkpoint.
      const resumed = await operator.mutation(api.captures.control, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "production",
        action: "resume",
        expectedVersion: stopped.version,
      });
      expect(resumed).toMatchObject({ state: "active" });
      expect(await consoleView(f, operator)).toMatchObject({ freecorpsCut: false });
      const stream = await streamOf(f, streamId);
      expect(JSON.parse((await opOf(f, stream.operationId!)).request)).toMatchObject({
        previousOperationId: next,
      });
      const resumedToken = await claimAt(f, stream.operationId!);
      expect(await f.t.mutation(internal.captureProcessing.prepare, resumedToken!)).toMatchObject({
        nsu: checkpoint,
        mode: "distNSU",
      });
      expect(await attentionEvents(f)).toHaveLength(1);
    });

    it("captura ativada por chave sem FNFE_CAPTURE_FISCAL: também ACCESS_REVOKED", async () => {
      const f = await siteFixture();
      const stream = await f.command("production", "activate");
      const next = await cycle(f, stream.id, stream.operationId);
      vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
      expect(await claimAt(f, next)).toBeNull();
      expect(await streamOf(f, stream.id)).toMatchObject({
        state: "attention",
        code: "ACCESS_REVOKED",
      });
      expect(await attentionEvents(f)).toHaveLength(1);
      // Back on: the console says it was the cut (#601), the REST connection stays as it was.
      stub(site);
      expect(await consoleView(f)).toMatchObject({
        code: "ACCESS_REVOKED",
        freecorpsCut: true,
      });
      const connection = await rest(f, f.secret, "GET");
      expect(connection.status).toBe(200);
      const data = connection.body.data as Record<string, unknown>;
      expect(data).toMatchObject({ id: stream.id, state: "attention", code: "ACCESS_REVOKED" });
      expect(data).not.toHaveProperty("freecorpsCut");
    });

    /**
     * #601: the console says the Freecorps cut only once the capture is on again, only for the
     * attention the cut caused, and only to the organization of the company.
     */
    it("o console diz que foi o corte só com as duas variáveis de volta", async () => {
      const f = await siteFixture();
      const { streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
      vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
      expect(await claimAt(f, next)).toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "attention",
        code: "ACCESS_REVOKED",
        freecorpsCut: true,
      });
      // Only the fiscal switch back: a resume would stop again, so the code keeps its words.
      vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
      expect(await consoleView(f)).toMatchObject({ freecorpsCut: false });
      stub(site);
      expect(await consoleView(f)).toMatchObject({ freecorpsCut: true });
      // The Início says it too, for this organization only.
      expect(
        (
          await home(await person(f.t, f.scope.organizationId, "owner"), f.scope.organizationId)
        ).pending.filter((item) => item.kind === "capture-attention"),
      ).toEqual([
        expect.objectContaining({
          companyId: f.scope.companyId,
          code: "ACCESS_REVOKED",
          freecorpsCut: true,
        }),
      ]);
      // Another organization reads neither the capture nor the mark.
      vi.unstubAllEnvs();
      stub(development);
      const other = await f.t.mutation(internal.testing.operationProof.prepare, {
        keyHash: await hashApiKey(`fnfe_${"d".repeat(43)}`),
        suffix: crypto.randomUUID(),
      });
      vi.unstubAllEnvs();
      stub(site);
      // Its own released company stopped with the same code, by a real revocation: no mark.
      const otherStream = await f.t.run(async (ctx) => {
        await ctx.db.patch("companies", other.companyId, {
          kind: "declared",
          cnpj: "11222333000181",
        });
        await ctx.db.insert("captureReleases", {
          organizationId: other.organizationId,
          companyId: other.companyId,
          released: true,
          blocked: false,
          minIntervalHours: 1,
          releasedBefore: true,
          actor: "member:synthetic",
          reason: "Liberação sintética",
          version: 1,
          updatedAt: Date.now(),
          eventId: await ctx.db.insert("captureReleaseEvents", {
            organizationId: other.organizationId,
            companyId: other.companyId,
            released: true,
            blocked: false,
            minIntervalHours: 1,
            version: 1,
            kind: "console_release",
            terms: CAPTURE_TERMS_VERSION,
            revokedKeys: 0,
            reason: "Liberação sintética",
            buildSha: null,
            deployment: "",
            createdAt: Date.now(),
          }),
        });
        return await ctx.db.insert("captureStreams", {
          organizationId: other.organizationId,
          projectId: other.projectId,
          companyId: other.companyId,
          environment: "production",
          identity: "11222333000181",
          service: "nfe-distribution",
          state: "attention",
          version: 2,
          checkpoint: "000000000000000",
          mode: "distNSU",
          nextAllowedAt: Date.now(),
          code: "ACCESS_REVOKED",
          received: 0,
          createdAt: Date.now(),
        });
      });
      const stranger = await person(f.t, other.organizationId, "owner");
      await expect(consoleView(f, stranger)).rejects.toThrow();
      const strangerPending = (await home(stranger, other.organizationId)).pending.filter(
        (item) => item.kind === "capture-attention",
      );
      expect(strangerPending).toEqual([
        expect.objectContaining({
          companyId: other.companyId,
          recordId: otherStream,
          code: "ACCESS_REVOKED",
        }),
      ]);
      expect(strangerPending[0]).not.toHaveProperty("freecorpsCut");
      // And the first organization still reads its own mark, not the other's attention.
      expect(
        (
          await home(await person(f.t, f.scope.organizationId, "owner"), f.scope.organizationId)
        ).pending.filter((item) => item.kind === "capture-attention"),
      ).toEqual([expect.objectContaining({ companyId: f.scope.companyId, freecorpsCut: true })]);
    });

    /**
     * The worker refuses the transport in an action and `failed` writes the attention in another
     * transaction: the mark comes from the worker's reading, even when the variables are back by
     * the time `failed` runs (#601).
     */
    it("o corte lido pelo worker fica marcado mesmo com as variáveis regravadas antes de failed", async () => {
      const f = await siteFixture();
      const stream = await f.command("production", "activate");
      const token = await f.claim(stream.operationId);
      const real = siteCapture.siteCaptureProfile;
      // The cut happens after `prepare`, right when the worker reads the switches, and the
      // operator writes them again before the worker's next step reaches the database.
      const profile = vi.spyOn(siteCapture, "siteCaptureProfile").mockImplementationOnce(() => {
        vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
        queueMicrotask(() => stub(site));
        return real();
      });
      try {
        const result = await f.t.action(internal.captureWorker.execute, {
          ...token,
          request: "{}",
        });
        expect(result).toMatchObject({ code: "FISCAL_TRANSPORT_DISABLED" });
      } finally {
        profile.mockRestore();
      }
      expect(process.env.FNFE_CAPTURE_TRANSPORT).toBe("sefaz");
      expect(await streamOf(f, stream.id)).toMatchObject({
        state: "attention",
        code: "FISCAL_TRANSPORT_DISABLED",
        freecorpsCut: true,
      });
      expect(await consoleView(f)).toMatchObject({
        code: "FISCAL_TRANSPORT_DISABLED",
        freecorpsCut: true,
      });
    });

    /**
     * The vault decides `ACCESS_REVOKED` in `certificateUse.authorizeTransport` and
     * `refusedBeforeSend` writes the attention in another transaction: the mark comes from the
     * vault's reading, even when the variables are back by the time the pause is written (#601).
     */
    it("o corte lido pelo cofre fica marcado mesmo com as variáveis regravadas antes da pausa", async () => {
      const f = await siteFixture();
      const stream = await f.command("production", "activate");
      const token = await f.claim(stream.operationId);
      // The cut happens after the worker chose the transport, right before the vault reads the
      // release; the operator writes the variables again as soon as the vault has decided.
      const real = certificateRuntime.transportWithCertificate;
      const transport = vi
        .spyOn(certificateRuntime, "transportWithCertificate")
        .mockImplementationOnce((ctx, claim, target) => {
          vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
          return real(ctx, claim, target);
        });
      const audit = certificateAccess.certificateAudit;
      const decided = vi
        .spyOn(certificateAccess, "certificateAudit")
        .mockImplementation(async (...args) => {
          await audit(...args);
          if (args[3] === "denied") stub(site);
        });
      try {
        const result = await f.t.action(internal.captureWorker.execute, {
          ...token,
          request: "{}",
        });
        expect(result).toMatchObject({ kind: "definitive", code: "ACCESS_REVOKED" });
        expect(decided).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          SITE_CAPTURE_ACTION,
          "denied",
          expect.anything(),
          stream.operationId,
        );
      } finally {
        transport.mockRestore();
        decided.mockRestore();
      }
      expect(process.env.FNFE_CAPTURE_FISCAL).toBe(site.FNFE_CAPTURE_FISCAL);
      expect(await opOf(f, stream.operationId)).toMatchObject({
        state: "paused",
        code: "ACCESS_REVOKED",
        uncertain: false,
      });
      expect(await streamOf(f, stream.id)).toMatchObject({
        state: "attention",
        code: "ACCESS_REVOKED",
        freecorpsCut: true,
      });
      expect(await consoleView(f)).toMatchObject({ code: "ACCESS_REVOKED", freecorpsCut: true });
    });

    it("failed só grava a marca do corte para os códigos do corte", async () => {
      const f = await siteFixture();
      const stream = await f.command("production", "activate");
      const token = await f.claim(stream.operationId);
      await f.t.mutation(internal.captureProcessing.failed, {
        ...token,
        code: "BATCH_UNAVAILABLE",
        cut: true,
      });
      const stopped = await streamOf(f, stream.id);
      expect(stopped).toMatchObject({ state: "attention", code: "BATCH_UNAVAILABLE" });
      expect(stopped.freecorpsCut).toBeUndefined();
    });

    it("revogação real com as variáveis presentes: ACCESS_REVOKED sem a marca do corte", async () => {
      const f = await siteFixture();
      const { streamId, operationId } = await consoleStart(f);
      let next = await cycle(f, streamId, operationId);
      // First the cut, resumed by a person: the mark goes with that attention.
      vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
      const token = await claimAt(f, next);
      expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({
        code: "FISCAL_TRANSPORT_DISABLED",
        freecorpsCut: true,
      });
      stub(site);
      const operator = await person(f.t, f.scope.organizationId, "operator", {
        companyId: f.scope.companyId,
      });
      await operator.mutation(api.captures.control, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "production",
        action: "resume",
        expectedVersion: (await streamOf(f, streamId)).version,
      });
      next = await cycle(f, streamId, (await streamOf(f, streamId)).operationId!);
      // Then a real loss of access, with both variables present: withdrawn and released again.
      await f.setRelease(false);
      await f.setRelease(true);
      expect(await claimAt(f, next)).toBeNull();
      const revoked = await streamOf(f, streamId);
      expect(revoked).toMatchObject({ state: "attention", code: "ACCESS_REVOKED" });
      expect(revoked.freecorpsCut).toBeUndefined();
      expect(await consoleView(f)).toMatchObject({
        code: "ACCESS_REVOKED",
        freecorpsCut: false,
      });
    });

    it("uma consulta que não chegou à vez durante o corte segue sozinha", async () => {
      const f = await siteFixture();
      const { streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      const due = (await opOf(f, next)).nextAttemptAt;
      expect(due).toBeGreaterThan(Date.now());
      vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
      vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
      stub(site);
      const token = await claimAt(f, next);
      expect(token).not.toBeNull();
      expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).not.toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({ state: "active" });
      expect(await attentionEvents(f)).toHaveLength(0);
    });

    it("consulta já enviada: sem transporte ela termina; sem FNFE_CAPTURE_FISCAL fica incerta em atenção", async () => {
      for (const name of ["FNFE_CAPTURE_TRANSPORT", "FNFE_CAPTURE_FISCAL"] as const) {
        vi.unstubAllEnvs();
        stub(development);
        const f = await siteFixture();
        const { streamId, operationId } = await consoleStart(f);
        const next = await cycle(f, streamId, operationId);
        // The request left (`beginEffect`); the variable goes before the answer is recorded.
        const token = await f.claim(next);
        expect(await f.t.mutation(internal.captureProcessing.prepare, token)).not.toBeNull();
        vi.stubEnv(name, undefined);
        if (name === "FNFE_CAPTURE_TRANSPORT") {
          await respond(f, token, distributionXml({ status: "137", environment: "1" }));
          expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
          expect(await opOf(f, next)).toMatchObject({ state: "succeeded" });
          expect(await streamOf(f, streamId)).toMatchObject({ state: "active" });
          expect(await attentionEvents(f)).toHaveLength(0);
          continue;
        }
        const rawId = await f.t.run((ctx) => ctx.storage.store(new Blob(["<retDistDFeInt/>"])));
        expect(
          await f.t.mutation(internal.captureProcessing.raw, {
            ...token,
            rawId,
            rawHash: "0".repeat(64),
            nsu: nsu(0),
            mode: "distNSU",
          }),
        ).toBeNull();
        await f.t.mutation(internal.operations.recordOutcome, {
          ...token,
          outcome: { kind: "uncertain", code: "CAPTURE_CHANGED" },
        });
        expect(await opOf(f, next)).toMatchObject({
          state: "paused",
          code: "ACCESS_REVOKED",
          uncertain: true,
        });
        expect(await streamOf(f, streamId)).toMatchObject({
          state: "attention",
          code: "ACCESS_REVOKED",
        });
        expect(await attentionEvents(f)).toHaveLength(1);
      }
    });

    it("apagar a variável por cima da parada geral põe em atenção em vez de adiar", async () => {
      const f = await siteFixture();
      const { streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      await halt(f, "halt");
      vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
      const token = await claimAt(f, next);
      expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "attention",
        code: "FISCAL_TRANSPORT_DISABLED",
      });
      expect(await attentionEvents(f)).toHaveLength(1);
    });
  });
});
