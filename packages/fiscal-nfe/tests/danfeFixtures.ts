import { readFileSync } from "node:fs";
import { accessKeyDigit } from "@freecorps/fiscal-core";
import { SignedXml } from "xml-crypto";

/**
 * NF-e sintéticas para o DANFE, válidas no XSD do pacote e assinadas com a chave sintética do
 * corpus (`tests/fixtures/nfe/4.00/synthetic-*.pem`, que não é ICP-Brasil). CNPJs fictícios da
 * lista de scripts/public-identifiers.test.ts e o alfanumérico do manual da RFB; chaves com
 * dígito calculado. Nada aqui foi autorizado: protocolo e eventos são evidência sintética.
 */
const NS = "http://www.portalfiscal.inf.br/nfe";
const DS = "http://www.w3.org/2000/09/xmldsig#";
const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const corpus = new URL("../../../tests/fixtures/nfe/4.00/", import.meta.url);
const privateKey = readFileSync(new URL("synthetic-signing-key.pem", corpus), "utf8");
const publicCert = readFileSync(new URL("synthetic-certificate.pem", corpus), "utf8");

/** Assina `target` (infNFe ou infEvento) e anexa a assinatura ao `container`. */
export function sign(xml: string, target: "infNFe" | "infEvento", container: "NFe" | "evento") {
  const signer = new SignedXml({
    privateKey,
    publicCert,
    signatureAlgorithm: DS + "rsa-sha1",
    canonicalizationAlgorithm: C14N,
  });
  signer.addReference({
    xpath: `//*[local-name()='${target}']`,
    transforms: [DS + "enveloped-signature", C14N],
    digestAlgorithm: DS + "sha1",
  });
  signer.computeSignature(xml, {
    location: { reference: `//*[local-name()='${container}']`, action: "append" },
  });
  return signer.getSignedXml();
}

export interface ProtocolOptions {
  cStat?: string;
  tpAmb?: "1" | "2";
  /** `null` omite a tag. */
  nProt?: string | null;
  /** `null` omite a tag; sem valor, usa o DigestValue da assinatura. */
  digVal?: string | null;
}

export interface FixtureOptions {
  cnpj?: string;
  tpAmb?: "1" | "2";
  items?: number;
  longDescriptions?: boolean;
  /** Texto de `infAdProd` de cada item, no lugar do texto longo padrão. */
  itemExtra?: string;
  infCpl?: string;
  emitterName?: string;
  emitterStreet?: string;
  rtc?: boolean;
  duplicates?: number;
  volumes?: number;
  issqn?: boolean;
  /** `null`: XML sem nfeProc. */
  protocol?: ProtocolOptions | null;
  /** Altera a NF-e já assinada, antes de montar o nfeProc. */
  tamper?: (signedNfe: string) => string;
}

export function accessKey(cnpj = "11222333000181") {
  const base = `352610${cnpj}550010000001231` + "12345678";
  return base + accessKeyDigit(base);
}

const LONG =
  "com descrição extensa para testar a quebra de linha no quadro de produtos, mantendo todas as palavras do XML";

