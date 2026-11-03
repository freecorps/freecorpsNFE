/**
 * Eventos da NFS-e nacional, pedRegEvento versão 1.00 (aceita pelo
 * `pedRegEvento_v1.01.xsd`). Portado de `convex/engine/events.ts`.
 * Implementado: e101101 (cancelamento por solicitação do emitente). Id do
 * pedido = "PRE" + chave (50) + código do evento. A assinatura enveloped é
 * sobre <infPedReg>, mesmo signer da DPS.
 *
 * Diferença do legado: sem `nPedRegEvento`. O elemento não existe no XSD
 * oficial (1.00 nem 1.01) nem no Anexo II v1.01; o pedido que o levava
 * seria recusado na validação de esquema. O pedido sai validado no XSD.
 */
import { normalizeCnpj } from "@freecorps/fiscal-core";
import { fail } from "./errors.js";
import { NFSE_NS, VER_APLIC_MAX, xsdLength, type BuiltXml } from "./dps.js";
import { assertSchema } from "./schema.js";
import { el } from "./xml.js";

export const EVENTO_CANCELAMENTO = "101101";
export const PED_REG_EVENTO_VERSAO = "1.00";

export interface CancelEventInput {
  tpAmb: 1 | 2;
  verAplic: string;
  dhEvento: string; // ISO 8601 com offset
  cnpjAutor: string; // o emitente
  chNFSe: string; // chave de acesso (50 dígitos)
  cMotivo: "1" | "2" | "9"; // 1 erro na emissão | 2 serviço não prestado | 9 outros
  xMotivo: string; // 15 a 255 caracteres
}

export function buildCancelEvent(input: CancelEventInput): BuiltXml {
  if (input.tpAmb !== 1 && input.tpAmb !== 2) fail("EVENT_FIELD_INVALID", "tpAmb deve ser 1 ou 2.");
  if (typeof input.verAplic !== "string" || input.verAplic.trim() === "")
    fail("EVENT_FIELD_INVALID", "verAplic deve ser informada.");
  if (xsdLength(input.verAplic) > VER_APLIC_MAX)
    fail("EVENT_FIELD_INVALID", `verAplic aceita até ${VER_APLIC_MAX} caracteres.`);
  if (!/^\d{50}$/.test(input.chNFSe)) fail("EVENT_FIELD_INVALID", "chNFSe deve ter 50 dígitos.");
  if (normalizeCnpj(input.cnpjAutor) !== input.cnpjAutor)
    fail("EVENT_FIELD_INVALID", "cnpjAutor não é CNPJ válido.");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(input.dhEvento))
    fail("EVENT_FIELD_INVALID", "dhEvento deve ser data-hora ISO com offset.");
  if (!["1", "2", "9"].includes(input.cMotivo))
    fail("EVENT_FIELD_INVALID", "cMotivo do cancelamento deve ser 1, 2 ou 9.");
  const xMotivo = input.xMotivo.trim();
  if (xMotivo.length < 15 || xMotivo.length > 255)
    fail("EVENT_FIELD_INVALID", "xMotivo do cancelamento deve ter entre 15 e 255 caracteres.");

  const id = `PRE${input.chNFSe}${EVENTO_CANCELAMENTO}`;
  const infPedReg = el(
    "infPedReg",
    [
      el("tpAmb", String(input.tpAmb)),
      el("verAplic", input.verAplic),
      el("dhEvento", input.dhEvento),
      el("CNPJAutor", input.cnpjAutor),
      el("chNFSe", input.chNFSe),
      el("e101101", [
        el("xDesc", "Cancelamento de NFS-e"),
        el("cMotivo", input.cMotivo),
        el("xMotivo", xMotivo),
      ]),
    ],
    { Id: id },
  );
  const xml = el("pedRegEvento", [infPedReg], { xmlns: NFSE_NS, versao: PED_REG_EVENTO_VERSAO });
  assertSchema(xml, "pedRegEvento");
  return { xml, id };
}
