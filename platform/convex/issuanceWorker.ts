"use node";
import { createHash } from "node:crypto";
import {
  MAX_XML_BYTES,
  NfseError,
  buildCancelEvent,
  buildDps,
  dpsUrl,
  gunzipB64,
  gzipB64,
  nacional,
  nfseUrl,
  previousDay,
  ptaxSaleForIssue,
  resolveEndpoint,
  signDps,
  signEvent,
  submitUrl,
  type CancelOutcome,
  type IssueOutcome,
  type NfseEndpoint,
  type NfseQueryContext,
  type NfseTarget,
  type NfseTargetId,
  type NfseTransport,
  type SignerKeys,
} from "@freecorps/fiscal-nfse";
import { renderDanfse, type DanfseMark } from "@freecorps/fiscal-nfse/danfse";
import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { withCertificate } from "./lib/certificateRuntime";
import { certificateRequest } from "./lib/certificateTransport";
import { certificateTlsPem } from "./lib/certificateValidation";
import { dpsInputOf, type FrozenSnapshot } from "./lib/issuanceDps";
import { VER_APLIC } from "./lib/issuanceValues";
import type { Claim } from "./lib/operationCore";
import { claimFields, outcome } from "./lib/operationValues";

/**
 * Executor and reconciler of `documents.issue` and `documents.cancel` (ADR 0004, §3 and §7).
 *
 * - The DPS (and the cancellation request) is built from the frozen snapshot, signed when the
 *   transport is real, and persisted before the first transmission; later attempts send the
 *   persisted text, never a rebuilt one.
 * - `submissions` is incremented before each transmission. When it is above zero, the next
 *   attempt consults the DPS by its Id first and only resends after a 404.
 * - Timeout, interrupted connection, unreadable answer and "DPS já existe" are `uncertain`: the
 *   operation goes to `reconciling` and this module's reconciler consults before anything else.
 */
type Outcome = Infer<typeof outcome>;
/** `mark`: the "SEM VALOR FISCAL" stamp of the DANFSe; only real production goes without it. */
type Io = NfseQueryContext & { signer: SignerKeys | null; mark: DanfseMark | null };

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const claimOf = (args: Claim): Claim => ({
  operationId: args.operationId,
  generation: args.generation,
  fence: args.fence,
});
const CHANGED: Outcome = { kind: "transient", code: "ISSUANCE_CHANGED" };
/** mTLS origins of the fiscal production, fixed here: the Sefin Nacional of production. */
const PRODUCTION_ORIGINS: readonly string[] = ["https://sefin.nfse.gov.br"];
const PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * The simulator speaks the Sefin paths (`/nfse`, `/dps/{id}`, `/nfse/{key}[/eventos]`); a target
 * with other paths (Campinas: `{base}`, `{base}/dps/{id}`, `{base}/{key}`) is mapped back to them.
 */
function simulatedPath(endpoint: NfseEndpoint, url: string): string {
  if (url === submitUrl(endpoint)) return "/nfse";
  const dps = dpsUrl(endpoint, "");
  if (url.startsWith(dps)) return `/dps/${url.slice(dps.length)}`;
  const nfse = nfseUrl(endpoint, "");
  if (url.startsWith(nfse)) return `/nfse/${url.slice(nfse.length)}`;
  throw new Error("SIMULATED_TARGET");
}

/** Synthetic tax authority: the same ADN contract, answered by `issuanceSimulator.exchange`. */
function simulatedTransport(ctx: ActionCtx, claim: Claim, target: NfseTarget): NfseTransport {
  const endpoint = resolveEndpoint(target);
  return async (request) => {
    const path = simulatedPath(endpoint, request.url);
    let xml: string | undefined;
    if (request.body) {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      const packed = body.dpsXmlGZipB64 ?? body.pedidoRegistroEventoXmlGZipB64;
      if (typeof packed === "string") xml = gunzipB64(packed);
    }
    const reply = await ctx.runMutation(internal.issuanceSimulator.exchange, {
      ...claim,
      method: request.method,
      path,
      ...(xml !== undefined ? { xml } : {}),
    });
    if (reply.kind === "lost") throw new Error("SIMULATED_TIMEOUT");
    const body = JSON.parse(reply.json) as Record<string, unknown>;
    if (reply.gzipField && reply.xml !== undefined) body[reply.gzipField] = gzipB64(reply.xml);
    return { status: reply.status, body: JSON.stringify(body), contentType: "application/json" };
  };
}