function det(n: number, options: FixtureOptions) {
  const is =
    options.rtc && n === 1
      ? `<IS><CSTIS>000</CSTIS><cClassTribIS>000001</cClassTribIS><vBCIS>100.00</vBCIS><pIS>10.0000</pIS><vIS>10.00</vIS></IS>`
      : "";
  const rtc = options.rtc
    ? `<IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib><gIBSCBS><vBC>100.00</vBC>` +
      `<gIBSUF><pIBSUF>0.1000</pIBSUF><vIBSUF>0.10</vIBSUF></gIBSUF>` +
      `<gIBSMun><pIBSMun>0.0000</pIBSMun><vIBSMun>0.00</vIBSMun></gIBSMun><vIBS>0.10</vIBS>` +
      `<gCBS><pCBS>0.9000</pCBS><gRed><pRedAliq>60.0000</pRedAliq><pAliqEfet>0.3600</pAliqEfet></gRed><vCBS>0.36</vCBS></gCBS>` +
      `</gIBSCBS></IBSCBS>`
    : "";
  const extra =
    options.itemExtra ?? (options.longDescriptions ? `Item ${n}: ${LONG} ${LONG}` : null);
  return (
    `<det nItem="${n}"><prod><cProd>COD-${n}</cProd><cEAN>SEM GTIN</cEAN>` +
    `<xProd>PRODUTO SINTETICO ${n}${options.longDescriptions ? ` ${LONG.slice(0, 90).trim()}` : ""}</xProd>` +
    `<NCM>21069090</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>2.0000</qCom><vUnCom>50.0000000001</vUnCom>` +
    `<vProd>100.00</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>2.0000</qTrib>` +
    `<vUnTrib>50.0000000001</vUnTrib><indTot>1</indTot></prod><imposto>` +
    `<ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>100.00</vBC><pICMS>18.00</pICMS><vICMS>18.00</vICMS></ICMS00></ICMS>` +
    `<IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vBC>100.00</vBC><pIPI>5.00</pIPI><vIPI>5.00</vIPI></IPITrib></IPI>` +
    `<PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>` +
    `${is}${rtc}</imposto>` +
    (extra ? `<infAdProd>${extra}</infAdProd>` : "") +
    `</det>`
  );
}

/** Data ISO `days` dias depois de 01/11/2026, sempre de calendário válido. */
function dueDate(days: number) {
  return new Date(Date.UTC(2026, 10, 1 + days)).toISOString().slice(0, 10);
}

