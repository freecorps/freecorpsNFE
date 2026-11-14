import { expect, vi } from "vite-plus/test";
import { api, internal } from "../../platform/convex/_generated/api";
import type { Id } from "../../platform/convex/_generated/dataModel";
import { person } from "./platform";
import { distributionXml } from "./distribution";
import { CNPJ, siteFixture, respond, streamOf } from "./siteCapture";

/** Builders of the production capture continuity suites: the console start, cycles and A1 renewal. */
export type Fixture = Awaited<ReturnType<typeof siteFixture>>;
export const ATTENTION = "connection.attention_required";
export const attentionEvents = (f: Fixture) =>
  f.t.run(async (ctx) =>
    (await ctx.db.query("outboxEvents").collect()).filter((event) => event.type === ATTENTION),
  );
export const opOf = (f: Fixture, id: Id<"operations">) =>
  f.t.run(async (ctx) => (await ctx.db.get("operations", id))!);
export const headOf = (f: Fixture) =>
  f.t.run(
    async (ctx) =>
      (await ctx.db
        .query("certificateHeads")
        .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
        .unique())!,
  );
/** The owner starts the company's production capture in the console. */
export async function consoleStart(f: Fixture) {
  const owner = await person(f.t, f.scope.organizationId, "owner");
  const view = await owner.mutation(api.captures.activate, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "production",
  });
  return { owner, streamId: view.id, operationId: view.operationId! };
}
/** One query answered with 137 and published: returns the next one the stream scheduled. */
export async function cycle(
  f: Fixture,
  streamId: Id<"captureStreams">,
  operationId: Id<"operations">,
) {
  const token = await f.claim(operationId);
  await respond(f, token, distributionXml({ status: "137", environment: "1" }));
  expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
  const stream = await streamOf(f, streamId);
  expect(stream.state).toBe("active");
  expect(stream.operationId).not.toBe(operationId);
  return stream.operationId!;
}
/** Claims the operation at its time; null when the claim refused it. */
export async function claimAt(f: Fixture, id: Id<"operations">) {
  const op = await opOf(f, id);
  vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
  const claimed = await f.t.mutation(internal.operations.claim, {
    operationId: id,
    generation: op.generation,
  });
  return claimed ? { operationId: id, generation: claimed.generation, fence: claimed.fence } : null;
}
/** The company renews its A1: a new certificate with `cnpj` becomes the active one. */
export const renew = (f: Fixture, cnpj = CNPJ) =>
  f.t.run(async (ctx) => {
    const head = (await ctx.db
      .query("certificateHeads")
      .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
      .unique())!;
    const old = (await ctx.db.get("certificates", head.activeId!))!;
    const { _id, _creationTime, ...copy } = old;
    const id = await ctx.db.insert("certificates", {
      ...copy,
      version: head.nextVersion,
      metadata: {
        ...old.metadata!,
        fingerprint: "d".repeat(64),
        cnpj,
        notAfter: Date.now() + 365 * 86400_000,
      },
    });
    await ctx.db.patch("certificates", old._id, { state: "replaced" });
    await ctx.db.patch("certificateHeads", head._id, {
      activeId: id,
      latestId: id,
      nextVersion: head.nextVersion + 1,
    });
    return id;
  });
/** The stream's automatic resumption the server scheduled, if any. */
export const scheduledResume = (f: Fixture) =>
  f.t.run(async (ctx) => {
    const rows = await ctx.db.system.query("_scheduled_functions").collect();
    const row = rows
      .filter((r) => r.name.includes("resumeEligible") && r.state.kind === "pending")
      .at(-1);
    return row
      ? {
          args: row.args[0] as { streamId: Id<"captureStreams">; version: number },
          at: row.scheduledTime,
        }
      : null;
  });