/** First certificate of a PEM chain: the signer's own certificate. */
function leafPem(chain: string) {
  const match = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(chain);
  if (!match) throw new Error("CERTIFICATE_UNAVAILABLE");
  return `${match[0]}\n`;
}

/**
 * Runs `use` with the transport of the frozen mode. Real modes open the company certificate of
 * the vault once per attempt: the same material signs and authenticates the mTLS calls to the
 * target's own origin only.
 */
async function withIo<T>(
  ctx: ActionCtx,
  claim: Claim,
  mode: string,
  targetId: string,
  use: (io: Io) => Promise<T>,
): Promise<T> {
  if (targetId !== "sefin-nacional" && targetId !== "campinas-adn")
    throw new Error("ISSUANCE_TARGET_INVALID");
  const target: NfseTarget = {
    id: targetId as NfseTargetId,
    environment: mode === "producao" ? "producao" : "producao-restrita",
  };
  if (mode === "simulated")
    return use({
      transport: simulatedTransport(ctx, claim, target),
      target,
      signer: null,
      mark: "simulated",
    });
  if (mode !== "producao-restrita" && mode !== "producao") throw new Error("ISSUANCE_MODE_INVALID");
  const origin = `https://${resolveEndpoint(target).host}`;
  // Checked before the attempt too (`withIoOrWait`); here once more, right before the vault.
  if (!originPinned(mode, targetId)) throw new Error("ISSUANCE_TARGET_INVALID");
  return withCertificate(ctx, claim, async (material) => {
    const pem = certificateTlsPem(material.pfx, material.password);
    let signer: SignerKeys;
    try {
      signer = {
        privateKeyPem: pem.key.toString("utf8"),
        certificatePem: leafPem(pem.cert.toString("utf8")),
      };
    } finally {
      pem.dispose();
    }
    const transport: NfseTransport = async (request) => {
      const response = await certificateRequest(
        {
          url: request.url,
          headers: request.headers,
          ...(request.body !== undefined ? { body: request.body } : {}),
          allowedOrigins: [origin],
          timeoutMs: 30_000,
          maxBytes: 2 * 1024 * 1024,
        },
        material,
      );
      return {
        status: response.status,
        body: response.body.toString("utf8"),
        contentType: response.contentType ?? null,
      };
    };
    return use({
      transport,
      target,
      signer,
      mark: mode === "producao" ? null : "restricted",
    });
  });
}

/**
 * Real production talks to the Sefin Nacional only (ADR 0004 §8, #198), whatever the package
 * resolves: the policy refuses any other target first, and this pins the origin once more.
 */
function originPinned(mode: string, targetId: string) {
  if (mode !== "producao") return true;
  if (targetId !== "sefin-nacional" && targetId !== "campinas-adn") return false;
  const host = resolveEndpoint({ id: targetId as NfseTargetId, environment: "producao" }).host;
  return PRODUCTION_ORIGINS.includes(`https://${host}`);
}

/**
 * The vault refused the certificate before this attempt sent anything. What the attempt becomes is
 * decided in one transaction by `issuanceProcessing.stopIfClosed`, from what the database says:
 * keep reconciling if anything was submitted before, wait if the policy is still open (the
 * certificate itself was refused), and only otherwise stop for good, rejected there.
 */
async function withIoOrWait(
  ctx: ActionCtx,
  claim: Claim,
  prep: { transport: string; target: string },
  task: "issue" | "cancel",
  use: (io: Io) => Promise<Outcome>,
): Promise<Outcome> {
  // The production origin is not the fixed one: refused before the vault and before `use`, so
  // nothing leaves now. The database decides: reconciling if anything was ever sent, otherwise
  // rejected for good.
  if (!originPinned(prep.transport, prep.target)) return stopped(ctx, claim, task, TARGET_INVALID);
  try {
    return await withIo(ctx, claim, prep.transport, prep.target, use);
  } catch (error) {
    if (error instanceof Error && error.message === TARGET_INVALID)
      return stopped(ctx, claim, task, TARGET_INVALID);
    if (!(error instanceof Error) || error.message !== "CERTIFICATE_UNAVAILABLE") throw error;
    return stopped(ctx, claim, task);
  }
}

