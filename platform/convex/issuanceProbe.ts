"use node";
import {
  SEFIN_HOSTS,
  buildDpsId,
  nacional,
  resolveEndpoint,
  type NfseTargetId,
  type NfseTransport,
} from "@freecorps/fiscal-nfse";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { currentCertificateKeyring, decryptCertificate } from "./lib/certificateCrypto";
import { certificateRequest } from "./lib/certificateTransport";
import { responseDiagnostic } from "./lib/operationValues";

/**
 * Operator probes of the real NFS-e transport, read-only: GETs to fixed origins, without a body
 * (the transport refuses anything else, `PROBE_GET_ONLY`). Nothing is signed, sent or persisted
 * at the authority, no DPS number is reserved and no operation is created.
 *
 * `verify`, before any issuance, by deployment:
 *
 * - Sandbox (phase 3): the restricted production, under the issuance's sandbox policy
 *   (`FNFE_NFSE_SANDBOX_TRANSPORT=producao-restrita` and the company in
 *   `FNFE_NFSE_RESTRICTED_COMPANIES`). DPS consultation by an Id that cannot exist (series
 *   99999, number 999999999999999 of the company's own CNPJ) in the Sefin and in Campinas, the
 *   municipal agreement in the Sefin and the ADN of the restricted production and, if asked, in
 *   the ADN of production, and the municipal parameters.
 * - Fiscal production deployment (phase 4): the company in `FNFE_NFSE_PRODUCTION_COMPANIES`, and
 *   only production hosts (`PRODUCTION_PROBE_HOSTS`): the impossible DPS in the Sefin of
 *   production, the agreement and the parameters in the ADN of production.
 *
 * A 404 with the authority's JSON (`not-found`) proves that the authority accepted the client
 * certificate and answered the API; 401/403 (`ADN_ACCESS_DENIED`) says it refused it; a 404
 * without that JSON is `CONSULT_INCONCLUSIVE`, with `diagnostic`, the criterion the issuance uses.
 * Municipal parameters come back parsed and bounded (`PARAMETER_BODY_LIMIT`), never logged.
 *
 * `verifyIssued`, after an authorization in production: the DPS by its Id and the NFS-e by the
 * recorded key, to record whether a single NFS-e answers for the Id.
 *
 * Every run, allowed or refused, goes to the Freecorps probe history (`issuanceProbeEvents`,
 * with the GitHub login); the customer's certificate audit gets `nfse-probe` or, in production,
 * `nfse-probe-production`, with the generic operator.
 */
export const PROBE_SERIES = 99_999;
export const PROBE_NUMBER = 999_999_999_999_999;
export const ADN_HOSTS = {
  producaoRestrita: "adn.producaorestrita.nfse.gov.br",
  producao: "adn.nfse.gov.br",
} as const;
const CAMPINAS = "3509502";
const PROBE_TARGETS: readonly NfseTargetId[] = ["sefin-nacional", "campinas-adn"];

const consultation = v.object({
  target: v.string(),
  host: v.string(),
  outcome: v.string(),
  code: v.union(v.string(), v.null()),
  httpStatus: v.union(v.number(), v.null()),
  /** Sanitized transport error (`CERTIFICATE_TIMEOUT`, `CERTIFICATE_NETWORK_ERROR`...). */
  transportError: v.union(v.string(), v.null()),
  /** Shape of an unreadable answer (`uncertain`); never body values. */
  diagnostic: v.union(responseDiagnostic, v.null()),
});
const adhesion = v.object({
  source: v.string(),
  host: v.string(),
  httpStatus: v.union(v.number(), v.null()),
  aderenteAmbienteNacional: v.union(v.number(), v.null()),
  aderenteEmissorNacional: v.union(v.number(), v.null()),
  code: v.union(v.string(), v.null()),
});

