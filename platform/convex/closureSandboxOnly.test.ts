import { createHash } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { actor } from "../../tests/helpers/export-fixture";
import { writeContent } from "../../tests/helpers/document-footprint";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import { fiscalGuardUntil } from "./lib/retentionClasses";
import {
  DAY,
  fixture,
  type Fixture,
  settle,
  settleNow,
  at,
  slug,
  closureOf,
  conserved,
  counts,
  seed,
  seedGuarded,
  twin,
  snapshot,
  survivors,
  closeAndPurge,
  rest,
  own,
} from "../../tests/helpers/closure";

/** A closed organization that never had Production loses its fiscal data early (#108). */
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5203",
    CONVEX_SITE_URL: "http://127.0.0.1:3265",
    BETTER_AUTH_SECRET: "synthetic-closure-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Rows with no environment: certificate audit, an orphan idempotency record, usage before #429. */
async function seedWithoutEnvironment(f: Fixture, membershipId: Id<"memberships">) {
  await seed(f, membershipId);
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...template } = (await ctx.db.query("operations").first())!;
    const operationId = await ctx.db.insert("operations", template);
    await ctx.db.delete("operations", operationId);
    await ctx.db.insert("idempotencyRecords", {
      organizationId: f.scope.organizationId,
      projectId: f.scope.projectId,
      name: "documents.import",
      key: "orphan",
      requestHash: "synthetic",
      operationId,
    });
    await ctx.db.insert("usageEvents", {
      organizationId: f.scope.organizationId,
      metric: "imports",
      key: "before-429",
      period: "2026-10",
      quantity: 1,
      state: "committed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

it("remove depois do encerramento os dados fiscais de uma organização que nunca teve Produção, sem os registros próprios da Freecorps", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await seedGuarded(f, "sandbox");
  await seedWithoutEnvironment(f, owner.membershipId);
  const before = await snapshot(f);
  const other = await twin(f);
  // A real note of another organization decides nothing here (#108).
  await f.t.run(async (ctx) => {
    for (const row of await ctx.db.query("fiscalDocuments").collect())
      if (row.organizationId === other.organizationId)
        await ctx.db.patch("fiscalDocuments", row._id, { tpAmb: "1" });
  });
  const untouched = await rest(f, before);
  expect((await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.documentId)))!.tpAmb).toBe("2");
  const closure = await closeAndPurge(f, owner);
  const after = await snapshot(f);
  // Plans, payments and capacity stay for their own deadline.
  expect(survivors(before, after)).toEqual(own(before));
  expect(own(before)).toEqual(
    expect.arrayContaining(["platformFreeClaims", "platformPlanReceipts", "platformPlanTerms"]),
  );
  expect(after._storage).toEqual([other.storageId]);
  // Another organization keeps its Sandbox.
  expect(await rest(f, before)).toEqual(untouched);
  expect(closure.expiredAt).toBeUndefined();
  expect(closure.sandboxOnly).toBe(true);
  // The guard then ends at its deadline as for an organization without fiscal data.
  vi.setSystemTime(fiscalGuardUntil(closure.requestedAt));
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect((await closureOf(f))!.expiredAt).toBeDefined();
  expect(await rest(f, before)).toEqual(untouched);
});

