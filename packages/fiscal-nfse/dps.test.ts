import { describe, expect, it } from "vite-plus/test";
import {
  BACEN_CURRENCY,
  NfseError,
  buildDps,
  buildDpsId,
  competencia,
  dhBrasilia,
  hojeBrasilia,
  type TomaExterior,
  type TomaNacional,
} from "./src/index";
import { campinasInput, exportInput, nationalInput, TOMADOR_CNPJ } from "./tests/inputs";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof NfseError ? error.code : "OTHER";
  }
  return null;
};

describe("buildDpsId", () => {
  it("gera o Id de 45 caracteres com zero à esquerda em série e nDPS", () => {
    const id = buildDpsId(nationalInput);
    expect(id).toBe("DPS355030821122233300018100001000000000000042");
    expect(id).toHaveLength(45);
  });

  it("recusa CNPJ inválido, série e número fora da faixa", () => {
    const prest = { ...nationalInput.prest, cnpj: "11222333000182" };
    expect(code(() => buildDpsId({ ...nationalInput, prest }))).toBe("DPS_FIELD_INVALID");
    expect(code(() => buildDpsId({ ...nationalInput, serie: 100_000 }))).toBe("DPS_FIELD_INVALID");
    expect(code(() => buildDpsId({ ...nationalInput, nDPS: 0 }))).toBe("DPS_FIELD_INVALID");
  });
});

describe("buildDps nacional", () => {
  const { xml, id } = buildDps(nationalInput);

  it("não tem prolog nem pretty-print e declara o namespace e a versão", () => {
    expect(xml.startsWith('<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">')).toBe(
      true,
    );
    expect(xml).not.toContain("\n");
  });

  it("mantém a ordem normativa do cabeçalho", () => {
    expect(xml).toMatch(
      /<tpAmb>2<\/tpAmb><dhEmi>[^<]+<\/dhEmi><verAplic>[^<]+<\/verAplic><serie>1<\/serie><nDPS>42<\/nDPS><dCompet>[^<]+<\/dCompet><tpEmit>1<\/tpEmit><cLocEmi>3550308<\/cLocEmi>/,
    );
  });

  it("série e nDPS sem zeros no XML, só no Id", () => {
    expect(xml).toContain("<serie>1</serie>");
    expect(xml).toContain("<nDPS>42</nDPS>");
    expect(xml).toContain(`<infDPS Id="${id}">`);
  });

  it("endereço do tomador: xLgr/nro/xBairro irmãos de endNac (E1235)", () => {
    expect(xml).toMatch(
      /<end><endNac><cMun>3550308<\/cMun><CEP>01001000<\/CEP><\/endNac><xLgr>Praca da Se<\/xLgr><nro>115<\/nro><xBairro>Centro<\/xBairro><\/end>/,
    );
  });

  it("não envia IM do prestador nem alíquota (E0120/E0625)", () => {
    expect(xml).not.toContain("<IM>");
    expect(xml).not.toContain("pAliq");
  });

  it("com prest.im, <IM> sai entre CNPJ e email (TCInfoPrestador)", () => {
    const prest = { ...nationalInput.prest, im: "ABC123456789012" };
    expect(buildDps({ ...nationalInput, prest }).xml).toContain(
      `<prest><CNPJ>${nationalInput.prest.cnpj}</CNPJ><IM>ABC123456789012</IM><email>`,
    );
  });

  it("recusa prest.im vazia ou acima de 15 caracteres (TSInscMun)", () => {
    for (const im of ["", "   ", "1".repeat(16)])
      expect(
        code(() => buildDps({ ...nationalInput, prest: { ...nationalInput.prest, im } })),
      ).toBe("DPS_FIELD_INVALID");
  });

  it("valores em texto decimal saem com 2 casas e ponto", () => {
    expect(xml).toContain("<vServ>67.60</vServ>");
    expect(xml).toContain("<vTotTribFed>0.00</vTotTribFed>");
  });

  it("tomador CNPJ troca o nome do elemento", () => {
    const toma: TomaNacional = {
      ...(nationalInput.toma as TomaNacional),
      tipo: "CNPJ",
      cpfCnpj: TOMADOR_CNPJ,
    };
    expect(buildDps({ ...nationalInput, toma }).xml).toContain(
      `<toma><CNPJ>${TOMADOR_CNPJ}</CNPJ>`,
    );
  });

  it("escapa texto livre", () => {
    const serv = { ...nationalInput.serv, xDescServ: 'A & B <c> "d"' };
    expect(buildDps({ ...nationalInput, serv }).xml).toContain(
      '<xDescServ>A &amp; B &lt;c&gt; "d"</xDescServ>',
    );
  });

  it("é determinístico", () => {
    expect(buildDps(nationalInput)).toEqual(buildDps(nationalInput));
  });
});