const parameterRead = v.object({
  source: v.string(),
  /** `aliquota`, `historicoaliquotas`, `regimes_especiais`, `retencoes` or `beneficio`. */
  query: v.string(),
  host: v.string(),
  path: v.string(),
  httpStatus: v.union(v.number(), v.null()),
  /** Size of the body received, in bytes; null without a response. */
  bytes: v.union(v.number(), v.null()),
  /** Parsed JSON, when the body fits the limit and is a valid Convex value. */
  json: v.any(),
  /** Otherwise the body as text, cut at the limit (`truncated`). */
  text: v.union(v.string(), v.null()),
  truncated: v.boolean(),
  /** Sanitized transport error, as in `adhesion`. */
  code: v.union(v.string(), v.null()),
});

const probeResult = v.object({
  certificate: v.object({ id: v.id("certificates"), version: v.number() }),
  dpsId: v.string(),
  consultations: v.array(consultation),
  adhesion: v.array(adhesion),
  parameters: v.array(parameterRead),
});
type ProbeResult = Infer<typeof probeResult>;
/** What `certificateUse.authorizeProbe` hands out when the policy allows the probe. */
type Granted = {
  certificate: Doc<"certificates">;
  eventId: Id<"issuanceProbeEvents">;
  environment: "producao-restrita" | "producao";
  issuance: { id: Id<"issuances">; dpsId: string; accessKey: string } | null;
};
type Material = { pfx: Buffer; password: Buffer };

/** GET-only transport pinned to one origin; remembers the sanitized error of the last call. */
function probeTransport(origin: string, material: Material) {
  const state: { error: string | null } = { error: null };
  const transport: NfseTransport = async (request) => {
    if (request.method !== "GET" || request.body !== undefined) throw new Error("PROBE_GET_ONLY");
    try {
      const response = await certificateRequest(
        {
          url: request.url,
          headers: request.headers,
          allowedOrigins: [origin],
          timeoutMs: 15_000,
          maxBytes: 256 * 1024,
        },
        material,
      );
      return {
        status: response.status,
        body: response.body.toString("utf8"),
        contentType: response.contentType ?? null,
      };
    } catch (error) {
      state.error =
        error instanceof Error && /^[A-Z0-9_]{1,60}$/.test(error.message)
          ? error.message
          : "PROBE_TRANSPORT_FAILED";
      throw error;
    }
  };
  return { transport, state };
}

/** Flags of the agreement; the body is `{ parametrosConvenio: {...} }` or the object itself. */
export function adhesionFlags(body: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const outer = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const inner = (
    outer.parametrosConvenio && typeof outer.parametrosConvenio === "object"
      ? outer.parametrosConvenio
      : outer
  ) as Record<string, unknown>;
  const flag = (value: unknown) => (typeof value === "number" ? value : null);
  return {
    aderenteAmbienteNacional: flag(inner.aderenteAmbienteNacional),
    aderenteEmissorNacional: flag(inner.aderenteEmissorNacional),
  };
}

export const PARAMETER_BODY_LIMIT = 8 * 1024;

/**
 * Service code of the ADN parameters, `II.SS.DD.CCC`: the 6 digits of the DPS `cTribNac` plus
 * the 3 of the municipal complement (`000` when the municipality created none). The service
 * answers 400 to any other spelling, including the same 9 digits without dots, so 6 digits get
 * `.000` and 9 digits get the dots. Null when it is not a service code.
 */
export function parameterServiceCode(code: string) {
  const match = /^(\d{2})\.?(\d{2})\.?(\d{2})(?:\.?(\d{3}))?$/.exec(code);
  return match ? `${match[1]}.${match[2]}.${match[3]}.${match[4] ?? "000"}` : null;
}

/**
 * Competence as the ISO date the service reads (`AAAA-MM-DD`); `AAAA-MM` becomes the first day.
 * Other spellings are refused here: the service reads ambiguous dates month first.
 */
