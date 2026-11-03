import { decimal, multiply, normalizeCnpj, quantize, validCpf } from "@freecorps/fiscal-core";
import {
  buildDpsId,
  dhBrasilia,
  hojeBrasilia,
  ibsCbsRequirement,
  isCalendarDate,
  resolveRoute,
  subitemFromCTribNac,
} from "@freecorps/fiscal-nfse/pure";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isIssuanceProductionDeployment, productionCompanies } from "./issuanceProduction";
import { isAmount, isCompetence, isIssRate } from "./issuanceRules";
import {
  campinasSeries,
  hasControl,
  stripPunctuation,
  validEmail,
  validMunicipalityCode,
} from "./nfseProfileRules";
import type { NfseActivity } from "./nfseProfileValues";
import { deny } from "./organizationAccess";
import { currentRow } from "./coldArchiveCurrent";
import { originalId } from "./coldArchiveOrigin";
import { authenticateKey, keyAccess, memberAccess } from "./operationAccess";
import { projectGrant } from "./projectAccess";
import { connectionAccess } from "./stripeAccess";
import {
  CANCEL_SCOPE,
  FOREIGN_CURRENCIES,
  ISSUE_SCOPE,
  SNAPSHOT_VERSION,
  cancelTask,
  issueTask,
  type IssuanceInput,
  type IssuanceView,
  type TransportMode,
} from "./issuanceValues";

export type IssuanceScope = {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
  companyId: Id<"companies">;
  environment: "sandbox" | "production";
};
export const scopeOf = (scope: IssuanceScope): IssuanceScope => ({
  organizationId: scope.organizationId,
  projectId: scope.projectId,
  companyId: scope.companyId,
  environment: scope.environment,
});

function invalid(code: string, field?: string): never {
  throw new ConvexError(field ? { code, field } : { code });
}

export type IssuanceAction = "issue" | "cancel" | "read";
/** Reading accepts either issuance scope: `documents:issue` when held, else `documents:cancel`. */
export const readScopeOf = (held: readonly string[]) =>
  !held.includes(ISSUE_SCOPE) && held.includes(CANCEL_SCOPE) ? CANCEL_SCOPE : ISSUE_SCOPE;
/**
 * Task scope a read is checked against. Members hold what the project grant of the company holds;
 * a key holds only the scopes it shares with that grant, since `keyAccess` needs the scope in
 * both. The console listing and download tickets use it too, so they follow the same rule as `get`.
 */
export async function issuanceReadTask(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  companyId: Id<"companies">,
  keyScopes?: readonly string[],
) {
  const granted = (await projectGrant(ctx, projectId, companyId))?.scopes ?? [];
  const held = keyScopes ? granted.filter((scope) => keyScopes.includes(scope)) : granted;
  return { scope: readScopeOf(held) };
}
/** The console works on the company: its scope may omit the project. */
export type CompanyIssuanceScope = Omit<IssuanceScope, "projectId"> & {
  projectId?: Id<"projects">;
};
/**
 * Issuing needs `documents:issue`, cancelling `documents:cancel`; reading accepts either, so a key
 * that only cancels can still follow its request. API keys go through `keyAccess` (key scope,
 * environment, company and active project grant). Members go through `memberAccess`, with no
 * project or grant: access to the company, any reading role, and owner, admin or operator to
 * issue and cancel.
 */
