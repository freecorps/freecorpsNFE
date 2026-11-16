/**
 * DANFSe em PDF, gerado a partir do XML da NFS-e autorizada, no modelo da Nota Técnica
 * SE/CGNFS-e nº 008, versão 1.02, de 14/07/2026 ("Especificações Técnicas do DANFSe",
 * DANFSe v2.0). A API nacional do DANFSe foi suspensa em 03/08/2026; desde então o emissor gera
 * o documento auxiliar.
 *
 * O PDF segue o Anexo I da NT: página A4 única, em retrato, com os blocos na ordem do modelo
 * (cabeçalho, dados da NFS-e com o QR de consulta, prestador, tomador, destinatário,
 * intermediário, serviço, tributação municipal, federal e IBS/CBS, valor total e informações
 * complementares), rótulos e descrições da norma, traço (-) no campo sem informação no XML
 * (nota 12) e reticências no texto que não cabe. Divergências deliberadas, registradas no README
 * do pacote: Helvetica no lugar de Arial e Microsoft Sans Serif (fontes não redistribuíveis), o
 * quadro da logomarca com o texto "NFS-e" no lugar da imagem oficial, o nome do município só
 * quando o XML o traz, sem o canhoto (opcional) e sem a marca d'água de cancelada ou
 * substituída (o PDF é gerado na autorização e não é refeito depois).
 *
 * Valores saem do texto decimal do XML, sem ponto flutuante. O PDF é determinístico (sem data de
 * criação nem produtor) e não consulta o relógio. Documento de produção restrita (`tpAmb` 2) ou
 * do simulador sai sempre com "NFS-e SEM VALIDADE JURÍDICA" no cabeçalho; a do simulador ganha
 * ainda a marca d'água "SIMULADA". Nenhuma das duas pode ser desligada para esses documentos.
 */
import { DOMParser } from "@xmldom/xmldom";
import { accessKeyStates, add, decimal, quantize, type ExactDecimal } from "@freecorps/fiscal-core";
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { NFSE_NS } from "./dps.js";
import { fail } from "./errors.js";
import { breakLines } from "./lineBreak.js";

/** Origem do documento quando não é produção. */
export type DanfseMark = "simulated" | "restricted";

export interface DanfseOptions {
  /**
   * `simulated`: NFS-e do provedor simulado (sandbox). `restricted`: produção
   * restrita. Sem valor, o ambiente do XML decide (`tpAmb` 2 vira `restricted`).
   */
  mark?: DanfseMark;
}

/** Campo sem informação no XML (NT 008, item 2.4.5, nota 12). */
export const DASH = "-";

/** Pessoa de um bloco do DANFSe, com cada campo já no formato da NT 008 ou `-`. */
export interface DanfseParty {
  documento: string;
  inscricaoMunicipal: string;
  telefone: string;
  nome: string;
  municipio: string;
  ibgeCep: string;
  endereco: string;
  email: string;
}

/**
 * O que o DANFSe mostra, lido do XML e formatado como a NT 008 pede. Bloco de pessoa ausente
 * vira o texto que a norma manda imprimir no lugar (item 2.3). Exportado para conferência.
 */
export interface DanfseData {
  chaveAcesso: string;
  tpAmb: 1 | 2;
  cabecalho: {
    /** "Município: Nome / UF", ou null quando o item do código nacional é 99. */
    municipio: string | null;
    ambienteGerador: string;
    tipoAmbiente: string;
  };
  identificacao: {
    numero: string;
    competencia: string;
    emissaoNfse: string;
    numeroDps: string;
    serieDps: string;
    emissaoDps: string;
    emitente: string;
    situacao: string;
    finalidade: string;
  };
  prestador: DanfseParty & { simplesNacional: string; regimeApuracao: string };
  tomador: DanfseParty | string;
  destinatario: DanfseParty | string;
  intermediario: DanfseParty | string;
  servico: {
    codigoTributacao: string;
    nbs: string;
    localPrestacao: string;
    descricaoTributacao: string;
    descricao: string;
  };
  issqn: {
    tipoTributacao: string;
    localIncidencia: string;
    regimeEspecial: string;
    imunidade: string;
    suspensao: string;
    processo: string;
    beneficio: string;
    calculoBm: string;
    deducoes: string;
    descontoIncondicionado: string;
    baseCalculo: string;
    aliquota: string;
    retencao: string;
    apurado: string;
  };
  federal: {
    irrf: string;
    previdenciaria: string;
    contribuicoes: string;
    /** Linha de PIS/COFINS: só para competência até 2026 (nota 6). */
    pisCofins: { pis: string; cofins: string; descricao: string } | null;
  };
  ibsCbs: {
    cstClassTrib: string;
    indicadorOperacao: string;
    exclusoes: string;
    baseCalculo: string;
    reducoes: string;
    aliquotasIbs: string;
    aliquotaEfetivaMun: string;
    valorMun: string;
    aliquotaEfetivaUf: string;
    valorUf: string;
    valorIbs: string;
    aliquotaCbs: string;
    aliquotaEfetivaCbs: string;
    valorCbs: string;
  };
  total: {
    valorServico: string;
    descontoIncondicionado: string;
    descontoCondicionado: string;
    retencoes: string;
    valorLiquido: string;
    ibsCbs: string;
    valorLiquidoIbsCbs: string;
  };
  /** Informações complementares, já na ordem e com os prefixos da NT 008, unidas por " | ". */
  informacoes: string;
  /** Linha fixa dos totais aproximados dos tributos (Lei 12.741/2012, nota 10). */
  totaisTributos: string;
}

/**
 * URL de consulta pública do QR Code (NT 008, item 2.4.3), com a chave de 50 dígitos depois do
 * sinal de igual.
 */
export const consultaPublicaUrl = (chave: string) =>
  `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${chave}`;

// ---------------------------------------------------------------------------
// Descrições das opções do leiaute (XSD v1.01, tiposSimples)

