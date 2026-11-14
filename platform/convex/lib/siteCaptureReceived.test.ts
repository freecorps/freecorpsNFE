import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { person } from "../../../tests/helpers/platform";
import { fixture as corpus } from "../../../tests/helpers/nfe-corpus";
import * as certificateRuntime from "./certificateRuntime";
import { distributionXml } from "../../../tests/helpers/distribution";
import { captureProcessingTask } from "./captureValues";
import { gunzipSync } from "node:zlib";
import {
  development,
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
 * #420: what the capture already received stays available. The envelopes behind the checkpoint
 * become documents in Documentos and in the export even after the release is withdrawn or the
 * deployment is cut, without querying the source or opening the vault, while closure, a company
 * that left, a revoked project or grant and a purged release still cut them.
 */
describe("documentos já recebidos depois da retirada", () => {
  type Fixture = Awaited<ReturnType<typeof siteFixture>>;
  const opOf = (f: Fixture, id: Id<"operations">) =>
    f.t.run(async (ctx) => (await ctx.db.get("operations", id))!);
  /** A summary and the full invoice of the same NF-e, as NSU 1 and 2. */
  const received = () =>
    distributionXml({
      environment: "1",
      envelopes: [
        { nsu: 1, xml: corpus("summary-authorized") },
        { nsu: 2, xml: corpus("invoice-authorized") },
      ],
    });
  /**
   * The owner starts the production capture in the console and the first query receives two
   * envelopes: the checkpoint moves past them and creates their `documents.capture`.
   */
  async function receivedByConsole() {
    const f = await siteFixture();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    const view = await owner.mutation(api.captures.activate, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "production",
    });
    return { f, owner, ...(await receive(f, view.id, view.operationId!)) };
  }
  async function receive(
    f: Fixture,
    streamId: Id<"captureStreams">,
    operationId: Id<"operations">,
  ) {
    const token = await f.claim(operationId);
    await respond(f, token, received());
    expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
    expect((await streamOf(f, streamId)).checkpoint).toBe("000000000000002");
    const children = await f.t.run(async (ctx) =>
      (await ctx.db.query("captureEnvelopes").collect()).map((e) => e.operationId!),
    );
    expect(children).toHaveLength(2);
    return { streamId, children };
  }
  /** Runs one operation through the worker at its time. */
  async function run(f: Fixture, id: Id<"operations">) {
    const op = await opOf(f, id);
    vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
    await f.t.action(internal.operationWorker.run, { operationId: id, generation: op.generation });
    return opOf(f, id);
  }
  /** What a person sees in Documentos › Produção. */
  const listed = async (f: Fixture, owner: Awaited<ReturnType<typeof person>>) =>
    (
      await owner.query(api.documents.list, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "production",
        cursor: null,
        limit: 10,
      })
    ).page;
  /** The organization export in Produção, finished, as text. */
  async function exported(f: Fixture, owner: Awaited<ReturnType<typeof person>>) {
    const job = await owner.mutation(api.exports.create, {
      organizationId: f.scope.organizationId,
      selection: { kind: "organization" },
      environment: "production",
      key: crypto.randomUUID(),
    });
    for (let n = 0; n < 30; n++) {
      const current = (await f.t.run((ctx) => ctx.db.get("documentExports", job.id)))!;
      if (current.state !== "running") break;
      await f.t.action(internal.exportWorker.run, {
        exportId: job.id,
        sequence: current.sequence,
      });
    }
    return f.t.run(async (ctx) => {
      const job2 = (await ctx.db.get("documentExports", job.id))!;
      expect(job2.state).toBe("succeeded");
      const texts: string[] = [];
      for (const part of await ctx.db
        .query("exportParts")
        .filter((q) => q.eq(q.field("exportId"), job.id))
        .collect()) {
        const blob = (await ctx.storage.get(part.storageId))!;
        texts.push(gunzipSync(Buffer.from(await blob.arrayBuffer())).toString());
      }
      return texts.join("\n");
    });
  }
  const certificateAudits = (f: Fixture) =>
    f.t.run(async (ctx) => (await ctx.db.query("certificateAudit").collect()).length);
  /** Every way to the source or the vault, watched while the stored documents are processed. */
  const watchVault = () => ({
    vault: vi.spyOn(certificateRuntime, "withCertificate"),
    transport: vi.spyOn(certificateRuntime, "transportWithCertificate"),
  });
  const withdraw = (f: Fixture, owner: Awaited<ReturnType<typeof person>>) =>
    owner.mutation(api.captureRelease.disable, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
    });
  /** Both documents processed, one NF-e in Documentos and in the export, nothing from the vault. */
  async function expectAvailable(
    f: Fixture,
    owner: Awaited<ReturnType<typeof person>>,
    children: Id<"operations">[],
  ) {
    const audits = await certificateAudits(f);
    const watched = watchVault();
    for (const id of children) {
      const op = await run(f, id);
      expect(op).toMatchObject({ state: "succeeded", task: { name: "documents.capture" } });
      expect(op.certificate).toBeUndefined();
    }
    expect(watched.vault).not.toHaveBeenCalled();
    expect(watched.transport).not.toHaveBeenCalled();
    expect(await certificateAudits(f)).toBe(audits);
    const page = await listed(f, owner);
    expect(page).toHaveLength(1);
    const docs = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ environment: "production", completeness: 2 });
    expect(await exported(f, owner)).toContain(`"id":"${docs[0]!._id}"`);
  }

  it("retirar logo depois do checkpoint: as notas aparecem em Documentos e na exportação", async () => {
    const { f, owner, children } = await receivedByConsole();
    // The continuations run under the company's release, pinned by its version.
    for (const id of children) expect((await opOf(f, id)).sourceCaptureReleaseId).toBeDefined();
    await withdraw(f, owner);
    await expectAvailable(f, owner, children);
  });

  it("emergência da Freecorps: o bloqueio também mantém o que foi recebido", async () => {
    const { f, owner, children } = await receivedByConsole();
    await f.t.mutation(internal.captureRelease.set, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      kind: "emergency_withdraw",
      operator: "ana-freecorps",
      reason: "Suspensão sintética da captura",
      runId: "4242",
      runAttempt: 1,
    });
    await expectAvailable(f, owner, children);
  });

  it("corte geral: sem FNFE_CAPTURE_FISCAL nem transporte, as notas aparecem", async () => {
    const { f, owner, children } = await receivedByConsole();
    vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
    vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
    await expectAvailable(f, owner, children);
  });

  it("parada geral da Freecorps (#424): as notas aparecem, com ou sem retirada", async () => {
    for (const withdrawn of [false, true]) {
      vi.unstubAllEnvs();
      stub(development);
      const { f, owner, children } = await receivedByConsole();
      await f.t.mutation(internal.captureRelease.setHalt, {
        kind: "halt",
        operator: "ana-freecorps",
        reason: "Parada sintética de todas as empresas",
        runId: "4242",
        runAttempt: 1,
      });
      expect(
        ((await (await f.t.fetch("/health")).json()) as { captureFiscal: string }).captureFiscal,
      ).toBe("halted");
      if (withdrawn) await withdraw(f, owner);
      await expectAvailable(f, owner, children);
    }
  });

  it("captura de chave retirada: as notas aparecem pela origem da chave", async () => {
    const f = await siteFixture();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    const stream = await f.command("production", "activate");
    const { children } = await receive(f, stream.id, stream.operationId);
    expect((await opOf(f, children[0]!)).sourceKeyId).toBe(f.scope.keyId);
    await withdraw(f, owner);
    await expectAvailable(f, owner, children);
  });

  it("encerramento, empresa fora, projeto ou concessão revogados e liberação expurgada continuam cortando", async () => {
    const cuts: Record<string, (f: Fixture) => Promise<void>> = {
      closure: (f) =>
        f.t.run(async (ctx) => {
          await ctx.db.insert("organizationClosures", {
            organizationId: f.scope.organizationId,
            state: "closing",
            requestedAt: Date.now(),
            exportUntil: Date.now() + 30 * 86_400_000,
            purgeBy: Date.now() + 37 * 86_400_000,
            generation: 1,
          });
        }),
      companyLeft: (f) =>
        f.t.run(async (ctx) => {
          const other = await ctx.db.insert("organizations", {
            name: "Outra organização",
            slug: crypto.randomUUID(),
            ownerCount: 1,
            memberCount: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          await ctx.db.patch("companies", f.scope.companyId, { organizationId: other });
        }),
      projectRevoked: (f) =>
        f.t.run(async (ctx) => {
          const op = (await ctx.db.query("captureEnvelopes").first())!;
          const child = (await ctx.db.get("operations", op.operationId!))!;
          const project = (await ctx.db.get("projects", child.projectId))!;
          await ctx.db.patch("projects", project._id, { accessEpoch: project.accessEpoch + 1 });
        }),
      releasePurged: (f) =>
        f.t.run(async (ctx) => {
          const release = (await ctx.db
            .query("captureReleases")
            .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
            .unique())!;
          await ctx.db.delete("captureReleases", release._id);
        }),
    };
    for (const [name, cut] of Object.entries(cuts)) {
      vi.unstubAllEnvs();
      stub(development);
      const { f, owner, children } = await receivedByConsole();
      await withdraw(f, owner);
      await cut(f);
      for (const id of children)
        expect(await run(f, id), name).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
      // The one-time resumption leaves them paused too.
      expect(await f.t.mutation(internal.captures.resumeStoredDocuments, {}), name).toEqual({
        resumed: 0,
        refused: 2,
        stillPaused: {},
        isDone: true,
      });
      // The read-only list names them for whoever decides.
      const listedPaused = await f.t.query(internal.captures.pausedStoredDocuments, {});
      expect(
        listedPaused.page.map((row) => row.code),
        name,
      ).toEqual(["ACCESS_REVOKED", "ACCESS_REVOKED"]);
      expect(await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect()), name).toEqual([]);
    }
    // A key capture whose grant was revoked: same cut, through the grant.
    vi.unstubAllEnvs();
    stub(development);
    const f = await siteFixture();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    const stream = await f.command("production", "activate");
    const { children } = await receive(f, stream.id, stream.operationId);
    await withdraw(f, owner);
    await f.t.run(async (ctx) => {
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
        )
        .unique())!;
      await ctx.db.patch("projectCompanies", grant._id, { accessEpoch: grant.accessEpoch + 1 });
    });
    for (const id of children)
      expect(await run(f, id)).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
  });

  it("o processamento não abre o cofre: com certificado, nem a tarefa vale como leitura", async () => {
    const { f, owner, children } = await receivedByConsole();
    await withdraw(f, owner);
    const head = await f.t.run(
      async (ctx) =>
        (await ctx.db
          .query("certificateHeads")
          .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
          .unique())!,
    );
    await f.t.run((ctx) =>
      ctx.db.patch("operations", children[0]!, {
        certificate: { id: head.activeId!, version: 1 },
      }),
    );
    expect(await run(f, children[0]!)).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
    // No caller reserves the processing of a stored document by itself.
    await expect(
      f.t.mutation(internal.operations.reserve, {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment: "production",
        keyHash: f.keyHash,
        key: "reserve-capture-processing",
        request: JSON.stringify({ artifactId: "x", processorVersion: "xml-import/3" }),
        task: captureProcessingTask,
      }),
    ).rejects.toThrow("INVALID_REQUEST");
  });

  it("filhas presas antes da correção voltam uma vez, sem duplicar a nota", async () => {
    const { f, owner, children } = await receivedByConsole();
    await withdraw(f, owner);
    // As the code before #420 left them: paused at the claim with ACCESS_REVOKED.
    await f.t.run(async (ctx) => {
      for (const id of children) {
        const op = (await ctx.db.get("operations", id))!;
        await ctx.db.patch("operations", id, {
          state: "paused",
          code: "ACCESS_REVOKED",
          generation: op.generation + 1,
          recoveryAt: undefined,
        });
      }
    });
    const result = await f.t.mutation(internal.captures.resumeStoredDocuments, {});
    expect(result).toEqual({ resumed: 2, refused: 0, stillPaused: {}, isDone: true });
    // Running it again touches nothing.
    expect(await f.t.mutation(internal.captures.resumeStoredDocuments, {})).toEqual({
      resumed: 0,
      refused: 0,
      stillPaused: {},
      isDone: true,
    });
    // The first child is lost after staging its version: the retry reuses it.
    const first = await opOf(f, children[0]!);
    vi.setSystemTime(Math.max(Date.now(), first.nextAttemptAt));
    const claimed = (await f.t.mutation(internal.operations.claim, {
      operationId: first._id,
      generation: first.generation,
    }))!;
    const token = { operationId: first._id, generation: claimed.generation, fence: claimed.fence };
    expect(await f.t.mutation(internal.operations.beginEffect, token)).toBe(true);
    await f.t.action(internal.importWorker.execute, { ...token, request: first.request });
    vi.setSystemTime(Date.now() + 60_001);
    await f.t.mutation(internal.operations.recoverOne, { operationId: first._id });
    await expectAvailable(f, owner, children);
    const versions = await f.t.run((ctx) => ctx.db.query("documentVersions").collect());
    expect(versions.filter((row) => row.operationId === first._id)).toHaveLength(1);
    expect(versions).toHaveLength(2);
  });

  it("filha presa sem orçamento de recuperação continua pausada e não conta como retomada", async () => {
    const { f, owner, children } = await receivedByConsole();
    await withdraw(f, owner);
    await f.t.run(async (ctx) => {
      for (const [index, id] of children.entries()) {
        const op = (await ctx.db.get("operations", id))!;
        await ctx.db.patch("operations", id, {
          state: "paused",
          code: "ACCESS_REVOKED",
          generation: op.generation + 1,
          recoveryAttempts: index === 0 ? 12 : 0,
          recoveryAt: undefined,
        });
      }
    });
    expect(await f.t.mutation(internal.captures.resumeStoredDocuments, {})).toEqual({
      resumed: 1,
      refused: 0,
      stillPaused: { RECOVERY_BUDGET_EXHAUSTED: 1 },
      isDone: true,
    });
    expect(await opOf(f, children[0]!)).toMatchObject({
      state: "paused",
      code: "RECOVERY_BUDGET_EXHAUSTED",
    });
    // The read-only list shows it, with its code and source; the resumed one is gone from it.
    expect((await f.t.query(internal.captures.pausedStoredDocuments, {})).page).toEqual([
      {
        operationId: children[0],
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        code: "RECOVERY_BUDGET_EXHAUSTED",
        source: "release",
      },
    ]);
  });
});
