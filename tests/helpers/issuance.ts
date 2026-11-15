import { consoleProjectFor } from "./console";
import { vi } from "vite-plus/test";
import { internal } from "../../platform/convex/_generated/api";
import type { Doc, Id } from "../../platform/convex/_generated/dataModel";
import {
  ISSUANCE_SCOPES,
  SYNTHETIC_ISSUER_CNPJ as ISSUER_CNPJ,
  issuerScope,
  nfseProfile,
  person,
  platformTest,
  softwareLicense,
  syntheticApiKey,
  type PlatformTest,
  type ProfileFields,
} from "./platform";
import { hashApiKey } from "../../platform/convex/lib/apiKeyCrypto";
import type { IssuanceInput } from "../../platform/convex/lib/issuanceValues";
import { syntheticCertificate } from "./certificates";
import * as certificateTransport from "../../platform/convex/lib/certificateTransport";
import { encryptCertificate } from "../../platform/convex/lib/certificateCrypto";

/**
 * Fixtures of the NFS-e issuance suites: synthetic companies, takers and profiles, and the
 * synthetic A1 and authority of the restricted production. Nothing here reaches a tax authority.
 */

/** Sefin produção restrita (and the simulated sandbox, tpAmb 2): NT 009 layout since 20/10/2026. */
export const PRODREST = "nfse-1.01-prodrest-20261020" as const;
type T = PlatformTest;