/** NF-e sem assinatura. */
export function unsignedNfe(options: FixtureOptions = {}) {
  const cnpj = options.cnpj ?? "11222333000181";
  const tpAmb = options.tpAmb ?? "1";
  const key = accessKey(cnpj);
  const count = options.items ?? 2;
  const total = `${count * 100}.00`;
  const dup = options.duplicates
    ? `<cobr><fat><nFat>123</nFat><vOrig>${total}</vOrig><vDesc>0.00</vDesc><vLiq>${total}</vLiq></fat>` +
      Array.from(
        { length: options.duplicates },
        (_, i) =>
          `<dup><nDup>${String(i + 1).padStart(3, "0")}</nDup><dVenc>${dueDate(i)}</dVenc><vDup>10.01</vDup></dup>`,
      ).join("") +
      `</cobr>`
    : "";
  const rtcTotals = options.rtc
    ? `<ISTot><vIS>10.00</vIS></ISTot><IBSCBSTot><vBCIBSCBS>${total}</vBCIBSCBS>` +
      `<gIBS><gIBSUF><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSUF>0.20</vIBSUF></gIBSUF>` +
      `<gIBSMun><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSMun>0.00</vIBSMun></gIBSMun><vIBS>0.20</vIBS>` +
      `<vCredPres>0.00</vCredPres><vCredPresCondSus>0.00</vCredPresCondSus></gIBS>` +
      `<gCBS><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vCBS>0.72</vCBS>` +
      `<vCredPres>0.00</vCredPres><vCredPresCondSus>0.00</vCredPresCondSus></gCBS></IBSCBSTot>`
    : "";
  const issqn = options.issqn
    ? `<ISSQNtot><vServ>300.00</vServ><vBC>300.00</vBC><vISS>15.00</vISS><dCompet>2026-10-30</dCompet></ISSQNtot>`
    : "";
  const volumes = Array.from(
    { length: options.volumes ?? 1 },
    (_, i) =>
      `<vol><qVol>3</qVol><esp>CAIXA</esp><marca>SINTETICA</marca><nVol>${i + 1}/3</nVol><pesoL>12.500</pesoL><pesoB>13.250</pesoB></vol>`,
  ).join("");
  const additional =
    options.infCpl === undefined
      ? ""
      : `<infAdic><infAdFisco>DOCUMENTO SINTETICO</infAdFisco><infCpl>${options.infCpl}</infCpl></infAdic>`;
  return (
    `<NFe xmlns="${NS}"><infNFe Id="NFe${key}" versao="4.00"><ide>` +
    `<cUF>35</cUF><cNF>12345678</cNF><natOp>VENDA DE MERCADORIA SINTETICA</natOp><mod>55</mod><serie>1</serie>` +
    `<nNF>123</nNF><dhEmi>2026-10-30T23:30:00-03:00</dhEmi><dhSaiEnt>2026-10-31T08:15:00-03:00</dhSaiEnt>` +
    `<tpNF>1</tpNF><idDest>1</idDest><cMunFG>3550308</cMunFG><tpImp>1</tpImp><tpEmis>1</tpEmis>` +
    `<cDV>${key[43]}</cDV><tpAmb>${tpAmb}</tpAmb><finNFe>1</finNFe><indFinal>0</indFinal><indPres>1</indPres>` +
    `<procEmi>0</procEmi><verProc>synthetic</verProc></ide>` +
    `<emit><CNPJ>${cnpj}</CNPJ><xNome>${options.emitterName ?? "EMITENTE SINTETICO DE TESTE LTDA"}</xNome><xFant>SINTETICO</xFant>` +
    `<enderEmit><xLgr>${options.emitterStreet ?? "Rua Exemplo"}</xLgr><nro>100</nro><xBairro>Centro</xBairro><cMun>3550308</cMun>` +
    `<xMun>Sao Paulo</xMun><UF>SP</UF><CEP>01001000</CEP><fone>1130000000</fone></enderEmit>` +
    `<IE>110042490114</IE>${options.issqn ? "<IM>12345</IM><CNAE>6201501</CNAE>" : ""}<CRT>3</CRT></emit>` +
    `<dest><CNPJ>11444777000161</CNPJ><xNome>DESTINATARIO SINTETICO S/A</xNome><enderDest><xLgr>Avenida Exemplo</xLgr>` +
    `<nro>200</nro><xCpl>Sala 3</xCpl><xBairro>Jardim Teste</xBairro><cMun>3509502</cMun><xMun>Campinas</xMun><UF>SP</UF>` +
    `<CEP>13000000</CEP><fone>19999990000</fone></enderDest><indIEDest>1</indIEDest><IE>244000000110</IE></dest>` +
    Array.from({ length: count }, (_, i) => det(i + 1, options)).join("") +
    `<total><ICMSTot><vBC>${total}</vBC><vICMS>18.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP>` +
    `<vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>${total}</vProd>` +
    `<vFrete>12.34</vFrete><vSeg>0.00</vSeg><vDesc>1.50</vDesc><vII>0.00</vII><vIPI>5.00</vIPI><vIPIDevol>0.00</vIPIDevol>` +
    `<vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>1234567.89</vNF></ICMSTot>${issqn}${rtcTotals}</total>` +
    `<transp><modFrete>0</modFrete><transporta><CNPJ>12345678000195</CNPJ><xNome>TRANSPORTADORA SINTETICA</xNome>` +
    `<IE>110042490114</IE><xEnder>Rodovia Exemplo, km 10</xEnder><xMun>Jundiai</xMun><UF>SP</UF></transporta>` +
    `<veicTransp><placa>ABC1D23</placa><UF>SP</UF><RNTC>12345678</RNTC></veicTransp>${volumes}</transp>` +
    dup +
    `<pag><detPag><tPag>01</tPag><vPag>${total}</vPag></detPag></pag>` +
    additional +
    `</infNFe></NFe>`
  );
}