const TIPO_AMBIENTE: Record<string, string> = { "1": "Produção", "2": "Homologação" };
const AMBIENTE_GERADOR: Record<string, string> = {
  "1": "Prefeitura",
  "2": "Sistema Nacional da NFS-e",
};
const EMITENTE: Record<string, string> = { "1": "Prestador", "2": "Tomador", "3": "Intermediário" };
const SITUACAO: Record<string, string> = {
  "100": "NFS-e Gerada",
  "102": "NFS-e de Decisão Judicial",
  "103": "NFS-e Avulsa",
  "107": "NFS-e MEI",
};
const FINALIDADE: Record<string, string> = { "0": "NFS-e regular" };
const SIMPLES: Record<string, string> = {
  "1": "Não Optante",
  "2": "Optante - Microempreendedor Individual (MEI)",
  "3": "Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)",
};
const REGIME_SN: Record<string, string> = {
  "1": "Regime de apuração dos tributos federais e municipal pelo Simples Nacional",
  "2": "Regime de apuração dos tributos federais pelo SN e ISSQN por fora do SN conforme respectiva legislação municipal do tributo",
  "3": "Regime de apuração dos tributos federais e municipal por fora do SN conforme respectivas legislações federal e municipal de cada tributo",
};
const TRIB_ISSQN: Record<string, string> = {
  "1": "Operação Tributável",
  "2": "Imunidade",
  "3": "Exportação de Serviço",
  "4": "Não Incidência",
};
const REGIME_ESPECIAL: Record<string, string> = {
  "0": "Nenhum",
  "1": "Ato Cooperado (Cooperativa)",
  "2": "Estimativa",
  "3": "Microempresa Municipal",
  "4": "Notário ou Registrador",
  "5": "Profissional Autônomo",
  "6": "Sociedade de Profissionais",
  "9": "Outros",
};
const IMUNIDADE: Record<string, string> = {
  "0": "Imunidade (tipo não informado na nota de origem)",
  "1": "Patrimônio, renda ou serviços, uns dos outros (CF88, Art 150, VI, a)",
  "2": "Templos de qualquer culto (CF88, Art 150, VI, b)",
  "3": "Patrimônio, renda ou serviços dos partidos políticos, inclusive suas fundações, das entidades sindicais dos trabalhadores, das instituições de educação e de assistência social, sem fins lucrativos, atendidos os requisitos da lei (CF88, Art 150, VI, c)",
  "4": "Livros, jornais, periódicos e o papel destinado a sua impressão (CF88, Art 150, VI, d)",
  "5": "Fonogramas e videofonogramas musicais produzidos no Brasil contendo obras musicais ou literomusicais de autores brasileiros e/ou obras em geral interpretadas por artistas brasileiros bem como os suportes materiais ou arquivos digitais que os contenham, salvo na etapa de replicação industrial de mídias ópticas de leitura a laser. (CF88, Art 150, VI, e)",
};
const SUSPENSAO: Record<string, string> = {
  "1": "Exigibilidade Suspensa por Decisão Judicial",
  "2": "Exigibilidade Suspensa por Processo Administrativo",
};
const BENEFICIO: Record<string, string> = {
  "1": "Isenção",
  // O XSD descreve 2 e 3 com o valor do benefício no texto ("Redução da BC em 'ppBM' %"); o
  // valor sai ao lado, em "Cálculo do BM".
  "2": "Redução da BC em %",
  "3": "Redução da BC em R$",
  "4": "Alíquota Diferenciada",
};
const RETENCAO_ISSQN: Record<string, string> = {
  "1": "Não Retido",
  "2": "Retido pelo Tomador",
  "3": "Retido pelo Intermediário",
};
const RETENCAO_PIS_COFINS: Record<string, string> = {
  "0": "PIS/COFINS/CSLL Não Retidos",
  "1": "PIS/COFINS Retidos",
  "2": "PIS/COFINS Não Retidos",
  "3": "PIS/COFINS/CSLL Retidos",
  "4": "PIS/COFINS Retidos, CSLL Não Retido",
  "5": "PIS Retido, COFINS/CSLL Não Retido",
  "6": "COFINS Retido, PIS/CSLL Não Retido",
  "7": "PIS Não Retido, COFINS/CSLL Retidos",
  "8": "PIS/COFINS Não Retidos, CSLL Retido",
  "9": "COFINS Não Retido, PIS/CSLL Retidos",
};

/** Descrição da opção; código fora da tabela aparece como veio, ausente vira `-`. */
const describe = (table: Record<string, string>, code: string | null) =>
  code === null ? DASH : (table[code] ?? code);

// ---------------------------------------------------------------------------
// Formatos

/** CNPJ com máscara, inclusive o alfanumérico (IN RFB 2.229/2024): 12 posições e 2 dígitos. */
const fmtCnpj = (d: string) =>
  /^[0-9A-Z]{12}\d{2}$/.test(d)
    ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
    : d;
const fmtCpf = (d: string) =>
  /^\d{11}$/.test(d) ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d;
/** CEP no formato da NT 008: nn.nnn-nnn. */
const fmtCep = (d: string) =>
  /^\d{8}$/.test(d) ? `${d.slice(0, 2)}.${d.slice(2, 5)}-${d.slice(5)}` : d;
/** Código de tributação nacional nn.nn.nn. */
const fmtTribNac = (d: string) =>
  /^\d{6}$/.test(d) ? `${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4)}` : d;
/** NBS n.nnnn.nn.nn. */
const fmtNbs = (d: string) =>
  /^\d{9}$/.test(d) ? `${d[0]}.${d.slice(1, 5)}.${d.slice(5, 7)}.${d.slice(7)}` : d;
/** UF pelo prefixo do código IBGE do município. */
const ufOf = (cMun: string | null) => (cMun ? (accessKeyStates[cMun.slice(0, 2)] ?? null) : null);

/**
 * "1234567" → "1.234.567". Laço em grupos de três a partir da esquerda: o valor vem do XML sem
 * limite de tamanho, e uma regex com lookahead revarreria o resto do número em cada posição.
 */
function groupThousands(digits: string): string {
  const head = digits.length % 3 || 3;
  let grouped = digits.slice(0, head);
  for (let i = head; i < digits.length; i += 3) grouped += `.${digits.slice(i, i + 3)}`;
  return grouped;
}

/** "1234.5" → "1.234,50": texto decimal, sem ponto flutuante. */
export function formatDecimal(value: string, places = 2): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const [, sign, int, frac = ""] = match;
  const grouped = groupThousands(int!.replace(/^0+(?=\d)/, ""));
  const decimals = frac.length >= places ? frac : frac.padEnd(places, "0");
  return `${sign}${grouped}${decimals ? `,${decimals}` : ""}`;
}
const brl = (value: string | null) => (value === null ? DASH : `R$ ${formatDecimal(value)}`);
/**
 * Alíquota com as casas do XML, sem zeros à direita além de duas: "2.5000" → "2,50%". Só as
 * casas depois do último ponto, se forem todas dígitos, perdem zeros; o resto passa intacto.
 * Percorre o texto uma vez, em vez de uma regex preguiçosa que recua a cada casa.
 */
function percent(value: string | null): string {
  if (value === null) return DASH;
  const dot = value.lastIndexOf(".");
  const frac = value.slice(dot + 1);
  let end = frac.length;
  if (dot >= 0 && /^\d+$/.test(frac)) while (end > 2 && frac[end - 1] === "0") end--;
  return `${formatDecimal(value.slice(0, dot + 1) + frac.slice(0, end), 2)}%`;
}
/** "2026-10-08T12:00:00-03:00" → "08/10/2026 12:00:00": a hora local do XML, sem o fuso. */
function dateTime(value: string | null) {
  if (value === null) return DASH;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/.exec(value);
  if (!match) return value;
  const date = `${match[3]}/${match[2]}/${match[1]}`;
  return match[4] ? `${date} ${match[4]}` : date;
}