const TARGET_INVALID = "ISSUANCE_TARGET_INVALID";
/** The outcome of an attempt refused before anything left, from `stopIfClosed`. */
async function stopped(
  ctx: ActionCtx,
  claim: Claim,
  task: "issue" | "cancel",
  code?: string,
): Promise<Outcome> {
  const reason = code ?? "CERTIFICATE_UNAVAILABLE";
  const stop = await ctx.runMutation(internal.issuanceProcessing.stopIfClosed, {
    ...claimOf(claim),
    task,
    ...(code !== undefined ? { code } : {}),
  });
  if (stop === "lost") return CHANGED;
  if (stop === "uncertain") return { kind: "uncertain", code: reason };
  if (stop === "open") return { kind: "transient", code: reason };
  return { kind: "definitive", code: code ?? "ISSUANCE_TRANSPORT_DISABLED" };
}

async function storeXml(ctx: ActionCtx, xml: string) {
  // The caller knows whether the XML is a local request or evidence of a fiscal effect.
  if (Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) return null;
  const storageId = await ctx.storage.store(new Blob([xml], { type: "application/xml" }));
  return { storageId, sha256: sha256(xml), size: Buffer.byteLength(xml, "utf8") };
}
async function loadXml(
  ctx: ActionCtx,
  stored: { storageId: Id<"_storage">; sha256: string },
): Promise<string | null> {
  const blob = await ctx.storage.get(stored.storageId);
  const xml = blob ? await blob.text() : null;
  return xml !== null && sha256(xml) === stored.sha256 ? xml : null;
}

// ---------------------------------------------------------------------------------------------
// PTAX

