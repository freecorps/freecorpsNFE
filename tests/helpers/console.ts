import type { TestConvex } from "convex-test";
import type { Id } from "../../platform/convex/_generated/dataModel";
import type schema from "../../platform/convex/schema";

/**
 * The organization's console project, as `ensureConsoleProject` creates it on the first console
 * write: tests that drive the internal helpers as a person use it as the scope's project.
 */
export async function consoleProjectFor(
  t: TestConvex<typeof schema>,
  organizationId: Id<"organizations">,
): Promise<Id<"projects">> {
  return t.run(async (ctx) => {
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_organizationId_and_kind", (q) =>
        q.eq("organizationId", organizationId).eq("kind", "console"),
      )
      .first();
    if (existing) return existing._id;
    const member = await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_authUserId", (q) => q.eq("organizationId", organizationId))
      .first();
    return ctx.db.insert("projects", {
      organizationId,
      name: "Console",
      externalReference: "",
      kind: "console",
      state: "active",
      version: 1,
      accessEpoch: 0,
      creatorMembershipId: member!._id,
      creatorEpoch: 0,
      createdAt: Date.now(),
    });
  });
}
