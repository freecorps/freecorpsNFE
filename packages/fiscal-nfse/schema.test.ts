/**
 * Prova contra os XSD oficiais da NFS-e nacional (pacotes v1.01-20260209 e da
 * produção restrita de 20/10/2026, do Portal NFS-e, em `schemas/`). Dados
 * sintéticos; nada aqui prova autorização.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import manifest from "./schemas/manifest.json" with { type: "json" };
import catalog from "./src/schemas.json" with { type: "json" };
import { loadSchemaText } from "./src/schema";
import {
  COM_EXT_DEFAULTS,
  DPS_LAYOUTS,
  NfseError,
  buildCancelEvent,
  buildDps,
  nacional,
  signDps,
  signEvent,
  validateDpsXml,
  validatePedRegEventoXml,
  type CancelEventInput,
  type DpsInput,
  type SchemaResult,
  type TomaExterior,
  type TomaNacional,
} from "./src/index";
import {
  PRESTADOR_CNPJ,
  campinasInput,
  exportInput,
  nationalInput,
  signerKeys,
} from "./tests/inputs";

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof NfseError ? error.code : "OTHER";
  }
  return null;
};
const elements = (result: SchemaResult) =>
  result.valid ? [] : result.issues.map((i) => i.element);

/**
 * Equivalente sintético da DPS rejeitada na prova real de 09/10/2026 (L9999):
 * exportação pelo canal campinas-adn, tomador nos EUA sem NIF, valor em USD,
 * série 20001, cTribMun, cNBS e IBSCBS. Nenhum dado do tomador real.
 */
const rejectedEquivalent: DpsInput = {
  ...campinasInput,
  dhEmi: "2026-10-09T10:00:00-03:00",
  dCompet: "2026-10-09",
  serie: 20001,
  nDPS: 1,
  toma: {
    tipo: "semNIF",
    cNaoNIF: 2,
    xNome: "Synthetic Buyer Inc.",
    cPais: "US",
    cEndPost: "10001",
    xCidade: "New York",
    xEstProvReg: "NY",
    xLgr: "Synthetic Avenue",
    nro: "100",
    xBairro: "N/A",
    email: "billing@buyer.example",
  },
  serv: {
    ...campinasInput.serv,
    xDescServ: "Licenciamento de software (exportação sintética)",
    comExt: { ...COM_EXT_DEFAULTS, tpMoeda: "220", vServMoeda: "100.00" },
  },
  valores: {
    vServ: "541.23",
    tribISSQN: 3,
    cPaisResult: "US",
    tpRetISSQN: 1,
    vTotTribFed: "0.00",
    vTotTribEst: "0.00",
    vTotTribMun: "0.00",
  },
};

const cancelInput: CancelEventInput = {
  tpAmb: 2,
  verAplic: "freecorpsNFE/1",
  dhEvento: "2026-10-09T11:00:00-03:00",
  cnpjAutor: PRESTADOR_CNPJ,
  chNFSe: "3".repeat(50),
  cMotivo: "1",
  xMotivo: "Erro na emissão da nota sintética",
};

