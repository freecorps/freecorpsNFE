import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import forge from "node-forge";
import { SignedXml } from "xml-crypto";
import { repoRoot } from "../lib/repo-root.mjs";

const root = repoRoot;
const output = join(root, "tests/fixtures/nfe/4.00");
mkdirSync(output, { recursive: true });
const keyPath = join(output, "synthetic-signing-key.pem"),
  certPath = join(output, "synthetic-certificate.pem");
if (!existsSync(keyPath)) {
  const keys = forge.pki.rsa.generateKeyPair(2048),
    cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "6901";
  cert.validity.notBefore = new Date("2020-01-01T00:00:00Z");
  cert.validity.notAfter = new Date("2040-01-01T00:00:00Z");
  cert.setSubject([{ name: "commonName", value: "SYNTHETIC FIXTURE ONLY - NOT ICP BRASIL" }]);
  cert.setIssuer(cert.subject.attributes);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey));
  writeFileSync(certPath, forge.pki.certificateToPem(cert));
}
const key = readFileSync(keyPath, "utf8"),
  cert = readFileSync(certPath, "utf8");
const ns = "http://www.portalfiscal.inf.br/nfe",
  ds = "http://www.w3.org/2000/09/xmldsig#";
function digit(base) {
  let sum = 0;
  for (let i = base.length - 1, w = 2; i >= 0; i--, w = w === 9 ? 2 : w + 1)
    sum += (base.charCodeAt(i) - 48) * w;
  const r = sum % 11;
  return String(r < 2 ? 0 : 11 - r);
}
function accessKey(cnpj) {
  const base = "352609" + cnpj + "55001" + "000000069" + "1" + "12345678";
  return base + digit(base);
}
function sign(xml, target, container) {
  const sig = new SignedXml({
    privateKey: key,
    publicCert: cert,
    signatureAlgorithm: ds + "rsa-sha1",
    canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  });
  sig.addReference({
    xpath: `//*[local-name()='${target}']`,
    transforms: [ds + "enveloped-signature", "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"],
    digestAlgorithm: ds + "sha1",
  });
  sig.computeSignature(xml, {
    location: { reference: `//*[local-name()='${container}']`, action: "append" },
  });
  return sig.getSignedXml();
}
function invoice(cnpj = "11222333000181", extra = "") {
  const k = accessKey(cnpj);
  return `<NFe xmlns="${ns}"><infNFe Id="NFe${k}" versao="4.00"><ide><cUF>35</cUF><cNF>12345678</cNF><natOp>VENDA SINTETICA</natOp><mod>55</mod><serie>1</serie><nNF>69</nNF><dhEmi>2026-09-12T12:00:00-03:00</dhEmi><tpNF>1</tpNF><idDest>1</idDest><cMunFG>3550308</cMunFG><tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>${k.at(-1)}</cDV><tpAmb>2</tpAmb><finNFe>1</finNFe><indFinal>1</indFinal><indPres>1</indPres><procEmi>0</procEmi><verProc>synthetic-69</verProc></ide><emit><CNPJ>${cnpj}</CNPJ><xNome>EMITENTE SINTETICO</xNome><enderEmit><xLgr>Rua Exemplo</xLgr><nro>69</nro><xBairro>Centro</xBairro><cMun>3550308</cMun><xMun>Sao Paulo</xMun><UF>SP</UF><CEP>01001000</CEP></enderEmit><IE>110042490114</IE><CRT>1</CRT></emit><det nItem="1"><prod><cProd>ITEM-69</cProd><cEAN>SEM GTIN</cEAN><xProd>PRODUTO SINTETICO</xProd><NCM>21069090</NCM><CEST>1709700</CEST><CFOP>5102</CFOP><uCom>UN</uCom><qCom>2.0000</qCom><vUnCom>12.3456789012</vUnCom><vProd>24.69</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>2.0000</qTrib><vUnTrib>12.3456789012</vUnTrib><indTot>1</indTot><xPed>PEDIDO-69</xPed><nItemPed>000069</nItemPed></prod><imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS><PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS></imposto></det><total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>24.69</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>24.69</vNF></ICMSTot></total><transp><modFrete>9</modFrete></transp><pag><detPag><tPag>01</tPag><vPag>24.69</vPag></detPag></pag>${extra}</infNFe></NFe>`;
}
const cnpj = "11222333000181",
  nfeKey = accessKey(cnpj),
  signed = sign(invoice(), "infNFe", "NFe");