export async function issuanceAccess(
  ctx: QueryCtx,
  scope: CompanyIssuanceScope,
  action: IssuanceAction,
  keyHash?: string,
  connectionId?: Id<"stripeConnections">,
) {
  if (connectionId !== undefined) {
    // Stripe connection (ADR 0006): issues and cancels under its project's grant, never reads.
    if (!scope.projectId || action === "read" || keyHash !== undefined) return deny("NOT_FOUND");
    const base = scopeOf({ ...scope, projectId: scope.projectId });
    await connectionAccess(ctx, connectionId, {
      ...base,
      task: { scope: action === "cancel" ? CANCEL_SCOPE : ISSUE_SCOPE },
    });
    return `stripe:${connectionId}`;
  }
  if (keyHash !== undefined) {
    if (!scope.projectId) return deny("NOT_FOUND");
    const base = scopeOf({ ...scope, projectId: scope.projectId });
    const task =
      action === "read"
        ? await issuanceReadTask(
            ctx,
            base.projectId,
            base.companyId,
            (await authenticateKey(ctx, keyHash)).scopes,
          )
        : { scope: action === "cancel" ? CANCEL_SCOPE : ISSUE_SCOPE };
    const key = await keyAccess(ctx, keyHash, { ...base, task });
    return `key:${key._id}`;
  }
  const { user } = await memberAccess(
    ctx,
    {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      environment: scope.environment,
      task: { scope: action === "cancel" ? CANCEL_SCOPE : ISSUE_SCOPE },
    },
    action !== "read",
  );
  return `user:${user._id}`;
}

/**
 * Companies of this deployment allowed to leave the simulator for the restricted production
 * (`FNFE_NFSE_RESTRICTED_COMPANIES`, company ids separated by commas). Anything malformed means
 * none: the policy fails closed.
 */
export function restrictedCompanies(): ReadonlySet<string> {
  const raw = (process.env.FNFE_NFSE_RESTRICTED_COMPANIES ?? "").trim();
  if (!raw) return new Set();
  const ids = raw.split(",").map((id) => id.trim());
  return ids.every((id) => /^[a-zA-Z0-9]{1,100}$/.test(id)) ? new Set(ids) : new Set();
}

/**
 * Real transport in the sandbox (ADR 0004 §8, phase 3): the deployment variable **and** the
 * company in the allowlist. The hosted profile serves several organizations; one variable alone
 * would send every company with an A1 in the vault to the tax authority.
 */
export function restrictedTransportAllowed(companyId: string) {
  return (
    process.env.PRODUCT_ENV === "sandbox" &&
    process.env.FNFE_NFSE_SANDBOX_TRANSPORT === "producao-restrita" &&
    restrictedCompanies().has(companyId)
  );
}

/** Deployment choice for the environment. Production always talks to the real production. */
export function transportModeFor(
  scope: Pick<IssuanceScope, "environment" | "companyId">,
): TransportMode {
  if (scope.environment === "production") return "producao";
  return restrictedTransportAllowed(scope.companyId) ? "producao-restrita" : "simulated";
}

/**
 * Vault policy of the NFS-e purpose, read in the same transaction that audits the certificate
 * use. In the sandbox, only an issuance frozen with `producao-restrita` whose company is still
 * allowed by the deployment gets the certificate. In `production`, only an operation and an
 * issuance in `production`, frozen with `producao` for `sefin-nacional`, for which
 * `productionTransportAllowed` still says yes: the same answer the executor reads before each
 * attempt, so the two never disagree. The simulator never asks for a certificate.
 */
export async function issuanceCertificateAllowed(ctx: QueryCtx, op: Doc<"operations">) {
  let issuance: Doc<"issuances"> | null = null;
  if (op.task.name === issueTask.name)
    issuance = await ctx.db
      .query("issuances")
      .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
      .unique();
  else if (op.task.name === cancelTask.name) {
    const cancellation = await ctx.db
      .query("issuanceCancellations")
      .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
      .unique();
    issuance = cancellation ? await ctx.db.get("issuances", cancellation.issuanceId) : null;
  }
  if (
    !issuance ||
    issuance.organizationId !== op.organizationId ||
    issuance.companyId !== op.companyId ||
    issuance.environment !== op.environment
  )
    return false;
  if (op.environment === "production")
    return (
      transportModeFor(issuance) === "producao" &&
      (await productionTransportAllowed(
        ctx,
        issuance,
        op.task.name === cancelTask.name ? "cancel" : "issue",
      ))
    );
  return (
    op.environment === "sandbox" &&
    issuance.transport === "producao-restrita" &&
    transportModeFor(issuance) === "producao-restrita"
  );
}

export async function productionGate(ctx: QueryCtx, companyId: Id<"companies">) {
  return ctx.db
    .query("issuanceGates")
    .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
    .unique();
}

