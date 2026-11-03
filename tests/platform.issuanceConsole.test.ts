/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import {
  ISSUANCE_SCOPES,
  issuerScope,
  nfseProfile,
  person,
  platformTest,
  softwareLicense,
  syntheticApiKey,
  usePlatformEnvironment,
  type PlatformTest,
} from "./helpers/platform";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import type { IssuanceInput } from "../platform/convex/lib/issuanceValues";

/**
 * Console functions of the NFS-e issuance (session only), over the simulated sandbox transport.
 * Every company, CNPJ, CPF and taker is synthetic; nothing here proves an authorization.
 */
const NOW = Date.UTC(2026, 9, 8, 15); // Thursday, 08/10/2026 12:00 in Brasília
const SITE = "http://localhost:5199";

usePlatformEnvironment({
  siteUrl: SITE,
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-issuance-console",
  now: NOW,
});
type T = PlatformTest;

/**
 * Organization, integration project with a key, declared company with an NFS-e profile in São
 * Paulo (Sefin Nacional). The console works on the company: `where` has no project.
 */
async function fixture(t = platformTest(), options: { demonstration?: boolean } = {}) {
  const keyHash = await hashApiKey(syntheticApiKey("c"));
  // The integration's key issues through the project grant; the console needs none.
  const scope = await issuerScope(t, {
    keyHash,
    kind: options.demonstration ? "demonstration" : "declared",
    grantScopes: ISSUANCE_SCOPES,
    keyScopes: [],
  });
  // The activity has no NBS: the console shows it as absent.
  const { nbs: _nbs, ...withoutNbs } = softwareLicense;
  await nfseProfile(t, scope, { activities: [withoutNbs] });
  const owner = await person(t, scope.organizationId, "owner");
  const where = {
    organizationId: scope.organizationId,
    companyId: scope.companyId,
    environment: "sandbox" as const,
  };
  return { t, scope, where, owner, keyHash };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Client = Fixture["owner"];

const domestic = (overrides: Partial<IssuanceInput> = {}): IssuanceInput => ({
  activityCode: "licenca",
  competence: "2026-10",
  issuerEmail: "fiscal@prestador.example",
  market: "domestic",
  taker: {
    kind: "national",
    document: "11.444.777/0001-61",
    name: "Tomador Sintético Ltda",
    address: {
      municipalityCode: "3550308",
      postalCode: "01001-000",
      street: "Praça da Sé",
      number: "100",
      district: "Sé",
    },
  },
  description: "Licença de uso de software, outubro de 2026",
  amount: { currency: "BRL", value: "1000" },
  issRate: "2.5",
  issWithheld: false,
  ...overrides,
});
const exported = (): IssuanceInput => ({
  activityCode: "licenca",
  competence: "2026-10",
  issueDate: "2026-10-05",
  issuerEmail: "fiscal@prestador.example",
  market: "export",
  taker: {
    kind: "foreign",
    nifAbsence: 2,
    name: "Example Grocery LLC",
    address: {
      country: "US",
      city: "San Francisco",
      postalCode: "94105",
      state: "CA",
      street: "Market St",
      number: "548",
      district: "SoMa",
    },
  },
  description: "Software subscription, October 2026",
  amount: { currency: "USD", value: "1000.00" },
  issWithheld: false,
});

function code(promise: Promise<unknown>) {
  return promise.then(
    () => "OK",
    (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
  );
}
const request = (client: Client, where: Fixture["where"], key: string, input = domestic()) =>
  client.mutation(api.issuanceConsole.request, { ...where, idempotencyKey: key, input });
const detail = (client: Client, where: Fixture["where"], issuanceId: string) =>
  client.query(api.issuanceConsole.detail, { ...where, issuanceId });
const list = (client: Client, where: Fixture["where"]) =>
  client.query(api.issuanceConsole.list, {
    ...where,
    paginationOpts: { numItems: 10, cursor: null },
  });

async function drive(t: T, issuanceId: Id<"issuances">, cancellation = false) {
  const operationId = await t.run(async (ctx) => {
    const row = (await ctx.db.get("issuances", issuanceId))!;
    if (!cancellation) return row.operationId;
    return (await ctx.db.get("issuanceCancellations", row.cancellationId!))!.operationId;
  });
  for (let i = 0; i < 4; i++) {
    const op = (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
    if (!["queued", "retry_wait", "reconciling"].includes(op.state)) break;
    vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
    await t.action(internal.operationWorker.run, { operationId, generation: op.generation });
  }
}

describe("emissão pelo console", () => {
  it("emite, lista, detalha com histórico e a mesma tentativa não emite duas vezes", async () => {
    const f = await fixture();
    const first = await request(f.owner, f.where, "console-1");
    expect(first.reused).toBe(false);
    // Double submit with the same attempt key returns the same issuance.
    const again = await request(f.owner, f.where, "console-1");
    expect(again).toEqual({ reused: true, issuanceId: first.issuanceId });
    const processing = await detail(f.owner, f.where, first.issuanceId);
    expect(processing.issuance).toMatchObject({ state: "processing", transport: "simulated" });
    expect(processing.canCancel).toBe(false);
    await drive(f.t, first.issuanceId);
    const done = await detail(f.owner, f.where, first.issuanceId);
    expect(done.issuance).toMatchObject({ state: "authorized", serviceBrl: "1000.00" });
    expect(done.snapshot).toMatchObject({
      taker: { kind: "national", documentType: "CNPJ", document: "11444777000161" },
      iss: { rate: "2.5000", withheld: false, amount: "25.00" },
      activity: { code: "licenca", nbs: null },
      issuer: { email: "fiscal@prestador.example" },
    });
    expect(done.events.map((e) => e.kind)).toEqual([
      "accepted",
      "dps_saved",
      "submitted",
      "danfse_saved",
      "authorized",
    ]);
    expect(done.canCancel).toBe(true);
    const page = await list(f.owner, f.where);
    expect(page.page).toHaveLength(1);
    expect(page.page[0]).toMatchObject({
      id: first.issuanceId,
      takerName: "Tomador Sintético Ltda",
      state: "authorized",
    });
    const usage = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
    expect(usage.filter((u) => u.metric === "issuances")).toHaveLength(1);
  });

  it("exportação mostra a PTAX congelada e o tomador sem NIF", async () => {
    const f = await fixture();
    const { issuanceId } = await request(f.owner, f.where, "export-1", exported());
    await drive(f.t, issuanceId);
    const done = await detail(f.owner, f.where, issuanceId);
    expect(done.issuance.state).toBe("authorized");
    expect(done.issuance.exchange).toMatchObject({
      currency: "USD",
      quoteDate: "2026-10-02",
      source: "simulated",
    });
    expect(done.snapshot.taker).toMatchObject({ kind: "foreign", nif: null, nifAbsence: 2 });
    expect(done.snapshot.iss).toEqual({ rate: null, withheld: false, amount: null });
  });

  it("cancela pelo console com motivo, sem repetir o efeito na mesma tentativa", async () => {
    const f = await fixture();
    const { issuanceId } = await request(f.owner, f.where, "para-cancelar");
    await drive(f.t, issuanceId);
    const cancel = (client: Client, key: string, reason = "Serviço emitido em duplicidade") =>
      client.mutation(api.issuanceConsole.cancel, {
        ...f.where,
        idempotencyKey: key,
        issuanceId,
        reasonCode: "1",
        reason,
      });
    expect(await code(cancel(f.owner, "c-curto", "curto"))).toBe("CANCEL_REASON_INVALID");
    const viewer = await person(f.t, f.where.organizationId, "viewer", {
      companyId: f.where.companyId,
    });
    expect(await code(cancel(viewer, "c-viewer"))).toBe("SCOPE_DENIED");
    expect((await detail(viewer, f.where, issuanceId)).canCancel).toBe(false);
    expect((await cancel(f.owner, "c-1")).reused).toBe(false);
    expect((await cancel(f.owner, "c-1")).reused).toBe(true);
    const pending = await detail(f.owner, f.where, issuanceId);
    expect(pending.issuance.cancellation?.state).toBe("processing");
    expect(pending.canCancel).toBe(false);
    await drive(f.t, issuanceId, true);
    const cancelled = await detail(f.owner, f.where, issuanceId);
    expect(cancelled.issuance.state).toBe("cancelled");
    expect(cancelled.events.map((e) => e.kind)).toContain("cancelled");
    expect(await f.t.run((ctx) => ctx.db.query("issuanceCancellations").collect())).toHaveLength(1);
  });
});

describe("permissões e isolamento", () => {
  const context = (client: Client, where: Fixture["where"]) =>
    client.query(api.issuanceConsole.context, {
      organizationId: where.organizationId,
      company: where.companyId,
    });
  const cancel = (client: Client, where: Fixture["where"], issuanceId: string, key: string) =>
    client.mutation(api.issuanceConsole.cancel, {
      ...where,
      idempotencyKey: key,
      issuanceId,
      reasonCode: "1",
      reason: "Serviço emitido em duplicidade",
    });

  it("emitem owner, admin e operator; viewer lê; developer não usa o console", async () => {
    const f = await fixture();
    const { issuanceId } = await request(f.owner, f.where, "base");
    await drive(f.t, issuanceId);
    const admin = await person(f.t, f.where.organizationId, "admin");
    const operator = await person(f.t, f.where.organizationId, "operator", {
      companyId: f.where.companyId,
    });
    const viewer = await person(f.t, f.where.organizationId, "viewer", {
      companyId: f.where.companyId,
    });
    const developer = await person(f.t, f.where.organizationId, "developer", {
      companyId: f.where.companyId,
    });
    expect(await code(request(admin, f.where, "admin"))).toBe("OK");
    expect(await code(request(operator, f.where, "operator"))).toBe("OK");
    expect(await code(request(viewer, f.where, "viewer"))).toBe("SCOPE_DENIED");
    expect(await code(request(developer, f.where, "developer"))).toBe("SCOPE_DENIED");
    for (const reader of [f.owner, admin, operator, viewer])
      expect((await detail(reader, f.where, issuanceId)).issuance.id).toBe(issuanceId);
    // A developer reaches fiscal data only through the integrations it manages.
    expect(await code(detail(developer, f.where, issuanceId))).toBe("SCOPE_DENIED");
    expect(await code(list(developer, f.where))).toBe("SCOPE_DENIED");
    expect((await detail(viewer, f.where, issuanceId)).canCancel).toBe(false);
    expect((await detail(operator, f.where, issuanceId)).canCancel).toBe(true);
    expect(await code(cancel(viewer, f.where, issuanceId, "c-viewer"))).toBe("SCOPE_DENIED");
    expect(await code(cancel(developer, f.where, issuanceId, "c-dev"))).toBe("SCOPE_DENIED");
    expect(await code(cancel(operator, f.where, issuanceId, "c-operator"))).toBe("OK");
    expect(await context(operator, f.where)).toMatchObject({
      companyId: f.where.companyId,
      canIssue: true,
      transport: "simulated",
    });
    expect(await context(viewer, f.where)).toMatchObject({ canIssue: false });
    expect(await context(developer, f.where)).toMatchObject({ canIssue: false });
    // A member without access to the company does not reach it.
    const stranger = await person(f.t, f.where.organizationId, "operator");
    expect(await code(request(stranger, f.where, "stranger"))).toBe("NOT_FOUND");
    expect(await code(list(stranger, f.where))).toBe("NOT_FOUND");
    expect(await code(detail(stranger, f.where, issuanceId))).toBe("NOT_FOUND");
    expect(await context(stranger, f.where)).toMatchObject({ companyId: null, canIssue: false });
    // Without a session nothing is read nor accepted.
    expect(await code(request(f.t as unknown as Client, f.where, "anon"))).not.toBe("OK");
    expect(await code(list(f.t as unknown as Client, f.where))).not.toBe("OK");
  });

  it("membro removido ou sem a concessão da empresa perde o acesso", async () => {
    const f = await fixture();
    const { issuanceId } = await request(f.owner, f.where, "base");
    const operator = await person(f.t, f.where.organizationId, "operator", {
      companyId: f.where.companyId,
    });
    expect(await code(request(operator, f.where, "antes"))).toBe("OK");
    await f.t.run(async (ctx) => {
      const grant = (await ctx.db
        .query("companyGrants")
        .withIndex("by_companyId_and_membershipId", (q) =>
          q.eq("companyId", f.where.companyId).eq("membershipId", operator.membershipId),
        )
        .unique())!;
      await ctx.db.patch("companyGrants", grant._id, { active: false, version: 2 });
    });
    expect(await code(request(operator, f.where, "sem-concessao"))).toBe("NOT_FOUND");
    expect(await code(detail(operator, f.where, issuanceId))).toBe("NOT_FOUND");
    const admin = await person(f.t, f.where.organizationId, "admin");
    expect(await code(request(admin, f.where, "admin"))).toBe("OK");
    await f.t.run((ctx) =>
      ctx.db.patch("memberships", admin.membershipId, { state: "removed", version: 2 }),
    );
    expect(await code(request(admin, f.where, "removido"))).not.toBe("OK");
    expect(await code(list(admin, f.where))).not.toBe("OK");
  });

  it("sem concessão de projeto: o console emite, lista a empresa inteira e não avisa outros projetos", async () => {
    const f = await fixture();
    // The integration loses every issuance scope; people do not depend on it.
    const grantId = await f.t.run(
      async (ctx) =>
        (await ctx.db
          .query("projectCompanies")
          .withIndex("by_projectId_and_companyId", (q) =>
            q.eq("projectId", f.scope.projectId).eq("companyId", f.where.companyId),
          )
          .unique())!._id,
    );
    const endpointId = await f.t.run((ctx) =>
      ctx.db.insert("webhookEndpoints", {
        organizationId: f.where.organizationId,
        projectId: f.scope.projectId,
        companyId: f.where.companyId,
        environment: "sandbox",
        name: "Destino sintético",
        url: "https://receiver.example.com/webhook",
        events: ["issuance.authorized", "issuance.cancelled"],
        active: true,
        version: 1,
        secretVersion: 1,
        secret: "ciphertext-sintetico",
        projectEpoch: 0,
        grantEpoch: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    // The integration issues through its key while it holds the scope.
    await f.t.run(async (ctx) => {
      const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
      await ctx.db.patch("apiKeys", key._id, { scopes: [...key.scopes, "documents:issue"] });
    });
    const byKey = await f.t.mutation(internal.issuance.request, {
      ...f.where,
      projectId: f.scope.projectId,
      keyHash: f.keyHash,
      idempotencyKey: "pela-api",
      input: domestic(),
    });
    await f.t.run((ctx) =>
      ctx.db.patch("projectCompanies", grantId, { scopes: ["documents:read"] }),
    );
    const { issuanceId } = await request(f.owner, f.where, "pelo-console");
    await drive(f.t, issuanceId);
    // The console lists every issuance of the company, whichever project requested it.
    expect((await list(f.owner, f.where)).page.map((row) => row.id).sort()).toEqual(
      [issuanceId, byKey.issuance.id].sort(),
    );
    expect((await detail(f.owner, f.where, byKey.issuance.id)).issuance.id).toBe(byKey.issuance.id);
    // The console's issuance belongs to the console project, which has no webhooks: the
    // integration's endpoint receives nothing about it.
    const delivered = await f.t.run(async (ctx) => {
      const events = await ctx.db.query("outboxEvents").collect();
      const deliveries = await ctx.db.query("webhookDeliveries").collect();
      return events
        .filter((event) => event.type === "issuance.authorized")
        .map((event) => ({
          resource: (JSON.parse(event.body) as { resource: { id: string } }).resource.id,
          endpoints: deliveries.filter((d) => d.eventId === event._id).map((d) => d.endpointId),
        }));
    });
    expect(delivered.find((event) => event.resource === issuanceId)?.endpoints).toEqual([]);
    expect(delivered.some((event) => event.endpoints.includes(endpointId))).toBe(false);
    const console = await f.t.run(async (ctx) => {
      const issuance = (await ctx.db.get("issuances", issuanceId as Id<"issuances">))!;
      return (await ctx.db.get("projects", issuance.projectId))!;
    });
    expect(console).toMatchObject({ kind: "console", externalReference: "" });
    // The key keeps needing its grant: without `documents:issue` it is refused.
    expect(
      await code(
        f.t.mutation(internal.issuance.request, {
          ...f.where,
          projectId: f.scope.projectId,
          keyHash: f.keyHash,
          idempotencyKey: "pela-api-sem-escopo",
          input: domestic(),
        }),
      ),
    ).toBe("NOT_FOUND");
    // And no key reaches the console project.
    expect(
      await code(
        f.t.query(internal.issuance.get, {
          ...f.where,
          projectId: console._id,
          keyHash: f.keyHash,
          issuanceId,
        }),
      ),
    ).not.toBe("OK");
  });

  it("detalhe, ticket e cancelamento seguem a matriz de papéis", async () => {
    const f = await fixture();
    const { issuanceId } = await request(f.owner, f.where, "matriz");
    await drive(f.t, issuanceId);
    const nfse = (await detail(f.owner, f.where, issuanceId)).issuance.artifacts.find(
      (artifact) => artifact.kind === "nfse",
    )!;
    const org = f.where.organizationId,
      company = f.where.companyId;
    const actors = {
      owner: f.owner,
      admin: await person(f.t, org, "admin"),
      operator: await person(f.t, org, "operator", { companyId: company }),
      viewer: await person(f.t, org, "viewer", { companyId: company }),
      developer: await person(f.t, org, "developer", { companyId: company }),
      outsider: await person(f.t, org, "operator"),
      removed: await person(f.t, org, "operator", { companyId: company }),
      revoked: await person(f.t, org, "operator", { companyId: company }),
      anonymous: f.t as unknown as Client,
    };
    await f.t.run(async (ctx) => {
      await ctx.db.patch("memberships", actors.removed.membershipId, {
        state: "removed",
        version: 2,
      });
      const grant = (await ctx.db
        .query("companyGrants")
        .withIndex("by_companyId_and_membershipId", (q) =>
          q.eq("companyId", company).eq("membershipId", actors.revoked.membershipId),
        )
        .unique())!;
      await ctx.db.patch("companyGrants", grant._id, { active: false, version: 2 });
    });
    const run = async (call: (client: Client) => Promise<unknown>) => {
      const answers: Record<string, string> = {};
      for (const [name, client] of Object.entries(actors)) answers[name] = await code(call(client));
      return answers;
    };
    const denied = {
      outsider: "NOT_FOUND",
      removed: "ACCESS_DENIED",
      revoked: "NOT_FOUND",
      anonymous: "UNAUTHENTICATED",
    };
    const read = {
      owner: "OK",
      admin: "OK",
      operator: "OK",
      viewer: "OK",
      developer: "SCOPE_DENIED",
      ...denied,
    };
    expect(await run((client) => detail(client, f.where, issuanceId))).toEqual(read);
    expect(
      await run((client) =>
        client.mutation(api.issuanceConsole.artifactTicket, {
          ...f.where,
          issuanceId,
          artifactId: nfse.id,
        }),
      ),
    ).toEqual(read);
    // The first writer asks for the cancellation; the next ones get the one in progress.
    expect(
      await run((client) =>
        client.mutation(api.issuanceConsole.cancel, {
          ...f.where,
          idempotencyKey: crypto.randomUUID(),
          issuanceId,
          reasonCode: "1",
          reason: "Serviço emitido em duplicidade",
        }),
      ),
    ).toEqual({ ...read, viewer: "SCOPE_DENIED" });
    expect(await f.t.run((ctx) => ctx.db.query("issuanceCancellations").collect())).toHaveLength(1);
  });

  it("cancelar pelo console a emissão de uma integração notifica só o projeto dono", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
      await ctx.db.patch("apiKeys", key._id, { scopes: [...key.scopes, "documents:issue"] });
    });
    const byKey = await f.t.mutation(internal.issuance.request, {
      ...f.where,
      projectId: f.scope.projectId,
      keyHash: f.keyHash,
      idempotencyKey: "da-integracao",
      input: domestic(),
    });
    const issuanceId = byKey.issuance.id as Id<"issuances">;
    await drive(f.t, issuanceId);
    // A second integration of the same company, with every scope and its own endpoint.
    const endpoint = (projectId: Id<"projects">) =>
      f.t.run((ctx) =>
        ctx.db.insert("webhookEndpoints", {
          organizationId: f.where.organizationId,
          projectId,
          companyId: f.where.companyId,
          environment: "sandbox",
          name: "Destino sintético",
          url: "https://receiver.example.com/webhook",
          events: ["issuance.cancelled"],
          active: true,
          version: 1,
          secretVersion: 1,
          secret: "ciphertext-sintetico",
          projectEpoch: 0,
          grantEpoch: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    const otherProject = await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...project } = (await ctx.db.get("projects", f.scope.projectId))!;
      const id = await ctx.db.insert("projects", { ...project, externalReference: "outra" });
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.where.companyId),
        )
        .unique())!;
      const { _id: _g, _creationTime: _gt, ...rest } = grant;
      await ctx.db.insert("projectCompanies", { ...rest, projectId: id });
      return id;
    });
    const owned = await endpoint(f.scope.projectId);
    const foreign = await endpoint(otherProject);
    const cancelled = await f.owner.mutation(api.issuanceConsole.cancel, {
      ...f.where,
      idempotencyKey: "console-cancela",
      issuanceId,
      reasonCode: "2",
      reason: "Serviço não prestado ao tomador sintético",
    });
    expect(cancelled.reused).toBe(false);
    await drive(f.t, issuanceId, true);
    expect((await detail(f.owner, f.where, issuanceId)).issuance.state).toBe("cancelled");
    const deliveries = await f.t.run(async (ctx) => {
      const events = (await ctx.db.query("outboxEvents").collect()).filter(
        (event) => event.type === "issuance.cancelled",
      );
      const rows = await ctx.db.query("webhookDeliveries").collect();
      return rows.filter((row) => events.some((event) => event._id === row.eventId));
    });
    expect(deliveries.map((row) => row.endpointId)).toEqual([owned]);
    expect(deliveries.map((row) => row.endpointId)).not.toContain(foreign);
    // The cancellation operation belongs to the console project; the issuance stays the
    // integration's.
    const owners = await f.t.run(async (ctx) => {
      const row = (await ctx.db.get("issuances", issuanceId))!;
      const cancellation = (await ctx.db.get("issuanceCancellations", row.cancellationId!))!;
      const op = (await ctx.db.get("operations", cancellation.operationId))!;
      return { issuance: row.projectId, operation: (await ctx.db.get("projects", op.projectId))! };
    });
    expect(owners.issuance).toBe(f.scope.projectId);
    expect(owners.operation.kind).toBe("console");
  });

  it("isola organizações e empresas", async () => {
    const f = await fixture();
    const { issuanceId } = await request(f.owner, f.where, "isolada");
    const other = await fixture(f.t);
    expect(await code(request(other.owner, f.where, "x"))).not.toBe("OK");
    expect(await code(detail(other.owner, other.where, issuanceId))).toBe("NOT_FOUND");
    expect(await code(list(other.owner, f.where))).not.toBe("OK");
    expect((await list(other.owner, other.where)).page).toEqual([]);
    // Another company of the same organization cannot be used as selector for this issuance.
    const companyId = await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...company } = (await ctx.db.get(
        "companies",
        f.where.companyId,
      ))!;
      return ctx.db.insert("companies", { ...company, cnpj: "11444777000161" });
    });
    expect(await code(detail(f.owner, { ...f.where, companyId }, issuanceId))).toBe("NOT_FOUND");
    expect((await list(f.owner, { ...f.where, companyId })).page).toEqual([]);
    // A production selector stays closed in this sandbox deployment, by access, before the gate.
    expect(
      await code(request(f.owner, { ...f.where, environment: "production" as never }, "prod")),
    ).toBe("NOT_FOUND");
  });

  it("empresa de demonstração não emite e o console sabe disso", async () => {
    const f = await fixture(platformTest(), { demonstration: true });
    expect(await code(request(f.owner, f.where, "demo"))).toBe("ISSUANCE_DEMONSTRATION_DENIED");
    expect(await context(f.owner, f.where)).toMatchObject({
      canIssue: false,
      company: { demonstration: true },
    });
  });
});