export function parameterCompetence(competence: string) {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(competence);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3] ?? "1")];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return `${match[1]}-${match[2]}-${String(day).padStart(2, "0")}`;
}

/** Whether a parsed JSON value is also a valid Convex value (field names, nesting). */
function convexValue(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => convexValue(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).every(
    ([key, item]) =>
      /^[\x20-\x7e]+$/.test(key) && !/^[$_]/.test(key) && convexValue(item, depth + 1),
  );
}

/** The body of a parameter read, parsed when it fits the limit, else a cut excerpt. */
export function boundedBody(body: string) {
  const raw = Buffer.from(body, "utf8");
  if (raw.length > PARAMETER_BODY_LIMIT) {
    // A cut inside a multibyte character decodes as U+FFFD; drop it.
    const text = raw.subarray(0, PARAMETER_BODY_LIMIT).toString("utf8").replace(/�+$/u, "");
    return { bytes: raw.length, json: null, text, truncated: true };
  }
  try {
    const json: unknown = JSON.parse(body);
    if (convexValue(json)) return { bytes: raw.length, json, text: null, truncated: false };
  } catch {
    // Not JSON: the text itself, within the limit.
  }
  return { bytes: raw.length, json: null, text: body, truncated: false };
}

const parametersArg = v.object({
  /** `cTribNac` (6 digits, complement `000`) or the full code with the complement (9 digits). */
  serviceCode: v.string(),
  /** `AAAA-MM` or `AAAA-MM-DD`. */
  competence: v.string(),
  /** Number of a municipal benefit (`nBM`) to read; optional. */
  benefitNumber: v.optional(v.string()),
  /** Also read in the ADN of production (`adn.nfse.gov.br`), read only. */
  production: v.optional(v.boolean()),
});

/** GET paths of the ADN parameters API for one municipality, service and competence. */
export function parameterPaths(
  municipality: string,
  parameters: { serviceCode: string; competence: string; benefitNumber?: string },
) {
  const service = parameterServiceCode(parameters.serviceCode);
  const competence = parameterCompetence(parameters.competence);
  const benefit = parameters.benefitNumber;
  if (!service || !competence || (benefit !== undefined && !/^\d{1,14}$/.test(benefit)))
    return null;
  const base = `/parametrizacao/${municipality}`;
  return [
    { query: "aliquota", path: `${base}/${service}/${competence}/aliquota` },
    { query: "historicoaliquotas", path: `${base}/${service}/historicoaliquotas` },
    { query: "regimes_especiais", path: `${base}/${service}/${competence}/regimes_especiais` },
    { query: "retencoes", path: `${base}/${competence}/retencoes` },
    ...(benefit
      ? [{ query: "beneficio", path: `${base}/${benefit}/${competence}/beneficio` }]
      : []),
  ];
}

/**
 * Hosts the probes may reach on the fiscal production deployment, fixed here: the Sefin Nacional
 * of production for the DPS and NFS-e reads, and the ADN of production for the agreement and the
 * municipal parameters. Only GETs, without a body.
 */
export const PRODUCTION_PROBE_HOSTS: readonly string[] = [SEFIN_HOSTS.producao, ADN_HOSTS.producao];
function productionHost(host: string) {
  if (!PRODUCTION_PROBE_HOSTS.includes(host)) throw new ConvexError({ code: "PROBE_HOST_DENIED" });
  return host;
}
const scopeOf = (args: {
  organizationId: Id<"organizations">;
  companyId: Id<"companies">;
  operator: string;
  reason: string;
}) => ({
  organizationId: args.organizationId,
  companyId: args.companyId,
  operator: args.operator,
  reason: args.reason,
});
type Read = { target: string; host: string; outcome: string; httpStatus: number | null };