it("com qualquer sinal de Produção, a guarda conserva tudo até o prazo, como antes", async () => {
  const now = () => Date.now();
  const gate = (f: Fixture, production: boolean) =>
    f.t.run((ctx) =>
      ctx.db.insert("issuanceGateEvents", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        version: 1,
        kind: "emergency_disable",
        production,
        operator: "operador-freecorps",
        reason: "Gate sintético",
        runId: "2",
        runAttempt: 1,
        buildSha: null,
        deployment: "https://brave-otter-123.convex.cloud",
        createdAt: now(),
      }),
    );
  const signals = {
    usage: (f: Fixture) =>
      f.t.run((ctx) =>
        ctx.db.insert("usageEvents", {
          organizationId: f.scope.organizationId,
          environment: "production",
          metric: "imports",
          key: "production",
          period: "2026-10",
          quantity: 1,
          state: "committed",
          createdAt: now(),
          updatedAt: now(),
        }),
      ),
    release: (f: Fixture) =>
      f.t.run((ctx) =>
        ctx.db.insert("captureReleaseEvents", {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          version: 1,
          kind: "emergency_withdraw",
          released: true,
          blocked: false,
          minIntervalHours: 1,
          revokedKeys: 0,
          operator: "operador-freecorps",
          reason: "Liberação sintética",
          runId: "1",
          runAttempt: 1,
          buildSha: null,
          deployment: "https://brave-otter-123.convex.cloud",
          createdAt: now(),
        }),
      ),
    gate: (f: Fixture) => gate(f, true),
    // #108: an imported NF-e whose XML says Produção, and one not known to be homologação.
    real: (f: Fixture) =>
      f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "1" })),
    unmarked: (f: Fixture) =>
      f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: undefined })),
    // More history than one read covers counts as Production, even without a production event.
    events: async (f: Fixture) => {
      for (let i = 0; i < 101; i++) await gate(f, false);
    },
    probe: (f: Fixture) =>
      f.t.run((ctx) =>
        ctx.db.insert("issuanceProbeEvents", {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          kind: "probe",
          environment: "producao",
          result: "authorized",
          operator: "operador-freecorps",
          reason: "Probe sintético",
          buildSha: null,
          deployment: "https://brave-otter-123.convex.cloud",
          createdAt: now(),
        }),
      ),
    imports: (f: Fixture) =>
      f.t.run(async (ctx) => {
        const row = (await ctx.db.query("imports").first())!;
        await ctx.db.patch("imports", row._id, { environment: "production" });
      }),
    issuances: async (f: Fixture) => {
      await seedGuarded(f, "sandbox");
      await f.t.run(async (ctx) => {
        const row = (await ctx.db.query("issuances").first())!;
        await ctx.db.patch("issuances", row._id, { environment: "production" });
      });
    },
    // Cold archive moves rows out of the tables the decision reads: an archive run is enough.
    archived: (f: Fixture) =>
      f.t.run((ctx) =>
        ctx.db.insert("coldArchiveRuns", {
          organizationId: f.scope.organizationId,
          key: `archive-${f.scope.organizationId}`,
          version: 1,
          state: "archived",
          reason: "closed",
          noticeAt: now(),
          eligibleAt: now(),
          retainUntil: now() + 365 * DAY,
          createdAt: now(),
          updatedAt: now(),
          phase: 0,
          cursor: null,
          rows: 0,
          files: 0,
          bytes: 0,
          digest: "synthetic",
        }),
      ),
  };
  for (const [name, signal] of Object.entries(signals)) {
    vi.setSystemTime(Date.UTC(2026, 9, 27, 12));
    const f = await fixture(),
      owner = await actor(f);
    // The signal appears during the closing window: the decision is taken at the purge.
    const closed = await owner.client.mutation(api.organizationClosure.close, {
      organizationId: f.scope.organizationId,
      confirmation: await slug(f),
    });
    await signal(f);
    const kept = await counts(f, conserved);
    await settle(f);
    await at(f, closed.exportUntil + 1);
    const closure = (await closureOf(f))!;
    expect(closure.state, name).toBe("purged");
    expect(closure.sandboxOnly, name).toBe(false);
    expect(await counts(f, conserved), name).toEqual(kept);
    // Only the deadline removes it.
    vi.setSystemTime(fiscalGuardUntil(closure.requestedAt) - 1);
    await f.t.mutation(internal.fiscalGuard.expire, {
      closureId: closure._id,
      generation: closure.generation,
    });
    expect(await counts(f, conserved), name).toEqual(kept);
  }
});

it("uma NF-e importada com tpAmb 1 no Sandbox não sai na remoção antecipada, chamada direto", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "1" }));
  const kept = await counts(f, conserved);
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(false);
  expect(await f.t.mutation(internal.fiscalGuard.early, { closureId: closure._id })).toEqual({
    done: true,
    removed: 0,
  });
  expect(await counts(f, conserved)).toEqual(kept);
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.documentId))).not.toBeNull();
});

it("a NF-e com tpAmb 1 do Sandbox fica até o prazo da guarda e sai na expiração final", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "1" }));
  const closure = await closeAndPurge(f, owner);
  vi.setSystemTime(fiscalGuardUntil(closure.requestedAt) - 1);
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.documentId))).not.toBeNull();
  vi.setSystemTime(fiscalGuardUntil(closure.requestedAt));
  const current = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: current._id,
    generation: current.generation,
  });
  await settleNow(f);
  expect((await closureOf(f))!.expiredAt).toBeDefined();
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.documentId))).toBeNull();
});

