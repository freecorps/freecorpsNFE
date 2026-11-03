import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getFile } from "./lib/importCore";
import { contentNeed, type ContentPlan } from "./lib/documentContentPlan";
import type { HistoryRow } from "./lib/documentRender";
/** The last ten published versions of a file, each `result` from its content (ADR 0010, B5). */
export async function historyPlan(
  ctx: QueryCtx,
  fileId: Id<"importFiles">,
  keyHash?: string,
): Promise<ContentPlan<HistoryRow[]>> {
  await getFile(ctx, fileId, keyHash, false);
  const artifact = await ctx.db
    .query("documentArtifacts")
    .withIndex("by_fileId", (q) => q.eq("fileId", fileId))
    .unique();
  if (!artifact) return { renderer: "history", data: [], needs: [] };
  const versions = await ctx.db
    .query("documentVersions")
    .withIndex("by_artifactId_and_publishedAt", (q) =>
      q.eq("artifactId", artifact._id).gt("publishedAt", 0),
    )
    .order("desc")
    .take(10);
  const data: HistoryRow[] = [];
  const needs = [];
  for (const version of versions) {
    const operation = await ctx.db.get("operations", version.operationId);
    if (version.state !== "complete" || operation?.state !== "succeeded") continue;
    needs.push(await contentNeed(ctx, `v${data.length}`, version, { result: true }));
    data.push({
      id: version._id,
      processorVersion: version.processorVersion,
      completedAt: version.completedAt!,
      code: version.code,
    });
  }
  return { renderer: "history", data, needs };
}