/** What a production transport is for: a new invoice, or the cancellation of a real one. */
export type ProductionPurpose = "issue" | "cancel";

/**
 * The only target with real production in the platform. The Campinas channel (`campinas-adn`)
 * has no authorization seen in production and is refused there (ADR 0004 §6, #198).
 */
export const PRODUCTION_TARGET = "sefin-nacional";

/**
 * Policy of the fiscal production (ADR 0004 §8, amendments of 21/10/2026, #198), the single
 * source of truth of the production transport. It holds for an issuance (or its cancellation) in
 * `production`, frozen with `producao` for `sefin-nacional`, on the fiscal production deployment,
 * whose company is in `FNFE_NFSE_PRODUCTION_COMPANIES`. The company's gate, in the same
 * organization, holds back only new invoices: a first submission needs it on. A cancellation of
 * an authorized invoice, and the reconciliation of an issuance already submitted (a consultation,
 * never a resend: `productionResendAllowed`), go on with the gate off while the company is in the
 * list. Taking the company out of the list stops everything. Read by the executor before every
 * attempt and by the vault when it hands out the certificate; a `false` stops the attempt before
 * anything is sent, definitively when nothing was sent yet.
 */
export async function productionTransportAllowed(
  ctx: QueryCtx,
  issuance: Doc<"issuances">,
  purpose: ProductionPurpose,
) {
  if (
    issuance.environment !== "production" ||
    issuance.transport !== "producao" ||
    issuance.target !== PRODUCTION_TARGET ||
    !isIssuanceProductionDeployment() ||
    !productionCompanies().has(issuance.companyId)
  )
    return false;
  if (purpose === "cancel" || issuance.submissions > 0) return true;
  return productionGateOpen(ctx, issuance);
}

/**
 * Whether an issuance already submitted may be sent again after the authority answered that the
 * DPS does not exist. Sending again is a new invoice as far as the gate goes: in `production` it
 * needs the gate on; elsewhere nothing changes. Read right before the resend.
 */
export async function productionResendAllowed(ctx: QueryCtx, issuance: Doc<"issuances">) {
  return issuance.environment !== "production" || productionGateOpen(ctx, issuance);
}

async function productionGateOpen(ctx: QueryCtx, issuance: Doc<"issuances">) {
  const gate = await productionGate(ctx, issuance.companyId);
  return !!gate?.production && gate.organizationId === issuance.organizationId;
}

/**
 * `[simular:...]` chooses an outcome of the sandbox simulator. In production it would go to a
 * real invoice as text, so the request is refused before any number is reserved.
 */
export function hasSimulationMarker(description: string) {
  return description.toLowerCase().includes("[simular:");
}

// ---------------------------------------------------------------------------------------------
// Request normalization. Deterministic and independent of the clock and of the profile: the
// result is the idempotency identity of the request.

function text(value: string | undefined, max: number, field: string, required = true) {
  const result = (value ?? "").trim().replace(/\s+/g, " ");
  if ((required && !result) || result.length > max || hasControl(result))
    invalid("ISSUANCE_FIELD_INVALID", field);
  return result;
}
function optionalText(value: string | undefined, max: number, field: string) {
  const result = text(value, max, field, false);
  return result ? result : undefined;
}
function email(value: string | undefined, field: string, required: boolean) {
  const result = (value ?? "").trim();
  if (!result) return required ? invalid("ISSUANCE_FIELD_INVALID", field) : undefined;
  if (!validEmail(result)) invalid("ISSUANCE_FIELD_INVALID", field);
  return result;
}
function money(value: string, field: string) {
  const result = value.trim();
  if (!isAmount(result)) invalid("ISSUANCE_AMOUNT_INVALID", field);
  return quantize(decimal(result), 2, "reject");
}