it("uma decisão de só Sandbox tomada antes da #108 para uma vez diante de uma NF-e real", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  await f.t.mutation(internal.fiscalGuard.hold, {
    organizationId,
    reference: "anterior-108",
    responsible: "operacao-sintetica",
    reviewAt: Date.now() + 400 * DAY,
  });
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(true);
  // The note as it was before #108: no mark, under a decision already recorded.
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: undefined }));
  await f.t.mutation(internal.fiscalGuard.release, { organizationId, reference: "anterior-108" });
  const kept = await counts(f, conserved);
  const warn = vi.spyOn(console, "warn");
  for (let i = 0; i < 2; i++) {
    const current = (await closureOf(f))!;
    await f.t.mutation(internal.fiscalGuard.expire, {
      closureId: current._id,
      generation: current.generation,
    });
  }
  const stopped = warn.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("organization.sandbox-purge-stopped"));
  warn.mockRestore();
  expect(stopped).toHaveLength(1);
  expect(JSON.parse(stopped[0]!)).toMatchObject({ reason: "fiscal-document" });
  expect((await closureOf(f))!.sandboxOnly).toBe(false);
  expect(await counts(f, conserved)).toEqual(kept);
});

/**
 * Imports `xml` as one more file of the fixture's company and runs its operation. The corpus note
 * with another issuer is refused as COMPANY_MISMATCH and keeps no document, only its original.
 */
async function importRefused(f: Fixture, xml: string) {
  const bytes = Buffer.from(xml);
  const key = crypto.randomUUID();
  const data = async (path: string, body?: unknown) =>
    (await (await f.request(path, "POST", body, `${key}-${path}`)).json()).data;
  const batch = await data("/v1/imports", {
    companyId: f.scope.companyId,
    files: [
      {
        name: "recusada.xml",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  });
  const file = `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}`;
  const upload = await data(`${file}/upload`);
  const sent = await f.t.fetch("/v1/import-upload", {
    method: "POST",
    headers: { "X-Upload-Token": upload.token },
    body: new Uint8Array(bytes),
  });
  expect(sent.status).toBe(200);
  const { operationId } = await data(`${file}/confirm`);
  await f.t.action(internal.operationWorker.run, { operationId, generation: 1 });
  // The content blob of the new version, written now so later counts do not see it arrive.
  await writeContent(f.t);
  return f.t.run(async (ctx) => {
    const artifact = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_fileId", (q) => q.eq("fileId", batch.fileIds[0]))
      .unique())!;
    const versions = await ctx.db
      .query("documentVersions")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifact._id))
      .collect();
    return { artifact, codes: versions.map((version) => version.code) };
  });
}
/** The corpus note, homologação, issued by a CNPJ other than the fixture company's. */
const otherIssuer = (tpAmb: "1" | "2") =>
  xmlFixture("invoice-authorized")
    .toString("utf8")
    .replaceAll("<tpAmb>2</tpAmb>", `<tpAmb>${tpAmb}</tpAmb>`)
    .replace("<emit><CNPJ>11222333000181</CNPJ>", "<emit><CNPJ>12345678000195</CNPJ>");

it("uma NF-e recusada com tpAmb 1 marca o original, que conta como Produção e fica até o prazo", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const { artifact, codes } = await importRefused(f, otherIssuer("1"));
  expect(codes).toEqual(["COMPANY_MISMATCH"]);
  expect([artifact.documentId, artifact.tpAmb]).toEqual([undefined, "1"]);
  const kept = await counts(f, conserved);
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(false);
  expect(await f.t.mutation(internal.fiscalGuard.early, { closureId: closure._id })).toEqual({
    done: true,
    removed: 0,
  });
  expect(await counts(f, conserved)).toEqual(kept);
  expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", artifact._id))).not.toBeNull();
});

