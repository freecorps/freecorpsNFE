import {
  referenceDate,
  referenceVersion,
  referenceManifest,
  referenceSearch,
  referenceValidity,
  referenceCursor,
  type ReferenceCursor,
  type ReferenceEntry,
} from "../../../packages/contracts/src/references";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { deny } from "./organizationAccess";

export interface ReferenceRead {
  dataset: "municipalities" | "ncm";
  date: string;
  version?: string;
  q?: string;
  code?: string;
  cursor?: string;
  limit?: number;
}
function entry(row: Doc<"referenceEntries">): ReferenceEntry {
  return {
    code: row.code,
    description: row.description,
    state: row.state,
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}
export async function readReferences(ctx: QueryCtx, args: ReferenceRead) {
  if (
    !referenceDate.safeParse(args.date).success ||
    (args.version !== undefined && !referenceVersion.safeParse(args.version).success) ||
    (args.q?.length ?? 0) > 100 ||
    !Number.isInteger(args.limit ?? 20) ||
    (args.limit ?? 20) < 1 ||
    (args.limit ?? 20) > 50 ||
    (args.code !== undefined && !(args.dataset === "ncm" ? /^\d{8}$/ : /^\d{7}$/).test(args.code))
  )
    return deny("INVALID_QUERY");
  const q = referenceSearch(args.q ?? "");
  let cursor: ReferenceCursor | undefined;
  if (args.cursor !== undefined) {
    try {
      if (args.cursor.length > 8192) return deny("INVALID_CURSOR");
      cursor = referenceCursor.parse(JSON.parse(decodeURIComponent(args.cursor)));
    } catch {
      return deny("INVALID_CURSOR");
    }
    if (
      cursor.dataset !== args.dataset ||
      cursor.date !== args.date ||
      cursor.q !== q ||
      (args.version && cursor.version !== args.version) ||
      args.code !== undefined
    )
      return deny("INVALID_CURSOR");
  }
  const requestedVersion = cursor?.version ?? args.version;
  let version: Doc<"referenceVersions"> | null;
  if (requestedVersion) {
    version = await ctx.db
      .query("referenceVersions")
      .withIndex("by_dataset_and_version", (i) =>
        i.eq("dataset", args.dataset).eq("version", requestedVersion),
      )
      .unique();
    if (!version || version.state !== "ready" || version.publishedAt === null)
      return deny("REFERENCE_VERSION_UNAVAILABLE");
  } else {
    const active = await ctx.db
      .query("referenceActive")
      .withIndex("by_dataset", (i) => i.eq("dataset", args.dataset))
      .unique();
    version = active ? await ctx.db.get("referenceVersions", active.versionId) : null;
    if (!version || version.state !== "ready" || version.publishedAt === null)
      return deny("REFERENCE_UNAVAILABLE");
  }
  const manifest = referenceManifest.parse(JSON.parse(version.manifest));
  const base = { manifest, date: args.date };
  if (args.code !== undefined) {
    const row = await ctx.db
      .query("referenceEntries")
      .withIndex("by_versionId_and_code", (i) =>
        i.eq("versionId", version._id).eq("code", args.code!),
      )
      .unique();
    const found = row ? entry(row) : null;
    return {
      ...base,
      status: found ? referenceValidity(found, manifest, args.date) : ("not_found" as const),
      entry: found,
    };
  }
  const byCode = /^\d*$/.test(q),
    prefix = q;
  if (cursor && (!cursor.after.startsWith(prefix) || !cursor.after)) return deny("INVALID_CURSOR");
  const after = cursor?.after;
  const rows = byCode
    ? await ctx.db
        .query("referenceEntries")
        .withIndex("by_versionId_and_code", (i) => {
          const index = i.eq("versionId", version._id);
          return (after ? index.gt("code", after) : index.gte("code", prefix)).lt(
            "code",
            prefix + "\uffff",
          );
        })
        .take((args.limit ?? 20) + 1)
    : await ctx.db
        .query("referenceEntries")
        .withIndex("by_versionId_and_nameKey", (i) => {
          const index = i.eq("versionId", version._id);
          return (after ? index.gt("nameKey", after) : index.gte("nameKey", prefix)).lt(
            "nameKey",
            prefix + "\uffff",
          );
        })
        .take((args.limit ?? 20) + 1);
  const page = rows.slice(0, args.limit ?? 20),
    last = page.at(-1);
  return {
    ...base,
    page: page.map((row) => ({
      ...entry(row),
      status: referenceValidity(row, manifest, args.date),
    })),
    nextCursor:
      rows.length > page.length && last
        ? encodeURIComponent(
            JSON.stringify({
              version: manifest.version,
              dataset: args.dataset,
              date: args.date,
              q,
              after: byCode ? last.code : last.nameKey,
            }),
          )
        : null,
  };
}