export type NormalizedRequest = ReturnType<typeof normalizeIssuanceInput>;
export function normalizeIssuanceInput(input: IssuanceInput) {
  const activityCode = text(input.activityCode, 40, "activityCode");
  if (!isCompetence(input.competence.trim())) invalid("ISSUANCE_COMPETENCE_INVALID", "competence");
  const issueDate = input.issueDate?.trim();
  if (issueDate !== undefined && !isCalendarDate(issueDate))
    invalid("ISSUANCE_DATE_INVALID", "issueDate");
  const currency = input.amount.currency.trim().toUpperCase();
  if (currency !== "BRL" && !(FOREIGN_CURRENCIES as readonly string[]).includes(currency))
    invalid("ISSUANCE_CURRENCY_UNSUPPORTED", "amount.currency");
  const value = money(input.amount.value, "amount.value");
  const issRate = input.issRate?.trim();
  if (issRate !== undefined && !isIssRate(issRate)) invalid("ISSUANCE_ISS_RATE_INVALID", "issRate");
  const t = input.taker;
  let taker:
    | {
        kind: "national";
        documentType: "CPF" | "CNPJ";
        document: string;
        name: string;
        email?: string;
        address: {
          municipalityCode: string;
          postalCode: string;
          street: string;
          number: string;
          district: string;
        };
      }
    | {
        kind: "foreign";
        nif?: string;
        nifAbsence?: 1 | 2;
        name: string;
        email?: string;
        address: {
          country: string;
          city: string;
          postalCode: string;
          state: string;
          street: string;
          number: string;
          district: string;
        };
      };
  if (t.kind === "national") {
    const document = stripPunctuation(t.document);
    const documentType = document.length === 11 ? "CPF" : "CNPJ";
    if (documentType === "CPF" ? !validCpf(document) : normalizeCnpj(document) !== document)
      invalid("ISSUANCE_TAKER_DOCUMENT_INVALID", "taker.document");
    const municipalityCode = t.address.municipalityCode.trim();
    if (!validMunicipalityCode(municipalityCode))
      invalid("ISSUANCE_FIELD_INVALID", "taker.address.municipalityCode");
    const postalCode = stripPunctuation(t.address.postalCode);
    if (!/^\d{8}$/.test(postalCode)) invalid("ISSUANCE_FIELD_INVALID", "taker.address.postalCode");
    taker = {
      kind: "national",
      documentType,
      document,
      name: text(t.name, 300, "taker.name"),
      ...(t.email?.trim() ? { email: email(t.email, "taker.email", false) } : {}),
      address: {
        municipalityCode,
        postalCode,
        street: text(t.address.street, 255, "taker.address.street"),
        number: text(t.address.number, 60, "taker.address.number"),
        district: text(t.address.district, 60, "taker.address.district"),
      },
    };
  } else {
    const nif = optionalText(t.nif, 40, "taker.nif");
    if (nif ? t.nifAbsence !== undefined : t.nifAbsence === undefined)
      invalid("ISSUANCE_TAKER_NIF_INVALID", "taker.nif");
    const country = t.address.country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || country === "BR")
      invalid("ISSUANCE_FIELD_INVALID", "taker.address.country");
    // The DPS XSD requires every part of the foreign address (TCEnderExt: cEndPost, xCidade,
    // xEstProvReg; TCEndereco: xLgr, nro, xBairro), with these maximum lengths. Without a
    // district in the address abroad, the taker informs the region or "N/A".
    const address = {
      country,
      city: text(t.address.city, 60, "taker.address.city"),
      postalCode: text(t.address.postalCode, 11, "taker.address.postalCode"),
      state: text(t.address.state, 60, "taker.address.state"),
      street: text(t.address.street, 255, "taker.address.street"),
      number: text(t.address.number, 60, "taker.address.number"),
      district: text(t.address.district, 60, "taker.address.district"),
    };
    taker = {
      kind: "foreign",
      ...(nif ? { nif } : { nifAbsence: t.nifAbsence! }),
      name: text(t.name, 300, "taker.name"),
      ...(t.email?.trim() ? { email: email(t.email, "taker.email", false) } : {}),
      address,
    };
  }
  const market = input.market;
  if (market === "export") {
    // Export of services: ISS not levied (LC 116/2003, art. 2º, I), foreign taker and currency.
    if (taker.kind !== "foreign") invalid("ISSUANCE_EXPORT_TAKER_REQUIRED", "taker");
    if (currency === "BRL") invalid("ISSUANCE_EXPORT_CURRENCY_REQUIRED", "amount.currency");
    if (issRate !== undefined) invalid("ISSUANCE_ISS_NOT_LEVIED", "issRate");
    if (input.issWithheld) invalid("ISSUANCE_WITHHOLDING_INVALID", "issWithheld");
  } else {
    if (taker.kind !== "national") invalid("ISSUANCE_TAKER_INVALID", "taker");
    if (currency !== "BRL") invalid("ISSUANCE_CURRENCY_INVALID", "amount.currency");
    if (input.issWithheld && taker.documentType !== "CNPJ")
      invalid("ISSUANCE_WITHHOLDING_INVALID", "issWithheld");
  }
  // Without an e-mail in the request, the snapshot takes the one of the profile.
  const issuerEmail = email(input.issuerEmail, "issuerEmail", false);
  return {
    activityCode,
    competence: input.competence.trim(),
    ...(issueDate ? { issueDate } : {}),
    ...(issuerEmail ? { issuerEmail } : {}),
    market,
    taker,
    description: text(input.description, 2000, "description"),
    amount: { currency, value },
    ...(issRate !== undefined ? { issRate: quantize(decimal(issRate), 4, "reject") } : {}),
    issWithheld: input.issWithheld,
  };
}