describe("validação de entrada", () => {
  it("recusa valor com casas além do leiaute em vez de arredondar", () => {
    const valores = { ...nationalInput.valores, vServ: "67.605" };
    expect(code(() => buildDps({ ...nationalInput, valores }))).toBe("DECIMAL_PRECISION");
  });

  it("recusa valor negativo, float disfarçado e texto não decimal", () => {
    for (const vServ of ["-1.00", "1e3", "abc", ""]) {
      const valores = { ...nationalInput.valores, vServ };
      expect(code(() => buildDps({ ...nationalInput, valores }))).toBe("DECIMAL_INVALID");
    }
  });

  it("recusa competência posterior à emissão (E0015)", () => {
    expect(code(() => buildDps({ ...nationalInput, dCompet: "2026-08-30" }))).toBe(
      "DPS_COMPETENCE_FUTURE",
    );
  });

  it("recusa data inexistente em dCompet e dhEmi, e tpAmb fora de 1/2", () => {
    expect(code(() => buildDps({ ...nationalInput, dCompet: "2026-02-30" }))).toBe(
      "DPS_FIELD_INVALID",
    );
    expect(code(() => buildDps({ ...nationalInput, dhEmi: "2026-02-30T10:00:00-03:00" }))).toBe(
      "DPS_FIELD_INVALID",
    );
    expect(code(() => buildDps({ ...nationalInput, tpAmb: 3 as 1 }))).toBe("DPS_FIELD_INVALID");
  });

  it("verAplic tem de 1 a 20 caracteres (TSVerAplic)", () => {
    expect(buildDps({ ...nationalInput, verAplic: "a".repeat(20) }).xml).toContain(
      `<verAplic>${"a".repeat(20)}</verAplic>`,
    );
    for (const verAplic of ["", " ", "freecorpsNFE-plataforma/1"])
      expect(code(() => buildDps({ ...nationalInput, verAplic }))).toBe("DPS_FIELD_INVALID");
  });

  it("recusa caractere de controle", () => {
    const serv = { ...nationalInput.serv, xDescServ: "a\u0001b" };
    expect(code(() => buildDps({ ...nationalInput, serv }))).toBe("XML_CHAR_INVALID");
  });
});

