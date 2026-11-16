import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { describe, expect, it } from "vite-plus/test";
import { inspectPdf } from "../../tests/helpers/pdf";
import { buildDps, type DpsInput } from "./src/index";
import { breakLines } from "./src/lineBreak";
import { consultaPublicaUrl, formatDecimal, readNfseForDanfse, renderDanfse } from "./src/danfse";
import { campinasInput, exportInput, nationalInput } from "./tests/inputs";

/**
 * NFS-e sintética no formato do ADN: infNFSe com o grupo emit, valores calculados
 * e a DPS embutida. Chave, nomes e valores são fictícios; nada aqui foi autorizado.
 */
const CHAVE = "35503082112223330001810000000000000042260800000001";
/**
 * `inspectPdf` measures text boxes without rotation, so the diagonal watermark looks wider
 * than it is; its geometry is centered on the page in the renderer. Everything else must fit.
 */
const outside = (pages: Array<{ outside: string[] }>) =>
  pages.flatMap((p) => p.outside).filter((item) => item !== "SIMULADA");
/** Nomes que o fisco devolve na NFS-e para os municípios das entradas sintéticas. */
const NAMES: Record<string, string> = { "3509502": "Campinas", "3550308": "São Paulo" };
function nfseXml(dps: DpsInput, extra = "", tail = "") {
  const inner = buildDps(dps).xml;
  const emi = dps.cLocEmi,
    prestacao = dps.serv.cLocPrestacao;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${CHAVE}">` +
    `<xLocEmi>${NAMES[emi]}</xLocEmi><xLocPrestacao>${NAMES[prestacao]}</xLocPrestacao>` +
    `<nNFSe>42</nNFSe><cLocIncid>${prestacao}</cLocIncid><xLocIncid>${NAMES[prestacao]}</xLocIncid>` +
    `<xTribNac>Licenciamento ou cessão de direito de uso de programas de computação.</xTribNac>` +
    `<verAplic>SefinNac</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis><cStat>100</cStat>` +
    `<dhProc>2026-08-29T10:00:05-03:00</dhProc><nDFSe>1</nDFSe>` +
    `<emit><CNPJ>${dps.prest.cnpj}</CNPJ><IM>12345</IM><xNome>Prestador Sintético Ltda</xNome>` +
    `<enderNac><xLgr>Rua do Prestador</xLgr><nro>100</nro><xCpl>Sala 2</xCpl>` +
    `<xBairro>Centro</xBairro><cMun>${emi}</cMun><UF>SP</UF><CEP>13010000</CEP></enderNac>` +
    `<fone>1930000000</fone></emit>` +
    `<valores><vBC>${dps.valores.vServ}</vBC><pAliqAplic>2.00</pAliqAplic><vISSQN>7.94</vISSQN>` +
    `<vTotalRet>7.94</vTotalRet><vLiq>389.06</vLiq></valores>` +
    extra +
    `${inner}${tail}</infNFSe></NFSe>`
  );
}
/** Grupo IBSCBS calculado pelo fisco, com valores fictícios. */
const IBSCBS_NFSE =
  `<IBSCBS><cLocalidadeIncid>3509502</cLocalidadeIncid><xLocalidadeIncid>Campinas</xLocalidadeIncid>` +
  `<valores><vBC>389.06</vBC><uf><pIBSUF>0.10</pIBSUF><pAliqEfetUF>0.10</pAliqEfetUF></uf>` +
  `<mun><pIBSMun>0.00</pIBSMun><pAliqEfetMun>0.00</pAliqEfetMun></mun>` +
  `<fed><pCBS>0.90</pCBS><pRedAliqCBS>10.00</pRedAliqCBS><pAliqEfetCBS>0.81</pAliqEfetCBS></fed></valores>` +
  `<totCIBS><vTotNF>392.87</vTotNF><gIBS><vIBSTot>0.39</vIBSTot><gIBSUFTot><vIBSUF>0.39</vIBSUF></gIBSUFTot>` +
  `<gIBSMunTot><vIBSMun>0.00</vIBSMun></gIBSMunTot></gIBS><gCBS><vCBS>3.42</vCBS></gCBS></totCIBS></IBSCBS>`;