/** NF-e assinada, por padrão dentro de nfeProc com protocolo 100 e digVal do digest assinado. */
export function nfeXml(options: FixtureOptions = {}) {
  const tpAmb = options.tpAmb ?? "1";
  const key = accessKey(options.cnpj);
  const signed = sign(unsignedNfe(options), "infNFe", "NFe");
  const nfe = options.tamper ? options.tamper(signed) : signed;
  if (options.protocol === null) return nfe;
  const protocol = options.protocol ?? {};
  const digest = /<DigestValue>([^<]+)<\/DigestValue>/.exec(signed)![1]!;
  const digVal = protocol.digVal === undefined ? digest : protocol.digVal;
  const nProt = protocol.nProt === undefined ? "135260000000123" : protocol.nProt;
  return (
    `<nfeProc xmlns="${NS}" versao="4.00">${nfe}` +
    `<protNFe versao="4.00"><infProt><tpAmb>${protocol.tpAmb ?? tpAmb}</tpAmb><verAplic>synthetic</verAplic><chNFe>${key}</chNFe>` +
    `<dhRecbto>2026-10-30T23:31:05-03:00</dhRecbto>${nProt === null ? "" : `<nProt>${nProt}</nProt>`}` +
    `${digVal === null ? "" : `<digVal>${digVal}</digVal>`}<cStat>${protocol.cStat ?? "100"}</cStat>` +
    `<xMotivo>EVIDENCIA SINTETICA</xMotivo></infProt></protNFe></nfeProc>`
  );
}

/** procEventoNFe assinado. Padrão: cancelamento 110111 registrado (135) em produção. */
export function eventXml(
  key: string,
  options: {
    cStat?: string;
    tpEvento?: string;
    tpAmb?: "1" | "2";
    nProt?: string;
    /** nSeqEvento; o protocolo do retorno termina com ela. */
    sequence?: number;
  } = {},
) {
  const type = options.tpEvento ?? "110111";
  const tpAmb = options.tpAmb ?? "1";
  const sequence = options.sequence ?? 1;
  const seq2 = String(sequence).padStart(2, "0");
  const detail =
    type === "110111"
      ? `<descEvento>Cancelamento</descEvento><nProt>${options.nProt ?? "135260000000123"}</nProt><xJust>CANCELAMENTO DE FIXTURE SINTETICA</xJust>`
      : `<descEvento>Carta de Correcao</descEvento><xCorrecao>CORRECAO DE DESCRICAO SINTETICA</xCorrecao>` +
        `<xCondUso>A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca do remetente ou do destinatario; III - a data de emissao ou de saida.</xCondUso>`;
  const event = sign(
    `<evento xmlns="${NS}" versao="1.00"><infEvento Id="ID${type}${key}${seq2}"><cOrgao>35</cOrgao><tpAmb>${tpAmb}</tpAmb>` +
      `<CNPJ>${key.slice(6, 20)}</CNPJ><chNFe>${key}</chNFe><dhEvento>2026-10-31T09:00:00-03:00</dhEvento>` +
      `<tpEvento>${type}</tpEvento><nSeqEvento>${sequence}</nSeqEvento><verEvento>1.00</verEvento>` +
      `<detEvento versao="1.00">${detail}</detEvento></infEvento></evento>`,
    "infEvento",
    "evento",
  );
  return (
    `<procEventoNFe xmlns="${NS}" versao="1.00">${event}` +
    `<retEvento versao="1.00"><infEvento><tpAmb>${tpAmb}</tpAmb><verAplic>synthetic</verAplic><cOrgao>35</cOrgao>` +
    `<cStat>${options.cStat ?? "135"}</cStat><xMotivo>EVIDENCIA SINTETICA</xMotivo><chNFe>${key}</chNFe>` +
    `<tpEvento>${type}</tpEvento><nSeqEvento>${sequence}</nSeqEvento>` +
    `<dhRegEvento>2026-10-31T09:00:07-03:00</dhRegEvento><nProt>${135260000000998 + sequence}</nProt></infEvento></retEvento></procEventoNFe>`
  );
}