/** Organization, project, declared company with an NFS-e profile in São Paulo (Sefin Nacional). */
export async function fixture(
  t = platformTest(),
  options: { profile?: ProfileFields | null; demonstration?: boolean } = {},
) {
  const keyHash = await hashApiKey(syntheticApiKey("b"));
  // The project grant and the key carry the issuance scopes; tests narrow them when needed.
  const scope = await issuerScope(t, {
    keyHash,
    kind: options.demonstration ? "demonstration" : "declared",
    grantScopes: ISSUANCE_SCOPES,
    keyScopes: ISSUANCE_SCOPES,
  });
  if (options.profile !== null) await nfseProfile(t, scope, options.profile);
  const owner = await person(t, scope.organizationId, "owner");
  // People act through the organization's console project; the key, through its own project.
  const where = {
    organizationId: scope.organizationId,
    projectId: await consoleProjectFor(t, scope.organizationId),
    companyId: scope.companyId,
    environment: "sandbox" as const,
  };
  const keyWhere = { ...where, projectId: scope.projectId };
  return { t, scope, where, keyWhere, owner, keyHash };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export const nationalTaker = {
  kind: "national" as const,
  document: "11.444.777/0001-61",
  name: "Tomador Sintético Ltda",
  email: "contas@tomador.example",
  address: {
    municipalityCode: "3550308",
    postalCode: "01001-000",
    street: "Praça da Sé",
    number: "100",
    district: "Sé",
  },
};
export const domestic = (overrides: Partial<IssuanceInput> = {}): IssuanceInput => ({
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
export const exported = (overrides: Partial<IssuanceInput> = {}): IssuanceInput => ({
  activityCode: "licenca",
  competence: "2026-10",
  issueDate: "2026-10-05",
  issuerEmail: "fiscal@prestador.example",
  market: "export",
  taker: {
    kind: "foreign",
    nif: "98-7654321",
    name: "Example Grocery LLC",
    address: {
      country: "us",
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
  ...overrides,
});

export function code(promise: Promise<unknown>) {
  return promise.then(
    () => "OK",
    (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
  );
}
export const request = (f: Fixture, key: string, input: IssuanceInput) =>
  f.owner.mutation(internal.issuance.request, { ...f.where, idempotencyKey: key, input });
export const cancel = (f: Fixture, key: string, issuanceId: string, reason: string) =>
  f.owner.mutation(internal.issuance.cancel, {
    ...f.where,
    idempotencyKey: key,
    issuanceId,
    reasonCode: "1",
    reason,
  });
export const view = (f: Fixture, issuanceId: string) =>
  f.owner.query(internal.issuance.get, { ...f.where, issuanceId });

/** Runs the operation like the worker pool would, one claimed attempt at a time. */
export async function drive(t: T, operationId: Id<"operations">, steps = 1) {
  for (let i = 0; i < steps; i++) {
    const op = (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
    if (!["queued", "retry_wait", "reconciling"].includes(op.state)) break;
    vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
    await t.action(internal.operationWorker.run, { operationId, generation: op.generation });
  }
  return (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
}
export async function xmlOf(
  t: T,
  issuanceId: Id<"issuances">,
  kind: Doc<"issuanceArtifacts">["kind"],
) {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("issuanceArtifacts")
      .withIndex("by_issuanceId_and_kind", (q) => q.eq("issuanceId", issuanceId).eq("kind", kind))
      .collect();
    return Promise.all(rows.map(async (row) => (await ctx.storage.get(row.storageId))!.text()));
  });
}
export async function simulation(t: T, dpsId: string) {
  return t.run(async (ctx) =>
    (await ctx.db.query("issuanceSimulations").collect()).find((row) => row.dpsId === dpsId),
  );
}

/** Campinas profile with what its validator requires (codes from the legacy homolog test). */
export const campinasProfile = (overrides: ProfileFields = {}): ProfileFields => ({
  municipalityCode: "3509502",
  campinasDpsSeries: "10001",
  activities: [
    {
      ...softwareLicense,
      cTribMun: "001",
      ibsCbs: { cIndOp: "100501", cst: "000", cClassTrib: "000001" },
    },
  ],
  ...overrides,
});
export const campinasTaker = {
  ...nationalTaker,
  address: { ...nationalTaker.address, municipalityCode: "3509502", postalCode: "13100-030" },
};

// Phase 3: real transport to the restricted production. The certificate is synthetic, made in
// memory, and every call to the network is replaced: nothing here reaches a tax authority.

const KEYRING = { active: "k1", keys: { k1: "ab".repeat(32) } };

/** Active synthetic A1 of the company, sealed in the vault envelope like an upload. */
export async function installCertificate(f: Fixture) {
  vi.stubEnv("FNFE_PLATFORM_CERT_KEYS", JSON.stringify(KEYRING));
  const material = syntheticCertificate({ cnpj: ISSUER_CNPJ });
  return f.t.run(async (ctx) => {
    const membership = (await ctx.db.query("memberships").first())!;
    const now = Date.now();
    const id = await ctx.db.insert("certificates", {
      organizationId: f.where.organizationId,
      companyId: f.where.companyId,
      version: 1,
      state: "active",
      uploaderId: "synthetic",
      membershipId: membership._id,
      membershipVersion: 1,
      metadata: {
        fingerprint: "c".repeat(64),
        subject: "Synthetic certificate, no fiscal validity",
        cnpj: ISSUER_CNPJ,
        notBefore: now - 86400_000,
        notAfter: now + 86400_000,
      },
      envelopeRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const envelope = encryptCertificate(
      KEYRING,
      { organizationId: f.where.organizationId, companyId: f.where.companyId, id, version: 1 },
      material.pfx,
      material.password,
    );
    await ctx.db.patch("certificates", id, { envelope });
    await ctx.db.insert("certificateHeads", {
      organizationId: f.where.organizationId,
      companyId: f.where.companyId,
      nextVersion: 2,
      latestId: id,
      activeId: id,
    });
    return id;
  });
}
export function openRestricted(...companies: string[]) {
  vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "producao-restrita");
  vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", companies.join(","));
}
export async function certificateUses(f: Fixture) {
  const rows = await f.t.run((ctx) => ctx.db.query("certificateAudit").collect());
  return rows.map((row) => `${row.action}:${row.result}`);
}
export async function claimOperation(t: T, operationId: Id<"operations">) {
  const op = (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
  vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
  const claimed = (await t.mutation(internal.operations.claim, {
    operationId,
    generation: op.generation,
  }))!;
  const token = { operationId, generation: claimed.generation, fence: claimed.fence! };
  await t.mutation(internal.operations.beginEffect, token);
  return token;
}
/** Records each mTLS request instead of opening a socket; by default the authority is down. */
export function fakeAuthority() {
  return vi
    .spyOn(certificateTransport, "certificateRequest")
    .mockImplementation(async () => ({ status: 503, body: Buffer.from("") }));
}