function processed(xml, status = "100", key = nfeKey, protocol = "135260000000069") {
  const digest = /<DigestValue>([^<]+)<\/DigestValue>/.exec(xml)[1];
  return `<nfeProc xmlns="${ns}" versao="4.00">${xml}<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>synthetic</verAplic><chNFe>${key}</chNFe><dhRecbto>2026-09-12T12:01:00-03:00</dhRecbto><nProt>${protocol}</nProt><digVal>${digest}</digVal><cStat>${status}</cStat><xMotivo>EVIDENCIA SINTETICA</xMotivo></infProt></protNFe></nfeProc>`;
}
function summary(status = "1") {
  return `<resNFe xmlns="${ns}" versao="1.01"><chNFe>${nfeKey}</chNFe><CNPJ>${cnpj}</CNPJ><xNome>EMITENTE SINTETICO</xNome><IE>110042490114</IE><dhEmi>2026-09-12T12:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>24.69</vNF><dhRecbto>2026-09-12T12:01:00-03:00</dhRecbto><nProt>135260000000069</nProt><cSitNFe>${status}</cSitNFe></resNFe>`;
}
function summaryKey(start, end, replacement) {
  const base = nfeKey.slice(0, start) + replacement + nfeKey.slice(end, 43);
  return summary().replace(nfeKey, base + digit(base));
}
const conditions =
  "A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca do remetente ou do destinatario; III - a data de emissao ou de saida.";
/**
 * Supplier events of NT 2025.002 (RTC, schemas v1.40) that concern the buyer. Each detail
 * fills only what its e<type>_v1.00.xsd requires after cOrgaoAutor, tpAutor and verAplic;
 * values are synthetic and refer to item 1 of the synthetic invoice.
 */
const rtcItem = (group, quantity, unit) =>
  `<${group} nItem="1"><vIBS>1.23</vIBS><vCBS>0.45</vCBS><gControleEstoque><${quantity}>2.0000</${quantity}><${unit}>UN</${unit}></gControleEstoque></${group}>`;
const rtcEvents = {
  112110: {
    description:
      "Informação de efetivo pagamento integral para liberar crédito presumido do adquirente",
    detail: "<indQuitacao>1</indQuitacao>",
  },
  112120: {
    description: "Importação em ALC/ZFM não convertida em isenção",
    detail: rtcItem("gConsumo", "qtde", "unidade"),
  },
  112130: {
    description:
      "Perecimento, perda, roubo ou furto durante o transporte contratado pelo fornecedor",
    detail:
      '<gPerecimento nItem="1"><vIBS>1.23</vIBS><vCBS>0.45</vCBS><gControleEstoque><qPerecimento>2.0000</qPerecimento><uPerecimento>UN</uPerecimento><vIBS>1.23</vIBS><vCBS>0.45</vCBS></gControleEstoque></gPerecimento>',
  },
  112140: {
    description: "Fornecimento não realizado com pagamento antecipado",
    detail: rtcItem("gItemNaoFornecido", "qNaoFornecida", "uNaoFornecida"),
  },
  112150: {
    description: "Atualização da Data de Previsão de Entrega",
    detail: "<dPrevEntrega>2026-09-20</dPrevEntrega>",
  },
};
/**
 * NT 2026.006 v1.00 event 110300 (Vinculação Pagamento, e110300_v1.00.xsd of PL_010g): the
 * issuer (tpAutor 1) links the authorized NF-e (nProt) to one payment transaction. Identifiers are
 * fictitious, as in the gPgtoVinc fixture; tpMeioPgto only follows the two-digit shape.
 */