it("um XML recusado antes da nota normalizada guarda a marca dos bytes, e sem ela conta como Produção", async () => {
  const nfce = await (async () => {
    const f = await fixture(),
      owner = await actor(f);
    await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "2" }));
    // An NFC-e is refused by the parser, with no document: only its bytes say Produção.
    const { artifact, codes } = await importRefused(
      f,
      otherIssuer("1").replace("<mod>55</mod>", "<mod>65</mod>"),
    );
    return { artifact, codes, closure: await closeAndPurge(f, owner) };
  })();
  expect([nfce.codes, nfce.artifact.tpAmb]).toEqual([["XML_MODEL_UNSUPPORTED"], "1"]);
  expect(nfce.closure.sandboxOnly).toBe(false);
  // A file the parser could not read is not known to hold no note.
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "2" }));
  const malformed = await importRefused(f, "<NFe><infNFe>");
  expect([malformed.codes, malformed.artifact.tpAmb]).toEqual([["XML_MALFORMED"], undefined]);
  expect((await closeAndPurge(f, owner)).sandboxOnly).toBe(false);
});

it("uma NF-e recusada de homologação não segura a remoção antecipada, e um arquivo que não é nota também não", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "2" }));
  const test = await importRefused(f, otherIssuer("2"));
  expect([test.codes, test.artifact.tpAmb]).toEqual([["COMPANY_MISMATCH"], "2"]);
  const junk = await importRefused(f, '<?xml version="1.0"?><nota>sintética</nota>');
  expect([junk.codes, junk.artifact.tpAmb]).toEqual([["XML_NAMESPACE_UNSUPPORTED"], undefined]);
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(true);
  await at(f, Date.now() + 1);
  for (const { artifact } of [test, junk])
    expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", artifact._id))).toBeNull();
});

it("os limites da leitura dos originais recusados contam como Produção, e o original sem versão também", async () => {
  /** `artifacts` unmarked originals without a document, each with `versions` refusals of a non-NF-e root. */
  const decide = async (artifacts: number, versions: number) => {
    const f = await fixture(),
      owner = await actor(f);
    await f.t.run(async (ctx) => {
      await ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "2" });
      const original = (await ctx.db.query("documentArtifacts").first())!;
      const { _id, _creationTime, documentId: _document, ...artifact } = original;
      const {
        _id: _versionId,
        _creationTime: _versionTime,
        documentId: _versionDocument,
        ...version
      } = (await ctx.db.query("documentVersions").first())!;
      for (let i = 0; i < artifacts; i++) {
        const artifactId = await ctx.db.insert("documentArtifacts", artifact);
        for (let n = 0; n < versions; n++)
          await ctx.db.insert("documentVersions", {
            ...version,
            artifactId,
            code: "XML_NAMESPACE_UNSUPPORTED",
            kind: "unknown",
          });
      }
    });
    return (await closeAndPurge(f, owner)).sandboxOnly;
  };
  expect(await decide(1, 10)).toBe(true);
  expect(await decide(1, 11)).toBe(false);
  expect(await decide(1, 0)).toBe(false);
  expect(await decide(100, 1)).toBe(true);
  expect(await decide(101, 1)).toBe(false);
});

it("um original recusado sem a marca, de antes dela, para uma decisão de só Sandbox já gravada", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "2" }));
  const organizationId = f.scope.organizationId;
  await f.t.mutation(internal.fiscalGuard.hold, {
    organizationId,
    reference: "recusada-sem-marca",
    responsible: "operacao-sintetica",
    reviewAt: Date.now() + 400 * DAY,
  });
  const { artifact } = await importRefused(f, otherIssuer("2"));
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(true);
  // The refused original as it was before the mark: a note, but not known to be a test one.
  await f.t.run((ctx) => ctx.db.patch("documentArtifacts", artifact._id, { tpAmb: undefined }));
  await f.t.mutation(internal.fiscalGuard.release, {
    organizationId,
    reference: "recusada-sem-marca",
  });
  const kept = await counts(f, conserved);
  const warn = vi.spyOn(console, "warn");
  const current = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: current._id,
    generation: current.generation,
  });
  const stopped = warn.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("organization.sandbox-purge-stopped"));
  warn.mockRestore();
  expect(stopped.map((line) => JSON.parse(line).reason)).toEqual(["fiscal-document"]);
  expect((await closureOf(f))!.sandboxOnly).toBe(false);
  expect(await counts(f, conserved)).toEqual(kept);
});
