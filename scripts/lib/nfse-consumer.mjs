// Consumidor independente de @freecorps/fiscal-nfse: roda num diretório limpo,
// com o tarball instalado pelo npm, fora do monorepo. Dados sintéticos; nada
// aqui prova autorização fiscal.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  NFSE_SCHEMA_PACKAGE,
  NfseError,
  buildDps,
  signDps,
  validateDpsXml,
  verifySignature,
} from "@freecorps/fiscal-nfse";
import { buildDpsId, resolveRoute, subitemFromCTribNac } from "@freecorps/fiscal-nfse/pure";
import { renderDanfse } from "@freecorps/fiscal-nfse/danfse";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
// Mesma DPS nacional de packages/fiscal-nfse/tests/inputs.ts: CNPJ e CPF de
// exemplo, com dígitos válidos e sem relação com clientes.
const input = {
  tpAmb: 2,
  dhEmi: "2026-08-29T10:00:00-03:00",
  verAplic: "FiscalNfseTest_1.0",
  serie: 1,
  nDPS: 42,
  dCompet: "2026-07-31",
  cLocEmi: "3550308",
  prest: {
    cnpj: "11222333000181",
    email: "fiscal@prestador.example",
    opSimpNac: 3,
    regApTribSN: 1,
    regEspTrib: 0,
  },
  toma: {
    tipo: "CPF",
    cpfCnpj: "11144477735",
    xNome: "Pessoa Sintética",
    cMun: "3550308",
    cep: "01001000",
    xLgr: "Praca da Se",
    nro: "115",
    xBairro: "Centro",
  },
  serv: { cLocPrestacao: "3550308", cTribNac: "100202", xDescServ: "Servico de teste" },
  valores: {
    vServ: "67.6",
    tpRetISSQN: 1,
    tribISSQN: 1,
    vTotTribFed: "0",
    vTotTribEst: "0",
    vTotTribMun: "0",
  },
};

// Montagem conferida no XSD oficial embutido no tarball.
const built = buildDps(input);
assert.equal(built.id, buildDpsId(input), "Id da DPS diverge do subconjunto ./pure");
assert.deepEqual(validateDpsXml(built.xml), { valid: true });
assert.deepEqual(buildDps(input), built, "Mesma entrada precisa gerar os mesmos bytes");
// Um desvio do esquema é recusado antes de assinar ou enviar.
const broken = validateDpsXml(
  built.xml.replace(/<cTribNac>\d+<\/cTribNac>/, "<cTribNac>X</cTribNac>"),
);
assert.equal(broken.valid, false, "XSD aceitou cTribNac inválido");
assert.throws(
  () => buildDps({ ...input, serv: { ...input.serv, cTribNac: "X" } }),
  (error) => error instanceof NfseError,
);

// Assinatura XMLDSig com chave RSA gerada em memória; nenhum material sai do
// processo. A chave pública basta para a verificação local do pacote.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = {
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  certificatePem: publicKey.export({ type: "spki", format: "pem" }),
};
const signed = signDps(built, keys, "rsa-sha256");
assert.ok(verifySignature(signed, keys.certificatePem), "Assinatura não verificou");
assert.ok(
  !verifySignature(signed.replace("Servico de teste", "Servico alterado"), keys.certificatePem),
);

// Roteamento puro, importado pelo Convex.
const route = resolveRoute({
  municipioIbge: input.cLocEmi,
  regime: "simples-nacional",
  subitem: subitemFromCTribNac(input.serv.cTribNac),
  date: input.dCompet,
});
assert.ok(route.kind, "Roteamento sem resultado");

// DANFSe sintético sobre uma NFS-e no formato do ADN que embute a DPS montada.
const chave = "35503082112223330001810000000000000042260800000001";
const nfse =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${chave}">` +
  `<xLocEmi>São Paulo</xLocEmi><xLocPrestacao>São Paulo</xLocPrestacao><nNFSe>42</nNFSe>` +
  `<xTribNac>Serviço sintético.</xTribNac><ambGer>2</ambGer><cStat>100</cStat>` +
  `<dhProc>2026-08-29T10:00:05-03:00</dhProc>` +
  `<emit><CNPJ>${input.prest.cnpj}</CNPJ><xNome>Prestador Sintético Ltda</xNome></emit>` +
  `<valores><vBC>67.60</vBC><vISSQN>0.00</vISSQN><vLiq>67.60</vLiq></valores>` +
  `${built.xml}</infNFSe></NFSe>`;
const pdf = Buffer.from(await renderDanfse(nfse, { mark: "simulated" }));
assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-", "DANFSe não gerou PDF");

console.log(
  JSON.stringify({
    result: "passed",
    runtime: process.version,
    schemaPackage: NFSE_SCHEMA_PACKAGE,
    dps: { id: built.id, xmlSha256: sha256(built.xml), xsd: "valid", invalidRejected: true },
    signature: { policy: "rsa-sha256", verified: true, tamperRejected: true },
    route,
    danfse: { bytes: pdf.length, mark: "simulated" },
  }),
);
