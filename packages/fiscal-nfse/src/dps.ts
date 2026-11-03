/**
 * DPS (Declaração de Prestação de Serviço), leiaute nacional 1.01.
 * Portado de `convex/engine/dps.ts` (legado congelado). A ORDEM dos elementos
 * é validada pelo XSD: a sequência abaixo é normativa, não estilo. Este módulo
 * não carrega o XSD (`/pure` e `/danfse` dependem dele); `buildDps`, em
 * `build.ts`, monta por `assembleDps` e confere o resultado no XSD oficial.
 * Armadilhas conhecidas: E1235 (endereço do tomador), E0166 (regApTribSN),
 * E0625 (alíquota no Simples), E0120 (IM do prestador, só quando informada),
 * E0015 (dCompet no futuro), E1229 (prolog dentro do elemento assinado).
 *
 * Exportação de serviço: tomador no exterior com NIF (ou cNaoNIF), endereço
 * em <endExt>, tribISSQN=3 + cPaisResult e grupo <comExt>.
 *
 * Diferença deliberada do legado: valores e alíquota chegam como texto
 * decimal exato (`"67.60"`, `"2"`), nunca centavos inteiros nem float. Casas
 * além da escala do leiaute são recusadas em vez de arredondadas.
 */
import { normalizeCnpj } from "@freecorps/fiscal-core";
import { isCalendarDate } from "./dates.js";
import { fail } from "./errors.js";
import { fixed, money } from "./decimal.js";
import { el, opt, type XmlNode } from "./xml.js";

export const NFSE_NS = "http://www.sped.fazenda.gov.br/nfse";
export const DPS_VERSAO = "1.01";

/**
 * Pacote de XSD cujo leiaute a DPS segue. O de produção é o v1.01-20260209 da
 * Documentação Atual. A produção restrita publicou em 20/10/2026 o leiaute da
 * NT 009 (`finNFSe` em `infDPS`, `xDescServ` depois de `cNBS`, `CST` e
 * `cClassTrib` direto em `IBSCBS/valores/trib`) e recusa o anterior com E1235
 * (prova de 02/11/2026, #197). Quem monta escolhe pelo ambiente de destino.
 */
export const DPS_LAYOUTS = ["nfse-1.01-20260209", "nfse-1.01-prodrest-20261020"] as const;
export type DpsLayout = (typeof DPS_LAYOUTS)[number];
export const DPS_LAYOUT_DEFAULT: DpsLayout = "nfse-1.01-20260209";
const TP_INSC_CNPJ = "2";

/** Tomador nacional (endereço em <endNac>). */
export interface TomaNacional {
  tipo: "CPF" | "CNPJ";
  cpfCnpj: string;
  xNome: string;
  cMun: string; // IBGE do tomador
  cep: string; // 8 dígitos
  xLgr: string;
  nro: string;
  xBairro: string;
  email?: string;
}

/**
 * Tomador no exterior (endereço em <endExt>): exportação de serviço. No XSD
 * (TCEnderExt e TCEndereco) todo o endereço é obrigatório: código postal,
 * cidade, estado/província/região, logradouro, número e bairro.
 */
export interface TomaExterior {
  tipo: "NIF" | "semNIF";
  nif?: string; // obrigatório quando tipo="NIF"
  cNaoNIF?: 1 | 2; // 1 = dispensado do NIF; 2 = não exigência (padrão em tipo="semNIF")
  xNome: string;
  cPais: string; // ISO 3166-1 alpha-2 (ex.: "CA")
  cEndPost: string; // até 11
  xCidade: string; // até 60
  xEstProvReg: string; // até 60
  xLgr: string; // até 255
  nro: string; // até 60
  xBairro: string; // até 60; sem bairro no endereço, a região ou distrito
  email?: string;
}

export type DpsToma = TomaNacional | TomaExterior;

export const isTomaExterior = (t: DpsToma): t is TomaExterior =>
  t.tipo === "NIF" || t.tipo === "semNIF";

