/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Doc } from "../platform/convex/_generated/dataModel";
import { executionAllowed } from "../platform/convex/lib/operationCore";
import {
  baseEnvironment,
  environmentServed,
  keyEnvironmentServed,
  type EnvironmentPurpose,
} from "../platform/convex/lib/environmentAccess";
import { gunzipSync } from "node:zlib";
import { api } from "../platform/convex/_generated/api";
import { routes } from "../packages/contracts/src/external";
import { integrationScopes, releasedProductionScopes } from "../packages/contracts/src/projects";
import { actor, fixture } from "./helpers/export-fixture";
import { CAPTURE_TERMS_VERSION } from "../platform/convex/lib/fiscalCaptureRelease";
import { sources } from "./helpers/convex-sources";

/**
 * ADR 0007: the environment is resolved per request. The hosted sandbox serves production only to
 * a company whose fiscal capture is released (`captureReleases`), and only for capture,
 * documents, webhooks and monitors, never imports or issuance; a withdrawn release keeps only
 * the reading of what was captured.
 */
const sandboxProfile = {
  APP_ENV: "development",
  PRODUCT_ENV: "sandbox",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  EMAIL_MODE: "local",
  WEBHOOK_MODE: "disabled",
  SITE_URL: "http://localhost:5207",
  FNFE_CAPTURE_FISCAL: "enabled",
  CONVEX_SITE_URL: "http://127.0.0.1:3267",
  BETTER_AUTH_SECRET: "synthetic-isolation-secret",
};
const proofProfile = {
  APP_ENV: "validation",
  PRODUCT_ENV: "production",
  FNFE_PROOF_FISCAL_ENV: "production",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  EMAIL_MODE: "disabled",
  WEBHOOK_MODE: "disabled",
  SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
};
const stub = (profile: Record<string, string>) => {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(profile)) vi.stubEnv(name, value);
};
beforeEach(() => {
  vi.useFakeTimers();
  stub(sandboxProfile);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const secret = `fnfe_${"a".repeat(43)}`;
/** Writes the release state the approved workflow would leave (`captureRelease.set`). */
const release = (f: Fixture, released: boolean, companyId = f.scope.companyId) =>
  f.t.run(async (ctx) => {
    const { organizationId } = f.scope;
    const prior = await ctx.db
      .query("captureReleases")
      .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
      .unique();
    const version = (prior?.version ?? 0) + 1;
    const fields = { organizationId, companyId, released, blocked: false, minIntervalHours: 1 };
    const eventId = await ctx.db.insert("captureReleaseEvents", {
      ...fields,
      version,
      kind: released ? "console_release" : "console_withdraw",
      ...(released ? { terms: CAPTURE_TERMS_VERSION } : {}),
      revokedKeys: 0,
      reason: "Liberação sintética da captura",
      buildSha: null,
      deployment: "",
      createdAt: Date.now(),
    });
    const state = {
      ...fields,
      releasedBefore: true,
      actor: "operator:freecorps",
      reason: "Liberação sintética da captura",
      version,
      updatedAt: Date.now(),
      eventId,
    };
    if (prior) await ctx.db.replace("captureReleases", prior._id, state);
    else await ctx.db.insert("captureReleases", state);
  });

const releasedPurposes: EnvironmentPurpose[] = [
  "companies:read",
  "documents:read",
  "connections:read",
  "connections:write",
  "webhooks:manage",
  "observability",
  "capture-processing",
];
const closedPurposes: EnvironmentPurpose[] = [
  "companies:write",
  "documents:import",
  "documents:issue",
  "documents:cancel",
  "certificates:read",
  "certificates:write",
  "references:read",
  "registry:read",
];

type Fixture = Awaited<ReturnType<typeof fixture>>;
/**
 * The fixture's company declared, and its key and grant moved to production, as a phase 3
 * release would leave them. A demonstration company never reaches production.
 */
async function productionKey(f: Fixture) {
  await f.t.run(async (ctx) => {
    await ctx.db.patch("companies", f.scope.companyId, { kind: "declared" });
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    await ctx.db.patch("apiKeys", key._id, {
      environment: "production",
      scopes: [...key.scopes, "companies:read"],
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      environments: ["sandbox", "production"],
      scopes: [...grant.scopes, "companies:read"],
    });
  });
}
const call = (f: Fixture, path: string, environment: string, method = "GET", body?: unknown) =>
  f.t.fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "X-Environment": environment,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
const served = (
  f: Fixture,
  environment: Doc<"apiKeys">["environment"],
  purpose: EnvironmentPurpose,
  kind: Doc<"companies">["kind"] = "declared",
) =>
  f.t.run(async (ctx) => {
    const company = (await ctx.db.get("companies", f.scope.companyId))!;
    return environmentServed(ctx, { ...company, kind }, environment, purpose);
  });

describe("environmentServed", () => {
  it("serves only sandbox on a sandbox deployment while no company is released", async () => {
    const f = await fixture();
    expect(baseEnvironment()).toBe("sandbox");
    for (const purpose of [...releasedPurposes, ...closedPurposes]) {
      expect(await served(f, "sandbox", purpose), purpose).toBe(true);
      expect(await served(f, "production", purpose), purpose).toBe(false);
    }
  });
  it("serves in released production exactly the shared scope list the console offers (#512)", async () => {
    const f = await fixture();
    await release(f, true);
    for (const scope of integrationScopes)
      expect(await served(f, "production", scope), scope).toBe(
        (releasedProductionScopes as readonly string[]).includes(scope),
      );
  });
  it("opens production for a released company only for the capture and its documents", async () => {
    const f = await fixture();
    await release(f, true);
    for (const purpose of releasedPurposes)
      expect(await served(f, "production", purpose), purpose).toBe(true);
    for (const purpose of closedPurposes)
      expect(await served(f, "production", purpose), purpose).toBe(false);
    // Sandbox stays served, and a demonstration company never reaches production.
    expect(await served(f, "sandbox", "documents:import")).toBe(true);
    expect(await served(f, "production", "documents:read", "demonstration")).toBe(false);
  });
  it("keeps only reading, and processing what was received, after the release is withdrawn or cut", async () => {
    const f = await fixture();
    const reading: EnvironmentPurpose[] = [
      "companies:read",
      "documents:read",
      "connections:read",
      "capture-processing",
    ];
    const check = async () => {
      for (const purpose of reading)
        expect(await served(f, "production", purpose), purpose).toBe(true);
      for (const purpose of [
        "connections:write",
        "webhooks:manage",
        "observability",
        ...closedPurposes,
      ] as EnvironmentPurpose[])
        expect(await served(f, "production", purpose), purpose).toBe(false);
    };
    await release(f, true);
    await release(f, false);
    await check();
    // Without the deployment switch (the general cut), a released company reads as withdrawn.
    await release(f, true);
    for (const value of ["disabled", "", undefined]) {
      vi.stubEnv("FNFE_CAPTURE_FISCAL", value);
      await check();
    }
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
    expect(await served(f, "production", "connections:write")).toBe(true);
  });
  it("keeps a production deployment fixed: production only, never per company", async () => {
    const f = await fixture();
    stub(proofProfile);
    await release(f, true);
    expect(baseEnvironment()).toBe("production");
    for (const purpose of [...releasedPurposes, ...closedPurposes]) {
      expect(await served(f, "production", purpose), purpose).toBe(true);
      expect(await served(f, "sandbox", purpose), purpose).toBe(false);
    }
    expect(await served(f, "production", "documents:read", "demonstration")).toBe(false);
  });
  it("admits a key at the entry only when one of its companies is served", async () => {
    const f = await fixture();
    await productionKey(f);
    const keyServed = (purpose: EnvironmentPurpose) =>
      f.t.run(async (ctx) =>
        keyEnvironmentServed(ctx, (await ctx.db.get("apiKeys", f.scope.keyId))!, purpose),
      );
    expect(await keyServed("companies:read")).toBe(false);
    await release(f, true);
    expect(await keyServed("companies:read")).toBe(true);
    expect(await keyServed("documents:import")).toBe(false);
    // A company of another organization listed on the key does not open it.
    await f.t.run(async (ctx) => {
      const other = await ctx.db.insert("organizations", {
        name: "Outra organização",
        slug: crypto.randomUUID(),
        ownerCount: 1,
        memberCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.patch("companies", f.scope.companyId, { organizationId: other });
    });
    expect(await keyServed("companies:read")).toBe(false);
  });
});

describe("REST", () => {
  it("refuses a production key on the sandbox site at every entry", async () => {
    const f = await fixture();
    await productionKey(f);
    // Entry checks answer 403; the per-company checks hide the company (404), as before.
    for (const [path, status, code] of [
      ["/v1/companies", 403, "ENVIRONMENT_DENIED"],
      ["/v1/capabilities", 403, "ENVIRONMENT_DENIED"],
      [`/v1/documents?companyId=${f.scope.companyId}`, 404, "NOT_FOUND"],
      [`/v1/documents/${f.documentId}?companyId=${f.scope.companyId}`, 404, "NOT_FOUND"],
    ] as const) {
      const response = await call(f, path, "production");
      expect(response.status, path).toBe(status);
      expect((await response.json()).error.code, path).toBe(code);
    }
    // The sandbox header does not borrow the key into sandbox either.
    const borrowed = await call(f, "/v1/companies", "sandbox");
    expect((await borrowed.json()).error.code).toBe("ENVIRONMENT_DENIED");
  });
  it("never shows a sandbox document to a released production key, nor imports there", async () => {
    const f = await fixture();
    await productionKey(f);
    await release(f, true);
    const companies = await call(f, "/v1/companies", "production");
    expect(companies.status).toBe(200);
    expect((await companies.json()).data).toHaveLength(1);
    const list = await call(f, `/v1/documents?companyId=${f.scope.companyId}`, "production");
    expect(list.status).toBe(200);
    expect((await list.json()).data.page).toEqual([]);
    expect(
      (await call(f, `/v1/documents/${f.documentId}?companyId=${f.scope.companyId}`, "production"))
        .status,
    ).toBe(404);
    const imported = await call(f, "/v1/imports", "production", "POST", {
      companyId: f.scope.companyId,
      files: [{ name: "nota.xml", size: 10, sha256: "0".repeat(64) }],
    });
    expect(imported.status).toBe(404);
    expect((await imported.json()).error.code).toBe("NOT_FOUND");
  });
});

describe("GET /v1/capabilities", () => {
  const all = [
    "companies.read",
    "documents.import",
    "documents.read",
    "documents.issue",
    "documents.cancel",
    "webhooks",
    "references.read",
    "connections.read",
    "connections.write",
    "registry.read",
  ];
  const released = [
    "companies.read",
    "documents.read",
    "webhooks",
    "connections.read",
    "connections.write",
  ];
  const withdrawn = ["companies.read", "documents.read", "connections.read"];
  const capabilities = async (f: Fixture, environment: "sandbox" | "production") => {
    const response = await call(f, "/v1/capabilities", environment);
    expect(response.status).toBe(200);
    const { data } = routes.getCapabilities.output.parse(await response.json());
    return { environment: data.environment, models: data.models, capabilities: data.capabilities };
  };
  /** A second declared company of the same organization, listed on the key. */
  const secondCompany = (f: Fixture) =>
    f.t.run(async (ctx) => {
      const { _id, _creationTime, ...company } = (await ctx.db.get(
        "companies",
        f.scope.companyId,
      ))!;
      const id = await ctx.db.insert("companies", {
        ...company,
        kind: "declared",
        cnpj: "11222333000181",
      });
      const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
      await ctx.db.patch("apiKeys", key._id, { companyIds: [...key.companyIds, id] });
      return id;
    });

  it("lists every implemented model and capability to a sandbox key, whatever its scopes", async () => {
    const f = await fixture();
    await release(f, true);
    expect(await capabilities(f, "sandbox")).toEqual({
      environment: "sandbox",
      models: ["55", "nfse"],
      capabilities: all,
    });
  });
  it("answers a released production key with production and only what it serves, no NFS-e", async () => {
    const f = await fixture();
    await productionKey(f);
    await release(f, true);
    expect(await capabilities(f, "production")).toEqual({
      environment: "production",
      models: ["55"],
      capabilities: released,
    });
    // The header still has to name the key's environment.
    const borrowed = await call(f, "/v1/capabilities", "sandbox");
    expect(borrowed.status).toBe(403);
    expect((await borrowed.json()).error.code).toBe("ENVIRONMENT_DENIED");
  });
  it("keeps only reading after the release is withdrawn or cut for the deployment", async () => {
    const f = await fixture();
    await productionKey(f);
    await release(f, true);
    await release(f, false);
    expect(await capabilities(f, "production")).toEqual({
      environment: "production",
      models: ["55"],
      capabilities: withdrawn,
    });
    await release(f, true);
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "disabled");
    expect(await capabilities(f, "production")).toEqual({
      environment: "production",
      models: ["55"],
      capabilities: withdrawn,
    });
  });
  it("lists everything to a production key on a production deployment", async () => {
    const f = await fixture();
    await productionKey(f);
    stub(proofProfile);
    expect(await capabilities(f, "production")).toEqual({
      environment: "production",
      models: ["55", "nfse"],
      capabilities: all,
    });
  });
  it("lists a capability served for at least one of the key's companies", async () => {
    const f = await fixture();
    await productionKey(f);
    const other = await secondCompany(f);
    // One company released, the other never: the released one opens the capability.
    await release(f, true, other);
    expect(await capabilities(f, "production")).toMatchObject({
      models: ["55"],
      capabilities: released,
    });
    // One withdrawn, the other never released: only reading remains.
    await release(f, false, other);
    expect((await capabilities(f, "production")).capabilities).toEqual(withdrawn);
    // One withdrawn, the other released: the released one still opens writing.
    await release(f, true);
    expect((await capabilities(f, "production")).capabilities).toEqual(released);
    // A company moved to another organization no longer counts for the key.
    await release(f, false);
    await release(f, true, other);
    await f.t.run(async (ctx) => {
      const stranger = await ctx.db.insert("organizations", {
        name: "Outra organização",
        slug: crypto.randomUUID(),
        ownerCount: 1,
        memberCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.patch("companies", other, { organizationId: stranger });
    });
    expect((await capabilities(f, "production")).capabilities).toEqual(withdrawn);
  });
});

describe("project grants and keys", () => {
  it("lists the grantable companies with their offer and saved version in one query (#512)", async () => {
    const f = await fixture();
    const project = { organizationId: f.scope.organizationId, projectId: f.scope.projectId };
    const declared = await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...company } = (await ctx.db.get(
        "companies",
        f.scope.companyId,
      ))!;
      return ctx.db.insert("companies", { ...company, kind: "declared", cnpj: "11222333000181" });
    });
    const candidates = async (
      client: Awaited<ReturnType<typeof actor>>["client"],
      args = project,
    ) =>
      (
        await client.query(api.projects.grantCandidates, {
          ...args,
          contextKey: "test",
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page;
    const owner = await actor(f);
    const byId = async () =>
      Object.fromEntries((await candidates(owner.client)).map((c) => [c.companyId, c]));
    let listed = await byId();
    // The demonstration company is Sandbox only; the fixture's grant keeps its version.
    expect(listed[f.scope.companyId]).toMatchObject({
      kind: "demonstration",
      offeredEnvironments: ["sandbox"],
      grantVersion: 1,
    });
    expect(listed[declared]).toMatchObject({
      kind: "declared",
      offeredEnvironments: ["sandbox"],
      grantVersion: 0,
    });
    await release(f, true, declared);
    listed = await byId();
    expect(listed[declared]!.offeredEnvironments).toEqual(["sandbox", "production"]);
    // A removed grant keeps its version, which the next save must name.
    await owner.client.mutation(api.projects.revokeCompany, {
      ...project,
      companyId: f.scope.companyId,
      expectedVersion: 1,
    });
    expect((await byId())[f.scope.companyId]!.grantVersion).toBe(2);
    // Who cannot integrate, or asks with another organization's project, gets nothing.
    const viewer = await actor(f, "viewer");
    await expect(candidates(viewer.client)).rejects.toThrow();
    const stranger = await f.t.run((ctx) =>
      ctx.db.insert("organizations", {
        name: "Outra organização",
        slug: crypto.randomUUID(),
        ownerCount: 1,
        memberCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      candidates(owner.client, { ...project, organizationId: stranger }),
    ).rejects.toThrow();
    // A developer sees only the companies of their own concessions, on a project they created.
    const developer = await actor(f, "developer");
    const own = await f.t.run(async (ctx) => {
      await ctx.db.insert("companyGrants", {
        organizationId: f.scope.organizationId,
        companyId: declared,
        membershipId: developer.membershipId,
        membershipEpoch: 0,
        active: true,
        version: 1,
        updatedAt: Date.now(),
      });
      return ctx.db.insert("projects", {
        organizationId: f.scope.organizationId,
        name: "Projeto do desenvolvedor",
        externalReference: "dev",
        state: "active",
        version: 1,
        accessEpoch: 0,
        creatorMembershipId: developer.membershipId,
        creatorEpoch: 0,
        createdAt: Date.now(),
      });
    });
    await expect(candidates(developer.client)).rejects.toThrow();
    const mine = await candidates(developer.client, { ...project, projectId: own });
    expect(mine.map((c) => c.companyId)).toEqual([declared]);
  });

  it("offer Produção to a new grant or key only while the company's capture is released", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.patch("companies", f.scope.companyId, { kind: "declared" }));
    const owner = await actor(f);
    const project = { organizationId: f.scope.organizationId, projectId: f.scope.projectId };
    const offered = () =>
      owner.client.query(api.projects.offeredEnvironments, {
        ...project,
        companyId: f.scope.companyId,
      });
    const grantVersion = () =>
      f.t.run(async (ctx) => {
        const grant = await ctx.db
          .query("projectCompanies")
          .withIndex("by_projectId_and_companyId", (q) =>
            q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
          )
          .unique();
        return grant?.version ?? 0;
      });
    const grant = async (environments: ("sandbox" | "production")[]) =>
      owner.client.mutation(api.projects.grantCompany, {
        ...project,
        companyId: f.scope.companyId,
        scopes: ["companies:read", "documents:read", "webhooks:manage"],
        environments,
        expectedVersion: await grantVersion(),
      });
    const key = (name: string) =>
      owner.client.action(api.keys.create, {
        ...project,
        name,
        scopes: ["documents:read"],
        environment: "production",
        companyIds: [f.scope.companyId],
        expiresAt: Date.now() + 86_400_000,
      });
    expect(await offered()).toEqual(["sandbox"]);
    // Before the release, the server refuses Produção in the grant, not only the console (#493).
    const before = await grantVersion();
    await expect(grant(["sandbox", "production"])).rejects.toThrow("ENVIRONMENT_DENIED");
    expect(await grantVersion()).toBe(before);
    await grant(["sandbox"]);
    await expect(key("antes")).rejects.toThrow("GRANT_DENIED");
    await release(f, true);
    expect(await offered()).toEqual(["sandbox", "production"]);
    await grant(["sandbox", "production"]);
    const listed = await owner.client.query(api.projects.companies, {
      ...project,
      contextKey: "test",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(listed.page[0]).toMatchObject({
      environments: ["sandbox", "production"],
      offeredEnvironments: ["sandbox", "production"],
    });
    expect((await key("produção")).secretOnce).toMatch(/^fnfe_/);
    const webhooks = () =>
      owner.client.query(api.webhooks.list, {
        ...project,
        companyId: f.scope.companyId,
        environment: "production",
      });
    expect(await webhooks()).toEqual([]);
    // Withdrawn: the saved grant stays editable as it is, and no new production key is issued.
    await release(f, false);
    expect(await offered()).toEqual(["sandbox"]);
    await grant(["sandbox", "production"]);
    vi.advanceTimersByTime(60_000);
    await expect(key("depois")).rejects.toThrow("ENVIRONMENT_DENIED");
    await expect(webhooks()).rejects.toThrow("NOT_FOUND");
    // Produção dropped from the grant cannot come back while the capture is off.
    await grant(["sandbox"]);
    await expect(grant(["sandbox", "production"])).rejects.toThrow("ENVIRONMENT_DENIED");
    // A grant saved with Produção stays removable after the withdrawal, and a revoked one does not
    // keep Produção for the next grant.
    await release(f, true);
    await grant(["sandbox", "production"]);
    await release(f, false);
    await owner.client.mutation(api.projects.revokeCompany, {
      ...project,
      companyId: f.scope.companyId,
      expectedVersion: await grantVersion(),
    });
    await expect(grant(["sandbox", "production"])).rejects.toThrow("ENVIRONMENT_DENIED");
    await grant(["sandbox"]);
  });
});

describe("workers and exports", () => {
  it("stops a production operation at the worker until its company is released", async () => {
    const f = await fixture();
    await productionKey(f);
    const allowed = () =>
      f.t.run(async (ctx) => {
        const op = (await ctx.db.query("operations").first())!;
        return executionAllowed(ctx, op);
      });
    expect(await allowed()).toBe(true);
    await f.t.run(async (ctx) => {
      const op = (await ctx.db.query("operations").first())!;
      await ctx.db.patch("operations", op._id, { environment: "production" });
    });
    expect(await allowed()).toBe(false);
    // Released, an import operation still never runs in production on the sandbox site.
    await release(f, true);
    expect(await allowed()).toBe(false);
  });
  it("exports a released company's production documents, by document and by organization", async () => {
    const f = await fixture();
    await productionKey(f);
    // The captured document, as the production capture leaves it.
    await f.t.run(async (ctx) => {
      await ctx.db.patch("fiscalDocuments", f.documentId, { environment: "production" });
      for (const artifact of await ctx.db
        .query("documentArtifacts")
        .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
        .collect())
        await ctx.db.patch("documentArtifacts", artifact._id, { environment: "production" });
    });
    const owner = await actor(f);
    const organization = {
      organizationId: f.scope.organizationId,
      selection: { kind: "organization" as const },
      environment: "production" as const,
    };
    // Before the release, Produção is neither offered nor accepted.
    expect(
      await owner.client.query(api.exports.environments, {
        organizationId: f.scope.organizationId,
      }),
    ).toEqual(["sandbox"]);
    await expect(
      owner.client.mutation(api.exports.create, { ...organization, key: "before" }),
    ).rejects.toThrow("ENVIRONMENT_DENIED");
    await release(f, true);
    expect(
      await owner.client.query(api.exports.environments, {
        organizationId: f.scope.organizationId,
      }),
    ).toEqual(["sandbox", "production"]);
    const byKey = await call(f, "/v1/exports", "production", "POST", {
      companyId: f.scope.companyId,
      documentId: f.documentId,
    });
    expect(byKey.status).toBe(200);
    const document = (await byKey.json()).data as { id: Doc<"documentExports">["_id"] };
    expect((await f.finish(document.id)).state).toBe("succeeded");
    const job = await owner.client.mutation(api.exports.create, { ...organization, key: "org" });
    expect(job.environment).toBe("production");
    expect((await f.finish(job.id)).state).toBe("succeeded");
    const content = await f.t.run(async (ctx) => {
      const parts = await ctx.db
        .query("exportParts")
        .filter((q) => q.eq(q.field("exportId"), job.id))
        .collect();
      const texts: string[] = [];
      for (const part of parts) {
        const blob = (await ctx.storage.get(part.storageId))!;
        texts.push(gunzipSync(Buffer.from(await blob.arrayBuffer())).toString());
      }
      return texts.join("\n");
    });
    expect(content).toContain(`"id":"${f.documentId}"`);
    expect(content).toContain('"environment":"production"');
    // Withdrawn, what was already captured can still be exported.
    await release(f, false);
    vi.advanceTimersByTime(60_000);
    const after = await owner.client.mutation(api.exports.create, { ...organization, key: "late" });
    expect((await f.finish(after.id)).state).toBe("succeeded");
  });
  it("refuses a production document export on the sandbox site", async () => {
    const f = await fixture();
    const { id } = await f.create();
    await f.t.run((ctx) => ctx.db.patch("documentExports", id, { environment: "production" }));
    await expect(f.finish(id)).rejects.toThrow("ENVIRONMENT_DENIED");
  });
});

it("reads PRODUCT_ENV only in the deployment gates, never in an access check", () => {
  const readers = Object.entries(sources)
    .filter(
      ([path, text]) => !path.includes("/_generated/") && text.includes("process.env.PRODUCT_ENV"),
    )
    .map(([path]) => path.replace("../../platform/convex/", ""))
    .sort();
  // The #50 proof policy, the NFS-e restricted transport and a local proof; `environment.ts`
  // checks the profile by name. Access goes through `lib/environmentAccess.ts`.
  expect(readers).toEqual([
    "lib/fiscalProof.ts",
    "lib/issuanceCore.ts",
    "testing/certificateProof.ts",
  ]);
});