const paymentLinkEvent = {
  description: "Vinculação Pagamento",
  detail:
    '<cOrgaoAutor>35</cOrgaoAutor><tpAutor>1</tpAutor><verAplic>synthetic-405</verAplic><nProt>135260000000069</nProt><gPgto idTransacao="000123-SINTETICA"><tpMeioPgto>03</tpMeioPgto><CNPJReceb>11444777000161</CNPJReceb><CNPJBasePSP>12345678</CNPJBasePSP></gPgto>',
};
function event(type = "110111", status = "135", transform = (xml) => xml) {
  const descriptions = {
    110111: "Cancelamento",
    110110: "Carta de Correcao",
    210200: "Confirmacao da Operacao",
    210210: "Ciencia da Operacao",
    210220: "Desconhecimento da Operacao",
    210240: "Operacao nao Realizada",
    ...Object.fromEntries(
      Object.entries(rtcEvents).map(([code, item]) => [code, item.description]),
    ),
    110300: paymentLinkEvent.description,
  };
  const detail =
    type === "110111"
      ? "<nProt>135260000000069</nProt><xJust>CANCELAMENTO DE FIXTURE SINTETICA</xJust>"
      : type === "110110"
        ? `<xCorrecao>CORRECAO DE DESCRICAO SINTETICA</xCorrecao><xCondUso>${conditions}</xCondUso>`
        : type === "210240"
          ? "<xJust>OPERACAO SINTETICA NAO REALIZADA</xJust>"
          : type in rtcEvents
            ? `<cOrgaoAutor>35</cOrgaoAutor><tpAutor>1</tpAutor><verAplic>synthetic-389</verAplic>${rtcEvents[type].detail}`
            : type === "110300"
              ? paymentLinkEvent.detail
              : "";
  const xml = sign(
    transform(
      `<evento xmlns="${ns}" versao="1.00"><infEvento Id="ID${type}${nfeKey}01"><cOrgao>35</cOrgao><tpAmb>2</tpAmb><CNPJ>${cnpj}</CNPJ><chNFe>${nfeKey}</chNFe><dhEvento>2026-09-12T12:02:00-03:00</dhEvento><tpEvento>${type}</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>${descriptions[type]}</descEvento>${detail}</detEvento></infEvento></evento>`,
    ),
    "infEvento",
    "evento",
  );
  // retEvento/xEvento is optional and limited to 60 characters; two RTC descriptions are longer,
  // so their synthetic reply omits it instead of inventing an abbreviation.
  const name = descriptions[type].length <= 60 ? `<xEvento>${descriptions[type]}</xEvento>` : "";
  return `<procEventoNFe xmlns="${ns}" versao="1.00">${xml}${transform(`<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>synthetic</verAplic><cOrgao>35</cOrgao><cStat>${status}</cStat><xMotivo>EVIDENCIA SINTETICA</xMotivo><chNFe>${nfeKey}</chNFe><tpEvento>${type}</tpEvento>${name}<nSeqEvento>1</nSeqEvento><dhRegEvento>2026-09-12T12:03:00-03:00</dhRegEvento><nProt>135260000000070</nProt></infEvento></retEvento>`)}</procEventoNFe>`;
}
/** Fictitious CNPJ with valid digits, other than the issuer in the access key. */
const otherAuthor = (xml) => xml.replace(`<CNPJ>${cnpj}</CNPJ>`, "<CNPJ>00000000000191</CNPJ>");
const differentTime = (xml) => xml.replace("<dhEvento>2026-09-12", "<dhEvento>2026-09-01");
// Only a rejected receipt keeps another author valid: the fisco refused that event.
const differentAuthorAndTime = (xml) => differentTime(otherAuthor(xml));
const checks = (parsing = "passed", xsd = "passed", signature = "passed", identity = "passed") => ({
  parsing,
  xsd,
  signature,
  identity,
});
function eventSummary(protocol = "135260000000070") {
  return `<resEvento xmlns="${ns}" versao="1.01"><cOrgao>35</cOrgao><CNPJ>${cnpj}</CNPJ><chNFe>${nfeKey}</chNFe><dhEvento>2026-09-12T12:02:00-03:00</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><xEvento>Cancelamento</xEvento><dhRecbto>2026-09-12T12:03:00-03:00</dhRecbto><nProt>${protocol}</nProt></resEvento>`;
}
/**
 * NT 2026.008 v1.00 layout: net values (I11a/I11b/I11c), advance-payment ICMS (NB01/NB02) and
 * the net total (W01a), in a debit note for advance payment (tpNFDebito 06), as NB01-20 requires.
 * Positions follow PL_010g v1.03: vUnComLiq/vProdLiq after vProd, vProdLiqTot before ICMSTot,
 * and ICMSPrevistoPagtoAntecip as one alternative of the ICMS choice, replacing the ICMSxx group.
 */
