/// <reference types="vite/client" />
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { expect } from "vite-plus/test";
import schema from "../../platform/convex/schema";
import { internal, components } from "../../platform/convex/_generated/api";
import type { Id } from "../../platform/convex/_generated/dataModel";
import { register } from "../../platform/test-setup";
import { fixture as xmlFixture } from "./nfe-corpus";
import { processNfe } from "../../packages/fiscal-nfe/src/index";
import { hashApiKey } from "../../platform/convex/lib/apiKeyCrypto";
const modules = import.meta.glob("../../platform/convex/**/*.ts");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function fixture(overrides: typeof modules = {}) {
  const t = convexTest(schema, { ...modules, ...overrides });
  register(t);
  const secret = `fnfe_${"a".repeat(43)}`,
    keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  const bytes = xmlFixture("invoice-authorized");
  const model = processNfe(bytes).normalized!.document;
  if (model.kind !== "invoice") throw new Error();
  await t.run(async (ctx) => {
    await ctx.db.patch("companies", scope.companyId, { cnpj: model.issuer.document });
    const scopes = ["documents:read", "documents:import"] as const;
    await ctx.db.patch("apiKeys", scope.keyId, {
      scopes: [...scopes],
      expiresAt: Date.now() + 7 * 86_400_000,
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { scopes: [...scopes] });
  });
  const request = (path: string, method = "GET", body?: unknown, key = "export-test-1") =>
    t.fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        "X-Environment": "sandbox",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  const batchResponse = await request("/v1/imports", "POST", {
    companyId: scope.companyId,
    files: [{ name: "nota.xml", size: bytes.length, sha256: hash(bytes) }],
  });
  expect(batchResponse.status).toBe(200);
  const batch = (await batchResponse.json()).data;
  const upload = (
    await (
      await request(`/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/upload`, "POST")
    ).json()
  ).data;
  expect(
    (
      await t.fetch("/v1/import-upload", {
        method: "POST",
        headers: { "X-Upload-Token": upload.token },
        body: new Uint8Array(bytes),
      })
    ).status,
  ).toBe(200);
  const operation = (
    await (
      await request(`/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/confirm`, "POST")
    ).json()
  ).data;
  await t.action(internal.operationWorker.run, {
    operationId: operation.operationId,
    generation: 1,
  });
  const result = (await (await request(`/v1/imports/${batch.importId}`)).json()).data.files[0];
  const documentId = result.documentId as Id<"fiscalDocuments">;
  expect(documentId).toBeTruthy();
  const create = async (key = "export-test-1") => {
    const response = await request(
      "/v1/exports",
      "POST",
      { companyId: scope.companyId, documentId },
      key,
    );
    expect(response.status).toBe(200);
    return (await response.json()).data as { id: Id<"documentExports"> };
  };
  const finish = async (id: Id<"documentExports">) => {
    for (let n = 0; n < 30; n++) {
      const job = (await t.run((ctx) => ctx.db.get("documentExports", id)))!;
      if (job.state !== "running") return job;
      await t.action(internal.exportWorker.run, { exportId: id, sequence: job.sequence });
    }
    throw new Error("Export did not terminate");
  };
  const download = (token: string) =>
    t.fetch("/v1/export-download", { headers: { "X-Download-Token": token } });
  const part = async (id: Id<"documentExports">) =>
    (await (await request(`/v1/exports/${id}/parts`)).json()).data.page[0] as {
      id: Id<"exportParts">;
      sha256: string;
      sequence: number;
    };
  const ticket = async (id: Id<"exportParts">) =>
    (await (await request(`/v1/export-parts/${id}/ticket`, "POST")).json()).data.token as string;
  return { t, scope, request, create, finish, download, part, ticket, bytes, documentId };
}
export async function actor(
  f: Awaited<ReturnType<typeof fixture>>,
  role: "owner" | "viewer" | "developer" = "owner",
) {
  const now = Date.now();
  const user = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Teste",
        email: `${crypto.randomUUID()}@development.invalid`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        expiresAt: now + 3600_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const membershipId = await f.t.run((ctx) =>
    ctx.db.insert("memberships", {
      organizationId: f.scope.organizationId,
      authUserId: user._id,
      name: user.name,
      email: user.email,
      role,
      state: "active",
      version: 1,
      joinedAt: now,
      updatedAt: now,
    }),
  );
  return { membershipId, client: f.t.withIdentity({ subject: user._id, sessionId: session._id }) };
}
