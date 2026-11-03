/**
 * Entradas sintéticas. CNPJs e CPF são números de exemplo com dígitos
 * válidos, sem relação com clientes; o certificado é autoassinado em memória.
 */
import { syntheticCertificate } from "../../../tests/helpers/certificates";
import { COM_EXT_DEFAULTS, type DpsInput, type SignerKeys } from "../src/index";

export const PRESTADOR_CNPJ = "11222333000181";
export const TOMADOR_CNPJ = "11444777000161";

let keys: SignerKeys | undefined;
export function signerKeys(): SignerKeys {
  if (!keys) {
    const certificate = syntheticCertificate({ cnpj: PRESTADOR_CNPJ });
    keys = { privateKeyPem: certificate.key, certificatePem: certificate.cert };
  }
  return keys;
}

export const nationalInput: DpsInput = {
  tpAmb: 2,
  dhEmi: "2026-08-29T10:00:00-03:00",
  verAplic: "FiscalNfseTest_1.0",
  serie: 1,
  nDPS: 42,
  dCompet: "2026-07-31",
  cLocEmi: "3550308",
  prest: {
    cnpj: PRESTADOR_CNPJ,
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
  serv: {
    cLocPrestacao: "3550308",
    cTribNac: "100202",
    xDescServ: "Servico de teste",
  },
  valores: {
    vServ: "67.6",
    tribISSQN: 1,
    tpRetISSQN: 1,
    vTotTribFed: "0",
    vTotTribEst: "0",
    vTotTribMun: "0",
  },
};

/** Campinas: cTribMun, cNBS, pAliq e o grupo IBSCBS (destinatário = tomador). */
export const campinasInput: DpsInput = {
  ...nationalInput,
  serie: 10001,
  nDPS: 1,
  dCompet: "2026-08-20",
  cLocEmi: "3509502",
  toma: {
    tipo: "CNPJ",
    cpfCnpj: TOMADOR_CNPJ,
    xNome: "Tomador Sintético Ltda",
    cMun: "3509502",
    cep: "13000000",
    xLgr: "Rua Exemplo",
    nro: "10",
    xBairro: "Bairro Exemplo",
    email: "fiscal@tomador.example",
  },
  serv: {
    cLocPrestacao: "3509502",
    cTribNac: "010501",
    cTribMun: "001",
    xDescServ: "Licenciamento de software (teste)",
    cNBS: "111032200",
  },
  valores: {
    vServ: "397",
    tribISSQN: 1,
    tpRetISSQN: 2,
    pAliq: "2",
    vTotTribFed: "0",
    vTotTribEst: "0",
    vTotTribMun: "7.94",
  },
  ibsCbs: { finNFSe: 0, cIndOp: "100501", indDest: 0, cst: "000", cClassTrib: "000001" },
};

/** Exportação: tomador fictício nos EUA, valor em USD. */
export const exportInput: DpsInput = {
  ...nationalInput,
  nDPS: 99,
  dCompet: "2026-08-29",
  toma: {
    tipo: "NIF",
    nif: "98-7654321",
    xNome: "Example Grocery LLC",
    cPais: "US",
    cEndPost: "94105",
    xCidade: "San Francisco",
    xEstProvReg: "CA",
    xLgr: "Market St",
    nro: "548",
    xBairro: "SoMa",
    email: "billing@grocery.example",
  },
  serv: {
    cLocPrestacao: "3550308",
    cTribNac: "100202",
    xDescServ: "Assinatura de software - agosto/2026",
    comExt: { ...COM_EXT_DEFAULTS, tpMoeda: "220", vServMoeda: "49" },
  },
  valores: {
    vServ: "269.50",
    tribISSQN: 3,
    cPaisResult: "US",
    tpRetISSQN: 1,
    vTotTribFed: "0",
    vTotTribEst: "0",
    vTotTribMun: "0",
  },
};
