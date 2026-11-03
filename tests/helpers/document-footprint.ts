import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { getDocumentSize, v, type Value } from "convex/values";
import { vi } from "vite-plus/test";
import { SignedXml } from "xml-crypto";
import { internal } from "../../platform/convex/_generated/api";
import { internalAction, internalMutation } from "../../platform/convex/_generated/server";
import { markVerified } from "../../platform/convex/lib/documentContentCleanup";
import schema from "../../platform/convex/schema";
import { hashApiKey } from "../../platform/convex/lib/apiKeyCrypto";
import { corpusRoot, fixture } from "./nfe-corpus";
import { legacyNfseImport, nfseXml } from "./nfse";
import { platformTest, type PlatformTest } from "./platform";

/**
 * Footprint of one fiscal note in the database, measured by pushing synthetic XML through the
 * real import (REST, upload, worker and scheduled projection) in convex-test (ADR 0010, phase
 * B). Sizes follow `getDocumentSize`; convex-test pads its IDs to 32 characters, the typical
 * length of a deployment's. Only aggregates leave this module.
 */
export const GZIP_LEVEL = 9;
const START = Date.UTC(2026, 9, 1, 12);
const tables = [...Object.keys(schema.tables), "_storage"];
type Rows = Record<string, Array<Record<string, Value>>>;

async function snapshot(t: PlatformTest): Promise<Rows> {
  return t.run(async (ctx) => {
    const rows: Rows = {};
    for (const table of tables)
      rows[table] = (await (table === "_storage"
        ? ctx.db.system.query("_storage").collect()
        : ctx.db.query(table as keyof typeof schema.tables).collect())) as never;
    return rows;
  });
}

