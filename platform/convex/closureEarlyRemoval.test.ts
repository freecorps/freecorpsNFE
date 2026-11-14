import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { trackStoredFile } from "./lib/capacityCore";
import { DOCUMENT_CONTENT_FORMAT, encodeDocumentContent } from "./lib/documentContent";
import { actor } from "../../tests/helpers/export-fixture";
import { fiscalGuardUntil } from "./lib/retentionClasses";
import {
  DAY,
  fixture,
  type Fixture,
  settleNow,
  slug,
  closureOf,
  conserved,
  counts,
  seedGuarded,
  twin,
  production,
  snapshot,
  survivors,
  closeAndPurge,
  rest,
  own,
} from "../../tests/helpers/closure";

/** How the early removal runs: legal holds, batches, shared files, cold archives and content blobs. */
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

it("uma retenção legal ativa segura a remoção antecipada, que vem na verificação depois da liberação", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await seedGuarded(f, "sandbox");
  const organizationId = f.scope.organizationId;
  const reference = "fiscalizacao-sandbox";
  await f.t.mutation(internal.fiscalGuard.hold, {
    organizationId,
    reference,
    responsible: "operacao-sintetica",
    reviewAt: Date.now() + 400 * DAY,
  });
  const kept = await counts(f, conserved);
  const before = await snapshot(f);
  let closure = await closeAndPurge(f, owner);
  expect(await counts(f, conserved)).toEqual(kept);
  await f.t.mutation(internal.fiscalGuard.early, { closureId: closure._id });
  expect(await counts(f, conserved)).toEqual(kept);
  await f.t.mutation(internal.fiscalGuard.release, { organizationId, reference });
  closure = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  await settleNow(f);
  expect(survivors(before, await snapshot(f))).toEqual(own(before));
  expect((await closureOf(f))!.expiredAt).toBeUndefined();
});

it("a remoção antecipada chamada direto não apaga uma organização ainda em encerramento", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const kept = await counts(f, conserved);
  await owner.client.mutation(api.organizationClosure.close, {
    organizationId: f.scope.organizationId,
    confirmation: await slug(f),
  });
  const closure = (await closureOf(f))!;
  expect(await f.t.mutation(internal.fiscalGuard.early, { closureId: closure._id })).toEqual({
    done: true,
    removed: 0,
  });
  expect(await counts(f, conserved)).toEqual(kept);
});

it("um encerramento expurgado antes da decisão de 27/10/2026 perde os dados na verificação seguinte, em lotes", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await twin(f);
  const closure = await closeAndPurge(f, owner);
  const kept = await snapshot(f);
  const untouched = await rest(f, {});
  // As the previous version left it: everything waiting for the guard, more than one batch.
  await seedGuarded(f, "sandbox");
  await f.t.run(async (ctx) => {
    for (let i = 0; i < 250; i++)
      await ctx.db.insert("usageEvents", {
        organizationId: f.scope.organizationId,
        environment: "sandbox",
        metric: "imports",
        key: `legacy-${i}`,
        period: "2026-10",
        quantity: 1,
        state: "committed",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
  });
  const seeded = await snapshot(f);
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect((await closureOf(f))!.expired).toBe((closure.expired ?? 0) + 200);
  expect((await closureOf(f))!.removed).toBe(closure.removed);
  await settleNow(f);
  // Every seeded row went; the rows that were there before, of the other organization, stay.
  const added = Object.fromEntries(
    Object.entries(seeded).map(([table, ids]) => [
      table,
      ids.filter((id) => !kept[table]?.includes(id)),
    ]),
  );
  expect(survivors(added, await snapshot(f))).toEqual(own(added));
  expect(await rest(f, added)).toEqual(untouched);
  const current = (await closureOf(f))!;
  expect(current.expiredAt).toBeUndefined();
  const job = await f.t.run((ctx) =>
    ctx.db.system.get("_scheduled_functions", current.scheduledId!),
  );
  expect(job?.name).toContain("expire");
  expect(job?.scheduledTime).toBe(Date.now() + 7 * DAY);
});

it("um erro na remoção antecipada desfaz o lote, avisa e mantém a agenda da guarda", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const other = await twin(f);
  // A corrupted link: an artifact of the other organization under this organization's document.
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...rest } = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first())!;
    await ctx.db.insert("documentArtifacts", {
      ...rest,
      organizationId: other.organizationId,
      fileId: undefined,
      storageId: await ctx.storage.store(new Blob(["other"])),
    });
  });
  const kept = await counts(f, conserved);
  const warn = vi.spyOn(console, "warn");
  const closure = await closeAndPurge(f, owner);
  const failed = warn.mock.calls.filter(([line]) =>
    String(line).includes("organization.sandbox-purge-failed"),
  );
  warn.mockRestore();
  expect(failed.length).toBeGreaterThan(0);
  expect(await counts(f, conserved)).toEqual(kept);
  const job = await f.t.run((ctx) =>
    ctx.db.system.get("_scheduled_functions", closure.scheduledId!),
  );
  expect(job?.name).toContain("expire");
  expect(job?.state.kind).toBe("pending");
});