/** Soma exata dos valores presentes; null sem nenhum, ou com algum ilegível. */
function sum(values: Array<string | null>): string | null {
  const present = values.filter((v): v is string => v !== null);
  if (present.length === 0) return null;
  try {
    let total: ExactDecimal = decimal("0");
    for (const value of present) total = add(total, decimal(value));
    return quantize(total, Math.max(2, total.scale), "reject");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Leitura do XML

type El = { getElementsByTagNameNS(ns: string, name: string): ArrayLike<El> } & {
  textContent: string | null;
  getAttribute(name: string): string | null;
  childNodes: ArrayLike<{ nodeType: number; localName?: string | null }>;
};

const first = (scope: El | null | undefined, name: string): El | null =>
  scope ? (scope.getElementsByTagNameNS(NFSE_NS, name)[0] ?? null) : null;

/** Filho direto, para não confundir `valores` da NFS-e com `valores` da DPS. */
function child(scope: El | null | undefined, name: string): El | null {
  if (!scope) return null;
  for (let i = 0; i < scope.childNodes.length; i++) {
    const node = scope.childNodes[i] as unknown as El & { nodeType: number; localName?: string };
    if (node.nodeType === 1 && node.localName === name) return node;
  }
  return null;
}
/** Caminho de filhos diretos: `path(inf, "IBSCBS", "valores", "uf")`. */
const path = (scope: El | null | undefined, ...names: string[]) =>
  names.reduce<El | null>((node, name) => child(node, name), scope ?? null);
const clean = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};
const textOf = (scope: El | null | undefined, name: string) =>
  clean(first(scope, name)?.textContent);
const own = (scope: El | null | undefined, name: string) => clean(child(scope, name)?.textContent);
const all = (scope: El | null | undefined, name: string) => {
  const found = scope ? scope.getElementsByTagNameNS(NFSE_NS, name) : [];
  return Array.from({ length: found.length }, (_, i) => clean(found[i]!.textContent)).filter(
    (v): v is string => v !== null,
  );
};
const or = (value: string | null) => value ?? DASH;

/** Nomes de município que o próprio XML traz, pelo código IBGE. */
type Places = Map<string, string>;

function municipio(places: Places, cMun: string | null, uf: string | null) {
  if (!cMun) return DASH;
  return `${places.get(cMun) ?? DASH} / ${uf ?? ufOf(cMun) ?? DASH}`;
}

/**
 * Pessoa de um grupo do leiaute (prest, toma, interm, dest). `fallback` é o grupo `emit` da
 * NFS-e, só quando o prestador é o emitente (`tpEmit` 1): a DPS traz então só o CNPJ, e o
 * fisco devolve nome, endereço, telefone e e-mail no `emit`.
 */
function party(group: El, places: Places, fallback: El | null = null): DanfseParty {
  const cnpj = own(group, "CNPJ"),
    cpf = own(group, "CPF"),
    nif = own(group, "NIF");
  const end = child(group, "end");
  const nac = child(end, "endNac"),
    ext = child(end, "endExt"),
    emitEnd = child(fallback, "enderNac");
  const street = end ?? emitEnd;
  const endereco = [
    own(street, "xLgr"),
    own(street, "nro"),
    own(street, "xCpl"),
    own(street, "xBairro"),
  ]
    .filter(Boolean)
    .join(", ");
  const cMun = nac ? own(nac, "cMun") : end ? null : own(emitEnd, "cMun");
  const cep = nac ? own(nac, "CEP") : end ? null : own(emitEnd, "CEP");
  let local: string, ibgeCep: string;
  if (ext) {
    local = [own(ext, "xCidade"), own(ext, "xEstProvReg")].filter(Boolean).join(" / ") || DASH;
    ibgeCep = `${DASH} / ${or(own(ext, "cEndPost"))}`;
  } else {
    local = municipio(places, cMun, nac ? null : own(emitEnd, "UF"));
    ibgeCep = cMun || cep ? `${or(cMun)} / ${cep ? fmtCep(cep) : DASH}` : DASH;
  }
  return {
    documento: cnpj ? fmtCnpj(cnpj) : cpf ? fmtCpf(cpf) : or(nif),
    inscricaoMunicipal: or(own(group, "IM") ?? own(fallback, "IM")),
    telefone: or(own(group, "fone") ?? own(fallback, "fone")),
    nome: or(own(group, "xNome") ?? own(fallback, "xNome")),
    municipio: local,
    ibgeCep,
    endereco: endereco || DASH,
    email: or(own(group, "email") ?? own(fallback, "email")),
  };
}

/** Lê do XML da NFS-e autorizada tudo o que o DANFSe mostra, no formato da NT 008. */
export function readNfseForDanfse(nfseXml: string): DanfseData {
  let doc: El;
  try {
    doc = new DOMParser({
      errorHandler: {
        warning: () => undefined,
        error: (message: string) => {
          throw new Error(message);
        },
        fatalError: (message: string) => {
          throw new Error(message);
        },
      },
    }).parseFromString(nfseXml, "text/xml") as unknown as El;
  } catch {
    return fail("DANFSE_XML_INVALID", "XML da NFS-e ilegível.");
  }
  const inf = first(doc, "infNFSe");
  const infDps = first(inf, "infDPS");
  if (!inf || !infDps) return fail("DANFSE_XML_INVALID", "XML sem infNFSe ou sem a DPS.");
  // TSIdNFSe da NT 009: o CNPJ do emitente na chave pode ser alfanumérico.
  const chave = /^NFS(\d{9}[0-9A-Z]{14}\d{27})$/.exec(inf.getAttribute("Id") ?? "")?.[1];
  if (!chave) return fail("DANFSE_XML_INVALID", "infNFSe sem Id com a chave de acesso.");
  const tpAmb = own(infDps, "tpAmb");
  if (tpAmb !== "1" && tpAmb !== "2") return fail("DANFSE_XML_INVALID", "tpAmb ausente na DPS.");
  const prest = child(infDps, "prest");
  if (!prest) return fail("DANFSE_XML_INVALID", "prest ausente na DPS.");
  const emit = child(inf, "emit");

  const places: Places = new Map();
  const place = (code: string | null, name: string | null) => {
    if (code && name && !places.has(code)) places.set(code, name);
  };
  const serv = child(infDps, "serv"),
    locPrest = child(serv, "locPrest"),
    cServ = child(serv, "cServ");
  const cLocEmi = own(infDps, "cLocEmi"),
    xLocEmi = own(inf, "xLocEmi");
  place(cLocEmi, xLocEmi);
  place(own(locPrest, "cLocPrestacao"), own(inf, "xLocPrestacao"));
  place(own(inf, "cLocIncid"), own(inf, "xLocIncid"));
  const nfseIbs = child(inf, "IBSCBS"),
    dpsIbs = child(infDps, "IBSCBS");
  place(own(nfseIbs, "cLocalidadeIncid"), own(nfseIbs, "xLocalidadeIncid"));

  // Cabeçalho e identificação.
  const cTribNac = own(cServ, "cTribNac");
  const emitUf = own(child(emit, "enderNac"), "UF") ?? ufOf(cLocEmi);
  const cabecalho = {
    municipio:
      cTribNac?.startsWith("99") === true
        ? null
        : `Município: ${xLocEmi ?? DASH} / ${emitUf ?? DASH}`,
    ambienteGerador: describe(AMBIENTE_GERADOR, own(inf, "ambGer")),
    tipoAmbiente: describe(TIPO_AMBIENTE, tpAmb),
  };
  const dCompet = own(infDps, "dCompet");
  const tpEmit = own(infDps, "tpEmit");
  const identificacao = {
    numero: or(own(inf, "nNFSe")),
    competencia: dateTime(dCompet),
    emissaoNfse: dateTime(own(inf, "dhProc")),
    numeroDps: or(own(infDps, "nDPS")),
    serieDps: or(own(infDps, "serie")),
    emissaoDps: dateTime(own(infDps, "dhEmi")),
    emitente: describe(EMITENTE, tpEmit),
    situacao: describe(SITUACAO, own(inf, "cStat")),
    finalidade: describe(FINALIDADE, own(infDps, "finNFSe") ?? own(dpsIbs, "finNFSe")),
  };

  // Pessoas.
  const regTrib = child(prest, "regTrib");
  const toma = child(infDps, "toma"),
    interm = child(infDps, "interm"),
    dest = child(dpsIbs, "dest");
  const indDest = own(dpsIbs, "indDest");
  const prestador = {
    ...party(prest, places, tpEmit === null || tpEmit === "1" ? emit : null),
    simplesNacional: describe(SIMPLES, own(regTrib, "opSimpNac")),
    regimeApuracao: describe(REGIME_SN, own(regTrib, "regApTribSN")),
  };

  // Serviço.
  const cTribMun = own(cServ, "cTribMun");
  const cLocPrestacao = own(locPrest, "cLocPrestacao");
  const servico = {
    codigoTributacao: cTribNac ? `${fmtTribNac(cTribNac)} / ${or(cTribMun)}` : DASH,
    nbs: own(cServ, "cNBS") ? fmtNbs(own(cServ, "cNBS")!) : DASH,
    localPrestacao:
      [
        own(inf, "xLocPrestacao"),
        cLocPrestacao && ufOf(cLocPrestacao),
        cLocPrestacao ? "BR" : own(locPrest, "cPaisPrestacao"),
      ]
        .filter(Boolean)
        .join(" / ") || DASH,
    descricaoTributacao: or(own(inf, "xTribMun") ?? own(inf, "xTribNac")),
    descricao: or(own(cServ, "xDescServ")),
  };

  // Tributação municipal. `valores` da DPS e da NFS-e são grupos diferentes: só filhos diretos.
  const dpsValores = child(infDps, "valores"),
    nfseValores = child(inf, "valores");
  const tribMun = path(dpsValores, "trib", "tribMun"),
    tribFed = path(dpsValores, "trib", "tribFed"),
    piscofins = child(tribFed, "piscofins"),
    exigSusp = child(tribMun, "exigSusp"),
    descontos = child(dpsValores, "vDescCondIncond");
  const cLocIncid = own(inf, "cLocIncid");
  const vDescIncond = own(descontos, "vDescIncond");
  const ibsValores = child(nfseIbs, "valores");
  const vCalcReeRepRes = own(ibsValores, "vCalcReeRepRes");
  const issqn = {
    tipoTributacao: describe(TRIB_ISSQN, own(tribMun, "tribISSQN")),
    localIncidencia:
      [
        own(inf, "xLocIncid"),
        cLocIncid && ufOf(cLocIncid),
        own(tribMun, "cPaisResult") ?? (cLocIncid ? "BR" : null),
      ]
        .filter(Boolean)
        .join(" / ") || DASH,
    regimeEspecial: describe(REGIME_ESPECIAL, own(regTrib, "regEspTrib")),
    imunidade: describe(IMUNIDADE, own(tribMun, "tpImunidade")),
    suspensao: describe(SUSPENSAO, own(exigSusp, "tpSusp")),
    processo: or(own(exigSusp, "nProcesso")),
    beneficio: describe(BENEFICIO, own(nfseValores, "tpBM")),
    calculoBm: brl(own(nfseValores, "vCalcBM") ?? own(child(tribMun, "BM"), "vRedBCBM")),
    // As parcelas que o vBC do ISSQN desconta, pela fórmula do XSD: "vDR ou vCalcDR +
    // vCalcReeRepRes" no leiaute de 02/2026 (a da NT 008) e "vAjusteBCISSQN +
    // vCalcAjusteBCISSQN" no da NT 009.
    deducoes: brl(
      sum([
        own(child(dpsValores, "vAjusteBC"), "vAjusteBCISSQN"),
        own(nfseValores, "vCalcAjusteBCISSQN"),
      ]) ??
        sum([
          own(nfseValores, "vCalcDR") ?? own(child(dpsValores, "vDedRed"), "vDR"),
          vCalcReeRepRes,
        ]),
    ),
    descontoIncondicionado: brl(vDescIncond),
    baseCalculo: brl(own(nfseValores, "vBC")),
    aliquota: percent(own(nfseValores, "pAliqAplic") ?? own(tribMun, "pAliq")),
    retencao: describe(RETENCAO_ISSQN, own(tribMun, "tpRetISSQN")),
    apurado: brl(own(nfseValores, "vISSQN")),
  };

  // Tributação federal. Com PIS/COFINS retidos (tpRetPisCofins 1), os valores entram nas
  // contribuições retidas e o débito de apuração própria é zero (NT 008 v1.02).
  const tpRetPisCofins = own(piscofins, "tpRetPisCofins");
  const vPis = own(piscofins, "vPis"),
    vCofins = own(piscofins, "vCofins"),
    vRetCSLL = own(tribFed, "vRetCSLL");
  const pisRetido = tpRetPisCofins === "1";
  const federal = {
    irrf: brl(own(tribFed, "vRetIRRF")),
    previdenciaria: brl(own(tribFed, "vRetCP")),
    contribuicoes: brl(pisRetido ? sum([vRetCSLL, vPis, vCofins]) : vRetCSLL),
    pisCofins:
      dCompet !== null && dCompet.slice(0, 4) <= "2026"
        ? {
            pis: pisRetido ? brl("0.00") : brl(vPis),
            cofins: pisRetido ? brl("0.00") : brl(vCofins),
            descricao: describe(RETENCAO_PIS_COFINS, tpRetPisCofins),
          }
        : null,
  };

  // IBS/CBS: valores calculados vêm do grupo IBSCBS da NFS-e; CST e cClassTrib, da DPS.
  const ibsUf = child(ibsValores, "uf"),
    ibsMun = child(ibsValores, "mun"),
    ibsFed = child(ibsValores, "fed"),
    totCIBS = child(nfseIbs, "totCIBS"),
    gIBS = child(totCIBS, "gIBS");
  const cst = textOf(dpsIbs, "CST"),
    cClassTrib = textOf(dpsIbs, "cClassTrib");
  const cLocalidadeIncid = own(nfseIbs, "cLocalidadeIncid");
  const vIBSTot = own(gIBS, "vIBSTot"),
    vCBS = own(child(totCIBS, "gCBS"), "vCBS");
  const percents = (values: Array<string | null>) =>
    values.every((v) => v === null) ? DASH : values.map(percent).join(" / ");
  const ibsCbs = {
    cstClassTrib: cst || cClassTrib ? `${or(cst)} / ${or(cClassTrib)}` : DASH,
    indicadorOperacao:
      own(dpsIbs, "cIndOp") || cLocalidadeIncid
        ? [
            or(own(dpsIbs, "cIndOp")),
            or(cLocalidadeIncid),
            or(own(nfseIbs, "xLocalidadeIncid")),
            or(ufOf(cLocalidadeIncid)),
          ].join(" / ")
        : DASH,
    exclusoes: brl(
      nfseIbs
        ? sum([
            vDescIncond,
            // vCalcReeRepRes no leiaute de 02/2026; na NT 009, o ajuste que o substitui no vBC.
            vCalcReeRepRes ??
              own(ibsValores, "vCalcAjusteBCIBSCBS") ??
              own(ibsValores, "vCalcAjusteBCLocImoveis"),
            own(nfseValores, "vISSQN"),
            vPis,
            vCofins,
          ])
        : null,
    ),
    baseCalculo: brl(own(ibsValores, "vBC")),
    reducoes: percents([
      own(ibsUf, "pRedAliqUF"),
      own(ibsMun, "pRedAliqMun"),
      own(ibsFed, "pRedAliqCBS"),
    ]),
    aliquotasIbs: percents([own(ibsUf, "pIBSUF"), own(ibsMun, "pIBSMun")]),
    aliquotaEfetivaMun: percent(own(ibsMun, "pAliqEfetMun")),
    valorMun: brl(own(child(gIBS, "gIBSMunTot"), "vIBSMun")),
    aliquotaEfetivaUf: percent(own(ibsUf, "pAliqEfetUF")),
    valorUf: brl(own(child(gIBS, "gIBSUFTot"), "vIBSUF")),
    valorIbs: brl(vIBSTot),
    aliquotaCbs: percent(own(ibsFed, "pCBS")),
    aliquotaEfetivaCbs: percent(own(ibsFed, "pAliqEfetCBS")),
    valorCbs: brl(vCBS),
  };

  const total = {
    valorServico: brl(own(child(dpsValores, "vServPrest"), "vServ")),
    descontoIncondicionado: brl(vDescIncond),
    descontoCondicionado: brl(own(descontos, "vDescCond")),
    retencoes: brl(own(nfseValores, "vTotalRet")),
    valorLiquido: brl(own(nfseValores, "vLiq")),
    ibsCbs: brl(sum([vIBSTot, vCBS])),
    valorLiquidoIbsCbs: brl(own(totCIBS, "vTotNF")),
  };

  // Informações complementares, na ordem e com os prefixos do item 2.4.5.
  const infoCompl = child(serv, "infoCompl");
  const informacoes = (
    [
      ["Inf. Cont.:", own(infoCompl, "xInfComp")],
      ["NFS-e Subst.:", own(child(infDps, "subst"), "chSubstda")],
      ["Doc. Ref.:", own(infoCompl, "docRef")],
      ["Cod. Obra:", own(child(serv, "obra"), "cObra")],
      ["Insc. Imob.:", textOf(infDps, "inscImobFisc")],
      ["Cod. Evt.:", own(child(serv, "atvEvento"), "idAtvEvt")],
      ["Doc. Tec.:", own(infoCompl, "idDocTec")],
      ["Núm. Ped.:", own(infoCompl, "xPed")],
      ["Item Ped.:", all(child(infoCompl, "gItemPed"), "xItemPed").join(", ") || null],
      ["Inf. A. T. Mun.:", own(inf, "xOutInf")],
    ] as const
  )
    .filter(([, value]) => value)
    .map(([label, value]) => `${label} ${value}`)
    .join(" | ");
  const totTrib = path(dpsValores, "trib", "totTrib");
  const monet = child(totTrib, "vTotTrib"),
    pct = child(totTrib, "pTotTrib");
  const approx = (money: string, rate: string) =>
    own(monet, money) !== null
      ? brl(own(monet, money))
      : own(pct, rate) !== null
        ? percent(own(pct, rate))
        : DASH;
  const totaisTributos =
    "Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: " +
    `Federais: ${approx("vTotTribFed", "pTotTribFed")}; ` +
    `Estaduais: ${approx("vTotTribEst", "pTotTribEst")}; ` +
    `Municipais: ${approx("vTotTribMun", "pTotTribMun")}`;

  return {
    chaveAcesso: chave,
    tpAmb: tpAmb === "1" ? 1 : 2,
    cabecalho,
    identificacao,
    prestador,
    tomador: toma
      ? party(toma, places)
      : "TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e",
    destinatario: dest
      ? party(dest, places)
      : indDest === "0"
        ? "O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO"
        : "DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e",
    intermediario: interm
      ? party(interm, places)
      : "INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e",
    servico,
    issqn,
    federal,
    ibsCbs,
    total,
    informacoes,
    totaisTributos,
  };
}

// ---------------------------------------------------------------------------
// Desenho, em pontos; as medidas da NT 008 estão em centímetros.

const A4 = { width: 595.28, height: 841.89 } as const;
const CM = 72 / 2.54;
/** Corpo do DANFSe: 20,40 cm de largura a 0,30 cm da borda do papel, como no item 2.4.5. */
const LEFT = 0.3 * CM;
const WIDTH = 20.4 * CM;
const COL = WIDTH / 4;
const TOP = 0.3 * CM;
const BOTTOM = A4.height - 0.3 * CM;
const PAD = 2.5;
const ROW = 0.63 * CM;
const ROW_ID = 0.67 * CM;
const NOTE_ROW = 0.42 * CM;
const LEAD = 8.4;
const BLACK = rgb(0, 0, 0);
/** Cinza claro a 5% de densidade (item 2.2.3). */
const SHADE = rgb(0.95, 0.95, 0.95);
/** Vermelho sólido M100/Y100 (item 2.4.3). */
const RED = rgb(1, 0, 0);
/** Cinza K35 das marcas d'água (item 2.5). */
const WATERMARK = rgb(0.65, 0.65, 0.65);
/** Limite de caracteres da descrição do serviço e das informações complementares (item 2.4.5). */
const DESCRIPTION_CHARS = 1300;
const INFO_CHARS = 2000;
/** Nenhuma célula comporta mais que isto: o texto é cortado antes de medir, em tempo linear. */
const CELL_CHARS = 600;

/**
 * As fontes padrão do PDF só codificam WinAnsi. Caracteres fora dela (emoji,
 * CJK) viram "?" em vez de derrubar a geração; controles viram espaço.
 */
function encoder(font: PDFFont) {
  const supported = new Set(font.getCharacterSet());
  return (value: string) =>
    Array.from(value)
      .map((char) => {
        const code = char.codePointAt(0)!;
        if (code < 32 || code === 127) return " ";
        return supported.has(code) ? char : "?";
      })
      .join("");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  return breakLines(text, maxWidth, size / 1000, (part) => font.widthOfTextAtSize(part, 1000));
}

/** Uma linha que cabe em `width`; o que passa termina em reticências (item 2.1). */
function fit(text: string, font: PDFFont, size: number, width: number): string {
  const capped = text.length > CELL_CHARS ? text.slice(0, CELL_CHARS) : text;
  if (capped === text && font.widthOfTextAtSize(text, size) <= width) return text;
  const head = wrap(capped, font, size, width - font.widthOfTextAtSize("...", size))[0] ?? "";
  return `${head}...`;
}

/**
 * Texto de um campo de `limit` caracteres (item 2.4.5): o que passa de `limit - 3` fica com os
 * primeiros `limit - 3` e reticências ("utilizar reticências caso a descrição supere 1297").
 */
const clip = (text: string, limit: number) =>
  text.length > limit - 3 ? `${text.slice(0, limit - 3)}...` : text;

/** Módulos do QR desenhados como retângulos: vetorial, sem PNG embutido. */
function drawQr(page: PDFPage, text: string, x: number, y: number, size: number) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const count = qr.modules.size;
  const cell = size / count;
  for (let row = 0; row < count; row++)
    for (let col = 0; col < count; col++)
      if (qr.modules.get(row, col))
        page.drawRectangle({
          x: x + col * cell,
          y: y + size - (row + 1) * cell,
          width: cell,
          height: cell,
          color: BLACK,
        });
}

