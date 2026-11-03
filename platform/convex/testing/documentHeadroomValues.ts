import { v, type Infer } from "convex/values";
import { readStoredContent, type ContentStorage } from "../lib/documentContentRead";

export const headroomShape = v.union(v.literal("wide"), v.literal("many"));
export const headroomRef = v.object({
  storageId: v.id("_storage"),
  contentSha256: v.string(),
  contentSize: v.number(),
  format: v.string(),
  storedSize: v.number(),
  items: v.number(),
});

/**
 * The heaviest reader of phase B, modelled: the whole blob through `readStoredContent` (gzip,
 * hash, canonical check), then every item parsed and the projection serialized, as an export does.
 * Detail and `/items` hold less: the result and one page of at most 25 items.
 */
export async function headroomRead(
  storage: ContentStorage,
  ref: Infer<typeof headroomRef>,
  runtime: Record<string, unknown>,
) {
  const started = Date.now();
  const content = await readStoredContent(storage, ref.storageId, ref, ref.contentSize);
  const projected = {
    result: JSON.parse(content.result) as unknown,
    items: content.items.map((item) => JSON.parse(item) as unknown),
  };
  const output = JSON.stringify(projected).length;
  if (projected.items.length !== ref.items) throw new Error("HEADROOM_ITEMS");
  return {
    contentSize: ref.contentSize,
    items: ref.items,
    output,
    ms: Date.now() - started,
    runtime,
  };
}