/** Rótulos dos campos obrigatórios da NT 008 v1.02 (itens 2.1.2 a 2.1.12), como no Anexo I. */
const NT008_LABELS = [
  "DANFSe v2.0",
  "Documento Auxiliar da NFS-e",
  "Ambiente Gerador:",
  "Tipo de Ambiente:",
  "CHAVE DE ACESSO DA NFS-E",
  "NÚMERO DA NFS-E",
  "COMPETÊNCIA DA NFS-E",
  "DATA E HORA DA EMISSÃO DA NFS-E",
  "NÚMERO DA DPS",
  "SÉRIE DA DPS",
  "DATA E HORA DA EMISSÃO DA DPS",
  "EMITENTE DA NFS-E",
  "SITUAÇÃO DA NFS-E",
  "FINALIDADE",
  "A autenticidade desta NFS-e pode ser verificada",
  "PRESTADOR / FORNECEDOR",
  "CNPJ / CPF / NIF",
  "Indicador Municipal (Inscrição)",
  "Telefone",
  "Nome / Nome Empresarial",
  "Município / Sigla UF",
  "Código IBGE / CEP",
  "Endereço",
  "E-mail",
  "Simples Nacional na Data de Competência",
  "Regime de Apuração Tributária pelo SN",
  "TOMADOR / ADQUIRENTE",
  "SERVIÇO PRESTADO",
  "Código de Tributação Nacional / Municipal",
  "Código da NBS",
  "Local da Prestação / Sigla UF / País",
  "Descrição do Serviço",
  "TRIBUTAÇÃO MUNICIPAL (ISSQN)",
  "Tipo de Tributação do ISSQN",
  "Município / Sigla UF / País de Incidência do ISSQN",
  "Regime Especial de Tributação do ISSQN",
  "Tipo de Imunidade do ISSQN",
  "Suspensão da Exigibilidade do ISSQN",
  "Número Processo Suspensão",
  "BC ISSQN",
  "Alíquota Aplicada",
  "Retenção do ISSQN",
  "ISSQN Apurado",
  "TRIBUTAÇÃO FEDERAL (EXCETO CBS)",
  "IRRF",
  "Contribuição Previdenciária - Retida",
  "Contribuições Sociais - Retidas",
  "PIS - Débito Apuração Própria",
  "COFINS - Débito Apuração Própria",
  "Descrição Contrib. Sociais - Retidas",
  "TRIBUTAÇÃO IBS / CBS",
  "CST / cClassTrib",
  "Indicador de Operação / Código IBGE Incidência / Município Incidência / Sigla UF",
  "Exclusões e Reduções da Base de Cálculo",
  "Base de Cálculo Após Exclusões e Reduções",
  "Red. Alíquota IBS / Red. Alíquota CBS",
  "Alíquota - IBS UF / IBS Mun",
  "Alíq. Efetiva Municipal - IBS",
  "Valor Apurado Municipal - IBS",
  "Alíq. Efetiva Estadual - IBS",
  "Valor Apurado Estadual - IBS",
  "Valor Total Apurado - IBS",
  "Alíquota - CBS",
  "Alíquota Efetiva - CBS",
  "Valor Total Apurado - CBS",
  "VALOR TOTAL DA NFS-E",
  "VALOR DA OPERAÇÃO / SERVIÇO",
  "Desconto Incondicionado",
  "Desconto Condicionado",
  "Total das Retenções (ISSQN / Federais)",
  "VALOR LÍQUIDO DA NFS-e",
  "Total do IBS/CBS",
  "VALOR LÍQUIDO DA NFS-e + IBS/CBS",
  "INFORMAÇÕES COMPLEMENTARES",
  "Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012:",
];

