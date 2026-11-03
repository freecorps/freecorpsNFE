import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { IssuanceSnapshot } from "./lib/issuanceCore";
import { activeClaim } from "./lib/operationCore";
import { claimFields } from "./lib/operationValues";

/**
 * Synthetic tax authority of the sandbox (transport `simulated`). It speaks the ADN contract
 * through the same adapter as the real one (`nacional.submitDps`, `consultByDps`...), keeps its
 * state per company and environment, and never touches the network. What it authorizes has no
 * fiscal value.
 *
 * Test cases are chosen by markers in the service description (issue) or in the cancellation
 * reason, so a sandbox integration can rehearse each outcome:
 *
 * - `[simular:rejeicao]`: rejection with code `SIM100` (definitive).
 * - `[simular:indisponivel]`: first submission answers 503 (transient), then authorizes.
 * - `[simular:timeout]`: first submission authorizes but the answer is lost (uncertain);
 *   reconciliation finds the invoice without resending.
 * - `[simular:perda]`: first submission is lost before reaching the authority; reconciliation
 *   finds nothing and resends the same DPS.
 * - `[simular:duplicada]`: like `timeout`, but the first consultation still answers 404; the
 *   resend gets "DPS já existe" (uncertain) and the next consultation finds it.
 * - Cancellation `[simular:rejeicao]`: rejection `SIM200`; `[simular:timeout]`: registered, answer
 *   lost. A second cancellation of the same invoice answers "evento já registrado".
 */
const marker = (text: string, name: string) => text.toLowerCase().includes(`[simular:${name}]`);

function checkDigit(digits: string) {
  let sum = 0,
    weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  return rest < 2 ? "0" : String(11 - rest);
}
/**
 * Access key of 50 digits with the layout of the national key: municipality (7), environment
 * (1), registration type (1), CNPJ (14), invoice number (13), year and month (4), code (9) and a
 * check digit. Deterministic for the DPS.
 */
function syntheticKey(dpsId: string, dhEmi: string) {
  const municipality = dpsId.slice(3, 10),
    cnpj = dpsId.slice(11, 25),
    number = dpsId.slice(30).replace(/^0+/, "").padStart(13, "0").slice(-13);
  let hash = 7;
  for (const char of dpsId) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000_000;
  const body = `${municipality}22${cnpj}${number}${dhEmi.slice(2, 4)}${dhEmi.slice(5, 7)}${String(hash).padStart(9, "0")}`;
  return body + checkDigit(body);
}
const escapeXml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
/** `emit` carries the provider's name, as in the real invoice; the DPS has only the CNPJ. */
function syntheticNfse(accessKey: string, dpsXml: string, issuer: { cnpj: string; name: string }) {
  const dps = dpsXml.replace(/^<\?xml[^>]*\?>/, "");
  const dhEmi = /<dhEmi>([^<]+)<\/dhEmi>/.exec(dps)?.[1] ?? "";
  const number = String(Number(accessKey.slice(23, 36)));
  return (
    `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${accessKey}">` +
    `<xLocEmi>Sandbox freecorpsNFE</xLocEmi><nNFSe>${number}</nNFSe><cStat>100</cStat>` +
    `<dhProc>${dhEmi}</dhProc><ambGer>2</ambGer>` +
    `<emit><CNPJ>${issuer.cnpj}</CNPJ><xNome>${escapeXml(issuer.name)}</xNome></emit>` +
    `<xOutInf>NFS-e simulada pelo sandbox da freecorpsNFE, sem validade fiscal.</xOutInf>` +
    `${dps}</infNFSe></NFSe>`
  );
}
function syntheticEvent(accessKey: string, requestXml: string) {
  const request = requestXml.replace(/^<\?xml[^>]*\?>/, "");
  return (
    `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infEvento Id="EVT${accessKey}101101001">` +
    `<xLocEmi>Sandbox freecorpsNFE</xLocEmi><cStat>135</cStat>` +
    `<xMotivo>Evento simulado pelo sandbox da freecorpsNFE, sem validade fiscal.</xMotivo>` +
    `${request}</infEvento></evento>`
  );
}

