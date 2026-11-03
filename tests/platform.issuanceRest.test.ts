/// <reference types="vite/client" />
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { internal } from "../platform/convex/_generated/api";
import type { Doc, Id } from "../platform/convex/_generated/dataModel";
import {
  ISSUANCE_SCOPES,
  issuerScope,
  nfseProfile,
  platformTest,
  projectGrant,
  syntheticApiKey,
  usePlatformEnvironment,
  type PlatformTest,
} from "./helpers/platform";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import { encryptCertificate } from "../platform/convex/lib/certificateCrypto";
import { syntheticCertificate } from "./helpers/certificates";
import { signApiRequest } from "../platform/auth-transport";
import { routes, errorResponse } from "../packages/contracts/src/external";
import type { WebhookEnvelope } from "../packages/contracts/src/webhooks";

/**
 * Public REST of the NFS-e issuance (`/v1/issuances`) and its webhooks, in the sandbox with the
 * simulated transport. Every company, CNPJ, taker and key is synthetic; nothing here reaches a
 * tax authority, so nothing here proves an authorization.
 */
const NOW = Date.UTC(2026, 9, 8, 15);
const realSetImmediate = globalThis.setImmediate;

/**
 * No deployment of the platform is the fiscal production of the issuance yet
 * (`deploy/issuance-production.json` names none), so no caller ever reaches the production gate.
 * Here the plan names a synthetic deployment, and one test switches the backend to its profile,
 * with requests signed like the Worker's, only to prove that the gate still stops a caller with
 * access and that the others never see it. The profile itself is proven in
 * `platform.issuanceProduction.test.ts`.
 */
vi.mock("../deploy/issuance-production.json", () => ({
  default: {
    version: 1,
    deployment: "brave-otter-123",
    url: "https://brave-otter-123.convex.cloud",
  },
}));
const PRODUCTION_SITE = "https://brave-otter-123.convex.site";
const PROXY_SECRET = "c".repeat(64);
const signing = { on: false };
function productionDeployment(companyId: string) {
  for (const [name, value] of Object.entries({
    APP_ENV: "installation",
    PRODUCT_ENV: "production",
    EMAIL_MODE: "disabled",
    WEBHOOK_MODE: "https",
    AUTH_PROXY_MODE: "signed",
    AUTH_PROXY_SECRET: PROXY_SECRET,
    SITE_URL: "https://console.producao.invalid",
    CONVEX_SITE_URL: PRODUCTION_SITE,
    CONVEX_CLOUD_URL: "https://brave-otter-123.convex.cloud",
    API_URL: "https://api.producao.invalid",
    FNFE_ISSUANCE_ENV: "production",
    FNFE_NFSE_PRODUCTION_COMPANIES: companyId,
  }))
    vi.stubEnv(name, value);
  signing.on = true;
}

usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-issuance-rest",
  now: NOW,
});
afterEach(() => {
  signing.on = false;
});
type T = PlatformTest;