export const verify = internalAction({
  args: {
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    operator: v.string(),
    reason: v.string(),
    /** IBGE code of the municipality whose agreement is read; Campinas by default. */
    municipalityCode: v.optional(v.string()),
    /** Restricted production only: also read the agreement in the ADN of production. */
    productionAdhesion: v.optional(v.boolean()),
    /** Municipal parameters of a service in a competence; not read unless given. */
    parameters: v.optional(parametersArg),
  },
  returns: probeResult,
  handler: async (ctx, args): Promise<ProbeResult> => {
    const municipality = args.municipalityCode ?? CAMPINAS;
    if (!/^\d{7}$/.test(municipality)) throw new ConvexError({ code: "INVALID_REQUEST" });
    const parameterQueries = args.parameters ? parameterPaths(municipality, args.parameters) : [];
    if (!parameterQueries) throw new ConvexError({ code: "INVALID_REQUEST" });
    const scope = scopeOf(args);
    const answer: Granted | { denied: string } = await ctx.runMutation(
      internal.certificateUse.authorizeProbe,
      { ...scope, kind: "probe" },
    );
    // The refusal is already in the history; the certificate is sealed and usable otherwise.
    if ("denied" in answer) throw new ConvexError({ code: answer.denied });
    const granted = answer;
    const cert = granted.certificate;
    if (!cert.envelope || !cert.metadata)
      throw new ConvexError({ code: "CERTIFICATE_UNAVAILABLE" });
    // On the fiscal production deployment every read goes to production, and only there.
    const production = granted.environment === "producao";
    let material: ReturnType<typeof decryptCertificate> | undefined;
    let result: "success" | "failed" = "failed";
    const reads: Read[] = [];
    try {
      const dpsId = buildDpsId({
        cLocEmi: municipality,
        serie: PROBE_SERIES,
        nDPS: PROBE_NUMBER,
        prest: { cnpj: cert.metadata.cnpj },
      });
      material = decryptCertificate(
        currentCertificateKeyring(),
        { ...cert, id: cert._id },
        cert.envelope,
      );
      const consultations = [];
      const consultTargets = production
        ? [{ id: "sefin-nacional" as const, environment: "producao" as const }]
        : PROBE_TARGETS.map((id) => ({ id, environment: "producao-restrita" as const }));
      for (const target of consultTargets) {
        const host = production
          ? productionHost(resolveEndpoint(target).host)
          : resolveEndpoint(target).host;
        const { transport, state } = probeTransport(`https://${host}`, material);
        const found = await nacional.consultByDps(dpsId, { transport, target });
        consultations.push({
          target: target.id,
          host,
          outcome: found.kind,
          code: "code" in found ? found.code : null,
          httpStatus: found.httpStatus,
          transportError: state.error,
          diagnostic: found.kind === "uncertain" ? found.diagnostic : null,
        });
        reads.push({ target: target.id, host, outcome: found.kind, httpStatus: found.httpStatus });
      }
      const sources = production
        ? [
            {
              source: "adn-producao",
              host: productionHost(ADN_HOSTS.producao),
              path: `/parametrizacao/${municipality}/convenio`,
            },
          ]
        : [
            {
              source: "sefin-producao-restrita",
              host: SEFIN_HOSTS.producaoRestrita,
              path: `/SefinNacional/parametros_municipais/${municipality}/convenio`,
            },
            {
              source: "adn-producao-restrita",
              host: ADN_HOSTS.producaoRestrita,
              path: `/parametrizacao/${municipality}/convenio`,
            },
            ...(args.productionAdhesion
              ? [
                  {
                    source: "adn-producao",
                    host: ADN_HOSTS.producao,
                    path: `/parametrizacao/${municipality}/convenio`,
                  },
                ]
              : []),
          ];
      const adhesionResults = [];
      for (const { source, host, path } of sources) {
        const { transport, state } = probeTransport(`https://${host}`, material);
        try {
          const response = await transport({
            method: "GET",
            url: `https://${host}${path}`,
            headers: { Accept: "application/json" },
          });
          adhesionResults.push({
            source,
            host,
            httpStatus: response.status,
            ...(response.status >= 200 && response.status < 300
              ? adhesionFlags(response.body)
              : { aderenteAmbienteNacional: null, aderenteEmissorNacional: null }),
            code: null,
          });
          reads.push({ target: source, host, outcome: "adhesion", httpStatus: response.status });
        } catch {
          adhesionResults.push({
            source,
            host,
            httpStatus: null,
            aderenteAmbienteNacional: null,
            aderenteEmissorNacional: null,
            code: state.error,
          });
          reads.push({ target: source, host, outcome: state.error ?? "failed", httpStatus: null });
        }
      }
      const parameterHosts = production
        ? [{ source: "adn-producao", host: productionHost(ADN_HOSTS.producao) }]
        : [
            { source: "adn-producao-restrita", host: ADN_HOSTS.producaoRestrita },
            ...(args.parameters?.production
              ? [{ source: "adn-producao", host: ADN_HOSTS.producao }]
              : []),
          ];
      const parameters = [];
      for (const { source, host } of args.parameters ? parameterHosts : []) {
        const { transport, state } = probeTransport(`https://${host}`, material);
        for (const { query, path } of parameterQueries) {
          state.error = null;
          try {
            const response = await transport({
              method: "GET",
              url: `https://${host}${path}`,
              headers: { Accept: "application/json" },
            });
            parameters.push({
              source,
              query,
              host,
              path,
              httpStatus: response.status,
              ...boundedBody(response.body),
              code: null,
            });
            reads.push({
              target: `${source}:${query}`,
              host,
              outcome: "read",
              httpStatus: response.status,
            });
          } catch {
            parameters.push({
              source,
              query,
              host,
              path,
              httpStatus: null,
              bytes: null,
              json: null,
              text: null,
              truncated: false,
              code: state.error,
            });
            reads.push({
              target: `${source}:${query}`,
              host,
              outcome: state.error ?? "failed",
              httpStatus: null,
            });
          }
        }
      }
      result = "success";
      return {
        certificate: { id: cert._id, version: cert.version },
        dpsId,
        consultations,
        adhesion: adhesionResults,
        parameters,
      };
    } finally {
      material?.dispose();
      await ctx.runMutation(internal.certificateUse.completeProbe, {
        organizationId: args.organizationId,
        companyId: args.companyId,
        eventId: granted.eventId,
        certificateId: cert._id,
        version: cert.version,
        result,
        reads,
      });
    }
  },
});

