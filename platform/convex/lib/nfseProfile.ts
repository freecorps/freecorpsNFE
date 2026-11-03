import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { NfseActivity, NfseProfileInput } from "./nfseProfileValues";
import {
  cTribNacMatchesItem,
  campinasSeries,
  stripPunctuation as digits,
  hasControl,
  lc116Item as normalizeLc116Item,
  municipalityState,
  validEmail,
  validMunicipalityCode,
} from "./nfseProfileRules";

export const MAX_ACTIVITIES = 50;
/** `activity` is the zero-based position in the submitted list, so the form can point to it. */
function invalid(code: string, activity?: number): never {
  throw new ConvexError(activity === undefined ? { code } : { code, activity });
}
function text(value: string | undefined, max: number, code: string, activity?: number) {
  const result = (value ?? "").trim();
  if (result.length > max || hasControl(result)) invalid(code, activity);
  return result;
}

function activity(input: NfseActivity, index: number): NfseActivity {
  const code = text(input.code, 40, "INVALID_ACTIVITY_CODE", index);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(code)) invalid("INVALID_ACTIVITY_CODE", index);
  const label = text(input.label, 80, "INVALID_ACTIVITY_LABEL", index);
  if (!label) invalid("INVALID_ACTIVITY_LABEL", index);
  const cnae = digits(input.cnae);
  if (!/^\d{7}$/.test(cnae)) invalid("INVALID_CNAE", index);
  const lc116Item = normalizeLc116Item(input.lc116Item);
  if (!lc116Item) invalid("INVALID_LC116_ITEM", index);
  const cTribNac = digits(input.cTribNac);
  if (!/^\d{6}$/.test(cTribNac)) invalid("INVALID_CTRIBNAC", index);
  if (!cTribNacMatchesItem(cTribNac, lc116Item)) invalid("ACTIVITY_CODES_MISMATCH", index);
  const nbs = input.nbs === undefined ? "" : digits(input.nbs);
  if (nbs && !/^\d{9}$/.test(nbs)) invalid("INVALID_NBS", index);
  // TSCodTribMun of the national layout: 3 digits, the municipal suffix of cTribNac (the
  // Campinas validator answered E0314 to the 9-digit municipal code in 29/08/2026).
  const cTribMun = input.cTribMun === undefined ? "" : digits(input.cTribMun);
  if (cTribMun && !/^\d{3}$/.test(cTribMun)) invalid("INVALID_CTRIBMUN", index);
  const ibsCbs = input.ibsCbs && {
    cIndOp: digits(input.ibsCbs.cIndOp),
    cst: digits(input.ibsCbs.cst),
    cClassTrib: digits(input.ibsCbs.cClassTrib),
  };
  if (
    ibsCbs &&
    (!/^\d{6}$/.test(ibsCbs.cIndOp) ||
      !/^\d{3}$/.test(ibsCbs.cst) ||
      !/^\d{6}$/.test(ibsCbs.cClassTrib))
  )
    invalid("INVALID_IBSCBS", index);
  const description = text(input.description, 1000, "INVALID_ACTIVITY_DESCRIPTION", index);
  return {
    code,
    label,
    cnae,
    lc116Item,
    cTribNac,
    ...(nbs ? { nbs } : {}),
    ...(cTribMun ? { cTribMun } : {}),
    ...(ibsCbs ? { ibsCbs } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * Server-side normalization of the NFS-e issuing profile. Throws `ConvexError({ code })` on the
 * first invalid field; the form validates the same rules only as feedback.
 */
export function normalizeNfseProfile(
  input: NfseProfileInput,
  companyState: string,
): NfseProfileInput {
  const registration = digits(input.municipalRegistration ?? "").toUpperCase();
  if (registration && !/^[0-9A-Z]{1,15}$/.test(registration))
    invalid("INVALID_MUNICIPAL_REGISTRATION");
  const municipalityCode = input.municipalityCode.trim();
  if (!validMunicipalityCode(municipalityCode)) invalid("INVALID_MUNICIPALITY_CODE");
  if (municipalityState(municipalityCode) !== companyState) invalid("MUNICIPALITY_STATE_MISMATCH");
  // regApTribSN belongs to ME/EPP only (opSimpNac 3); the layout rejects it elsewhere.
  if ((input.opSimpNac === 3) !== (input.regApTribSN !== undefined)) invalid("INVALID_SIMPLES");
  const issuerEmail = (input.issuerEmail ?? "").trim();
  if (issuerEmail && !validEmail(issuerEmail)) invalid("INVALID_ISSUER_EMAIL");
  const series = input.dpsSeries.trim();
  if (!/^\d{1,5}$/.test(series) || !Number(series)) invalid("INVALID_DPS_SERIES");
  const campinas = (input.campinasDpsSeries ?? "").trim();
  if (campinas && !campinasSeries(campinas)) invalid("INVALID_CAMPINAS_DPS_SERIES");
  if (!input.activities.length) invalid("ACTIVITIES_REQUIRED");
  if (input.activities.length > MAX_ACTIVITIES) invalid("TOO_MANY_ACTIVITIES");
  const activities = input.activities.map(activity);
  const codes = new Set<string>(),
    classifications = new Set<string>();
  activities.forEach((item, index) => {
    const code = item.code.toUpperCase();
    const classification = [
      item.cnae,
      item.lc116Item,
      item.cTribNac,
      item.nbs ?? "",
      item.cTribMun ?? "",
    ].join(":");
    if (codes.has(code) || classifications.has(classification))
      invalid("DUPLICATE_ACTIVITY", index);
    codes.add(code);
    classifications.add(classification);
  });
  return {
    ...(registration ? { municipalRegistration: registration } : {}),
    ...(issuerEmail ? { issuerEmail } : {}),
    municipalityCode,
    opSimpNac: input.opSimpNac,
    ...(input.regApTribSN !== undefined ? { regApTribSN: input.regApTribSN } : {}),
    regEspTrib: input.regEspTrib,
    dpsSeries: String(Number(series)),
    ...(campinas ? { campinasDpsSeries: campinas } : {}),
    activities,
  };
}
export function nfseProfileOf(ctx: QueryCtx, companyId: Id<"companies">) {
  return ctx.db
    .query("nfseProfiles")
    .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
    .unique();
}
/** Series the profile can number: the Sefin Nacional one and, when set, the Campinas one. */
export const profileSeries = (profile: Doc<"nfseProfiles">) => [
  ...new Set([
    profile.dpsSeries,
    ...(profile.campinasDpsSeries ? [profile.campinasDpsSeries] : []),
  ]),
];
/** Few rows per company: two environments times the series the profile ever had. */
export function dpsSequencesOf(ctx: QueryCtx, companyId: Id<"companies">) {
  return ctx.db
    .query("dpsSequences")
    .withIndex("by_companyId_and_environment_and_series", (q) => q.eq("companyId", companyId))
    .take(100);
}
export function sequenceView(row: Doc<"dpsSequences">) {
  const start = row.start ?? 1;
  return {
    environment: row.environment,
    series: row.series,
    start,
    next: row.last + 1,
    locked: row.last >= start,
    startSetAt: row.startSetAt ?? null,
  };
}

/** Key order is not part of a Convex document; compare the fields of the profile only. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function sameProfile(stored: Doc<"nfseProfiles">, next: NfseProfileInput) {
  const { version: _version, updatedAt: _updatedAt, ...current } = profileView(stored);
  return JSON.stringify(canonical(current)) === JSON.stringify(canonical(next));
}
export function profileView(profile: Doc<"nfseProfiles">) {
  return {
    ...(profile.municipalRegistration
      ? { municipalRegistration: profile.municipalRegistration }
      : {}),
    ...(profile.issuerEmail ? { issuerEmail: profile.issuerEmail } : {}),
    municipalityCode: profile.municipalityCode,
    opSimpNac: profile.opSimpNac,
    ...(profile.regApTribSN !== undefined ? { regApTribSN: profile.regApTribSN } : {}),
    regEspTrib: profile.regEspTrib,
    dpsSeries: profile.dpsSeries,
    ...(profile.campinasDpsSeries ? { campinasDpsSeries: profile.campinasDpsSeries } : {}),
    activities: profile.activities,
    version: profile.version,
    updatedAt: profile.updatedAt,
  };
}