describe("lista filtrada, origem, correção e tomadores frequentes", () => {
  const resubmission = (client: Client, where: Fixture["where"], issuanceId: string) =>
    client.query(api.issuanceConsole.resubmission, { ...where, issuanceId });
  const takers = (client: Client, where: Fixture["where"]) =>
    client.query(api.issuanceConsole.recentTakers, where);

  it("filtra por situação e período e diz a origem de cada emissão", async () => {
    const f = await fixture();
    const ok = await request(f.owner, f.where, "ok");
    await drive(f.t, ok.issuanceId);
    vi.setSystemTime(NOW + 1_800_000);
    const refused = await request(
      f.owner,
      f.where,
      "recusada",
      domestic({ description: "Teste sintético [simular:rejeicao]" }),
    );
    await drive(f.t, refused.issuanceId);
    await f.t.run(async (ctx) => {
      const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
      await ctx.db.patch("apiKeys", key._id, { scopes: [...key.scopes, "documents:issue"] });
    });
    const byKey = await f.t.mutation(internal.issuance.request, {
      ...f.where,
      projectId: f.scope.projectId,
      keyHash: f.keyHash,
      idempotencyKey: "pela-api",
      input: domestic(),
    });
    const filtered = (filters: { state?: "rejected" | "authorized"; from?: number; to?: number }) =>
      f.owner.query(api.issuanceConsole.list, {
        ...f.where,
        ...filters,
        paginationOpts: { numItems: 10, cursor: null },
      });
    expect((await filtered({ state: "rejected" })).page.map((row) => row.id)).toEqual([
      refused.issuanceId,
    ]);
    expect((await filtered({ state: "authorized" })).page.map((row) => row.id)).toEqual([
      ok.issuanceId,
    ]);
    expect((await filtered({ to: NOW + 1000 })).page.map((row) => row.id)).toEqual([ok.issuanceId]);
    expect((await filtered({ from: NOW + 1000 })).page).toHaveLength(2);
    expect(await code(filtered({ from: NOW + 1000, to: NOW }))).toBe("INVALID_REQUEST");
    const integration = await f.t.run(
      async (ctx) => (await ctx.db.get("projects", f.scope.projectId))!.name,
    );
    const rows = (await filtered({})).page;
    expect(rows.find((row) => row.id === byKey.issuance.id)!.origin).toEqual({
      kind: "integration",
      integration,
    });
    expect(rows.find((row) => row.id === ok.issuanceId)!.origin).toEqual({
      kind: "console",
      integration: null,
    });
    expect((await detail(f.owner, f.where, byKey.issuance.id)).origin).toEqual({
      kind: "integration",
      integration,
    });
  });

  it("corrige uma rejeitada com um pedido novo, com outro número de DPS", async () => {
    const f = await fixture();
    const refused = await request(
      f.owner,
      f.where,
      "recusada",
      domestic({ description: "Teste sintético [simular:rejeicao]" }),
    );
    await drive(f.t, refused.issuanceId);
    const before = await detail(f.owner, f.where, refused.issuanceId);
    expect(before.issuance.state).toBe("rejected");
    const input = await resubmission(f.owner, f.where, refused.issuanceId);
    expect(input).toMatchObject({
      activityCode: "licenca",
      competence: "2026-10",
      market: "domestic",
      issRate: "2.5000",
      issWithheld: false,
      amount: { currency: "BRL", value: "1000.00" },
      taker: { kind: "national", document: "11444777000161" },
    });
    expect(input).not.toHaveProperty("issueDate");
    const again = await request(f.owner, f.where, "corrigida", {
      ...input,
      description: "Licença de uso de software, outubro de 2026",
    });
    expect(again.issuanceId).not.toBe(refused.issuanceId);
    const after = await detail(f.owner, f.where, again.issuanceId);
    expect(after.issuance.number).toBe(before.issuance.number + 1);
    expect((await detail(f.owner, f.where, refused.issuanceId)).issuance.state).toBe("rejected");
  });

  it("devolve o pedido de exportação sem alíquota, no formato aceito pelo pedido", async () => {
    const f = await fixture();
    const { issuanceId } = await request(f.owner, f.where, "exportacao", exported());
    const input = await resubmission(f.owner, f.where, issuanceId);
    expect(input).not.toHaveProperty("issRate");
    expect(input).toMatchObject({
      market: "export",
      amount: { currency: "USD" },
      taker: { kind: "foreign", nifAbsence: 2, address: { country: "US", postalCode: "94105" } },
    });
    expect(input.taker).not.toHaveProperty("nif");
    expect((await request(f.owner, f.where, "exportacao-2", input)).issuanceId).not.toBe(
      issuanceId,
    );
  });

  it("sugere tomadores só da própria empresa, sem repetir, a quem lê a empresa", async () => {
    const f = await fixture();
    await request(f.owner, f.where, "a");
    await request(f.owner, f.where, "b");
    await request(f.owner, f.where, "c", exported());
    expect((await takers(f.owner, f.where)).map(({ taker }) => taker.name)).toEqual([
      "Example Grocery LLC",
      "Tomador Sintético Ltda",
    ]);
    const viewer = await person(f.t, f.where.organizationId, "viewer", {
      companyId: f.where.companyId,
    });
    expect(await takers(viewer, f.where)).toHaveLength(2);
    const developer = await person(f.t, f.where.organizationId, "developer", {
      companyId: f.where.companyId,
    });
    expect(await code(takers(developer, f.where))).toBe("SCOPE_DENIED");
    const stranger = await person(f.t, f.where.organizationId, "operator");
    expect(await code(takers(stranger, f.where))).toBe("NOT_FOUND");
    // Another company of the same organization has its own takers: none of these.
    const companyId = await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...company } = (await ctx.db.get(
        "companies",
        f.where.companyId,
      ))!;
      return ctx.db.insert("companies", { ...company, cnpj: "11444777000161" });
    });
    expect(await takers(f.owner, { ...f.where, companyId })).toEqual([]);
    // Another organization reaches neither the takers nor the request to correct.
    const other = await fixture(f.t);
    const { issuanceId } = await request(f.owner, f.where, "d");
    expect(await code(takers(other.owner, f.where))).not.toBe("OK");
    expect(await code(resubmission(other.owner, f.where, issuanceId))).not.toBe("OK");
    expect(await code(resubmission(other.owner, other.where, issuanceId))).toBe("NOT_FOUND");
    expect(await code(resubmission(stranger, f.where, issuanceId))).toBe("NOT_FOUND");
    expect(await code(resubmission(f.owner, { ...f.where, companyId }, issuanceId))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("download dos XML", () => {
  async function authorized() {
    const f = await fixture();
    const { issuanceId } = await request(f.owner, f.where, "xml");
    await drive(f.t, issuanceId);
    const view = (await detail(f.owner, f.where, issuanceId)).issuance;
    const nfse = view.artifacts.find((a) => a.kind === "nfse")!;
    return { f, issuanceId, nfse };
  }
  const fetchXml = (t: T, token: string) =>
    t.fetch("/v1/document-download", {
      headers: { Origin: SITE, "X-Download-Token": token, "X-Request-Id": crypto.randomUUID() },
    });

  it("entrega o XML autorizado por ticket de uso curto, como os originais", async () => {
    const { f, issuanceId, nfse } = await authorized();
    const viewer = await person(f.t, f.where.organizationId, "viewer", {
      companyId: f.where.companyId,
    });
    const ticket = await viewer.mutation(api.issuanceConsole.artifactTicket, {
      ...f.where,
      issuanceId,
      artifactId: nfse.id,
    });
    const response = await fetchXml(f.t, ticket.token);
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain("sem validade fiscal");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // The ticket expires after a minute.
    vi.setSystemTime(Date.now() + 61_000);
    expect((await fetchXml(f.t, ticket.token)).status).toBe(404);
  });

  it("recusa artefato de outra emissão, outra organização e acesso revogado", async () => {
    const { f, issuanceId, nfse } = await authorized();
    const other = await fixture(f.t);
    const { issuanceId: otherId } = await request(other.owner, other.where, "xml-outra");
    await drive(f.t, otherId);
    const otherArtifact = (await detail(other.owner, other.where, otherId)).issuance.artifacts[0]!;
    const ticket = (client: Client, where: Fixture["where"], issuance: string, artifact: string) =>
      code(
        client.mutation(api.issuanceConsole.artifactTicket, {
          ...where,
          issuanceId: issuance,
          artifactId: artifact,
        }),
      );
    expect(await ticket(f.owner, f.where, issuanceId, otherArtifact.id)).toBe("NOT_FOUND");
    expect(await ticket(other.owner, other.where, otherId, nfse.id)).toBe("NOT_FOUND");
    expect(await ticket(other.owner, f.where, issuanceId, nfse.id)).not.toBe("OK");
    // A ticket issued before the company access was revoked is refused at download time.
    const operator = await person(f.t, f.where.organizationId, "operator", {
      companyId: f.where.companyId,
    });
    const issued = await operator.mutation(api.issuanceConsole.artifactTicket, {
      ...f.where,
      issuanceId,
      artifactId: nfse.id,
    });
    await f.t.run(async (ctx) => {
      const grant = (await ctx.db
        .query("companyGrants")
        .withIndex("by_companyId_and_membershipId", (q) =>
          q.eq("companyId", f.where.companyId).eq("membershipId", operator.membershipId),
        )
        .unique())!;
      await ctx.db.patch("companyGrants", grant._id, { active: false, version: 2 });
    });
    expect((await fetchXml(f.t, issued.token)).status).toBe(404);
  });
});
