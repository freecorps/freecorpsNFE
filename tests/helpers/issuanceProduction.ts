import { vi } from "vite-plus/test";
import { internal } from "../../platform/convex/_generated/api";
import type { Id } from "../../platform/convex/_generated/dataModel";
import { hashApiKey } from "../../platform/convex/lib/apiKeyCrypto";
import { encryptCertificate } from "../../platform/convex/lib/certificateCrypto";
import * as certificateTransport from "../../platform/convex/lib/certificateTransport";
import type { IssuanceInput } from "../../platform/convex/lib/issuanceValues";
// Same source module the platform resolves under test, so the XSD catalog is registered once.
import { gzipB64 } from "../../packages/fiscal-nfse/src/index";
import { syntheticCertificate } from "./certificates";
import {
  ISSUANCE_SCOPES,
  SYNTHETIC_ISSUER_CNPJ,
  issuerScope,
  nfseProfile,
  platformTest,
  projectGrant,
  softwareLicense,
  syntheticApiKey,
} from "./platform";

/**
 * Fixtures of the NFS-e fiscal production suites in platform/convex/lib (issuanceProduction,
 * issuanceProductionReconciliation and issuanceProductionProbe, `.test.ts`): the named synthetic
 * deployment and its profiles, a company with an active synthetic A1 and a production key, and
 * the Sefin of production replaced. Each test file mocks `deploy/issuance-production.json`
 * itself. Nothing here reaches a tax authority.
 */
export const NAMED = "brave-otter-123";
export const NAMED_URL = `https://${NAMED}.convex.cloud`;

/** The named deployment, marked: the hosted installation profile in fiscal production. */
export const production = {
  APP_ENV: "installation",
  PRODUCT_ENV: "production",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  WEBHOOK_MODE: "https",
  EMAIL_MODE: "disabled",
  AUTH_PROXY_MODE: "signed",
  AUTH_PROXY_SECRET: "c".repeat(64),
  SITE_URL: "https://console.producao.invalid",
  CONVEX_SITE_URL: `https://${NAMED}.convex.site`,
  CONVEX_CLOUD_URL: NAMED_URL,
  API_URL: "https://api.producao.invalid",
  FNFE_ISSUANCE_ENV: "production",
};
/** The #50 capture target: validation profile with production data, transport closed. */
export const target50 = {
  APP_ENV: "validation",
  PRODUCT_ENV: "production",
  FNFE_PROOF_FISCAL_ENV: "production",
  FISCAL_ENV: "disabled",
  EMAIL_MODE: "disabled",
  WEBHOOK_MODE: "disabled",
  SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
  CONVEX_CLOUD_URL: "https://modest-seal-118.convex.cloud",
};
export const stub = (env: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
};
export const MARK_REFUSED = "Invalid platform configuration: FNFE_ISSUANCE_ENV";

export const NOW = Date.UTC(2026, 9, 8, 15); // Thursday, 08/10/2026 12:00 in Brasília
const KEYRING = { active: "k1", keys: { k1: "ab".repeat(32) } };
export const SEFIN = "https://sefin.nfse.gov.br/SefinNacional";
export const KEY = `3550308${"4".repeat(43)}`;
export const nationalTaker = {
  kind: "national" as const,
  document: "11.444.777/0001-61",
  name: "Tomador Sintético Ltda",
  address: {
    municipalityCode: "3550308",
    postalCode: "01001-000",
    street: "Praça da Sé",
    number: "100",
    district: "Sé",
  },
};
const domestic = (overrides: Partial<IssuanceInput> = {}): IssuanceInput => ({
  activityCode: "licenca",
  competence: "2026-10",
  issuerEmail: "fiscal@prestador.example",
  market: "domestic",
  taker: nationalTaker,
  description: "Licença de uso de software, outubro de 2026",
  amount: { currency: "BRL", value: "1000" },
  issRate: "2.5",
  issWithheld: false,
  ...overrides,
});
/** Not a Simples company in Campinas: from 01/10/2026 its channel is `campinas-adn` (C2). */
export const campinasProfile = {
  municipalityCode: "3509502",
  campinasDpsSeries: "10001",
  activities: [
    {
      ...softwareLicense,
      cTribMun: "001",
      ibsCbs: { cIndOp: "100501", cst: "000", cClassTrib: "000001" },
    },
  ],
};
export const json = (status: number, body: unknown) => ({
  status,
  body: Buffer.from(JSON.stringify(body)),
  contentType: "application/json",
});
export const nfseOf = (dps: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}">` +
  `<nNFSe>11</nNFSe>${dps.replace(/^<\?xml[^>]*\?>/, "")}</infNFSe></NFSe>`;

