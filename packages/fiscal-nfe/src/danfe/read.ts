import { accessKeyDigit, decimal } from "@freecorps/fiscal-core";
import { NFE_NS, decodeXml, dom, fail } from "../xml.js";
import { danfeSituation, type DanfeEvidence, type DanfeStatus } from "./situation.js";

export type { DanfeEvidence, DanfeStatus };

/**
 * Leitura do XML original da NF-e modelo 55 para o DANFE. Nada aqui altera o XML: o leitor
 * extrai texto e confere a forma dos valores; a situação vem de `danfeSituation`.
 */

export interface DanfeParty {
  name: string;
  document: string | null;
  ie: string | null;
  street: string;
  district: string;
  city: string;
  uf: string;
  cep: string | null;
  phone: string | null;
}

export interface DanfeItem {
  number: string;
  code: string;
  description: string;
  extra: string | null;
  ncm: string;
  cst: string;
  cfop: string;
  unit: string;
  quantity: string;
  unitValue: string;
  total: string;
  icms: { base: string | null; rate: string | null; value: string | null };
  ipi: { base: string | null; rate: string | null; value: string | null } | null;
  /** Grupo UB (IBS/CBS) do item, quando existe; alíquotas já escolhidas pela regra do gRed. */
  ibsCbs: {
    cst: string;
    classTrib: string;
    base: string | null;
    rateUf: string | null;
    valueUf: string | null;
    rateMun: string | null;
    valueMun: string | null;
    rateCbs: string | null;
    valueCbs: string | null;
  } | null;
  is: { base: string | null; rate: string | null; value: string | null } | null;
}

export interface DanfeData {
  key: string;
  tpAmb: "1" | "2";
  tpEmis: string;
  tpNF: string;
  series: string;
  number: string;
  natOp: string;
  issuedAt: string;
  movedAt: string | null;
  crt: string | null;
  emitter: DanfeParty & { ieSt: string | null; im: string | null };
  recipient: DanfeParty | null;
  status: DanfeStatus;
  invoice: {
    number: string | null;
    original: string | null;
    discount: string | null;
    net: string | null;
  } | null;
  installments: Array<{ number: string; due: string; value: string }>;
  totals: Record<string, string | null>;
  ibsCbsTotals: Record<string, string | null> | null;
  hasMonophase: boolean;
  issqn: {
    im: string | null;
    services: string | null;
    base: string | null;
    value: string | null;
  } | null;
  transport: {
    modFrete: string;
    carrier: {
      name: string;
      document: string | null;
      ie: string | null;
      address: string;
      city: string;
      uf: string;
    } | null;
    vehicle: { plate: string; uf: string; rntc: string | null } | null;
    volumes: Array<
      Record<"quantity" | "species" | "brand" | "numbering" | "gross" | "net", string | null>
    >;
  };
  items: DanfeItem[];
  additional: { fisco: string | null; complementary: string | null };
}

type Node = Element;

function kids(node: Node | null, name: string): Node[] {
  if (!node) return [];
  return Array.from(node.childNodes).filter(
    (n): n is Element =>
      n.nodeType === 1 &&
      (n as Element).namespaceURI === NFE_NS &&
      (n as Element).localName === name,
  );
}
const one = (node: Node | null, name: string) => kids(node, name)[0] ?? null;
/** Caminho de filhos diretos: `at(det, "imposto", "ICMS")`. */
function at(node: Node | null, ...path: string[]): Node | null {
  let current = node;
  for (const name of path) current = one(current, name);
  return current;
}
function read(node: Node | null, ...path: string[]): string | null {
  const found = at(node, ...path);
  const value = found?.textContent?.trim();
  return value ? value : null;
}
/** Valor decimal: precisa ser texto decimal exato; o erro aponta o campo. */
function amount(node: Node | null, ...path: string[]): string | null {
  const value = read(node, ...path);
  if (value === null) return null;
  try {
    decimal(value);
  } catch {
    return fail("DANFE_XML_INVALID", path.at(-1));
  }
  return value;
}
const firstElement = (node: Node | null) =>
  (node && (Array.from(node.childNodes).find((n) => n.nodeType === 1) as Element | undefined)) ??
  null;

function party(node: Node | null, address: string): DanfeParty | null {
  if (!node) return null;
  const ender = one(node, address);
  const street = [read(ender, "xLgr"), read(ender, "nro"), read(ender, "xCpl")]
    .filter(Boolean)
    .join(", ");
  return {
    name: read(node, "xNome") ?? "",
    document: read(node, "CNPJ") ?? read(node, "CPF") ?? read(node, "idEstrangeiro"),
    ie: read(node, "IE"),
    street,
    district: read(ender, "xBairro") ?? "",
    city: read(ender, "xMun") ?? "",
    uf: read(ender, "UF") ?? "",
    cep: read(ender, "CEP"),
    phone: read(ender, "fone"),
  };
}

