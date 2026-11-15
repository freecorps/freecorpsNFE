import { nfseXml } from "../../tests/helpers/nfse";
import { it, expect } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import { person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import { importStates, importSummary } from "./lib/importCore";
import type { QueryCtx } from "./_generated/server";
import { fixture, completedImport } from "../../tests/helpers/imports";

/** Database reads of the import listings, measured on 20-file batches. */
usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-import-secret",
});

// Count returned database documents and their JSON bytes, not Convex billing or wire deltas.
function measuredDb(db: QueryCtx["db"]) {
  const reads = { queries: 0, documents: 0, jsonBytes: 0, entries: 0 };
  function trace<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, key) {
        const value: unknown = Reflect.get(object, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, object, args);
          if (["get", "unique", "take"].includes(String(key))) {
            reads.queries++;
            return Promise.resolve(result).then((value: unknown) => {
              for (const doc of Array.isArray(value) ? value : value === null ? [] : [value]) {
                reads.documents++;
                reads.jsonBytes += Buffer.byteLength(JSON.stringify(doc));
                // Published entries of a batch version (NF-e 55 has one, an ABRASF batch many).
                if (doc && typeof doc === "object" && "parentVersionId" in doc) reads.entries++;
              }
              return value;
            });
          }
          return result && typeof result === "object" ? trace(result) : result;
        };
      },
    });
  }
  return { db: trace(db), reads };
}

