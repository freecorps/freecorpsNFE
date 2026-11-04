import { convexTest } from "convex-test";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { api, components } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
import type { Id } from "../platform/convex/_generated/dataModel";
import type { MembershipRole } from "../packages/contracts/src/organizations";
import { normalizeNfseProfile } from "../platform/convex/lib/nfseProfile";
import { modules } from "./helpers/convex-modules";

// Relógio fixo: as fixtures são relativas a este instante, longe de virada de dia e de mês
// (freecorps/no-wall-clock-in-tests).
vi.setSystemTime(new Date("2026-06-15T15:00:00Z"));
afterAll(() => vi.useRealTimers());

const contextKey = "nfse-profile-proof",
  paginationOpts = { numItems: 50, cursor: null };
const company = {
  cnpj: "00000000000191",
  name: "Empresa sintética",
  address: {
    street: "Rua sintética",
    number: "1",
    complement: "",
    district: "Centro",
    city: "São Paulo",
    state: "SP",
    postalCode: "01000-000",
  },
};
// Synthetic profile. Public table codes only (IBGE of São Paulo, software licensing codes).
const activity = {
  code: "licenca",
  label: "Licenciamento de software",
  cnae: "6202-3/00",
  lc116Item: "1.05",
  cTribNac: "01.05.01",
  nbs: "1.1103.22.00",
  description: "Licença de uso de software sintético",
};
const profile = {
  municipalRegistration: "123.456-7",
  municipalityCode: "3550308",
  opSimpNac: 3 as const,
  regApTribSN: 1 as const,
  regEspTrib: 0 as const,
  dpsSeries: "00001",
  activities: [activity],
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
    BETTER_AUTH_SECRET: "synthetic-secret-for-local-nfse-profile-tests",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

type T = ReturnType<typeof convexTest>;
async function actor(t: T) {
  const now = Date.now();
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Pessoa de teste",
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
  return {
    user,
    client: t.withIdentity({
      subject: user._id,
      sessionId: session._id,
      issuer: "http://127.0.0.1:3233",
    }),
  };
}
async function organization(owner: Awaited<ReturnType<typeof actor>>) {
  const org = await owner.client.mutation(api.organizations.create, {
    name: "Equipe sintética",
    slug: `org-${crypto.randomUUID()}`,
  });
  const created = await owner.client.mutation(api.companies.create, {
    ...company,
    organizationId: org.organizationId,
  });
  return { organizationId: org.organizationId, companyId: created.companyId };
}
async function fixture() {
  const t = convexTest(schema, modules);
  register(t);
  const owner = await actor(t);
  return { t, owner, scope: await organization(owner) };
}
async function member(t: T, organizationId: Id<"organizations">, role: MembershipRole) {
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
  return { ...person, membershipId };
}
function code(promise: Promise<unknown>) {
  return promise.then(
    () => "OK",
    (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
  );
}
const rows = (t: T) => t.run((ctx) => ctx.db.query("nfseProfiles").collect());

it.each(["owner", "admin"] as const)(
  "%s cria e atualiza o perfil, com versão, normalização e auditoria",
  async (role) => {
    const { t, owner, scope } = await fixture();
    const person = role === "owner" ? owner : await member(t, scope.organizationId, role);
    expect(await person.client.query(api.nfseProfiles.get, { ...scope, contextKey })).toBeNull();
    expect(
      await person.client.mutation(api.nfseProfiles.save, {
        ...scope,
        ...profile,
        expectedVersion: 0,
      }),
    ).toEqual({ version: 1, changed: true });
    expect(await person.client.query(api.nfseProfiles.get, { ...scope, contextKey })).toEqual({
      municipalRegistration: "1234567",
      municipalityCode: "3550308",
      opSimpNac: 3,
      regApTribSN: 1,
      regEspTrib: 0,
      dpsSeries: "1",
      activities: [
        {
          code: "licenca",
          label: "Licenciamento de software",
          cnae: "6202300",
          lc116Item: "01.05",
          cTribNac: "010501",
          nbs: "111032200",
          description: "Licença de uso de software sintético",
        },
      ],
      version: 1,
      updatedAt: expect.any(Number),
    });
    // Same profile again: no new version and no audit entry.
    expect(
      await person.client.mutation(api.nfseProfiles.save, {
        ...scope,
        ...profile,
        expectedVersion: 1,
      }),
    ).toEqual({ version: 1, changed: false });
    // Leaving the Simples drops regApTribSN and the IM from the stored row.
    const { municipalRegistration: _im, regApTribSN: _sn, ...rest } = profile;
    expect(
      await person.client.mutation(api.nfseProfiles.save, {
        ...scope,
        ...rest,
        opSimpNac: 1,
        regEspTrib: 6,
        expectedVersion: 1,
      }),
    ).toEqual({ version: 2, changed: true });
    const [row] = await rows(t);
    expect(row).toMatchObject({ version: 2, opSimpNac: 1, regEspTrib: 6 });
    expect(row).not.toHaveProperty("regApTribSN");
    expect(row).not.toHaveProperty("municipalRegistration");
    expect(row).not.toHaveProperty("aliquota");
    expect(
      await code(
        person.client.mutation(api.nfseProfiles.save, { ...scope, ...profile, expectedVersion: 1 }),
      ),
    ).toBe("NFSE_PROFILE_CHANGED");
    const actions = (
      await owner.client.query(api.companies.activity, { ...scope, paginationOpts, contextKey })
    ).page.map((a) => a.action);
    expect(actions.slice(0, 2)).toEqual([
      "company.nfse_profile_updated",
      "company.nfse_profile_created",
    ]);
    const operational = await t.run((ctx) => ctx.db.query("operationalAudit").collect());
    expect(
      operational
        .filter((e) => e.action.startsWith("company.nfse_profile"))
        .map((e) => [e.action, e.companyId, e.actor]),
    ).toEqual([
      ["company.nfse_profile_created", scope.companyId, person.user._id],
      ["company.nfse_profile_updated", scope.companyId, person.user._id],
    ]);
  },
);

it.each(["developer", "operator", "viewer"] as const)(
  "%s lê o perfil apenas com acesso à empresa e nunca o altera",
  async (role) => {
    const { t, owner, scope } = await fixture();
    await owner.client.mutation(api.nfseProfiles.save, {
      ...scope,
      ...profile,
      expectedVersion: 0,
    });
    const person = await member(t, scope.organizationId, role);
    const read = () => person.client.query(api.nfseProfiles.get, { ...scope, contextKey });
    const write = () =>
      person.client.mutation(api.nfseProfiles.save, {
        ...scope,
        ...profile,
        dpsSeries: "2",
        expectedVersion: 1,
      });
    expect(await code(read())).toBe("ACCESS_DENIED");
    expect(await code(write())).toBe("ACCESS_DENIED");
    await owner.client.mutation(api.companies.setGrant, {
      ...scope,
      membershipId: person.membershipId,
      allowed: true,
      expectedMembershipVersion: 1,
      expectedGrantVersion: 0,
    });
    expect((await read())?.dpsSeries).toBe("1");
    expect(await code(write())).toBe("ACCESS_DENIED");
    expect((await rows(t))[0]).toMatchObject({ version: 1, dpsSeries: "1" });
  },
);

it("sessão sem membership, sem identidade ou de outra organização não lê nem grava", async () => {
  const { t, owner, scope } = await fixture();
  await owner.client.mutation(api.nfseProfiles.save, { ...scope, ...profile, expectedVersion: 0 });
  const stranger = await actor(t);
  const save = { ...scope, ...profile, expectedVersion: 1 };
  expect(await code(stranger.client.query(api.nfseProfiles.get, { ...scope, contextKey }))).toBe(
    "ACCESS_DENIED",
  );
  expect(await code(stranger.client.mutation(api.nfseProfiles.save, save))).toBe("ACCESS_DENIED");
  expect(await code(t.query(api.nfseProfiles.get, { ...scope, contextKey }))).toBe(
    "UNAUTHENTICATED",
  );
  expect(await code(t.mutation(api.nfseProfiles.save, save))).toBe("UNAUTHENTICATED");
  // Owner of another organization, with its own id as selector or the victim's.
  const outsider = await actor(t);
  const other = await organization(outsider);
  for (const organizationId of [other.organizationId, scope.organizationId]) {
    const target = { organizationId, companyId: scope.companyId };
    expect(await code(outsider.client.query(api.nfseProfiles.get, { ...target, contextKey }))).toBe(
      "ACCESS_DENIED",
    );
    expect(
      await code(
        outsider.client.mutation(api.nfseProfiles.save, {
          ...target,
          ...profile,
          expectedVersion: 1,
        }),
      ),
    ).toBe("ACCESS_DENIED");
  }
  // And the victim's owner cannot write into the other organization's company.
  expect(
    await code(
      owner.client.mutation(api.nfseProfiles.save, {
        organizationId: scope.organizationId,
        companyId: other.companyId,
        ...profile,
        expectedVersion: 0,
      }),
    ),
  ).toBe("ACCESS_DENIED");
  expect(await rows(t)).toHaveLength(1);
});

it("o perfil pertence a uma empresa: concessão de outra empresa não dá acesso", async () => {
  const { t, owner, scope } = await fixture();
  const second = await owner.client.mutation(api.companies.create, {
    ...company,
    cnpj: "11222333000181",
    organizationId: scope.organizationId,
  });
  await owner.client.mutation(api.nfseProfiles.save, { ...scope, ...profile, expectedVersion: 0 });
  const person = await member(t, scope.organizationId, "operator");
  await owner.client.mutation(api.companies.setGrant, {
    organizationId: scope.organizationId,
    companyId: second.companyId,
    membershipId: person.membershipId,
    allowed: true,
    expectedMembershipVersion: 1,
    expectedGrantVersion: 0,
  });
  const secondScope = { organizationId: scope.organizationId, companyId: second.companyId };
  expect(
    await person.client.query(api.nfseProfiles.get, { ...secondScope, contextKey }),
  ).toBeNull();
  expect(await code(person.client.query(api.nfseProfiles.get, { ...scope, contextKey }))).toBe(
    "ACCESS_DENIED",
  );
  expect(await owner.client.query(api.nfseProfiles.get, { ...secondScope, contextKey })).toBeNull();
});

it("a empresa de demonstração não recebe perfil", async () => {
  const { owner, scope } = await fixture();
  const { companyId } = await owner.client.mutation(api.onboarding.start, {
    organizationId: scope.organizationId,
    mode: "demonstration",
    expectedVersion: 1,
  });
  const demo = { organizationId: scope.organizationId, companyId: companyId! };
  expect(
    await code(
      owner.client.mutation(api.nfseProfiles.save, {
        ...demo,
        ...profile,
        // The synthetic demonstration company is declared in SP as well.
        expectedVersion: 0,
      }),
    ),
  ).toBe("DEMONSTRATION_READ_ONLY");
  expect(await owner.client.query(api.nfseProfiles.get, { ...demo, contextKey })).toBeNull();
});

const invalid: Array<[string, Record<string, unknown>]> = [
  ["INVALID_MUNICIPALITY_CODE", { municipalityCode: "355030" }],
  ["INVALID_MUNICIPALITY_CODE", { municipalityCode: "35503O8" }],
  ["INVALID_MUNICIPALITY_CODE", { municipalityCode: "9950308" }],
  ["MUNICIPALITY_STATE_MISMATCH", { municipalityCode: "3304557" }],
  ["INVALID_MUNICIPAL_REGISTRATION", { municipalRegistration: "1234567890123456" }],
  ["INVALID_MUNICIPAL_REGISTRATION", { municipalRegistration: "12#4" }],
  ["INVALID_SIMPLES", { opSimpNac: 3, regApTribSN: undefined }],
  ["INVALID_SIMPLES", { opSimpNac: 2 }],
  ["INVALID_SIMPLES", { opSimpNac: 1 }],
  ["INVALID_DPS_SERIES", { dpsSeries: "" }],
  ["INVALID_DPS_SERIES", { dpsSeries: "123456" }],
  ["INVALID_DPS_SERIES", { dpsSeries: "1A" }],
  ["INVALID_DPS_SERIES", { dpsSeries: "00000" }],
  ["ACTIVITIES_REQUIRED", { activities: [] }],
  [
    "TOO_MANY_ACTIVITIES",
    {
      activities: Array.from({ length: 51 }, (_, i) => ({
        ...activity,
        code: `a${i}`,
        cTribNac: `0105${String(i).padStart(2, "0")}`,
      })),
    },
  ],
  ["INVALID_CNAE", { activities: [{ ...activity, cnae: "620230" }] }],
  ["INVALID_CNAE", { activities: [{ ...activity, cnae: "62023001" }] }],
  ["INVALID_LC116_ITEM", { activities: [{ ...activity, lc116Item: "1.5" }] }],
  ["INVALID_LC116_ITEM", { activities: [{ ...activity, lc116Item: "41.01" }] }],
  ["INVALID_LC116_ITEM", { activities: [{ ...activity, lc116Item: "01.00" }] }],
  ["INVALID_CTRIBNAC", { activities: [{ ...activity, cTribNac: "01050" }] }],
  ["INVALID_CTRIBNAC", { activities: [{ ...activity, cTribNac: "0105011" }] }],
  ["ACTIVITY_CODES_MISMATCH", { activities: [{ ...activity, cTribNac: "010601" }] }],
  ["INVALID_NBS", { activities: [{ ...activity, nbs: "11103220" }] }],
  ["INVALID_ISSUER_EMAIL", { issuerEmail: "fiscal@" }],
  ["INVALID_ISSUER_EMAIL", { issuerEmail: `${"x".repeat(75)}@a.example` }],
  ["INVALID_CAMPINAS_DPS_SERIES", { campinasDpsSeries: "10000" }],
  ["INVALID_CAMPINAS_DPS_SERIES", { campinasDpsSeries: "50000" }],
  ["INVALID_CAMPINAS_DPS_SERIES", { campinasDpsSeries: "1A001" }],
  // The 9-digit municipal code is not cTribMun: the layout takes the 3-digit suffix (E0314).
  ["INVALID_CTRIBMUN", { activities: [{ ...activity, cTribMun: "010501001" }] }],
  [
    "INVALID_IBSCBS",
    {
      activities: [{ ...activity, ibsCbs: { cIndOp: "100501", cst: "00", cClassTrib: "000001" } }],
    },
  ],
  [
    "INVALID_IBSCBS",
    { activities: [{ ...activity, ibsCbs: { cIndOp: "", cst: "000", cClassTrib: "000001" } }] },
  ],
  ["INVALID_ACTIVITY_CODE", { activities: [{ ...activity, code: "" }] }],
  ["INVALID_ACTIVITY_CODE", { activities: [{ ...activity, code: "com espaço" }] }],
  ["INVALID_ACTIVITY_LABEL", { activities: [{ ...activity, label: "  " }] }],
  [
    "INVALID_ACTIVITY_DESCRIPTION",
    { activities: [{ ...activity, description: "x".repeat(1001) }] },
  ],
];
it.each(invalid)("recusa %s na mutation real sem gravar nada", async (expected, change) => {
  const { t, owner, scope } = await fixture();
  expect(
    await code(
      owner.client.mutation(api.nfseProfiles.save, {
        ...scope,
        ...profile,
        ...change,
        expectedVersion: 0,
      } as Parameters<typeof owner.client.mutation<typeof api.nfseProfiles.save>>[1]),
    ),
  ).toBe(expected);
  expect(await rows(t)).toEqual([]);
});

it("recusa atividades duplicadas por código ou classificação e indica a posição", async () => {
  const { owner, scope } = await fixture();
  const save = (activities: (typeof activity)[]) =>
    owner.client
      .mutation(api.nfseProfiles.save, { ...scope, ...profile, activities, expectedVersion: 0 })
      .then(
        () => null,
        (error: { data?: unknown }) => error.data,
      );
  expect(await save([activity, { ...activity, code: "LICENCA", cTribNac: "010502" }])).toEqual({
    code: "DUPLICATE_ACTIVITY",
    activity: 1,
  });
  expect(
    await save([activity, { ...activity, code: "outra", cnae: "6202300", cTribNac: "010501" }]),
  ).toEqual({ code: "DUPLICATE_ACTIVITY", activity: 1 });
  expect(
    await save([activity, { ...activity, code: "outra", cTribNac: "010502", cnae: "x" }]),
  ).toEqual({ code: "INVALID_CNAE", activity: 1 });
  expect(await save([activity, { ...activity, code: "outra", cTribNac: "010502" }])).toBeNull();
});

it("guarda e-mail do prestador, série de Campinas, cTribMun e IBS/CBS normalizados", async () => {
  const { t, owner, scope } = await fixture();
  await owner.client.mutation(api.nfseProfiles.save, {
    ...scope,
    ...profile,
    issuerEmail: "  fiscal@prestador.example ",
    campinasDpsSeries: "10001",
    activities: [
      {
        ...activity,
        cTribMun: "001",
        ibsCbs: { cIndOp: "100.501", cst: "000", cClassTrib: "000001" },
      },
    ],
    expectedVersion: 0,
  });
  expect(await owner.client.query(api.nfseProfiles.get, { ...scope, contextKey })).toMatchObject({
    issuerEmail: "fiscal@prestador.example",
    campinasDpsSeries: "10001",
    activities: [
      { cTribMun: "001", ibsCbs: { cIndOp: "100501", cst: "000", cClassTrib: "000001" } },
    ],
  });
  // Clearing the optional fields drops them from the row.
  await owner.client.mutation(api.nfseProfiles.save, { ...scope, ...profile, expectedVersion: 1 });
  const [row] = await rows(t);
  expect(row).not.toHaveProperty("issuerEmail");
  expect(row).not.toHaveProperty("campinasDpsSeries");
  expect(row!.activities[0]).not.toHaveProperty("ibsCbs");
});

describe("número inicial da DPS", () => {
  const seed = async () => {
    const f = await fixture();
    await f.owner.client.mutation(api.nfseProfiles.save, {
      ...f.scope,
      ...profile,
      campinasDpsSeries: "10001",
      expectedVersion: 0,
    });
    return f;
  };
  const start = (
    client: Awaited<ReturnType<typeof actor>>["client"],
    scope: { organizationId: Id<"organizations">; companyId: Id<"companies"> },
    series: string,
    value: number,
    environment: "sandbox" | "production" = "sandbox",
  ) =>
    client.mutation(api.nfseProfiles.setDpsStart, { ...scope, environment, series, start: value });

  it("lista as séries do perfil nos dois ambientes e grava o início com auditoria", async () => {
    const { t, owner, scope } = await seed();
    const list = () => owner.client.query(api.nfseProfiles.sequences, { ...scope, contextKey });
    expect(await list()).toEqual([
      { environment: "sandbox", series: "1", start: 1, next: 1, locked: false, startSetAt: null },
      {
        environment: "sandbox",
        series: "10001",
        start: 1,
        next: 1,
        locked: false,
        startSetAt: null,
      },
      {
        environment: "production",
        series: "1",
        start: 1,
        next: 1,
        locked: false,
        startSetAt: null,
      },
      {
        environment: "production",
        series: "10001",
        start: 1,
        next: 1,
        locked: false,
        startSetAt: null,
      },
    ]);
    expect(await start(owner.client, scope, "00001", 501)).toEqual({
      series: "1",
      start: 501,
      changed: true,
    });
    // Still unused: the start can move again; the same value is not a change.
    expect(await start(owner.client, scope, "1", 801)).toMatchObject({ changed: true });
    expect(await start(owner.client, scope, "1", 801)).toMatchObject({ changed: false });
    expect((await list())[0]).toMatchObject({ series: "1", start: 801, next: 801, locked: false });
    const audit = await t.run((ctx) => ctx.db.query("companyAudit").collect());
    expect(audit.filter((a) => a.action === "company.nfse_dps_start_set")).toHaveLength(2);
    // The platform reserves the first number: from then on the start is locked.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("dpsSequences").first())!;
      await ctx.db.patch("dpsSequences", row._id, { last: 801 });
    });
    expect((await list())[0]).toMatchObject({ next: 802, locked: true });
    expect(await code(start(owner.client, scope, "1", 900))).toBe("DPS_START_LOCKED");
    // Other environment and other series are independent.
    expect(await start(owner.client, scope, "1", 50, "production")).toMatchObject({ start: 50 });
    expect(await start(owner.client, scope, "10001", 7)).toMatchObject({ start: 7 });
  });

  it("recusa série fora do perfil, número inválido e quem não administra", async () => {
    const { t, owner, scope } = await seed();
    expect(await code(start(owner.client, scope, "2", 10))).toBe("INVALID_DPS_SERIES");
    for (const value of [0, -1, 1.5, 1e15])
      expect(await code(start(owner.client, scope, "1", value))).toBe("INVALID_DPS_START");
    for (const role of ["operator", "developer", "viewer"] as const) {
      const person = await member(t, scope.organizationId, role);
      expect(await code(start(person.client, scope, "1", 10))).toBe("ACCESS_DENIED");
    }
    const outsider = await actor(t);
    const other = await organization(outsider);
    for (const organizationId of [other.organizationId, scope.organizationId])
      expect(
        await code(start(outsider.client, { organizationId, companyId: scope.companyId }, "1", 10)),
      ).toBe("ACCESS_DENIED");
    expect(
      await code(
        t.mutation(api.nfseProfiles.setDpsStart, {
          ...scope,
          environment: "sandbox",
          series: "1",
          start: 10,
        }),
      ),
    ).toBe("UNAUTHENTICATED");
    expect(await t.run((ctx) => ctx.db.query("dpsSequences").collect())).toEqual([]);
  });

  it("exige perfil e não vale para a empresa de demonstração", async () => {
    const { owner, scope } = await fixture();
    expect(await code(start(owner.client, scope, "1", 10))).toBe("NFSE_PROFILE_REQUIRED");
    const { companyId } = await owner.client.mutation(api.onboarding.start, {
      organizationId: scope.organizationId,
      mode: "demonstration",
      expectedVersion: 1,
    });
    const demo = { organizationId: scope.organizationId, companyId: companyId! };
    expect(await code(start(owner.client, demo, "1", 10))).toBe("DEMONSTRATION_READ_ONLY");
  });
});

it("normaliza sem depender da ordem nem de pontuação", () => {
  const result = normalizeNfseProfile(
    { ...profile, opSimpNac: 2, regApTribSN: undefined, dpsSeries: "070" },
    "SP",
  );
  expect(result).toMatchObject({ opSimpNac: 2, dpsSeries: "70" });
  expect(result).not.toHaveProperty("regApTribSN");
  expect(
    normalizeNfseProfile(
      {
        ...profile,
        activities: [{ ...activity, lc116Item: "0105", nbs: "", description: "  " }],
      },
      "SP",
    ).activities[0],
  ).toEqual({
    code: "licenca",
    label: "Licenciamento de software",
    cnae: "6202300",
    lc116Item: "01.05",
    cTribNac: "010501",
  });
});