/** Grupo <comExt>, obrigatório quando o tomador está no exterior. */
export interface ComExt {
  mdPrestacao: number; // 1 = transfronteiriço (consumido no exterior)
  vincPrest: number; // 0 = sem vínculo entre prestador e tomador
  tpMoeda: string; // código BACEN da moeda (ver BACEN_CURRENCY)
  vServMoeda: string; // valor na moeda original, decimal em texto (2 casas)
  mecAFComexP: string; // "01" = nenhum mecanismo de apoio (prestador)
  mecAFComexT: string; // "01" = nenhum (tomador)
  movTempBens: number; // 1 = não há movimentação temporária de bens
  mdic: number; // 0 = não enquadrado
}

export const COM_EXT_DEFAULTS: Omit<ComExt, "tpMoeda" | "vServMoeda"> = {
  mdPrestacao: 1,
  vincPrest: 0,
  mecAFComexP: "01",
  mecAFComexT: "01",
  movTempBens: 1,
  mdic: 0,
};

/** Códigos BACEN das moedas já faturadas pelo legado. */
export const BACEN_CURRENCY: Readonly<Record<string, string>> = {
  USD: "220",
  CAD: "165",
  EUR: "978",
  GBP: "540",
};

export interface DpsInput {
  /** Leiaute (pacote de XSD); ausente, o de produção. */
  layout?: DpsLayout;
  tpAmb: 1 | 2; // 1 = produção; 2 = produção restrita
  dhEmi: string; // ISO 8601 com offset, ex. 2026-08-29T10:00:00-03:00
  verAplic: string;
  serie: number;
  nDPS: number;
  dCompet: string; // YYYY-MM-DD, nunca posterior à data de dhEmi (E0015)
  cLocEmi: string; // IBGE 7 dígitos do município do emitente

  /** Substituição de NFS-e: nova DPS vinculada à chave da nota substituída. */
  subst?: {
    chSubstda: string; // chave de acesso (50 díg.) da NFS-e substituída
    cMotivo: string; // "01" erro na emissão | "02" serviço não prestado | "99" outros
    xMotivo?: string; // obrigatório quando cMotivo="99"
  };

  prest: {
    cnpj: string; // 14 caracteres
    /**
     * Inscrição municipal (TSInscMun, 1 a 15 caracteres). Opcional: pela E0120, só vai
     * quando o contribuinte tem cadastro complementar no CNC do município emissor; quem
     * monta decide (a plataforma só a manda à IMA/Campinas).
     */
    im?: string;
    email: string;
    opSimpNac: number; // 1 = não optante; 2 = MEI; 3 = ME/EPP
    regApTribSN?: number; // 1 = federal+municipal pelo SN (só para opSimpNac=3; E0166)
    regEspTrib: number; // 0 = nenhum
  };

  toma: DpsToma;
  /**
   * Grupo <dest> do XSD 1.01: filho de <IBSCBS>, depois de `indDest`. Só existe
   * com `ibsCbs.indDest = 1` (destinatário diferente do tomador, regra E0910);
   * com `indDest = 0` o destinatário é o próprio tomador e o grupo fica de fora.
   */
  dest?: DpsToma;

  serv: {
    cLocPrestacao: string;
    cTribNac: string; // código nacional de 6 dígitos
    cTribMun?: string; // código municipal (Campinas exige)
    xDescServ: string;
    cNBS?: string; // NBS 9 dígitos (Campinas exige)
    comExt?: ComExt;
  };

  valores: {
    vServ: string; // BRL, decimal em texto
    // 1 = tributável | 2 = imunidade | 3 = exportação | 4 = não incidência
    tribISSQN: 1 | 2 | 3 | 4;
    cPaisResult?: string; // obrigatório quando tribISSQN=3 (ISO alpha-2)
    tpRetISSQN: number; // 1 = não retido
    // % ISS em texto; TSDec1V2: até 2 casas (nacional omite no Simples, E0625).
    // A DPS 1.01 não tem cLocIncid: o local de incidência é calculado pelo fisco.
    pAliq?: string;
    vTotTribFed: string;
    vTotTribEst: string;
    vTotTribMun: string;
  };

  /**
   * Grupo IBSCBS (NT 005/2025), último filho de infDPS. Obrigatório pelas datas
   * de `ibsCbsRequirement` (Ato Conjunto RFB/CGIBS 4/2026); a IMA/Campinas o
   * exige sempre. Domínios de cIndOp e cClassTrib vêm de tabela oficial externa.
   */
  ibsCbs?: {
    finNFSe: number; // 0 = NFS-e regular; no leiaute da NT 009 vai em infDPS
    cIndOp: string;
    indDest: 0 | 1; // 0 = destinatário é o tomador; 1 = outro, informado em `dest`
    cst: string;
    cClassTrib: string;
  };
}