/** Raiz do documento auxiliar: aceita `NFe` ou `nfeProc`. */
function parse(xml: string | Uint8Array) {
  const bytes = typeof xml === "string" ? new TextEncoder().encode(xml) : xml;
  return dom(decodeXml(bytes)).documentElement as Element;
}

/** Alíquota do IBS/CBS: a efetiva do gRed quando ele existe (NT 2026.010, 4.3). */
const rtcRate = (group: Node | null, rate: string) =>
  amount(group, "gRed", "pAliqEfet") ?? amount(group, rate);

function item(det: Node): DanfeItem {
  const prod = one(det, "prod");
  const tax = one(det, "imposto");
  const icms = firstElement(one(tax, "ICMS"));
  const ipiTrib = at(tax, "IPI", "IPITrib");
  const ibsCbs = one(tax, "IBSCBS");
  const gIbsCbs = one(ibsCbs, "gIBSCBS");
  const is = one(tax, "IS");
  const orig = read(icms, "orig") ?? "";
  return {
    number: det.getAttribute("nItem") ?? "",
    code: read(prod, "cProd") ?? "",
    description: read(prod, "xProd") ?? "",
    extra: read(det, "infAdProd"),
    ncm: read(prod, "NCM") ?? "",
    cst: orig + (read(icms, "CST") ?? read(icms, "CSOSN") ?? ""),
    cfop: read(prod, "CFOP") ?? "",
    unit: read(prod, "uCom") ?? "",
    quantity: amount(prod, "qCom") ?? "",
    unitValue: amount(prod, "vUnCom") ?? "",
    total: amount(prod, "vProd") ?? "",
    icms: { base: amount(icms, "vBC"), rate: amount(icms, "pICMS"), value: amount(icms, "vICMS") },
    ipi: ipiTrib
      ? {
          base: amount(ipiTrib, "vBC"),
          rate: amount(ipiTrib, "pIPI"),
          value: amount(ipiTrib, "vIPI"),
        }
      : null,
    ibsCbs: ibsCbs
      ? {
          cst: read(ibsCbs, "CST") ?? "",
          classTrib: read(ibsCbs, "cClassTrib") ?? "",
          base: amount(gIbsCbs, "vBC"),
          rateUf: rtcRate(one(gIbsCbs, "gIBSUF"), "pIBSUF"),
          valueUf: amount(gIbsCbs, "gIBSUF", "vIBSUF"),
          rateMun: rtcRate(one(gIbsCbs, "gIBSMun"), "pIBSMun"),
          valueMun: amount(gIbsCbs, "gIBSMun", "vIBSMun"),
          rateCbs: rtcRate(one(gIbsCbs, "gCBS"), "pCBS"),
          valueCbs: amount(gIbsCbs, "gCBS", "vCBS"),
        }
      : null,
    is: is
      ? { base: amount(is, "vBCIS"), rate: amount(is, "pIS"), value: amount(is, "vIS") }
      : null,
  };
}