/** Company with profile and active synthetic A1, and a production key granted to it. */
export async function fixture(
  options: { kind?: "declared" | "demonstration"; profile?: Record<string, unknown> } = {},
) {
  const t = platformTest();
  const keyHash = await hashApiKey(syntheticApiKey("d"));
  const scope = await issuerScope(t, {
    keyHash,
    kind: options.kind ?? "declared",
    grantScopes: ISSUANCE_SCOPES,
    keyScopes: ISSUANCE_SCOPES,
  });
  await nfseProfile(t, scope, options.profile ?? {});
  const grant = await projectGrant(t, scope.projectId, scope.companyId);
  vi.stubEnv("FNFE_PLATFORM_CERT_KEYS", JSON.stringify(KEYRING));
  const material = syntheticCertificate({ cnpj: SYNTHETIC_ISSUER_CNPJ });
  await t.run(async (ctx) => {
    await ctx.db.patch("projectCompanies", grant._id, {
      environments: ["sandbox", "production"],
    });
    await ctx.db.patch("apiKeys", scope.keyId, { environment: "production" });
    const membership = (await ctx.db.query("memberships").first())!;
    const now = Date.now();
    const id = await ctx.db.insert("certificates", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      version: 1,
      state: "active",
      uploaderId: "synthetic",
      membershipId: membership._id,
      membershipVersion: 1,
      metadata: {
        fingerprint: "c".repeat(64),
        subject: "Synthetic certificate, no fiscal validity",
        cnpj: SYNTHETIC_ISSUER_CNPJ,
        notBefore: now - 86400_000,
        notAfter: now + 86400_000,
      },
      envelopeRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const envelope = encryptCertificate(
      KEYRING,
      { organizationId: scope.organizationId, companyId: scope.companyId, id, version: 1 },
      material.pfx,
      material.password,
    );
    await ctx.db.patch("certificates", id, { envelope });
    await ctx.db.insert("certificateHeads", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      nextVersion: 2,
      latestId: id,
      activeId: id,
    });
  });
  const where = {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    companyId: scope.companyId,
    environment: "production" as const,
    keyHash,
  };
  const request = (key: string, overrides: Partial<IssuanceInput> = {}) =>
    t.mutation(internal.issuance.request, {
      ...where,
      idempotencyKey: key,
      input: domestic(overrides),
    });
  const cancel = (
    key: string,
    issuanceId: string,
    reason = "Prova sintética do cancelamento em produção",
  ) =>
    t.mutation(internal.issuance.cancel, {
      ...where,
      idempotencyKey: key,
      issuanceId,
      reasonCode: "1",
      reason,
    });
  /** The fiscal production deployment; `list` is the content of FNFE_NFSE_PRODUCTION_COMPANIES. */
  const onProduction = (list: string | null = scope.companyId) =>
    stub({ ...production, FNFE_NFSE_PRODUCTION_COMPANIES: list ?? undefined });
  /** Through the real switch, from the workflow; the list must already have the company. */
  const gate = (on: boolean) =>
    t.mutation(internal.issuance.setProductionGate, {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      kind: on ? "enable" : "emergency_disable",
      operator: "operador-freecorps",
      ...(on ? { approver: "aprovador-freecorps" } : {}),
      runId: "4242",
      runAttempt: 1,
      reason: "Prova sintética da produção fiscal",
    });
  /** A gate row as a restore could leave it, where no switch may run. */
  const gateRow = (on: boolean) =>
    t.run(async (ctx) => {
      const row = await ctx.db
        .query("issuanceGates")
        .withIndex("by_companyId", (q) => q.eq("companyId", scope.companyId))
        .unique();
      const fields = {
        organizationId: scope.organizationId,
        companyId: scope.companyId,
        production: on,
        actor: "operator:freecorps",
        reason: "Linha sintética de gate",
        version: (row?.version ?? 0) + 1,
        updatedAt: Date.now(),
      };
      if (row) await ctx.db.replace("issuanceGates", row._id, fields);
      else await ctx.db.insert("issuanceGates", fields);
    });
  const rows = () =>
    t.run(async (ctx) => ({
      issuances: await ctx.db.query("issuances").collect(),
      numbers: await ctx.db.query("dpsSequences").collect(),
      cancellations: await ctx.db.query("issuanceCancellations").collect(),
      operations: await ctx.db.query("operations").collect(),
      uses: (await ctx.db.query("certificateAudit").collect()).map(
        (row) => `${row.action}:${row.result}`,
      ),
    }));
  const dpsOf = async (issuanceId: string) =>
    t.run(async (ctx) => {
      const row = await ctx.db
        .query("issuanceArtifacts")
        .withIndex("by_issuanceId_and_kind", (q) =>
          q.eq("issuanceId", issuanceId as Id<"issuances">).eq("kind", "dps"),
        )
        .first();
      return row ? (await ctx.storage.get(row.storageId))!.text() : "";
    });
  /** Runs the operation like the worker pool would, one claimed attempt at a time. */
  const drive = async (operationId: string, steps = 1) => {
    const id = operationId as Id<"operations">;
    for (let i = 0; i < steps; i++) {
      const op = (await t.run((ctx) => ctx.db.get("operations", id)))!;
      if (!["queued", "retry_wait", "reconciling"].includes(op.state)) break;
      vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
      await t.action(internal.operationWorker.run, {
        operationId: id,
        generation: op.generation,
      });
    }
    return (await t.run((ctx) => ctx.db.get("operations", id)))!;
  };
  const issuanceRow = (issuanceId: string) =>
    t.run((ctx) => ctx.db.get("issuances", issuanceId as Id<"issuances">));
  return {
    t,
    scope,
    request,
    cancel,
    onProduction,
    gate,
    gateRow,
    rows,
    dpsOf,
    drive,
    issuanceRow,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: { data?: { code?: string }; message?: string }) =>
      error.data?.code ?? error.message ?? "ERROR",
  );
