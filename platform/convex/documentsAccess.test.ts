import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import { routes, errorResponse } from "../../packages/contracts/src/external";
import { actor, fixture, documentsFixture } from "../../tests/helpers/documents";

/** Who reads documents: scopes, revoked keys, members and grants, and the sandbox capabilities. */
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5190",
    CONVEX_SITE_URL: "http://127.0.0.1:3239",
    BETTER_AUTH_SECRET: "synthetic-import-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("requires documents:read independently of import rights and rejects revoked keys after warm reads", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const detail = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:import"] }));
  expect((await f.get()).status).toBe(403);
  expect((await f.get(`/v1/document-artifacts/${detail.version.artifactId}/original`)).status).toBe(
    403,
  );
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:read"] }));
  expect((await f.get()).status).toBe(200);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect((await f.get()).status).toBe(401);
  expect((await f.get(`/v1/document-artifacts/${detail.version.artifactId}/original`)).status).toBe(
    401,
  );
});
it.each(["key", "grant"] as const)(
  "revoking %s denies the warmed import-to-document journey, including outstanding upload tickets",
  async (revocation) => {
    const f = await documentsFixture(),
      imported = await f.importXml(),
      pending = await f.reserve(f.bytes, "pending");
    const filePath = `/v1/imports/${imported.batch.importId}/files/${imported.batch.fileIds[0]}`;
    const paths = [
      `/v1/imports/${imported.batch.importId}`,
      `${filePath}/history`,
      `/v1/documents?companyId=${f.scope.companyId}`,
      ...["", "/items", "/versions", "/events"].map(
        (suffix) =>
          `/v1/documents/${imported.file.documentId}${suffix}?companyId=${f.scope.companyId}${suffix === "/items" ? `&versionId=${imported.file.versionId}` : ""}`,
      ),
      `/v1/document-artifacts/${imported.version.artifactId}/original?companyId=${f.scope.companyId}`,
    ];
    for (const path of paths) expect((await f.request(path, "GET")).status, path).toBe(200);
    const uploadPath = `/v1/imports/${pending.importId}/files/${pending.fileIds[0]}/upload`;
    const ticket = (await (await f.request(uploadPath)).json()).data;
    await f.t.run(async (ctx) => {
      if (revocation === "key")
        await ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() });
      else {
        const grant = (await ctx.db
          .query("projectCompanies")
          .withIndex("by_projectId_and_companyId", (q) =>
            q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
          )
          .unique())!;
        await ctx.db.patch("projectCompanies", grant._id, { active: false });
      }
    });
    const status = revocation === "key" ? 401 : 404;
    for (const path of paths) {
      const response = await f.request(path, "GET");
      expect(response.status, path).toBe(status);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
    }
    for (const path of [uploadPath, `${filePath}/confirm`, `${filePath}/reprocess`])
      expect((await f.request(path)).status, path).toBe(status);
    const response = await f.t.fetch("/v1/import-upload", {
      method: "POST",
      headers: { "X-Upload-Token": ticket.token },
      body: new Uint8Array(f.bytes),
    });
    expect(response.status).toBe(status);
    expect((await f.t.run((ctx) => ctx.db.get("importFiles", pending.fileIds[0]!)))!.state).toBe(
      "reserved",
    );
  },
);

it.each(["member", "company"] as const)(
  "revoking %s denies human history, items, resume and previously issued download tickets",
  async (revocation) => {
    const f = await documentsFixture(),
      imported = await f.importXml();
    // An operator reaches the company through its own grant, never the integration's.
    const owner = await actor(f.t, f.scope.organizationId, "operator");
    const companyGrant = await f.t.run((ctx) =>
      ctx.db.insert("companyGrants", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        membershipId: owner.membershipId,
        membershipEpoch: 0,
        active: true,
        version: 1,
        updatedAt: Date.now(),
      }),
    );
    const fileId = imported.batch.fileIds[0]!;
    const doc = { ...f.queryScope, documentId: imported.file.documentId! };
    const pagination = { cursor: null, limit: 10 };
    const reads = [
      () =>
        owner.client.query(api.imports.selected, {
          ...f.queryScope,
          batch: imported.batch.importId,
        }),
      () => owner.client.query(api.imports.recent, f.queryScope),
      () => owner.client.action(api.documentContentNode.importHistoryRead, { fileId }),
      () => owner.client.query(api.documents.list, { ...f.queryScope, ...pagination }),
      () => owner.client.action(api.documentContentNode.documentDetailRead, doc),
      () =>
        owner.client.action(api.documentContentNode.documentItemsRead, {
          ...doc,
          ...pagination,
          versionId: imported.file.versionId!,
        }),
      () =>
        owner.client.action(api.documentContentNode.documentVersionsRead, {
          ...doc,
          ...pagination,
        }),
    ];
    for (const read of reads) await expect(read()).resolves.toBeDefined();
    const downloadArgs = { ...f.queryScope, artifactId: imported.version.artifactId };
    const ticket = await owner.client.mutation(api.documentDownloads.ticket, downloadArgs);
    const download = () =>
      f.t.fetch("/v1/document-download", {
        headers: { Origin: "http://localhost:5190", "X-Download-Token": ticket.token },
      });
    expect((await download()).status).toBe(200);
    const pending = await f.reserve(f.bytes, "paused");
    await f.upload(pending);
    // The batch is the integration's: people read it but do not change it.
    await expect(
      owner.client.mutation(api.imports.confirm, { fileId: pending.fileIds[0]! }),
    ).rejects.toThrow("INTEGRATION_RECORD");
    const accepted = await f.confirm(pending);
    await expect(
      owner.client.mutation(api.operations.control, {
        operationId: accepted.operationId,
        action: "pause",
        expectedGeneration: 1,
      }),
    ).rejects.toThrow("INTEGRATION_RECORD");
    await expect(
      owner.client.query(api.operations.get, { operationId: accepted.operationId }),
    ).resolves.toMatchObject({ id: accepted.operationId });
    // The integration pauses its own operation through the API.
    expect(
      (
        await f.request(`/v1/operations/${accepted.operationId}/pause`, "POST", {
          expectedGeneration: 1,
        })
      ).status,
    ).toBe(200);
    const operation = (await f.t.run((ctx) => ctx.db.get("operations", accepted.operationId)))!;
    await f.t.run(async (ctx) => {
      if (revocation === "member")
        await ctx.db.patch("memberships", owner.membershipId, { state: "removed" });
      else await ctx.db.patch("companyGrants", companyGrant, { active: false, version: 2 });
    });
    for (const read of reads) await expect(read()).rejects.toThrow();
    await expect(owner.client.mutation(api.imports.confirm, { fileId })).rejects.toThrow();
    await expect(
      owner.client.mutation(api.importProcessing.reprocess, { fileId, key: "denied" }),
    ).rejects.toThrow();
    await expect(
      owner.client.mutation(api.operations.control, {
        operationId: operation._id,
        action: "retry",
        expectedGeneration: operation.generation,
      }),
    ).rejects.toThrow();
    await expect(
      owner.client.mutation(api.documentDownloads.ticket, downloadArgs),
    ).rejects.toThrow();
    expect((await download()).status).toBe(404);
    expect((await f.t.run((ctx) => ctx.db.get("operations", operation._id)))!.state).toBe("paused");
  },
);

