import { getFunctionName } from "convex/server";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import schema from "./schema";
import { api, internal, components } from "./_generated/api";
import { register } from "../test-setup";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { fixture, actor } from "../../tests/helpers/export-fixture";
import { runExport } from "./exportWorker";
import { readBatch } from "./exportSource";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import { keepInline, writeContent } from "../../tests/helpers/document-footprint";
import { modules } from "../../tests/helpers/convex-modules";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5201",
    CONVEX_SITE_URL: "http://127.0.0.1:3261",
    BETTER_AUTH_SECRET: "synthetic-export-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
it("exports exact originals, versions and items with hashes; retries reuse the same operation", async () => {
  const f = await fixture(),
    job = await f.create();
  expect((await f.create()).id).toBe(job.id);
  expect((await f.finish(job.id)).state).toBe("succeeded");
  await f.t.action(internal.exportWorker.run, { exportId: job.id, sequence: 0 });
  const part = await f.part(job.id),
    response = await f.download(await f.ticket(part.id));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const zipped = new Uint8Array(await response.arrayBuffer());
  expect(hash(zipped)).toBe(part.sha256);
  const text = gunzipSync(zipped).toString();
  const rows = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.find((row) => row.type === "original").content).toBe(
    Buffer.from(f.bytes).toString("base64"),
  );
  expect(rows.some((row) => row.type === "item")).toBe(true);
  const exported = rows.find((row) => row.type === "version").payload;
  expect(exported.kind).toBe("invoice");
  // The export reads the same projection as the API: both totals and the purpose (#396, #397).
  expect(exported.declaredTotals).toEqual({ vNF: exported.total, vNFTot: null });
  expect(exported.purpose).toMatchObject({ code: "1", label: "NF-e normal" });
  expect(rows.at(-1)).toEqual({ type: "part-end", final: true });
  expect(text).not.toMatch(
    /storageId|keyHash|tokenHash|wrappedKey|password|envelope|_creationTime/,
  );
});
it("download de exportação compartilha o limite REST da chave e preserva a revogação", async () => {
  const f = await fixture(),
    job = await f.create();
  await f.finish(job.id);
  const part = await f.part(job.id);
  const token = await f.ticket(part.id);
  expect((await f.download(token)).status).toBe(200);
  // Saturate with cheap REST reads; the previously issued ticket cannot bypass that budget.
  for (let i = 0; i < 60; i++) await f.request(`/v1/exports/${job.id}`);
  const before = await f.t.run((ctx) => ctx.db.query("operationalAudit").collect());
  for (let i = 0; i < 20; i++) {
    const result = await f.download(token);
    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("1");
  }
  expect(await f.t.run((ctx) => ctx.db.query("operationalAudit").collect())).toEqual(before);
  vi.setSystemTime(Date.now() + 1000);
  expect((await f.download(token)).status).toBe(200);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect((await f.download(token)).status).toBe(401);
});
it("revoked key invalidates warmed metadata and already issued download tickets", async () => {
  const f = await fixture(),
    job = await f.create();
  await f.finish(job.id);
  const token = await f.ticket((await f.part(job.id)).id);
  expect((await f.download(token)).status).toBe(200);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect((await f.download(token)).status).toBe(401);
  expect((await f.request(`/v1/exports/${job.id}`)).status).toBe(401);
});
it("rejects malformed JSON and pagination at the HTTP boundary with a non-retryable 400", async () => {
  const f = await fixture(),
    job = await f.create("!");
  expect((await f.create("!")).id).toBe(job.id);
  await f.finish(job.id);
  for (const query of [
    "limit=NaN",
    "limit=0",
    "limit=-1",
    "limit=1000000",
    "limit=1&limit=2",
    "cursor=a&cursor=b",
    "unexpected=1",
    `cursor=${"a".repeat(8193)}`,
  ]) {
    const response = await f.request(`/v1/exports/${job.id}/parts?${query}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({
      code: "INVALID_REQUEST",
      retryable: false,
    });
  }
  const response = await f.t.fetch("/v1/exports", {
    method: "POST",
    headers: {
      Authorization: `Bearer fnfe_${"a".repeat(43)}`,
      "X-Environment": "sandbox",
      "Content-Type": "application/json",
      "Idempotency-Key": "malformed-json",
    },
    body: "{",
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toMatchObject({
    code: "INVALID_REQUEST",
    retryable: false,
  });
});
it("a document removed during preparation cannot produce an empty successful package", async () => {
  const f = await fixture(),
    job = await f.create();
  await f.t.run((ctx) => ctx.db.delete("fiscalDocuments", f.documentId));
  await expect(
    f.t.action(internal.exportWorker.run, { exportId: job.id, sequence: 0 }),
  ).rejects.toThrow();
  expect((await f.t.run((ctx) => ctx.db.get("documentExports", job.id)))?.state).not.toBe(
    "succeeded",
  );
  expect(
    await f.t.run((ctx) =>
      ctx.db
        .query("exportParts")
        .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job.id))
        .collect(),
    ),
  ).toEqual([]);
});
it("continues across batches without skipping items and replay cannot delete an accepted part", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    const item = (await ctx.db.query("documentItems").first())!;
    for (let position = 1; position <= 1100; position++)
      await ctx.db.insert("documentItems", {
        versionId: item.versionId,
        position,
        data: item.data,
      });
    // The version's item count is authoritative for positional reads (ADR 0010, B5).
    await ctx.db.patch("documentVersions", item.versionId, { itemCount: 1101, writtenItems: 1101 });
  });
  const job = await f.create();
  expect((await f.finish(job.id)).state).toBe("succeeded");
  const parts = await f.t.run((ctx) =>
    ctx.db
      .query("exportParts")
      .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job.id))
      .collect(),
  );
  expect(parts.length).toBeGreaterThan(1);
  const rows: { type: string; final?: boolean }[] = [];
  for (const part of parts) {
    const response = await f.download(await f.ticket(part._id));
    expect(response.status).toBe(200);
    rows.push(
      ...gunzipSync(new Uint8Array(await response.arrayBuffer()))
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  }
  const total = await f.t.run(
    async (ctx) => (await ctx.db.query("documentItems").collect()).length,
  );
  expect(rows.filter((row) => row.type === "item")).toHaveLength(total);
  expect(rows.filter((row) => row.type === "part-end" && row.final)).toHaveLength(1);
  const first = parts[0]!;
  await f.t.mutation(internal.exports.commit, {
    exportId: job.id,
    sequence: 0,
    checkpoint: "{}",
    done: true,
    part: { storageId: first.storageId, sha256: first.sha256, size: first.size },
  });
  expect(await f.t.run(async (ctx) => (await ctx.storage.get(first.storageId))?.size)).toBe(
    first.size,
  );
});
it("restore refuses storage or documents even when no organization exists", async () => {
  const t = convexTest(schema, modules);
  register(t);
  await expect(t.query(internal.testing.restoreProof.assertEmpty, {})).resolves.toBe(null);
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["unrelated"])));
  await expect(t.query(internal.testing.restoreProof.assertEmpty, {})).rejects.toThrow(
    "RESTORE_TARGET_NOT_EMPTY",
  );
  await t.run((ctx) => ctx.storage.delete(storageId));
  const factor = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "twoFactor",
      data: { userId: "synthetic-restore-guard", secret: "synthetic", backupCodes: "synthetic" },
    },
  });
  await expect(t.query(internal.testing.restoreProof.assertEmpty, {})).rejects.toThrow(
    "RESTORE_TARGET_NOT_EMPTY",
  );
  await t.mutation(components.betterAuth.adapter.deleteOne, {
    input: { model: "twoFactor", where: [{ field: "_id", value: factor._id }] },
  });
  await t.run((ctx) =>
    ctx.db.insert("validationProbes", {
      key: "persistence-v1",
      nonce: "preserve",
      createdAt: Date.now(),
    }),
  );
  await expect(t.query(internal.testing.restoreProof.assertEmpty, {})).rejects.toThrow(
    "RESTORE_TARGET_NOT_EMPTY",
  );
});
it("refuses another project and organization and read scope cannot be inferred from import", async () => {
  const f = await fixture(),
    job = await f.create();
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(`fnfe_${"b".repeat(43)}`),
    suffix: crypto.randomUUID(),
  });
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:import"] }));
  expect((await f.request(`/v1/exports/${job.id}`)).status).toBe(403);
  const response = await f.t.fetch(`/v1/exports/${job.id}`, {
    headers: { Authorization: `Bearer fnfe_${"b".repeat(43)}`, "X-Environment": "sandbox" },
  });
  expect(response.status).toBe(404);
  expect(other.organizationId).not.toBe(f.scope.organizationId);
});
it("refuses download tickets for a part of another project, organization or member", async () => {
  const f = await fixture(),
    job = await f.create();
  await f.finish(job.id);
  const part = await f.part(job.id);
  // Outro projeto da mesma organização, com concessão ativa à mesma empresa e
  // os mesmos escopos: o projeto continua sendo a fronteira da exportação.
  const sibling = `fnfe_${"c".repeat(43)}`;
  const siblingHash = await hashApiKey(sibling);
  await f.t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    const project = (await ctx.db.get("projects", f.scope.projectId))!;
    const { _id: ignoredProject, _creationTime: ignoredProjectTime, ...projectFields } = project;
    void ignoredProject;
    void ignoredProjectTime;
    const projectId = await ctx.db.insert("projects", {
      ...projectFields,
      name: "Projeto irmão",
      externalReference: "sibling",
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    const { _id: ignoredGrant, _creationTime: ignoredGrantTime, ...grantFields } = grant;
    void ignoredGrant;
    void ignoredGrantTime;
    await ctx.db.insert("projectCompanies", { ...grantFields, projectId });
    const { _id: ignoredKey, _creationTime: ignoredKeyTime, ...keyFields } = key;
    void ignoredKey;
    void ignoredKeyTime;
    await ctx.db.insert("apiKeys", { ...keyFields, projectId, keyHash: siblingHash });
  });
  const foreign = `fnfe_${"b".repeat(43)}`;
  await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(foreign),
    suffix: crypto.randomUUID(),
  });
  const headers = (secret: string) => ({
    Authorization: `Bearer ${secret}`,
    "X-Environment": "sandbox",
    "Content-Type": "application/json",
  });
  // Controle: a chave irmã é válida e lê o documento da empresa concedida ao
  // seu projeto; só a exportação, criada pelo outro projeto, fica fora.
  expect(
    (
      await f.t.fetch(`/v1/documents/${f.documentId}?companyId=${f.scope.companyId}`, {
        headers: headers(sibling),
      })
    ).status,
  ).toBe(200);
  for (const secret of [sibling, foreign]) {
    const ticket = await f.t.fetch(`/v1/export-parts/${part.id}/ticket`, {
      method: "POST",
      headers: headers(secret),
      body: "{}",
    });
    expect(ticket.status).toBe(404);
    expect(
      (await f.t.fetch(`/v1/exports/${job.id}/parts`, { headers: headers(secret) })).status,
    ).toBe(404);
  }
  const outsider = await actor(f);
  // Membro ativo de outra organização: a sessão existe, a membership não alcança a parte.
  await f.t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      name: "Outra organização",
      slug: crypto.randomUUID(),
      ownerCount: 1,
      memberCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.patch("memberships", outsider.membershipId, { organizationId });
  });
  await expect(
    outsider.client.mutation(api.exportDownloads.ticket, { partId: part.id }),
  ).rejects.toThrow();
  // O dono do projeto continua obtendo o ticket da própria parte.
  expect((await f.download(await f.ticket(part.id))).status).toBe(200);
});
it("expires tickets at 60 seconds and export files at 24 hours, independent of cleanup", async () => {
  const f = await fixture(),
    job = await f.create();
  await f.finish(job.id);
  const part = await f.part(job.id),
    token = await f.ticket(part.id);
  vi.setSystemTime(Date.now() + 60_001);
  expect((await f.download(token)).status).toBe(404);
  vi.setSystemTime(Date.now() + 86_400_000);
  expect((await f.request(`/v1/exports/${job.id}/parts`)).status).toBe(404);
  await f.t.mutation(internal.exports.expire, { exportId: job.id });
  expect(await f.t.run((ctx) => ctx.db.get("exportParts", part.id))).toBe(null);
});
it("revoking a ready export immediately invalidates tickets", async () => {
  const f = await fixture(),
    job = await f.create();
  await f.finish(job.id);
  const token = await f.ticket((await f.part(job.id)).id);
  expect((await f.request(`/v1/exports/${job.id}/revoke`, "POST")).status).toBe(200);
  expect((await f.download(token)).status).toBe(404);
});
it("ticket de exportação desconhecido, de navegador fora do console ou de outra parte responde 404 sem auditar nem cobrar (#134)", async () => {
  const f = await fixture(),
    job = await f.create(),
    sibling = await f.create("export-test-2");
  await f.finish(job.id);
  await f.finish(sibling.id);
  const part = await f.part(job.id),
    other = await f.part(sibling.id);
  expect(other.id).not.toBe(part.id);
  const download = (token: string, headers: Record<string, string> = {}, search = "") =>
    f.t.fetch(`/v1/export-download${search}`, {
      headers: { ...headers, "X-Download-Token": token },
    });
  const refused = async (response: Response) => {
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  };
  const effects = () =>
    f.t.run(async (ctx) => ({
      audits: (await ctx.db.query("operationalAudit").collect()).filter(
        (row) => row.action === "export.downloaded",
      ).length,
      charges: (await ctx.db.query("capacityEvents").collect()).filter(
        (row) => row.metric === "downloadsBytes",
      ).length,
    }));
  // Control: an intact ticket downloads, and that download is audited and charged.
  const token = await f.ticket(part.id);
  expect((await f.download(token)).status).toBe(200);
  const before = await effects();
  expect(before.audits).toBeGreaterThan(0);
  expect(before.charges).toBeGreaterThan(0);

  await refused(await download("x".repeat(72)));
  await refused(await download(token, { Origin: "https://exemplo.invalid" }));
  await refused(await download(token, {}, "?part=1"));
  // A ticket whose row names a part of another export.
  const swapped = await f.ticket(part.id),
    swappedHash = await hashApiKey(swapped);
  await f.t.run(async (ctx) => {
    const row = (await ctx.db
      .query("exportTickets")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", swappedHash))
      .unique())!;
    await ctx.db.patch("exportTickets", row._id, { partId: other.id });
  });
  await refused(await download(swapped));
  expect(await effects()).toEqual(before);
});
it("lost access before commit discards the generated blob and never publishes success", async () => {
  const f = await fixture(),
    job = await f.create();
  const storageId = await f.t.run((ctx) => ctx.storage.store(new Blob(["partial"])));
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  await f.t.mutation(internal.exports.commit, {
    exportId: job.id,
    sequence: 0,
    checkpoint: "{}",
    done: true,
    part: { storageId, size: 7, sha256: "a".repeat(64) },
  });
  expect((await f.t.run((ctx) => ctx.db.get("documentExports", job.id)))?.state).toBe("failed");
  expect(await f.t.run((ctx) => ctx.storage.get(storageId))).toBe(null);
});
it("a lista do console descreve empresa e documento só da exportação autorizada", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await owner.client.mutation(api.exports.create, {
    organizationId: f.scope.organizationId,
    selection: {
      kind: "document",
      documentId: f.documentId,
      companyId: f.scope.companyId,
    },
    key: "described-document",
  });
  await owner.client.mutation(api.exports.create, {
    organizationId: f.scope.organizationId,
    selection: { kind: "organization" },
    key: "described-organization",
  });
  const page = await owner.client.query(api.exports.list, {
    organizationId: f.scope.organizationId,
    paginationOpts: { numItems: 10, cursor: null },
  });
  const fiscalKey = await f.t.run(
    async (ctx) => (await ctx.db.get("fiscalDocuments", f.documentId))!.fiscalKey,
  );
  expect(page.page.find((job) => job.selection.kind === "document")!.description).toEqual({
    companyName: "Empresa sintética",
    model: "55",
    fiscalKey,
  });
  expect(page.page.find((job) => job.selection.kind === "organization")!.description).toBeNull();
  // Outro membro da mesma organização não vê nem recebe a descrição da exportação alheia.
  const viewer = await actor(f, "viewer");
  const foreign = await viewer.client.query(api.exports.list, {
    organizationId: f.scope.organizationId,
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(foreign.page).toEqual([]);
});
it("requires manager for organization export and removal invalidates a human ticket", async () => {
  const f = await fixture(),
    owner = await actor(f),
    viewer = await actor(f, "viewer");
  const args = {
    organizationId: f.scope.organizationId,
    selection: { kind: "organization" as const },
    key: "organization-test",
  };
  await expect(viewer.client.mutation(api.exports.create, args)).rejects.toThrow();
  await expect(f.t.mutation(api.exports.create, args)).rejects.toThrow();
  const job = await owner.client.mutation(api.exports.create, args);
  await f.finish(job.id);
  const page = await owner.client.query(api.exports.parts, {
    exportId: job.id,
    paginationOpts: { numItems: 20, cursor: null },
  });
  const token = (
    await owner.client.mutation(api.exportDownloads.ticket, { partId: page.page[0]!.id })
  ).token;
  await f.t.run((ctx) =>
    ctx.db.patch("memberships", owner.membershipId, { state: "removed", version: 2 }),
  );
  expect((await f.download(token)).status).toBe(404);
  await expect(
    owner.client.query(api.exports.parts, {
      exportId: job.id,
      paginationOpts: { numItems: 20, cursor: null },
    }),
  ).rejects.toThrow();
});
it("organization package includes its documents and unclassified originals but excludes another tenant", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(`fnfe_${"b".repeat(43)}`),
    suffix: crypto.randomUUID(),
  });
  const seeded = await f.t.run(async (ctx) => {
    const doc = (await ctx.db.get("fiscalDocuments", f.documentId))!;
    const { _id: ignoredId, _creationTime: ignoredTime, ...fields } = doc;
    void ignoredId;
    void ignoredTime;
    const second = await ctx.db.insert("fiscalDocuments", {
      ...fields,
      fiscalKey: "2".repeat(44),
      publishedVersionId: undefined,
    });
    const outsider = await ctx.db.insert("fiscalDocuments", {
      ...fields,
      organizationId: other.organizationId,
      companyId: other.companyId,
      fiscalKey: "3".repeat(44),
      publishedVersionId: undefined,
    });
    const artifact = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first())!;
    const { _id: artifactId, _creationTime: artifactTime, ...artifactFields } = artifact;
    void artifactId;
    void artifactTime;
    const unclassified = await ctx.db.insert("documentArtifacts", {
      ...artifactFields,
      documentId: undefined,
      fileId: undefined,
    });
    return { second, outsider, unclassified };
  });
  const job = await owner.client.mutation(api.exports.create, {
    organizationId: f.scope.organizationId,
    selection: { kind: "organization" },
    key: "organization-content",
  });
  expect((await f.finish(job.id)).state).toBe("succeeded");
  const parts = await owner.client.query(api.exports.parts, {
    exportId: job.id,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  const rows: { type: string; id?: string; artifactId?: string; content?: string }[] = [];
  for (const part of parts.page) {
    const { token } = await owner.client.mutation(api.exportDownloads.ticket, { partId: part.id });
    const response = await f.download(token);
    rows.push(
      ...gunzipSync(new Uint8Array(await response.arrayBuffer()))
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  }
  expect(
    rows
      .filter((row) => row.type === "document")
      .map((row) => row.id)
      .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
  ).toEqual([f.documentId, seeded.second].sort((a, b) => a.localeCompare(b)));
  expect(rows.some((row) => row.id === seeded.outsider)).toBe(false);
  expect(
    rows.some((row) => row.type === "unclassified-artifact" && row.id === seeded.unclassified),
  ).toBe(true);
  expect(
    rows.find((row) => row.type === "original" && row.artifactId === seeded.unclassified)?.content,
  ).toBe(Buffer.from(f.bytes).toString("base64"));
});
it("expired plan still permits export and changed grants do not resurrect old tickets", async () => {
  const f = await fixture();
  // The synthetic organization has no paid plan. Export is a read capability.
  const job = await f.create();
  await f.finish(job.id);
  const token = await f.ticket((await f.part(job.id)).id);
  await f.t.run(async (ctx) => {
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { accessEpoch: 1 });
    await ctx.db.patch("apiKeys", f.scope.keyId, { grantEpochs: [1] });
  });
  expect((await f.download(token)).status).toBe(404);
});

it.each(["read", "store", "commit"] as const)(
  "resumes after a lost %s response without duplicating content",
  async (failure) => {
    const f = await fixture(),
      job = await f.create();
    const args = { exportId: job.id, sequence: 0 };
    const before = (await f.t.run((ctx) => ctx.db.get("documentExports", job.id)))!;
    await expect(
      f.t.action(async (ctx) => {
        const intercepted = { ...ctx };
        if (failure === "read")
          intercepted.runQuery = async (query, ...queryArgs) => {
            const result = await ctx.runQuery(query, ...queryArgs);
            if (queryArgs[0] && "checkpoint" in queryArgs[0]) throw new Error("LOST_RESPONSE");
            return result;
          };
        if (failure === "store")
          intercepted.storage = {
            ...ctx.storage,
            store: async (blob) => {
              await ctx.storage.store(blob);
              throw new Error("LOST_RESPONSE");
            },
          };
        if (failure === "commit")
          intercepted.runMutation = async (mutation, ...mutationArgs) => {
            const result = await ctx.runMutation(mutation, ...mutationArgs);
            if (getFunctionName(mutation) === "exports:commit") throw new Error("LOST_RESPONSE");
            return result;
          };
        return runExport(intercepted, args);
      }),
    ).rejects.toThrow("LOST_RESPONSE");
    const after = (await f.t.run((ctx) => ctx.db.get("documentExports", job.id)))!;
    expect(after.sequence).toBe(failure === "commit" ? 1 : 0);
    if (failure !== "commit") expect(after.checkpoint).toBe(before.checkpoint);
    await f.t.action(internal.exportWorker.run, args);
    expect((await f.finish(job.id)).state).toBe("succeeded");
    const parts = await f.t.run((ctx) =>
      ctx.db
        .query("exportParts")
        .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job.id))
        .collect(),
    );
    expect(parts).toHaveLength(1);
    const response = await f.download(await f.ticket(parts[0]!._id));
    const rows = gunzipSync(new Uint8Array(await response.arrayBuffer()))
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const type of ["document", "version", "artifact", "original"])
      expect(rows.filter((row) => row.type === type)).toHaveLength(1);
  },
);

it("refuses an expired key with the mutation's clock; the worker's query never reads it", async () => {
  const f = await fixture();
  const job = await f.create();
  const args = { exportId: job.id, sequence: 0 };
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { expiresAt: Date.now() - 1 }));
  expect(await f.t.query(internal.exportSource.start, { ...args, now: Date.now() })).not.toBeNull();
  await expect(f.t.mutation(internal.exports.reservePart, args)).rejects.toThrow("INVALID_API_KEY");
});
it.each(["key", "grant", "member", "revoke", "expire"] as const)(
  "refuses the next batch after %s changes",
  async (change) => {
    const f = await fixture();
    const owner = await actor(f);
    const job =
      change === "member"
        ? await owner.client.mutation(api.exports.create, {
            organizationId: f.scope.organizationId,
            selection: { kind: "organization" },
            key: "batch-revocation",
          })
        : await f.create();
    const args = { exportId: job.id, sequence: 0, now: Date.now() };
    const start = (await f.t.query(internal.exportSource.start, args))!;
    const first = await f.t.query(internal.exportSource.read, {
      ...args,
      checkpoint: start.checkpoint,
      maxSteps: 1,
    });
    if (change === "revoke") await f.request(`/v1/exports/${job.id}/revoke`, "POST");
    else if (change === "expire") vi.setSystemTime(Date.now() + 86_400_001);
    else
      await f.t.run(async (ctx) => {
        if (change === "key")
          await ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() });
        if (change === "member")
          await ctx.db.patch("memberships", owner.membershipId, { state: "removed", version: 2 });
        if (change === "grant") {
          const grant = (await ctx.db
            .query("projectCompanies")
            .withIndex("by_projectId_and_companyId", (q) =>
              q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
            )
            .unique())!;
          await ctx.db.patch("projectCompanies", grant._id, { accessEpoch: 1 });
        }
      });
    await expect(
      // The worker passes its clock on every call, as `runExport` does.
      f.t.query(internal.exportSource.read, {
        ...args,
        now: Date.now(),
        checkpoint: first.checkpoint,
      }),
    ).rejects.toThrow();
  },
);

it("replays the exact batch and excludes versions and originals published after the request", async () => {
  const f = await fixture(),
    job = await f.create();
  const args = { exportId: job.id, sequence: 0, now: Date.now() };
  const start = (await f.t.query(internal.exportSource.start, args))!;
  const first = await f.t.query(internal.exportSource.read, {
    ...args,
    checkpoint: start.checkpoint,
  });
  expect(first.steps).toBeGreaterThan(1);
  expect(
    await f.t.query(internal.exportSource.read, { ...args, checkpoint: start.checkpoint }),
  ).toEqual(first);
  await f.t.run(async (ctx) => {
    const doc = (await ctx.db.get("fiscalDocuments", f.documentId))!;
    const version = (await ctx.db.get("documentVersions", doc.publishedVersionId!))!;
    const artifact = (await ctx.db.get("documentArtifacts", version.artifactId))!;
    const { _id: aid, _creationTime: atime, ...afields } = artifact;
    const { _id: vid, _creationTime: vtime, ...vfields } = version;
    void [aid, atime, vid, vtime];
    const later = await ctx.db.insert("documentArtifacts", {
      ...afields,
      importedAt: Date.now() + 1,
    });
    await ctx.db.insert("documentVersions", {
      ...vfields,
      artifactId: later,
      publishedAt: Date.now() + 1,
    });
  });
  await f.finish(job.id);
  const response = await f.download(await f.ticket((await f.part(job.id)).id));
  const rows = gunzipSync(new Uint8Array(await response.arrayBuffer()))
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.filter((row) => row.type === "version")).toHaveLength(1);
  expect(rows.filter((row) => row.type === "original")).toHaveLength(1);
});

it("stops on database bytes even when the public projection is small", async () => {
  const f = await fixture(),
    job = await f.create();
  await f.t.run(async (ctx) => {
    const doc = (await ctx.db.get("fiscalDocuments", f.documentId))!;
    const version = (await ctx.db.get("documentVersions", doc.publishedVersionId!))!;
    const item = (await ctx.db.query("documentItems").first())!;
    await ctx.db.patch("documentVersions", version._id, {
      result: JSON.stringify({ ...JSON.parse(version.result!), ignored: "x".repeat(850_000) }),
    });
    await ctx.db.patch("operations", version.operationId, { request: "x".repeat(850_000) });
    for (let position = 1; position < 500; position++)
      await ctx.db.insert("documentItems", { versionId: version._id, position, data: item.data });
    await ctx.db.patch("documentVersions", version._id, { itemCount: 500, writtenItems: 500 });
  });
  const args = { exportId: job.id, sequence: 0, now: Date.now() };
  const start = (await f.t.query(internal.exportSource.start, args))!;
  const measured = await f.t.query(async (ctx) => {
    const page = await readBatch(ctx, { ...args, checkpoint: start.checkpoint });
    return { page, metrics: await ctx.meta.getTransactionMetrics() };
  });
  expect(measured.page.steps).toBeLessThan(8);
  expect(measured.metrics.bytesRead.used).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  expect(measured.metrics.bytesRead.used).toBeLessThan(8 * 1024 * 1024);
  expect(Buffer.byteLength(measured.page.records)).toBeLessThan(512 * 1024);
  expect((await f.finish(job.id)).state).toBe("succeeded");
});

it("bounds empty transitions and the requested output/step budgets", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run(async (ctx) => {
    const doc = (await ctx.db.get("fiscalDocuments", f.documentId))!;
    const { _id, _creationTime, ...fields } = doc;
    void [_id, _creationTime];
    await ctx.db.patch("fiscalDocuments", doc._id, { environment: "production" });
    for (let n = 0; n < 100; n++)
      await ctx.db.insert("fiscalDocuments", {
        ...fields,
        fiscalKey: String(n).padStart(44, "0"),
        publishedVersionId: undefined,
      });
  });
  const job = await owner.client.mutation(api.exports.create, {
    organizationId: f.scope.organizationId,
    selection: { kind: "organization" },
    key: "empty-transitions",
  });
  const args = { exportId: job.id, sequence: 0, now: Date.now() };
  const start = (await f.t.query(internal.exportSource.start, args))!;
  const tiny = await f.t.query(internal.exportSource.read, {
    ...args,
    checkpoint: start.checkpoint,
    maxBytes: 1,
  });
  expect(tiny.records.trim().split("\n")).toHaveLength(1);
  const bounded = await f.t.query(internal.exportSource.read, {
    ...args,
    checkpoint: start.checkpoint,
    maxSteps: 1000,
  });
  expect(bounded.steps).toBe(8);
  expect(bounded.done).toBe(false);
  let checkpoint = start.checkpoint,
    calls = 0,
    documents = 0;
  while (calls < 100) {
    const page = await f.t.query(internal.exportSource.read, { ...args, checkpoint });
    calls++;
    documents += page.records
      ? page.records
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((row) => row.type === "document").length
      : 0;
    checkpoint = page.checkpoint;
    if (page.done) break;
  }
  expect(documents).toBe(100);
  expect(calls).toBeLessThan(50);
  expect(JSON.parse(checkpoint).phase).toBe("done");
});

it.each(["hash", "size", "missing"] as const)(
  "refuses an invalid original: %s",
  async (corruption) => {
    const f = await fixture(),
      job = await f.create();
    await f.t.run(async (ctx) => {
      const artifact = (await ctx.db
        .query("documentArtifacts")
        .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
        .first())!;
      if (corruption === "missing") await ctx.storage.delete(artifact.storageId!);
      else
        await ctx.db.patch(
          "documentArtifacts",
          artifact._id,
          corruption === "hash" ? { sha256: "0".repeat(64) } : { size: 10 * 1024 * 1024 + 1 },
        );
    });
    await expect(f.finish(job.id)).rejects.toThrow(/EXPORT_ORIGINAL_/);
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("exportParts")
          .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job.id))
          .collect(),
      ),
    ).toEqual([]);
  },
);

it("keeps the event version and its exact original after importing a cancellation", async () => {
  const f = await fixture();
  const bytes = xmlFixture("event-110111");
  const batch = (
    await (
      await f.request(
        "/v1/imports",
        "POST",
        {
          companyId: f.scope.companyId,
          files: [{ name: "evento.xml", size: bytes.length, sha256: hash(bytes) }],
        },
        "event-import",
      )
    ).json()
  ).data;
  const path = `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}`;
  const ticket = (await (await f.request(`${path}/upload`, "POST")).json()).data;
  expect(
    (
      await f.t.fetch("/v1/import-upload", {
        method: "POST",
        headers: { "X-Upload-Token": ticket.token },
        body: new Uint8Array(bytes),
      })
    ).status,
  ).toBe(200);
  const op = (await (await f.request(`${path}/confirm`, "POST")).json()).data;
  await f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
  const job = await f.create();
  await f.finish(job.id);
  const response = await f.download(await f.ticket((await f.part(job.id)).id));
  const rows = gunzipSync(new Uint8Array(await response.arrayBuffer()))
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.filter((row) => row.type === "version").map((row) => row.payload.kind)).toContain(
    "event",
  );
  expect(rows.filter((row) => row.type === "original").map((row) => row.content)).toContain(
    bytes.toString("base64"),
  );
});

it("ends the part at the byte budget before fetching another original", async () => {
  const f = await fixture();
  const bytes = new Uint8Array(3 * 1024 * 1024).fill(65);
  await f.t.run(async (ctx) => {
    const artifact = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first())!;
    const large = {
      storageId: await ctx.storage.store(new Blob([bytes])),
      size: bytes.length,
      sha256: hash(bytes),
    };
    await ctx.db.patch("documentArtifacts", artifact._id, large);
    const { _id, _creationTime, ...fields } = artifact;
    void [_id, _creationTime];
    await ctx.db.insert("documentArtifacts", { ...fields, ...large, fileId: undefined });
  });
  const job = await f.create();
  await f.t.action(internal.exportWorker.run, { exportId: job.id, sequence: 0 });
  expect(await f.t.run((ctx) => ctx.db.get("documentExports", job.id))).toMatchObject({
    state: "running",
    sequence: 1,
  });
  expect((await f.finish(job.id)).state).toBe("succeeded");
  const parts = await f.t.run((ctx) =>
    ctx.db
      .query("exportParts")
      .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job.id))
      .collect(),
  );
  expect(parts).toHaveLength(3);
  let originals = 0;
  for (const part of parts) {
    const compressed = await f.t.run(async (ctx) =>
      (await ctx.storage.get(part.storageId))!.arrayBuffer(),
    );
    const rows = gunzipSync(new Uint8Array(compressed))
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const inPart = rows.filter((row) => row.type === "original");
    expect(inPart.length).toBeLessThanOrEqual(1);
    originals += inPart.length;
  }
  expect(originals).toBe(2);
});

it.each(["company", "organization"] as const)(
  "rejects a checkpoint targeting another %s",
  async (scope) => {
    const f = await fixture(),
      job = await f.create();
    const other = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash: await hashApiKey(`fnfe_${"b".repeat(43)}`),
      suffix: crypto.randomUUID(),
    });
    const outsider = await f.t.run(async (ctx) => {
      if (scope === "company")
        await ctx.db.patch("companies", other.companyId, {
          organizationId: f.scope.organizationId,
        });
      const doc = (await ctx.db.get("fiscalDocuments", f.documentId))!;
      const { _id, _creationTime, ...fields } = doc;
      void [_id, _creationTime];
      return ctx.db.insert("fiscalDocuments", {
        ...fields,
        companyId: other.companyId,
        organizationId: scope === "company" ? f.scope.organizationId : other.organizationId,
        publishedVersionId: undefined,
      });
    });
    const args = { exportId: job.id, sequence: 0, now: Date.now() };
    const start = (await f.t.query(internal.exportSource.start, args))!;
    const page = await f.t.query(internal.exportSource.read, {
      ...args,
      checkpoint: start.checkpoint,
      maxSteps: 1,
    });
    const forged = JSON.stringify({ ...JSON.parse(page.checkpoint), documentId: outsider });
    await expect(
      f.t.query(internal.exportSource.read, { ...args, checkpoint: forged }),
    ).rejects.toThrow();
  },
);

it("exports the payload and the items from the content blob (ADR 0010, B5)", async () => {
  const f = await fixture(keepInline());
  await writeContent(f.t);
  await f.t.run(async (ctx) => {
    for (const version of await ctx.db.query("documentVersions").collect()) {
      expect(version.contentStorageId).toBeDefined();
      const result = JSON.parse(version.result!) as { document: Record<string, unknown> };
      result.document.issuer = { ...(result.document.issuer as object), name: "ADULTERADO" };
      await ctx.db.patch("documentVersions", version._id, { result: JSON.stringify(result) });
    }
    for (const item of await ctx.db.query("documentItems").collect())
      await ctx.db.patch("documentItems", item._id, {
        data: item.data.replace(/"description":"[^"]*"/, '"description":"ADULTERADO"'),
      });
  });
  const job = await f.create();
  expect((await f.finish(job.id)).state).toBe("succeeded");
  const response = await f.download(await f.ticket((await f.part(job.id)).id));
  const text = gunzipSync(new Uint8Array(await response.arrayBuffer())).toString();
  const rows = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; position?: number });
  expect(rows.filter((row) => row.type === "version")).toHaveLength(1);
  expect(rows.filter((row) => row.type === "item").map((row) => row.position)).toEqual(
    Array.from({ length: rows.filter((row) => row.type === "item").length }, (_, i) => i),
  );
  expect(rows.filter((row) => row.type === "item").length).toBeGreaterThan(0);
  expect(text).not.toContain("ADULTERADO");
  expect(text).not.toContain("$content");
});