const verifyIssuedResult = v.object({
  issuanceId: v.id("issuances"),
  dpsId: v.string(),
  accessKey: v.string(),
  /** DPS consultation by Id in the Sefin of production. */
  dps: v.object({
    outcome: v.string(),
    httpStatus: v.union(v.number(), v.null()),
    /** Access key the Sefin answered for the DPS Id; null when it answered none. */
    accessKey: v.union(v.string(), v.null()),
    transportError: v.union(v.string(), v.null()),
  }),
  /** NFS-e download by the recorded access key. */
  nfse: v.object({
    outcome: v.string(),
    httpStatus: v.union(v.number(), v.null()),
    /** The NFS-e contains the `infDPS` with the issuance's DPS Id. */
    dpsMatches: v.boolean(),
    transportError: v.union(v.string(), v.null()),
  }),
  /**
   * `true`: a single NFS-e answers for the DPS Id, and it is the recorded one (the DPS
   * consultation found the recorded key and the NFS-e of that key carries this DPS). `false`: the
   * authority answered another key for the Id, or an NFS-e without this DPS. `null`: no such
   * answer either way (not found, transient, unreadable, no response).
   */
  single: v.union(v.boolean(), v.null()),
});

/**
 * Read-only verification of an issuance authorized in production (#198): consults the DPS by its
 * Id and downloads the NFS-e by the recorded access key, both GETs to the Sefin Nacional of
 * production, and records whether a single NFS-e answers for the Id. Only on the fiscal
 * production deployment, for a company in the list; it never signs, submits or changes the
 * issuance. A consultation of the ADN of production by access key is not made: its path could
 * not be confirmed in the official documentation, which opens only with a client certificate.
 */
