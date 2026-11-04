import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import schema from "./schema";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { register } from "../test-setup";
import { CAPTURE_TERMS_VERSION } from "./lib/fiscalCaptureRelease";
import { modules } from "../../tests/helpers/convex-modules";

/**
 * Início of the console (`consoleHome.summary`) and the landing after login
 * (`organizations.landing`): what each member sees is limited to its organization, to the
 * companies it reaches and to its role. Synthetic data only.
 */
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 15, 15);
const MONTH_START = Date.UTC(2026, 9, 1);
const contextKey = "home-test";

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5182",
    CONVEX_SITE_URL: "http://127.0.0.1:3225",
    BETTER_AUTH_SECRET: "synthetic-secret-for-offline-local-tests-only",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type T = TestConvex<typeof schema>;
type Role = "owner" | "admin" | "operator" | "viewer" | "developer";

async function login(t: T) {
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
  return {
    userId: user._id,
    client: t.withIdentity({ subject: user._id, sessionId: session._id }),
  };
}

const address = {
  street: "Rua sintética",
  number: "1",
  complement: "",
  district: "Centro",
  city: "Cidade",
  state: "SP",
  postalCode: "01000000",
};

/**
 * A fictitious CNPJ with valid check digits, from its 12-digit base (the RFB rule, as in
 * `normalizeCnpj`). Checked against the fixtures' 11.222.333/0001-81.
 */
function validCnpj(base: string): string {
  const digit = (value: string) => {
    let sum = 0;
    for (let i = value.length - 1, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1)
      sum += Number(value[i]) * weight;
    return sum % 11 < 2 ? 0 : 11 - (sum % 11);
  };
  const first = digit(base);
  return `${base}${first}${digit(base + first)}`;
}
if (
  validCnpj("112223330001") !== "11222333000181" ||
  validCnpj("114447770001") !== "11444777000161"
)
  throw new Error("validCnpj does not follow the RFB rule");

async function organization(t: T, slug: string) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: `Organização ${slug}`,
      slug,
      ownerCount: 1,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    const company = (name: string, cnpj: string) =>
      ctx.db.insert("companies", {
        organizationId,
        cnpj,
        name,
        address,
        kind: "declared",
        declaredBy: "synthetic",
        declaredAt: now,
        fieldSources: { name: "declared", address: "declared" },
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    return {
      organizationId,
      first: await company(`Primeira ${slug}`, "11222333000181"),
      second: await company(`Segunda ${slug}`, "11444777000161"),
    };
  });
}

async function member(
  t: T,
  organizationId: Id<"organizations">,
  role: Role,
  companies: Id<"companies">[] = [],
) {
  const { userId, client } = await login(t);
  const membershipId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("memberships", {
      organizationId,
      authUserId: userId,
      name: "Pessoa sintética",
      email: `${userId}@development.invalid`,
      role,
      state: "active",
      version: 1,
      joinedAt: Date.now(),
      updatedAt: Date.now(),
    });
    for (const companyId of companies)
      await ctx.db.insert("companyGrants", {
        organizationId,
        companyId,
        membershipId: id,
        membershipEpoch: 0,
        active: true,
        version: 1,
        updatedAt: Date.now(),
      });
    return id;
  });
  return { userId, client, membershipId };
}

/** Month of synthetic work on one company: issuances, documents, a failed import and setup. */
async function work(
  t: T,
  organizationId: Id<"organizations">,
  companyId: Id<"companies">,
  membershipId: Id<"memberships">,
  options: { certificateDays?: number; profile?: boolean } = {},
) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Console",
      externalReference: "",
      kind: "console",
      state: "active",
      version: 1,
      accessEpoch: 0,
      creatorMembershipId: membershipId,
      creatorEpoch: 0,
      createdAt: now,
    });
    const scope = { organizationId, projectId, companyId, environment: "sandbox" as const };
    const operation = (
      state: "succeeded" | "reconciling" | "failed",
      workload: "issuance" | "import",
    ) =>
      ctx.db.insert("operations", {
        ...scope,
        task: {
          name: workload === "issuance" ? "nfse.issue" : "documents.import",
          workload,
          scope: workload === "issuance" ? "documents:issue" : "documents:import",
          executor: "synthetic",
        },
        request: "{}",
        requestHash: "synthetic",
        projectEpoch: 0,
        grantEpoch: 0,
        state,
        stage: "ready",
        generation: 1,
        fence: 0,
        attempts: 1,
        maxAttempts: 3,
        leaseUntil: 0,
        nextAttemptAt: 0,
        backoffMs: 0,
        jitterMs: 0,
        uncertain: false,
        createdAt: now,
        updatedAt: now,
      });
    let number = 0;
    const issuance = async (
      state: "authorized" | "rejected" | "processing",
      createdAt: number,
      operationState: "succeeded" | "reconciling" = "succeeded",
    ) =>
      ctx.db.insert("issuances", {
        ...scope,
        operationId: await operation(operationState, "issuance"),
        state,
        transport: "simulated",
        target: "sefin-nacional",
        series: "1",
        number: ++number,
        dpsId: `DPS${String(number).padStart(42, "0")}`,
        snapshot: "{}",
        snapshotSha256: "synthetic",
        submissions: 1,
        version: 1,
        createdAt,
        updatedAt: createdAt,
      });
    const authorized = await issuance("authorized", now - DAY);
    const rejected = await issuance("rejected", now - 2 * DAY);
    const reconciling = await issuance("processing", now - 3 * DAY, "reconciling");
    // Last month: outside the counts and the pending list.
    await issuance("rejected", MONTH_START - DAY);
    const document = (fiscalKey: string, listedAt: number, emitted = false) =>
      ctx.db.insert("fiscalDocuments", {
        organizationId,
        companyId,
        environment: "sandbox",
        model: "55",
        ...(emitted ? { direction: "emitted" as const } : {}),
        fiscalKey,
        listedAt,
        completeness: 1,
        createdAt: listedAt,
      });
    await document("a", now - DAY);
    await document("b", now - 2 * DAY);
    await document("c", now - DAY, true);
    await document("d", MONTH_START - DAY);
    const importId = await ctx.db.insert("imports", {
      ...scope,
      key: "synthetic",
      requestHash: "synthetic",
      createdAt: now - DAY,
    });
    await ctx.db.insert("importFiles", {
      importId,
      position: 0,
      name: "nota.xml",
      size: 10,
      sha256: "synthetic",
      state: "accepted",
      expiresAt: now + DAY,
      operationId: await operation("failed", "import"),
    });
    if (options.certificateDays !== undefined) {
      const certificateId = await ctx.db.insert("certificates", {
        organizationId,
        companyId,
        version: 1,
        state: "active",
        uploaderId: "synthetic",
        membershipId,
        membershipVersion: 1,
        metadata: {
          fingerprint: "synthetic",
          subject: "Empresa sintética",
          cnpj: "11222333000181",
          notBefore: now - 300 * DAY,
          notAfter: now + options.certificateDays * DAY,
        },
        envelopeRevision: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("certificateHeads", {
        organizationId,
        companyId,
        nextVersion: 2,
        latestId: certificateId,
        activeId: certificateId,
      });
    }
    if (options.profile)
      await ctx.db.insert("nfseProfiles", {
        organizationId,
        companyId,
        municipalityCode: "3550308",
        opSimpNac: 1,
        regEspTrib: 0,
        dpsSeries: "1",
        activities: [
          {
            code: "sintetica",
            label: "Atividade sintética",
            cnae: "6202300",
            lc116Item: "01.05",
            cTribNac: "010501",
          },
        ],
        version: 1,
        updatedBy: "synthetic",
        createdAt: now,
        updatedAt: now,
      });
    return { authorized, rejected, reconciling, importId };
  });
}