/** Lê do XML original tudo o que o DANFE mostra e decide a situação pelas evidências. */
export function readNfeForDanfe(xml: string | Uint8Array, evidence: DanfeEvidence = {}): DanfeData {
  const root = parse(xml);
  if (root.namespaceURI !== NFE_NS || !["NFe", "nfeProc"].includes(root.localName ?? ""))
    return fail("DANFE_XML_INVALID", "NFe");
  const nfe = root.localName === "NFe" ? root : one(root, "NFe");
  const inf = one(nfe, "infNFe");
  if (!inf) return fail("DANFE_XML_INVALID", "infNFe");
  const key = /^NFe([0-9]{6}[A-Z0-9]{12}[0-9]{26})$/.exec(inf.getAttribute("Id") ?? "")?.[1];
  if (!key || accessKeyDigit(key.slice(0, 43)) !== key[43]) return fail("DANFE_XML_INVALID", "Id");
  const ide = one(inf, "ide");
  if (read(ide, "mod") !== "55") return fail("DANFE_MODEL_UNSUPPORTED", "mod");
  const tpAmb = read(ide, "tpAmb");
  if (tpAmb !== "1" && tpAmb !== "2") return fail("DANFE_XML_INVALID", "tpAmb");
  const emit = one(inf, "emit");
  const emitter = party(emit, "enderEmit") ?? fail("DANFE_XML_INVALID", "emit");
  const icmsTot = at(inf, "total", "ICMSTot");
  const ibsCbsTot = at(inf, "total", "IBSCBSTot");
  const isTot = at(inf, "total", "ISTot");
  const mono = one(ibsCbsTot, "gMono");
  const issqnTot = at(inf, "total", "ISSQNtot");
  const cobr = one(inf, "cobr");
  const transp = one(inf, "transp");
  const carrier = one(transp, "transporta");
  const vehicle = one(transp, "veicTransp");

  const totals: Record<string, string | null> = {};
  for (const field of [
    "vBC",
    "vICMS",
    "vBCST",
    "vST",
    "vIPI",
    "vFCP",
    "vFCPST",
    "vICMSUFDest",
    "vFCPUFDest",
    "qBCMono",
    "vICMSMono",
    "qBCMonoReten",
    "vICMSMonoReten",
    "vProd",
    "vFrete",
    "vSeg",
    "vDesc",
    "vOutro",
    "vNF",
  ])
    totals[field] = amount(icmsTot, field);

  return {
    key,
    tpAmb,
    tpEmis: read(ide, "tpEmis") ?? "1",
    tpNF: read(ide, "tpNF") ?? "",
    series: read(ide, "serie") ?? "",
    number: read(ide, "nNF") ?? "",
    natOp: read(ide, "natOp") ?? "",
    issuedAt: read(ide, "dhEmi") ?? "",
    movedAt: read(ide, "dhSaiEnt"),
    crt: read(emit, "CRT"),
    emitter: { ...emitter, ieSt: read(emit, "IEST"), im: read(emit, "IM") },
    recipient: party(one(inf, "dest"), "enderDest"),
    status: danfeSituation(xml, evidence),
    invoice: one(cobr, "fat")
      ? {
          number: read(cobr, "fat", "nFat"),
          original: amount(cobr, "fat", "vOrig"),
          discount: amount(cobr, "fat", "vDesc"),
          net: amount(cobr, "fat", "vLiq"),
        }
      : null,
    installments: kids(cobr, "dup").map((dup) => ({
      number: read(dup, "nDup") ?? "",
      due: read(dup, "dVenc") ?? "",
      value: amount(dup, "vDup") ?? "",
    })),
    totals,
    ibsCbsTotals:
      ibsCbsTot || isTot
        ? {
            vCBS: amount(ibsCbsTot, "gCBS", "vCBS"),
            vIBSUF: amount(ibsCbsTot, "gIBS", "gIBSUF", "vIBSUF"),
            vIBSMun: amount(ibsCbsTot, "gIBS", "gIBSMun", "vIBSMun"),
            vIS: amount(isTot, "vIS"),
            vIBSMono: amount(mono, "vIBSMono"),
            vCBSMono: amount(mono, "vCBSMono"),
            vIBSMonoReten: amount(mono, "vIBSMonoReten"),
            vCBSMonoReten: amount(mono, "vCBSMonoReten"),
          }
        : null,
    hasMonophase: mono !== null,
    issqn: issqnTot
      ? {
          im: read(emit, "IM"),
          services: amount(issqnTot, "vServ"),
          base: amount(issqnTot, "vBC"),
          value: amount(issqnTot, "vISS"),
        }
      : null,
    transport: {
      modFrete: read(transp, "modFrete") ?? "",
      carrier: carrier
        ? {
            name: read(carrier, "xNome") ?? "",
            document: read(carrier, "CNPJ") ?? read(carrier, "CPF"),
            ie: read(carrier, "IE"),
            address: read(carrier, "xEnder") ?? "",
            city: read(carrier, "xMun") ?? "",
            uf: read(carrier, "UF") ?? "",
          }
        : null,
      vehicle: vehicle
        ? {
            plate: read(vehicle, "placa") ?? "",
            uf: read(vehicle, "UF") ?? "",
            rntc: read(vehicle, "RNTC"),
          }
        : null,
      volumes: kids(transp, "vol").map((vol) => ({
        quantity: read(vol, "qVol"),
        species: read(vol, "esp"),
        brand: read(vol, "marca"),
        numbering: read(vol, "nVol"),
        gross: amount(vol, "pesoB"),
        net: amount(vol, "pesoL"),
      })),
    },
    items: kids(inf, "det").map(item),
    additional: {
      fisco: read(inf, "infAdic", "infAdFisco"),
      complementary: read(inf, "infAdic", "infCpl"),
    },
  };
}