const advancePaymentIcms =
  "<ICMSPrevistoPagtoAntecip><vICMSPrevisto>4.44</vICMSPrevisto></ICMSPrevistoPagtoAntecip>";
const netValues = (xml) =>
  xml
    .replace("<finNFe>1</finNFe>", "<finNFe>6</finNFe><tpNFDebito>06</tpNFDebito>")
    .replace(
      "<vProd>24.69</vProd>",
      "<vProd>24.69</vProd><vUnComLiq>11.2233445566</vUnComLiq><vProdLiq>22.45</vProdLiq>",
    )
    .replace("<ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102>", advancePaymentIcms)
    .replace("<total><ICMSTot>", "<total><vProdLiqTot>22.45</vProdLiqTot><ICMSTot>");
/**
 * NT 2026.006 v1.00 group gPgtoVinc (PL_010g, after infIntermed): two payments linked to the
 * NF-e. Identifiers are fictitious; CNPJReceb uses a fictitious CNPJ with valid digits, and the
 * tpMeioPgto codes follow the two-digit shape: 03 is outside the IT DFe 2026.001 v1.01 table (no
 * label) and 17 is in it ("Pix QRCode").
 */
const paymentLink =
  '<gPgtoVinc><gPgto nPag="1" idTransacao="000123-SINTETICA"><tpMeioPgto>03</tpMeioPgto><CNPJReceb>11444777000161</CNPJReceb><CNPJBasePSP>12345678</CNPJBasePSP></gPgto><gPgto nPag="2" idTransacao="TX-SINTETICA-02"><tpMeioPgto>17</tpMeioPgto><CNPJReceb>11222333000181</CNPJReceb><CNPJBasePSP>11222333</CNPJBasePSP></gPgto></gPgtoVinc>';
