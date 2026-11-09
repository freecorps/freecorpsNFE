import { convexTest } from "convex-test";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import schema from "../../platform/convex/schema";
import { components, internal } from "../../platform/convex/_generated/api";
import type { Doc, Id } from "../../platform/convex/_generated/dataModel";
import { register } from "../../platform/test-setup";
import { modules } from "./convex-modules";

/**
 * Actors and scopes of the platform integration suites. Each helper grants only what its caller
 * names: role, company grant, scopes and environment stay explicit in every scenario.
 */

export type PlatformTest = ReturnType<typeof platformTest>;
export type Role = Doc<"memberships">["role"];
export type IntegrationScope = Doc<"apiKeys">["scopes"][number];

export const SYNTHETIC_ISSUER_CNPJ = "11222333000181";
export const ISSUANCE_SCOPES = ["documents:issue", "documents:cancel"] as const;

/**
 * A fresh database with the platform's components registered. `overrides` replaces modules by
 * their key in `modules` (`../../platform/convex/<file>.ts`).
 */
export function platformTest(overrides: typeof modules = {}) {
  for (const key of Object.keys(overrides))
    if (!(key in modules)) throw new Error(`platformTest: no module ${key} to override`);
  const t = convexTest(schema, { ...modules, ...overrides });
  register(t);
  return t;
}

/**
 * Stubs the local sandbox environment and fake timers around each test of the calling file, and
 * restores both after it. `now` pins the clock when the suite depends on the date.
 */
export function usePlatformEnvironment(env: {
  siteUrl: string;
  convexSiteUrl: string;
  secret: string;
  now?: number;
}) {
  beforeEach(() => {
    vi.useFakeTimers();
    if (env.now !== undefined) vi.setSystemTime(env.now);
    for (const [key, value] of Object.entries({
      APP_ENV: "development",
      PRODUCT_ENV: "sandbox",
      FISCAL_ENV: "disabled",
      FNFE_CRONS: "off",
      EMAIL_MODE: "local",
      WEBHOOK_MODE: "disabled",
      SITE_URL: env.siteUrl,
      CONVEX_SITE_URL: env.convexSiteUrl,
      BETTER_AUTH_SECRET: env.secret,
    }))
      vi.stubEnv(key, value);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
}

/**
 * An explicit plan with finite `captures` and `bytes` quotas, which every production capture
 * requires (#429). Suites that run that capture assign it in their fixture; the refusals
 * without it are proved in `platform/convex/lib/siteCapture.test.ts`. Synthetic limits, far above a test.
 */
export function capturePlan(
  t: Pick<PlatformTest, "mutation">,
  organizationId: Id<"organizations">,
  limits: Partial<Doc<"usagePlans">["limits"]> = {},
  expectedVersion = 0,
) {
  return t.mutation(internal.usage.assignPlan, {
    organizationId,
    name: "Plano sintético de captura",
    startsAt: 0,
    endsAt: Date.UTC(2100, 0, 1),
    limits: {
      imports: null,
      captures: 100_000,
      registry: null,
      bytes: 1_000_000_000_000,
      deliveries: null,
      ...limits,
    },
    concurrency: 8,
    actor: "test",
    reason: "plano sintético de captura",
    expectedVersion,
  });
}
/** A synthetic API key secret in the platform's format; `fill` pads it to full length. */
export const syntheticApiKey = (fill = "b") =>
  `fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, fill)}`;

/**
 * A Better Auth person with a live session and an active membership of `role`. Only `companyId`
 * adds a company grant; without it, members below admin reach no company.
 */
export async function person(
  t: PlatformTest,
  organizationId: Id<"organizations">,
  role: Role,
  options: { companyId?: Id<"companies"> } = {},
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
  if (options.companyId)
    await companyGrant(t, { organizationId, companyId: options.companyId, membershipId });
  const client = t.withIdentity({
    subject: user._id,
    sessionId: session._id,
    issuer: process.env.CONVEX_SITE_URL,
  });
  return Object.assign(client, { membershipId });
}

/** An active grant of one company to one membership. */
export function companyGrant(
  t: PlatformTest,
  grant: {
    organizationId: Id<"organizations">;
    companyId: Id<"companies">;
    membershipId: Id<"memberships">;
  },
) {
  return t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      ...grant,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
}

/** The grant of `companyId` to `projectId`. */
export function projectGrant(
  t: PlatformTest,
  projectId: Id<"projects">,
  companyId: Id<"companies">,
) {
  return t.run(
    async (ctx) =>
      (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", projectId).eq("companyId", companyId),
        )
        .unique())!,
  );
}

/**
 * Organization, integration project, key and company from `operationProof.prepare`, with the
 * company under the synthetic issuer CNPJ. The project grant and the key gain exactly the scopes
 * passed in `grantScopes` and `keyScopes`.
 */
export async function issuerScope(
  t: PlatformTest,
  options: {
    keyHash: string;
    kind: Doc<"companies">["kind"];
    grantScopes: readonly IntegrationScope[];
    keyScopes: readonly IntegrationScope[];
  },
) {
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash: options.keyHash,
    suffix: crypto.randomUUID(),
  });
  const grant = await projectGrant(t, scope.projectId, scope.companyId);
  await t.run(async (ctx) => {
    await ctx.db.patch("companies", scope.companyId, {
      cnpj: SYNTHETIC_ISSUER_CNPJ,
      kind: options.kind,
    });
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: [...grant.scopes, ...options.grantScopes],
    });
    const key = (await ctx.db.get("apiKeys", scope.keyId))!;
    await ctx.db.patch("apiKeys", key._id, { scopes: [...key.scopes, ...options.keyScopes] });
  });
  return scope;
}

export const softwareLicense = {
  code: "licenca",
  label: "Licenciamento de software",
  cnae: "6203100",
  lc116Item: "01.05",
  cTribNac: "010501",
  nbs: "111032200",
};
export type ProfileFields = Partial<Omit<Doc<"nfseProfiles">, "_id" | "_creationTime">>;

/** An NFS-e profile in São Paulo (Sefin Nacional) offering `softwareLicense`, unless overridden. */
export function nfseProfile(
  t: PlatformTest,
  scope: { organizationId: Id<"organizations">; companyId: Id<"companies"> },
  fields: ProfileFields = {},
) {
  return t.run((ctx) =>
    ctx.db.insert("nfseProfiles", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      municipalityCode: "3550308",
      opSimpNac: 1,
      regEspTrib: 0,
      dpsSeries: "1",
      activities: [softwareLicense],
      version: 1,
      updatedBy: "synthetic",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...fields,
    }),
  );
}
