import { expect, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import { internal } from "../../platform/convex/_generated/api";
import { hashApiKey } from "../../platform/convex/lib/apiKeyCrypto";
import { parseDistribution } from "../../packages/fiscal-nfe/src/distribution";
import type { Claim } from "../../platform/convex/lib/operationCore";
import type { Doc, Id } from "../../platform/convex/_generated/dataModel";
import { platformTest, person } from "./platform";

/**
 * Fixtures of the NF-e distribution capture suites (platform/convex/captures*.test.ts): a
 * synthetic company with people and keys, the steps of one capture (claim, raw answer, delivery,
 * batch description, persistence), the expiry of a lease and the move of a stream to another
 * project. Each test file mocks `./buildInfo` and sets the environment and the clock itself.
 */
export const setup = () => platformTest();
/** A signed-in member of `role` (`person`), with its membership. */
export async function human(
  t: ReturnType<typeof setup>,
  organizationId: Id<"organizations">,
  role: "owner" | "admin" | "operator" | "developer" | "viewer",
) {
  const client = await person(t, organizationId, role);
  return { membershipId: client.membershipId, client };
}

export async function fixture(t = setup()) {
  const secret = `fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`,
    keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  await t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", scope.keyId))!;
    const scopes = [...key.scopes, "connections:read", "documents:read"] as const;
    await ctx.db.patch("apiKeys", key._id, {
      scopes: [...scopes],
      expiresAt: Date.now() + 10 * 86400_000,
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { scopes: [...scopes] });
    await ctx.db.patch("companies", scope.companyId, { kind: "declared" });
    const id = await ctx.db.insert("certificates", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      version: 1,
      state: "active",
      uploaderId: "proof",
      membershipId: key.creatorMembershipId,
      membershipVersion: 1,
      metadata: {
        fingerprint: "synthetic",
        subject: "test",
        cnpj: "00000000000191",
        notBefore: Date.now() - 1000,
        notAfter: Date.now() + 30 * 86400_000,
      },
      envelope: {
        format: 1,
        keyVersion: "synthetic",
        pfx: new ArrayBuffer(0),
        password: new ArrayBuffer(0),
        wrappedKey: new ArrayBuffer(0),
      },
      envelopeRevision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("certificateHeads", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      nextVersion: 2,
      activeId: id,
      latestId: id,
    });
  });
  const args = { keyHash, environment: "sandbox", companyId: scope.companyId };
  const command = async (
    action?: "activate" | "sync" | "pause" | "resume",
    expectedVersion?: number,
  ) =>
    JSON.parse(
      await t.mutation(internal.captureRest.dispatch, {
        ...args,
        ...(action ? { action } : {}),
        ...(expectedVersion ? { expectedVersion } : {}),
      }),
    ) as {
      id: Doc<"captureStreams">["_id"];
      version: number;
      operationId: Doc<"operations">["_id"];
      nextAllowedAt: number;
      checkpoint: string;
      state: string;
    };
  return { t, scope, args, secret, command };
}
export async function claim(f: Awaited<ReturnType<typeof fixture>>) {
  const view = await f.command();
  const op = (await f.t.run((ctx) => ctx.db.get("operations", view.operationId)))!;
  vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
  const claimed = (await f.t.mutation(internal.operations.claim, {
    operationId: op._id,
    generation: op.generation,
  }))!;
  const token = { operationId: op._id, generation: claimed.generation, fence: claimed.fence };
  await f.t.mutation(internal.operations.beginEffect, token);
  return token;
}
export async function raw(f: Awaited<ReturnType<typeof fixture>>, token: Claim, bytes: Buffer) {
  const input = (await f.t.mutation(internal.captureProcessing.prepare, token))!;
  const rawId = await f.t.run((ctx) => ctx.storage.store(new Blob([Uint8Array.from(bytes)])));
  const batchId = (await f.t.mutation(internal.captureProcessing.raw, {
    ...token,
    rawId,
    rawHash: createHash("sha256").update(bytes).digest("hex"),
    nsu: input.nsu,
    mode: input.mode,
  }))!;
  return batchId;
}
/** Delivers the envelope at `position` of `bytes` to the batch, with its own stored file. */
export async function deliver(
  f: Awaited<ReturnType<typeof fixture>>,
  token: Claim,
  batchId: Id<"captureBatches">,
  bytes: Buffer,
  position: number,
) {
  const e = parseDistribution(bytes, "sandbox").envelopes[position]!;
  const storageId = await f.t.run((ctx) => ctx.storage.store(new Blob([Uint8Array.from(e.xml)])));
  const saved = await f.t.mutation(internal.captureProcessing.envelope, {
    ...token,
    batchId,
    position,
    nsu: e.nsu,
    schema: e.schema,
    sha256: e.sha256,
    size: e.xml.length,
    storageId,
  });
  return { saved, storageId };
}
export async function describeBatch(
  f: Awaited<ReturnType<typeof fixture>>,
  token: Claim,
  batchId: Id<"captureBatches">,
  bytes: Buffer,
) {
  const parsed = parseDistribution(bytes, "sandbox");
  return f.t.mutation(internal.captureProcessing.describe, {
    ...token,
    batchId,
    status: parsed.status,
    lastNsu: parsed.lastNsu,
    maxNsu: parsed.maxNsu,
    count: parsed.envelopes.length,
  });
}
export async function persist(f: Awaited<ReturnType<typeof fixture>>, token: Claim, bytes: Buffer) {
  const batchId = await raw(f, token, bytes);
  await describeBatch(f, token, batchId, bytes);
  const count = parseDistribution(bytes, "sandbox").envelopes.length;
  for (let position = 0; position < count; position++)
    expect((await deliver(f, token, batchId, bytes, position)).saved).toBe(true);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "success", response: "{}" },
  });
  return batchId;
}
/** The lease ends; the recovered operation runs again through the real worker. */
export async function expireAndRerun(f: Awaited<ReturnType<typeof fixture>>, token: Claim) {
  vi.setSystemTime(Date.now() + 60_001);
  await f.t.mutation(internal.operations.recoverOne, { operationId: token.operationId });
  const op = (await f.t.run((ctx) => ctx.db.get("operations", token.operationId)))!;
  vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
  await f.t.action(internal.operationWorker.run, {
    operationId: op._id,
    generation: op.generation,
  });
}

/** Hands the company's stream (and its current operation) to another project, as a fixture. */
export async function moveStream(
  f: Awaited<ReturnType<typeof fixture>>,
  projectId: Id<"projects">,
) {
  await f.t.run(async (ctx) => {
    const stream = (await ctx.db
      .query("captureStreams")
      .withIndex("by_companyId_environment", (q) =>
        q.eq("companyId", f.scope.companyId).eq("environment", "sandbox"),
      )
      .unique())!;
    await ctx.db.patch("captureStreams", stream._id, { projectId });
    if (stream.operationId) await ctx.db.patch("operations", stream.operationId, { projectId });
  });
}