const BOM = String.fromCharCode(0xfeff);
describe("XSD oficial incorporado", () => {
  it("os originais conferem com o manifesto, byte a byte", () => {
    expect(manifest.sources).toEqual([
      expect.objectContaining({
        id: "nfse-1.01-20260209",
        archiveSha256: "e7935cbd9470527c6cc32984c1b2263e614183bf0139ce2733eaaed2de9a8072",
      }),
      expect.objectContaining({
        id: "nfse-1.01-prodrest-20261020",
        archiveSha256: "25fdcecc651a67a216496ab10d7566631e6ed10f721e37d62c7845dadb0ea267",
      }),
    ]);
    expect(manifest.sources.map((source) => source.id)).toEqual([...DPS_LAYOUTS]);
    for (const file of manifest.files) {
      const raw = readFileSync(new URL(`./schemas/${file.path}`, import.meta.url));
      expect(sha256(raw), file.path).toBe(file.sha256);
    }
  });

  it("o catálogo distribuído traz os originais intactos (CC BY-ND)", () => {
    const distributed = catalog as Record<string, string>;
    expect(Object.keys(distributed).sort()).toEqual(manifest.files.map((f) => f.path).sort());
    for (const file of manifest.files) {
      const raw = readFileSync(new URL(`./schemas/${file.path}`, import.meta.url));
      expect(Buffer.from(distributed[file.path]!, "utf8").equals(raw), file.path).toBe(true);
      expect(file.runtimeUtf8Sha256, file.path).toBe(file.sha256);
    }
  });

  it("só ao carregar sai o BOM e o patch registrado de TSSerieDPS", () => {
    for (const file of manifest.files) {
      const original = (catalog as Record<string, string>)[file.path]!;
      const loaded = loadSchemaText(file.path, original);
      const withoutBom = original.startsWith(BOM) ? original.slice(1) : original;
      expect(original.startsWith(BOM), file.path).toBe(file.byteOrderMark);
      expect("loadTimeAdjustment" in file, file.path).toBe(loaded !== withoutBom);
      expect(loaded, file.path).toBe(
        withoutBom.replace(
          '<xs:pattern value="^0{0,4}\\d{1,5}$"/>',
          '<xs:pattern value="0{0,4}\\d{1,5}"/>',
        ),
      );
    }
    expect(() =>
      loadSchemaText("nfse-1.01-20260209/tiposSimples_v1.01.xsd", "<xs:schema/>"),
    ).toThrow("TSSerieDPS");
  });

  it("série: o padrão oficial tem âncoras literais; a cópia de runtime aceita 1 a 99999", () => {
    expect(validateDpsXml(buildDps({ ...nationalInput, serie: 1 }).xml)).toEqual({ valid: true });
    expect(validateDpsXml(buildDps({ ...nationalInput, serie: 99_999 }).xml)).toEqual({
      valid: true,
    });
    const xml = buildDps(nationalInput).xml.replace("<serie>1</serie>", "<serie>123456</serie>");
    expect(new Set(elements(validateDpsXml(xml)))).toEqual(new Set(["serie"]));
  });
});