/** The Sefin of production, replaced: authorizes, finds and registers events. */
export function authority(f: Fixture, behaviour: { submit?: "authorize" | "timeout" } = {}) {
  let sent = "";
  let issuanceId = "";
  const spy = vi
    .spyOn(certificateTransport, "certificateRequest")
    .mockImplementation(async (target) => {
      if (target.url === `${SEFIN}/nfse` && target.body !== undefined) {
        sent = await f.dpsOf(issuanceId);
        if (behaviour.submit === "timeout") throw new Error("CERTIFICATE_TIMEOUT");
        return json(201, { chaveAcesso: KEY, nfseXmlGZipB64: gzipB64(nfseOf(sent)) });
      }
      if (target.url.startsWith(`${SEFIN}/dps/`) && target.body === undefined)
        return sent
          ? json(200, { tipoAmbiente: 1, chaveAcesso: KEY })
          : json(404, {
              tipoAmbiente: 1,
              erros: [{ Codigo: "E2220", Descricao: "Não encontrada" }],
            });
      if (target.url === `${SEFIN}/nfse/${KEY}` && target.body === undefined)
        return json(200, { nfseXmlGZipB64: gzipB64(nfseOf(sent)) });
      if (target.url === `${SEFIN}/nfse/${KEY}/eventos` && target.body !== undefined)
        return json(201, { eventoXmlGZipB64: gzipB64("<evento>sintético</evento>") });
      return json(404, { erros: [{ Codigo: "E2220", Descricao: "Não encontrado" }] });
    });
  return {
    spy,
    track: (id: string) => {
      issuanceId = id;
    },
    calls: () =>
      spy.mock.calls.map(
        ([target]) => `${target.body === undefined ? "GET" : "POST"} ${target.url}`,
      ),
  };
}
/** Accepted and authorized in the fiscal production, through the real path. */
export async function authorized(f: Fixture, key = "autorizada") {
  f.onProduction();
  await f.gate(true);
  const fake = authority(f);
  const accepted = await f.request(key);
  fake.track(accepted.issuance.id);
  await f.drive(accepted.issuance.operationId);
  vi.restoreAllMocks();
  return accepted.issuance;
}