const cents = (value: number) =>
  `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;

/** `invoice-authorized` with `items` copies of its item, totals adjusted and signed again. */
export function nfeWithItems(items: number) {
  const xml = fixture("invoice-authorized").toString("utf8");
  const nfe = xml.match(/<NFe [\s\S]*<\/NFe>/)![0].replace(/<Signature[\s\S]*<\/Signature>/, "");
  const item = nfe.match(/<det nItem="1">[\s\S]*?<\/det>/)![0];
  const [head, tail] = nfe.replace(item, "\u0000").split("<total>") as [string, string];
  const total = cents(2469 * items);
  const body =
    head.replace(
      "\u0000",
      Array.from({ length: items }, (_, i) => item.replace('nItem="1"', `nItem="${i + 1}"`)).join(
        "",
      ),
    ) +
    "<total>" +
    tail.replaceAll("24.69", total);
  const ds = "http://www.w3.org/2000/09/xmldsig#",
    c14n = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
  const signer = new SignedXml({
    privateKey: readFileSync(new URL("synthetic-signing-key.pem", corpusRoot), "utf8"),
    publicCert: readFileSync(new URL("synthetic-certificate.pem", corpusRoot), "utf8"),
    signatureAlgorithm: ds + "rsa-sha1",
    canonicalizationAlgorithm: c14n,
  });
  signer.addReference({
    xpath: "//*[local-name()='infNFe']",
    transforms: [ds + "enveloped-signature", c14n],
    digestAlgorithm: ds + "sha1",
  });
  signer.computeSignature(body, {
    location: { reference: "//*[local-name()='NFe']", action: "append" },
  });
  const signed = signer.getSignedXml();
  const digest = /<DigestValue>([^<]+)<\/DigestValue>/.exec(signed)![1]!;
  const full = xml
    .replace(/<NFe [\s\S]*<\/NFe>/, signed)
    .replace(/<digVal>[^<]+<\/digVal>/, `<digVal>${digest}</digVal>`);
  const summary = fixture("summary-authorized")
    .toString("utf8")
    .replace("<vNF>24.69</vNF>", `<vNF>${total}</vNF>`);
  return { summary: Buffer.from(summary), full: Buffer.from(full) };
}

export type Scenario = { id: string; model: "55" | "nfse"; items: number; files: Buffer[] };

/** NF-e with 1, 5 and 20 items, each a summary then its authorized procNFe; NFS-e alone and in a batch of 20. */
export const scenarios = (): Scenario[] => [
  ...[1, 5, 20].map((items) => {
    const { summary, full } = nfeWithItems(items);
    return { id: `nfe-${items}`, model: "55" as const, items, files: [summary, full] };
  }),
  { id: "nfse-single", model: "nfse", items: 0, files: [Buffer.from(nfseXml([1]))] },
  {
    id: "nfse-batch-20",
    model: "nfse",
    items: 0,
    files: [Buffer.from(nfseXml(Array.from({ length: 20 }, (_, i) => i + 1)))],
  },
];

/**
 * The baseline is the footprint before phase B: publication still schedules the content blob of
 * B4, and this stand-in writes nothing, so the receipt keeps measuring the inline rows only.
 */
const beforePhaseB = {
  "../../platform/convex/importProcessing.ts": async () => ({
    ...(await import("../../platform/convex/importProcessing")),
    storeContent: internalAction({
      args: { versionId: v.id("documentVersions"), attempt: v.number() },
      returns: v.null(),
      handler: async () => null,
    }),
  }),
};

/**
 * B8 clears a version's inline copy as soon as the writer reads its blob back. The tests of B4 to
 * B7 compare the blob with that copy, so they keep it: the read-back still marks the version
 * verified, only the cleanup is left out. `prefix` is the path from the caller's module map to
 * the repository root (`../../` from `tests/helpers`, `../` from `tests`).
 */
export function keepInline(prefix = "../../") {
  return {
    [`${prefix}platform/convex/importProcessing.ts`]: async () => ({
      ...(await import("../../platform/convex/importProcessing")),
      verifiedContent: internalMutation({
        args: { versionId: v.id("documentVersions"), contentSha256: v.string() },
        returns: v.null(),
        handler: async (ctx, args) => {
          await markVerified(ctx, args.versionId, args.contentSha256);
          return null;
        },
      }),
    }),
  };
}

/**
 * Runs `storeContent` for each published version still without a blob. Under load, convex-test
 * can fail a store inside a scheduled action that races another scheduled mutation ("Write
 * outside of transaction"), and swallows the error; running it directly makes the blob certain.
 */
export async function writeContent(t: PlatformTest) {
  const versions = await t.run((ctx) => ctx.db.query("documentVersions").collect());
  for (const version of versions)
    if (version.publishedAt !== undefined && version.contentStorageId === undefined)
      await t.action(internal.importProcessing.storeContent, {
        versionId: version._id,
        attempt: 1,
      });
}

/**
 * Imports `files` one after another through REST, upload, worker and scheduled work. Without
 * `contentBlobs`, the B4 content blob is not written (`beforePhaseB`).
 */
export async function importAll(
  files: Buffer[],
  { contentBlobs = false, cleanup = false }: { contentBlobs?: boolean; cleanup?: boolean } = {},
) {
  vi.setSystemTime(START);
  // `cleanup`: the writer clears the inline copy after reading its blob back, as B8 does.
  // NFS-e batches are legacy data since the ABRASF import was retired (`legacyNfseImport`).
  const t = platformTest({
    ...(contentBlobs ? (cleanup ? {} : keepInline()) : beforePhaseB),
    ...legacyNfseImport(),
  });
  const secret = `fnfe_${"b".repeat(43)}`;
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(secret),
    suffix: "footprint",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch("companies", scope.companyId, { cnpj: "11222333000181" });
    // The scheduled work advances the fake clock past the proof key's hour.
    await ctx.db.patch("apiKeys", scope.keyId, { expiresAt: Date.UTC(2100, 0, 1) });
  });
  let key = 0;
  const call = async (path: string, body?: unknown) => {
    const response = await t.fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "X-Environment": "sandbox",
        "Content-Type": "application/json",
        "Idempotency-Key": `footprint-${key++}`,
      },
      body: JSON.stringify(body ?? {}),
    });
    if (response.status !== 200)
      throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return (await response.json()).data;
  };
  const imported: { importId: string; fileId: string }[] = [];
  const before = await snapshot(t);
  for (const [index, data] of files.entries()) {
    // Timestamps inside `result` follow the clock, which the scheduled work of the previous file
    // moved by a varying amount, and the usage lane is drawn at random: each file starts at a
    // fixed instant, under the fake timers of `usePlatformEnvironment`, with the same lane,
    // stored whenever it is not 0, as in most production events.
    vi.setSystemTime(START + index * 7 * 86_400_000);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      await importFile(data);
    } finally {
      vi.restoreAllMocks();
    }
  }
  if (contentBlobs) await writeContent(t);
  return { t, call, imported, before, after: await snapshot(t) };

  async function importFile(data: Buffer) {
    const sha256 = createHash("sha256").update(data).digest("hex");
    const batch = await call("/v1/imports", {
      companyId: scope.companyId,
      files: [{ name: "nota.xml", size: data.length, sha256 }],
    });
    imported.push({ importId: batch.importId, fileId: batch.fileIds[0] });
    const file = `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}`;
    const { token } = await call(`${file}/upload`);
    const uploaded = await t.fetch("/v1/import-upload", {
      method: "POST",
      headers: { "X-Upload-Token": token },
      body: new Uint8Array(data),
    });
    if (uploaded.status !== 200) throw new Error(`upload: ${uploaded.status}`);
    const { operationId } = await call(`${file}/confirm`);
    await t.action(internal.operationWorker.run, { operationId, generation: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
}

/** The stored JSON text as a value, so the blob does not escape it a second time. */
const parsed = (value: Value | undefined) =>
  typeof value === "string" ? (JSON.parse(value) as unknown) : null;
const round = (value: number, digits = 0) => Number(value.toFixed(digits));
/** Fields that phase B moves to the per-version blob; `documentItems` rows count as moved whole. */
const MOVABLE: Record<string, string[]> = {
  documentVersions: ["result", "fiscalEvidence"],
  documentFiscalEvidence: ["snapshot"],
};

function checksOf(version: Record<string, Value>) {
  const { checks } = JSON.parse(version.result as string) as {
    checks?: Record<string, { status: string }>;
  };
  return `${version.kind as string}: signature ${checks?.signature?.status}, evidence ${checks?.fiscalEvidence?.status}`;
}

/** Bytes, rows and the movable share of one scenario, per note. */
export async function measure({ id, model, items, files }: Scenario) {
  const { before, after } = await importAll(files);
  const added = (table: string) => {
    const known = new Set(before[table]!.map((row) => row._id));
    return after[table]!.filter((row) => !known.has(row._id));
  };
  const size = (row: Record<string, Value | undefined>) =>
    getDocumentSize(row as Record<string, Value>);
  const notes = added("fiscalDocuments").length;
  const perNote = (value: number) => round(value / notes);
  const tablesOut: Record<string, { rows: number; bytes: number }> = {};
  let documentBytes = 0,
    allBytes = 0,
    movableBytes = 0,
    skeletonBytes = 0;
  for (const table of tables) {
    if (table === "_storage") continue;
    const bytes =
      after[table]!.reduce((sum, row) => sum + size(row), 0) -
      before[table]!.reduce((sum, row) => sum + size(row), 0);
    const rows = after[table]!.length - before[table]!.length;
    if (!bytes && !rows) continue;
    tablesOut[table] = { rows: round(rows / notes, 2), bytes: perNote(bytes) };
    allBytes += bytes;
    if (/^(fiscalDocuments|document)/.test(table)) documentBytes += bytes;
    for (const row of added(table))
      if (table === "documentItems") {
        movableBytes += size(row);
        // The row without `data` (`versionId` and `position`), if B keeps it for the cursor.
        skeletonBytes += size({ ...row, data: undefined });
      } else
        for (const field of MOVABLE[table] ?? [])
          if (row[field] !== undefined)
            movableBytes += size(row) - size({ ...row, [field]: undefined });
  }
  // One blob per document version: content, evidence, items and evidence snapshots, as one JSON
  // value. `raw` is that JSON before compression, so both sides of the ratio hold the same text.
  let raw = 0,
    gzip = 0;
  for (const version of added("documentVersions")) {
    const blob = JSON.stringify({
      result: parsed(version.result),
      fiscalEvidence: parsed(version.fiscalEvidence),
      items: added("documentItems")
        .filter((item) => item.versionId === version._id)
        .map((item) => parsed(item.data)),
      evidence: added("documentFiscalEvidence")
        .filter((row) => row.versionId === version._id)
        .map((row) => parsed(row.snapshot)),
    });
    raw += Buffer.byteLength(blob);
    gzip += gzipSync(blob, { level: GZIP_LEVEL }).byteLength;
  }
  const storage = added("_storage");
  return {
    id,
    model,
    items,
    files: files.length,
    notes,
    versionsPerNote: round(added("documentVersions").length / notes, 2),
    // Proves the re-signed NF-e passed as authorized, like the production notes it compares to.
    checks: [...new Set(added("documentVersions").map(checksOf))].sort(),
    blobsPerNote: round(storage.length / notes, 2),
    fileBytesPerNote: perNote(storage.reduce((sum, blob) => sum + (blob.size as number), 0)),
    xmlBytes: files.reduce((sum, file) => sum + file.length, 0),
    documentBytesPerNote: perNote(documentBytes),
    allTablesBytesPerNote: perNote(allBytes),
    residualDocumentBytesPerNote: perNote(documentBytes - movableBytes),
    residualWithItemSkeletonBytesPerNote: perNote(documentBytes - movableBytes + skeletonBytes),
    movable: {
      rawBytesPerNote: perNote(raw),
      gzipBytesPerNote: perNote(gzip),
      gzipRatio: round(gzip / raw, 3),
    },
    tables: tablesOut,
  };
}

/** Least squares of `value` over the item count: fixed bytes plus bytes per item. */
export function regression(points: Array<{ items: number; value: number }>) {
  const n = points.length,
    mx = points.reduce((s, p) => s + p.items, 0) / n,
    my = points.reduce((s, p) => s + p.value, 0) / n;
  const perItem =
    points.reduce((s, p) => s + (p.items - mx) * (p.value - my), 0) /
    points.reduce((s, p) => s + (p.items - mx) ** 2, 0);
  return { fixed: round(my - perItem * mx), perItem: round(perItem) };
}

export async function footprint() {
  const measured = [];
  for (const scenario of scenarios()) measured.push(await measure(scenario));
  const nfe = measured.filter((s) => s.model === "55");
  const fit = (pick: (s: (typeof nfe)[number]) => number) =>
    regression(nfe.map((s) => ({ items: s.items, value: pick(s) })));
  return {
    format: "document-footprint/1",
    sizeMethod: "getDocumentSize de convex/values, IDs de 32 caracteres, sem índices",
    gzip: { library: "node:zlib", level: GZIP_LEVEL, blob: "um por versão de documento" },
    environment: "sandbox (convex-test)",
    regression: {
      nfeDocumentTables: fit((s) => s.documentBytesPerNote),
      nfeAllTables: fit((s) => s.allTablesBytesPerNote),
      nfeGzipBlob: fit((s) => s.movable.gzipBytesPerNote),
      nfeResidual: fit((s) => s.residualDocumentBytesPerNote),
      nfeResidualWithItemSkeleton: fit((s) => s.residualWithItemSkeletonBytesPerNote),
    },
    scenarios: measured,
  };
}

/**
 * The same scenario after phase B (ADR 0010, B8): the writer stores the blob, reads it back and
 * clears the inline copy. Bytes per note in the document tables and in all tables, and the files
 * per note, blob included, measured as `measure` measures before.
 */
export async function measureAfter({ id, model, items, files }: Scenario) {
  const { before, after } = await importAll(files, { contentBlobs: true, cleanup: true });
  const size = (row: Record<string, Value | undefined>) =>
    getDocumentSize(row as Record<string, Value>);
  const added = (table: string) => {
    const known = new Set(before[table]!.map((row) => row._id));
    return after[table]!.filter((row) => !known.has(row._id));
  };
  const notes = added("fiscalDocuments").length;
  const perNote = (value: number) => round(value / notes);
  let documentBytes = 0,
    allBytes = 0;
  const tablesOut: Record<string, { rows: number; bytes: number }> = {};
  for (const table of tables) {
    if (table === "_storage") continue;
    const bytes =
      after[table]!.reduce((sum, row) => sum + size(row), 0) -
      before[table]!.reduce((sum, row) => sum + size(row), 0);
    const rows = after[table]!.length - before[table]!.length;
    if (!bytes && !rows) continue;
    tablesOut[table] = { rows: round(rows / notes, 2), bytes: perNote(bytes) };
    allBytes += bytes;
    if (/^(fiscalDocuments|document)/.test(table)) documentBytes += bytes;
  }
  const versions = added("documentVersions");
  const storage = added("_storage");
  return {
    id,
    model,
    items,
    notes,
    versionsPerNote: round(versions.length / notes, 2),
    clearedVersions: versions.filter((version) => version.result === undefined).length,
    blobsPerNote: round(storage.length / notes, 2),
    fileBytesPerNote: perNote(storage.reduce((sum, blob) => sum + (blob.size as number), 0)),
    documentBytesPerNote: perNote(documentBytes),
    allTablesBytesPerNote: perNote(allBytes),
    tables: tablesOut,
  };
}