/** Organization, project, key and declared company with an NFS-e profile in São Paulo. */
async function fixture(t = platformTest()) {
  const secret = syntheticApiKey("c");
  const scope = await issuerScope(t, {
    keyHash: await hashApiKey(secret),
    kind: "declared",
    grantScopes: ISSUANCE_SCOPES,
    keyScopes: ISSUANCE_SCOPES,
  });
  await nfseProfile(t, scope);
  const call = async (
    path: string,
    init: { method?: string; body?: unknown; key?: string | null; environment?: string } = {},
    bearer = secret,
  ) => {
    const method = init.method ?? "GET";
    // On the production profile only requests signed by the Worker reach the REST.
    const signed = signing.on
      ? await signApiRequest({ method, url: PRODUCTION_SITE + path }, "203.0.113.9", PROXY_SECRET)
      : {};
    return t.fetch(path, {
      method,
      headers: {
        ...signed,
        Authorization: `Bearer ${bearer}`,
        "X-Environment": init.environment ?? "sandbox",
        "Content-Type": "application/json",
        ...(init.key ? { "Idempotency-Key": init.key } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  };
  return { t, scope, secret, call };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A second key of the same project, with its own scopes, companies and environment. */
async function extraKey(
  f: Fixture,
  fields: Partial<Omit<Doc<"apiKeys">, "_id" | "_creationTime">> = {},
) {
  const secret = syntheticApiKey("c");
  const key = (await f.t.run((ctx) => ctx.db.get("apiKeys", f.scope.keyId)))!;
  const { _id, _creationTime, ...rest } = key;
  await f.t.run((ctx) =>
    ctx.db.insert("apiKeys", { ...rest, prefix: "fnfe_extra", ...fields, keyHash: "" }),
  );
  const hash = await hashApiKey(secret);
  await f.t.run(async (ctx) => {
    const row = (await ctx.db.query("apiKeys").collect()).find((k) => k.keyHash === "")!;
    await ctx.db.patch("apiKeys", row._id, { keyHash: hash });
  });
  return secret;
}

const body = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
  companyId: f.scope.companyId,
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

async function json(response: Response) {
  return errorResponse.parse(await response.json());
}
async function errorCode(response: Response) {
  const parsed = errorResponse.parse(await response.json());
  return `${response.status}:${parsed.error.code}`;
}

/** Public ids are opaque strings; the test database still knows them as operation ids. */
async function drive(t: T, publicId: string, steps = 1) {
  const operationId = publicId as Id<"operations">;
  for (let i = 0; i < steps; i++) {
    const op = (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
    if (!["queued", "retry_wait", "reconciling"].includes(op.state)) break;
    vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
    await t.action(internal.operationWorker.run, { operationId, generation: op.generation });
  }
  return (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
}
async function issue(f: Fixture, key: string, overrides: Record<string, unknown> = {}) {
  const response = await f.call("/v1/issuances", {
    method: "POST",
    key,
    body: body(f, overrides),
  });
  expect(response.status).toBe(202);
  const parsed = routes.createIssuance.output.parse(await response.json());
  return { response, ...parsed.data };
}
async function get(f: Fixture, id: string, bearer?: string) {
  const response = await f.call(
    `/v1/issuances/${id}?companyId=${f.scope.companyId}`,
    {},
    bearer ?? f.secret,
  );
  return response;
}
async function endpoint(
  f: Fixture,
  events: Doc<"webhookEndpoints">["events"],
  projectId = f.scope.projectId,
) {
  return f.t.run((ctx) =>
    ctx.db.insert("webhookEndpoints", {
      organizationId: f.scope.organizationId,
      projectId,
      companyId: f.scope.companyId,
      environment: "sandbox",
      name: "Destino sintético",
      url: "https://receiver.example.com/webhook",
      events,
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
}
async function outbox(t: T) {
  return t.run(async (ctx) => {
    const events = await ctx.db.query("outboxEvents").collect();
    const deliveries = await ctx.db.query("webhookDeliveries").collect();
    return events
      .filter((e) => e.type.startsWith("issuance."))
      .map((e) => ({
        type: e.type,
        body: JSON.parse(e.body) as WebhookEnvelope,
        endpoints: deliveries.filter((d) => d.eventId === e._id).map((d) => d.endpointId),
      }));
  });
}

describe("POST /v1/issuances", () => {
  it("aceita, reflete o estado persistido e autoriza no transporte simulado", async () => {
    const f = await fixture();
    const first = await issue(f, "rest-1");
    expect(first.reused).toBe(false);
    // Accepted is not success: the issuance is still processing.
    expect(first.issuance).toMatchObject({ state: "processing", accessKey: null });
    expect(first.response.headers.get("Location")).toBe(`/v1/issuances/${first.issuance.id}`);
    expect(first.issuance).not.toHaveProperty("organizationId");
    expect(first.issuance).not.toHaveProperty("documentId");
    expect((await drive(f.t, first.issuance.operationId)).state).toBe("succeeded");
    const read = await get(f, first.issuance.id);
    expect(read.status).toBe(200);
    const done = routes.getIssuance.output.parse(await read.json()).data;
    expect(done).toMatchObject({
      id: first.issuance.id,
      state: "authorized",
      serviceBrl: "1000.00",
      amount: { currency: "BRL", value: "1000.00" },
      transport: "simulated",
    });
    expect(done.accessKey).toMatch(/^\d{50}$/);
    // The operation of the issuance is readable with the same key.
    const op = await f.call(`/v1/operations/${done.operationId}`);
    expect(op.status).toBe(200);
  });

  it("repete o mesmo efeito com a mesma chave e recusa outro pedido com ela", async () => {
    const f = await fixture();
    const first = await issue(f, "rest-idem");
    const again = await issue(f, "rest-idem");
    expect(again).toMatchObject({ reused: true, issuance: { id: first.issuance.id } });
    const conflict = await f.call("/v1/issuances", {
      method: "POST",
      key: "rest-idem",
      body: body(f, { amount: { currency: "BRL", value: "999" } }),
    });
    expect(await errorCode(conflict)).toBe("409:IDEMPOTENCY_CONFLICT");
    const missing = await f.call("/v1/issuances", { method: "POST", body: body(f) });
    expect(await errorCode(missing)).toBe("400:INVALID_REQUEST");
    const numbers = await f.t.run((ctx) => ctx.db.query("issuances").collect());
    expect(numbers.map((row) => row.number)).toEqual([1]);
  });

  it("valida o schema na borda e as regras fiscais no servidor, com o campo recusado", async () => {
    const f = await fixture();
    const post = (payload: unknown) =>
      f.call("/v1/issuances", { method: "POST", key: crypto.randomUUID(), body: payload });
    expect(await errorCode(await post({ ...body(f), extra: true }))).toBe("400:INVALID_REQUEST");
    expect(await errorCode(await post(body(f, { amount: { currency: "BRL", value: 10 } })))).toBe(
      "400:INVALID_REQUEST",
    );
    const taker = await post(body(f, { taker: { ...body(f).taker, document: "11444777000162" } }));
    expect(taker.status).toBe(400);
    expect((await json(taker)).error).toMatchObject({
      code: "ISSUANCE_TAKER_DOCUMENT_INVALID",
      field: "taker.document",
    });
    expect(await errorCode(await post(body(f, { issRate: undefined })))).toBe(
      "400:ISSUANCE_ISS_RATE_REQUIRED",
    );
    expect(await errorCode(await post(body(f, { activityCode: "outra" })))).toBe(
      "400:NFSE_ACTIVITY_NOT_FOUND",
    );
    // Money beyond the scale of the field is refused at the edge, never rounded.
    expect(
      await errorCode(await post(body(f, { amount: { currency: "BRL", value: "10.001" } }))),
    ).toBe("400:INVALID_REQUEST");
    expect(await errorCode(await post(body(f, { issRate: "2.00001" })))).toBe(
      "400:INVALID_REQUEST",
    );
    // Without `issuerEmail` the profile must hold one.
    const noEmail = await post(body(f, { issuerEmail: undefined }));
    expect(noEmail.status).toBe(400);
    expect((await json(noEmail)).error).toMatchObject({
      code: "ISSUANCE_ISSUER_EMAIL_REQUIRED",
      field: "issuerEmail",
    });
    const left = await f.t.run(async (ctx) => ({
      issuances: await ctx.db.query("issuances").collect(),
      sequences: await ctx.db.query("dpsSequences").collect(),
    }));
    expect(left).toEqual({ issuances: [], sequences: [] });
  });
});

describe("perfil NFS-e na API", () => {
  it("usa o e-mail do perfil e lista o que falta para Campinas", async () => {
    const f = await fixture();
    const profile = await f.t.run(async (ctx) => (await ctx.db.query("nfseProfiles").first())!);
    await f.t.run((ctx) =>
      ctx.db.patch("nfseProfiles", profile._id, { issuerEmail: "perfil@prestador.example" }),
    );
    const accepted = await issue(f, "email-do-perfil", { issuerEmail: undefined });
    const snapshot = await f.t.run(async (ctx) =>
      JSON.parse(
        (await ctx.db.get("issuances", accepted.issuance.id as Id<"issuances">))!.snapshot,
      ),
    );
    expect(snapshot.issuer.email).toBe("perfil@prestador.example");
    // Campinas (non-opting provider since 01/10/2026) needs fields this profile lacks.
    await f.t.run((ctx) =>
      ctx.db.patch("nfseProfiles", profile._id, { municipalityCode: "3509502" }),
    );
    const incomplete = await f.call("/v1/issuances", {
      method: "POST",
      key: "campinas",
      body: body(f),
    });
    expect(incomplete.status).toBe(409);
    const error = (await json(incomplete)).error;
    expect(error.code).toBe("NFSE_ROUTE_PROFILE_INCOMPLETE");
    expect(error.missing).toEqual(expect.arrayContaining(["cTribMun", "ibsCbs"]));
  });

  it("IBS/CBS na Sefin (Ato Conjunto 4/2026): falta no perfil e exportação recusada", async () => {
    const f = await fixture();
    const profile = await f.t.run(async (ctx) => (await ctx.db.query("nfseProfiles").first())!);
    // Subitem 17.01, non-opting provider: the group is required from 01/10/2026.
    const consulting = {
      code: "consultoria",
      label: "Consultoria empresarial",
      cnae: "7020400",
      lc116Item: "17.01",
      cTribNac: "170101",
    };
    await f.t.run((ctx) =>
      ctx.db.patch("nfseProfiles", profile._id, {
        activities: [...profile.activities, consulting],
      }),
    );
    const post = (key: string, overrides: Record<string, unknown>) =>
      f.call("/v1/issuances", { method: "POST", key, body: body(f, overrides) });
    const incomplete = await post("sem-ibscbs", { activityCode: "consultoria" });
    expect(incomplete.status).toBe(409);
    expect((await json(incomplete)).error).toMatchObject({
      code: "NFSE_ROUTE_PROFILE_INCOMPLETE",
      missing: ["ibsCbs"],
    });
    const exportation = await post("exportacao", {
      activityCode: "consultoria",
      market: "export",
      issueDate: "2026-10-05",
      taker: {
        kind: "foreign",
        nif: "98-7654321",
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
      amount: { currency: "USD", value: "1000.00" },
      issRate: undefined,
    });
    expect(exportation.status).toBe(409);
    expect((await json(exportation)).error).toMatchObject({
      // The internal code reaches the public vocabulary as the route refusal (alias, no new enum).
      code: "NFSE_ROUTE_UNSUPPORTED",
      message: expect.stringContaining("grupo IBS/CBS"),
      retryable: false,
    });
    expect(await f.t.run((ctx) => ctx.db.query("dpsSequences").collect())).toEqual([]);
  });
});

describe("leitura, lista e artefatos", () => {
  it("lista paginado e filtra por estado, só no projeto da chave", async () => {
    const f = await fixture();
    const a = await issue(f, "lista-a");
    const b = await issue(f, "lista-b", { description: "Outro serviço [simular:rejeicao]" });
    await drive(f.t, a.issuance.operationId);
    await drive(f.t, b.issuance.operationId);
    const page = await f.call(`/v1/issuances?companyId=${f.scope.companyId}&limit=1`);
    expect(page.status).toBe(200);
    const first = routes.listIssuances.output.parse(await page.json()).data;
    expect(first.page.map((row) => row.id)).toEqual([b.issuance.id]);
    expect(first.nextCursor).toBeTruthy();
    const next = await f.call(
      `/v1/issuances?companyId=${f.scope.companyId}&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    const second = routes.listIssuances.output.parse(await next.json()).data;
    expect(second.page.map((row) => row.id)).toEqual([a.issuance.id]);
    // The cursor is bound to the query: another filter cannot reuse it.
    const wrong = await f.call(
      `/v1/issuances?companyId=${f.scope.companyId}&state=authorized&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(await errorCode(wrong)).toBe("400:INVALID_CURSOR");
    const rejected = await f.call(`/v1/issuances?companyId=${f.scope.companyId}&state=rejected`);
    const filtered = routes.listIssuances.output.parse(await rejected.json()).data;
    expect(filtered.page.map((row) => [row.id, row.state, row.code])).toEqual([
      [b.issuance.id, "rejected", "ADN_REJECTED"],
    ]);
    expect(
      await errorCode(await f.call(`/v1/issuances?companyId=${f.scope.companyId}&state=x`)),
    ).toBe("400:INVALID_REQUEST");
    expect(await errorCode(await f.call(`/v1/issuances`))).toBe("400:INVALID_REQUEST");
    expect(
      await errorCode(await f.call(`/v1/issuances?companyId=${f.scope.companyId}&limit=51`)),
    ).toBe("400:INVALID_REQUEST");
  });

  it("baixa a DPS e a NFS-e preservadas e recusa artefato de outra emissão", async () => {
    const f = await fixture();
    const a = await issue(f, "xml-a");
    const b = await issue(f, "xml-b");
    await drive(f.t, a.issuance.operationId);
    await drive(f.t, b.issuance.operationId);
    const view = routes.getIssuance.output.parse(await (await get(f, a.issuance.id)).json()).data;
    const other = routes.getIssuance.output.parse(await (await get(f, b.issuance.id)).json()).data;
    for (const artifact of view.artifacts) {
      const response = await f.call(
        `/v1/issuances/${view.id}/artifacts/${artifact.id}?companyId=${f.scope.companyId}`,
      );
      expect(response.status).toBe(200);
      const pdf = artifact.kind === "danfse";
      expect(response.headers.get("Content-Disposition")).toBe(
        `attachment; filename="${artifact.kind}.${pdf ? "pdf" : "xml"}"`,
      );
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.length).toBe(artifact.size);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      expect(Buffer.from(digest).toString("hex")).toBe(artifact.sha256);
      expect(new TextDecoder().decode(bytes.slice(0, pdf ? 5 : 1))).toBe(pdf ? "%PDF-" : "<");
    }
    // The DANFSe PDF comes with the authorized XML.
    expect(view.artifacts.map((a) => a.kind).sort()).toEqual(["danfse", "dps", "nfse"]);
    const foreign = await f.call(
      `/v1/issuances/${view.id}/artifacts/${other.artifacts[0]!.id}?companyId=${f.scope.companyId}`,
    );
    expect(await errorCode(foreign)).toBe("404:NOT_FOUND");
    const extra = await f.call(
      `/v1/issuances/${view.id}/artifacts/${view.artifacts[0]!.id}?companyId=${f.scope.companyId}&x=1`,
    );
    expect(await errorCode(extra)).toBe("400:INVALID_REQUEST");
  });
});

describe("acesso por chave", () => {
  it("nega sem escopo, revogada, sem concessão, empresa fora da chave e ambiente errado", async () => {
    const f = await fixture();
    const accepted = await issue(f, "acesso");
    const id = accepted.issuance.id;
    const read = (bearer: string) => get(f, id, bearer);
    const post = (bearer: string, key: string) =>
      f.call("/v1/issuances", { method: "POST", key, body: body(f) }, bearer);

    // Without the issuance scopes on the key.
    const plain = await extraKey(f, { scopes: ["documents:import", "documents:read"] });
    expect(await errorCode(await post(plain, "sem-escopo"))).toBe("403:SCOPE_DENIED");
    expect(await errorCode(await read(plain))).toBe("403:SCOPE_DENIED");
    // A key that only cancels reads but does not issue.
    const canceller = await extraKey(f, { scopes: ["documents:cancel"] });
    expect(await errorCode(await post(canceller, "so-cancela"))).toBe("403:SCOPE_DENIED");
    expect((await read(canceller)).status).toBe(200);
    // A key with both scopes reads through the one it shares with the grant (only cancel here).
    const shared = await projectGrant(f.t, f.scope.projectId, f.scope.companyId);
    await f.t.run((ctx) =>
      ctx.db.patch("projectCompanies", shared._id, {
        scopes: shared.scopes.filter((s) => s !== "documents:issue"),
      }),
    );
    expect((await read(f.secret)).status).toBe(200);
    expect(await errorCode(await post(f.secret, "concessao-so-cancela"))).toBe("404:NOT_FOUND");
    await f.t.run((ctx) => ctx.db.patch("projectCompanies", shared._id, { scopes: shared.scopes }));
    // Wrong environment header and a key of another environment.
    const wrongHeader = await f.call(`/v1/issuances/${id}?companyId=${f.scope.companyId}`, {
      environment: "production",
    });
    expect(await errorCode(wrongHeader)).toBe("403:ENVIRONMENT_DENIED");
    const production = await extraKey(f, { environment: "production" });
    const prodRead = await f.call(
      `/v1/issuances/${id}?companyId=${f.scope.companyId}`,
      { environment: "production" },
      production,
    );
    expect(prodRead.status).toBe(404);
    // Company outside the key.
    const noCompany = await extraKey(f, { companyIds: [], grantEpochs: [] });
    expect(await errorCode(await read(noCompany))).toBe("404:NOT_FOUND");
    expect(await errorCode(await post(noCompany, "sem-empresa"))).toBe("404:NOT_FOUND");
    // Revoked key.
    const revoked = await extraKey(f, { revokedAt: Date.now() - 1 });
    expect(await errorCode(await read(revoked))).toBe("401:INVALID_API_KEY");
    expect(await errorCode(await post(revoked, "revogada"))).toBe("401:INVALID_API_KEY");
    // The project grant loses the issuance scopes: the key alone is not enough.
    const grant = await projectGrant(f.t, f.scope.projectId, f.scope.companyId);
    await f.t.run((ctx) =>
      ctx.db.patch("projectCompanies", grant._id, { scopes: ["documents:import"] }),
    );
    expect(await errorCode(await read(f.secret))).toBe("404:NOT_FOUND");
    expect(await errorCode(await post(f.secret, "sem-concessao"))).toBe("404:NOT_FOUND");
    await f.t.run((ctx) =>
      ctx.db.patch("projectCompanies", grant._id, {
        scopes: [...grant.scopes],
        active: false,
      }),
    );
    expect(await errorCode(await read(f.secret))).toBe("404:NOT_FOUND");
  });

  it("isola outro projeto, outra empresa e outra organização, inclusive no download", async () => {
    const f = await fixture();
    const accepted = await issue(f, "isolada");
    await drive(f.t, accepted.issuance.operationId);
    const view = routes.getIssuance.output.parse(
      await (await get(f, accepted.issuance.id)).json(),
    ).data;
    const artifactPath = `/v1/issuances/${view.id}/artifacts/${view.artifacts[0]!.id}`;

    // Another organization with its own key, company and issuance scopes.
    const other = await fixture(f.t);
    const crossOrg = await other.call(`/v1/issuances/${view.id}?companyId=${f.scope.companyId}`);
    expect(await errorCode(crossOrg)).toBe("404:NOT_FOUND");
    const ownCompany = await other.call(
      `/v1/issuances/${view.id}?companyId=${other.scope.companyId}`,
    );
    expect(await errorCode(ownCompany)).toBe("404:NOT_FOUND");
    expect(
      await errorCode(await other.call(`${artifactPath}?companyId=${other.scope.companyId}`)),
    ).toBe("404:NOT_FOUND");
    const cancelOther = await other.call(`/v1/issuances/${view.id}/cancellation`, {
      method: "POST",
      key: "alheia",
      body: {
        companyId: other.scope.companyId,
        reasonCode: "1",
        reason: "Cancelamento de nota alheia sintética",
      },
    });
    expect(await errorCode(cancelOther)).toBe("404:NOT_FOUND");

    // Same organization, another project with the same company granted.
    const projectSecret = syntheticApiKey("c");
    await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...project } = (await ctx.db.get("projects", f.scope.projectId))!;
      const projectId = await ctx.db.insert("projects", { ...project, externalReference: "outro" });
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
        )
        .unique())!;
      const { _id: _g, _creationTime: _gt, ...rest } = grant;
      await ctx.db.insert("projectCompanies", { ...rest, projectId });
      const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
      const { _id: _k, _creationTime: _kt, ...keyRest } = key;
      await ctx.db.insert("apiKeys", {
        ...keyRest,
        projectId,
        keyHash: await hashApiKey(projectSecret),
      });
    });
    expect(await errorCode(await get(f, view.id, projectSecret))).toBe("404:NOT_FOUND");
    const list = await f.call(`/v1/issuances?companyId=${f.scope.companyId}`, {}, projectSecret);
    expect(routes.listIssuances.output.parse(await list.json()).data.page).toEqual([]);
    expect(
      await errorCode(
        await f.call(`${artifactPath}?companyId=${f.scope.companyId}`, {}, projectSecret),
      ),
    ).toBe("404:NOT_FOUND");
  });
});

describe("cancelamento", () => {
  it("cancela por chave com documents:cancel, de forma idempotente, e reflete o estado", async () => {
    const f = await fixture();
    const accepted = await issue(f, "cancelavel");
    const cancel = (
      key: string,
      reason = "Serviço não prestado ao tomador sintético",
      bearer?: string,
    ) =>
      f.call(
        `/v1/issuances/${accepted.issuance.id}/cancellation`,
        {
          method: "POST",
          key,
          body: { companyId: f.scope.companyId, reasonCode: "2", reason },
        },
        bearer ?? f.secret,
      );
    // Not authorized yet.
    expect(await errorCode(await cancel("cedo"))).toBe("409:ISSUANCE_NOT_CANCELLABLE");
    await drive(f.t, accepted.issuance.operationId);
    expect(await errorCode(await cancel("curto", "curto"))).toBe("400:CANCEL_REASON_INVALID");
    const issuer = await extraKey(f, { scopes: ["documents:issue"] });
    expect(await errorCode(await cancel("sem-escopo", undefined, issuer))).toBe("403:SCOPE_DENIED");
    expect(
      await errorCode(
        await f.call(`/v1/issuances/${accepted.issuance.id}/cancellation`, {
          method: "POST",
          body: {
            companyId: f.scope.companyId,
            reasonCode: "2",
            reason: "Sem chave de idempotência",
          },
        }),
      ),
    ).toBe("400:INVALID_REQUEST");
    const first = await cancel("cancela-1");
    expect(first.status).toBe(202);
    const pending = routes.cancelIssuance.output.parse(await first.json()).data;
    expect(pending).toMatchObject({
      reused: false,
      issuance: { state: "authorized", cancellation: { state: "processing", sequence: 1 } },
    });
    const again = routes.cancelIssuance.output.parse(await (await cancel("cancela-1")).json());
    expect(again.data.reused).toBe(true);
    const operationId = pending.issuance.cancellation!.operationId;
    expect((await drive(f.t, operationId)).state).toBe("succeeded");
    const done = routes.getIssuance.output.parse(
      await (await get(f, accepted.issuance.id)).json(),
    ).data;
    expect(done).toMatchObject({ state: "cancelled", cancellation: { state: "registered" } });
    expect(done.artifacts.map((a) => a.kind).sort()).toEqual([
      "cancel-event",
      "cancel-request",
      "danfse",
      "dps",
      "nfse",
    ]);
    const cancellations = await f.t.run((ctx) => ctx.db.query("issuanceCancellations").collect());
    expect(cancellations).toHaveLength(1);
  });
});

describe("webhooks de emissão", () => {
  it("publica autorização, rejeição e cancelamento só para o projeto, sem duplicar", async () => {
    const f = await fixture();
    const all = [
      "issuance.authorized",
      "issuance.rejected",
      "issuance.cancelled",
      "issuance.cancellation_rejected",
    ] as const;
    const own = await endpoint(f, [...all]);
    // Another project of the organization with the same company does not receive it.
    const otherProject = await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...project } = (await ctx.db.get("projects", f.scope.projectId))!;
      const projectId = await ctx.db.insert("projects", { ...project, externalReference: "x" });
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
        )
        .unique())!;
      const { _id: _g, _creationTime: _gt, ...rest } = grant;
      await ctx.db.insert("projectCompanies", { ...rest, projectId });
      return projectId;
    });
    const foreign = await endpoint(f, [...all], otherProject);

    const ok = await issue(f, "wh-ok");
    const bad = await issue(f, "wh-bad", { description: "Serviço [simular:rejeicao]" });
    await drive(f.t, ok.issuance.operationId);
    await drive(f.t, bad.issuance.operationId);
    // A replayed checkpoint does not publish again.
    await f.t.mutation(internal.issuanceProcessing.checkpointIssue, {
      operationId: ok.issuance.operationId as Id<"operations">,
      response: "{}",
    });
    const cancelRejected = await f.call(`/v1/issuances/${ok.issuance.id}/cancellation`, {
      method: "POST",
      key: "wh-cancel-1",
      body: {
        companyId: f.scope.companyId,
        reasonCode: "9",
        reason: "Teste de rejeição sintética [simular:rejeicao]",
      },
    });
    const first = routes.cancelIssuance.output.parse(await cancelRejected.json()).data;
    await drive(f.t, first.issuance.cancellation!.operationId);
    const cancelled = await f.call(`/v1/issuances/${ok.issuance.id}/cancellation`, {
      method: "POST",
      key: "wh-cancel-2",
      body: {
        companyId: f.scope.companyId,
        reasonCode: "1",
        reason: "Erro na emissão da nota sintética",
      },
    });
    const second = routes.cancelIssuance.output.parse(await cancelled.json()).data;
    expect(second.issuance.cancellation!.sequence).toBe(2);
    await drive(f.t, second.issuance.cancellation!.operationId);

    const events = await outbox(f.t);
    expect(events.map((e) => [e.type, e.body.resource.id])).toEqual([
      ["issuance.authorized", ok.issuance.id],
      ["issuance.rejected", bad.issuance.id],
      ["issuance.cancellation_rejected", ok.issuance.id],
      ["issuance.cancelled", ok.issuance.id],
    ]);
    for (const event of events) {
      expect(event.endpoints).toEqual([own]);
      expect(event.endpoints).not.toContain(foreign);
      expect(event.body).toMatchObject({
        version: "1",
        environment: "sandbox",
        companyId: f.scope.companyId,
        synthetic: false,
        resource: { type: "issuance" },
      });
      // Ids only: no XML, taker, reason or secret in the envelope.
      expect(Object.keys(event.body).sort()).toEqual([
        "companyId",
        "environment",
        "eventId",
        "occurredAt",
        "resource",
        "synthetic",
        "type",
        "version",
      ]);
    }
    // The resource version is the persisted issuance version, monotonic per issuance.
    const versions = events
      .filter((e) => e.body.resource.id === ok.issuance.id)
      .map((e) => e.body.resource.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    const final = routes.getIssuance.output.parse(await (await get(f, ok.issuance.id)).json()).data;
    expect(versions.at(-1)).toBe(final.version);
  });

  it("não entrega a destino cuja concessão não tem o escopo do evento", async () => {
    const f = await fixture();
    const target = await endpoint(f, ["issuance.authorized", "issuance.cancelled"]);
    const grant = await projectGrant(f.t, f.scope.projectId, f.scope.companyId);
    const accepted = await issue(f, "wh-escopo");
    // The grant keeps issuing but loses `webhooks:manage`: the endpoint stops receiving.
    await f.t.run((ctx) =>
      ctx.db.patch("projectCompanies", grant._id, {
        scopes: grant.scopes.filter((s) => s !== "webhooks:manage"),
      }),
    );
    await drive(f.t, accepted.issuance.operationId);
    const events = await outbox(f.t);
    expect(events.map((e) => e.type)).toEqual(["issuance.authorized"]);
    expect(events[0]!.endpoints).not.toContain(target);
  });
});

/** Second project of the same organization, with the same company granted and its own key. */
async function otherProject(f: Fixture) {
  const secret = syntheticApiKey("c");
  const grant = await projectGrant(f.t, f.scope.projectId, f.scope.companyId);
  const projectId = await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...project } = (await ctx.db.get("projects", f.scope.projectId))!;
    const id = await ctx.db.insert("projects", { ...project, externalReference: "outro" });
    const { _id: _g, _creationTime: _gt, ...rest } = grant;
    await ctx.db.insert("projectCompanies", { ...rest, projectId: id });
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    const { _id: _k, _creationTime: _kt, ...keyRest } = key;
    await ctx.db.insert("apiKeys", {
      ...keyRest,
      projectId: id,
      keyHash: await hashApiKey(secret),
    });
    return id;
  });
  return { projectId, secret };
}