it("revoking the integration's grant stops its key, not the people of the company", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const viewer = await actor(f.t, f.scope.organizationId, "viewer");
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: viewer.membershipId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  await f.t.run(async (ctx) => {
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { active: false });
  });
  expect((await f.get()).status).toBe(404);
  const doc = { ...f.queryScope, documentId: imported.file.documentId! };
  expect(
    (await viewer.client.action(api.documentContentNode.documentDetailRead, doc)).summary.id,
  ).toBe(doc.documentId);
  expect(
    (await viewer.client.query(api.documents.list, { ...f.queryScope, cursor: null, limit: 10 }))
      .page,
  ).toHaveLength(1);
  const ticket = await viewer.client.mutation(api.documentDownloads.ticket, {
    ...f.queryScope,
    artifactId: imported.version.artifactId,
  });
  const download = await f.t.fetch("/v1/document-download", {
    headers: { Origin: "http://localhost:5190", "X-Download-Token": ticket.token },
  });
  expect(download.status).toBe(200);
  // Reading is not writing: a viewer neither reprocesses nor rebuilds.
  await expect(
    viewer.client.mutation(api.documents.reprocess, { ...doc, key: "viewer" }),
  ).rejects.toThrow("SCOPE_DENIED");
  expect(await viewer.client.query(api.documents.canProcess, f.queryScope)).toBe(false);
  // A developer with access to the company reads through integrations, not the console.
  const developer = await actor(f.t, f.scope.organizationId, "owner");
  await f.t.run((ctx) =>
    ctx.db.patch("memberships", developer.membershipId, { role: "developer" }),
  );
  await expect(
    developer.client.action(api.documentContentNode.documentDetailRead, doc),
  ).rejects.toThrow("NOT_FOUND");
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: developer.membershipId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  await expect(
    developer.client.action(api.documentContentNode.documentDetailRead, doc),
  ).rejects.toThrow("SCOPE_DENIED");
  await expect(
    developer.client.mutation(api.documentDownloads.ticket, {
      ...f.queryScope,
      artifactId: imported.version.artifactId,
    }),
  ).rejects.toThrow("SCOPE_DENIED");
  // Another organization's member, or a login without membership, does not reach this company.
  const other = await documentsFixture(f.t);
  const outsider = await actor(other.t, other.scope.organizationId);
  await expect(
    outsider.client.action(api.documentContentNode.documentDetailRead, doc),
  ).rejects.toThrow("ACCESS_DENIED");
  await expect(
    outsider.client.action(api.documentContentNode.documentDetailRead, {
      ...doc,
      organizationId: other.scope.organizationId,
    }),
  ).rejects.toThrow("NOT_FOUND");
});

it("rejects a key that expires after a successful indexed page read", async () => {
  const f = await documentsFixture();
  await f.importXml();
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { expiresAt: Date.now() + 1000 }));
  expect((await f.get()).status).toBe(200);
  vi.setSystemTime(Date.now() + 1001);
  const response = await f.get();
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe("INVALID_API_KEY");
});

it("keeps capabilities restricted to the sandbox validation environment", async () => {
  const f = await fixture();
  const sandbox = await f.request("/v1/capabilities", "GET");
  expect(sandbox.status).toBe(200);
  expect(routes.getCapabilities.output.parse(await sandbox.json()).data.environment).toBe(
    "sandbox",
  );
  await expect(
    f.t.query(internal.capabilityRest.authorize, {
      keyHash: f.keyHash,
      environment: "production",
    }),
  ).rejects.toThrow("ENVIRONMENT_DENIED");
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { environment: "production" }));
  vi.stubEnv("PRODUCT_ENV", "production");
  await expect(
    f.t.query(internal.capabilityRest.authorize, {
      keyHash: f.keyHash,
      environment: "production",
    }),
  ).rejects.toThrow("Invalid platform configuration: PRODUCT_ENV");
  const denied = await f.request("/v1/capabilities", "GET");
  expect(denied.status).toBe(503);
  expect(errorResponse.parse(await denied.json()).error.code).toBe("UNAVAILABLE");
});