it("um arquivo também guardado por outra organização fica; os da própria organização saem", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const other = await twin(f);
  const { shared, alone, foreign } = await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...rest } = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first())!;
    const shared = await ctx.storage.store(new Blob(["shared"]));
    const alone = await ctx.storage.store(new Blob(["own"]));
    // More holders in this organization than one read covers, for both files.
    for (let i = 0; i < 25; i++)
      for (const storageId of [shared, alone])
        await ctx.db.insert("documentArtifacts", { ...rest, fileId: undefined, storageId });
    const foreign = await ctx.db.insert("documentArtifacts", {
      ...rest,
      organizationId: other.organizationId,
      documentId: undefined,
      fileId: undefined,
      storageId: shared,
    });
    return { shared, alone, foreign };
  });
  await closeAndPurge(f, owner);
  await f.t.run(async (ctx) => {
    const holders = (await ctx.db.query("documentArtifacts").collect()).filter(
      (row) => row.organizationId === f.scope.organizationId,
    );
    expect(holders).toEqual([]);
    expect(await ctx.db.get("documentArtifacts", foreign)).not.toBeNull();
    expect(await ctx.db.system.get("_storage", shared)).not.toBeNull();
    expect(await ctx.db.system.get("_storage", alone)).toBeNull();
  });
});

it("um encerramento sem decisão gravada decide na verificação seguinte, e arquivo frio conta como Produção", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  // Held, so the purge leaves the data in place, as a closure purged before 27/10/2026 did.
  await f.t.mutation(internal.fiscalGuard.hold, {
    organizationId,
    reference: "anterior",
    responsible: "operacao-sintetica",
    reviewAt: Date.now() + 400 * DAY,
  });
  await closeAndPurge(f, owner);
  await f.t.mutation(internal.fiscalGuard.release, { organizationId, reference: "anterior" });
  const kept = await counts(f, conserved);
  await f.t.run(async (ctx) => {
    const closure = (await ctx.db.query("organizationClosures").first())!;
    await ctx.db.patch("organizationClosures", closure._id, { sandboxOnly: undefined });
    await ctx.db.insert("coldArchiveRuns", {
      organizationId,
      key: `archive-${organizationId}`,
      version: 1,
      state: "archived",
      reason: "closed",
      noticeAt: Date.now(),
      eligibleAt: Date.now(),
      retainUntil: Date.now() + 365 * DAY,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "synthetic",
    });
  });
  const closure = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  await settleNow(f);
  expect((await closureOf(f))!.sandboxOnly).toBe(false);
  expect(await counts(f, conserved)).toEqual(kept);
  // Decided once: removing the archive run later changes nothing.
  await f.t.run(async (ctx) => {
    for (const run of await ctx.db.query("coldArchiveRuns").collect())
      await ctx.db.delete("coldArchiveRuns", run._id);
  });
  const again = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: again._id,
    generation: again.generation,
  });
  expect(await counts(f, conserved)).toEqual(kept);
});

it("um arquivo cujo outro dono não pode ser lido desfaz o lote e não apaga a linha", async () => {
  const f = await fixture(),
    owner = await actor(f);
  // An import file of a vanished import holds the same original as this organization's artifact.
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...file } = (await ctx.db.query("importFiles").first())!;
    const {
      _id: _importId,
      _creationTime: _created,
      ...source
    } = (await ctx.db.query("imports").first())!;
    const gone = await ctx.db.insert("imports", source);
    await ctx.db.delete("imports", gone);
    await ctx.db.insert("importFiles", { ...file, importId: gone });
  });
  const kept = await counts(f, conserved);
  const storageId = await f.t.run(
    async (ctx) => (await ctx.db.query("importFiles").first())!.storageId!,
  );
  const warn = vi.spyOn(console, "warn");
  const closure = await closeAndPurge(f, owner);
  const logged = (text: string) =>
    warn.mock.calls.filter(([line]) => String(line).includes(text)).length;
  expect(closure.sandboxOnly).toBe(true);
  expect(logged("Unreadable file holder")).toBeGreaterThan(0);
  expect(await counts(f, conserved)).toEqual(kept);

  // At the deadline the guard does not stop: the rows go, the file stays and is logged.
  vi.setSystemTime(fiscalGuardUntil(closure.requestedAt));
  const current = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: current._id,
    generation: current.generation,
  });
  await settleNow(f);
  const fileKept = logged("organization.file-kept");
  warn.mockRestore();
  expect((await closureOf(f))!.expiredAt).toBeDefined();
  expect(fileKept).toBeGreaterThan(0);
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get("fiscalDocuments", f.documentId)).toBeNull();
    expect(await ctx.db.system.get("_storage", storageId)).not.toBeNull();
  });
});