/** Second company of the organization, granted to the project, and a key holding only it. */
async function otherCompany(f: Fixture) {
  const grant = await projectGrant(f.t, f.scope.projectId, f.scope.companyId);
  const companyId = await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...company } = (await ctx.db.get("companies", f.scope.companyId))!;
    const id = await ctx.db.insert("companies", { ...company, cnpj: "11444777000161" });
    const { _id: _g, _creationTime: _gt, ...rest } = grant;
    await ctx.db.insert("projectCompanies", { ...rest, companyId: id });
    return id;
  });
  const secret = await extraKey(f, { companyIds: [companyId], grantEpochs: [0] });
  return { companyId, secret };
}

const cancelBody = (companyId: string) => ({
  companyId,
  reasonCode: "2",
  reason: "Serviço não prestado ao tomador sintético",
});

describe("gate de produção e acesso", () => {
  /** Issues and cancels in `production` with each key; the answers must not depend on the gate. */
  async function productionAnswers(f: Fixture, keys: Record<string, string>, round: string) {
    const answers: Record<string, string[]> = {};
    for (const [name, bearer] of Object.entries(keys)) {
      const issued = await f.call(
        "/v1/issuances",
        { method: "POST", key: `${round}-${name}`, body: body(f), environment: "production" },
        bearer,
      );
      const cancelled = await f.call(
        "/v1/issuances/inexistente/cancellation",
        {
          method: "POST",
          key: `${round}-${name}-c`,
          body: cancelBody(f.scope.companyId),
          environment: "production",
        },
        bearer,
      );
      answers[name] = [await errorCode(issued), await errorCode(cancelled)];
    }
    return answers;
  }
  /**
   * The gate state the answers depend on, written as a restore could leave it: the switch itself
   * refuses to open while the vault policy of the deployment is pending, and is proven in
   * `platform.issuanceGate.test.ts`.
   */
  const setGate = async (f: Fixture, production: boolean) => {
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("issuanceGates")
        .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
        .unique();
      const fields = {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        production,
        actor: "operador-freecorps",
        reason: "Linha sintética de gate",
        version: (row?.version ?? 0) + 1,
        updatedAt: Date.now(),
      };
      if (row) await ctx.db.replace("issuanceGates", row._id, fields);
      else await ctx.db.insert("issuanceGates", fields);
    });
  };

  it("chave sem escopo ou sem a empresa recebe a mesma resposta com o gate aberto ou fechado", async () => {
    const f = await fixture();
    const grant = await projectGrant(f.t, f.scope.projectId, f.scope.companyId);
    await f.t.run((ctx) =>
      ctx.db.patch("projectCompanies", grant._id, { environments: ["sandbox", "production"] }),
    );
    const keys = {
      allowed: await extraKey(f, { environment: "production" }),
      noScope: await extraKey(f, { environment: "production", scopes: ["documents:import"] }),
      noCompany: await extraKey(f, { environment: "production", companyIds: [], grantEpochs: [] }),
    };
    // This sandbox deployment refuses `production` by access, for every key, before the gate.
    const sandboxClosed = await productionAnswers(f, keys, "sandbox-fechado");
    await setGate(f, true);
    const sandboxOpen = await productionAnswers(f, keys, "sandbox-aberto");
    expect(sandboxClosed).toEqual({
      allowed: ["404:NOT_FOUND", "404:NOT_FOUND"],
      noScope: ["404:NOT_FOUND", "404:NOT_FOUND"],
      noCompany: ["404:NOT_FOUND", "404:NOT_FOUND"],
    });
    expect(sandboxOpen).toEqual(sandboxClosed);

    // The fiscal production deployment: the key with access meets the gate, the others do not.
    productionDeployment(f.scope.companyId);
    await setGate(f, false);
    const closed = await productionAnswers(f, keys, "producao-fechado");
    await setGate(f, true);
    const open = await productionAnswers(f, keys, "producao-aberto");
    // Cancelling needs the list, not the gate: past it, there is no such issuance.
    expect(closed).toEqual({
      allowed: ["403:ISSUANCE_PRODUCTION_DISABLED", "404:NOT_FOUND"],
      noScope: ["403:SCOPE_DENIED", "403:SCOPE_DENIED"],
      noCompany: ["404:NOT_FOUND", "404:NOT_FOUND"],
    });
    // Past the open gate the key with access goes on: no A1 in the vault, no such issuance.
    expect(open).toEqual({
      allowed: ["409:CERTIFICATE_UNAVAILABLE", "404:NOT_FOUND"],
      noScope: closed.noScope,
      noCompany: closed.noCompany,
    });
    expect(await f.t.run((ctx) => ctx.db.query("issuances").collect())).toEqual([]);
  });

  it("em produção, a API aceita para a Sefin e recusa empresa fora da lista, Campinas e marcador antes do número", async () => {
    const f = await fixture();
    const grant = await projectGrant(f.t, f.scope.projectId, f.scope.companyId);
    await f.t.run((ctx) =>
      ctx.db.patch("projectCompanies", grant._id, { environments: ["sandbox", "production"] }),
    );
    const key = await extraKey(f, { environment: "production" });
    // An active synthetic A1 of the company, sealed in the vault envelope like an upload.
    const keyring = { active: "k1", keys: { k1: "ab".repeat(32) } };
    vi.stubEnv("FNFE_PLATFORM_CERT_KEYS", JSON.stringify(keyring));
    const material = syntheticCertificate({ cnpj: "11222333000181" });
    await f.t.run(async (ctx) => {
      const membership = (await ctx.db.query("memberships").first())!;
      const now = Date.now();
      const id = await ctx.db.insert("certificates", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        version: 1,
        state: "active",
        uploaderId: "synthetic",
        membershipId: membership._id,
        membershipVersion: 1,
        metadata: {
          fingerprint: "c".repeat(64),
          subject: "Synthetic certificate, no fiscal validity",
          cnpj: "11222333000181",
          notBefore: now - 86400_000,
          notAfter: now + 86400_000,
        },
        envelopeRevision: 1,
        createdAt: now,
        updatedAt: now,
      });
      const envelope = encryptCertificate(
        keyring,
        { organizationId: f.scope.organizationId, companyId: f.scope.companyId, id, version: 1 },
        material.pfx,
        material.password,
      );
      await ctx.db.patch("certificates", id, { envelope });
      await ctx.db.insert("certificateHeads", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        nextVersion: 2,
        latestId: id,
        activeId: id,
      });
    });
    productionDeployment(f.scope.companyId);
    await setGate(f, true);
    const post = (idempotency: string, overrides: Record<string, unknown> = {}) =>
      f.call(
        "/v1/issuances",
        { method: "POST", key: idempotency, body: body(f, overrides), environment: "production" },
        key,
      );
    expect(
      await errorCode(await post("marcador", { description: "Licença [simular:timeout]" })),
    ).toBe("400:ISSUANCE_FIELD_INVALID");
    // Campinas: a profile in the municipality, for a company that is not in the Simples.
    await f.t.run(async (ctx) => {
      const profile = (await ctx.db.query("nfseProfiles").first())!;
      await ctx.db.patch("nfseProfiles", profile._id, {
        municipalityCode: "3509502",
        campinasDpsSeries: "10001",
        activities: profile.activities.map((activity) => ({
          ...activity,
          cTribMun: "001",
          ibsCbs: { cIndOp: "100501", cst: "000", cClassTrib: "000001" },
        })),
      });
    });
    const campinasTaker = {
      kind: "national",
      document: "11.444.777/0001-61",
      name: "Tomador Sintético Ltda",
      address: {
        municipalityCode: "3509502",
        postalCode: "13100-030",
        street: "Praça da Sé",
        number: "100",
        district: "Sé",
      },
    };
    expect(await errorCode(await post("campinas", { taker: campinasTaker, issRate: "2" }))).toBe(
      "409:NFSE_ROUTE_UNSUPPORTED",
    );
    await f.t.run(async (ctx) => {
      const profile = (await ctx.db.query("nfseProfiles").first())!;
      await ctx.db.patch("nfseProfiles", profile._id, { municipalityCode: "3550308" });
    });
    vi.stubEnv("FNFE_NFSE_PRODUCTION_COMPANIES", "");
    expect(await errorCode(await post("fora-da-lista"))).toBe("403:ISSUANCE_PRODUCTION_DISABLED");
    expect(await f.t.run((ctx) => ctx.db.query("dpsSequences").collect())).toEqual([]);
    // Listed, with the gate on: accepted for the Sefin Nacional of production.
    vi.stubEnv("FNFE_NFSE_PRODUCTION_COMPANIES", f.scope.companyId);
    const accepted = await post("aceito");
    expect(accepted.status).toBe(202);
    expect(routes.createIssuance.output.parse(await accepted.json()).data.issuance).toMatchObject({
      transport: "producao",
      target: "sefin-nacional",
      state: "processing",
    });
  });

  it("recusa chave expirada ao emitir, ler e listar", async () => {
    const f = await fixture();
    const accepted = await issue(f, "expira");
    const expired = await extraKey(f, { expiresAt: Date.now() - 1 });
    const post = await f.call(
      "/v1/issuances",
      { method: "POST", key: "expirada", body: body(f) },
      expired,
    );
    expect(await errorCode(post)).toBe("401:INVALID_API_KEY");
    expect(await errorCode(await get(f, accepted.issuance.id, expired))).toBe(
      "401:INVALID_API_KEY",
    );
    const list = await f.call(`/v1/issuances?companyId=${f.scope.companyId}`, {}, expired);
    expect(await errorCode(list)).toBe("401:INVALID_API_KEY");
    // A key still within its validity reads and lists.
    const valid = await extraKey(f, { expiresAt: Date.now() + 3600_000 });
    expect((await get(f, accepted.issuance.id, valid)).status).toBe(200);
    const listed = await f.call(`/v1/issuances?companyId=${f.scope.companyId}`, {}, valid);
    expect(routes.listIssuances.output.parse(await listed.json()).data.page).toHaveLength(1);
  });

  it("nega cancelar por outro projeto, por chave revogada e com concessão sem documents:cancel", async () => {
    const f = await fixture();
    const accepted = await issue(f, "cancel-acesso");
    await drive(f.t, accepted.issuance.operationId);
    const cancel = (key: string, bearer: string) =>
      f.call(
        `/v1/issuances/${accepted.issuance.id}/cancellation`,
        { method: "POST", key, body: cancelBody(f.scope.companyId) },
        bearer,
      );
    const project = await otherProject(f);
    expect(await errorCode(await cancel("outro-projeto", project.secret))).toBe("404:NOT_FOUND");
    const revoked = await extraKey(f, { revokedAt: Date.now() - 1 });
    expect(await errorCode(await cancel("revogada", revoked))).toBe("401:INVALID_API_KEY");
    const grant = await projectGrant(f.t, f.scope.projectId, f.scope.companyId);
    await f.t.run((ctx) =>
      ctx.db.patch("projectCompanies", grant._id, {
        scopes: grant.scopes.filter((s) => s !== "documents:cancel"),
      }),
    );
    // The key holds `documents:cancel`; the grant no longer does.
    expect(await errorCode(await cancel("concessao-sem-cancel", f.secret))).toBe("404:NOT_FOUND");
    expect(await f.t.run((ctx) => ctx.db.query("issuanceCancellations").collect())).toEqual([]);
    await f.t.run((ctx) => ctx.db.patch("projectCompanies", grant._id, { scopes: grant.scopes }));
    const allowed = await cancel("permitido", f.secret);
    expect(allowed.status).toBe(202);
    const pending = routes.cancelIssuance.output.parse(await allowed.json()).data;
    expect(pending.issuance.cancellation).toMatchObject({ state: "processing", sequence: 1 });
  });

  it("nega o download sem escopo, sem concessão e por outra empresa", async () => {
    const f = await fixture();
    const accepted = await issue(f, "download");
    await drive(f.t, accepted.issuance.operationId);
    const view = routes.getIssuance.output.parse(
      await (await get(f, accepted.issuance.id)).json(),
    ).data;
    const artifact = view.artifacts.find((a) => a.kind === "nfse")!;
    const download = (bearer: string, companyId: string = f.scope.companyId) =>
      f.call(
        `/v1/issuances/${view.id}/artifacts/${artifact.id}?companyId=${companyId}`,
        {},
        bearer,
      );
    expect((await download(f.secret)).status).toBe(200);
    const noScope = await extraKey(f, { scopes: ["documents:import", "documents:read"] });
    expect(await errorCode(await download(noScope))).toBe("403:SCOPE_DENIED");
    // A key of another company of the organization, with its own company or with this one.
    const company = await otherCompany(f);
    expect(await errorCode(await download(company.secret, company.companyId))).toBe(
      "404:NOT_FOUND",
    );
    expect(await errorCode(await download(company.secret))).toBe("404:NOT_FOUND");
    const grant = await projectGrant(f.t, f.scope.projectId, f.scope.companyId);
    await f.t.run((ctx) =>
      ctx.db.patch("projectCompanies", grant._id, { scopes: ["documents:import"] }),
    );
    expect(await errorCode(await download(f.secret))).toBe("404:NOT_FOUND");
  });

  it("a mesma Idempotency-Key não devolve a emissão a quem não tem a empresa nem a outro projeto", async () => {
    const f = await fixture();
    const original = await issue(f, "idem-compartilhada");
    // Another key of the project, holding only another company of the organization.
    const company = await otherCompany(f);
    const sameCompany = await f.call(
      "/v1/issuances",
      { method: "POST", key: "idem-compartilhada", body: body(f) },
      company.secret,
    );
    expect(await errorCode(sameCompany)).toBe("404:NOT_FOUND");
    const ownCompany = await f.call(
      "/v1/issuances",
      {
        method: "POST",
        key: "idem-compartilhada",
        body: body(f, { companyId: company.companyId }),
      },
      company.secret,
    );
    expect(ownCompany.status).toBe(404);
    const denied = await ownCompany.text();
    expect(errorResponse.parse(JSON.parse(denied)).error.code).toBe("NOT_FOUND");
    expect(denied).not.toContain(original.issuance.id);
    expect(denied).not.toContain(original.issuance.operationId);
    // The key namespace belongs to the project: another project gets its own issuance.
    const project = await otherProject(f);
    const elsewhere = await f.call(
      "/v1/issuances",
      { method: "POST", key: "idem-compartilhada", body: body(f) },
      project.secret,
    );
    expect(elsewhere.status).toBe(202);
    const own = routes.createIssuance.output.parse(await elsewhere.json()).data;
    expect(own.reused).toBe(false);
    expect(own.issuance.id).not.toBe(original.issuance.id);
    // The original key still replays its own issuance.
    const replay = await issue(f, "idem-compartilhada");
    expect(replay).toMatchObject({ reused: true, issuance: { id: original.issuance.id } });
  });
});