export interface BuiltXml {
  /** XML sem prolog e sem assinatura. */
  xml: string;
  /** Valor do atributo Id do elemento a assinar. */
  id: string;
}

const digits = (value: string, length: number, field: string) => {
  if (!new RegExp(`^\\d{${length}}$`).test(value))
    fail("DPS_FIELD_INVALID", `${field} deve ter ${length} dígitos.`);
  return value;
};

const integer = (value: number, min: number, max: number, field: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail("DPS_FIELD_INVALID", `${field} deve ser inteiro entre ${min} e ${max}.`);
  return String(value);
};

/** Tamanho como o XSD conta (caracteres, não unidades UTF-16): um par substituto vale 1. */
export const xsdLength = (value: string) =>
  value.length - (value.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);

/** Texto obrigatório; `max` é o maxLength do XSD. */
const text = (value: string | undefined, field: string, max?: number) => {
  if (typeof value !== "string" || value.trim() === "")
    return fail("DPS_FIELD_INVALID", `${field} não pode ser vazio.`);
  if (max !== undefined && xsdLength(value) > max)
    fail("DPS_FIELD_INVALID", `${field} aceita até ${max} caracteres.`);
  return value;
};

/** Tamanho máximo da inscrição municipal do prestador (TSInscMun). */
const IM_MAX = 15;

/** Tamanho máximo de `verAplic` (TSVerAplic), na DPS e no pedido de evento. */
export const VER_APLIC_MAX = 20;

const cnpj = (value: string, field: string) =>
  normalizeCnpj(value) === value ? value : fail("DPS_FIELD_INVALID", `${field} não é CNPJ válido.`);

const DH_EMI = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

/** "DPS" + cLocEmi(7) + tpInsc(1) + CNPJ(14) + serie(5) + nDPS(15) = 45 caracteres. */
export function buildDpsId(input: {
  cLocEmi: string;
  serie: number;
  nDPS: number;
  prest: { cnpj: string };
}): string {
  return (
    "DPS" +
    digits(input.cLocEmi, 7, "cLocEmi") +
    TP_INSC_CNPJ +
    cnpj(input.prest.cnpj, "prest.cnpj") +
    integer(input.serie, 1, 99_999, "serie").padStart(5, "0") +
    integer(input.nDPS, 1, 999_999_999_999_999, "nDPS").padStart(15, "0")
  );
}

function party(tag: "toma" | "dest", p: DpsToma): XmlNode {
  if (isTomaExterior(p)) {
    let identity: XmlNode;
    if (p.tipo === "NIF") {
      if (!p.nif) return fail("DPS_FIELD_INVALID", `${tag}: tomador NIF sem o número do NIF.`);
      identity = el("NIF", p.nif);
    } else identity = el("cNaoNIF", String(p.cNaoNIF ?? 2));
    if (!/^[A-Z]{2}$/.test(p.cPais))
      fail("DPS_FIELD_INVALID", `${tag}.cPais deve ser código ISO de 2 letras.`);
    return el(tag, [
      identity,
      el("xNome", text(p.xNome, `${tag}.xNome`)),
      el("end", [
        el("endExt", [
          el("cPais", p.cPais),
          el("cEndPost", text(p.cEndPost, `${tag}.cEndPost`, 11)),
          el("xCidade", text(p.xCidade, `${tag}.xCidade`, 60)),
          el("xEstProvReg", text(p.xEstProvReg, `${tag}.xEstProvReg`, 60)),
        ]),
        // Logradouro é IRMÃO de endExt dentro de <end>, como no endNac (E1235), e
        // obrigatório também no exterior (TCEndereco): xLgr, nro, [xCpl], xBairro.
        ...address(tag, p),
      ]),
      opt("email", p.email),
    ]);
  }
  if (p.tipo === "CNPJ") cnpj(p.cpfCnpj, `${tag}.CNPJ`);
  else digits(p.cpfCnpj, 11, `${tag}.CPF`);
  return el(tag, [
    el(p.tipo, p.cpfCnpj),
    el("xNome", text(p.xNome, `${tag}.xNome`)),
    el("end", [
      el("endNac", [
        el("cMun", digits(p.cMun, 7, `${tag}.cMun`)),
        el("CEP", digits(p.cep, 8, `${tag}.CEP`)),
      ]),
      // xLgr/nro/xBairro são filhos de <end>, IRMÃOS de <endNac> (E1235).
      ...address(tag, p),
    ]),
    opt("email", p.email),
  ]);
}

