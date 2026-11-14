import { convexTest } from "convex-test";
import { expect, vi } from "vite-plus/test";
import schema from "../../platform/convex/schema";
import { internal } from "../../platform/convex/_generated/api";
import type { Id } from "../../platform/convex/_generated/dataModel";
import { capturePlan } from "./platform";
import { register } from "../../platform/test-setup";
import { hashApiKey } from "../../platform/convex/lib/apiKeyCrypto";
import { CAPTURE_TERMS_VERSION } from "../../platform/convex/lib/fiscalCaptureRelease";
import * as certificateRuntime from "../../platform/convex/lib/certificateRuntime";
import { distributionXml } from "./distribution";
import { parseDistribution } from "../../packages/fiscal-nfe/src/distribution";
import { createHash } from "node:crypto";
import type { Claim } from "../../platform/convex/lib/operationCore";
import { signApiRequest } from "../../platform/auth-transport";
import { modules } from "./convex-modules";

/**
 * Fixtures of the site capture suites (ADR 0007, phase 4): the development and site profiles, a
 * released company with a production key and the durable source responses. Synthetic transport
 * only.
 */
export const CNPJ = "00000000000191";
export const development = {
  APP_ENV: "development",
  PRODUCT_ENV: "sandbox",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  EMAIL_MODE: "local",
  WEBHOOK_MODE: "disabled",
  SITE_URL: "http://localhost:5209",
  CONVEX_SITE_URL: "http://127.0.0.1:3269",
  BETTER_AUTH_SECRET: "synthetic-site-capture",
};
export const site = {
  APP_ENV: "installation",
  PRODUCT_ENV: "sandbox",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  EMAIL_MODE: "disabled",
  WEBHOOK_MODE: "disabled",
  AUTH_PROXY_MODE: "signed",
  AUTH_PROXY_SECRET: "b".repeat(64),
  SITE_URL: "https://console.operator.invalid",
  CONVEX_SITE_URL: "https://api.operator.invalid",
  API_URL: "https://rest.operator.invalid",
  BETTER_AUTH_SECRET: "synthetic-site-capture",
  FNFE_CAPTURE_FISCAL: "enabled",
  FNFE_CAPTURE_TRANSPORT: "sefaz",
};
export const stub = (profile: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(profile)) vi.stubEnv(name, value);
};
/** A released company with a production key, built locally, then served by the site profile. */
export async function siteFixture(options: { released?: boolean; plan?: boolean } = {}) {
  const t = convexTest(schema, modules);
  register(t);
  const secret = `fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`;
  const keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  await t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", scope.keyId))!;
    const scopes = [...key.scopes, "connections:read", "documents:read"] as const;
    await ctx.db.patch("apiKeys", key._id, {
      scopes: [...scopes],
      environment: "production",
      expiresAt: Date.now() + 10 * 86400_000,
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: [...scopes],
      environments: ["sandbox", "production"],
    });
    await ctx.db.patch("companies", scope.companyId, { kind: "declared", cnpj: CNPJ });
    const id = await ctx.db.insert("certificates", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      version: 1,
      state: "active",
      uploaderId: "proof",
      membershipId: key.creatorMembershipId,
      membershipVersion: 1,
      metadata: {
        fingerprint: "c".repeat(64),
        subject: "test",
        cnpj: CNPJ,
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
  const setRelease = (released: boolean, minIntervalHours = 1) =>
    t.run(async (ctx) => {
      const prior = await ctx.db
        .query("captureReleases")
        .withIndex("by_companyId", (q) => q.eq("companyId", scope.companyId))
        .unique();
      const version = (prior?.version ?? 0) + 1;
      const base = {
        organizationId: scope.organizationId,
        companyId: scope.companyId,
        released,
        blocked: false,
        minIntervalHours,
      };
      const eventId = await ctx.db.insert("captureReleaseEvents", {
        ...base,
        version,
        kind: released ? "console_release" : "console_withdraw",
        ...(released ? { terms: CAPTURE_TERMS_VERSION } : {}),
        revokedKeys: 0,
        reason: "Liberação sintética",
        buildSha: null,
        deployment: "",
        createdAt: Date.now(),
      });
      const state = {
        ...base,
        releasedBefore: true,
        actor: "member:synthetic",
        reason: "Liberação sintética",
        version,
        updatedAt: Date.now(),
        eventId,
      };
      if (prior) await ctx.db.replace("captureReleases", prior._id, state);
      else await ctx.db.insert("captureReleases", state);
    });
  if (options.released ?? true) await setRelease(true);
  // Production capture requires the organization's plan with finite quotas (#429); the tests
  // without it pass `plan: false`.
  if (options.plan ?? true) await capturePlan(t, scope.organizationId);
  stub(site);
  const command = async (environment: "sandbox" | "production", action?: "activate") =>
    JSON.parse(
      await t.mutation(internal.captureRest.dispatch, {
        keyHash,
        environment,
        companyId: scope.companyId,
        ...(action ? { action } : {}),
      }),
    ) as { id: Id<"captureStreams">; operationId: Id<"operations"> };
  const claim = async (operationId: Id<"operations">) => {
    const op = (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
    vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
    const claimed = (await t.mutation(internal.operations.claim, {
      operationId,
      generation: op.generation,
    }))!;
    const token = { operationId, generation: claimed.generation, fence: claimed.fence };
    await t.mutation(internal.operations.beginEffect, token);
    return token;
  };
  return { t, scope, keyHash, secret, command, claim, setRelease };
}
export type SiteFixture = Awaited<ReturnType<typeof siteFixture>>;
/** The public REST of the site, signed like the Worker: an installation refuses direct calls. */
export async function rest(f: SiteFixture, secret: string, method: "GET" | "POST", body?: unknown) {
  const path =
    method === "GET" ? `/v1/connections/nfe?companyId=${f.scope.companyId}` : "/v1/connections/nfe";
  const signed = await signApiRequest(
    { method, url: site.CONVEX_SITE_URL + path },
    "203.0.113.9",
    site.AUTH_PROXY_SECRET,
  );
  const response = await f.t.fetch(path, {
    method,
    headers: {
      ...signed,
      Authorization: `Bearer ${secret}`,
      "X-Environment": "production",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
/**
 * A production key for `f`'s company held by someone else: another project of the same
 * organization, granted the company, or a project of another organization, granted nothing here.
 */
export async function foreignKey(f: SiteFixture, owner: "project" | "organization") {
  const secret = `fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "b")}`;
  const keyHash = await hashApiKey(secret);
  const scopes = ["connections:read", "connections:write", "documents:read"] as const;
  if (owner === "organization") {
    // The synthetic organization is prepared on the local profile, as `siteFixture` does.
    vi.unstubAllEnvs();
    stub(development);
    const other = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash,
      suffix: crypto.randomUUID(),
    });
    vi.unstubAllEnvs();
    stub(site);
    await f.t.run((ctx) =>
      ctx.db.patch("apiKeys", other.keyId, {
        scopes: [...scopes],
        environment: "production",
        expiresAt: Date.now() + 10 * 86400_000,
      }),
    );
    return secret;
  }
  await f.t.run(async (ctx) => {
    const own = (await ctx.db.get("projects", f.scope.projectId))!;
    const projectId = await ctx.db.insert("projects", {
      ...pick(own),
      name: "Outro projeto",
      externalReference: crypto.randomUUID(),
    });
    await ctx.db.insert("projectCompanies", {
      organizationId: f.scope.organizationId,
      projectId,
      companyId: f.scope.companyId,
      scopes: [...scopes],
      environments: ["production"],
      active: true,
      version: 1,
      accessEpoch: 0,
    });
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    await ctx.db.insert("apiKeys", {
      ...pick(key),
      projectId,
      keyHash,
      scopes: [...scopes],
      environment: "production",
      companyIds: [f.scope.companyId],
      grantEpochs: [0],
      expiresAt: Date.now() + 10 * 86400_000,
    });
  });
  return secret;
}
export const pick = <T extends { _id: unknown; _creationTime: unknown }>({
  _id,
  _creationTime,
  ...rest
}: T) => rest;
export const transportOk = () =>
  vi.spyOn(certificateRuntime, "transportWithCertificate").mockResolvedValue({
    status: 200,
    body: distributionXml({ status: "137", last: 0, max: 0, environment: "1" }),
  });

/** A durable source response through prepare, raw, describe, outcome and checkpoint. */
export async function respond(
  f: Awaited<ReturnType<typeof siteFixture>>,
  token: Claim,
  bytes: Buffer,
) {
  const input = (await f.t.mutation(internal.captureProcessing.prepare, token))!;
  const rawId = await f.t.run((ctx) => ctx.storage.store(new Blob([Uint8Array.from(bytes)])));
  const batchId = (await f.t.mutation(internal.captureProcessing.raw, {
    ...token,
    rawId,
    rawHash: createHash("sha256").update(bytes).digest("hex"),
    nsu: input.nsu,
    mode: input.mode,
  }))!;
  const parsed = parseDistribution(bytes, "production");
  await f.t.mutation(internal.captureProcessing.describe, {
    ...token,
    batchId,
    status: parsed.status,
    lastNsu: parsed.lastNsu,
    maxNsu: parsed.maxNsu,
    count: parsed.envelopes.length,
  });
  for (const [position, e] of parsed.envelopes.entries()) {
    const storageId = await f.t.run((ctx) => ctx.storage.store(new Blob([Uint8Array.from(e.xml)])));
    expect(
      await f.t.mutation(internal.captureProcessing.envelope, {
        ...token,
        batchId,
        position,
        nsu: e.nsu,
        schema: e.schema,
        sha256: e.sha256,
        size: e.xml.length,
        storageId,
      }),
    ).toBe(true);
  }
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "success", response: "{}" },
  });
  await f.t.mutation(internal.operations.checkpoint, token);
}
export const streamOf = (f: Awaited<ReturnType<typeof siteFixture>>, id: Id<"captureStreams">) =>
  f.t.run(async (ctx) => (await ctx.db.get("captureStreams", id))!);