describe("DPS no XSD oficial", () => {
  const destinatario: TomaNacional = {
    ...(campinasInput.toma as TomaNacional),
    xNome: "Destinatário Sintético",
  };
  const fixtures: Record<string, DpsInput> = {
    nacional: nationalInput,
    // Não optante na Sefin com o grupo exigido pelo Ato Conjunto 4/2026 (#338): sem cTribMun,
    // IM nem pAliq de Campinas, com o IBSCBS no fim de infDPS.
    "sefin, não optante com IBSCBS": {
      ...nationalInput,
      dhEmi: "2026-10-15T10:00:00-03:00",
      dCompet: "2026-10-15",
      prest: {
        cnpj: PRESTADOR_CNPJ,
        email: "fiscal@prestador.example",
        opSimpNac: 1,
        regEspTrib: 0,
      },
      valores: { ...nationalInput.valores, pAliq: "2.5", vTotTribMun: "1.69" },
      ibsCbs: { finNFSe: 0, cIndOp: "100501", indDest: 0, cst: "000", cClassTrib: "000001" },
    },
    campinas: campinasInput,
    "campinas com IM do prestador": {
      ...campinasInput,
      prest: { ...campinasInput.prest, im: "123456789012345" },
    },
    "campinas com destinatário (indDest 1)": {
      ...campinasInput,
      dest: destinatario,
      ibsCbs: { ...campinasInput.ibsCbs!, indDest: 1 },
    },
    exportação: exportInput,
    "exportação sem NIF": {
      ...exportInput,
      toma: { ...(exportInput.toma as TomaExterior), tipo: "semNIF", nif: undefined, cNaoNIF: 1 },
    },
    substituição: { ...exportInput, subst: { chSubstda: "3".repeat(50), cMotivo: "01" } },
    "substituição 99": {
      ...nationalInput,
      subst: { chSubstda: "3".repeat(50), cMotivo: "99", xMotivo: "Correção sintética" },
    },
    "exportação equivalente à rejeitada em 09/10": rejectedEquivalent,
  };

  for (const [name, input] of Object.entries(fixtures))
    it(`${name}: passa sem assinatura e assinada (RSA-SHA256 e RSA-SHA1)`, () => {
      const built = buildDps(input);
      expect(validateDpsXml(built.xml)).toEqual({ valid: true });
      for (const policy of ["rsa-sha256", "rsa-sha1"] as const)
        expect(validateDpsXml(signDps(built, signerKeys(), policy))).toEqual({ valid: true });
    });

  const NT009 = "nfse-1.01-prodrest-20261020" as const;
  for (const [name, input] of Object.entries(fixtures))
    it(`${name}, leiaute da NT 009 (produção restrita): passa sem assinatura e assinada`, () => {
      const built = buildDps({ ...input, layout: NT009 });
      expect(validateDpsXml(built.xml, NT009)).toEqual({ valid: true });
      expect(validateDpsXml(signDps(built, signerKeys(), "rsa-sha256"), NT009)).toEqual({
        valid: true,
      });
      // Cada leiaute é recusado pelo XSD do outro: não há DPS que sirva aos dois.
      expect(validateDpsXml(built.xml).valid).toBe(false);
      expect(validateDpsXml(buildDps(input).xml, NT009).valid).toBe(false);
    });

  it("o leiaute de produção na produção restrita reproduz a recusa E1235 de 02/11/2026", () => {
    const result = validateDpsXml(buildDps(nationalInput).xml, NT009);
    expect(elements(result)).toEqual(["cLocEmi"]);
    expect(result.valid ? "" : result.issues[0]!.message).toMatch(/cMotivoEmisTI, finNFSe/);
  });

  it("NT 009: finNFSe em infDPS, xDescServ depois de cNBS, CST e cClassTrib direto em trib", () => {
    const { xml } = buildDps({ ...campinasInput, layout: NT009 });
    expect(xml).toContain("<tpEmit>1</tpEmit><finNFSe>0</finNFSe><cLocEmi>");
    expect(xml).toMatch(/<cNBS>111032200<\/cNBS><xDescServ>[^<]+<\/xDescServ><\/cServ>/);
    expect(xml).toContain("<IBSCBS><cIndOp>");
    expect(xml).toMatch(/<trib><CST>\d{3}<\/CST><cClassTrib>\d{6}<\/cClassTrib><\/trib>/);
    expect(xml).not.toContain("<gIBSCBS>");
    expect(xml.match(/<finNFSe>/g)).toHaveLength(1);
    // Sem o grupo IBSCBS a finalidade continua informada (obrigatória no leiaute).
    expect(buildDps({ ...nationalInput, layout: NT009 }).xml).toContain("<finNFSe>0</finNFSe>");
    expect(code(() => buildDps({ ...nationalInput, layout: "x" as typeof NT009 }))).toBe(
      "DPS_FIELD_INVALID",
    );
  });

  it("a exportação equivalente leva endExt completo, USD, série 20001 e o grupo IBSCBS", () => {
    const { xml } = buildDps(rejectedEquivalent);
    expect(xml).toContain("<serie>20001</serie>");
    expect(xml).toContain(
      "<toma><cNaoNIF>2</cNaoNIF><xNome>Synthetic Buyer Inc.</xNome><end><endExt><cPais>US</cPais><cEndPost>10001</cEndPost><xCidade>New York</xCidade><xEstProvReg>NY</xEstProvReg></endExt><xLgr>Synthetic Avenue</xLgr><nro>100</nro><xBairro>N/A</xBairro></end>",
    );
    expect(xml).toContain("<tpMoeda>220</tpMoeda>");
    expect(xml).toMatch(/<cTribMun>001<\/cTribMun>.*<cNBS>111032200<\/cNBS>/);
    expect(xml).toMatch(/<IBSCBS>.*<\/IBSCBS><\/infDPS>/);
  });

  it("a mesma DPS sem xBairro e com verAplic de 25 caracteres falha no XSD", () => {
    const { xml } = buildDps(rejectedEquivalent);
    const semBairro = xml.replace("<xBairro>N/A</xBairro>", "");
    expect(elements(validateDpsXml(semBairro))).toEqual(["end"]);
    const verAplic = xml.replace(
      /<verAplic>[^<]+<\/verAplic>/,
      "<verAplic>freecorpsNFE-plataforma/1</verAplic>",
    );
    const result = validateDpsXml(verAplic);
    expect(elements(result)).toEqual(["verAplic"]);
    expect(result.valid ? "" : result.issues[0]!.message).toMatch(/maxLength/);
    expect(
      elements(
        validateDpsXml(
          semBairro.replace(/<verAplic>[^<]+</, "<verAplic>freecorpsNFE-plataforma/1<"),
        ),
      ),
    ).toEqual(["verAplic", "end"]);
  });

  it("o pacote recusa a mesma montagem antes do XSD (campo e tamanho)", () => {
    const toma = { ...(rejectedEquivalent.toma as TomaExterior), xBairro: "" };
    expect(code(() => buildDps({ ...rejectedEquivalent, toma }))).toBe("DPS_FIELD_INVALID");
    expect(
      code(() => buildDps({ ...rejectedEquivalent, verAplic: "freecorpsNFE-plataforma/1" })),
    ).toBe("DPS_FIELD_INVALID");
  });

  it("o que só o XSD pega vira DPS_SCHEMA_INVALID na montagem, com o elemento", () => {
    const longa = { ...nationalInput.serv, xDescServ: "a".repeat(2001) };
    let error: unknown;
    try {
      buildDps({ ...nationalInput, serv: longa });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NfseError);
    expect((error as NfseError).code).toBe("DPS_SCHEMA_INVALID");
    expect((error as NfseError).message).toMatch(/xDescServ/);
    // TSString: sem espaço nas pontas.
    const toma = { ...(nationalInput.toma as TomaNacional), xBairro: " Centro" };
    expect(code(() => buildDps({ ...nationalInput, toma }))).toBe("DPS_SCHEMA_INVALID");
  });

  it("raiz errada e XML malformado não passam", () => {
    expect(validateDpsXml(buildCancelEvent(cancelInput).xml).valid).toBe(false);
    expect(validateDpsXml("<DPS").valid).toBe(false);
  });

  it("nacional.issue não transmite DPS fora do XSD", async () => {
    let calls = 0;
    const outcome = await nacional.issue(
      { dps: { ...nationalInput, serv: { ...nationalInput.serv, xDescServ: "a".repeat(2001) } } },
      {
        signer: signerKeys(),
        target: { id: "sefin-nacional", environment: "producao-restrita" },
        transport: async () => {
          calls++;
          return { status: 500, body: "" };
        },
      },
    );
    expect(outcome).toMatchObject({ kind: "definitive", code: "DPS_SCHEMA_INVALID", sent: false });
    expect(calls).toBe(0);
  });
});

describe("pedido de registro de evento no XSD oficial", () => {
  it("cancelamento passa sem assinatura e assinado", () => {
    const built = buildCancelEvent(cancelInput);
    expect(validatePedRegEventoXml(built.xml)).toEqual({ valid: true });
    for (const policy of ["rsa-sha256", "rsa-sha1"] as const)
      expect(validatePedRegEventoXml(signEvent(built, signerKeys(), policy))).toEqual({
        valid: true,
      });
  });

  it("verAplic acima de 20 e nPedRegEvento (fora do XSD) falham", () => {
    expect(code(() => buildCancelEvent({ ...cancelInput, verAplic: "x".repeat(21) }))).toBe(
      "EVENT_FIELD_INVALID",
    );
    const { xml } = buildCancelEvent(cancelInput);
    const longo = xml.replace(/<verAplic>[^<]+</, `<verAplic>${"x".repeat(21)}<`);
    expect(elements(validatePedRegEventoXml(longo))).toEqual(["verAplic"]);
    const legado = xml.replace("</chNFSe>", "</chNFSe><nPedRegEvento>1</nPedRegEvento>");
    expect(elements(validatePedRegEventoXml(legado))).toEqual(["nPedRegEvento"]);
  });
});