describe("operações de emissão com escopo legado", () => {
  /** An issuance operation as the console recorded it before #206: `documents:import`. */
  async function legacy(f: Fixture, key: string) {
    const accepted = await issue(f, key);
    const operationId = accepted.issuance.operationId as Id<"operations">;
    await f.t.run(async (ctx) => {
      const op = (await ctx.db.get("operations", operationId))!;
      await ctx.db.patch("operations", operationId, {
        task: { ...op.task, scope: "documents:import" },
      });
    });
    return { operationId, issuanceId: accepted.issuance.id };
  }
  const generationOf = async (f: Fixture, id: Id<"operations">) =>
    (await f.t.run((ctx) => ctx.db.get("operations", id)))!.generation;
  const control = (
    f: Fixture,
    id: string,
    action: "pause" | "retry",
    generation: number,
    bearer: string,
  ) =>
    f.call(
      `/v1/operations/${id}/${action}`,
      { method: "POST", body: { expectedGeneration: generation } },
      bearer,
    );

  it("exige documents:issue em GET, pause e retry de /v1/operations, ignorando o escopo gravado", async () => {
    const f = await fixture();
    const { operationId } = await legacy(f, "legada");
    const importOnly = await extraKey(f, { scopes: ["documents:import"] });
    const generation = await generationOf(f, operationId);
    expect(await errorCode(await f.call(`/v1/operations/${operationId}`, {}, importOnly))).toBe(
      "403:SCOPE_DENIED",
    );
    expect(await errorCode(await control(f, operationId, "pause", generation, importOnly))).toBe(
      "403:SCOPE_DENIED",
    );
    expect(await errorCode(await control(f, operationId, "retry", generation, importOnly))).toBe(
      "403:SCOPE_DENIED",
    );
    expect(await generationOf(f, operationId)).toBe(generation);
    // A key with `documents:issue` (and the grant) follows and controls the same operation.
    const issuer = await extraKey(f, { scopes: ["documents:issue"] });
    expect((await f.call(`/v1/operations/${operationId}`, {}, issuer)).status).toBe(200);
    const paused = await control(f, operationId, "pause", generation, issuer);
    expect(paused.status).toBe(200);
    const stopped = routes.pauseOperation.output.parse(await paused.json()).data;
    expect(stopped.state).toBe("paused");
    const retried = await control(f, operationId, "retry", stopped.generation, issuer);
    expect(retried.status).toBe(200);
    expect(routes.retryOperation.output.parse(await retried.json()).data.state).not.toBe("paused");
    // A grant of `documents:import` only does not reach the issuance operation either.
    const grant = await projectGrant(f.t, f.scope.projectId, f.scope.companyId);
    await f.t.run((ctx) =>
      ctx.db.patch("projectCompanies", grant._id, { scopes: ["documents:import"] }),
    );
    expect(await errorCode(await f.call(`/v1/operations/${operationId}`, {}, importOnly))).toBe(
      "404:NOT_FOUND",
    );
  });

  it("o executor revalida a operação legada pelo escopo da emissão e a retoma após a concessão", async () => {
    const f = await fixture();
    const { operationId, issuanceId } = await legacy(f, "legada-executor");
    const grant = await projectGrant(f.t, f.scope.projectId, f.scope.companyId);
    await f.t.run((ctx) =>
      ctx.db.patch("projectCompanies", grant._id, {
        scopes: grant.scopes.filter((s) => !(ISSUANCE_SCOPES as readonly string[]).includes(s)),
      }),
    );
    // A grant of `documents:import` only stops the legacy operation before any transmission.
    const stopped = await drive(f.t, operationId);
    expect(stopped).toMatchObject({ state: "paused", code: "ACCESS_REVOKED", attempts: 0 });
    // Granting `documents:issue` keeps the grant epoch, so a retry resumes the same operation.
    await f.t.run((ctx) => ctx.db.patch("projectCompanies", grant._id, { scopes: grant.scopes }));
    const retried = await control(f, operationId, "retry", stopped.generation, f.secret);
    expect(retried.status).toBe(200);
    expect((await drive(f.t, operationId)).state).toBe("succeeded");
    const done = routes.getIssuance.output.parse(await (await get(f, issuanceId)).json()).data;
    expect(done.state).toBe("authorized");
  });
});

describe("corpo das respostas REST", () => {
  /**
   * A borda REST lia o corpo por `clone()`. No undici do Node 23, coletar o clone cancela o
   * stream da original, e quem a lia depois recebia "Body has already been read": a falha
   * intermitente da suíte completa. Forçar a coleta torna o caso determinístico.
   */
  it("continua legível depois de uma coleta de lixo entre a resposta e a leitura", async () => {
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;
    const f = await fixture();
    const created = await f.call("/v1/issuances", {
      method: "POST",
      key: "corpo-depois-da-coleta",
      body: body(f),
    });
    const denied = await f.call("/v1/issuances", {
      method: "POST",
      key: "corpo-depois-da-coleta-2",
      body: body(f),
      environment: "production",
    });
    for (let i = 0; i < 3; i++) {
      collect();
      // Os finalizadores rodam numa volta real do event loop, fora dos fake timers.
      await new Promise((resolve) => realSetImmediate(resolve));
    }
    expect(created.status).toBe(202);
    expect(routes.createIssuance.output.parse(await created.json()).data.reused).toBe(false);
    expect(await errorCode(denied)).toBe("403:ENVIRONMENT_DENIED");
  });
});
