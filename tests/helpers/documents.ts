import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { expect } from "vite-plus/test";
import schema from "../../platform/convex/schema";
import { internal, components } from "../../platform/convex/_generated/api";
import { register } from "../../platform/test-setup";
import { hashApiKey } from "../../platform/convex/lib/apiKeyCrypto";
import { fixture as xmlFixture } from "./nfe-corpus";
import { processNfe } from "../../packages/fiscal-nfe/src/index";
import type { Id } from "../../platform/convex/_generated/dataModel";
import { modules } from "./convex-modules";

/**
 * Fixtures of the fiscal document suites: a database with the platform registered, people and keys
 * of an organization, and a company with imported NF-e documents.
 */
export function testDatabase() {
  return convexTest(schema, modules);
}
export async function actor(
  t: ReturnType<typeof testDatabase>,
  organizationId: Id<"organizations">,
  role: "owner" | "admin" | "operator" | "developer" | "viewer" = "owner",
) {
  const now = Date.now();
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Pessoa sintética",
        email: `${crypto.randomUUID()}@development.invalid`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await t.mutation(components.betterAuth.adapter.create, {
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
  const membershipId = await t.run((ctx) =>
    ctx.db.insert("memberships", {
      organizationId,
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
  return {
    client: t.withIdentity({
      subject: user._id,
      sessionId: session._id,
      issuer: "http://127.0.0.1:3239",
    }),
    membershipId,
  };
}

export async function fixture(database?: ReturnType<typeof testDatabase>) {
  const t = database ?? convexTest(schema, modules);
  if (!database) register(t);
  const secret = `fnfe_${crypto.randomUUID().replaceAll("-", "")}${"b".repeat(11)}`,
    keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  const bytes = xmlFixture("invoice-signed");
  const model = processNfe(bytes).normalized!.document;
  if (model.kind !== "invoice") throw new Error("Expected invoice");
  await t.run((ctx) => ctx.db.patch("companies", scope.companyId, { cnpj: model.issuer.document }));
  const headers = {
    Authorization: `Bearer ${secret}`,
    "X-Environment": "sandbox",
    "Content-Type": "application/json",
  };
  async function request(path: string, method = "POST", body?: unknown, key = "first") {
    return t.fetch(path, {
      method,
      headers: { ...headers, "Idempotency-Key": key },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  }
  async function reserve(data = bytes, key = "first") {
    const response = await request(
      "/v1/imports",
      "POST",
      {
        companyId: scope.companyId,
        files: [
          {
            name: "nota.xml",
            size: data.length,
            sha256: createHash("sha256").update(data).digest("hex"),
          },
        ],
      },
      key,
    );
    expect(response.status).toBe(200);
    return (await response.json()).data as {
      importId: Id<"imports">;
      fileIds: Id<"importFiles">[];
      reused: boolean;
    };
  }
  async function upload(batch: Awaited<ReturnType<typeof reserve>>, data = bytes) {
    const response = await request(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/upload`,
    );
    expect(response.status).toBe(200);
    const ticket = (await response.json()).data as { token: string };
    return t.fetch("/v1/import-upload", {
      method: "POST",
      headers: { "X-Upload-Token": ticket.token },
      body: new Uint8Array(data),
    });
  }
  async function confirm(batch: Awaited<ReturnType<typeof reserve>>) {
    const response = await request(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/confirm`,
    );
    expect(response.status).toBe(200);
    return (await response.json()).data as { operationId: Id<"operations">; reused: boolean };
  }
  async function result(batch: Awaited<ReturnType<typeof reserve>>) {
    const response = await request(`/v1/imports/${batch.importId}`, "GET");
    expect(response.status).toBe(200);
    return (await response.json()).data as {
      files: Array<{
        code: string;
        state: string;
        result: string | null;
        documentId: string | null;
        versionId: string | null;
      }>;
    };
  }
  return { t, scope, bytes, request, reserve, upload, confirm, result, keyHash, secret };
}
export async function documentsFixture(database?: ReturnType<typeof testDatabase>) {
  const f = await fixture(database);
  await f.t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    await ctx.db.patch("apiKeys", key._id, { scopes: [...key.scopes, "documents:read"] });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: [...grant.scopes, "documents:read"],
    });
  });
  async function importXml(bytes = f.bytes) {
    const batch = await f.reserve(bytes, crypto.randomUUID());
    expect((await f.upload(batch, bytes)).status).toBe(200);
    const operation = await f.confirm(batch);
    await f.t.action(internal.operationWorker.run, {
      operationId: operation.operationId,
      generation: 1,
    });
    const file = (await f.result(batch)).files[0]!;
    const version = await f.t.run((ctx) =>
      ctx.db.get("documentVersions", file.versionId as Id<"documentVersions">),
    );
    if (file.documentId) await rebuild(file.documentId);
    return { batch, file, version: version! };
  }
  async function rebuild(documentId: string) {
    const doc = (await f.t.run((ctx) =>
      ctx.db.get("fiscalDocuments", documentId as Id<"fiscalDocuments">),
    ))!;
    await f.t.action(internal.documentProjectionWorker.rebuild, {
      documentId: doc._id,
      generation: doc.projectionGeneration!,
    });
  }
  async function get(path = "/v1/documents", extra = "") {
    return f.request(`${path}?companyId=${f.scope.companyId}${extra}`, "GET");
  }
  return {
    ...f,
    importXml,
    get,
    rebuild,
    // The console reads the company: no project.
    queryScope: {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox" as const,
    },
  };
}