export const verifyIssued = internalAction({
  args: {
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    issuanceId: v.id("issuances"),
    operator: v.string(),
    reason: v.string(),
  },
  returns: verifyIssuedResult,
  handler: async (ctx, args): Promise<Infer<typeof verifyIssuedResult>> => {
    const scope = scopeOf(args);
    const answer: Granted | { denied: string } = await ctx.runMutation(
      internal.certificateUse.authorizeProbe,
      { ...scope, kind: "verify-issued", issuanceId: args.issuanceId },
    );
    // The refusal is already in the history.
    if ("denied" in answer) throw new ConvexError({ code: answer.denied });
    const granted = answer;
    const cert = granted.certificate;
    if (granted.environment !== "producao" || !granted.issuance || !cert.envelope)
      throw new ConvexError({ code: "ISSUANCE_PROBE_DISABLED" });
    const { dpsId, accessKey } = granted.issuance;
    let material: ReturnType<typeof decryptCertificate> | undefined;
    let result: "success" | "failed" = "failed";
    const reads: Read[] = [];
    let single: boolean | null = null;
    try {
      material = decryptCertificate(
        currentCertificateKeyring(),
        { ...cert, id: cert._id },
        cert.envelope,
      );
      const target = { id: "sefin-nacional" as const, environment: "producao" as const };
      const host = productionHost(resolveEndpoint(target).host);
      const dpsRead = probeTransport(`https://${host}`, material);
      const found = await nacional.consultByDps(dpsId, { transport: dpsRead.transport, target });
      reads.push({ target: "sefin-dps", host, outcome: found.kind, httpStatus: found.httpStatus });
      const nfseRead = probeTransport(`https://${host}`, material);
      const nfse = await nacional.consultByAccessKey(accessKey, {
        transport: nfseRead.transport,
        target,
      });
      reads.push({ target: "sefin-nfse", host, outcome: nfse.kind, httpStatus: nfse.httpStatus });
      const dpsMatches =
        nfse.kind === "found" &&
        new RegExp(`<(?:[\\w.-]+:)?infDPS\\b[^>]*\\sId=["']${dpsId}["']`).test(nfse.nfseXml);
      const answered = found.kind === "found" ? found.chaveAcesso : null;
      // `false` only when the authority answered something else: another key for the DPS Id, or
      // an NFS-e without this DPS. Anything short of two found answers proves nothing (`null`).
      if (
        (found.kind === "found" && answered !== accessKey) ||
        (nfse.kind === "found" && !dpsMatches)
      )
        single = false;
      else if (found.kind === "found" && nfse.kind === "found") single = true;
      // A read without any answer (transport failure) fails the run.
      result = dpsRead.state.error || nfseRead.state.error ? "failed" : "success";
      return {
        issuanceId: granted.issuance.id,
        dpsId,
        accessKey,
        dps: {
          outcome: found.kind,
          httpStatus: found.httpStatus,
          accessKey: answered,
          transportError: dpsRead.state.error,
        },
        nfse: {
          outcome: nfse.kind,
          httpStatus: nfse.httpStatus,
          dpsMatches,
          transportError: nfseRead.state.error,
        },
        single,
      };
    } finally {
      material?.dispose();
      await ctx.runMutation(internal.certificateUse.completeProbe, {
        organizationId: args.organizationId,
        companyId: args.companyId,
        eventId: granted.eventId,
        certificateId: cert._id,
        version: cert.version,
        result,
        reads,
        // Recorded only for a run that got answers; a failed one proves nothing either way.
        ...(result === "success" ? { single } : {}),
      });
    }
  },
});