const cases = [
  [
    "bytes-limit",
    "x".repeat(2 * 1024 * 1024 + 1),
    checks("failed", "not_checked", "not_checked", "not_checked"),
  ],
  [
    "invoice-prefixed",
    sign(
      invoice()
        .replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)/g, "<$1nf:$2")
        .replace('xmlns="' + ns + '"', 'xmlns:nf="' + ns + '"'),
      "infNFe",
      "NFe",
    ),
    checks(),
  ],

  ["event-summary", eventSummary(), checks("passed", "passed", "not_applicable")],
  [
    "event-summary-conflict",
    eventSummary("135260000000071"),
    checks("passed", "passed", "not_applicable"),
  ],
  ["invoice-signed", signed, checks()],
  ["invoice-authorized", processed(signed), checks()],
  ["invoice-net-values", processed(sign(netValues(invoice()), "infNFe", "NFe")), checks()],
  ["invoice-payment-link", processed(sign(invoice(cnpj, paymentLink), "infNFe", "NFe")), checks()],
  ["invoice-alphanumeric", sign(invoice("12ABC34501DE35"), "infNFe", "NFe"), checks()],
  ["summary-authorized", summary(), checks("passed", "passed", "not_applicable")],
  ["summary-cancelled", summary("3"), checks("passed", "passed", "not_applicable")],
  ["summary-denied", summary("2"), checks("passed", "passed", "not_applicable")],
  [
    "summary-invalid-uf",
    summaryKey(0, 2, "99"),
    checks("passed", "passed", "not_applicable", "failed"),
  ],
  [
    "summary-invalid-month",
    summaryKey(4, 6, "13"),
    checks("passed", "passed", "not_applicable", "failed"),
  ],
  [
    "summary-zero-number",
    summaryKey(25, 34, "000000000"),
    checks("passed", "passed", "not_applicable", "failed"),
  ],
  [
    "summary-invalid-emission",
    summaryKey(34, 35, "8"),
    checks("passed", "passed", "not_applicable", "failed"),
  ],
  [
    "summary-issued-at-mismatch",
    summary().replace("<dhEmi>2026-09", "<dhEmi>2026-08"),
    checks("passed", "passed", "not_applicable", "failed"),
  ],
  [
    "wide-tax-group",
    invoice().replace(
      /<imposto>[\s\S]*?<\/imposto>/,
      "<imposto>" + "<extra>0</extra>".repeat(5000) + "</imposto>",
    ),
    checks("passed", "failed", "failed"),
  ],
  ...[
    "110111",
    "110110",
    "210200",
    "210210",
    "210220",
    "210240",
    ...Object.keys(rtcEvents),
    "110300",
  ].map((type) => ["event-" + type, event(type), checks()]),
  [
    "event-112150-invalid-detail",
    event("112150", "135", (xml) => xml.replace("<dPrevEntrega>2026-09-20</dPrevEntrega>", "")),
    checks("passed", "failed"),
  ],
  [
    "event-summary-112150",
    eventSummary()
      .replace("<tpEvento>110111</tpEvento>", "<tpEvento>112150</tpEvento>")
      .replace(
        "<xEvento>Cancelamento</xEvento>",
        `<xEvento>${rtcEvents[112150].description}</xEvento>`,
      ),
    checks("passed", "passed", "not_applicable"),
  ],
  // The XSD admits only the issuer as author (tpAutor 1) and requires the gPgto group.
  [
    "event-110300-wrong-author",
    event("110300", "135", (xml) => xml.replace("<tpAutor>1</tpAutor>", "<tpAutor>2</tpAutor>")),
    checks("passed", "failed"),
  ],
  [
    "event-110300-invalid-detail",
    event("110300", "135", (xml) => xml.replace(/<gPgto [\s\S]*<\/gPgto>/, "")),
    checks("passed", "failed"),
  ],
  [
    "event-summary-110300",
    eventSummary()
      .replace("<tpEvento>110111</tpEvento>", "<tpEvento>110300</tpEvento>")
      .replace(
        "<xEvento>Cancelamento</xEvento>",
        `<xEvento>${paymentLinkEvent.description}</xEvento>`,
      ),
    checks("passed", "passed", "not_applicable"),
  ],
  ["cancellation-rejected", event("110111", "573"), checks()],
  ["event-rejected-conflicting-claims", event("110111", "573", differentAuthorAndTime), checks()],
  ["event-unlinked-conflicting-claims", event("110111", "136", differentTime), checks()],
  ["event-accepted-conflicting-claims", event("110111", "135", differentTime), checks()],
  // #532: an event only the issuer registers, signed by another CNPJ, fails the identity step.
  ...["110111", "110110", "112110", "110300"].map((type) => [
    `event-${type}-other-author`,
    event(type, "135", otherAuthor),
    checks("passed", "passed", "passed", "failed"),
  ]),
  [
    "event-summary-other-author",
    otherAuthor(eventSummary()),
    checks("passed", "passed", "not_applicable", "failed"),
  ],
  ["event-210200-other-author", event("210200", "135", otherAuthor), checks()],
  [
    "event-rejected-other-identity",
    event("110111", "573", (xml) =>
      xml
        .replaceAll(nfeKey, accessKey("00000000000191"))
        .replaceAll("<tpAmb>2</tpAmb>", "<tpAmb>1</tpAmb>"),
    ),
    checks(),
  ],
  [
    "invoice-monophase",
    sign(
      invoice()
        .replace("<CRT>1</CRT>", "<CRT>3</CRT>")
        .replace(
          "<ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102>",
          "<ICMS02><orig>0</orig><CST>02</CST><qBCMono>2.0000</qBCMono><adRemICMS>1.2345</adRemICMS><vICMSMono>2.47</vICMSMono></ICMS02>",
        ),
      "infNFe",
      "NFe",
    ),
    checks(),
  ],
  [
    "summary-conflicting-total",
    summary().replace("24.69", "25.69"),
    checks("passed", "passed", "not_applicable"),
  ],
  [
    "protocol-digest-whitespace",
    processed(signed).replace(/<digVal>([^<]+)<\/digVal>/, "<digVal>  $1  </digVal>"),
    checks(),
  ],
  [
    "signature-other-reference",
    signed.replace(/URI="#[^"]+"/, 'URI="#other"'),
    checks("passed", "passed", "failed"),
  ],
  [
    "signature-external-reference",
    signed.replace(/URI="#[^"]+"/, 'URI="https://example.invalid/external"'),
    checks("passed", "passed", "failed"),
  ],
  [
    "signature-wrapping",
    signed.replace(
      "</infNFe>",
      "<wrapper>" + signed.replace(/NFe(\d{44})/g, "NFe$1other") + "</wrapper></infNFe>",
    ),
    checks("passed", "failed", "failed"),
  ],
  [
    "invalid-utf8",
    Buffer.from([0xc3, 0x28]),
    checks("failed", "not_checked", "not_checked", "not_checked"),
  ],
  [
    "depth-limit",
    "<a>".repeat(65) + "</a>".repeat(65),
    checks("failed", "not_checked", "not_checked", "not_checked"),
  ],
  [
    "nodes-limit",
    "<a>" + "<b/>".repeat(50000) + "</a>",
    checks("failed", "not_checked", "not_checked", "not_checked"),
  ],
  [
    "invalid-calendar",
    signed.replace("2026-09-12", "2026-02-30"),
    checks("failed", "not_checked", "not_checked", "not_checked"),
  ],
  ["invoice-unsigned", invoice(), checks("passed", "failed", "failed")],
  [
    "signature-tampered",
    signed.replace("PRODUTO SINTETICO", "PRODUTO ADULTERADO"),
    checks("passed", "passed", "failed"),
  ],
  [
    "protocol-mismatch",
    processed(signed, "100", accessKey("12ABC34501DE35")),
    checks("passed", "passed", "passed", "failed"),
  ],
  [
    "schema-unknown",
    signed.replace('versao="4.00"', 'versao="9.99"'),
    checks("unsupported", "not_checked", "not_checked", "not_checked"),
  ],
  ["malformed", "<NFe>", checks("failed", "not_checked", "not_checked", "not_checked")],
  [
    "doctype",
    '<!DOCTYPE NFe [<!ENTITY x SYSTEM "https://example.invalid/secret">]>' + signed,
    checks("failed", "not_checked", "not_checked", "not_checked"),
  ],
  [
    "duplicate-id",
    signed.replace("</infNFe>", `<extra Id="NFe${nfeKey}"/></infNFe>`),
    checks("failed", "not_checked", "not_checked", "not_checked"),
  ],
  [
    "namespace-unknown",
    signed.replaceAll(ns, "https://example.invalid/not-nfe"),
    checks("unsupported", "not_checked", "not_checked", "not_checked"),
  ],
  [
    "extreme-decimal",
    sign(
      invoice().replace("12.3456789012", "999999999999999999999999999999.1234567890"),
      "infNFe",
      "NFe",
    ),
    checks("passed", "failed", "passed"),
  ],
];
const manifest = {
  version: 1,
  model: "55",
  parser: "nfe-parser/8",
  normalizer: "nfe-normalizer/1",
  rule: "nfe-status/2",
  evaluatedAt: "2026-09-12T15:00:00Z",
  source: "synthetic",
  redistribution: "Project-generated synthetic data; no real credential or fiscal document",
  cases: [],
};
for (const [id, xml, expected] of cases) {
  if (typeof id !== "string" || !(typeof xml === "string" || Buffer.isBuffer(xml)))
    throw new Error("Invalid corpus case");
  const path = id + ".xml";
  writeFileSync(join(output, path), xml);
  const parsed = expected.parsing === "passed";
  const hasClaim =
    [
      "invoice-authorized",
      "invoice-net-values",
      "invoice-payment-link",
      "protocol-mismatch",
      "protocol-digest-whitespace",
      "cancellation-rejected",
    ].includes(id) ||
    id.startsWith("summary-") ||
    id.startsWith("event-");
  const completeExpected = {
    parsing: expected.parsing,
    xsd: expected.xsd,
    signature: expected.signature,
    identity: expected.identity,
    normalization: parsed ? "passed" : "not_checked",
    certificateTrust: "not_checked",
    originTrust: "not_checked",
    certificateTime: expected.signature === "passed" ? "passed" : "not_checked",
    fiscalEvidence:
      parsed && hasClaim
        ? expected.identity === "passed" && expected.xsd === "passed"
          ? "passed"
          : "failed"
        : "not_checked",
  };
  const parsingErrors = {
    "bytes-limit": "XML_TOO_LARGE",
    "invalid-utf8": "XML_ENCODING_INVALID",
    "depth-limit": "XML_LIMIT_EXCEEDED",
    "nodes-limit": "XML_LIMIT_EXCEEDED",
    "invalid-calendar": "XML_FIELD_INVALID",
    "schema-unknown": "XML_SCHEMA_UNSUPPORTED",
    malformed: "XML_MALFORMED",
    doctype: "XML_UNSAFE",
    "duplicate-id": "XML_DUPLICATE_ID",
    "namespace-unknown": "XML_NAMESPACE_UNSUPPORTED",
  };
  const expectedCodes = {
    parsing: parsed ? "XML_PARSED" : parsingErrors[id],
    xsd: parsed ? (expected.xsd === "passed" ? "XSD_VALID" : "XSD_INVALID") : "NOT_CHECKED",
    identity: parsed
      ? expected.identity === "passed"
        ? "NFE_IDENTITY_VALID"
        : id === "protocol-mismatch"
          ? "NFE_PROTOCOL_MISMATCH"
          : id === "summary-issued-at-mismatch"
            ? "NFE_KEY_ISSUED_AT_MISMATCH"
            : id.includes("-other-author")
              ? "NFE_EVENT_AUTHOR_NOT_ISSUER"
              : "NFE_KEY_COMPONENT_INVALID"
      : "NOT_CHECKED",
    normalization: parsed ? "NORMALIZATION_VALID" : "NOT_CHECKED",
    signature: !parsed
      ? "NOT_CHECKED"
      : expected.signature === "passed"
        ? "SIGNATURE_INTEGRITY_VALID"
        : expected.signature === "not_applicable"
          ? "SUMMARY_HAS_NO_DOCUMENT_SIGNATURE"
          : ["invoice-unsigned", "wide-tax-group"].includes(id)
            ? "SIGNATURE_MISSING"
            : "SIGNATURE_INVALID_OR_UNSUPPORTED",
    certificateTrust: parsed ? "CERTIFICATE_CHAIN_NOT_CHECKED" : "NOT_CHECKED",
    certificateTime: !parsed
      ? "NOT_CHECKED"
      : expected.signature === "passed"
        ? "CERTIFICATE_VALID_AT_EVALUATION"
        : "CERTIFICATE_TIME_NOT_CHECKED",
    originTrust: "FISCAL_ORIGIN_NOT_AUTHENTICATED",
    fiscalEvidence: !parsed
      ? "NOT_CHECKED"
      : !hasClaim
        ? "FISCAL_EVIDENCE_ABSENT"
        : completeExpected.fiscalEvidence === "passed"
          ? "PRESERVED_FISCAL_CLAIM_CONSISTENT"
          : "FISCAL_EVIDENCE_INCONSISTENT",
  };
  if (Object.values(expectedCodes).some((code) => typeof code !== "string"))
    throw new Error("Every scenario needs an explicit expected error code");
  manifest.cases.push({
    id,
    path,
    sha256: createHash("sha256").update(xml).digest("hex"),
    origin: "scripts/fiscal/generate-nfe-corpus.mjs",
    expected: completeExpected,
    expectedCodes,
  });
}
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Generated ${cases.length} synthetic NF-e cases`);