// ---------------------------------------------------------------------------------------------
// Snapshot: the request checked against the profile in force, frozen at acceptance.

/**
 * What the Campinas validator (IMA) requires beyond the national layout, as observed in its
 * homologation by the legacy engine on 29/08/2026: `cTribMun` (L0017/E0314), `cNBS` (E0316), the
 * group `IBSCBS` (L9999) and an integration series between 10001 and 49999 (L0022). Missing
 * pieces refuse the request before any number is reserved, naming what the profile lacks.
 */
function campinasSeriesOf(profile: Doc<"nfseProfiles">, activity: NfseActivity) {
  const series = profile.campinasDpsSeries ?? profile.dpsSeries;
  const missing = [
    ...(activity.cTribMun ? [] : ["cTribMun"]),
    ...(activity.nbs ? [] : ["nbs"]),
    ...(activity.ibsCbs ? [] : ["ibsCbs"]),
    ...(campinasSeries(series) ? [] : ["campinasDpsSeries"]),
  ];
  if (missing.length)
    throw new ConvexError({
      code: "NFSE_ROUTE_PROFILE_INCOMPLETE",
      missing,
      message: `O canal de Campinas exige no perfil fiscal: ${missing
        .map((field) => PROFILE_FIELDS[field])
        .join(", ")}.`,
    });
  return series;
}
const PROFILE_FIELDS: Record<string, string> = {
  cTribMun: "código de tributação municipal da atividade",
  nbs: "código NBS da atividade",
  ibsCbs: "classificação IBS/CBS da atividade",
  campinasDpsSeries: "série da DPS de Campinas, entre 10001 e 49999",
};

/** Rule id frozen when the group goes only because the Campinas validator requires it (L9999). */
const CAMPINAS_IBSCBS_RULE = "campinas-ima";

const brDate = (iso: string) => iso.split("-").reverse().join("/");

/**
 * Whether the DPS carries the group `IBSCBS`, decided once at acceptance and frozen in the
 * snapshot. The obligation comes from `ibsCbsRequirement` (Ato Conjunto RFB/CGIBS 4/2026), by
 * regime, subitem and the taxable event, which the DPS declares in `dCompet`: the route keeps
 * the issue date, as the municipal guide does, but the Ato counts the facts that occur from each
 * date. On any target, a required group needs the activity's classification. The Campinas
 * channel sends the group even before the Ato, because its validator requires it.
 *
 * An export with the group required is refused: its `cIndOp`, CST and `cClassTrib` are not the
 * domestic activity's (Anexo VII, 100501 is the taker's address in Brazil) and no official
 * answer gives them yet (#198, #338). The Simples, outside the Ato until 2027, keeps exporting.
 */
