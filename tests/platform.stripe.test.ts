/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { api, components, internal } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import { register } from "../platform/test-setup";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import { encryptCertificate } from "../platform/convex/lib/certificateCrypto";
import { syntheticCertificate } from "./helpers/certificates";
import {
  minorToDecimal,
  planIssuance,
  readCharge,
  readEnvelope,
  verifyStripeSignature,
  type StripeEnvelope,
} from "../platform/convex/lib/stripeEvent";
import { splitStreet } from "../platform/convex/lib/stripeAddress";
import { normalizeIssuanceInput } from "../platform/convex/lib/issuanceCore";
import { canonicalEntries, sha256 } from "../lib/reference-dataset";
import type { StripeCharge, StripeConnectionConfig } from "../platform/convex/lib/stripeValues";

/**
 * Stripe connection (ADR 0006). Every customer, id and secret is synthetic; the issuances run on
 * the simulated transport, so nothing here reaches a tax authority or Stripe.
 */
/**
 * The versioned plan names no fiscal production deployment today; here it names a synthetic one,
 * reached only by the test that switches the backend to its profile.
 */
vi.mock("../deploy/issuance-production.json", () => ({
  default: {
    version: 1,
    deployment: "brave-otter-123",
    url: "https://brave-otter-123.convex.cloud",
  },
}));