/** Fim de TCEndereco, igual para endNac e endExt. */
function address(tag: string, p: { xLgr: string; nro: string; xBairro: string }): XmlNode[] {
  return [
    el("xLgr", text(p.xLgr, `${tag}.xLgr`, 255)),
    el("nro", text(p.nro, `${tag}.nro`, 60)),
    el("xBairro", text(p.xBairro, `${tag}.xBairro`, 60)),
  ];
}

/** Monta a DPS sem assinatura e sem validar no XSD. Mesma entrada, mesmos bytes. */
export function assembleDps(input: DpsInput): BuiltXml {
  const id = buildDpsId(input);
  const emission = DH_EMI.exec(input.dhEmi);
  if (!emission || !isCalendarDate(emission[1]!))
    return fail("DPS_FIELD_INVALID", "dhEmi deve ser data-hora ISO com offset.");
  if (input.tpAmb !== 1 && input.tpAmb !== 2) fail("DPS_FIELD_INVALID", "tpAmb deve ser 1 ou 2.");
  if (!isCalendarDate(input.dCompet))
    fail("DPS_FIELD_INVALID", "dCompet deve ser AAAA-MM-DD válida.");
  if (input.dCompet > emission[1]!)
    fail("DPS_COMPETENCE_FUTURE", "dCompet não pode ser posterior à data de emissão (E0015).");
  const { valores: v, serv: s } = input;
  if (v.tribISSQN === 3 && !v.cPaisResult)
    fail("DPS_EXPORT_COUNTRY", "Exportação (tribISSQN=3) exige cPaisResult.");
  if (v.cPaisResult !== undefined && !/^[A-Z]{2}$/.test(v.cPaisResult))
    fail("DPS_FIELD_INVALID", "valores.cPaisResult deve ser código ISO de 2 letras.");
  if (isTomaExterior(input.toma) && !s.comExt)
    fail("DPS_EXPORT_COMEXT", "Tomador no exterior exige o grupo comExt.");
  if (input.subst?.cMotivo === "99" && !input.subst.xMotivo)
    fail("DPS_FIELD_INVALID", "Substituição com cMotivo 99 exige xMotivo.");
  // O destinatário só é identificado quando difere do tomador (E0910).
  if (input.dest && input.ibsCbs?.indDest !== 1)
    fail("DPS_FIELD_INVALID", "dest só é informado com ibsCbs.indDest 1 (E0910).");
  if (input.ibsCbs?.indDest === 1 && !input.dest)
    fail("DPS_FIELD_INVALID", "ibsCbs.indDest 1 exige o grupo dest.");

  const layout = input.layout ?? DPS_LAYOUT_DEFAULT;
  if (!DPS_LAYOUTS.includes(layout)) fail("DPS_FIELD_INVALID", "layout de DPS desconhecido.");
  const nt009 = layout === "nfse-1.01-prodrest-20261020";
  const c = s.comExt;
  const g = input.ibsCbs;
  const xDescServ = el("xDescServ", text(s.xDescServ, "serv.xDescServ"));
  const infDps = el(
    "infDPS",
    [
      el("tpAmb", String(input.tpAmb)),
      el("dhEmi", input.dhEmi),
      el("verAplic", text(input.verAplic, "verAplic", VER_APLIC_MAX)),
      el("serie", String(input.serie)),
      el("nDPS", String(input.nDPS)),
      el("dCompet", input.dCompet),
      el("tpEmit", "1"),
      // NT 009: a finalidade sai de IBSCBS e vem antes de cLocEmi, sempre informada.
      nt009 ? el("finNFSe", String(g?.finNFSe ?? 0)) : undefined,
      el("cLocEmi", input.cLocEmi),
      input.subst &&
        el("subst", [
          el("chSubstda", digits(input.subst.chSubstda, 50, "subst.chSubstda")),
          el("cMotivo", input.subst.cMotivo),
          opt("xMotivo", input.subst.xMotivo),
        ]),
      el("prest", [
        el("CNPJ", input.prest.cnpj),
        // <IM> entre CNPJ e email (TCInfoPrestador); ausente quando não informada (E0120).
        input.prest.im === undefined
          ? undefined
          : el("IM", text(input.prest.im, "prest.im", IM_MAX)),
        el("email", text(input.prest.email, "prest.email")),
        el("regTrib", [
          el("opSimpNac", String(input.prest.opSimpNac)),
          input.prest.regApTribSN === undefined
            ? undefined
            : el("regApTribSN", String(input.prest.regApTribSN)),
          el("regEspTrib", String(input.prest.regEspTrib)),
        ]),
      ]),
      party("toma", input.toma),
      el("serv", [
        el("locPrest", [el("cLocPrestacao", digits(s.cLocPrestacao, 7, "serv.cLocPrestacao"))]),
        el("cServ", [
          el("cTribNac", digits(s.cTribNac, 6, "serv.cTribNac")),
          opt("cTribMun", s.cTribMun),
          nt009 ? undefined : xDescServ,
          opt("cNBS", s.cNBS),
          nt009 ? xDescServ : undefined,
        ]),
        c &&
          el("comExt", [
            el("mdPrestacao", String(c.mdPrestacao)),
            el("vincPrest", String(c.vincPrest)),
            el("tpMoeda", digits(c.tpMoeda, 3, "comExt.tpMoeda")),
            el("vServMoeda", money(c.vServMoeda, "comExt.vServMoeda")),
            el("mecAFComexP", c.mecAFComexP),
            el("mecAFComexT", c.mecAFComexT),
            el("movTempBens", String(c.movTempBens)),
            el("mdic", String(c.mdic)),
          ]),
      ]),
      el("valores", [
        el("vServPrest", [el("vServ", money(v.vServ, "valores.vServ"))]),
        el("trib", [
          el("tribMun", [
            el("tribISSQN", String(v.tribISSQN)),
            v.tribISSQN === 3 ? el("cPaisResult", v.cPaisResult!) : undefined,
            el("tpRetISSQN", String(v.tpRetISSQN)),
            // TCTribMunicipal: pAliq vem DEPOIS de tpRetISSQN, com 2 casas. O legado
            // invertia a ordem e usava 4 casas pelo homolog antigo da IMA, que não
            // validava o XSD; o endpoint atual valida (L9999).
            v.pAliq === undefined ? undefined : el("pAliq", fixed(v.pAliq, 2, "valores.pAliq")),
          ]),
          el("totTrib", [
            el("vTotTrib", [
              el("vTotTribFed", money(v.vTotTribFed, "valores.vTotTribFed")),
              el("vTotTribEst", money(v.vTotTribEst, "valores.vTotTribEst")),
              el("vTotTribMun", money(v.vTotTribMun, "valores.vTotTribMun")),
            ]),
          ]),
        ]),
      ]),
      g &&
        el("IBSCBS", [
          nt009 ? undefined : el("finNFSe", String(g.finNFSe)),
          el("cIndOp", g.cIndOp),
          el("indDest", String(g.indDest)),
          input.dest && party("dest", input.dest),
          el("valores", [
            el(
              "trib",
              nt009
                ? [el("CST", g.cst), el("cClassTrib", g.cClassTrib)]
                : [el("gIBSCBS", [el("CST", g.cst), el("cClassTrib", g.cClassTrib)])],
            ),
          ]),
        ]),
    ],
    { Id: id },
  );
  return { xml: el("DPS", [infDps], { xmlns: NFSE_NS, versao: DPS_VERSAO }), id };
}

const BRASILIA_OFFSET_MS = 3 * 3600 * 1000;

/** Data-hora em Brasília (-03:00 fixo; sem horário de verão desde 2019). `now` é obrigatório. */
export function dhBrasilia(now: Date): string {
  return new Date(now.getTime() - BRASILIA_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

/** Data civil em Brasília, AAAA-MM-DD. */
export function hojeBrasilia(now: Date): string {
  return new Date(now.getTime() - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Competência: último dia do mês (1 a 12), AAAA-MM-DD. */
export function competencia(year: number, month: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12)
    fail("DPS_FIELD_INVALID", "Competência exige ano inteiro e mês entre 1 e 12.");
  const d = new Date(Date.UTC(year, month, 0));
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