interface Cell {
  label: string;
  value: string;
  span?: number;
  shaded?: boolean;
}

/**
 * Gera o DANFSe em PDF a partir do XML da NFS-e autorizada. Função pura e
 * determinística: o mesmo XML e as mesmas opções dão os mesmos bytes.
 */
export async function renderDanfse(nfseXml: string, options: DanfseOptions = {}) {
  const data = readNfseForDanfse(nfseXml);
  // Produção restrita nunca sai sem a expressão, mesmo que o chamador não peça.
  const mark: DanfseMark | null = options.mark ?? (data.tpAmb === 2 ? "restricted" : null);
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(`DANFSe ${data.chaveAcesso}`);
  doc.setLanguage("pt-BR");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = encoder(font);
  const page = doc.addPage([A4.width, A4.height]);
  /** `top` é a distância do topo do papel até a linha de base. */
  const text = (
    value: string,
    x: number,
    top: number,
    size: number,
    opts: { font?: PDFFont; color?: ReturnType<typeof rgb>; width?: number; center?: boolean } = {},
  ) => {
    const f = opts.font ?? font;
    let shown = safe(value);
    if (opts.width !== undefined) shown = fit(shown, f, size, opts.width);
    const dx = opts.center && opts.width ? (opts.width - f.widthOfTextAtSize(shown, size)) / 2 : 0;
    page.drawText(shown, {
      x: x + dx,
      y: A4.height - top,
      size,
      font: f,
      color: opts.color ?? BLACK,
    });
  };
  const shade = (x: number, top: number, width: number, height: number) =>
    page.drawRectangle({ x, y: A4.height - top - height, width, height, color: SHADE });
  const rule = (top: number, thickness = 0.5) =>
    page.drawLine({
      start: { x: LEFT, y: A4.height - top },
      end: { x: LEFT + WIDTH, y: A4.height - top },
      thickness,
      color: BLACK,
    });

  let y = TOP;

  // Cabeçalho (item 2.4.3), sombreado.
  const header = 1.16 * CM;
  shade(LEFT, y, WIDTH, header);
  text("NFS-e", LEFT + 0.19 * CM, y + 0.95 * CM, 18, { font: bold });
  const center = LEFT + 5.11 * CM,
    centerWidth = 10.19 * CM;
  text("DANFSe v2.0", center, y + 10, 9, { font: bold, width: centerWidth, center: true });
  text("Documento Auxiliar da NFS-e", center, y + 19.5, 9, {
    font: bold,
    width: centerWidth,
    center: true,
  });
  if (mark)
    text("NFS-e SEM VALIDADE JURÍDICA", center, y + 29, 9, {
      font: bold,
      color: RED,
      width: centerWidth,
      center: true,
    });
  const right = LEFT + 15.32 * CM + PAD,
    rightWidth = 5.08 * CM - 2 * PAD;
  if (data.cabecalho.municipio)
    text(data.cabecalho.municipio, right, y + 9, 8, { width: rightWidth });
  text(`Ambiente Gerador: ${data.cabecalho.ambienteGerador}`, right, y + 20, 6, {
    width: rightWidth,
  });
  text(`Tipo de Ambiente: ${data.cabecalho.tipoAmbiente}`, right, y + 28, 6, { width: rightWidth });
  y += header;
  rule(y);

  /** Uma linha de até quatro células: rótulo em negrito em cima, conteúdo embaixo. */
  const row = (
    cells: Cell[],
    opts: { height?: number; labelSize?: number; upper?: boolean; columns?: number } = {},
  ) => {
    const height = opts.height ?? ROW;
    const labelSize = opts.labelSize ?? 6;
    const columns = opts.columns ?? 4;
    let col = 0;
    for (const cell of cells) {
      const span = cell.span ?? 1;
      const x = LEFT + col * COL;
      const width = span * COL;
      if (cell.shaded) shade(x, y, width, height);
      if (cell.label)
        text(
          opts.upper ? cell.label.toUpperCase() : cell.label,
          x + PAD,
          y + labelSize + 0.5,
          labelSize,
          {
            font: bold,
            width: width - 2 * PAD,
          },
        );
      if (cell.value) text(cell.value, x + PAD, y + height - 3, 7, { width: width - 2 * PAD });
      col += span;
      if (col > columns) break;
    }
    y += height;
  };
  /** Primeira linha de um bloco: título sombreado e caixa alta na primeira coluna (item 2.4.1). */
  const titled = (title: string, cells: Cell[], height = ROW) => {
    shade(LEFT, y, COL, height);
    text(title.toUpperCase(), LEFT + PAD, y + height / 2 + 2.5, 7, {
      font: bold,
      width: COL - 2 * PAD,
    });
    const before = y;
    row([{ label: "", value: "" }, ...cells], { height });
    y = before + height;
  };
  /** Bloco suprimido: só o texto da norma, centralizado (item 2.3). */
  const note = (value: string) => {
    text(value, LEFT, y + NOTE_ROW - 3.5, 7, { width: WIDTH, center: true });
    y += NOTE_ROW;
    rule(y);
  };

  // Dados da NFS-e, com o QR à direita.
  const id = data.identificacao;
  const keyHeight = 0.77 * CM;
  text("CHAVE DE ACESSO DA NFS-E", LEFT + PAD, y + 8.5, 7, { font: bold });
  text(data.chaveAcesso, LEFT + PAD, y + keyHeight - 4.5, 7, { width: 3 * COL - 2 * PAD });
  y += keyHeight;
  const idRow = (cells: Cell[]) =>
    row(cells, { height: ROW_ID, labelSize: 7, upper: true, columns: 3 });
  idRow([
    { label: "Número da NFS-e", value: id.numero },
    { label: "Competência da NFS-e", value: id.competencia },
    { label: "Data e Hora da Emissão da NFS-e", value: id.emissaoNfse },
  ]);
  idRow([
    { label: "Número da DPS", value: id.numeroDps },
    { label: "Série da DPS", value: id.serieDps },
    { label: "Data e Hora da Emissão da DPS", value: id.emissaoDps },
  ]);
  idRow([
    { label: "Emitente da NFS-e", value: id.emitente, shaded: true },
    { label: "Situação da NFS-e", value: id.situacao },
    { label: "Finalidade", value: id.finalidade },
  ]);
  // QR Code com o centro no da posição sugerida (X 17,48 cm e Y 1,67 cm da borda do papel, lado
  // de 1,52 cm), mas com 1,80 cm de lado: a norma fixa só o mínimo, e o espaço até a descrição
  // complementar (Y 3,36 cm) comporta o maior, que a leitura por câmera agradece.
  const qrSize = 1.8 * CM;
  const qrCenter = { x: (17.48 + 0.76) * CM, top: (1.67 + 0.76) * CM };
  drawQr(
    page,
    consultaPublicaUrl(data.chaveAcesso),
    qrCenter.x - qrSize / 2,
    A4.height - qrCenter.top - qrSize / 2,
    qrSize,
  );
  const qrNote = [
    "A autenticidade desta NFS-e pode ser verificada",
    "pela leitura deste código QR ou pela consulta da",
    "chave de acesso no portal nacional da NFS-e",
  ];
  qrNote.forEach((line, i) =>
    text(line, 15.8 * CM, 3.36 * CM + 6 + i * 7, 6, { width: 4.85 * CM }),
  );
  rule(y);

  // Pessoas (itens 2.1.3 a 2.1.6).
  const personBlock = (title: string, p: DanfseParty, withIm: boolean) => {
    titled(title, [
      { label: "CNPJ / CPF / NIF", value: p.documento },
      withIm
        ? { label: "Indicador Municipal (Inscrição)", value: p.inscricaoMunicipal }
        : { label: "", value: "" },
      { label: "Telefone", value: p.telefone },
    ]);
    row([
      { label: "Nome / Nome Empresarial", value: p.nome, span: 2 },
      { label: "Município / Sigla UF", value: p.municipio },
      { label: "Código IBGE / CEP", value: p.ibgeCep },
    ]);
    row([
      { label: "Endereço", value: p.endereco, span: 2 },
      { label: "E-mail", value: p.email, span: 2 },
    ]);
  };
  personBlock("Prestador / Fornecedor", data.prestador, true);
  row([
    { label: "Simples Nacional na Data de Competência", value: data.prestador.simplesNacional },
    {
      label: "Regime de Apuração Tributária pelo SN",
      value: data.prestador.regimeApuracao,
      span: 3,
    },
  ]);
  rule(y);
  for (const [title, p, withIm] of [
    ["Tomador / Adquirente", data.tomador, true],
    ["Destinatário da Operação", data.destinatario, false],
    ["Intermediário da Operação", data.intermediario, true],
  ] as const) {
    if (typeof p === "string") note(p);
    else {
      personBlock(title, p, withIm);
      rule(y);
    }
  }

  // Serviço prestado (item 2.1.7). A descrição ocupa o espaço que sobrar, com as informações.
  const s = data.servico;
  titled("Serviço Prestado", [
    { label: "Código de Tributação Nacional / Municipal", value: s.codigoTributacao },
    { label: "Código da NBS", value: s.nbs },
    { label: "Local da Prestação / Sigla UF / País", value: s.localPrestacao },
  ]);
  text(clip(s.descricaoTributacao, 170), LEFT + PAD, y + 7.5, 7, { width: WIDTH - 2 * PAD });
  y += 10;
  text("Descrição do Serviço", LEFT + PAD, y + 7, 6, { font: bold });
  y += 8.5;
  const descriptionTop = y;
  const textWidth = WIDTH - 2 * PAD;
  const description = wrap(safe(clip(s.descricao, DESCRIPTION_CHARS)), font, 7, textWidth);
  const info = data.informacoes
    ? wrap(safe(clip(data.informacoes, INFO_CHARS)), font, 7, textWidth)
    : [];
  const totals = wrap(safe(data.totaisTributos), font, 7, textWidth);

  // Altura fixa de tudo o que vem depois da descrição.
  const i = data.issqn;
  const optionalIssRow = [i.beneficio, i.calculoBm, i.deducoes, i.descontoIncondicionado].some(
    (v) => v !== DASH,
  );
  const fixedBelow =
    ROW * (3 + (optionalIssRow ? 1 : 0)) +
    ROW * (data.federal.pisCofins ? 2 : 1) +
    ROW * 4 +
    ROW_ID * 2 +
    10 + // título das informações complementares
    LEAD * totals.length +
    4;
  const lines = Math.max(0, Math.floor((BOTTOM - descriptionTop - fixedBelow) / LEAD));
  // Descrição e informações dividem as linhas livres: quem precisa de menos que a metade fica
  // inteiro e o outro leva o resto; cada um corta o seu texto com reticências.
  const half = Math.floor(lines / 2);
  const descriptionShown = Math.min(description.length, Math.max(half, lines - info.length));
  const infoShown = Math.min(info.length, lines - descriptionShown);
  const ellipsis = (line: string) => {
    const room = textWidth - font.widthOfTextAtSize("...", 7);
    return `${font.widthOfTextAtSize(line, 7) <= room ? line : (wrap(line, font, 7, room)[0] ?? "")}...`;
  };
  const cut = (source: string[], shown: number) =>
    shown >= source.length
      ? source
      : shown <= 0
        ? []
        : [...source.slice(0, shown - 1), ellipsis(source[shown - 1]!)];
  for (const line of cut(description, descriptionShown)) {
    text(line, LEFT + PAD, y + 7, 7);
    y += LEAD;
  }
  // Espaço que sobra fica com a descrição (item 2.3).
  y = Math.max(y, BOTTOM - fixedBelow - LEAD * infoShown) + 2;
  rule(y);

  // Tributação municipal (item 2.1.8).
  titled("Tributação Municipal (ISSQN)", [
    { label: "Tipo de Tributação do ISSQN", value: i.tipoTributacao },
    {
      label: "Município / Sigla UF / País de Incidência do ISSQN",
      value: i.localIncidencia,
      span: 2,
    },
  ]);
  row([
    { label: "Regime Especial de Tributação do ISSQN", value: i.regimeEspecial },
    { label: "Tipo de Imunidade do ISSQN", value: i.imunidade },
    { label: "Suspensão da Exigibilidade do ISSQN", value: i.suspensao },
    { label: "Número Processo Suspensão", value: i.processo },
  ]);
  if (optionalIssRow)
    row([
      { label: "Benefício Municipal", value: i.beneficio },
      { label: "Cálculo do BM", value: i.calculoBm },
      { label: "Total Deduções/Reduções", value: i.deducoes },
      { label: "Desconto Incondicionado", value: i.descontoIncondicionado },
    ]);
  row([
    { label: "BC ISSQN", value: i.baseCalculo },
    { label: "Alíquota Aplicada", value: i.aliquota },
    { label: "Retenção do ISSQN", value: i.retencao },
    { label: "ISSQN Apurado", value: i.apurado },
  ]);
  rule(y);

  // Tributação federal (item 2.1.9).
  const f = data.federal;
  titled("Tributação Federal (Exceto CBS)", [
    { label: "IRRF", value: f.irrf },
    { label: "Contribuição Previdenciária - Retida", value: f.previdenciaria },
    { label: "Contribuições Sociais - Retidas", value: f.contribuicoes },
  ]);
  if (f.pisCofins)
    row([
      { label: "PIS - Débito Apuração Própria", value: f.pisCofins.pis },
      { label: "COFINS - Débito Apuração Própria", value: f.pisCofins.cofins },
      { label: "Descrição Contrib. Sociais - Retidas", value: f.pisCofins.descricao, span: 2 },
    ]);
  rule(y);

  // IBS/CBS (item 2.1.10).
  const t = data.ibsCbs;
  titled("Tributação IBS / CBS", [
    { label: "CST / cClassTrib", value: t.cstClassTrib },
    {
      label: "Indicador de Operação / Código IBGE Incidência / Município Incidência / Sigla UF",
      value: t.indicadorOperacao,
      span: 2,
    },
  ]);
  row([
    { label: "Exclusões e Reduções da Base de Cálculo", value: t.exclusoes },
    { label: "Base de Cálculo Após Exclusões e Reduções", value: t.baseCalculo },
    { label: "Red. Alíquota IBS / Red. Alíquota CBS", value: t.reducoes },
    { label: "Alíquota - IBS UF / IBS Mun", value: t.aliquotasIbs },
  ]);
  row([
    { label: "Alíq. Efetiva Municipal - IBS", value: t.aliquotaEfetivaMun },
    { label: "Valor Apurado Municipal - IBS", value: t.valorMun },
    { label: "Alíq. Efetiva Estadual - IBS", value: t.aliquotaEfetivaUf },
    { label: "Valor Apurado Estadual - IBS", value: t.valorUf },
  ]);
  row([
    { label: "Valor Total Apurado - IBS", value: t.valorIbs },
    { label: "Alíquota - CBS", value: t.aliquotaCbs },
    { label: "Alíquota Efetiva - CBS", value: t.aliquotaEfetivaCbs },
    { label: "Valor Total Apurado - CBS", value: t.valorCbs },
  ]);
  rule(y);

  // Valor total (item 2.1.11).
  const v = data.total;
  titled(
    "Valor Total da NFS-e",
    [
      { label: "VALOR DA OPERAÇÃO / SERVIÇO", value: v.valorServico },
      { label: "Desconto Incondicionado", value: v.descontoIncondicionado },
      { label: "Desconto Condicionado", value: v.descontoCondicionado },
    ],
    ROW_ID,
  );
  row(
    [
      { label: "Total das Retenções (ISSQN / Federais)", value: v.retencoes },
      { label: "VALOR LÍQUIDO DA NFS-e", value: v.valorLiquido },
      { label: "Total do IBS/CBS", value: v.ibsCbs },
      { label: "VALOR LÍQUIDO DA NFS-e + IBS/CBS", value: v.valorLiquidoIbsCbs, shaded: true },
    ],
    { height: ROW_ID },
  );
  rule(y);

  // Informações complementares (item 2.1.12), até o fim da página.
  shade(LEFT, y, COL, 10);
  text("INFORMAÇÕES COMPLEMENTARES", LEFT + PAD, y + 7.5, 7, { font: bold, width: COL - 2 * PAD });
  y += 10;
  for (const line of [...cut(info, infoShown), ...totals]) {
    text(line, LEFT + PAD, y + 7, 7);
    y += LEAD;
  }

  // Borda da página, de 1 ponto (item 2.2.3).
  page.drawRectangle({
    x: LEFT,
    y: A4.height - BOTTOM,
    width: WIDTH,
    height: BOTTOM - TOP,
    borderColor: BLACK,
    borderWidth: 1,
  });

  // Documento do simulador: marca d'água no estilo das de cancelamento (item 2.5).
  if (mark === "simulated") {
    const size = 60,
      angle = (40 * Math.PI) / 180,
      label = "SIMULADA",
      width = font.widthOfTextAtSize(label, size);
    page.drawText(label, {
      x: A4.width / 2 - (width / 2) * Math.cos(angle) + (size / 3) * Math.sin(angle),
      y: A4.height / 2 - (width / 2) * Math.sin(angle) - (size / 3) * Math.cos(angle),
      size,
      font,
      color: WATERMARK,
      opacity: 0.5,
      rotate: degrees(40),
    });
  }

  return doc.save({ useObjectStreams: false });
}
