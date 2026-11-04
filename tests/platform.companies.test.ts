import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { api, components, internal } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
import type { Id } from "../platform/convex/_generated/dataModel";
import type { MembershipRole } from "../packages/contracts/src/organizations";
import { modules } from "./helpers/convex-modules";
const contextKey = "company-proof",
  paginationOpts = { numItems: 50, cursor: null };
const input = {
  cnpj: "00000000000191",
  name: "Empresa sintética",
  address: {
    street: "Rua sintética",
    number: "1",
    complement: "",
    district: "Centro",
    city: "Cidade sintética",
    state: "SP",
    postalCode: "01000-000",
  },
};
beforeEach(() => {
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5187",
    CONVEX_SITE_URL: "http://127.0.0.1:3233",
    BETTER_AUTH_SECRET: "synthetic-secret-for-local-company-tests",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}
async function actor(t: ReturnType<typeof setup>, verified = true) {
  const now = Date.now(),
    email = `${crypto.randomUUID()}@development.invalid`;
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Pessoa de teste",
        email,
        emailVerified: verified,
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
  return {
    user,
    client: t.withIdentity({
      subject: user._id,
      sessionId: session._id,
      issuer: "http://127.0.0.1:3233",
    }),
  };
}
async function fixture() {
  const t = setup(),
    owner = await actor(t);
  const org = await owner.client.mutation(api.organizations.create, {
    name: "Equipe sintética",
    slug: `org-${crypto.randomUUID()}`,
  });
  const created = await owner.client.mutation(api.companies.create, {
    ...input,
    organizationId: org.organizationId,
  });
  return {
    t,
    owner,
    org,
    scope: { organizationId: org.organizationId, companyId: created.companyId },
  };
}
async function member(
  t: ReturnType<typeof setup>,
  organizationId: Id<"organizations">,
  role: MembershipRole,
) {
  const person = await actor(t);
  const membershipId = await t.run((ctx) =>
    ctx.db.insert("memberships", {
      organizationId,
      authUserId: person.user._id,
      name: person.user.name,
      email: person.user.email,
      role,
      state: "active",
      version: 1,
      joinedAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  // Denormalized membership count is part of the fixture, as in a real acceptance transaction.
  await t.run(async (ctx) => {
    const org = (await ctx.db.get("organizations", organizationId))!;
    await ctx.db.patch("organizations", organizationId, {
      memberCount: org.memberCount + 1,
      ownerCount: org.ownerCount + Number(role === "owner"),
    });
  });
  return { ...person, membershipId };
}
it("requires verified live identity before validation or data access", async () => {
  const { t, scope } = await fixture();
  const unverified = await actor(t, false);
  await expect(
    t.query(api.companies.list, {
      organizationId: scope.organizationId,
      contextKey,
      paginationOpts,
    }),
  ).rejects.toThrow();
  await expect(
    unverified.client.mutation(api.companies.create, {
      ...input,
      organizationId: scope.organizationId,
    }),
  ).rejects.toThrow();
});
it.each(["not-an-id", "", "organization-id"])(
  "untrusted company route %s returns the unavailable state",
  async (route) => {
    const { owner, scope } = await fixture();
    const value = route === "organization-id" ? String(scope.organizationId) : route;
    expect(
      await owner.client.query(api.companies.get, {
        ...scope,
        companyId: value as Id<"companies">,
        contextKey,
      }),
    ).toBeNull();
  },
);
it("concurrent creation returns one identity without replacing confirmed fields", async () => {
  const { t, owner, scope } = await fixture();
  const replies = await Promise.all(
    [1, 2].map((i) =>
      owner.client.mutation(api.companies.create, {
        ...input,
        name: `Overwrite ${i}`,
        organizationId: scope.organizationId,
      }),
    ),
  );
  expect(replies).toEqual([
    { companyId: scope.companyId, reused: true },
    { companyId: scope.companyId, reused: true },
  ]);
  const company = await owner.client.query(api.companies.get, { ...scope, contextKey });
  expect(company).toMatchObject({
    name: input.name,
    cnpj: input.cnpj,
    address: { postalCode: "01000000" },
    fiscalAccess: "not-configured",
    registryStatus: "not-consulted",
  });
  expect(await t.run((ctx) => ctx.db.query("companies").collect())).toHaveLength(1);
  const fresh = await owner.client.mutation(api.organizations.create, {
    name: "Concorrência",
    slug: `new-${crypto.randomUUID()}`,
  });
  const first = await Promise.all(
    [1, 2].map(() =>
      owner.client.mutation(api.companies.create, {
        ...input,
        organizationId: fresh.organizationId,
      }),
    ),
  );
  expect(first[0].companyId).toBe(first[1].companyId);
  expect(first.filter((r) => !r.reused)).toHaveLength(1);
});
it("the same CNPJ belongs independently to two organizations and forged IDs never cross them", async () => {
  const { t, owner, scope } = await fixture();
  const outsider = await actor(t);
  const org = await outsider.client.mutation(api.organizations.create, {
    name: "Outra equipe",
    slug: `other-${crypto.randomUUID()}`,
  });
  const second = await outsider.client.mutation(api.companies.create, {
    ...input,
    organizationId: org.organizationId,
  });
  const foreignMember = await member(t, org.organizationId, "operator");
  await expect(
    owner.client.mutation(api.companies.setGrant, {
      ...scope,
      membershipId: foreignMember.membershipId,
      allowed: true,
      expectedMembershipVersion: 1,
      expectedGrantVersion: 0,
    }),
  ).rejects.toThrow("ACCESS_DENIED");
  expect(await t.run((ctx) => ctx.db.query("companyGrants").collect())).toEqual([]);
  expect(second.reused).toBe(false);
  expect(second.companyId).not.toBe(scope.companyId);
  expect(
    await owner.client.query(api.companies.get, {
      ...scope,
      companyId: second.companyId,
      contextKey,
    }),
  ).toBeNull();
  await expect(
    outsider.client.query(api.companies.list, {
      organizationId: scope.organizationId,
      paginationOpts,
      contextKey,
    }),
  ).rejects.toThrow();
  await expect(
    owner.client.mutation(api.companies.update, {
      ...scope,
      companyId: second.companyId,
      name: input.name,
      address: input.address,
      expectedVersion: 1,
    }),
  ).rejects.toThrow("ACCESS_DENIED");
  await expect(
    owner.client.mutation(api.onboarding.selectCompany, {
      ...scope,
      companyId: second.companyId,
      expectedVersion: 1,
    }),
  ).rejects.toThrow();
});
it("a granted operator loses document capability immediately after becoming a developer", async () => {
  const { t, owner, scope } = await fixture();
  const person = await member(t, scope.organizationId, "operator");
  await owner.client.mutation(api.companies.setGrant, {
    ...scope,
    membershipId: person.membershipId,
    allowed: true,
    expectedMembershipVersion: 1,
    expectedGrantVersion: 0,
  });
  const before = await person.client.query(api.companies.get, { ...scope, contextKey });
  expect(before?.capabilities.operateDocuments).toBe(true);
  await owner.client.mutation(api.organizations.changeRole, {
    organizationId: scope.organizationId,
    membershipId: person.membershipId,
    role: "developer",
    expectedVersion: 1,
  });
  const after = await person.client.query(api.companies.get, { ...scope, contextKey });
  expect(after?.capabilities).toEqual({ read: true, manage: false, operateDocuments: false });
  expect(after?.accessVersion).not.toBe(before?.accessVersion);
});
it("invalid address and empty name never overwrite confirmed company fields", async () => {
  const { owner, scope } = await fixture();
  for (const change of [
    { name: "", address: input.address },
    { name: input.name, address: { ...input.address, state: "XX" } },
  ]) {
    await expect(
      owner.client.mutation(api.companies.update, { ...scope, ...change, expectedVersion: 1 }),
    ).rejects.toThrow();
  }
  expect(await owner.client.query(api.companies.get, { ...scope, contextKey })).toMatchObject({
    name: input.name,
    version: 1,
    address: { state: "SP" },
  });
});
it.each(["developer", "operator", "viewer"] as const)(
  "%s only reads companies explicitly granted and cannot change its own grants",
  async (role) => {
    const { t, owner, scope } = await fixture(),
      person = await member(t, scope.organizationId, role);
    const second = await owner.client.mutation(api.companies.create, {
      ...input,
      cnpj: "12ABC34501DE35",
      organizationId: scope.organizationId,
    });
    expect(await person.client.query(api.companies.get, { ...scope, contextKey })).toBeNull();
    expect(
      (
        await person.client.query(api.companies.list, {
          organizationId: scope.organizationId,
          paginationOpts,
          contextKey,
        })
      ).page,
    ).toEqual([]);
    await owner.client.mutation(api.companies.setGrant, {
      ...scope,
      membershipId: person.membershipId,
      allowed: true,
      expectedMembershipVersion: 1,
      expectedGrantVersion: 0,
    });
    const list = await person.client.query(api.companies.list, {
      organizationId: scope.organizationId,
      paginationOpts,
      contextKey,
    });
    expect(list.page.map((c) => c.id)).toEqual([scope.companyId]);
    expect(
      await person.client.query(api.companies.get, {
        ...scope,
        companyId: second.companyId,
        contextKey,
      }),
    ).toBeNull();
    expect(
      (await person.client.query(api.companies.get, { ...scope, contextKey }))?.capabilities,
    ).toEqual({ read: true, manage: false, operateDocuments: role === "operator" });
    await expect(
      person.client.mutation(api.companies.create, {
        ...input,
        organizationId: scope.organizationId,
      }),
    ).rejects.toThrow();
    await expect(
      person.client.mutation(api.companies.update, {
        ...scope,
        name: "Forbidden",
        address: input.address,
        expectedVersion: 1,
      }),
    ).rejects.toThrow();
    await expect(
      person.client.mutation(api.companies.setGrant, {
        ...scope,
        membershipId: person.membershipId,
        allowed: true,
        expectedMembershipVersion: 1,
        expectedGrantVersion: 1,
      }),
    ).rejects.toThrow();
    await expect(
      person.client.mutation(api.onboarding.start, {
        organizationId: scope.organizationId,
        mode: "manual",
        expectedVersion: 1,
      }),
    ).rejects.toThrow();
    await owner.client.mutation(api.companies.setGrant, {
      ...scope,
      membershipId: person.membershipId,
      allowed: false,
      expectedMembershipVersion: 1,
      expectedGrantVersion: 1,
    });
    expect(await person.client.query(api.companies.get, { ...scope, contextKey })).toBeNull();
    expect(
      (
        await person.client.query(api.onboarding.get, {
          organizationId: scope.organizationId,
          contextKey,
        })
      ).company,
    ).toBeNull();
  },
);
it("manager access is inherited and cannot be replaced by a self-grant", async () => {
  const { t, owner, scope } = await fixture(),
    admin = await member(t, scope.organizationId, "admin");
  await admin.client.mutation(api.companies.update, {
    ...scope,
    name: "Atualizada",
    address: input.address,
    expectedVersion: 1,
  });
  expect((await owner.client.query(api.companies.get, { ...scope, contextKey }))?.name).toBe(
    "Atualizada",
  );
  await expect(
    admin.client.mutation(api.companies.setGrant, {
      ...scope,
      membershipId: admin.membershipId,
      allowed: false,
      expectedMembershipVersion: 1,
      expectedGrantVersion: 0,
    }),
  ).rejects.toThrow();
  await owner.client.mutation(api.organizations.changeRole, {
    organizationId: scope.organizationId,
    membershipId: admin.membershipId,
    expectedVersion: 1,
    role: "viewer",
  });
  expect(await admin.client.query(api.companies.get, { ...scope, contextKey })).toBeNull();
});
it("membership removal and acceptance of a new invite never revive an old company grant", async () => {
  const { t, owner, scope } = await fixture(),
    person = await member(t, scope.organizationId, "operator");
  await owner.client.mutation(api.companies.setGrant, {
    ...scope,
    membershipId: person.membershipId,
    allowed: true,
    expectedMembershipVersion: 1,
    expectedGrantVersion: 0,
  });
  await owner.client.mutation(api.organizations.removeMember, {
    organizationId: scope.organizationId,
    membershipId: person.membershipId,
    expectedVersion: 1,
  });
  await expect(person.client.query(api.companies.get, { ...scope, contextKey })).rejects.toThrow();
  await owner.client.action(api.invitations.send, {
    organizationId: scope.organizationId,
    email: person.user.email,
    role: "operator",
  });
  const token = (await t.query(internal.mail.inbox, { email: person.user.email })).find(
    (m) => m.type === "organization-invitation",
  )!.otp;
  await person.client.action(api.invitations.accept, { token });
  expect(await person.client.query(api.companies.get, { ...scope, contextKey })).toBeNull();
  expect(
    (
      await person.client.query(api.companies.list, {
        organizationId: scope.organizationId,
        paginationOpts,
        contextKey,
      })
    ).page,
  ).toEqual([]);
  await owner.client.mutation(api.companies.setGrant, {
    ...scope,
    membershipId: person.membershipId,
    allowed: true,
    expectedMembershipVersion: 3,
    expectedGrantVersion: 1,
  });
  expect(await person.client.query(api.companies.get, { ...scope, contextKey })).not.toBeNull();
});
it("rejects stale edits and grants and records audit events", async () => {
  const { t, owner, scope } = await fixture(),
    person = await member(t, scope.organizationId, "viewer");
  await owner.client.mutation(api.companies.update, {
    ...scope,
    name: "Editada",
    address: input.address,
    expectedVersion: 1,
  });
  await expect(
    owner.client.mutation(api.companies.update, {
      ...scope,
      name: "Antiga",
      address: input.address,
      expectedVersion: 1,
    }),
  ).rejects.toThrow("COMPANY_CHANGED");
  await owner.client.mutation(api.companies.setGrant, {
    ...scope,
    membershipId: person.membershipId,
    allowed: true,
    expectedMembershipVersion: 1,
    expectedGrantVersion: 0,
  });
  await expect(
    owner.client.mutation(api.companies.setGrant, {
      ...scope,
      membershipId: person.membershipId,
      allowed: false,
      expectedMembershipVersion: 1,
      expectedGrantVersion: 0,
    }),
  ).rejects.toThrow("GRANT_CHANGED");
  const actions = (
    await owner.client.query(api.companies.activity, { ...scope, paginationOpts, contextKey })
  ).page.map((a) => a.action);
  expect(actions).toEqual(["company.granted", "company.updated", "company.created"]);
});
it("persists manual onboarding, chosen company and dismissal without declaring a first document or fiscal access", async () => {
  const { owner, scope } = await fixture();
  const get = () =>
    owner.client.query(api.onboarding.get, {
      organizationId: scope.organizationId,
      contextKey: crypto.randomUUID(),
    });
  expect(await get()).toMatchObject({
    mode: "manual",
    company: { id: scope.companyId },
    version: 1,
    firstDocument: "pending-import",
    certificateRequired: false,
  });
  await owner.client.mutation(api.onboarding.dismissGuidance, {
    organizationId: scope.organizationId,
    expectedVersion: 1,
  });
  expect(await get()).toMatchObject({ guidanceDismissed: true, firstDocument: "pending-import" });
  const second = await owner.client.mutation(api.companies.create, {
    ...input,
    cnpj: "12ABC34501DE35",
    organizationId: scope.organizationId,
  });
  await expect(
    owner.client.mutation(api.onboarding.selectCompany, {
      organizationId: scope.organizationId,
      companyId: second.companyId,
      expectedVersion: 1,
    }),
  ).rejects.toThrow("ONBOARDING_CHANGED");
  await owner.client.mutation(api.onboarding.selectCompany, {
    organizationId: scope.organizationId,
    companyId: second.companyId,
    expectedVersion: 2,
  });
  expect((await get()).company?.id).toBe(second.companyId);
});
it("starts a repeatable synthetic sandbox without PFX and refuses reclassifying a declared company as demo", async () => {
  const { owner, scope } = await fixture();
  const args = {
    organizationId: scope.organizationId,
    mode: "demonstration" as const,
    expectedVersion: 1,
  };
  const results = await Promise.all([
    owner.client.mutation(api.onboarding.start, args),
    owner.client.mutation(api.onboarding.start, args),
  ]);
  expect(results[0].companyId).toBe(results[1].companyId);
  const demo = await owner.client.query(api.companies.get, {
    ...scope,
    companyId: results[0].companyId!,
    contextKey,
  });
  expect(demo).toMatchObject({ kind: "demonstration", fiscalAccess: "not-configured" });
  await expect(
    owner.client.mutation(api.companies.update, {
      ...scope,
      companyId: demo!.id,
      name: "Real",
      address: input.address,
      expectedVersion: 1,
    }),
  ).rejects.toThrow("DEMONSTRATION_READ_ONLY");
  await expect(
    owner.client.mutation(api.companies.create, {
      ...input,
      cnpj: "12ABC34501DE35",
      organizationId: scope.organizationId,
    }),
  ).rejects.toThrow("COMPANY_KIND_CONFLICT");
});
it.each(["12ABC34501DE34", "12ABC34501DE3A", "00000000000000"])(
  "rejects invalid CNPJ %s in the actual mutation",
  async (cnpj) => {
    const { owner, scope } = await fixture();
    await expect(
      owner.client.mutation(api.companies.create, {
        ...input,
        cnpj,
        organizationId: scope.organizationId,
      }),
    ).rejects.toThrow("INVALID_CNPJ");
  },
);
it("deletes a company registered by mistake, with its configuration, only for a manager who types the CNPJ", async () => {
  const { t, owner, scope } = await fixture();
  const other = await member(t, scope.organizationId, "operator");
  const company = (await owner.client.query(api.companies.get, { ...scope, contextKey }))!;
  await owner.client.mutation(api.companies.setGrant, {
    ...scope,
    membershipId: other.membershipId,
    allowed: true,
    expectedMembershipVersion: 1,
    expectedGrantVersion: 0,
  });
  // A rejected upload is an attempt, not history: it goes with the company.
  await t.run((ctx) =>
    ctx.db.insert("certificates", {
      ...scope,
      version: 1,
      state: "rejected",
      uploaderId: owner.user._id,
      membershipId: other.membershipId,
      membershipVersion: 1,
      envelopeRevision: 0,
      code: "CERTIFICATE_IDENTITY",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await expect(
    other.client.mutation(api.companies.remove, {
      ...scope,
      expectedVersion: company.version,
      confirmation: input.cnpj,
    }),
  ).rejects.toThrow(/ACCESS_DENIED/);
  expect(await other.client.query(api.companies.deletion, { ...scope, contextKey })).toEqual({
    allowed: false,
  });
  expect(await owner.client.query(api.companies.deletion, { ...scope, contextKey })).toEqual({
    allowed: true,
  });
  await expect(
    owner.client.mutation(api.companies.remove, {
      ...scope,
      expectedVersion: company.version,
      confirmation: "11222333000181",
    }),
  ).rejects.toThrow(/CONFIRMATION_MISMATCH/);
  await expect(
    owner.client.mutation(api.companies.remove, {
      ...scope,
      expectedVersion: company.version - 1,
      confirmation: input.cnpj,
    }),
  ).rejects.toThrow(/COMPANY_CHANGED/);
  const outsider = await actor(t);
  await expect(
    outsider.client.mutation(api.companies.remove, {
      ...scope,
      expectedVersion: company.version,
      confirmation: input.cnpj,
    }),
  ).rejects.toThrow();

  await owner.client.mutation(api.companies.remove, {
    ...scope,
    expectedVersion: company.version,
    confirmation: "00.000.000/0001-91",
  });
  expect(await owner.client.query(api.companies.get, { ...scope, contextKey })).toBeNull();
  expect(await owner.client.query(api.companies.deletion, { ...scope, contextKey })).toEqual({
    allowed: false,
  });
  const left = await t.run(async (ctx) => ({
    grants: await ctx.db.query("companyGrants").collect(),
    audit: await ctx.db.query("companyAudit").collect(),
    certificates: await ctx.db.query("certificates").collect(),
    onboarding: await ctx.db.query("onboarding").collect(),
    trail: await ctx.db.query("operationalAudit").collect(),
  }));
  expect(left.grants).toEqual([]);
  expect(left.audit).toEqual([]);
  expect(left.certificates).toEqual([]);
  expect(left.onboarding.every((row) => row.companyId === undefined)).toBe(true);
  expect(left.trail.some((row) => row.action === "company.deleted")).toBe(true);
  // The CNPJ is free again for the correct registration.
  const again = await owner.client.mutation(api.companies.create, {
    ...input,
    organizationId: scope.organizationId,
  });
  expect(again.reused).toBe(false);
});
it("keeps a company with history or an accepted certificate", async () => {
  const { t, owner, scope } = await fixture();
  const membershipId = await t.run(
    async (ctx) =>
      (await ctx.db
        .query("memberships")
        .withIndex("by_organizationId_and_state", (q) =>
          q.eq("organizationId", scope.organizationId).eq("state", "active"),
        )
        .first())!._id,
  );
  const certificateId = await t.run((ctx) =>
    ctx.db.insert("certificates", {
      ...scope,
      version: 1,
      state: "validating",
      uploaderId: owner.user._id,
      membershipId,
      membershipVersion: 1,
      envelopeRevision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  const remove = () =>
    owner.client.mutation(api.companies.remove, {
      ...scope,
      expectedVersion: 1,
      confirmation: input.cnpj,
    });
  // Still being validated: the worker must not finish on a removed company.
  await expect(remove()).rejects.toThrow(/COMPANY_HAS_HISTORY/);
  await t.run((ctx) => ctx.db.patch("certificates", certificateId, { state: "rejected" }));
  const projectId = await t.run((ctx) =>
    ctx.db.insert("projects", {
      organizationId: scope.organizationId,
      name: "Integração sintética",
      externalReference: "sintetica",
      state: "active",
      version: 1,
      accessEpoch: 0,
      creatorMembershipId: membershipId,
      creatorEpoch: 0,
      createdAt: Date.now(),
    }),
  );
  // A revoked project grant is history too: operations and keys may point at it.
  await t.run((ctx) =>
    ctx.db.insert("projectCompanies", {
      organizationId: scope.organizationId,
      projectId,
      companyId: scope.companyId,
      scopes: [],
      environments: [],
      active: false,
      version: 2,
      accessEpoch: 0,
    }),
  );
  expect(await owner.client.query(api.companies.deletion, { ...scope, contextKey })).toEqual({
    allowed: false,
  });
  await expect(remove()).rejects.toThrow(/COMPANY_HAS_HISTORY/);
  expect(await owner.client.query(api.companies.get, { ...scope, contextKey })).not.toBeNull();
});
it("never deletes the sandbox demonstration", async () => {
  const { t, owner, scope } = await fixture();
  await t.run((ctx) => ctx.db.patch("companies", scope.companyId, { kind: "demonstration" }));
  await expect(
    owner.client.mutation(api.companies.remove, {
      ...scope,
      expectedVersion: 1,
      confirmation: input.cnpj,
    }),
  ).rejects.toThrow(/DEMONSTRATION_READ_ONLY/);
});

// Pre-creation registry lookup (#511). Synthetic CNPJs of `scripts/public-copy/public-identifiers.test.ts`.
const consulted = "11222333000181";
const provider = (cnpj: string) => ({
  cnpj,
  razao_social: "Razão social da fonte sintética",
  situacao_cadastral: "Ativa",
  tipo_logradouro: "Avenida",
  logradouro: "Consultada",
  numero: "100",
  complemento: "",
  bairro: "Bairro sintético",
  municipio: "Cidade da fonte",
  uf: "RJ",
  cep: "20000000",
});
async function lookupFixture() {
  vi.useFakeTimers();
  const f = await fixture();
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      Response.json(provider(String(url).split("/").pop()!.split("?")[0]!)),
    );
  vi.stubGlobal("fetch", transport);
  const organizationId = f.scope.organizationId;
  const lookup = (cnpj: string, key: string, client = f.owner.client) =>
    client.mutation(api.registry.lookup, { organizationId, cnpj, key });
  const status = (lookupId: Id<"registryLookups">, client = f.owner.client) =>
    client.query(api.registry.lookupStatus, { organizationId, lookupId });
  // Runs the provider call the lookup scheduled, without reaching the 24 h expiry.
  const settle = async () => {
    vi.advanceTimersByTime(1);
    await f.t.finishInProgressScheduledFunctions();
  };
  const usage = () =>
    f.t.run(async (ctx) =>
      (await ctx.db.query("usageEvents").collect()).filter((e) => e.metric === "registry"),
    );
  return { ...f, transport, lookup, status, settle, usage };
}
it("consulta o CNPJ antes do cadastro e cria a empresa com a origem cadastral", async () => {
  const f = await lookupFixture();
  const first = await f.lookup("11.222.333/0001-81", "lookup-key-0001");
  if (first.kind !== "lookup") throw new Error("expected a lookup");
  expect(first.reused).toBe(false);
  expect(await f.status(first.lookupId)).toMatchObject({ state: "pending", data: null });
  await f.settle();
  const found = await f.status(first.lookupId);
  expect(found).toMatchObject({
    cnpj: consulted,
    state: "found",
    provider: "opencnpj",
    sourceUpdatedAt: null,
    data: { name: "Razão social da fonte sintética", address: { city: "Cidade da fonte" } },
  });
  expect(found.consultedAt).toEqual(expect.any(Number));
  // Same key: same lookup. Another key: the fresh cache answers. One call, one charge.
  expect(await f.lookup(consulted, "lookup-key-0001")).toEqual({ ...first, reused: true });
  const second = await f.lookup(consulted, "lookup-key-0002");
  if (second.kind !== "lookup") throw new Error("expected a lookup");
  expect(await f.status(second.lookupId)).toMatchObject({
    state: "found",
    cacheVersion: found.cacheVersion,
  });
  await expect(f.lookup(input.cnpj, "lookup-key-0001")).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
  expect(f.transport).toHaveBeenCalledTimes(1);
  // Charged in the deployment's environment; the caller cannot name another one.
  expect(await f.usage()).toMatchObject([{ environment: "sandbox", state: "committed" }]);
  await expect(
    f.owner.client.mutation(api.registry.lookup, {
      organizationId: f.scope.organizationId,
      cnpj: "12345678000195",
      key: "lookup-key-prod",
      environment: "production",
    } as never),
  ).rejects.toThrow();

  const create = (registry: {
    lookupId: Id<"registryLookups">;
    expectedCacheVersion: number;
    fields: ("name" | "address")[];
  }) =>
    f.owner.client.mutation(api.companies.create, {
      ...input,
      cnpj: consulted,
      name: "Nome digitado",
      organizationId: f.scope.organizationId,
      registry,
    });
  const choice = { lookupId: first.lookupId, expectedCacheVersion: found.cacheVersion! };
  await expect(
    create({ ...choice, expectedCacheVersion: found.cacheVersion! + 1, fields: ["name"] }),
  ).rejects.toThrow(/REGISTRY_CHANGED/);
  const created = await create({ ...choice, fields: ["name"] });
  expect(created.reused).toBe(false);
  const company = await f.t.run((ctx) => ctx.db.get("companies", created.companyId));
  expect(company).toMatchObject({
    name: "Razão social da fonte sintética",
    address: { city: input.address.city, postalCode: "01000000" },
    fieldSources: { name: "registry", address: "declared" },
  });
  const history = await f.t.run((ctx) => ctx.db.query("registryApplications").collect());
  expect(history).toMatchObject([
    {
      companyId: created.companyId,
      actorUserId: f.owner.user._id,
      fields: ["name"],
      before: { name: "Nome digitado" },
      after: { name: "Razão social da fonte sintética" },
      consultedAt: found.consultedAt,
    },
  ]);
  // The company now exists: no lookup, and a later create reuses it without overwriting.
  expect(await f.lookup(consulted, "lookup-key-0003")).toEqual({
    kind: "existing",
    companyId: created.companyId,
  });
  expect(await create({ ...choice, fields: ["name", "address"] })).toEqual({
    companyId: created.companyId,
    reused: true,
  });
  expect(await f.t.run((ctx) => ctx.db.get("companies", created.companyId))).toEqual(company);
  expect(f.transport).toHaveBeenCalledTimes(1);
});
it("restrição posterior à consulta recusa o cadastro como consulta alterada, sem revelar a restrição", async () => {
  const f = await lookupFixture();
  const result = await f.lookup(consulted, "lookup-key-0301");
  if (result.kind !== "lookup") throw new Error("expected a lookup");
  await f.settle();
  const { cacheVersion } = await f.status(result.lookupId);
  await f.t.mutation(internal.registryStore.restrict, {
    cnpj: consulted,
    blocked: true,
    reference: "D02-SYNTHETIC-511-B",
    actor: "privacy-test",
    expectedVersion: 0,
  });
  expect(await f.status(result.lookupId)).toMatchObject({ state: "unavailable", data: null });
  await expect(
    f.owner.client.mutation(api.companies.create, {
      ...input,
      cnpj: consulted,
      organizationId: f.scope.organizationId,
      registry: {
        lookupId: result.lookupId,
        expectedCacheVersion: cacheVersion!,
        fields: ["name"],
      },
    }),
  ).rejects.toThrow(/REGISTRY_CHANGED/);
});
it("consulta antes do cadastro só para owner/admin da organização dona da consulta", async () => {
  const f = await lookupFixture();
  const admin = await member(f.t, f.scope.organizationId, "admin");
  const mine = await f.lookup(consulted, "lookup-key-0101", admin.client);
  if (mine.kind !== "lookup") throw new Error("expected a lookup");
  await f.settle();
  const { cacheVersion } = await f.status(mine.lookupId);
  for (const role of ["operator", "developer", "viewer"] as const) {
    const person = await member(f.t, f.scope.organizationId, role);
    await expect(f.lookup(consulted, `lookup-key-${role}`, person.client)).rejects.toThrow();
    await expect(f.status(mine.lookupId, person.client)).rejects.toThrow();
  }
  const outsider = await actor(f.t);
  await expect(f.lookup(consulted, "lookup-key-0102", outsider.client)).rejects.toThrow();
  await expect(f.status(mine.lookupId, outsider.client)).rejects.toThrow();
  // Another organization's owner: the lookup ID is not proof of access to its answer.
  const other = await outsider.client.mutation(api.organizations.create, {
    name: "Outra equipe",
    slug: `other-${crypto.randomUUID()}`,
  });
  await expect(
    outsider.client.query(api.registry.lookupStatus, {
      organizationId: other.organizationId,
      lookupId: mine.lookupId,
    }),
  ).rejects.toThrow();
  await expect(
    outsider.client.mutation(api.companies.create, {
      ...input,
      cnpj: consulted,
      organizationId: other.organizationId,
      registry: { lookupId: mine.lookupId, expectedCacheVersion: cacheVersion!, fields: ["name"] },
    }),
  ).rejects.toThrow(/ACCESS_DENIED/);
  // Even when the company already exists there, a foreign lookup is refused, not ignored.
  await outsider.client.mutation(api.companies.create, {
    ...input,
    cnpj: consulted,
    organizationId: other.organizationId,
  });
  await expect(
    outsider.client.mutation(api.companies.create, {
      ...input,
      cnpj: consulted,
      organizationId: other.organizationId,
      registry: { lookupId: mine.lookupId, expectedCacheVersion: cacheVersion!, fields: ["name"] },
    }),
  ).rejects.toThrow(/ACCESS_DENIED/);
  expect(await f.t.run((ctx) => ctx.db.query("companies").collect())).toHaveLength(2);
  expect(f.transport).toHaveBeenCalledTimes(1);
});
it("cota, restrição, ausência e indisponibilidade da fonte deixam só o cadastro manual", async () => {
  const f = await lookupFixture();
  const run = async (cnpj: string, key: string) => {
    const result = await f.lookup(cnpj, key);
    if (result.kind !== "lookup") throw new Error("expected a lookup");
    await f.settle();
    return { ...(await f.status(result.lookupId)), lookupId: result.lookupId };
  };
  await f.t.mutation(internal.registryStore.restrict, {
    cnpj: "11444777000161",
    blocked: true,
    reference: "D02-SYNTHETIC-511",
    actor: "privacy-test",
    expectedVersion: 0,
  });
  expect(await run("11444777000161", "lookup-key-0201")).toMatchObject({
    state: "unavailable",
    data: null,
    cacheVersion: null,
  });
  f.transport.mockResolvedValueOnce(new Response(null, { status: 404 }));
  const absent = await run("12345678000195", "lookup-key-0202");
  expect(absent).toMatchObject({ state: "not_found", data: null });
  f.transport.mockResolvedValueOnce(new Response(null, { status: 503 }));
  expect(await run("11111111000191", "lookup-key-0203")).toMatchObject({
    state: "unavailable",
    data: null,
  });
  expect(f.transport).toHaveBeenCalledTimes(2);
  await expect(
    f.owner.client.mutation(api.companies.create, {
      ...input,
      cnpj: "12345678000195",
      organizationId: f.scope.organizationId,
      registry: { lookupId: absent.lookupId, expectedCacheVersion: 1, fields: ["name"] },
    }),
  ).rejects.toThrow(/REGISTRY_CHANGED/);
  // Manual fill stays available for the same CNPJ.
  const manual = await f.owner.client.mutation(api.companies.create, {
    ...input,
    cnpj: "12345678000195",
    organizationId: f.scope.organizationId,
  });
  expect(await f.t.run((ctx) => ctx.db.get("companies", manual.companyId))).toMatchObject({
    name: input.name,
    fieldSources: { name: "declared", address: "declared" },
  });

  await f.t.mutation(internal.usage.assignPlan, {
    organizationId: f.scope.organizationId,
    name: "Quota",
    startsAt: Date.now() - 1,
    endsAt: Date.now() + 100000,
    limits: { imports: null, bytes: null, captures: null, registry: 2, deliveries: null },
    concurrency: 2,
    actor: "test",
    reason: "quota",
    expectedVersion: 0,
  });
  const quota = await run(consulted, "lookup-key-0204");
  expect(quota).toMatchObject({ state: "quota", data: null });
  expect(f.transport).toHaveBeenCalledTimes(2);
  expect(await f.usage()).toHaveLength(2);
  // Another organization's refresh fills the cache later: a quota lookup still cannot use it.
  await f.t.run((ctx) => ctx.db.insert("registryCache", foundCache(consulted)));
  expect(await f.status(quota.lookupId)).toMatchObject({ state: "quota", data: null });
  await expect(
    f.owner.client.mutation(api.companies.create, {
      ...input,
      cnpj: consulted,
      organizationId: f.scope.organizationId,
      registry: { lookupId: quota.lookupId, expectedCacheVersion: 1, fields: ["name"] },
    }),
  ).rejects.toThrow(/REGISTRY_CHANGED/);
});
/** A found cache row as another holder's call would leave it. */
function foundCache(cnpj: string) {
  const now = Date.now();
  return {
    provider: "opencnpj" as const,
    cnpj,
    status: "found" as const,
    data: {
      name: "Razão social da fonte sintética",
      status: "Ativa",
      address: { ...input.address, postalCode: "01000000", city: "Cidade da fonte" },
    },
    sourceUpdatedAt: null,
    consultedAt: now,
    lastAttemptAt: now,
    expiresAt: now + 86_400_000,
    refreshAfter: now + 86_400_000,
    retainUntil: now + 30 * 86_400_000,
    version: 1,
    stale: false,
  };
}
it("falha inesperada da fonte vira indisponível com intervalo, sem nova cobrança", async () => {
  const f = await lookupFixture();
  f.transport.mockRejectedValueOnce(new Error("synthetic network failure"));
  const first = await f.lookup(consulted, "lookup-key-0301");
  if (first.kind !== "lookup") throw new Error("expected a lookup");
  await f.settle();
  expect(await f.status(first.lookupId)).toMatchObject({ state: "unavailable", data: null });
  const again = await f.lookup(consulted, "lookup-key-0302");
  if (again.kind !== "lookup") throw new Error("expected a lookup");
  await f.settle();
  expect(await f.status(again.lookupId)).toMatchObject({ state: "unavailable" });
  expect(f.transport).toHaveBeenCalledTimes(1);
  expect(await f.usage()).toHaveLength(1);
});
it("consulta que aguarda outra reserva sai de pending quando ela vence e descarta resposta tardia", async () => {
  const f = await lookupFixture();
  const cacheOf = () =>
    f.t.run((ctx) =>
      ctx.db
        .query("registryCache")
        .withIndex("by_provider_and_cnpj", (q) =>
          q.eq("provider", "opencnpj").eq("cnpj", consulted),
        )
        .unique(),
    );
  // Another holder (an operation, here without one) reserved the CNPJ for 60 s.
  const cacheId = await f.t.run((ctx) =>
    ctx.db.insert("registryCache", {
      ...foundCache(consulted),
      status: "unavailable",
      data: null,
      consultedAt: null,
      expiresAt: 0,
      refreshAfter: 0,
      version: 0,
      stale: true,
      pendingUntil: Date.now() + 60_000,
    }),
  );
  const waiting = await f.lookup(consulted, "lookup-key-0401");
  if (waiting.kind !== "lookup") throw new Error("expected a lookup");
  expect(await f.status(waiting.lookupId)).toMatchObject({ state: "pending" });
  // Before it ends, a newer reservation replaces it: settle must leave that one alone.
  await f.t.run((ctx) =>
    ctx.db.patch("registryCache", cacheId, { pendingUntil: Date.now() + 120_000 }),
  );
  vi.advanceTimersByTime(60_001);
  await f.t.finishInProgressScheduledFunctions();
  expect(await f.status(waiting.lookupId)).toMatchObject({ state: "pending" });
  vi.advanceTimersByTime(60_000);
  await f.t.finishInProgressScheduledFunctions();
  expect(await f.status(waiting.lookupId)).toMatchObject({ state: "unavailable", data: null });
  expect((await cacheOf())!.refreshAfter).toBeGreaterThan(Date.now());
  expect(f.transport).not.toHaveBeenCalled();

  // A lookup's own call whose answer only arrives after its lease: the answer is discarded.
  vi.advanceTimersByTime(60_000);
  let answer: (value: Response) => void = () => {};
  f.transport.mockImplementationOnce(() => new Promise<Response>((done) => (answer = done)));
  const late = await f.lookup(consulted, "lookup-key-0402");
  if (late.kind !== "lookup") throw new Error("expected a lookup");
  vi.advanceTimersByTime(1);
  await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(1));
  vi.advanceTimersByTime(30_000);
  await vi.waitFor(async () =>
    expect(await f.status(late.lookupId)).toMatchObject({ state: "unavailable" }),
  );
  answer(Response.json(provider(consulted)));
  await f.t.finishInProgressScheduledFunctions();
  expect(await f.status(late.lookupId)).toMatchObject({ state: "unavailable", data: null });
  expect(await cacheOf()).toMatchObject({ status: "unavailable", data: null });
});
it("cache vencido aparece como expired e o cadastro recusa consulta vencida, de outro CNPJ ou com endereço incompleto", async () => {
  const f = await lookupFixture();
  const first = await f.lookup(consulted, "lookup-key-0501");
  if (first.kind !== "lookup") throw new Error("expected a lookup");
  await f.settle();
  const found = await f.status(first.lookupId);
  const create = (
    lookupId: Id<"registryLookups">,
    fields: ("name" | "address")[],
    cnpj = consulted,
  ) =>
    f.owner.client.mutation(api.companies.create, {
      ...input,
      cnpj,
      organizationId: f.scope.organizationId,
      registry: { lookupId, expectedCacheVersion: found.cacheVersion!, fields },
    });
  await expect(create(first.lookupId, ["name"], "12345678000195")).rejects.toThrow(
    /REGISTRY_CHANGED/,
  );
  await f.t.run((ctx) =>
    ctx.db.patch("registryLookups", first.lookupId, { expiresAt: Date.now() - 1 }),
  );
  await expect(create(first.lookupId, ["name"])).rejects.toThrow(/REGISTRY_CHANGED/);

  // A live lookup shows the answer only while the cache's own 24 h last. The session of the
  // fixture lasts one hour, so the end of that window is reached through the cache's expiry job.
  const later = await f.lookup(consulted, "lookup-key-0502");
  if (later.kind !== "lookup") throw new Error("expected a lookup");
  expect(await f.status(later.lookupId)).toMatchObject({ state: "found" });
  await f.t.run(async (ctx) => {
    const cache = (await ctx.db.query("registryCache").first())!;
    await ctx.db.patch("registryCache", cache._id, {
      expiresAt: Date.now() - 1,
      refreshAfter: Date.now() - 1,
    });
  });
  const cacheId = (await f.t.run((ctx) => ctx.db.query("registryCache").first()))!._id;
  await f.t.mutation(internal.registryStore.expire, { cacheId });
  expect(await f.status(later.lookupId)).toMatchObject({
    state: "expired",
    data: null,
    cacheVersion: null,
  });
  await expect(create(later.lookupId, ["name"])).rejects.toThrow(/REGISTRY_CHANGED/);
  expect(f.transport).toHaveBeenCalledTimes(1);

  // A new lookup consults again; the consulted address is applied at creation.
  const fresh = await f.lookup(consulted, "lookup-key-0503");
  if (fresh.kind !== "lookup") throw new Error("expected a lookup");
  await f.settle();
  const answer = await f.status(fresh.lookupId);
  const created = await f.owner.client.mutation(api.companies.create, {
    ...input,
    cnpj: consulted,
    organizationId: f.scope.organizationId,
    registry: {
      lookupId: fresh.lookupId,
      expectedCacheVersion: answer.cacheVersion!,
      fields: ["address"],
    },
  });
  expect(created.reused).toBe(false);
  expect(await f.t.run((ctx) => ctx.db.get("companies", created.companyId))).toMatchObject({
    name: input.name,
    address: { street: "Avenida Consultada", number: "100", state: "RJ", postalCode: "20000000" },
    fieldSources: { name: "declared", address: "registry" },
  });

  // The source answers without a street number: the consulted address cannot be applied.
  f.transport.mockResolvedValueOnce(Response.json({ ...provider("11444777000161"), numero: "" }));
  const partial = await f.lookup("11444777000161", "lookup-key-0504");
  if (partial.kind !== "lookup") throw new Error("expected a lookup");
  await f.settle();
  const incomplete = await f.status(partial.lookupId);
  expect(incomplete).toMatchObject({ state: "found", data: { address: { number: "" } } });
  await expect(
    f.owner.client.mutation(api.companies.create, {
      ...input,
      cnpj: "11444777000161",
      organizationId: f.scope.organizationId,
      registry: {
        lookupId: partial.lookupId,
        expectedCacheVersion: incomplete.cacheVersion!,
        fields: ["address"],
      },
    }),
  ).rejects.toThrow(/INVALID_COMPANY/);
});