const reply = v.union(
  v.object({ kind: v.literal("lost") }),
  v.object({
    kind: v.literal("reply"),
    status: v.number(),
    json: v.string(),
    gzipField: v.optional(v.string()),
    xml: v.optional(v.string()),
  }),
);
const json = (status: number, body: unknown, gzip?: { field: string; xml: string }) => ({
  kind: "reply" as const,
  status,
  json: JSON.stringify(body),
  ...(gzip ? { gzipField: gzip.field, xml: gzip.xml } : {}),
});
/**
 * Absence of a DPS or invoice, with the envelope of the national standard: only this 404 lets the
 * adapter conclude `not-found` and resend. An unknown path answers a bare 404, which is
 * inconclusive, as a missing route of a real authority.
 */
const absent = () => json(404, { tipoAmbiente: 2, versaoAplicativo: "sandbox-freecorpsNFE" });
const rejection = (code: string, message: string) => ({
  erros: [{ codigo: code, mensagem: message, complemento: null }],
});

async function context(ctx: MutationCtx, op: Doc<"operations">) {
  if (op.task.name === "documents.issue") {
    const issuance = await ctx.db
      .query("issuances")
      .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
      .unique();
    return issuance ? { issuance, cancellation: null } : null;
  }
  const cancellation = await ctx.db
    .query("issuanceCancellations")
    .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
    .unique();
  const issuance = cancellation ? await ctx.db.get("issuances", cancellation.issuanceId) : null;
  return issuance && cancellation ? { issuance, cancellation } : null;
}
async function stateOf(ctx: MutationCtx, op: Doc<"operations">, dpsId: string) {
  return ctx.db
    .query("issuanceSimulations")
    .withIndex("by_companyId_and_environment_and_dpsId", (q) =>
      q.eq("companyId", op.companyId).eq("environment", op.environment).eq("dpsId", dpsId),
    )
    .unique();
}