function ibsCbsGroupOf(args: {
  simples: boolean;
  activity: NfseActivity;
  dCompet: string;
  market: NormalizedRequest["market"];
  campinas: boolean;
}) {
  const subitem = subitemFromCTribNac(args.activity.cTribNac);
  const requirement = ibsCbsRequirement({
    regime: args.simples ? "simples-nacional" : "nao-optante",
    subitem,
    date: args.dCompet,
  });
  const what = `${args.simples ? "optante do Simples Nacional" : "não optante"} no subitem ${subitem}`;
  const since = `Para fato gerador desde ${brDate(requirement.since)} (Ato Conjunto RFB/CGIBS 4/2026)`;
  if (requirement.required && args.market === "export")
    throw new ConvexError({
      code: "ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED",
      message: `${since}, a exportação de ${what} leva o grupo IBS/CBS. A classificação da exportação ainda não tem fonte oficial, e a da atividade nacional não serve ao tomador no exterior.`,
    });
  // On the Campinas channel, `campinasSeriesOf` names `ibsCbs` with the channel's other fields.
  if (requirement.required && !args.campinas && !args.activity.ibsCbs)
    throw new ConvexError({
      code: "NFSE_ROUTE_PROFILE_INCOMPLETE",
      missing: ["ibsCbs"],
      message: `${since}, a NFS-e de ${what} exige no perfil fiscal: ${PROFILE_FIELDS.ibsCbs}.`,
    });
  if (requirement.required) return { required: true, ruleId: requirement.ruleId };
  if (args.campinas) return { required: true, ruleId: CAMPINAS_IBSCBS_RULE };
  return { required: false, ruleId: requirement.ruleId };
}

const lastDay = (competence: string) => {
  const [year, month] = competence.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
};