describe("Campinas (padrão nacional, XSD 1.01)", () => {
  const { xml } = buildDps(campinasInput);

  it("cServ na ordem cTribNac, cTribMun, xDescServ, cNBS", () => {
    expect(xml).toMatch(
      /<cServ><cTribNac>010501<\/cTribNac><cTribMun>001<\/cTribMun><xDescServ>[^<]+<\/xDescServ><cNBS>111032200<\/cNBS><\/cServ>/,
    );
  });

  it("sem <dest> quando o destinatário é o tomador (indDest 0, E0910)", () => {
    expect(xml).not.toContain("<dest>");
    expect(xml).toMatch(/<\/toma><serv>/);
  });

  it("tribMun na ordem do XSD: tpRetISSQN e depois pAliq (2 casas), sem cLocIncid", () => {
    expect(xml).toMatch(
      /<tribMun><tribISSQN>1<\/tribISSQN><tpRetISSQN>2<\/tpRetISSQN><pAliq>2\.00<\/pAliq><\/tribMun>/,
    );
    expect(xml).not.toContain("cLocIncid");
  });

  it("alíquota decimal em texto até 2 casas (TSDec1V2)", () => {
    const valores = { ...campinasInput.valores, pAliq: "2.5" };
    expect(buildDps({ ...campinasInput, valores }).xml).toContain("<pAliq>2.50</pAliq>");
    const zeros = { ...campinasInput.valores, pAliq: "2.0100" };
    expect(buildDps({ ...campinasInput, valores: zeros }).xml).toContain("<pAliq>2.01</pAliq>");
    const excess = { ...campinasInput.valores, pAliq: "2.125" };
    expect(code(() => buildDps({ ...campinasInput, valores: excess }))).toBe("DECIMAL_PRECISION");
  });

  it("IBSCBS é o último grupo de infDPS", () => {
    expect(xml).toMatch(
      /<IBSCBS><finNFSe>0<\/finNFSe><cIndOp>100501<\/cIndOp><indDest>0<\/indDest><valores><trib><gIBSCBS><CST>000<\/CST><cClassTrib>000001<\/cClassTrib><\/gIBSCBS><\/trib><\/valores><\/IBSCBS><\/infDPS>/,
    );
  });

  it("destinatário diferente (indDest 1): <dest> dentro de IBSCBS, logo após indDest", () => {
    const dest = { ...(campinasInput.toma as TomaNacional), xNome: "Destinatário Sintético" };
    const ibsCbs = { ...campinasInput.ibsCbs!, indDest: 1 as const };
    const withDest = buildDps({ ...campinasInput, dest, ibsCbs }).xml;
    expect(withDest).toMatch(
      new RegExp(`<indDest>1</indDest><dest><CNPJ>${TOMADOR_CNPJ}</CNPJ><xNome>Destinatário`),
    );
    expect(withDest).toMatch(/<\/dest><valores><trib><gIBSCBS>/);
  });

  it("recusa dest com indDest 0 e indDest 1 sem dest", () => {
    expect(code(() => buildDps({ ...campinasInput, dest: campinasInput.toma }))).toBe(
      "DPS_FIELD_INVALID",
    );
    const ibsCbs = { ...campinasInput.ibsCbs!, indDest: 1 as const };
    expect(code(() => buildDps({ ...campinasInput, ibsCbs }))).toBe("DPS_FIELD_INVALID");
    expect(code(() => buildDps({ ...nationalInput, dest: nationalInput.toma }))).toBe(
      "DPS_FIELD_INVALID",
    );
  });

  it("sem ibsCbs/pAliq os grupos são omitidos (compatível com a Sefin)", () => {
    const national = buildDps({
      ...campinasInput,
      serv: { ...campinasInput.serv, cTribMun: undefined, cNBS: undefined },
      valores: { ...campinasInput.valores, pAliq: undefined, tpRetISSQN: 1 },
      ibsCbs: undefined,
    }).xml;
    for (const tag of ["<dest>", "<IBSCBS>", "<pAliq>", "<cNBS>"])
      expect(national).not.toContain(tag);
  });
});