async function setup() {
  const t = convexTest(schema, modules);
  register(t);
  const a = await organization(t, "alfa");
  const b = await organization(t, "beta");
  const owner = await member(t, a.organizationId, "owner");
  const records = await work(t, a.organizationId, a.first, owner.membershipId, {
    certificateDays: 10,
    profile: true,
  });
  const second = await work(t, a.organizationId, a.second, owner.membershipId);
  const otherOwner = await member(t, b.organizationId, "owner");
  await work(t, b.organizationId, b.first, otherOwner.membershipId, { certificateDays: 5 });
  return {
    t,
    a,
    b,
    records,
    second,
    owner,
    otherOwner,
    admin: await member(t, a.organizationId, "admin"),
    operator: await member(t, a.organizationId, "operator", [a.first]),
    viewer: await member(t, a.organizationId, "viewer", [a.first]),
    developer: await member(t, a.organizationId, "developer", [a.first]),
    outsider: await member(t, a.organizationId, "operator"),
    stranger: await login(t),
  };
}
const args = (organizationId: Id<"organizations">) => ({
  organizationId,
  monthStart: MONTH_START,
  asOf: NOW,
  contextKey,
});
function code(promise: Promise<unknown>) {
  return promise.then(
    () => "OK",
    (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
  );
}

describe("Início do console", () => {
  it("resume o mês, as pendências e a prontidão de todas as empresas para o gestor", async () => {
    const s = await setup();
    const summary = await s.owner.client.query(api.consoleHome.summary, args(s.a.organizationId));
    expect(summary.environment).toBe("sandbox");
    expect(summary.companies).toEqual({ count: 2, truncated: false });
    expect(summary.month).toEqual({
      issuances: { authorized: 2, processing: 2, rejected: 2, cancelled: 0 },
      received: 4,
      production: null,
      failedImports: 2,
      partial: false,
    });
    const kinds = summary.pending.map((item) => [item.kind, item.companyId]);
    // The certificate comes first; the month's rejected, reconciling and failed work follows.
    expect(kinds[0]).toEqual(["certificate-expiring", s.a.first]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ["issuance-rejected", s.a.first],
        ["issuance-reconciling", s.a.first],
        ["import-failed", s.a.first],
        ["issuance-rejected", s.a.second],
        ["import-failed", s.a.second],
      ]),
    );
    expect(summary.pending).toHaveLength(7);
    expect(
      summary.pending.find(
        (item) => item.kind === "issuance-rejected" && item.companyId === s.a.first,
      )?.recordId,
    ).toBe(s.records.rejected);
    expect(
      summary.pending.find((item) => item.kind === "import-failed" && item.companyId === s.a.first)
        ?.recordId,
    ).toBe(s.records.importId);
    // The readiness is by task (#510); the single checklist is gone.
    expect(summary).not.toHaveProperty("readiness");
    expect(summary.tasks.issue?.complete).toBe(true);
  });

  it("limita o membro às empresas concedidas, inclusive na prontidão", async () => {
    const s = await setup();
    for (const actor of [s.operator, s.viewer]) {
      const summary = await actor.client.query(api.consoleHome.summary, args(s.a.organizationId));
      expect(summary.companies.count).toBe(1);
      expect(new Set(summary.pending.map((item) => item.companyId))).toEqual(new Set([s.a.first]));
      expect(summary.month?.issuances).toEqual({
        authorized: 1,
        processing: 1,
        rejected: 1,
        cancelled: 0,
      });
      expect(summary.tasks.import?.complete).toBe(true);
    }
  });

  it("não mostra trabalho fiscal ao membro sem acesso a empresas nem ao developer", async () => {
    const s = await setup();
    const outsider = await s.outsider.client.query(
      api.consoleHome.summary,
      args(s.a.organizationId),
    );
    expect(outsider.companies.count).toBe(0);
    expect(outsider.pending).toEqual([]);
    expect(outsider.month?.received).toBe(0);
    expect(outsider.tasks.import?.steps[0]).toMatchObject({
      state: "blocked",
      reason: "no-company",
    });
    const developer = await s.developer.client.query(
      api.consoleHome.summary,
      args(s.a.organizationId),
    );
    expect(developer).toMatchObject({ month: null, pending: [], tasks: { import: null } });
    expect(developer).not.toHaveProperty("readiness");
  });

  it("isola as organizações e recusa quem não é membro", async () => {
    const s = await setup();
    const other = await s.otherOwner.client.query(
      api.consoleHome.summary,
      args(s.b.organizationId),
    );
    expect(other.companies.count).toBe(2);
    expect(other.pending.length).toBeGreaterThan(0);
    expect(other.pending.every((item) => [s.b.first, s.b.second].includes(item.companyId))).toBe(
      true,
    );
    expect(
      await code(s.otherOwner.client.query(api.consoleHome.summary, args(s.a.organizationId))),
    ).toBe("ACCESS_DENIED");
    expect(
      await code(s.stranger.client.query(api.consoleHome.summary, args(s.a.organizationId))),
    ).toBe("ACCESS_DENIED");
    await s.t.run((ctx) =>
      ctx.db.patch("memberships", s.operator.membershipId, { state: "removed", version: 2 }),
    );
    expect(
      await code(s.operator.client.query(api.consoleHome.summary, args(s.a.organizationId))),
    ).toBe("ACCESS_DENIED");
  });

  it("recusa um relógio inválido em vez de ler um intervalo sem limite", async () => {
    const s = await setup();
    for (const clock of [
      { monthStart: NOW + DAY, asOf: NOW },
      { monthStart: NOW - 60 * DAY, asOf: NOW },
      { monthStart: Number.NaN, asOf: NOW },
    ])
      expect(
        await code(
          s.owner.client.query(api.consoleHome.summary, { ...args(s.a.organizationId), ...clock }),
        ),
      ).toBe("INVALID_REQUEST");
  });

  it("marca a etapa de integração só para quem a administra e só com chave válida", async () => {
    const s = await setup();
    const projectId = await s.t.run((ctx) =>
      ctx.db.insert("projects", {
        organizationId: s.a.organizationId,
        name: "Integração sintética",
        externalReference: "sintetica",
        state: "active",
        version: 1,
        accessEpoch: 0,
        creatorMembershipId: s.owner.membershipId,
        creatorEpoch: 0,
        createdAt: Date.now(),
      }),
    );
    const step = async (actor: { client: typeof s.owner.client }) =>
      (await actor.client.query(api.consoleHome.summary, args(s.a.organizationId))).tasks.integrate
        .steps[1];
    expect(await step(s.owner)).toMatchObject({ key: "key", state: "todo" });
    expect(await step(s.viewer)).toMatchObject({ key: "key", state: "blocked", reason: "role" });
    await s.t.run((ctx) =>
      ctx.db.insert("apiKeys", {
        organizationId: s.a.organizationId,
        projectId,
        projectEpoch: 0,
        name: "Chave sintética",
        keyHash: "synthetic-hash",
        prefix: "fnfe_syn",
        scopes: ["documents:read"],
        environment: "sandbox",
        companyIds: [s.a.first],
        grantEpochs: [0],
        expiresAt: NOW + 30 * DAY,
        revokedAt: null,
        rotatedAt: null,
        createdAt: Date.now(),
        creatorMembershipId: s.owner.membershipId,
      }),
    );
    expect(await step(s.owner)).toMatchObject({ key: "key", state: "done" });
    expect(await step(s.admin)).toMatchObject({ key: "key", state: "done" });
  });
});