export type IssuanceSnapshot = ReturnType<typeof buildSnapshot>;
export function buildSnapshot(args: {
  request: NormalizedRequest;
  company: Doc<"companies">;
  profile: Doc<"nfseProfiles">;
  environment: IssuanceScope["environment"];
  transport: TransportMode;
  now: number;
}) {
  const { request, company, profile } = args;
  const activity = profile.activities.find(
    (item) => item.code.toUpperCase() === request.activityCode.toUpperCase(),
  );
  if (!activity) return invalid("NFSE_ACTIVITY_NOT_FOUND", "activityCode");
  const today = hojeBrasilia(new Date(args.now));
  const issueDate = request.issueDate ?? today;
  if (issueDate > today) invalid("ISSUANCE_DATE_FUTURE", "issueDate");
  // dCompet cannot be after the issue date (E0015): the competence month is closed by the
  // earlier of its last day and the issue date.
  if (request.competence > issueDate.slice(0, 7))
    invalid("ISSUANCE_COMPETENCE_FUTURE", "competence");
  const dCompet = lastDay(request.competence) < issueDate ? lastDay(request.competence) : issueDate;
  const dhEmi =
    issueDate === today ? dhBrasilia(new Date(args.now)) : `${issueDate}T12:00:00-03:00`;
  const simples = profile.opSimpNac !== 1;
  const route = resolveRoute({
    municipioIbge: profile.municipalityCode,
    regime: simples ? "simples-nacional" : "nao-optante",
    subitem: subitemFromCTribNac(activity.cTribNac),
    date: issueDate,
  });
  if (route.kind === "unsupported")
    throw new ConvexError({
      code: "NFSE_ROUTE_UNSUPPORTED",
      reason: route.code,
      message: route.message,
    });
  const campinas = route.target === "campinas-adn";
  const ibsCbsGroup = ibsCbsGroupOf({
    simples,
    activity,
    dCompet,
    market: request.market,
    campinas,
  });
  const series = campinas ? campinasSeriesOf(profile, activity) : profile.dpsSeries;
  const issuerEmail = request.issuerEmail ?? profile.issuerEmail;
  if (!issuerEmail) invalid("ISSUANCE_ISSUER_EMAIL_REQUIRED", "issuerEmail");
  // The foreign postal code is required on every target by `normalizeIssuanceInput` (XSD).
  // The Simples provider without withholding omits the rate (E0625); a non-opting provider and
  // any withholding state it. Campinas follows the same rule: on 09/10/2026 its homologation
  // (Simples ME/EPP, service 01.05.01.001 at 2,00% in the ADN and in the IMA table) rejected
  // pAliq 2.00 without withholding with L0006 (rate does not match the municipal rule) and the
  // same rate with withholding with L0009 (service not subject to withholding). The old IMA
  // endpoint's "alíquota 0,0000% fora dos limites" no longer applies.
  if (request.market === "domestic") {
    const rateRequired = !simples || request.issWithheld;
    if (rateRequired && request.issRate === undefined)
      invalid("ISSUANCE_ISS_RATE_REQUIRED", "issRate");
    if (!rateRequired && request.issRate !== undefined)
      invalid("ISSUANCE_ISS_RATE_NOT_ALLOWED", "issRate");
  }
  const serviceBrl = request.amount.currency === "BRL" ? request.amount.value : null;
  const issAmount =
    serviceBrl !== null && request.issRate !== undefined
      ? quantize(
          multiply(multiply(decimal(serviceBrl), decimal(request.issRate)), decimal("0.01")),
          2,
          "half-up",
        )
      : null;
  return {
    version: SNAPSHOT_VERSION,
    acceptedAt: args.now,
    environment: args.environment,
    tpAmb: args.transport === "producao" ? (1 as const) : (2 as const),
    transport: args.transport,
    target: route.target,
    route: { ruleId: route.ruleId, source: route.source },
    issuer: {
      cnpj: company.cnpj,
      name: company.name,
      email: issuerEmail,
    },
    profile: {
      version: profile.version,
      municipalityCode: profile.municipalityCode,
      ...(profile.municipalRegistration
        ? { municipalRegistration: profile.municipalRegistration }
        : {}),
      opSimpNac: profile.opSimpNac,
      ...(profile.regApTribSN !== undefined ? { regApTribSN: profile.regApTribSN } : {}),
      regEspTrib: profile.regEspTrib,
      dpsSeries: series,
    },
    activity,
    ibsCbsGroup,
    issueDate,
    dhEmi,
    competence: request.competence,
    dCompet,
    market: request.market,
    taker: request.taker,
    description: request.description,
    amount: request.amount,
    serviceBrl,
    iss: {
      ...(request.issRate !== undefined ? { rate: request.issRate } : {}),
      withheld: request.issWithheld,
      amount: issAmount,
    },
  };
}

/**
 * Hands out the next DPS number of the company, environment and series. Convex serializes
 * concurrent mutations on the same row, so two requests never get the same number. A number is
 * never returned to the pool: rejection leaves a gap, which the national standard accepts.
 */
export async function reserveDpsNumber(ctx: MutationCtx, scope: IssuanceScope, series: string) {
  const row = await ctx.db
    .query("dpsSequences")
    .withIndex("by_companyId_and_environment_and_series", (q) =>
      q.eq("companyId", scope.companyId).eq("environment", scope.environment).eq("series", series),
    )
    .unique();
  const number = (row?.last ?? 0) + 1;
  if (number > 999_999_999_999_999) return deny("DPS_NUMBER_EXHAUSTED");
  if (row) await ctx.db.patch("dpsSequences", row._id, { last: number, updatedAt: Date.now() });
  else
    await ctx.db.insert("dpsSequences", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      environment: scope.environment,
      series,
      last: number,
      updatedAt: Date.now(),
    });
  return number;
}
export const dpsIdOf = (snapshot: IssuanceSnapshot, number: number) =>
  buildDpsId({
    cLocEmi: snapshot.profile.municipalityCode,
    serie: Number(snapshot.profile.dpsSeries),
    nDPS: number,
    prest: { cnpj: snapshot.issuer.cnpj },
  });