const modules = import.meta.glob("../platform/convex/**/*.ts");
const NOW = Date.UTC(2026, 9, 8, 15); // 08/10/2026 12:00 in Brasília
const SECRET = `whsec_${"a1".repeat(16)}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5199",
    CONVEX_SITE_URL: "http://127.0.0.1:3257",
    BETTER_AUTH_SECRET: "synthetic-stripe",
    FNFE_WEBHOOK_MASTER_KEY: "ab".repeat(32),
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const config = (overrides: Partial<StripeConnectionConfig> = {}): StripeConnectionConfig => ({
  market: "both",
  domesticActivityCode: "licenca",
  exportActivityCode: "licenca",
  description: "{itens} — cobrança {cobranca}, competência {periodo}",
  issRate: "2.5",
  invoices: true,
  checkouts: true,
  foreignWithoutNif: "not_required",
  refundPolicy: "notify",
  ...overrides,
});

const address = {
  line1: "548 Market St",
  line2: "Suite 100",
  city: "Toronto",
  state: "ON",
  postal_code: "M5V 2T6",
  country: "CA",
};
function invoicePaid(overrides: Record<string, unknown> = {}, id = "evt_invoice_1") {
  return {
    id,
    type: "invoice.paid",
    livemode: false,
    created: Math.floor(NOW / 1000),
    data: {
      object: {
        id: "in_1",
        object: "invoice",
        number: "GROC-0001",
        amount_paid: 30000,
        currency: "cad",
        customer_name: "Example Grocery Inc.",
        customer_email: "billing@grocery.example",
        customer_address: address,
        customer_tax_ids: [{ type: "ca_bn", value: "123456789" }],
        status_transitions: { paid_at: Math.floor(NOW / 1000) },
        lines: { data: [{ description: "Loja Exemplo Business (monthly)" }] },
        payment_intent: "pi_1",
        ...overrides,
      },
    },
  };
}
function checkout(
  overrides: Record<string, unknown> = {},
  id = "evt_checkout_1",
  type = "checkout.session.completed",
) {
  return {
    id,
    type,
    livemode: false,
    created: Math.floor(NOW / 1000),
    data: {
      object: {
        id: "cs_1",
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        amount_total: 5000,
        currency: "usd",
        payment_intent: "pi_2",
        customer_details: {
          name: "Example Grocery Inc.",
          email: "billing@grocery.example",
          address,
          tax_ids: [],
        },
        ...overrides,
      },
    },
  };
}
const refund = (total = true, id = "evt_refund_1") => ({
  id,
  type: "charge.refunded",
  livemode: false,
  created: Math.floor(NOW / 1000),
  data: {
    object: {
      id: "ch_1",
      object: "charge",
      amount: 30000,
      amount_refunded: total ? 30000 : 1000,
      refunded: total,
      payment_intent: "pi_1",
    },
  },
});

function sign(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
  return `t=${at},v1=${v1}`;
}
const envelope = (event: object) => readEnvelope(JSON.stringify(event)) as StripeEnvelope;

describe("leitura do evento do Stripe", () => {
  it("confere a assinatura, inclusive com mais de um v1, e recusa a vencida", async () => {
    const body = JSON.stringify(invoicePaid());
    const now = Math.floor(NOW / 1000);
    expect(await verifyStripeSignature(body, sign(body), SECRET, now)).toBe("ok");
    const other = createHmac("sha256", "whsec_outro").update(`${now}.${body}`).digest("hex");
    expect(await verifyStripeSignature(body, `${sign(body)},v1=${other}`, SECRET, now)).toBe("ok");
    expect(await verifyStripeSignature(`${body} `, sign(body), SECRET, now)).toBe(
      "SIGNATURE_INVALID",
    );
    expect(await verifyStripeSignature(body, sign(body, "whsec_outro"), SECRET, now)).toBe(
      "SIGNATURE_INVALID",
    );
    expect(await verifyStripeSignature(body, sign(body, SECRET, now - 301), SECRET, now)).toBe(
      "SIGNATURE_EXPIRED",
    );
    expect(await verifyStripeSignature(body, null, SECRET, now)).toBe("SIGNATURE_MISSING");
    expect(await verifyStripeSignature(body, "t=1", SECRET, now)).toBe("SIGNATURE_MISSING");
  });

  it("lê fatura paga nas duas formas de API e converte centavos sem ponto flutuante", () => {
    const old = readCharge(envelope(invoicePaid()));
    expect(old).toMatchObject({
      kind: "charge",
      charge: {
        kind: "invoice",
        id: "in_1",
        amount: "300.00",
        currency: "CAD",
        paymentIntentId: "pi_1",
      },
    });
    const basil = readCharge(
      envelope(
        invoicePaid({
          payment_intent: undefined,
          payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_9" } }] },
        }),
      ),
    );
    expect(basil).toMatchObject({ charge: { paymentIntentId: "pi_9" } });
    expect([1, 99, 100, 123456].map(minorToDecimal)).toEqual(["0.01", "0.99", "1.00", "1234.56"]);
  });

  it("ignora o que não é cobrança paga", () => {
    expect(readCharge(envelope(invoicePaid({ amount_paid: 0 })))).toEqual({
      kind: "ignored",
      code: "ZERO_AMOUNT",
    });
    expect(readCharge(envelope(checkout({ mode: "subscription" })))).toMatchObject({
      code: "CHECKOUT_NOT_PAYMENT",
    });
    expect(readCharge(envelope(checkout({ payment_status: "unpaid" })))).toMatchObject({
      code: "NOT_PAID",
    });
    expect(readEnvelope(JSON.stringify({ ...invoicePaid(), type: "customer.created" }))).toBeNull();
    expect(readEnvelope("{")).toBe("INVALID");
    expect(readCharge(envelope(refund(false)))).toMatchObject({ reversal: { total: false } });
  });

  it("separa rua e número da linha única do Stripe", () => {
    expect(splitStreet("548 Market St", "S/N")).toEqual({ street: "Market St", number: "548" });
    expect(splitStreet("Rua das Flores, 120", "S/N")).toEqual({
      street: "Rua das Flores",
      number: "120",
    });
    expect(splitStreet("Rua das Flores, 120 apto 3", "S/N")).toEqual({
      street: "Rua das Flores apto 3",
      number: "120",
    });
    expect(splitStreet("Avenida Paulista", "S/N")).toEqual({
      street: "Avenida Paulista",
      number: "S/N",
    });
  });

  it("monta o pedido pelo mercado e diz o que falta", () => {
    const charge = (readCharge(envelope(invoicePaid())) as { charge: StripeCharge }).charge;
    const ready = planIssuance({ config: config(), charge });
    expect(ready).toMatchObject({
      kind: "ready",
      input: {
        market: "export",
        competence: "2026-10",
        amount: { currency: "CAD", value: "300.00" },
        description: "Loja Exemplo Business (monthly) — cobrança GROC-0001, competência 10/2026",
        taker: {
          kind: "foreign",
          nif: "123456789",
          address: { country: "CA", street: "Market St", number: "548", district: "Suite 100" },
        },
      },
    });
    expect(ready.kind === "ready" && "issRate" in ready.input).toBe(false);
    expect(planIssuance({ config: config({ market: "domestic" }), charge })).toEqual({
      kind: "ignored",
      code: "OUT_OF_MARKET",
    });
    const noNif = { ...charge, customer: { ...charge.customer, taxIds: [] } };
    expect(planIssuance({ config: config({ foreignWithoutNif: "hold" }), charge: noNif })).toEqual({
      kind: "pending",
      market: "export",
      missing: ["nif"],
    });
    expect(planIssuance({ config: config(), charge: noNif })).toMatchObject({
      input: { taker: { nifAbsence: 2 } },
    });
    const brazilian = {
      ...charge,
      currency: "BRL",
      customer: { ...charge.customer, country: "BR", taxIds: [] },
    };
    expect(planIssuance({ config: config(), charge: brazilian })).toEqual({
      kind: "pending",
      market: "domestic",
      missing: ["document", "municipality"],
    });
    expect(planIssuance({ config: config(), charge: { ...charge, currency: "JPY" } })).toEqual({
      kind: "failed",
      code: "STRIPE_CURRENCY_UNSUPPORTED",
    });
  });

  it("normaliza o CPF ou CNPJ do Stripe como o console, e o inválido segue recusado", () => {
    const base = (readCharge(envelope(invoicePaid())) as { charge: StripeCharge }).charge;
    const plan = (type: string, value: string) =>
      planIssuance({
        config: config(),
        municipalityCode: "3550308",
        charge: {
          ...base,
          currency: "BRL",
          customer: {
            ...base.customer,
            country: "BR",
            postalCode: "01310-100",
            taxIds: [{ type, value }],
          },
        },
      });
    const document = (type: string, value: string) => {
      const ready = plan(type, value);
      if (ready.kind !== "ready") throw new Error(ready.kind);
      return ready.input.taker.kind === "national" ? ready.input.taker.document : null;
    };
    expect(document("br_cnpj", "12.abc.345/01de-35")).toBe("12ABC34501DE35");
    expect(document("br_cnpj", "12abc34501de35")).toBe("12ABC34501DE35");
    expect(document("br_cnpj", "11.222.333/0001-81")).toBe("11222333000181");
    expect(document("br_cpf", "529.982.247-25")).toBe("52998224725");
    for (const value of ["12.abc.345/01de-35", "11.222.333/0001-81", "529.982.247-25"]) {
      const ready = plan(value.length > 14 ? "br_cnpj" : "br_cpf", value);
      if (ready.kind !== "ready") throw new Error(ready.kind);
      expect(() => normalizeIssuanceInput(ready.input)).not.toThrow();
    }
    const invalid = plan("br_cnpj", "12.abc.345/01de-36");
    if (invalid.kind !== "ready") throw new Error(invalid.kind);
    expect(() => normalizeIssuanceInput(invalid.input)).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "ISSUANCE_TAKER_DOCUMENT_INVALID" }),
      }),
    );
    // The public request stays strict: the canonical form is upper case, as the docs say.
    expect(() =>
      normalizeIssuanceInput({
        ...invalid.input,
        taker: { ...invalid.input.taker, document: "12.abc.345/01de-35" },
      } as typeof invalid.input),
    ).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "ISSUANCE_TAKER_DOCUMENT_INVALID" }),
      }),
    );
  });
});

function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}
type T = ReturnType<typeof setup>;

async function human(
  t: T,
  organizationId: Id<"organizations">,
  role: "owner" | "operator" | "developer",
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
  await t.run((ctx) =>
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
  return t.withIdentity({
    subject: user._id,
    sessionId: session._id,
    issuer: "http://127.0.0.1:3257",
  });
}

/** Organization, integration project with a grant, company with an NFS-e profile, owner. */
async function fixture(options: { cancelScope?: boolean } = {}) {
  const t = setup();
  const keyHash = await hashApiKey(
    `fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "b")}`,
  );
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  await t.run(async (ctx) => {
    await ctx.db.patch("companies", scope.companyId, { cnpj: "11222333000181", kind: "declared" });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: [
        ...grant.scopes,
        "documents:issue",
        ...(options.cancelScope === false ? [] : (["documents:cancel"] as const)),
      ],
    });
    await ctx.db.insert("nfseProfiles", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      municipalityCode: "3550308",
      issuerEmail: "fiscal@prestador.example",
      opSimpNac: 1,
      regEspTrib: 0,
      dpsSeries: "1",
      activities: [
        {
          code: "licenca",
          label: "Licenciamento de software",
          cnae: "6203100",
          lc116Item: "01.05",
          cTribNac: "010501",
          nbs: "111032200",
        },
      ],
      version: 1,
      updatedBy: "synthetic",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  const owner = await human(t, scope.organizationId, "owner");
  const where = {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    companyId: scope.companyId,
    environment: "sandbox" as const,
  };
  return { t, scope, owner, where };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function connect(f: Fixture, overrides: Partial<StripeConnectionConfig> = {}) {
  const connection = await f.owner.mutation(api.stripe.createConnection, {
    ...f.where,
    name: "Loja Exemplo",
    config: config(overrides),
  });
  await f.owner.mutation(api.stripe.setSigningSecret, {
    connectionId: connection.id,
    secret: SECRET,
  });
  return connection.id;
}
async function deliver(
  f: Fixture,
  connectionId: Id<"stripeConnections">,
  event: object,
  signature?: string,
) {
  const body = JSON.stringify(event);
  const response = await f.t.fetch(`/v1/stripe/connections/${connectionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature ?? sign(body) },
    body,
  });
  return { status: response.status, body: (await response.json()) as { code: string } };
}
const events = (f: Fixture) => f.t.run((ctx) => ctx.db.query("stripeEvents").collect());
const issuances = (f: Fixture) => f.t.run((ctx) => ctx.db.query("issuances").collect());
function code(promise: Promise<unknown>) {
  return promise.then(
    () => "OK",
    (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
  );
}
async function drive(t: T, operationId: Id<"operations">, steps = 3) {
  for (let i = 0; i < steps; i++) {
    const op = (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
    if (!["queued", "retry_wait", "reconciling"].includes(op.state)) break;
    vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
    await t.action(internal.operationWorker.run, { operationId, generation: op.generation });
  }
}

describe("conexão Stripe", () => {
  it("só owner ou admin configura, e só com perfil, atividade e concessão de emissão", async () => {
    const f = await fixture();
    const developer = await human(f.t, f.scope.organizationId, "developer");
    expect(
      await code(
        developer.mutation(api.stripe.createConnection, {
          ...f.where,
          name: "x",
          config: config(),
        }),
      ),
    ).not.toBe("OK");
    expect(
      await code(
        f.owner.mutation(api.stripe.createConnection, {
          ...f.where,
          name: "x",
          config: config({ exportActivityCode: "inexistente" }),
        }),
      ),
    ).toBe("STRIPE_EXPORT_ACTIVITY_INVALID");
    expect(
      await code(
        f.owner.mutation(api.stripe.createConnection, {
          ...f.where,
          name: "x",
          config: config({ market: "export", issRate: "2" }),
        }),
      ),
    ).toBe("STRIPE_ISS_RATE_INVALID");
    for (const issRate of ["0", "2.1234", "5.5", "6"])
      expect(
        await code(
          f.owner.mutation(api.stripe.createConnection, {
            ...f.where,
            name: "x",
            config: config({ issRate }),
          }),
        ),
      ).toBe("STRIPE_ISS_RATE_INVALID");
    const id = await connect(f);
    const [listed] = await f.owner.query(api.stripe.listConnections, {
      organizationId: f.where.organizationId,
      projectId: f.where.projectId,
    });
    expect(listed).toMatchObject({ id, secretSet: true, active: true });
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    const stored = await f.t.run((ctx) => ctx.db.get("stripeConnections", id));
    expect(stored!.secret).not.toContain("whsec_");
  });

  it("exige documents:cancel para cancelar sozinha no reembolso", async () => {
    const f = await fixture({ cancelScope: false });
    expect(
      await code(
        f.owner.mutation(api.stripe.createConnection, {
          ...f.where,
          name: "x",
          config: config({ refundPolicy: "cancel" }),
        }),
      ),
    ).toBe("STRIPE_CANCEL_SCOPE_REQUIRED");
  });

  it("recusa assinatura inválida e registra a falha para o guia", async () => {
    const f = await fixture();
    const id = await connect(f);
    const result = await deliver(f, id, invoicePaid(), sign("{}"));
    expect(result).toEqual({ status: 400, body: { code: "SIGNATURE_INVALID" } });
    expect(await events(f)).toHaveLength(0);
    const connection = await f.t.run((ctx) => ctx.db.get("stripeConnections", id));
    expect(connection!.lastFailureCode).toBe("SIGNATURE_INVALID");
    const bare = await f.owner.mutation(api.stripe.createConnection, {
      ...f.where,
      name: "Sem segredo",
      config: config(),
    });
    expect((await deliver(f, bare.id, invoicePaid())).status).toBe(404);
    const noted = await f.t.run((ctx) => ctx.db.get("stripeConnections", bare.id));
    expect(noted!.lastFailureCode).toBe("SECRET_MISSING");
    const unknown = await f.t.fetch("/v1/stripe/connections/abc/events", {
      method: "POST",
      body: "{}",
    });
    expect(unknown.status).toBe(404);
  });

  it("emite a NFS-e de exportação da fatura paga pelo projeto, uma vez só", async () => {
    const f = await fixture();
    const id = await connect(f);
    expect(await deliver(f, id, invoicePaid())).toEqual({
      status: 200,
      body: { code: "RECEIVED" },
    });
    // Stripe resends the same event, and a second event about the same invoice arrives.
    await deliver(f, id, invoicePaid());
    await deliver(f, id, invoicePaid({}, "evt_invoice_again"));
    const rows = await events(f);
    expect(rows.map((e) => [e.stripeEventId, e.state, e.code ?? null])).toEqual([
      ["evt_invoice_1", "issued", null],
      ["evt_invoice_again", "ignored", "DUPLICATE_CHARGE"],
    ]);
    const [issuance] = await issuances(f);
    expect(issuance).toMatchObject({
      projectId: f.where.projectId,
      transport: "simulated",
      number: 1,
    });
    expect(rows[1]!.issuanceId).toBe(issuance!._id);
    const op = await f.t.run((ctx) => ctx.db.get("operations", issuance!.operationId));
    expect(op!.sourceStripeConnectionId).toBe(id);
    await drive(f.t, issuance!.operationId);
    const done = await f.t.run((ctx) => ctx.db.get("issuances", issuance!._id));
    expect(done!.state).toBe("authorized");
    const snapshot = JSON.parse(done!.snapshot) as Record<string, unknown>;
    expect(snapshot).toMatchObject({ market: "export", taker: { nif: "123456789" } });
  });

  it("segura sem gastar número quando falta dado, e libera com o tomador completo", async () => {
    const f = await fixture();
    const id = await connect(f);
    await deliver(
      f,
      id,
      checkout({ customer_details: { name: "Sem Endereço", address: { country: "CA" } } }),
    );
    const [held] = await events(f);
    expect(held).toMatchObject({
      state: "pending_data",
      missing: ["street", "postalCode", "city"],
    });
    expect(await issuances(f)).toHaveLength(0);
    expect(await f.t.run((ctx) => ctx.db.query("dpsSequences").collect())).toHaveLength(0);
    // A bad taker is refused when submitted, with the issuance's own code.
    expect(
      await code(
        f.owner.mutation(api.stripe.completeEvent, {
          eventId: held!._id,
          taker: {
            kind: "foreign",
            nifAbsence: 2,
            name: "Sem Endereço Inc.",
            address: {
              country: "BR",
              city: "x",
              postalCode: "1",
              state: "x",
              street: "x",
              number: "1",
              district: "x",
            },
          },
        }),
      ),
    ).toBe("ISSUANCE_FIELD_INVALID");
    expect((await events(f))[0]!.state).toBe("pending_data");
    const operator = await human(f.t, f.scope.organizationId, "operator");
    // An operator without access to the company cannot release it.
    expect(await code(operator.mutation(api.stripe.retryEvent, { eventId: held!._id }))).toBe(
      "NOT_FOUND",
    );
    await f.owner.mutation(api.stripe.completeEvent, {
      eventId: held!._id,
      taker: {
        kind: "foreign",
        nifAbsence: 2,
        name: "Sem Endereço Inc.",
        address: {
          country: "CA",
          city: "Toronto",
          postalCode: "M5V 2T6",
          state: "ON",
          street: "King St W",
          number: "100",
          district: "N/A",
        },
      },
    });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const [released] = await events(f);
    expect(released!.state).toBe("issued");
    const [issuance] = await issuances(f);
    expect(issuance!.projectId).toBe(f.where.projectId);
  });

  it("emite sozinha para o tomador nacional com CNPJ alfanumérico em minúsculas", async () => {
    const f = await fixture();
    // A one-row municipalities table, so the city and state of the customer resolve to an IBGE code.
    const entries = [
      {
        code: "3550308",
        description: "São Paulo",
        state: "SP",
        validFrom: "2025-01-01",
        validTo: null,
      },
    ];
    const hash = await sha256(canonicalEntries(entries));
    const storageId = await f.t.run((ctx) =>
      ctx.storage.store(
        new Blob(
          [
            JSON.stringify({
              manifest: {
                dataset: "municipalities",
                version: "synthetic-stripe",
                source: "Corpus sintético Freecorps",
                sourceUrl: "https://example.invalid/references",
                sourceVersion: "synthetic-stripe",
                retrievedAt: "2026-09-22T00:00:00Z",
                asOf: "2026-09-22",
                coverage: "intervals",
                sourceSha256: hash,
                contentSha256: hash,
                count: entries.length,
                termsUrl: "https://example.invalid/synthetic-terms",
                redistribution: "synthetic",
                terms: "Dados inventados para testes, sem correspondência fiscal.",
              },
              entries,
            }),
          ],
          { type: "application/json" },
        ),
      ),
    );
    const versionId = await f.t.action(internal.referenceLoad.stage, { storageId });
    await f.t.mutation(internal.referenceImport.publish, {
      versionId,
      expectedGeneration: 0,
      reason: "Prova sintética",
    });
    const id = await connect(f);
    const brazilian = (document: string, eventId: string, invoiceId: string) =>
      invoicePaid(
        {
          id: invoiceId,
          payment_intent: `pi_${invoiceId}`,
          currency: "brl",
          customer_name: "Cliente Sintético Ltda",
          customer_address: {
            line1: "Avenida Paulista, 1000",
            line2: "Bela Vista",
            city: "São Paulo",
            state: "SP",
            postal_code: "01310-100",
            country: "BR",
          },
          customer_tax_ids: [{ type: "br_cnpj", value: document }],
        },
        eventId,
      );
    await deliver(f, id, brazilian("12.abc.345/01de-35", "evt_br_lower", "in_br_1"));
    await deliver(f, id, brazilian("12.abc.345/01de-36", "evt_br_bad", "in_br_2"));
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await events(f);
    expect(rows.map((e) => [e.stripeEventId, e.state, e.code ?? null])).toEqual([
      ["evt_br_lower", "issued", null],
      ["evt_br_bad", "failed", "ISSUANCE_TAKER_DOCUMENT_INVALID"],
    ]);
    const [issuance] = await issuances(f);
    expect(JSON.parse(issuance!.snapshot)).toMatchObject({
      market: "domestic",
      taker: { documentType: "CNPJ", document: "12ABC34501DE35" },
    });
  });

  it("checkout em modo assinatura não gera nota (a fatura paga gera)", async () => {
    const f = await fixture();
    const id = await connect(f);
    await deliver(f, id, checkout({ mode: "subscription" }));
    expect((await events(f)).map((e) => e.code)).toEqual(["CHECKOUT_NOT_PAYMENT"]);
    expect(await issuances(f)).toHaveLength(0);
  });

  it("reembolso total só sugere o cancelamento por padrão", async () => {
    const f = await fixture();
    const id = await connect(f);
    await deliver(f, id, invoicePaid());
    await deliver(f, id, refund(false, "evt_partial"));
    await deliver(f, id, refund(true));
    const rows = await events(f);
    expect(
      rows.map((e) => [e.stripeEventId, e.state, e.code ?? null, e.refundAction ?? null]),
    ).toEqual([
      ["evt_invoice_1", "issued", null, "suggested"],
      ["evt_partial", "refund", "PARTIAL_REFUND", null],
      ["evt_refund_1", "refund", "CANCEL_SUGGESTED", null],
    ]);
    expect(await f.t.run((ctx) => ctx.db.query("issuanceCancellations").collect())).toHaveLength(0);
  });

  it("com a opção ligada, cancela sozinha a nota autorizada", async () => {
    const f = await fixture();
    const id = await connect(f, { refundPolicy: "cancel" });
    await deliver(f, id, invoicePaid());
    const [issuance] = await issuances(f);
    await drive(f.t, issuance!.operationId);
    await deliver(f, id, refund(true));
    const [cancellation] = await f.t.run((ctx) => ctx.db.query("issuanceCancellations").collect());
    expect(cancellation).toMatchObject({
      reasonCode: "9",
      reason: "Cobrança reembolsada no Stripe (ch_1).",
    });
    const rows = await events(f);
    expect(rows.find((e) => e.stripeEventId === "evt_refund_1")!.code).toBe("CANCEL_REQUESTED");
    expect(rows.find((e) => e.stripeEventId === "evt_invoice_1")!.refundAction).toBe("requested");
    const op = await f.t.run((ctx) => ctx.db.get("operations", cancellation!.operationId));
    expect(op!.sourceStripeConnectionId).toBe(id);
  });

  it("para de emitir quando a concessão é revogada, e conceder de novo não reativa", async () => {
    const f = await fixture();
    const id = await connect(f);
    await f.t.run(async (ctx) => {
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.where.projectId).eq("companyId", f.where.companyId),
        )
        .unique())!;
      await ctx.db.patch("projectCompanies", grant._id, { accessEpoch: grant.accessEpoch + 1 });
    });
    expect((await deliver(f, id, invoicePaid())).status).toBe(200);
    const [row] = await events(f);
    expect(row).toMatchObject({ state: "failed", code: "NOT_FOUND" });
    expect(await issuances(f)).toHaveLength(0);
  });

  it("em produção fiscal, emite pela Sefin só com a empresa na lista e o gate ligado", async () => {
    const f = await fixture();
    const id = await connect(f);
    const keyring = { active: "k1", keys: { k1: "ab".repeat(32) } };
    vi.stubEnv("FNFE_PLATFORM_CERT_KEYS", JSON.stringify(keyring));
    const material = syntheticCertificate({ cnpj: "11222333000181" });
    await f.t.run(async (ctx) => {
      await ctx.db.patch("stripeConnections", id, { environment: "production" });
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
        )
        .unique())!;
      await ctx.db.patch("projectCompanies", grant._id, {
        environments: ["sandbox", "production"],
      });
      // An active synthetic A1 of the company, sealed in the vault envelope like an upload.
      const membership = (await ctx.db.query("memberships").first())!;
      const now = Date.now();
      const certificateId = await ctx.db.insert("certificates", {
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
        {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          id: certificateId,
          version: 1,
        },
        material.pfx,
        material.password,
      );
      await ctx.db.patch("certificates", certificateId, { envelope });
      await ctx.db.insert("certificateHeads", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        nextVersion: 2,
        latestId: certificateId,
        activeId: certificateId,
      });
    });
    const gate = (production: boolean) =>
      f.t.run(async (ctx) => {
        const row = await ctx.db
          .query("issuanceGates")
          .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
          .unique();
        const fields = {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          production,
          actor: "operator:freecorps",
          reason: "Linha sintética de gate",
          version: (row?.version ?? 0) + 1,
          updatedAt: Date.now(),
        };
        if (row) await ctx.db.replace("issuanceGates", row._id, fields);
        else await ctx.db.insert("issuanceGates", fields);
      });
    // The fiscal production deployment (the plan names a synthetic one in this file).
    const production = (list: string) => {
      for (const [name, value] of Object.entries({
        APP_ENV: "installation",
        PRODUCT_ENV: "production",
        EMAIL_MODE: "disabled",
        WEBHOOK_MODE: "https",
        AUTH_PROXY_MODE: "signed",
        AUTH_PROXY_SECRET: "c".repeat(64),
        SITE_URL: "https://console.producao.invalid",
        CONVEX_SITE_URL: "https://brave-otter-123.convex.site",
        CONVEX_CLOUD_URL: "https://brave-otter-123.convex.cloud",
        API_URL: "https://api.producao.invalid",
        FNFE_ISSUANCE_ENV: "production",
        FNFE_NFSE_PRODUCTION_COMPANIES: list,
      }))
        vi.stubEnv(name, value);
    };
    // One invoice per event, so that none is a duplicate of a refused one.
    const live = (event: string) => ({
      ...invoicePaid({ id: `in_${event}`, payment_intent: `pi_${event}` }, event),
      livemode: true,
    });

    production("");
    await gate(true);
    await deliver(f, id, live("evt_fora_da_lista"));
    production(f.scope.companyId);
    await gate(false);
    await deliver(f, id, live("evt_gate_desligado"));
    expect((await events(f)).map((e) => [e.stripeEventId, e.state, e.code ?? null])).toEqual([
      ["evt_fora_da_lista", "failed", "ISSUANCE_PRODUCTION_DISABLED"],
      ["evt_gate_desligado", "failed", "ISSUANCE_PRODUCTION_DISABLED"],
    ]);
    expect(await issuances(f)).toEqual([]);
    expect(await f.t.run((ctx) => ctx.db.query("dpsSequences").collect())).toEqual([]);

    // Listed and with the gate on: a simulator marker or a Campinas route still never leaves.
    await gate(true);
    const marked = live("evt_marcador");
    marked.data.object.lines = { data: [{ description: "Loja Exemplo [simular:timeout]" }] };
    await deliver(f, id, marked);
    const profile = (await f.t.run((ctx) => ctx.db.query("nfseProfiles").first()))!;
    await f.t.run((ctx) =>
      ctx.db.patch("nfseProfiles", profile._id, {
        municipalityCode: "3509502",
        campinasDpsSeries: "10001",
        activities: profile.activities.map((activity) => ({
          ...activity,
          cTribMun: "001",
          ibsCbs: { cIndOp: "100501", cst: "000", cClassTrib: "000001" },
        })),
      }),
    );
    await deliver(f, id, live("evt_campinas"));
    await f.t.run((ctx) =>
      ctx.db.patch("nfseProfiles", profile._id, { municipalityCode: "3550308" }),
    );
    expect(
      (await events(f)).slice(2).map((e) => [e.stripeEventId, e.state, e.code ?? null]),
    ).toEqual([
      ["evt_marcador", "failed", "ISSUANCE_FIELD_INVALID"],
      ["evt_campinas", "failed", "NFSE_ROUTE_UNSUPPORTED"],
    ]);
    expect(await f.t.run((ctx) => ctx.db.query("dpsSequences").collect())).toEqual([]);

    await deliver(f, id, live("evt_liberado"));
    const [issuance] = await issuances(f);
    expect(issuance).toMatchObject({ transport: "producao", target: "sefin-nacional" });
    const op = await f.t.run((ctx) => ctx.db.get("operations", issuance!.operationId));
    expect(op).toMatchObject({ environment: "production", sourceStripeConnectionId: id });
  });

  it("em produção, só aceita evento livemode", async () => {
    const f = await fixture();
    const id = await connect(f);
    await f.t.run((ctx) => ctx.db.patch("stripeConnections", id, { environment: "production" }));
    await deliver(f, id, invoicePaid());
    expect((await events(f)).map((e) => e.code)).toEqual(["LIVEMODE_MISMATCH"]);
  });
});