export const exchange = internalMutation({
  args: {
    ...claimFields,
    method: v.union(v.literal("GET"), v.literal("POST")),
    path: v.string(),
    xml: v.optional(v.string()),
  },
  returns: reply,
  handler: async (ctx, { method, path, xml, ...claim }) => {
    const op = await activeClaim(ctx, claim);
    const found = op ? await context(ctx, op) : null;
    // Only the claimed operation of a simulated sandbox issuance reaches the simulator.
    if (!op || !found || op.environment !== "sandbox" || found.issuance.transport !== "simulated")
      return { kind: "lost" as const };
    const { issuance, cancellation } = found;
    const snapshot = JSON.parse(issuance.snapshot) as IssuanceSnapshot;
    const description = snapshot.description;
    if (method === "POST" && path === "/nfse") {
      const dpsId = /Id="(DPS\d{7}\d[0-9A-Z]{14}\d{20})"/.exec(xml ?? "")?.[1];
      const dhEmi = /<dhEmi>([^<]+)<\/dhEmi>/.exec(xml ?? "")?.[1];
      if (!xml || !dpsId || !dhEmi) return json(400, rejection("SIM001", "DPS ilegível."));
      // The simulated authority only knows DPS of this issuance: no cross-tenant echo.
      if (dpsId !== issuance.dpsId) return json(400, rejection("SIM002", "DPS de outra emissão."));
      const state = await stateOf(ctx, op, dpsId);
      const posts = (state?.posts ?? 0) + 1;
      if (state?.accessKey) {
        await ctx.db.patch("issuanceSimulations", state._id, { posts });
        return json(400, rejection("E0014", "Já existe NFS-e emitida para esta DPS."));
      }
      const first = posts === 1;
      const authorize = async (lag = 0) => {
        const accessKey = syntheticKey(dpsId, dhEmi);
        const fields = {
          posts,
          lag,
          accessKey,
          nfseXml: syntheticNfse(accessKey, xml, snapshot.issuer),
        };
        if (state) await ctx.db.patch("issuanceSimulations", state._id, fields);
        else
          await ctx.db.insert("issuanceSimulations", {
            organizationId: op.organizationId,
            companyId: op.companyId,
            environment: op.environment,
            dpsId,
            cancelled: false,
            eventPosts: 0,
            ...fields,
          });
        return fields;
      };
      const count = async () => {
        if (state) await ctx.db.patch("issuanceSimulations", state._id, { posts });
        else
          await ctx.db.insert("issuanceSimulations", {
            organizationId: op.organizationId,
            companyId: op.companyId,
            environment: op.environment,
            dpsId,
            posts,
            lag: 0,
            cancelled: false,
            eventPosts: 0,
          });
      };
      if (marker(description, "rejeicao")) {
        await count();
        return json(
          400,
          rejection(
            "SIM100",
            "Rejeição simulada pelo sandbox: a descrição pediu [simular:rejeicao].",
          ),
        );
      }
      if (first && marker(description, "indisponivel")) {
        await count();
        return json(503, {});
      }
      if (first && marker(description, "perda")) {
        await count();
        return { kind: "lost" as const };
      }
      if (first && (marker(description, "timeout") || marker(description, "duplicada"))) {
        await authorize(marker(description, "duplicada") ? 1 : 0);
        return { kind: "lost" as const };
      }
      const issued = await authorize();
      return json(
        201,
        { chaveAcesso: issued.accessKey, idDps: dpsId },
        { field: "nfseXmlGZipB64", xml: issued.nfseXml },
      );
    }
    const dps = /^\/dps\/(DPS\d{7}\d[0-9A-Z]{14}\d{20})$/.exec(path);
    if (method === "GET" && dps) {
      const state = dps[1] === issuance.dpsId ? await stateOf(ctx, op, dps[1]!) : null;
      if (state && state.lag > 0) {
        await ctx.db.patch("issuanceSimulations", state._id, { lag: state.lag - 1 });
        return absent();
      }
      return state?.accessKey ? json(200, { chaveAcesso: state.accessKey }) : absent();
    }
    const nfse = /^\/nfse\/(\d{50})(\/eventos)?$/.exec(path);
    // Before the platform records the key (recovery), the issuance only knows its own DPS.
    const state = nfse ? await stateOf(ctx, op, issuance.dpsId) : null;
    if (nfse && !nfse[2] && method === "GET")
      return state?.accessKey === nfse[1]
        ? json(
            200,
            { chaveAcesso: state.accessKey },
            { field: "nfseXmlGZipB64", xml: state.nfseXml! },
          )
        : absent();
    if (nfse && nfse[2] && method === "POST" && cancellation) {
      if (state?.accessKey !== nfse[1] || !xml)
        return json(400, rejection("E0002", "NFS-e não encontrada para o evento."));
      if (state.cancelled)
        return json(
          400,
          rejection("E0840", "Evento de cancelamento já registrado para esta NFS-e."),
        );
      const eventPosts = state.eventPosts + 1;
      if (marker(cancellation.reason, "rejeicao")) {
        await ctx.db.patch("issuanceSimulations", state._id, { eventPosts });
        return json(
          400,
          rejection(
            "SIM200",
            "Cancelamento rejeitado pelo sandbox: o motivo pediu [simular:rejeicao].",
          ),
        );
      }
      await ctx.db.patch("issuanceSimulations", state._id, { eventPosts, cancelled: true });
      if (eventPosts === 1 && marker(cancellation.reason, "timeout"))
        return { kind: "lost" as const };
      return json(201, {}, { field: "eventoXmlGZipB64", xml: syntheticEvent(nfse[1]!, xml) });
    }
    return json(404, {});
  },
});