describe("destino depois do login", () => {
  it("abre a organização lembrada só para quem ainda é membro dela", async () => {
    const s = await setup();
    expect(await s.owner.client.query(api.organizations.landing, { remembered: "alfa" })).toEqual({
      slug: "alfa",
    });
    // Another organization's address does not open it, nor reveal that it exists.
    expect(await s.owner.client.query(api.organizations.landing, { remembered: "beta" })).toEqual({
      slug: "alfa",
    });
    expect(
      await s.stranger.client.query(api.organizations.landing, { remembered: "alfa" }),
    ).toBeNull();
  });

  it("abre a única organização e manda à lista quando há várias sem lembrança", async () => {
    const s = await setup();
    expect(await s.owner.client.query(api.organizations.landing, {})).toEqual({ slug: "alfa" });
    await s.t.run((ctx) =>
      ctx.db.insert("memberships", {
        organizationId: s.b.organizationId,
        authUserId: s.owner.userId,
        name: "Pessoa sintética",
        email: `${s.owner.userId}@development.invalid`,
        role: "viewer",
        state: "active",
        version: 1,
        joinedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect(await s.owner.client.query(api.organizations.landing, {})).toBeNull();
    expect(await s.owner.client.query(api.organizations.landing, { remembered: "beta" })).toEqual({
      slug: "beta",
    });
    expect(await s.stranger.client.query(api.organizations.landing, {})).toBeNull();
    expect(await code(s.t.query(api.organizations.landing, {}))).toBe("UNAUTHENTICATED");
  });
});

type Actor = { client: Awaited<ReturnType<typeof login>>["client"] };
const tasksOf = async (actor: Actor, organizationId: Id<"organizations">) =>
  (await actor.client.query(api.consoleHome.summary, args(organizationId))).tasks;
type TaskView = {
  complete: boolean;
  steps: { key: string; state: string; companyId: string | null; reason?: string }[];
} | null;
/** Steps as `[key, state, companyId, reason]`, to read a whole task in one line. */
const steps = (task: TaskView) =>
  task?.steps.map((item) => [item.key, item.state, item.companyId, item.reason ?? null]) ?? null;

/**
 * #510: the Início computes readiness by task (import, simulated issuance, capture, integration),
 * on the server, with the same companies and roles as the rest of the summary.
 */
describe("prontidão por tarefa", () => {
  it("dá a cada papel as etapas que ele pode cumprir e bloqueia as outras", async () => {
    const s = await setup();
    const a = s.a;
    // Owner and admin: both companies; the first has a document, a valid A1 and a profile.
    for (const actor of [s.owner, s.admin]) {
      const tasks = await tasksOf(actor, a.organizationId);
      expect(tasks.import?.complete).toBe(true);
      expect(steps(tasks.import)).toEqual([
        ["company", "done", a.first, null],
        ["permission", "done", null, null],
        ["document", "done", a.first, null],
      ]);
      expect(tasks.import?.demonstrationCompanyId).toBeNull();
      // Simulated sandbox issuance: no certificate step, even with companies lacking one.
      expect(steps(tasks.issue)).toEqual([
        ["company", "done", a.first, null],
        ["permission", "done", null, null],
        ["profile", "done", a.first, null],
      ]);
      expect(tasks.issue?.complete).toBe(true);
      // Without the deployment switch the capture is not offered here.
      expect(tasks.capture).toEqual({
        complete: false,
        steps: ["company", "certificate", "authorize", "start"].map((key) => ({
          key,
          state: "unavailable",
          companyId: null,
          reason: "deployment",
        })),
      });
      expect(steps(tasks.integrate)).toEqual([
        ["project", "todo", null, null],
        ["key", "blocked", null, "previous"],
      ]);
    }
    // Operator: imports and issues on its company; integrations are not its role.
    const operator = await tasksOf(s.operator, a.organizationId);
    expect(operator.import?.complete).toBe(true);
    expect(operator.issue?.complete).toBe(true);
    expect(steps(operator.integrate)).toEqual([
      ["project", "blocked", null, "role"],
      ["key", "blocked", null, "role"],
    ]);
    // Viewer: neither imports nor issues, but sees that the organization already did both.
    const viewer = await tasksOf(s.viewer, a.organizationId);
    expect(steps(viewer.import)).toEqual([
      ["company", "done", a.first, null],
      ["permission", "blocked", null, "role"],
      ["document", "done", a.first, null],
    ]);
    expect(viewer.import?.complete).toBe(true);
    expect(viewer.issue?.steps[1]).toEqual({
      key: "permission",
      state: "blocked",
      companyId: null,
      reason: "role",
    });
    expect(viewer.issue?.complete).toBe(true);
    // A viewer granted a company with nothing yet: the task is not done, nor its to do.
    const empty = await s.t.run((ctx) =>
      ctx.db.insert("companies", {
        organizationId: a.organizationId,
        cnpj: validCnpj("112223330002"),
        name: "Sem documentos",
        address,
        kind: "declared",
        declaredBy: "synthetic",
        declaredAt: NOW,
        fieldSources: { name: "declared", address: "declared" },
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const newViewer = await member(s.t, a.organizationId, "viewer", [empty]);
    const fresh = await tasksOf(newViewer, a.organizationId);
    expect(steps(fresh.import)?.[2]).toEqual(["document", "blocked", empty, "role"]);
    expect(fresh.import?.complete).toBe(false);
    // Developer: only the integration, as in the rest of the Início.
    expect(await tasksOf(s.developer, a.organizationId)).toEqual({
      import: null,
      issue: null,
      capture: null,
      integrate: {
        complete: false,
        steps: [
          { key: "project", state: "todo", companyId: null },
          { key: "key", state: "blocked", companyId: null, reason: "previous" },
        ],
      },
    });
    // A member without companies cannot declare one: it waits for a grant.
    const outsider = await tasksOf(s.outsider, a.organizationId);
    expect(steps(outsider.import)).toEqual([
      ["company", "blocked", null, "no-company"],
      ["permission", "done", null, null],
      ["document", "blocked", null, "previous"],
    ]);
    expect(steps(outsider.issue)).toEqual([
      ["company", "blocked", null, "no-company"],
      ["permission", "done", null, null],
      ["profile", "blocked", null, "role"],
    ]);
    // Who is not a member reads nothing.
    expect(
      await code(s.stranger.client.query(api.consoleHome.summary, args(a.organizationId))),
    ).toBe("ACCESS_DENIED");
    expect(
      await code(s.otherOwner.client.query(api.consoleHome.summary, args(a.organizationId))),
    ).toBe("ACCESS_DENIED");
  });

  it("conta a integração só com projeto ativo administrado e chave válida", async () => {
    const s = await setup();
    const projectId = await s.t.run((ctx) =>
      ctx.db.insert("projects", {
        organizationId: s.a.organizationId,
        name: "Integração sintética",
        externalReference: "sintetica",
        state: "active",
        version: 1,
        accessEpoch: 0,
        creatorMembershipId: s.owner.membershipId,
        creatorEpoch: 0,
        createdAt: Date.now(),
      }),
    );
    expect(steps((await tasksOf(s.owner, s.a.organizationId)).integrate)).toEqual([
      ["project", "done", null, null],
      ["key", "todo", null, null],
    ]);
    // A developer manages only the projects it created.
    expect((await tasksOf(s.developer, s.a.organizationId)).integrate.steps[0]?.state).toBe("todo");
    await s.t.run((ctx) =>
      ctx.db.insert("apiKeys", {
        organizationId: s.a.organizationId,
        projectId,
        projectEpoch: 0,
        name: "Chave sintética",
        keyHash: "synthetic-hash",
        prefix: "fnfe_syn",
        scopes: ["documents:read"],
        environment: "sandbox",
        companyIds: [s.a.first],
        grantEpochs: [0],
        expiresAt: NOW + 30 * DAY,
        revokedAt: null,
        rotatedAt: null,
        createdAt: Date.now(),
        creatorMembershipId: s.owner.membershipId,
      }),
    );
    expect((await tasksOf(s.admin, s.a.organizationId)).integrate.complete).toBe(true);
  });

  it("não usa documento nem perfil de empresa fora da concessão", async () => {
    const s = await setup();
    // A third company with nothing yet; the operator reaches only it.
    const third = await s.t.run((ctx) =>
      ctx.db.insert("companies", {
        organizationId: s.a.organizationId,
        cnpj: validCnpj("114447770002"),
        name: "Terceira alfa",
        address,
        kind: "declared",
        declaredBy: "synthetic",
        declaredAt: NOW,
        fieldSources: { name: "declared", address: "declared" },
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const granted = await member(s.t, s.a.organizationId, "operator", [third]);
    const tasks = await tasksOf(granted, s.a.organizationId);
    expect(steps(tasks.import)).toEqual([
      ["company", "done", third, null],
      ["permission", "done", null, null],
      ["document", "todo", third, null],
    ]);
    expect(steps(tasks.issue)).toEqual([
      ["company", "done", third, null],
      ["permission", "done", null, null],
      ["profile", "blocked", third, "role"],
    ]);
    // The owner, who reaches the first company, has both done there.
    const owner = await tasksOf(s.owner, s.a.organizationId);
    expect(owner.import?.complete).toBe(true);
    expect(owner.issue?.complete).toBe(true);
  });

  it("pede certificado na emissão só quando o transporte da empresa não é o simulador", async () => {
    const s = await setup();
    vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "producao-restrita");
    vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", s.a.second);
    // The second company would talk to the restricted production: it lacks a certificate and
    // a profile, so the first company, simulated and ready, is still the closest one.
    const owner = await tasksOf(s.owner, s.a.organizationId);
    expect(steps(owner.issue)).toEqual([
      ["company", "done", s.a.first, null],
      ["permission", "done", null, null],
      ["profile", "done", s.a.first, null],
    ]);
    vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", s.a.first);
    // Its certificate is valid and has its CNPJ: the step appears and is done.
    expect(steps((await tasksOf(s.owner, s.a.organizationId)).issue)).toEqual([
      ["company", "done", s.a.first, null],
      ["permission", "done", null, null],
      ["certificate", "done", s.a.first, null],
      ["profile", "done", s.a.first, null],
    ]);
    await s.t.run(async (ctx) => {
      const head = await ctx.db
        .query("certificateHeads")
        .withIndex("by_companyId", (q) => q.eq("companyId", s.a.first))
        .unique();
      await ctx.db.patch("certificates", head!.activeId!, { state: "revoked" });
    });
    const after = await tasksOf(s.owner, s.a.organizationId);
    expect(after.issue?.steps[2]).toMatchObject({ key: "certificate", state: "todo" });
    expect(after.issue?.complete).toBe(false);
  });

  it("prefere a empresa pronta para emitir à que só tem mais etapas feitas", async () => {
    const s = await setup();
    // R (first) needs a certificate, has it, and has no profile; S (second) is simulated and
    // has a profile.
    await s.t.run(async (ctx) => {
      const profile = await ctx.db
        .query("nfseProfiles")
        .withIndex("by_companyId", (q) => q.eq("companyId", s.a.first))
        .unique();
      const { _id, _creationTime, ...fields } = profile!;
      await ctx.db.delete("nfseProfiles", _id);
      await ctx.db.insert("nfseProfiles", { ...fields, companyId: s.a.second });
    });
    vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "producao-restrita");
    vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", s.a.first);
    const tasks = await tasksOf(s.owner, s.a.organizationId);
    expect(tasks.issue?.complete).toBe(true);
    expect(steps(tasks.issue)).toEqual([
      ["company", "done", s.a.second, null],
      ["permission", "done", null, null],
      ["profile", "done", s.a.second, null],
    ]);
  });

  it("dá a emissão simulada como indisponível num deployment de produção", async () => {
    const s = await setup();
    // A demonstration company, with its example imported in the sandbox.
    const demo = await s.t.run(async (ctx) => {
      const id = await ctx.db.insert("companies", {
        organizationId: s.a.organizationId,
        cnpj: "12ABC34501DE35",
        name: "Empresa de demonstração",
        address,
        kind: "demonstration",
        declaredBy: "synthetic",
        declaredAt: NOW,
        fieldSources: { name: "demonstration", address: "demonstration" },
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("fiscalDocuments", {
        organizationId: s.a.organizationId,
        companyId: id,
        environment: "sandbox",
        model: "55",
        fiscalKey: "demo",
        listedAt: NOW,
        completeness: 1,
        createdAt: NOW,
      });
      return id;
    });
    // A deployment whose base environment is production (the #50 validation target's profile).
    for (const [name, value] of Object.entries({
      APP_ENV: "validation",
      PRODUCT_ENV: "production",
      FNFE_PROOF_FISCAL_ENV: "production",
      EMAIL_MODE: "disabled",
      SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    }))
      vi.stubEnv(name, value);
    const tasks = await tasksOf(s.owner, s.a.organizationId);
    expect(steps(tasks.issue)).toEqual([
      ["company", "unavailable", null, "deployment"],
      ["permission", "unavailable", null, "deployment"],
      ["profile", "unavailable", null, "deployment"],
    ]);
    expect(tasks.issue?.complete).toBe(false);
    // The demonstration company exists only in the sandbox: not offered, not pointed to, and
    // its sandbox document does not count; the import waits for a production document.
    expect(tasks.import?.demonstrationCompanyId).toBeNull();
    expect(steps(tasks.import)).toEqual([
      ["company", "done", s.a.first, null],
      ["permission", "done", null, null],
      ["document", "todo", s.a.first, null],
    ]);
    expect(tasks.import?.steps.some((item) => item.companyId === demo)).toBe(false);
  });

  it("não conta empresa além do limite de 10, nem mostra o seu id", async () => {
    const t = convexTest(schema, modules);
    register(t);
    const { organizationId, ids } = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        name: "Organização cheia",
        slug: "cheia",
        ownerCount: 1,
        memberCount: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const ids: Id<"companies">[] = [];
      for (let index = 0; index < 11; index++)
        ids.push(
          await ctx.db.insert("companies", {
            organizationId,
            cnpj: validCnpj(`11222333${String(index + 10).padStart(4, "0")}`),
            name: `Empresa ${index}`,
            address,
            kind: "declared",
            declaredBy: "synthetic",
            declaredAt: NOW,
            fieldSources: { name: "declared", address: "declared" },
            version: 1,
            createdAt: NOW,
            updatedAt: NOW,
          }),
        );
      return { organizationId, ids };
    });
    const owner = await member(t, organizationId, "owner");
    // Only the 11th company, beyond the limit, has a document and an NFS-e profile.
    const eleventh = ids[10]!;
    await work(t, organizationId, eleventh, owner.membershipId, { profile: true });
    const summary = await owner.client.query(api.consoleHome.summary, args(organizationId));
    expect(summary.companies).toEqual({ count: 10, truncated: true });
    expect(steps(summary.tasks.import)?.[2]).toEqual(["document", "todo", ids[0], null]);
    expect(steps(summary.tasks.issue)?.[2]).toEqual(["profile", "todo", ids[0], null]);
    const all = [summary.tasks.import, summary.tasks.issue, summary.tasks.capture];
    expect(all.some((task) => task?.steps.some((item) => item.companyId === eleventh))).toBe(false);
  });

  it("não aponta a empresa de demonstração a quem só recebeu outra empresa", async () => {
    const s = await setup();
    const [demo, third] = await s.t.run(async (ctx) => {
      const company = (cnpj: string, kind: "declared" | "demonstration") =>
        ctx.db.insert("companies", {
          organizationId: s.a.organizationId,
          cnpj,
          name: `Empresa ${cnpj}`,
          address,
          kind,
          declaredBy: "synthetic",
          declaredAt: NOW,
          fieldSources: { name: kind, address: kind },
          version: 1,
          createdAt: NOW,
          updatedAt: NOW,
        });
      const demo = await company("12ABC34501DE35", "demonstration");
      await ctx.db.insert("fiscalDocuments", {
        organizationId: s.a.organizationId,
        companyId: demo,
        environment: "sandbox",
        model: "55",
        fiscalKey: "demo",
        listedAt: NOW,
        completeness: 1,
        createdAt: NOW,
      });
      return [demo, await company(validCnpj("114447770003"), "declared")];
    });
    const granted = await member(s.t, s.a.organizationId, "operator", [third]);
    const tasks = await tasksOf(granted, s.a.organizationId);
    expect(tasks.import?.demonstrationCompanyId).toBeNull();
    expect(steps(tasks.import)?.[2]).toEqual(["document", "todo", third, null]);
    expect(
      [tasks.import, tasks.issue, tasks.capture, tasks.integrate].some((task) =>
        task?.steps.some((item) => item.companyId === demo),
      ),
    ).toBe(false);
    // The owner reaches it, so the example is offered there.
    expect((await tasksOf(s.owner, s.a.organizationId)).import?.demonstrationCompanyId).toBe(demo);
  });

  it("conclui a importação de uma organização só com a empresa de demonstração", async () => {
    const t = convexTest(schema, modules);
    register(t);
    const empty = (slug: string) =>
      t.run((ctx) =>
        ctx.db.insert("organizations", {
          name: `Organização ${slug}`,
          slug,
          ownerCount: 1,
          memberCount: 1,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
    // Two organizations with the same synthetic CNPJ of the demonstration company.
    const [alfa, beta] = [await empty("demo-alfa"), await empty("demo-beta")];
    const [ownerA, ownerB] = [await member(t, alfa, "owner"), await member(t, beta, "owner")];
    const start = (actor: Actor, organizationId: Id<"organizations">) =>
      actor.client.mutation(api.onboarding.start, {
        organizationId,
        mode: "demonstration",
        expectedVersion: 0,
      });
    const demoA = (await start(ownerA, alfa)).companyId!;
    const demoB = (await start(ownerB, beta)).companyId!;
    expect(demoA).not.toBe(demoB);
    const before = await tasksOf(ownerA, alfa);
    expect(before.import?.demonstrationCompanyId).toBe(demoA);
    expect(steps(before.import)?.[2]).toEqual(["document", "todo", demoA, null]);
    // The example XML, imported as any XML is: a received document with its published version.
    await t.run((ctx) =>
      ctx.db.insert("fiscalDocuments", {
        organizationId: alfa,
        companyId: demoA,
        environment: "sandbox",
        model: "55",
        fiscalKey: "demo",
        listedAt: NOW,
        completeness: 1,
        createdAt: NOW,
      }),
    );
    const after = await tasksOf(ownerA, alfa);
    expect(after.import?.complete).toBe(true);
    expect(steps(after.import)?.[2]).toEqual(["document", "done", demoA, null]);
    // Issuance needs a declared company: it is the next thing to do, not a hidden failure.
    expect(steps(after.issue)?.[0]).toEqual(["company", "todo", null, null]);
    // The other organization, with the same CNPJ, sees its own company and no document.
    const other = await tasksOf(ownerB, beta);
    expect(other.import?.demonstrationCompanyId).toBe(demoB);
    expect(other.import?.complete).toBe(false);
    expect(steps(other.import)?.[2]).toEqual(["document", "todo", demoB, null]);
  });

  /** One organization, one declared company, its owner and a reader of its `document` step. */
  async function singleCompany() {
    const t = convexTest(schema, modules);
    register(t);
    const { organizationId, companyId } = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        name: "Organização emissora",
        slug: "emissora",
        ownerCount: 1,
        memberCount: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const companyId = await ctx.db.insert("companies", {
        organizationId,
        cnpj: "11222333000181",
        name: "Emissora",
        address,
        kind: "declared",
        declaredBy: "synthetic",
        declaredAt: NOW,
        fieldSources: { name: "declared", address: "declared" },
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      return { organizationId, companyId };
    });
    const owner = await member(t, organizationId, "owner");
    const insert = (fields: {
      fiscalKey: string;
      environment: "sandbox" | "production";
      completeness: number;
      emitted?: boolean;
      listedAt?: number;
    }) =>
      t.run((ctx) =>
        ctx.db.insert("fiscalDocuments", {
          organizationId,
          companyId,
          environment: fields.environment,
          model: fields.emitted ? "nfse" : "55",
          ...(fields.emitted ? { direction: "emitted" as const } : {}),
          fiscalKey: fields.fiscalKey,
          listedAt: fields.listedAt ?? NOW,
          completeness: fields.completeness,
          createdAt: fields.listedAt ?? NOW,
        }),
      );
    const document = async () => steps((await tasksOf(owner, organizationId)).import)?.[2] ?? null;
    return { companyId, insert, document };
  }

  it("não conta como primeira importação a NFS-e emitida nem o documento de Produção", async () => {
    const { companyId, insert, document } = await singleCompany();
    // An NFS-e the platform issued this month, not yet published (`issuanceProcessing`).
    await insert({ fiscalKey: "emitida", environment: "sandbox", completeness: -1, emitted: true });
    expect(await document()).toEqual(["document", "todo", companyId, null]);
    // A document received in production does not import anything in the sandbox.
    await insert({ fiscalKey: "producao", environment: "production", completeness: 1 });
    expect(await document()).toEqual(["document", "todo", companyId, null]);
    // An imported one does.
    await insert({ fiscalKey: "importada", environment: "sandbox", completeness: 1 });
    expect(await document()).toEqual(["document", "done", companyId, null]);
  });

  it("acha o primeiro documento de um mês anterior, publicado, pela consulta indexada", async () => {
    const { companyId, insert, document } = await singleCompany();
    // Nothing listed this month: the month's rows are empty and the indexed query decides.
    const earlier = MONTH_START - 40 * DAY;
    await insert({
      fiscalKey: "emitida-antes",
      environment: "sandbox",
      completeness: -1,
      emitted: true,
      listedAt: earlier,
    });
    expect(await document()).toEqual(["document", "todo", companyId, null]);
    await insert({
      fiscalKey: "importada-antes",
      environment: "sandbox",
      completeness: 1,
      listedAt: earlier,
    });
    expect(await document()).toEqual(["document", "done", companyId, null]);
  });
});

/**
 * #422: the Início counts what the fiscal capture received in production and lists a production
 * capture in attention, or without an answered query for 30 days (paused included), while the
 * company's release holds. Sandbox streams and withdrawn releases are not pending items.
 */
describe("captura em Produção no Início", () => {
  type Setup = Awaited<ReturnType<typeof setup>>;
  async function released(s: Setup, companyId: Id<"companies">, released = true) {
    await s.t.run(async (ctx) => {
      const base = {
        organizationId: s.a.organizationId,
        companyId,
        released,
        blocked: false,
        minIntervalHours: 1,
      };
      const eventId = await ctx.db.insert("captureReleaseEvents", {
        ...base,
        version: 1,
        kind: released ? "console_release" : "console_withdraw",
        ...(released ? { terms: CAPTURE_TERMS_VERSION } : {}),
        revokedKeys: 0,
        reason: "Liberação sintética",
        buildSha: null,
        deployment: "",
        createdAt: Date.now(),
      });
      await ctx.db.insert("captureReleases", {
        ...base,
        releasedBefore: true,
        actor: "member:synthetic",
        reason: "Liberação sintética",
        version: 1,
        updatedAt: Date.now(),
        eventId,
      });
    });
  }
  const stream = (
    s: Setup,
    companyId: Id<"companies">,
    fields: {
      environment?: "sandbox" | "production";
      state: "active" | "paused" | "attention";
      code?: string;
      lastSuccessAt?: number;
    },
  ) =>
    s.t.run(async (ctx) => {
      const project = (await ctx.db
        .query("projects")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", s.a.organizationId))
        .first())!;
      return ctx.db.insert("captureStreams", {
        organizationId: s.a.organizationId,
        projectId: project._id,
        companyId,
        environment: fields.environment ?? "production",
        identity: "11222333000181",
        service: "nfe-distribution",
        state: fields.state,
        ...(fields.code ? { code: fields.code } : {}),
        version: 3,
        checkpoint: "000000000000001",
        mode: "distNSU",
        nextAllowedAt: 0,
        ...(fields.lastSuccessAt !== undefined ? { lastSuccessAt: fields.lastSuccessAt } : {}),
        lastAttemptAt: NOW - 2 * DAY,
        received: 1,
        createdAt: NOW - 90 * DAY,
      });
    });
  const captured = (s: Setup, companyId: Id<"companies">) =>
    s.t.run(async (ctx) => {
      for (const [fiscalKey, listedAt] of [
        ["p1", NOW - DAY],
        ["p2", NOW - 2 * DAY],
        ["p3", MONTH_START - DAY],
      ] as const)
        await ctx.db.insert("fiscalDocuments", {
          organizationId: s.a.organizationId,
          companyId,
          environment: "production",
          model: "55",
          fiscalKey,
          listedAt,
          completeness: 1,
          createdAt: listedAt,
        });
    });
  const pending = (summary: { pending: { kind: string; companyId: string }[] }) =>
    summary.pending.filter((item) => item.kind.startsWith("capture"));

  it("conta os documentos de Produção e lista a captura em atenção e a parada há 30 dias", async () => {
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
    const s = await setup();
    await released(s, s.a.first);
    await released(s, s.a.second);
    await captured(s, s.a.first);
    const attention = await stream(s, s.a.first, {
      state: "attention",
      code: "SOURCE_CONSUMPTION_BLOCKED",
      lastSuccessAt: NOW - 3 * DAY,
    });
    const quiet = await stream(s, s.a.second, {
      state: "paused",
      code: "PAUSED_BY_USER",
      lastSuccessAt: NOW - 31 * DAY,
    });
    // A sandbox stream in attention is not a pending item of the Início.
    await stream(s, s.a.second, { environment: "sandbox", state: "attention" });
    const summary = await s.owner.client.query(api.consoleHome.summary, args(s.a.organizationId));
    expect(summary.month?.received).toBe(4);
    expect(summary.month?.production).toEqual({ received: 2 });
    expect(pending(summary)).toEqual([
      expect.objectContaining({
        kind: "capture-attention",
        companyId: s.a.first,
        recordId: attention,
        at: NOW - 2 * DAY,
        // The reason, so the Início says it (#432).
        code: "SOURCE_CONSUMPTION_BLOCKED",
        // Who resumes it (#607): here the console.
        origin: { kind: "console", integration: null },
      }),
      expect.objectContaining({
        kind: "capture-quiet",
        companyId: s.a.second,
        recordId: quiet,
        at: NOW - 31 * DAY,
      }),
    ]);
    // Certificates and captures come before the month's issuances and imports.
    expect(summary.pending.slice(0, 3).map((item) => item.kind)).toEqual([
      "certificate-expiring",
      "capture-attention",
      "capture-quiet",
    ]);
    // 29 days is not yet a pending item.
    await s.t.run((ctx) =>
      ctx.db.patch("captureStreams", quiet, { lastSuccessAt: NOW - 29 * DAY }),
    );
    expect(
      pending(await s.owner.client.query(api.consoleHome.summary, args(s.a.organizationId))),
    ).toHaveLength(1);
  });

  it("diz que a captura em atenção é de uma integração, pelo nome dela (#607)", async () => {
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
    const s = await setup();
    await released(s, s.a.first);
    const attention = await stream(s, s.a.first, { state: "attention", code: "ACCESS_REVOKED" });
    await s.t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        organizationId: s.a.organizationId,
        name: "ERP Serra",
        externalReference: "erp-serra",
        state: "active",
        version: 1,
        accessEpoch: 0,
        creatorMembershipId: s.owner.membershipId,
        creatorEpoch: 0,
        createdAt: NOW,
      });
      await ctx.db.patch("captureStreams", attention, { projectId });
    });
    const summary = await s.owner.client.query(api.consoleHome.summary, args(s.a.organizationId));
    expect(pending(summary)).toEqual([
      expect.objectContaining({
        kind: "capture-attention",
        recordId: attention,
        origin: { kind: "integration", integration: "ERP Serra" },
      }),
    ]);
    // A project of another organization: an integration, without its name.
    await s.t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        organizationId: s.b.organizationId,
        name: "Projeto alheio",
        externalReference: "alheio",
        state: "active",
        version: 1,
        accessEpoch: 0,
        creatorMembershipId: s.owner.membershipId,
        creatorEpoch: 0,
        createdAt: NOW,
      });
      await ctx.db.patch("captureStreams", attention, { projectId });
    });
    const foreign = await s.owner.client.query(api.consoleHome.summary, args(s.a.organizationId));
    expect(pending(foreign)).toEqual([
      expect.objectContaining({
        recordId: attention,
        origin: { kind: "integration", integration: null },
      }),
    ]);
    expect(JSON.stringify(foreign)).not.toContain("Projeto alheio");
  });

  it("só para quem lê a empresa: o concedido vê a sua, o developer e o membro sem empresa não", async () => {
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
    const s = await setup();
    await released(s, s.a.first);
    await released(s, s.a.second);
    await captured(s, s.a.first);
    await stream(s, s.a.second, { state: "attention", code: "CAPTURE_FISCAL_DENIED" });
    for (const actor of [s.operator, s.viewer]) {
      const summary = await actor.client.query(api.consoleHome.summary, args(s.a.organizationId));
      // Granted only the first company: its documents, not the other's attention.
      expect(summary.month?.production).toEqual({ received: 2 });
      expect(pending(summary)).toEqual([]);
    }
    const outsider = await s.outsider.client.query(
      api.consoleHome.summary,
      args(s.a.organizationId),
    );
    expect(outsider.month?.production).toBeNull();
    const developer = await s.developer.client.query(
      api.consoleHome.summary,
      args(s.a.organizationId),
    );
    expect(developer).toMatchObject({ month: null, pending: [] });
    // Another organization sees none of it.
    const other = await s.otherOwner.client.query(
      api.consoleHome.summary,
      args(s.b.organizationId),
    );
    expect(other.month?.production).toBeNull();
    expect(pending(other)).toEqual([]);
  });

  it("retirada a liberação, os documentos continuam contados e a captura sai das pendências", async () => {
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
    const s = await setup();
    await released(s, s.a.first, false);
    await captured(s, s.a.first);
    await stream(s, s.a.first, {
      state: "paused",
      code: "CAPTURE_RELEASE_WITHDRAWN",
      lastSuccessAt: NOW - 40 * DAY,
    });
    const summary = await s.owner.client.query(api.consoleHome.summary, args(s.a.organizationId));
    expect(summary.month?.production).toEqual({ received: 2 });
    expect(pending(summary)).toEqual([]);
    // Without the deployment switch every release reads as withdrawn: nothing pending either.
    vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
    await released(s, s.a.second);
    await stream(s, s.a.second, { state: "attention", code: "SOURCE_CONSUMPTION_BLOCKED" });
    expect(
      pending(await s.owner.client.query(api.consoleHome.summary, args(s.a.organizationId))),
    ).toEqual([]);
  });

  it("tarefa de captura: autorizar e iniciar são etapas distintas, por papel e por empresa", async () => {
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
    const s = await setup();
    const first = s.a.first;
    // The first company has its own valid A1; nothing released yet.
    expect(steps((await tasksOf(s.owner, s.a.organizationId)).capture)).toEqual([
      ["company", "done", first, null],
      ["certificate", "done", first, null],
      ["authorize", "todo", first, null],
      ["start", "blocked", first, "previous"],
    ]);
    // Authorizing is the owner's or admin's; starting, also the operator's; the viewer neither.
    expect(steps((await tasksOf(s.operator, s.a.organizationId)).capture)?.slice(2)).toEqual([
      ["authorize", "blocked", first, "role"],
      ["start", "blocked", first, "previous"],
    ]);
    expect(steps((await tasksOf(s.viewer, s.a.organizationId)).capture)?.slice(2)).toEqual([
      ["authorize", "blocked", first, "role"],
      ["start", "blocked", first, "role"],
    ]);
    await released(s, first);
    expect(steps((await tasksOf(s.admin, s.a.organizationId)).capture)?.slice(2)).toEqual([
      ["authorize", "done", first, null],
      ["start", "todo", first, null],
    ]);
    // A paused stream has not started; an active one completes the task.
    const id = await stream(s, first, { state: "paused", code: "PAUSED_BY_USER" });
    expect((await tasksOf(s.owner, s.a.organizationId)).capture?.complete).toBe(false);
    await s.t.run((ctx) => ctx.db.patch("captureStreams", id, { state: "active" }));
    const done = await tasksOf(s.owner, s.a.organizationId);
    expect(done.capture?.complete).toBe(true);
    // A member granted only another company never sees this stream.
    const granted = await member(s.t, s.a.organizationId, "operator", [s.a.second]);
    expect(steps((await tasksOf(granted, s.a.organizationId)).capture)).toEqual([
      ["company", "done", s.a.second, null],
      ["certificate", "blocked", s.a.second, "role"],
      ["authorize", "blocked", s.a.second, "role"],
      ["start", "blocked", s.a.second, "previous"],
    ]);
    expect((await tasksOf(s.developer, s.a.organizationId)).capture).toBeNull();
    // The deployment switch off: the release reads as withdrawn and the task is unavailable.
    vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
    const off = await tasksOf(s.owner, s.a.organizationId);
    expect(off.capture?.complete).toBe(false);
    expect(off.capture?.steps.every((item) => item.state === "unavailable")).toBe(true);
    expect(off.capture?.steps[0]?.reason).toBe("deployment");
  });

  it("tarefa de captura: a empresa bloqueada pela Freecorps não se autoriza nem é preferida", async () => {
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
    const s = await setup();
    // Freecorps blocks a company before any release.
    const block = (companyId: Id<"companies">) =>
      s.t.run(async (ctx) => {
        const base = {
          organizationId: s.a.organizationId,
          companyId,
          released: false,
          blocked: true,
          minIntervalHours: 1,
          reason: "Bloqueio sintético",
        };
        const eventId = await ctx.db.insert("captureReleaseEvents", {
          ...base,
          version: 1,
          kind: "emergency_withdraw",
          revokedKeys: 0,
          buildSha: null,
          deployment: "",
          createdAt: NOW,
        });
        await ctx.db.insert("captureReleases", {
          ...base,
          releasedBefore: false,
          actor: "operator:freecorps",
          version: 1,
          updatedAt: NOW,
          eventId,
        });
      });
    await block(s.a.first);
    // Only the first company: authorizing is blocked for everyone, owner included.
    const onlyFirst = await member(s.t, s.a.organizationId, "operator", [s.a.first]);
    expect(steps((await tasksOf(onlyFirst, s.a.organizationId)).capture)?.[2]).toEqual([
      "authorize",
      "blocked",
      s.a.first,
      "freecorps",
    ]);
    // The owner is pointed to the second company, which can still be released.
    expect(steps((await tasksOf(s.owner, s.a.organizationId)).capture)).toEqual([
      ["company", "done", s.a.second, null],
      ["certificate", "todo", s.a.second, null],
      ["authorize", "blocked", s.a.second, "previous"],
      ["start", "blocked", s.a.second, "previous"],
    ]);
    // Both blocked: the owner, too, cannot authorize, and nothing after it is to do.
    await block(s.a.second);
    expect(steps((await tasksOf(s.owner, s.a.organizationId)).capture)).toEqual([
      ["company", "done", s.a.first, null],
      ["certificate", "done", s.a.first, null],
      ["authorize", "blocked", s.a.first, "freecorps"],
      ["start", "blocked", s.a.first, "previous"],
    ]);
  });
});