describe("leitura do XML para o DANFSe", () => {
  it("lê e formata cada campo como a NT 008 pede", () => {
    const data = readNfseForDanfse(nfseXml(campinasInput, IBSCBS_NFSE));
    expect(data).toMatchObject({
      chaveAcesso: CHAVE,
      tpAmb: 2,
      cabecalho: {
        municipio: "Município: Campinas / SP",
        ambienteGerador: "Sistema Nacional da NFS-e",
        tipoAmbiente: "Homologação",
      },
      identificacao: {
        numero: "42",
        competencia: "20/08/2026",
        emissaoNfse: "29/08/2026 10:00:05",
        numeroDps: "1",
        serieDps: "10001",
        emissaoDps: "29/08/2026 10:00:00",
        emitente: "Prestador",
        situacao: "NFS-e Gerada",
        finalidade: "NFS-e regular",
      },
      // A DPS traz só CNPJ, e-mail e regime: o resto vem do grupo emit que o fisco preenche.
      prestador: {
        documento: "11.222.333/0001-81",
        inscricaoMunicipal: "12345",
        telefone: "1930000000",
        nome: "Prestador Sintético Ltda",
        municipio: "Campinas / SP",
        ibgeCep: "3509502 / 13.010-000",
        endereco: "Rua do Prestador, 100, Sala 2, Centro",
        email: "fiscal@prestador.example",
        simplesNacional: "Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)",
        regimeApuracao:
          "Regime de apuração dos tributos federais e municipal pelo Simples Nacional",
      },
      tomador: {
        documento: "11.444.777/0001-61",
        inscricaoMunicipal: "-",
        telefone: "-",
        nome: "Tomador Sintético Ltda",
        municipio: "Campinas / SP",
        ibgeCep: "3509502 / 13.000-000",
        endereco: "Rua Exemplo, 10, Bairro Exemplo",
        email: "fiscal@tomador.example",
      },
      destinatario: "O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO",
      intermediario: "INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e",
      servico: {
        codigoTributacao: "01.05.01 / 001",
        nbs: "1.1103.22.00",
        localPrestacao: "Campinas / SP / BR",
        descricaoTributacao:
          "Licenciamento ou cessão de direito de uso de programas de computação.",
        descricao: "Licenciamento de software (teste)",
      },
      issqn: {
        tipoTributacao: "Operação Tributável",
        localIncidencia: "Campinas / SP / BR",
        regimeEspecial: "Nenhum",
        imunidade: "-",
        suspensao: "-",
        processo: "-",
        beneficio: "-",
        baseCalculo: "R$ 397,00",
        aliquota: "2,00%",
        retencao: "Retido pelo Tomador",
        apurado: "R$ 7,94",
      },
      federal: { irrf: "-", previdenciaria: "-", contribuicoes: "-" },
      ibsCbs: {
        cstClassTrib: "000 / 000001",
        indicadorOperacao: "100501 / 3509502 / Campinas / SP",
        // Das parcelas da soma (desconto, reembolso, ISSQN, PIS e COFINS), só o vISSQN existe.
        exclusoes: "R$ 7,94",
        baseCalculo: "R$ 389,06",
        reducoes: "- / - / 10,00%",
        aliquotasIbs: "0,10% / 0,00%",
        aliquotaEfetivaMun: "0,00%",
        valorMun: "R$ 0,00",
        aliquotaEfetivaUf: "0,10%",
        valorUf: "R$ 0,39",
        valorIbs: "R$ 0,39",
        aliquotaCbs: "0,90%",
        aliquotaEfetivaCbs: "0,81%",
        valorCbs: "R$ 3,42",
      },
      total: {
        valorServico: "R$ 397,00",
        descontoIncondicionado: "-",
        descontoCondicionado: "-",
        retencoes: "R$ 7,94",
        valorLiquido: "R$ 389,06",
        ibsCbs: "R$ 3,81",
        valorLiquidoIbsCbs: "R$ 392,87",
      },
      informacoes: "",
      totaisTributos:
        "Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: " +
        "Federais: R$ 0,00; Estaduais: R$ 0,00; Municipais: R$ 7,94",
    });
  });

  it("sem o grupo IBSCBS, os campos de IBS/CBS ficam com traço", () => {
    const data = readNfseForDanfse(nfseXml(nationalInput));
    expect(Object.values(data.ibsCbs).every((value) => value === "-")).toBe(true);
    expect(data.total.ibsCbs).toBe("-");
    expect(data.destinatario).toBe("DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e");
    expect(data.tomador).toMatchObject({
      municipio: "São Paulo / SP",
      ibgeCep: "3550308 / 01.001-000",
    });
  });

  it("CNPJ alfanumérico sai com a máscara", () => {
    const xml = nfseXml(campinasInput).replace(
      "<CNPJ>11444777000161</CNPJ>",
      "<CNPJ>12ABC34501DE35</CNPJ>",
    );
    expect(readNfseForDanfse(xml).tomador).toMatchObject({ documento: "12.ABC.345/01DE-35" });
  });

  it("aceita a chave com o CNPJ alfanumérico do emitente (TSIdNFSe da NT 009)", () => {
    const chave = `355030821${"12ABC34501DE35"}${"0".repeat(26)}1`;
    const xml = nfseXml(campinasInput).replace(`NFS${CHAVE}`, `NFS${chave}`);
    expect(readNfseForDanfse(xml).chaveAcesso).toBe(chave);
  });

  it("emitente que não é o prestador não empresta nome nem endereço ao prestador", () => {
    const xml = nfseXml(campinasInput).replace("<tpEmit>1</tpEmit>", "<tpEmit>2</tpEmit>");
    expect(readNfseForDanfse(xml)).toMatchObject({
      identificacao: { emitente: "Tomador" },
      prestador: {
        documento: "11.222.333/0001-81",
        nome: "-",
        inscricaoMunicipal: "-",
        telefone: "-",
        endereco: "-",
        email: "fiscal@prestador.example",
      },
    });
  });

  it("benefício, deduções e desconto incondicionado saem pela fórmula do XSD", () => {
    const base = nfseXml(campinasInput, IBSCBS_NFSE).replace(
      "</vServPrest>",
      "</vServPrest><vDescCondIncond><vDescIncond>2.00</vDescIncond><vDescCond>1.50</vDescCond></vDescCondIncond>",
    );
    // Leiaute de 02/2026: vCalcDR + vCalcReeRepRes, e o reembolso também entra nas exclusões.
    const febr = readNfseForDanfse(
      base
        .replace(
          "<vBC>397</vBC>",
          "<vCalcDR>10.00</vCalcDR><tpBM>2</tpBM><vCalcBM>3.00</vCalcBM><vBC>397</vBC>",
        )
        .replace(
          "<valores><vBC>389.06</vBC>",
          "<valores><vBC>389.06</vBC><vCalcReeRepRes>5.00</vCalcReeRepRes>",
        ),
    );
    expect(febr.issqn).toMatchObject({
      beneficio: "Redução da BC em %",
      calculoBm: "R$ 3,00",
      deducoes: "R$ 15,00",
      descontoIncondicionado: "R$ 2,00",
    });
    expect(febr.total).toMatchObject({
      descontoIncondicionado: "R$ 2,00",
      descontoCondicionado: "R$ 1,50",
    });
    // 2,00 de desconto + 5,00 de reembolso + 7,94 de ISSQN.
    expect(febr.ibsCbs.exclusoes).toBe("R$ 14,94");
    // NT 009: vAjusteBCISSQN + vCalcAjusteBCISSQN, e o ajuste do IBS/CBS no lugar do reembolso.
    const nt009 = readNfseForDanfse(
      base
        .replace(
          "</vDescCondIncond>",
          "</vDescCondIncond><vAjusteBC><pAjusteBCISSQN>0</pAjusteBCISSQN><vAjusteBCISSQN>100.00</vAjusteBCISSQN></vAjusteBC>",
        )
        .replace("<vBC>397</vBC>", "<vCalcAjusteBCISSQN>50.00</vCalcAjusteBCISSQN><vBC>397</vBC>")
        .replace(
          "<valores><vBC>389.06</vBC>",
          "<valores><vBC>389.06</vBC><vCalcAjusteBCIBSCBS>500.00</vCalcAjusteBCIBSCBS>",
        ),
    );
    expect(nt009.issqn.deducoes).toBe("R$ 150,00");
    expect(nt009.ibsCbs.exclusoes).toBe("R$ 509,94");
  });

  it("município que o XML não nomeia sai com traço e a UF do código IBGE", () => {
    const rio = nfseXml(nationalInput).replace(
      "<toma><CPF>11144477735</CPF><xNome>Pessoa Sintética</xNome><end><endNac><cMun>3550308</cMun>",
      "<toma><CPF>11144477735</CPF><xNome>Pessoa Sintética</xNome><end><endNac><cMun>3304557</cMun>",
    );
    expect(rio).toContain("<cMun>3304557</cMun>");
    // A norma pede o nome do município; o XML só nomeia os de emissão, prestação e incidência.
    expect(readNfseForDanfse(rio).tomador).toMatchObject({
      municipio: "- / RJ",
      ibgeCep: "3304557 / 01.001-000",
    });
  });

  it("tomador ausente e destinatário informado", () => {
    const withoutToma = nfseXml(campinasInput).replace(/<toma>[\s\S]*?<\/toma>/, "");
    expect(readNfseForDanfse(withoutToma).tomador).toBe(
      "TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e",
    );
    const data = readNfseForDanfse(
      nfseXml({
        ...campinasInput,
        ibsCbs: { ...campinasInput.ibsCbs!, indDest: 1 },
        dest: { ...nationalInput.toma, xNome: "Destinatário Sintético" },
      }),
    );
    expect(data.destinatario).toMatchObject({
      documento: "111.444.777-35",
      nome: "Destinatário Sintético",
      municipio: "- / SP",
    });
  });

  it("monta as informações complementares na ordem e com os prefixos da norma", () => {
    const xml = nfseXml(campinasInput, "<xOutInf>Observação do município.</xOutInf>")
      .replace(
        "</cServ>",
        "</cServ><obra><cObra>OBRA-1</cObra><inscImobFisc>IMOB-4</inscImobFisc></obra><atvEvento><idAtvEvt>EVT-9</idAtvEvt></atvEvento>" +
          "<infoCompl><idDocTec>DT-3</idDocTec><docRef>REF-7</docRef><xPed>PED-5</xPed>" +
          "<gItemPed><xItemPed>1</xItemPed><xItemPed>2</xItemPed></gItemPed>" +
          "<xInfComp>Contrato 12/2026</xInfComp></infoCompl>",
      )
      .replace("<prest>", `<subst><chSubstda>${"9".repeat(50)}</chSubstda></subst><prest>`);
    expect(readNfseForDanfse(xml).informacoes).toBe(
      "Inf. Cont.: Contrato 12/2026 | " +
        `NFS-e Subst.: ${"9".repeat(50)} | Doc. Ref.: REF-7 | Cod. Obra: OBRA-1 | ` +
        "Insc. Imob.: IMOB-4 | " +
        "Cod. Evt.: EVT-9 | Doc. Tec.: DT-3 | Núm. Ped.: PED-5 | Item Ped.: 1, 2 | " +
        "Inf. A. T. Mun.: Observação do município.",
    );
  });

  it("PIS/COFINS retidos vão para as contribuições retidas, e a linha some depois de 2026", () => {
    const xml = (dCompet: string, tpRet: string) =>
      nfseXml({ ...campinasInput, dCompet, dhEmi: `${dCompet}T10:00:00-03:00` }).replace(
        "</tribMun>",
        "</tribMun><tribFed><piscofins><CST>01</CST><vPis>1.10</vPis><vCofins>5.05</vCofins>" +
          `<tpRetPisCofins>${tpRet}</tpRetPisCofins></piscofins><vRetCSLL>3.00</vRetCSLL></tribFed>`,
      );
    expect(readNfseForDanfse(xml("2026-08-20", "1")).federal).toEqual({
      irrf: "-",
      previdenciaria: "-",
      contribuicoes: "R$ 9,15",
      pisCofins: { pis: "R$ 0,00", cofins: "R$ 0,00", descricao: "PIS/COFINS Retidos" },
    });
    expect(readNfseForDanfse(xml("2026-08-20", "2")).federal).toEqual({
      irrf: "-",
      previdenciaria: "-",
      contribuicoes: "R$ 3,00",
      pisCofins: { pis: "R$ 1,10", cofins: "R$ 5,05", descricao: "PIS/COFINS Não Retidos" },
    });
    expect(readNfseForDanfse(xml("2027-01-05", "2")).federal.pisCofins).toBeNull();
  });

  it("não mostra o município no cabeçalho quando o item do código nacional é 99", () => {
    const xml = nfseXml(campinasInput).replace(
      "<cTribNac>010501</cTribNac>",
      "<cTribNac>990101</cTribNac>",
    );
    expect(readNfseForDanfse(xml).cabecalho.municipio).toBeNull();
  });

  it("recusa XML ilegível, sem DPS ou sem chave", () => {
    expect(() => readNfseForDanfse("<NFSe")).toThrow(/ilegível/);
    expect(() =>
      readNfseForDanfse(`<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe/></NFSe>`),
    ).toThrow(expect.objectContaining({ code: "DANFSE_XML_INVALID" }));
    expect(() => readNfseForDanfse(nfseXml(nationalInput).replace(`NFS${CHAVE}`, "NFS1"))).toThrow(
      /chave de acesso/,
    );
    const withoutPrest = nfseXml(nationalInput).replace(/<prest>[\s\S]*?<\/prest>/, "");
    expect(() => readNfseForDanfse(withoutPrest)).toThrow(
      expect.objectContaining({ code: "DANFSE_XML_INVALID", message: "prest ausente na DPS." }),
    );
  });

  it("formata decimal sem ponto flutuante", () => {
    expect(formatDecimal("1234567.5")).toBe("1.234.567,50");
    expect(formatDecimal("0.1")).toBe("0,10");
    expect(formatDecimal("2.0125", 2)).toBe("2,0125");
  });

  it("agrupa os milhares como o agrupamento por regex, em qualquer tamanho", () => {
    // Referência: a regex de antes, que revarria o resto do número em cada posição.
    const legacy = (int: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    for (let length = 1; length <= 40; length++) {
      const digits = "9876543210".repeat(4).slice(0, length);
      expect(formatDecimal(`-${digits}.5`)).toBe(`-${legacy(digits)},50`);
    }
    expect(formatDecimal("000012345.678")).toBe("12.345,678");
    expect(formatDecimal("0")).toBe("0,00");
  });

  it("formata um valor de 300 mil dígitos", () => {
    expect(formatDecimal("1".repeat(300_000))).toBe(`${Array(100_000).fill("111").join(".")},00`);
  });
});

describe("DANFSe em PDF", () => {
  it("imprime numa página todos os campos obrigatórios da NT 008, o QR e a expressão de homologação", async () => {
    const bytes = await renderDanfse(nfseXml(campinasInput, IBSCBS_NFSE));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const pages = await inspectPdf(bytes);
    expect(pages).toHaveLength(1);
    const [page] = pages;
    for (const label of NT008_LABELS) expect(page!.text).toContain(label);
    for (const value of [
      CHAVE,
      "Município: Campinas / SP",
      "Sistema Nacional da NFS-e",
      "Homologação",
      "29/08/2026 10:00:05",
      "Prestador Sintético Ltda",
      "11.222.333/0001-81",
      "Tomador Sintético Ltda",
      "O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO",
      "INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e",
      "01.05.01 / 001",
      "1.1103.22.00",
      "Licenciamento de software (teste)",
      "Operação Tributável",
      "Retido pelo Tomador",
      "R$ 397,00",
      "2,00%",
      "R$ 389,06",
      "R$ 392,87",
    ])
      expect(page!.text).toContain(value);
    // Expressão do item 2.4.3 para tpAmb 2, abaixo do título.
    expect(page!.text).toContain("Documento Auxiliar da NFS-e NFS-e SEM VALIDADE JURÍDICA");
    expect(page!.text).not.toContain("SIMULADA");
    expect(page!.qr).toBe(consultaPublicaUrl(CHAVE));
    expect(outside(pages)).toEqual([]);
  });

  it("aponta o QR para a consulta pública da norma", () => {
    expect(consultaPublicaUrl(CHAVE)).toBe(
      `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${CHAVE}`,
    );
  });

  it("produção sai sem expressão de teste; o simulador sai com ela e com a marca d'água", async () => {
    const [production] = await inspectPdf(
      await renderDanfse(nfseXml({ ...nationalInput, tpAmb: 1 })),
    );
    expect(production!.text).toContain("Tipo de Ambiente: Produção");
    expect(production!.text).not.toMatch(/SEM VALIDADE JURÍDICA|SIMULADA|SEM VALOR FISCAL/);
    // O simulador marca o documento mesmo que o XML diga produção.
    const [simulated] = await inspectPdf(
      await renderDanfse(nfseXml({ ...nationalInput, tpAmb: 1 }), { mark: "simulated" }),
    );
    expect(simulated!.text).toContain("NFS-e SEM VALIDADE JURÍDICA");
    expect(simulated!.text).toContain("SIMULADA");
  });

  it("exportação mostra o tomador no exterior e a exportação do ISSQN", async () => {
    const [page] = await inspectPdf(await renderDanfse(nfseXml(exportInput)));
    for (const piece of [
      "98-7654321",
      "Example Grocery LLC",
      "San Francisco / CA",
      "- / 94105",
      "Exportação de Serviço",
      "Market St, 548, SoMa",
    ])
      expect(page!.text).toContain(piece);
  });

  it("corta a descrição longa com reticências e mantém tudo numa página", async () => {
    const long = Array.from({ length: 160 }, (_, i) => `item-${i}`).join(" descrição longa ");
    const xml = nfseXml(
      nationalInput,
      `<xOutInf>${"Informação longa. ".repeat(150)}</xOutInf>`,
    ).replace(/<xDescServ>[^<]*<\/xDescServ>/, `<xDescServ>${long}</xDescServ>`);
    const pages = await inspectPdf(await renderDanfse(xml));
    expect(pages).toHaveLength(1);
    const text = pages[0]!.text;
    expect(text).toContain("item-0");
    expect(text).not.toContain("item-159");
    expect(text).toMatch(/\.\.\. +TRIBUTAÇÃO MUNICIPAL/);
    // A linha dos totais aproximados é fixa: nenhum corte das informações a leva junto.
    expect(text).toMatch(/Informação longa\.[^|]*\.\.\. +Totais Aproximados dos Tributos/);
    expect(outside(pages)).toEqual([]);
  });

  it("com todos os blocos preenchidos e textos longos, cabe numa página com o QR legível", async () => {
    let xml = nfseXml(
      {
        ...campinasInput,
        ibsCbs: { ...campinasInput.ibsCbs!, indDest: 1 },
        dest: { ...nationalInput.toma, xNome: "Destinatário Sintético" },
      },
      `${IBSCBS_NFSE}<xOutInf>${"Informação longa do município. ".repeat(80)}</xOutInf>`,
    );
    const toma = /<toma>[\s\S]*?<\/toma>/.exec(xml)![0];
    xml = xml
      .replace(toma, toma + toma.replaceAll("toma>", "interm>"))
      .replace(
        /<xDescServ>[^<]*<\/xDescServ>/,
        `<xDescServ>${Array.from({ length: 400 }, (_, i) => `WWW-${i}`).join(" descrição ")}</xDescServ>`,
      )
      .replace("<vBC>397</vBC>", "<tpBM>1</tpBM><vCalcBM>1.00</vCalcBM><vBC>397</vBC>");
    const pages = await inspectPdf(await renderDanfse(xml, { mark: "simulated" }));
    expect(pages).toHaveLength(1);
    const text = pages[0]!.text;
    for (const block of [
      "TOMADOR / ADQUIRENTE",
      "DESTINATÁRIO DA OPERAÇÃO",
      "INTERMEDIÁRIO DA OPERAÇÃO",
      "Destinatário Sintético",
      "Benefício Municipal",
      "Isenção",
      "Cálculo do BM",
      "Total Deduções/Reduções",
      "WWW-0",
      "Inf. A. T. Mun.: Informação longa",
      "Totais Aproximados dos Tributos",
    ])
      expect(text).toContain(block);
    expect(pages[0]!.qr).toBe(consultaPublicaUrl(CHAVE));
    expect(outside(pages)).toEqual([]);
  });

  it("é determinístico e troca caracteres fora da fonte por ?", async () => {
    const xml = nfseXml({
      ...nationalInput,
      serv: { ...nationalInput.serv, xDescServ: "Serviço 漢字 🚀 com acento" },
    });
    const a = await renderDanfse(xml, { mark: "simulated" });
    const b = await renderDanfse(xml, { mark: "simulated" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const [page] = await inspectPdf(a);
    expect(page!.text).toContain("Serviço ?? ? com acento");
  });

  it("traz as informações da administração municipal com o prefixo da norma", async () => {
    const xml = nfseXml(
      nationalInput,
      "<xOutInf>NFS-e simulada pelo sandbox da freecorpsNFE, sem validade fiscal.</xOutInf>",
    );
    const [page] = await inspectPdf(await renderDanfse(xml, { mark: "simulated" }));
    expect(page!.text).toContain("INFORMAÇÕES COMPLEMENTARES");
    expect(page!.text).toContain("Inf. A. T. Mun.: NFS-e simulada pelo sandbox");
  });
});

/** XML sintético com a alíquota trocada direto no texto, sem passar pela validação da DPS. */
const withRate = (pAliqAplic: string) =>
  nfseXml(campinasInput).replace(
    /<pAliqAplic>[^<]*<\/pAliqAplic>/,
    `<pAliqAplic>${pAliqAplic}</pAliqAplic>`,
  );

describe("alíquota no DANFSe", () => {
  it.each([
    { name: "2.00", pAliq: "2.00", printed: "2,00%" },
    { name: "2.5000", pAliq: "2.5000", printed: "2,50%" },
    { name: "2.0125", pAliq: "2.0125", printed: "2,0125%" },
    { name: "2.01250", pAliq: "2.01250", printed: "2,0125%" },
    { name: "5", pAliq: "5", printed: "5,00%" },
    { name: "2.000000", pAliq: "2.000000", printed: "2,00%" },
  ])("pAliqAplic $name sai como $printed", ({ pAliq, printed }) => {
    expect(readNfseForDanfse(withRate(pAliq)).issqn.aliquota).toBe(printed);
  });

  it("sem pAliqAplic na NFS-e, usa a alíquota da DPS", () => {
    const xml = nfseXml(campinasInput).replace(/<pAliqAplic>[^<]*<\/pAliqAplic>/, "");
    expect(readNfseForDanfse(xml).issqn.aliquota).toBe("2,00%");
  });

  it("alíquota com 200 mil casas que não terminam em zero sai cortada na célula", async () => {
    // O caso que fazia a regex de antes recuar a cada casa; a célula corta o texto antes de medir.
    const [page] = await inspectPdf(await renderDanfse(withRate(`2.${"0".repeat(200_000)}1`)));
    expect(page!.text).toMatch(/Alíquota Aplicada +2,0{10,}\.\.\./);
  });
});

/**
 * Mede como a quebra de linha cresce sem depender do relógio: conta os caracteres que ela pede
 * para medir. A medida de mentira dá 1 a cada caractere.
 */
function measuredBreak(text: string, width: number) {
  let measured = 0;
  const lines = breakLines(text, width, 1, (part) => {
    measured += part.length;
    return part.length;
  });
  return { lines, measured };
}

/** A quebra anterior, que remedia cada linha candidata: referência das linhas esperadas. */
function remeasuringWrap(text: string, font: PDFFont, size: number, maxWidth: number) {
  const lines: string[] = [];
  let current = "";
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut--;
      if (current) lines.push(current);
      lines.push(rest.slice(0, cut));
      current = "";
      rest = rest.slice(cut);
    }
    const candidate = current ? `${current} ${rest}` : rest;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) current = candidate;
    else {
      if (current) lines.push(current);
      current = rest;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const helvetica = async () => (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
/** Largura útil do texto do DANFSe: o corpo de 20,40 cm menos o recuo de 2,5 pt de cada lado. */
const CONTENT_WIDTH = (20.4 * 72) / 2.54 - 5;

describe("desempenho da quebra de linha do DANFSe", () => {
  // Cada palavra é medida inteira uma vez e a junção com a anterior em cinco caracteres ("x y", x
  // e y); a palavra cortada mede ainda cada caractere sozinho e com o anterior. No pior caso,
  // quatro por caractere. A quebra de antes media nesses casos de 8 a 43 mil por caractere.
  const BUDGET = 4;

  it.each([
    { name: "descrição de 5.000 caracteres sem espaço", text: "A".repeat(5000), width: 100 },
    { name: "palavra de 500 caracteres sem espaço", text: "B".repeat(500), width: 30 },
    { name: "texto de 5.000 palavras", text: "palavra ".repeat(5000), width: 100 },
    { name: "texto de 5.000 letras soltas", text: "a ".repeat(5000), width: 100 },
  ])(`$name mede cada caractere no máximo ${BUDGET} vezes`, ({ text, width }) => {
    const { lines, measured } = measuredBreak(text, width);
    expect(measured).toBeLessThanOrEqual(BUDGET * text.length);
    expect(lines.every((line) => line.length <= width)).toBe(true);
    expect(lines.join("").replaceAll(" ", "")).toBe(text.replaceAll(" ", ""));
  });

  it("as medidas dobram quando o texto dobra", () => {
    const small = measuredBreak("C".repeat(5000), 100).measured;
    const large = measuredBreak("C".repeat(10_000), 100).measured;
    expect(large).toBeLessThanOrEqual(2 * small + BUDGET);
  });

  it("na Helvetica, todo caractere alarga o texto, com ou sem kerning", async () => {
    // O corte da palavra longa para na primeira medida que passa da linha: vale só se nenhum par
    // com kerning encolhe o texto ao ganhar um caractere.
    const font = await helvetica();
    const chars = font
      .getCharacterSet()
      .filter((code) => code >= 32 && code !== 127)
      .map((code) => String.fromCodePoint(code));
    for (const a of chars)
      for (const b of chars)
        expect(font.widthOfTextAtSize(a + b, 1000)).toBeGreaterThan(
          font.widthOfTextAtSize(a, 1000),
        );
  });

  it("dá as mesmas linhas que remedir cada candidata", async () => {
    const font = await helvetica();
    const texts = [
      Array.from({ length: 160 }, (_, i) => `item-${i}`).join(" descrição longa "),
      "AVATAR To. Yo, Wa Te L’L’ “Av” ff, rv. ".repeat(40),
      // Curtas: a referência remede prefixos e fica cúbica nas palavras longas.
      "W".repeat(150),
      "i".repeat(300),
      "AV".repeat(100),
      "L’".repeat(100),
      `Serviço de manutenção ${"X".repeat(120)} fim ${"Á".repeat(90)}`,
      "Rua Exemplo, 10, Bairro Exemplo · Município IBGE 3509502 · CEP 13000-000",
      "",
      "  espaços\tem\nexcesso  ",
    ];
    for (const size of [8, 8.5, 9])
      for (const width of [CONTENT_WIDTH, 60, 4])
        for (const text of texts)
          expect(
            breakLines(text, width, size / 1000, (part) => font.widthOfTextAtSize(part, 1000)),
          ).toEqual(remeasuringWrap(text, font, size, width));
  });

  it("descrição de 20.000 caracteres sem espaço sai cortada na página única", async () => {
    const xml = nfseXml(nationalInput).replace(
      /<xDescServ>[^<]*<\/xDescServ>/,
      `<xDescServ>${"A".repeat(20_000)}</xDescServ>`,
    );
    const pages = await inspectPdf(await renderDanfse(xml));
    expect(pages).toHaveLength(1);
    const printed = pages[0]!.boxes.filter((b) => /^A+(\.\.\.)?$/.test(b.str));
    const count = printed.reduce((total, b) => total + b.str.replace("...", "").length, 0);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(1297);
    expect(printed.at(-1)!.str.endsWith("...")).toBe(true);
    expect(outside(pages)).toEqual([]);
  });
});