it.each(["fixture", "synthetic-large"])(
  "measures a 20-file %s batch without pretending to reduce DB reads",
  async (scenario) => {
    const f = await completedImport();
    await f.t.run(async (ctx) => {
      const file = (await ctx.db.get("importFiles", f.detailArgs.fileId))!;
      const operation = (await ctx.db.get("operations", file.operationId!))!;
      const version = (await ctx.db.get("documentVersions", f.detailArgs.versionId))!;
      const { _id: _fileId, _creationTime: _fileTime, ...fileData } = file;
      const { _id: _opId, _creationTime: _opTime, ...operationData } = operation;
      const { _id: _versionId, _creationTime: _versionTime, ...versionData } = version;
      const result =
        scenario === "fixture"
          ? version.result
          : JSON.stringify({ diagnostic: "x".repeat(120000) });
      await ctx.db.patch("documentVersions", version._id, { result });
      for (let i = 1; i < 20; i++) {
        const operationId = await ctx.db.insert("operations", operationData);
        await ctx.db.insert("importFiles", {
          ...fileData,
          position: i,
          name: `nota-${i}.xml`,
          operationId,
        });
        await ctx.db.insert("documentVersions", { ...versionData, operationId, result });
      }
    });
    const measure = (includeResults: boolean) =>
      f.t.run(async (ctx) => {
        const batch = (await ctx.db.get("imports", f.batch.importId))!;
        const tracked = measuredDb(ctx.db);
        const summary = await importSummary({ ...ctx, db: tracked.db }, batch, includeResults);
        return {
          payloadBytes: Buffer.byteLength(JSON.stringify(summary)),
          ...tracked.reads,
          summary,
        };
      });
    const before = await measure(true),
      after = await measure(false);
    expect(after.summary.files).toHaveLength(20);
    expect(
      after.summary.files.every((file) => file.result === null && file.versionId !== null),
    ).toBe(true);
    expect(after.documents).toBe(60);
    expect(after.jsonBytes).toBe(before.jsonBytes);
    expect(after.payloadBytes).toBeLessThan(before.payloadBytes / 10);
    process.stdout.write(
      JSON.stringify({
        scenario,
        before: {
          payloadBytes: before.payloadBytes,
          documents: before.documents,
          readJsonBytes: before.jsonBytes,
        },
        after: {
          payloadBytes: after.payloadBytes,
          documents: after.documents,
          readJsonBytes: after.jsonBytes,
        },
      }) + "\n",
    );
  },
);
it.each(["nfe-55", "abrasf"] as const)(
  "recent reads ten 20-file %s batches without published entries and keeps state and code",
  async (model) => {
    const f = await fixture(undefined, model === "abrasf");
    const xml = model === "abrasf" ? Buffer.from(nfseXml()) : xmlFixture("invoice-authorized");
    if (model === "abrasf")
      await f.t.run((ctx) =>
        ctx.db.patch("companies", f.scope.companyId, { cnpj: "11222333000181" }),
      );
    const first = await f.reserve(xml);
    await f.upload(first, xml);
    const accepted = await f.confirm(first);
    await f.t.action(internal.operationWorker.run, {
      operationId: accepted.operationId,
      generation: 1,
    });
    // Ten batches of twenty files, each a copy of the processed one with its published entries,
    // then varied outcomes: pending, rejected, superseded by a reprocess, reserved and partial.
    await f.t.run(async (ctx) => {
      const strip = <T extends { _id: unknown; _creationTime: number }>({
        _id: _unused,
        _creationTime: _time,
        ...rest
      }: T) => rest;
      const batch = (await ctx.db.get("imports", first.importId))!;
      const file = (await ctx.db.get("importFiles", first.fileIds[0]!))!;
      const operation = (await ctx.db.get("operations", file.operationId!))!;
      const version = (await ctx.db
        .query("documentVersions")
        .withIndex("by_operationId_entryIndex", (q) =>
          q.eq("operationId", operation._id).eq("entryIndex", undefined),
        )
        .unique())!;
      const entries = await ctx.db
        .query("documentVersions")
        .withIndex("by_parentVersionId", (q) => q.eq("parentVersionId", version._id))
        .take(20);
      // An NF-e 55 version is the document itself; an ABRASF batch publishes one entry per invoice.
      expect(entries).toHaveLength(model === "abrasf" ? 7 : 0);
      if (entries[0])
        await ctx.db.patch("documentVersions", entries[0]._id, { publishedAt: undefined });
      for (let b = 0; b < 10; b++) {
        const importId =
          b === 0 ? batch._id : await ctx.db.insert("imports", { ...strip(batch), key: `r-${b}` });
        for (let i = b === 0 ? 1 : 0; i < 20; i++) {
          const outcome = (b + i) % 5;
          if (outcome === 4) {
            await ctx.db.insert("importFiles", {
              ...strip(file),
              importId,
              position: i,
              state: "reserved",
              operationId: undefined,
              processingOperationId: undefined,
            });
            continue;
          }
          const operationId = await ctx.db.insert("operations", {
            ...strip(operation),
            ...(outcome === 1 ? { state: "running" as const, code: undefined } : {}),
            ...(outcome === 2 ? { state: "failed" as const, code: "COMPANY_MISMATCH" } : {}),
          });
          await ctx.db.insert("importFiles", {
            ...strip(file),
            importId,
            position: i,
            operationId,
            processingOperationId: undefined,
          });
          const versionId = await ctx.db.insert("documentVersions", {
            ...strip(version),
            operationId,
            ...(outcome === 3 ? { state: "staging" as const } : {}),
          });
          for (const entry of entries)
            await ctx.db.insert("documentVersions", {
              ...strip(entry),
              parentVersionId: versionId,
            });
        }
      }
    });
    const measure = (path: "summary" | "states") =>
      f.t.run(async (ctx) => {
        const tracked = measuredDb(ctx.db);
        const batches = await ctx.db
          .query("imports")
          .withIndex("by_organizationId_and_companyId_and_environment", (q) =>
            q
              .eq("organizationId", f.scope.organizationId)
              .eq("companyId", f.scope.companyId)
              .eq("environment", "sandbox"),
          )
          .order("desc")
          .take(10);
        const rows = [];
        for (const batch of batches)
          rows.push(
            path === "states"
              ? await importStates({ ...ctx, db: tracked.db }, batch)
              : (await importSummary({ ...ctx, db: tracked.db }, batch, false)).files.map(
                  ({ state, code }) => ({ state, code }),
                ),
          );
        return { rows, ...tracked.reads };
      });
    const before = await measure("summary"),
      after = await measure("states");
    expect(after.rows).toEqual(before.rows);
    expect(after.rows.flat()).toHaveLength(200);
    expect(new Set(after.rows.flat().map((row) => row.state))).toEqual(
      new Set(["succeeded", "running", "failed", "reserved"]),
    );
    expect(after.entries).toBe(0);
    expect(before.entries).toBe(model === "abrasf" ? 7 * 40 : 0);
    // One entry lookup less for each of the 40 files with a visible result.
    expect(after.queries).toBe(before.queries - 40);
    expect(after.documents).toBe(before.documents - before.entries);
    if (model === "abrasf") expect(after.jsonBytes).toBeLessThan(before.jsonBytes);
    else expect(after.jsonBytes).toBe(before.jsonBytes);
    const owner = await person(f.t, f.scope.organizationId, "owner");
    const scope = {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox" as const,
    };
    expect((await owner.query(api.imports.recent, scope)).map((row) => row.files)).toEqual(
      after.rows,
    );
    const operator = await person(f.t, f.scope.organizationId, "operator");
    await expect(operator.query(api.imports.recent, scope)).rejects.toThrow("NOT_FOUND");
    const other = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash: `other-recent-${model}`,
      suffix: `other-recent-${model}`,
    });
    const outsider = await person(f.t, other.organizationId, "owner");
    await expect(outsider.query(api.imports.recent, scope)).rejects.toThrow();
    expect(
      await outsider.query(api.imports.recent, {
        organizationId: other.organizationId,
        companyId: other.companyId,
        environment: "sandbox",
      }),
    ).toEqual([]);
    // Documents read, not Convex billing or latency: those were not measured here.
    process.stdout.write(
      JSON.stringify({
        model,
        batches: 10,
        filesPerBatch: 20,
        before: {
          queries: before.queries,
          documents: before.documents,
          entries: before.entries,
          readJsonBytes: before.jsonBytes,
        },
        after: {
          queries: after.queries,
          documents: after.documents,
          entries: after.entries,
          readJsonBytes: after.jsonBytes,
        },
      }) + "\n",
    );
  },
);