/** Deterministic sandbox quotation: sale rate of the previous weekday, no network. */
const SIMULATED_RATES: Record<string, string> = {
  USD: "5.432100",
  CAD: "3.987600",
  EUR: "6.012300",
  GBP: "7.123400",
};
function simulatedPtax(currency: string, issueDate: string) {
  let day = previousDay(issueDate);
  while ([0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) day = previousDay(day);
  const rate = SIMULATED_RATES[currency];
  if (!rate) throw new NfseError("PTAX_CURRENCY_INVALID", "Moeda sem cotação simulada.");
  return { rate, quoteDate: day };
}
const OLINDA = "https://olinda.bcb.gov.br/";
/** Public BCB/Olinda API, plain HTTPS without the company certificate. */
const olinda: NfseTransport = async (request) => {
  if (!request.url.startsWith(OLINDA)) throw new Error("PTAX_HOST_DENIED");
  const response = await fetch(request.url, {
    method: "GET",
    headers: request.headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (body.length > 256 * 1024) throw new Error("PTAX_RESPONSE_LIMIT");
  return { status: response.status, body };
};

// ---------------------------------------------------------------------------------------------
// Issue

/**
 * A local XSD failure names the element and the facet that failed: kept as the rejection
 * detail, so the operator sees which field to fix. Other local errors keep their code only.
 */
const schemaDetail = (error: NfseError) =>
  error.code === "DPS_SCHEMA_INVALID" || error.code === "EVENT_SCHEMA_INVALID"
    ? [{ code: null, message: error.message }]
    : [];

async function rejectIssue(
  ctx: ActionCtx,
  claim: Claim,
  code: string,
  rejections: Array<{ code: string | null; message: string; complement?: string | null }>,
): Promise<Outcome> {
  await ctx.runMutation(internal.issuanceProcessing.rejectIssue, {
    ...claim,
    code,
    rejections: rejections.map((item) => ({
      code: item.code,
      message: [item.message, item.complement].filter(Boolean).join(" — "),
    })),
  });
  return { kind: "definitive", code };
}

/**
 * DANFSe of the authorized XML, rendered once and preserved next to it. Best effort: a PDF that
 * cannot be rendered never holds back the authorization; the failure is recorded instead.
 */
async function storeDanfse(ctx: ActionCtx, nfseXml: string, mark: DanfseMark | null) {
  try {
    const pdf = await renderDanfse(nfseXml, mark ? { mark } : {});
    if (pdf.byteLength > 2 * 1024 * 1024) throw new Error("DANFSE_SIZE_LIMIT");
    const storageId = await ctx.storage.store(
      new Blob([Buffer.from(pdf)], { type: "application/pdf" }),
    );
    return {
      danfse: {
        storageId,
        sha256: createHash("sha256").update(pdf).digest("hex"),
        size: pdf.byteLength,
      },
    };
  } catch (error) {
    return { danfseError: error instanceof NfseError ? error.code : "DANFSE_RENDER_FAILED" };
  }
}

async function authorize(
  ctx: ActionCtx,
  claim: Claim,
  io: Io,
  accessKey: string,
  nfseXml: string,
  recoveredByConsult: boolean,
): Promise<Outcome> {
  const stored = await storeXml(ctx, nfseXml);
  if (!stored) return { kind: "uncertain", code: "NFSE_XML_LIMIT" };
  const pdf = await storeDanfse(ctx, nfseXml, io.mark);
  const saved = await ctx.runMutation(internal.issuanceProcessing.recordAuthorization, {
    ...claim,
    ...stored,
    ...pdf,
    accessKey,
    nfseNumber: /<nNFSe>(\d{1,15})<\/nNFSe>/.exec(nfseXml)?.[1] ?? null,
    recoveredByConsult,
  });
  if (!saved) {
    await ctx.storage.delete(stored.storageId);
    if (pdf.danfse) await ctx.storage.delete(pdf.danfse.storageId);
    // The invoice exists at the authority; the next reconciliation finds it again.
    return { kind: "uncertain", code: "ISSUANCE_CHANGED" };
  }
  return { kind: "success", response: JSON.stringify({ accessKey, recoveredByConsult }) };
}

/**
 * Found by the consultation: download the authorized XML by its key (`GET {base}{nfsePath}/{key}`),
 * never send the DPS again. The key comes from the consultation, not from our submission: the IMA
 * once answered a DPS with the key of an invoice of another DPS (`4success/nfse-campinas`,
 * 29/07/2026). Only the invoice that embeds this DPS Id is authorized.
 */
async function recover(
  ctx: ActionCtx,
  claim: Claim,
  io: Io,
  dpsId: string,
  accessKey: string,
): Promise<Outcome> {
  const nfse = await nacional.consultByAccessKey(accessKey, io);
  if (nfse.kind !== "found")
    return {
      kind: "uncertain",
      code: "NFSE_DOWNLOAD_PENDING",
      ...(nfse.kind === "uncertain" ? { diagnostic: nfse.diagnostic } : {}),
    };
  if (!new RegExp(`<(?:[\\w.-]+:)?infDPS\\b[^>]*\\sId=["']${dpsId}["']`).test(nfse.nfseXml))
    return { kind: "uncertain", code: "NFSE_DPS_MISMATCH" };
  return authorize(ctx, claim, io, accessKey, nfse.nfseXml, true);
}

async function settleIssue(ctx: ActionCtx, claim: Claim, io: Io, result: IssueOutcome) {
  if (result.kind === "success")
    return authorize(ctx, claim, io, result.chaveAcesso, result.nfseXml, false);
  if (result.kind === "definitive") return rejectIssue(ctx, claim, result.code, result.rejections);
  if (result.kind === "uncertain" && result.diagnostic)
    return {
      kind: "uncertain",
      code: result.code,
      diagnostic: result.diagnostic,
    } satisfies Outcome;
  return { kind: result.kind, code: result.code } satisfies Outcome;
}

async function runIssue(ctx: ActionCtx, claim: Claim): Promise<Outcome> {
  const prep = await ctx.runMutation(internal.issuanceProcessing.prepareIssue, claim);
  if (!prep) return CHANGED;
  if (prep.state === "rejected") return { kind: "definitive", code: prep.code ?? "ADN_REJECTED" };
  if (prep.state !== "processing") return CHANGED;
  if (prep.accessKey && prep.nfse)
    return { kind: "success", response: JSON.stringify({ accessKey: prep.accessKey }) };
  if (!prep.allowed)
    return prep.submissions > 0
      ? { kind: "uncertain", code: "ISSUANCE_TRANSPORT_DISABLED" }
      : rejectIssue(ctx, claim, "ISSUANCE_TRANSPORT_DISABLED", []);
  const snapshot = JSON.parse(prep.snapshot) as FrozenSnapshot;
  return withIoOrWait(ctx, claim, prep, "issue", async (io) => {
    // Anything that may have reached the authority is consulted before it is sent again. Without
    // the persisted DPS there is nothing to consult nor to resend: a new DPS is never built then.
    if (prep.submissions > 0) {
      if (!prep.dps) return { kind: "uncertain", code: "DPS_UNAVAILABLE" };
      const found = await nacional.consultByDps(prep.dpsId, io);
      if (found.kind === "found") return recover(ctx, claim, io, prep.dpsId, found.chaveAcesso);
      // Only a 404 with the authority's JSON allows the resend; anything else keeps reconciling.
      if (found.kind === "uncertain")
        return { kind: "uncertain", code: found.code, diagnostic: found.diagnostic };
      if (found.kind !== "not-found") return { kind: "uncertain", code: found.code };
      // The resend is a new submission: in production it needs the gate on, which `markSubmitted`
      // decides right before it leaves.
    }
    let brl = snapshot.serviceBrl ?? prep.exchange?.brlAmount ?? null;
    if (brl === null) {
      let quote: { rate: string; quoteDate: string };
      try {
        quote =
          prep.transport === "simulated"
            ? simulatedPtax(snapshot.amount.currency, snapshot.issueDate)
            : await ptaxSaleForIssue(snapshot.amount.currency, snapshot.issueDate, olinda);
      } catch {
        // No quotation, no DPS: nothing left for the authority yet.
        return { kind: "transient", code: "PTAX_UNAVAILABLE" };
      }
      brl = await ctx.runMutation(internal.issuanceProcessing.freezeExchange, {
        ...claim,
        rate: quote.rate,
        quoteDate: quote.quoteDate,
        source: prep.transport === "simulated" ? "simulated" : "ptax-bcb",
      });
      if (brl === null) return CHANGED;
    }
    let xml: string | null;
    if (prep.dps) {
      xml = await loadXml(ctx, prep.dps);
      if (xml === null) return { kind: "uncertain", code: "DPS_UNAVAILABLE" };
    } else {
      let built: ReturnType<typeof buildDps>;
      try {
        built = buildDps(dpsInputOf(snapshot, brl));
        if (built.id !== prep.dpsId)
          throw new NfseError("DPS_ID_MISMATCH", "Id da DPS diverge do número reservado.");
        xml = io.signer
          ? signDps(built, io.signer, resolveEndpoint(io.target).signature)
          : `${PROLOG}${built.xml}`;
      } catch (error) {
        if (error instanceof NfseError)
          return rejectIssue(ctx, claim, error.code, schemaDetail(error));
        throw error;
      }
      const stored = await storeXml(ctx, xml);
      if (!stored) return rejectIssue(ctx, claim, "NFSE_XML_LIMIT", []);
      const saved = await ctx.runMutation(internal.issuanceProcessing.saveDps, {
        ...claim,
        ...stored,
        signed: io.signer !== null,
      });
      if (!saved) {
        await ctx.storage.delete(stored.storageId);
        return CHANGED;
      }
    }
    const mark = await ctx.runMutation(internal.issuanceProcessing.markSubmitted, claim);
    if (mark === "lost") return CHANGED;
    // With the gate off, a resend never leaves: the issuance stays uncertain, consulted again on
    // each attempt, until the gate is on again and the operation is resumed, or someone decides.
    if (mark === "blocked") return { kind: "uncertain", code: "ISSUANCE_RESEND_BLOCKED" };
    if (mark === "rejected") return { kind: "definitive", code: "ISSUANCE_TRANSPORT_DISABLED" };
    const result = await nacional.submitDps({ dpsId: prep.dpsId, signedDpsXml: xml }, io);
    return settleIssue(ctx, claim, io, result);
  });
}

export const issue = internalAction({
  args: { ...claimFields, request: v.string() },
  returns: outcome,
  handler: (ctx, args) => runIssue(ctx, claimOf(args)),
});
/** Same path: with `submissions` above zero it consults by DPS Id before anything else. */
export const reconcileIssue = internalAction({
  args: { ...claimFields, request: v.string() },
  returns: outcome,
  handler: (ctx, args) => runIssue(ctx, claimOf(args)),
});

// ---------------------------------------------------------------------------------------------
// Cancellation

async function rejectCancel(
  ctx: ActionCtx,
  claim: Claim,
  code: string,
  rejections: Array<{ code: string | null; message: string; complement?: string | null }>,
): Promise<Outcome> {
  await ctx.runMutation(internal.issuanceProcessing.rejectCancel, {
    ...claim,
    code,
    rejections: rejections.map((item) => ({
      code: item.code,
      message: [item.message, item.complement].filter(Boolean).join(" — "),
    })),
  });
  return { kind: "definitive", code };
}

async function settleCancel(ctx: ActionCtx, claim: Claim, result: CancelOutcome) {
  if (result.kind === "definitive") return rejectCancel(ctx, claim, result.code, result.rejections);
  if (result.kind !== "success") return { kind: result.kind, code: result.code } satisfies Outcome;
  const event = result.eventXml ? await storeXml(ctx, result.eventXml) : null;
  if (result.eventXml && !event)
    return { kind: "uncertain", code: "NFSE_XML_LIMIT" } satisfies Outcome;
  const saved = await ctx.runMutation(internal.issuanceProcessing.recordCancelEvent, {
    ...claim,
    event,
    alreadyRegistered: result.alreadyRegistered,
  });
  if (!saved) {
    if (event) await ctx.storage.delete(event.storageId);
    return { kind: "uncertain", code: "ISSUANCE_CHANGED" } satisfies Outcome;
  }
  return {
    kind: "success",
    response: JSON.stringify({ alreadyRegistered: result.alreadyRegistered }),
  } satisfies Outcome;
}

/**
 * The event Id is deterministic (`PRE` + access key + `101101`), and the authority answers a
 * repeated event with "evento já registrado", which the adapter reports as success. So the
 * reconciliation of a cancellation resends the persisted request: it cannot register twice.
 */
async function runCancel(ctx: ActionCtx, claim: Claim): Promise<Outcome> {
  const prep = await ctx.runMutation(internal.issuanceProcessing.prepareCancel, claim);
  if (!prep) return CHANGED;
  if (prep.state === "rejected") return { kind: "definitive", code: prep.code ?? "ADN_REJECTED" };
  if (prep.state !== "processing") return CHANGED;
  if (!prep.allowed)
    return prep.submissions > 0
      ? { kind: "uncertain", code: "ISSUANCE_TRANSPORT_DISABLED" }
      : rejectCancel(ctx, claim, "ISSUANCE_TRANSPORT_DISABLED", []);
  const snapshot = JSON.parse(prep.snapshot) as FrozenSnapshot;
  return withIoOrWait(ctx, claim, prep, "cancel", async (io) => {
    let xml: string | null;
    const eventId = `PRE${prep.accessKey}101101`;
    if (prep.event) {
      xml = await loadXml(ctx, prep.event);
      if (xml === null) return { kind: "uncertain", code: "EVENT_UNAVAILABLE" };
    } else {
      try {
        const built = buildCancelEvent({
          tpAmb: snapshot.tpAmb,
          verAplic: VER_APLIC,
          dhEvento: prep.requestedAt,
          cnpjAutor: snapshot.issuer.cnpj,
          chNFSe: prep.accessKey,
          cMotivo: prep.reasonCode as "1" | "2" | "9",
          xMotivo: prep.reason,
        });
        xml = io.signer
          ? signEvent(built, io.signer, resolveEndpoint(io.target).signature)
          : `${PROLOG}${built.xml}`;
      } catch (error) {
        if (error instanceof NfseError)
          return rejectCancel(ctx, claim, error.code, schemaDetail(error));
        throw error;
      }
      const stored = await storeXml(ctx, xml);
      if (!stored) return rejectCancel(ctx, claim, "NFSE_XML_LIMIT", []);
      const saved = await ctx.runMutation(internal.issuanceProcessing.saveCancelEvent, {
        ...claim,
        ...stored,
        signed: io.signer !== null,
      });
      if (!saved) {
        await ctx.storage.delete(stored.storageId);
        return CHANGED;
      }
    }
    const mark = await ctx.runMutation(internal.issuanceProcessing.markCancelSubmitted, claim);
    if (mark === "lost") return CHANGED;
    if (mark === "blocked") return { kind: "uncertain", code: "ISSUANCE_TRANSPORT_DISABLED" };
    if (mark === "rejected") return { kind: "definitive", code: "ISSUANCE_TRANSPORT_DISABLED" };
    const result = await nacional.submitCancelEvent(
      { eventId, chNFSe: prep.accessKey, signedEventXml: xml },
      io,
    );
    return settleCancel(ctx, claim, result);
  });
}

export const cancel = internalAction({
  args: { ...claimFields, request: v.string() },
  returns: outcome,
  handler: (ctx, args) => runCancel(ctx, claimOf(args)),
});
export const reconcileCancel = internalAction({
  args: { ...claimFields, request: v.string() },
  returns: outcome,
  handler: (ctx, args) => runCancel(ctx, claimOf(args)),
});
