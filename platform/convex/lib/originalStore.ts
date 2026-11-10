import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { trackDatabaseRecord } from "./capacityCore";
import { originalSourceOf } from "./documentOriginalRead";
import type { OriginalSource } from "./documentValues";
import { storageHash } from "./importValues";
import { deny } from "./organizationAccess";

/**
 * The only writer of the XML originals' rows (`documentArtifacts`, #110). `sha256` and `size`
 * are the guard's proof of the original, so they are written once, here, against the stored
 * file, and change only when the original moves to the cold tier with the hash it keeps.
 * `capacityCore.insertFiscal` and `patchFiscal` refuse the table in their type. The ADR 0009
 * rehydration restores the rows as the verified package holds them, and the download checks the
 * stored file against the row anyway (`servedOriginal`).
 *
 * The rows count as database stock without enforcement: a refused write would lose an original
 * already admitted (`capacityCore.trackDatabaseRecord`).
 */
type Artifact = Doc<"documentArtifacts">;

/** Whether `_storage` holds exactly the bytes the row describes: Convex hashes in base64. */
async function storedAs(
  ctx: Pick<QueryCtx, "db">,
  storageId: Id<"_storage">,
  sha256: string,
  size: number,
) {
  const meta = await ctx.db.system.get("_storage", storageId);
  return !!meta && meta.size === size && storageHash(meta.sha256) === sha256;
}

/**
 * Records a new hot original; its `sha256` and `size` must be those of the stored file. A hot
 * row carries none of the cold object's fields, which only `moveOriginalCold` writes.
 */
export async function insertOriginal(
  ctx: MutationCtx,
  value: WithoutSystemFields<Artifact> & { storageId: Id<"_storage"> },
) {
  if (
    value.objectKey !== undefined ||
    value.objectSha256 !== undefined ||
    value.objectSize !== undefined ||
    !(await storedAs(ctx, value.storageId, value.sha256, value.size))
  )
    return deny("INVALID_FILE");
  const id = await ctx.db.insert("documentArtifacts", value);
  await track(ctx, id);
  return id;
}

/** What may change on an original's row without touching the original itself. */
export type OriginalLinks = Partial<
  Pick<Artifact, "documentId" | "nfseBatch" | "processingOperationId" | "tpAmb">
>;
export async function linkOriginal(
  ctx: MutationCtx,
  id: Id<"documentArtifacts">,
  links: OriginalLinks,
) {
  const { documentId, nfseBatch, processingOperationId, tpAmb } = links;
  await ctx.db.patch("documentArtifacts", id, {
    ...("documentId" in links ? { documentId } : {}),
    ...("nfseBatch" in links ? { nfseBatch } : {}),
    ...("processingOperationId" in links ? { processingOperationId } : {}),
    ...("tpAmb" in links ? { tpAmb } : {}),
  });
  await track(ctx, id);
}

/**
 * Points the row at the original's cold object (ADR 0010, decision 8). The raw XML keeps its
 * `sha256` and `size`; the caller has checked the object against them.
 */
export async function moveOriginalCold(
  ctx: MutationCtx,
  id: Id<"documentArtifacts">,
  cold: { objectKey: string; objectSha256: string; objectSize: number },
  restoringInventory: boolean,
) {
  await ctx.db.patch("documentArtifacts", id, {
    storageId: undefined,
    objectKey: cold.objectKey,
    objectSha256: cold.objectSha256,
    objectSize: cold.objectSize,
  });
  await track(ctx, id, restoringInventory);
}

async function track(ctx: MutationCtx, id: Id<"documentArtifacts">, restoringInventory = false) {
  const record = (await ctx.db.get("documentArtifacts", id))!;
  await trackDatabaseRecord(
    ctx,
    record.organizationId,
    "documentArtifacts",
    id,
    record,
    false,
    restoringInventory,
  );
}

/**
 * The original a download serves. A hot file whose `_storage` hash or size differs from the row
 * is refused with `ORIGINAL_UNAVAILABLE`, as a damaged cold object is (`decodeOriginal`): the
 * download never hands out bytes the recorded hash does not describe.
 */
export async function servedOriginal(
  ctx: Pick<QueryCtx, "db">,
  artifact: Artifact,
): Promise<OriginalSource> {
  const source = originalSourceOf(artifact);
  if (!source) return deny("ORIGINAL_UNAVAILABLE");
  if ("storageId" in source && !(await storedAs(ctx, source.storageId, source.sha256, source.size)))
    return deny("ORIGINAL_UNAVAILABLE");
  return source;
}