it("um arquivo frio iniciado depois da decisão para a remoção antecipada, uma vez", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  // Held through the purge, so the data is still there after the decision.
  await f.t.mutation(internal.fiscalGuard.hold, {
    organizationId,
    reference: "arquivo",
    responsible: "operacao-sintetica",
    reviewAt: Date.now() + 400 * DAY,
  });
  const kept = await counts(f, conserved);
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(true);
  await f.t.mutation(internal.fiscalGuard.release, { organizationId, reference: "arquivo" });
  await f.t.run((ctx) =>
    ctx.db.insert("coldArchiveRuns", {
      organizationId,
      key: `archive-${organizationId}`,
      version: 1,
      state: "notice",
      reason: "closed",
      noticeAt: Date.now(),
      eligibleAt: Date.now(),
      retainUntil: Date.now() + 365 * DAY,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "synthetic",
    }),
  );
  const warn = vi.spyOn(console, "warn");
  for (let i = 0; i < 2; i++) {
    const current = (await closureOf(f))!;
    await f.t.mutation(internal.fiscalGuard.expire, {
      closureId: current._id,
      generation: current.generation,
    });
  }
  const stopped = warn.mock.calls.filter(([line]) =>
    String(line).includes("organization.sandbox-purge-stopped"),
  ).length;
  warn.mockRestore();
  expect(stopped).toBe(1);
  expect((await closureOf(f))!.sandboxOnly).toBe(false);
  expect(await counts(f, conserved)).toEqual(kept);
});

it("um encerramento sem decisão gravada, só com Sandbox e sem arquivo frio, perde os dados na verificação seguinte", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  await f.t.mutation(internal.fiscalGuard.hold, {
    organizationId,
    reference: "anterior",
    responsible: "operacao-sintetica",
    reviewAt: Date.now() + 400 * DAY,
  });
  await closeAndPurge(f, owner);
  await f.t.mutation(internal.fiscalGuard.release, { organizationId, reference: "anterior" });
  await f.t.run(async (ctx) => {
    const closure = (await ctx.db.query("organizationClosures").first())!;
    await ctx.db.patch("organizationClosures", closure._id, { sandboxOnly: undefined });
  });
  const before = await snapshot(f);
  const closure = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  await settleNow(f);
  const after = (await closureOf(f))!;
  expect(after.sandboxOnly).toBe(true);
  expect(after.expiredAt).toBeUndefined();
  expect(after.expired).toBeGreaterThan(0);
  expect(survivors(before, await snapshot(f))).toEqual(own(before));
});

/**
 * Two versions holding a content blob (ADR 0010, phase B), tracked in the capacity inventory:
 * one on the fixture document, removed with it, and one without a document, which only the
 * operations path reaches, once the artifacts are gone.
 */
async function contentBlobs(f: Fixture) {
  return f.t.run(async (ctx) => {
    const { _id, _creationTime, ...template } = (await ctx.db
      .query("documentVersions")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first())!;
    const ids: Id<"_storage">[] = [];
    for (const documentId of [f.documentId, undefined]) {
      const encoded = await encodeDocumentContent({ result: template.result!, items: [] });
      const contentStorageId = await ctx.storage.store(new Blob([Uint8Array.from(encoded.bytes)]));
      await ctx.db.insert("documentVersions", {
        ...template,
        documentId,
        contentStorageId,
        contentSha256: encoded.contentSha256,
        contentSize: encoded.contentSize,
        contentFormat: DOCUMENT_CONTENT_FORMAT,
      });
      await trackStoredFile(ctx, f.scope.organizationId, contentStorageId);
      ids.push(contentStorageId);
    }
    return ids;
  });
}
async function contentBlobsGone(f: Fixture, ids: Id<"_storage">[]) {
  await f.t.run(async (ctx) => {
    expect(await ctx.db.query("documentVersions").collect()).toEqual([]);
    for (const id of ids) {
      expect(await ctx.db.system.get("_storage", id)).toBeNull();
      expect(
        await ctx.db
          .query("capacityFiles")
          .withIndex("by_storageId", (q) => q.eq("storageId", id))
          .collect(),
      ).toEqual([]);
    }
  });
}

it("a remoção antecipada apaga o blob de conteúdo das versões e libera sua capacidade, pelos documentos e pelas operações", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const ids = await contentBlobs(f);
  await closeAndPurge(f, owner);
  expect((await closureOf(f))!.sandboxOnly).toBe(true);
  await contentBlobsGone(f, ids);
});

it("o expurgo no fim da guarda apaga o blob de conteúdo das versões e libera sua capacidade", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const ids = await contentBlobs(f);
  await production(f);
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(false);
  vi.setSystemTime(fiscalGuardUntil(closure.requestedAt));
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  await settleNow(f);
  expect((await closureOf(f))!.expiredAt).toBeDefined();
  await contentBlobsGone(f, ids);
});