describe("exportação (tomador no exterior)", () => {
  const { xml } = buildDps(exportInput);

  it("tomador com NIF e endereço em endExt (logradouro irmão de endExt)", () => {
    expect(xml).toContain("<toma><NIF>98-7654321</NIF><xNome>Example Grocery LLC</xNome>");
    expect(xml).toMatch(
      /<end><endExt><cPais>US<\/cPais><cEndPost>94105<\/cEndPost><xCidade>San Francisco<\/xCidade><xEstProvReg>CA<\/xEstProvReg><\/endExt><xLgr>Market St<\/xLgr><nro>548<\/nro><xBairro>SoMa<\/xBairro><\/end>/,
    );
    expect(xml).not.toContain("<endNac>");
  });

  it("tribISSQN=3 com cPaisResult, sem alíquota", () => {
    expect(xml).toContain("<tribISSQN>3</tribISSQN><cPaisResult>US</cPaisResult>");
    expect(xml).not.toContain("pAliq");
  });

  it("comExt depois de cServ, na ordem normativa e com valor na moeda original", () => {
    expect(xml).toMatch(
      /<\/cServ><comExt><mdPrestacao>1<\/mdPrestacao><vincPrest>0<\/vincPrest><tpMoeda>220<\/tpMoeda><vServMoeda>49\.00<\/vServMoeda><mecAFComexP>01<\/mecAFComexP><mecAFComexT>01<\/mecAFComexT><movTempBens>1<\/movTempBens><mdic>0<\/mdic><\/comExt>/,
    );
  });

  it("tabela BACEN cobre as moedas do legado", () => {
    expect(BACEN_CURRENCY).toEqual({ USD: "220", CAD: "165", EUR: "978", GBP: "540" });
  });

  it("tomador sem NIF usa cNaoNIF, com o endereço completo", () => {
    const toma: TomaExterior = {
      tipo: "semNIF",
      cNaoNIF: 2,
      xNome: "John Doe",
      cPais: "GB",
      cEndPost: "SW1A 1AA",
      xCidade: "London",
      xEstProvReg: "Greater London",
      xLgr: "Synthetic Road",
      nro: "1",
      xBairro: "Westminster",
    };
    const { xml: semNif } = buildDps({ ...exportInput, toma });
    expect(semNif).toContain("<toma><cNaoNIF>2</cNaoNIF><xNome>John Doe</xNome>");
    expect(semNif).toContain(
      "<endExt><cPais>GB</cPais><cEndPost>SW1A 1AA</cEndPost><xCidade>London</xCidade><xEstProvReg>Greater London</xEstProvReg></endExt><xLgr>Synthetic Road</xLgr><nro>1</nro><xBairro>Westminster</xBairro>",
    );
  });

  it("recusa endereço no exterior incompleto ou longo (TCEnderExt/TCEndereco)", () => {
    const toma = exportInput.toma as TomaExterior;
    for (const field of ["cEndPost", "xEstProvReg", "xLgr", "nro", "xBairro"] as const) {
      for (const value of [undefined, "", "  "]) {
        const partial = { ...toma, [field]: value } as TomaExterior;
        expect(code(() => buildDps({ ...exportInput, toma: partial }))).toBe("DPS_FIELD_INVALID");
      }
    }
    const limits = { cEndPost: 11, xCidade: 60, xEstProvReg: 60, xLgr: 255, nro: 60, xBairro: 60 };
    for (const [field, max] of Object.entries(limits)) {
      const fits = { ...toma, [field]: "a".repeat(max) } as TomaExterior;
      expect(buildDps({ ...exportInput, toma: fits }).id).toBeTruthy();
      const long = { ...toma, [field]: "a".repeat(max + 1) } as TomaExterior;
      expect(code(() => buildDps({ ...exportInput, toma: long }))).toBe("DPS_FIELD_INVALID");
    }
  });

  it("ISS não incidente (tribISSQN=4) sai sem cPaisResult", () => {
    const valores = { ...exportInput.valores, tribISSQN: 4 as const, cPaisResult: undefined };
    const { xml: naoIncidente } = buildDps({ ...exportInput, valores });
    expect(naoIncidente).toContain("<tribISSQN>4</tribISSQN><tpRetISSQN>1</tpRetISSQN>");
  });

  it("recusa exportação sem cPaisResult e tomador exterior sem comExt", () => {
    const valores = { ...exportInput.valores, cPaisResult: undefined };
    expect(code(() => buildDps({ ...exportInput, valores }))).toBe("DPS_EXPORT_COUNTRY");
    for (const cPaisResult of ["us", "USA", "U1"]) {
      const malformed = { ...exportInput.valores, cPaisResult };
      expect(code(() => buildDps({ ...exportInput, valores: malformed }))).toBe(
        "DPS_FIELD_INVALID",
      );
    }
    const serv = { ...exportInput.serv, comExt: undefined };
    expect(code(() => buildDps({ ...exportInput, serv }))).toBe("DPS_EXPORT_COMEXT");
  });
});

describe("substituição", () => {
  it("<subst> entra entre cLocEmi e prest", () => {
    const ch = "3".repeat(50);
    const { xml } = buildDps({ ...exportInput, subst: { chSubstda: ch, cMotivo: "01" } });
    expect(xml).toContain(
      `<cLocEmi>3550308</cLocEmi><subst><chSubstda>${ch}</chSubstda><cMotivo>01</cMotivo></subst><prest>`,
    );
  });

  it("cMotivo 99 exige xMotivo", () => {
    const subst = { chSubstda: "3".repeat(50), cMotivo: "99" };
    expect(code(() => buildDps({ ...exportInput, subst }))).toBe("DPS_FIELD_INVALID");
  });
});

describe("datas sem relógio implícito", () => {
  it("dhBrasilia usa offset -03:00 fixo", () => {
    expect(dhBrasilia(new Date("2026-08-29T12:34:56.789Z"))).toBe("2026-08-29T09:34:56-03:00");
  });

  it("hojeBrasilia devolve a data civil de Brasília", () => {
    expect(hojeBrasilia(new Date("2026-08-29T01:30:00Z"))).toBe("2026-08-28");
    expect(hojeBrasilia(new Date("2026-08-29T12:00:00Z"))).toBe("2026-08-29");
  });

  it("competencia devolve o último dia do mês, inclusive fevereiro bissexto", () => {
    expect(competencia(2026, 7)).toBe("2026-07-31");
    expect(competencia(2026, 2)).toBe("2026-02-28");
    expect(competencia(2028, 2)).toBe("2028-02-29");
    expect(competencia(2026, 12)).toBe("2026-12-31");
    expect(code(() => competencia(2026, 13))).toBe("DPS_FIELD_INVALID");
  });
});