export async function issuanceEvent(
  ctx: MutationCtx,
  issuance: Doc<"issuances">,
  kind: Doc<"issuanceEvents">["kind"],
  code?: string,
  operationId?: Id<"operations">,
) {
  await ctx.db.insert("issuanceEvents", {
    organizationId: issuance.organizationId,
    issuanceId: issuance._id,
    kind,
    ...(code ? { code } : {}),
    ...(operationId ? { operationId } : {}),
    createdAt: Date.now(),
  });
}

/** The caller authorized the scope; the row still proves it belongs to it. */
/** Without a project (the console), any issuance of the company; with one, only that project's. */
export async function scopedIssuance(ctx: QueryCtx, scope: CompanyIssuanceScope, id: string) {
  // An ID of before a rehydration resolves through the organization's map (ADR 0009, §6).
  const issuance = await currentRow(ctx, scope.organizationId, "issuances", id);
  if (
    !issuance ||
    issuance.organizationId !== scope.organizationId ||
    (scope.projectId !== undefined && issuance.projectId !== scope.projectId) ||
    issuance.companyId !== scope.companyId ||
    issuance.environment !== scope.environment
  )
    return deny("NOT_FOUND");
  return issuance;
}

export async function issuanceView(
  ctx: QueryCtx,
  issuance: Doc<"issuances">,
): Promise<IssuanceView> {
  const snapshot = JSON.parse(issuance.snapshot) as IssuanceSnapshot;
  const op = await ctx.db.get("operations", issuance.operationId);
  const artifacts = await ctx.db
    .query("issuanceArtifacts")
    .withIndex("by_issuanceId_and_kind", (q) => q.eq("issuanceId", issuance._id))
    .take(20);
  const cancellation = issuance.cancellationId
    ? await ctx.db.get("issuanceCancellations", issuance.cancellationId)
    : null;
  return {
    id: issuance._id,
    ...originalId(issuance),
    organizationId: issuance.organizationId,
    projectId: issuance.projectId,
    companyId: issuance.companyId,
    environment: issuance.environment,
    operationId: issuance.operationId,
    operationState: op?.state ?? "failed",
    state: issuance.state,
    transport: issuance.transport,
    target: issuance.target,
    series: issuance.series,
    number: issuance.number,
    dpsId: issuance.dpsId,
    issueDate: snapshot.issueDate,
    competence: snapshot.competence,
    market: snapshot.market,
    amount: snapshot.amount,
    serviceBrl: snapshot.serviceBrl ?? issuance.exchange?.brlAmount ?? null,
    exchange: issuance.exchange ?? null,
    accessKey: issuance.accessKey ?? null,
    nfseNumber: issuance.nfseNumber ?? null,
    documentId: issuance.documentId ?? null,
    code: issuance.code ?? null,
    rejections: issuance.rejections ?? [],
    artifacts: artifacts.map((row) => ({
      id: row._id,
      ...originalId(row),
      kind: row.kind,
      sha256: row.sha256,
      size: row.size,
      signed: row.signed,
      createdAt: row.createdAt,
    })),
    cancellation: cancellation
      ? {
          id: cancellation._id,
          operationId: cancellation.operationId,
          state: cancellation.state,
          sequence: cancellation.sequence,
          reasonCode: cancellation.reasonCode,
          reason: cancellation.reason,
          code: cancellation.code ?? null,
          rejections: cancellation.rejections ?? [],
          alreadyRegistered: cancellation.alreadyRegistered ?? false,
          createdAt: cancellation.createdAt,
          updatedAt: cancellation.updatedAt,
        }
      : null,
    version: issuance.version,
    createdAt: issuance.createdAt,
    updatedAt: issuance.updatedAt,
  };
}

/** Bounded copy of the rejections returned by the tax authority. */
export function boundedRejections(
  items: ReadonlyArray<{ code: string | null; message: string; complement?: string | null }>,
) {
  return items.slice(0, 20).map((item) => ({
    code: item.code && /^[A-Za-z0-9_.-]{1,20}$/.test(item.code) ? item.code : null,
    message: [item.message, item.complement].filter(Boolean).join(" — ").slice(0, 500),
  }));
}
