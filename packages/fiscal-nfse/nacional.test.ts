import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  buildDpsId,
  dpsUrl,
  eventsUrl,
  extractRejections,
  gunzipB64,
  gzipB64,
  nacional,
  nfseUrl,
  resolveEndpoint,
  submitUrl,
  verifySignature,
  type CancelEventInput,
  type NfseContext,
  type NfseHttpRequest,
  type NfseHttpResponse,
  type NfseTarget,
} from "./src/index";
import { campinasInput, nationalInput, PRESTADOR_CNPJ, signerKeys } from "./tests/inputs";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/adn/${name}`, import.meta.url), "utf8");
const NFSE_XML = fixture("nfse-autorizada.xml");
const CHAVE = "3".repeat(50);
const SEFIN: NfseTarget = { id: "sefin-nacional", environment: "producao-restrita" };
const CAMPINAS: NfseTarget = { id: "campinas-adn", environment: "producao-restrita" };

/** Transporte gravador: responde da fila, ou lança o erro dado. */
function recorder(...replies: (NfseHttpResponse | Error)[]) {
  const requests: NfseHttpRequest[] = [];
  const transport = async (request: NfseHttpRequest) => {
    requests.push(request);
    const reply = replies.shift();
    if (!reply) throw new Error("resposta não programada");
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { requests, transport };
}

const ctx = (transport: NfseContext["transport"], target = SEFIN): NfseContext => ({
  signer: signerKeys(),
  transport,
  target,
});
const authorized = (status = 201) => ({
  status,
  body: JSON.stringify({ chaveAcesso: CHAVE, nfseXmlGZipB64: gzipB64(NFSE_XML) }),
});

describe("alvos", () => {
  it("sefin-nacional: hosts por ambiente, envio em /nfse, RSA-SHA256", () => {
    expect(resolveEndpoint({ id: "sefin-nacional", environment: "producao" })).toEqual({
      id: "sefin-nacional",
      environment: "producao",
      host: "sefin.nfse.gov.br",
      basePath: "/SefinNacional",
      submitPath: "/nfse",
      dpsPath: "/dps",
      nfsePath: "/nfse",
      signature: "rsa-sha256",
      tpAmb: 1,
    });
    expect(resolveEndpoint(SEFIN).host).toBe("sefin.producaorestrita.nfse.gov.br");
  });

  it("campinas-adn: hosts do guia de 18/09/2026, base /notafiscal-ws/nfse, RSA-SHA1", () => {
    expect(resolveEndpoint({ id: "campinas-adn", environment: "producao" })).toEqual({
      id: "campinas-adn",
      environment: "producao",
      host: "nfseapi.campinas.sp.gov.br",
      basePath: "/notafiscal-ws/nfse",
      submitPath: "",
      dpsPath: "/dps",
      nfsePath: "",
      signature: "rsa-sha1",
      tpAmb: 1,
    });
    expect(resolveEndpoint(CAMPINAS)).toMatchObject({
      host: "preprod-nfseapi.ima.sp.gov.br",
      basePath: "/notafiscal-ws/nfse",
      tpAmb: 2,
    });
  });

  // Sefin: /SefinNacional + /nfse, /dps/{id}, /nfse/{chave}, /nfse/{chave}/eventos.
  // IMA (guia de 18/09/2026): base /notafiscal-ws/nfse + "", /dps/{id}, /{chave}, /{chave}/eventos.
  it.each([
    [
      "sefin-nacional",
      "producao-restrita",
      "https://sefin.producaorestrita.nfse.gov.br/SefinNacional",
      ["/nfse", "/dps/", "/nfse/", "/nfse/"],
    ],
    [
      "sefin-nacional",
      "producao",
      "https://sefin.nfse.gov.br/SefinNacional",
      ["/nfse", "/dps/", "/nfse/", "/nfse/"],
    ],
    [
      "campinas-adn",
      "producao-restrita",
      "https://preprod-nfseapi.ima.sp.gov.br/notafiscal-ws/nfse",
      ["", "/dps/", "/", "/"],
    ],
    [
      "campinas-adn",
      "producao",
      "https://nfseapi.campinas.sp.gov.br/notafiscal-ws/nfse",
      ["", "/dps/", "/", "/"],
    ],
  ] as const)(
    "URLs de %s em %s: envio, consulta por DPS, NFS-e e eventos",
    (id, environment, base, paths) => {
      const endpoint = resolveEndpoint({ id, environment });
      const dpsId = buildDpsId(nationalInput);
      expect(submitUrl(endpoint)).toBe(`${base}${paths[0]}`);
      expect(dpsUrl(endpoint, dpsId)).toBe(`${base}${paths[1]}${dpsId}`);
      expect(nfseUrl(endpoint, CHAVE)).toBe(`${base}${paths[2]}${CHAVE}`);
      expect(eventsUrl(endpoint, CHAVE)).toBe(`${base}${paths[3]}${CHAVE}/eventos`);
    },
  );

  it("recusa alvo e ambiente desconhecidos", () => {
    expect(() =>
      resolveEndpoint({ id: "abrasf" as "sefin-nacional", environment: "producao" }),
    ).toThrow(/desconhecido/);
    expect(() =>
      resolveEndpoint({ id: "sefin-nacional", environment: "homologacao" as "producao" }),
    ).toThrow(/Ambiente/);
  });
});

describe("issue", () => {
  it("envia a DPS assinada em gzip+base64 e devolve a NFS-e autorizada", async () => {
    const { requests, transport } = recorder(authorized());
    const outcome = await nacional.issue({ dps: nationalInput }, ctx(transport));
    expect(outcome).toMatchObject({
      kind: "success",
      dpsId: buildDpsId(nationalInput),
      chaveAcesso: CHAVE,
      nfseXml: NFSE_XML,
      httpStatus: 201,
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe("https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse");
    expect(request!.headers["Content-Type"]).toBe("application/json");
    const sent = gunzipB64(JSON.parse(request!.body!).dpsXmlGZipB64);
    expect(sent).toBe(outcome.signedDpsXml);
    expect(sent).toContain("xmldsig-more#rsa-sha256");
    expect(verifySignature(sent, signerKeys().certificatePem)).toBe(true);
  });

  it("submitDps reenvia o mesmo XML persistido, byte a byte, sem reassinar", async () => {
    const first = recorder(authorized());
    const issued = await nacional.issue({ dps: nationalInput }, ctx(first.transport));
    const second = recorder(authorized());
    const resent = await nacional.submitDps(
      { dpsId: issued.dpsId!, signedDpsXml: issued.signedDpsXml! },
      { transport: second.transport, target: SEFIN },
    );
    expect(resent).toMatchObject({ kind: "success", dpsId: issued.dpsId, chaveAcesso: CHAVE });
    expect(gunzipB64(JSON.parse(second.requests[0]!.body!).dpsXmlGZipB64)).toBe(
      issued.signedDpsXml,
    );
  });

  it("submitDps recusa Id divergente ou ambiente trocado sem enviar", async () => {
    const { requests, transport } = recorder();
    const { signedDpsXml, dpsId } = await nacional.issue(
      { dps: nationalInput },
      ctx(recorder(authorized()).transport),
    );
    const other = buildDpsId({ ...nationalInput, nDPS: 43 });
    expect(
      await nacional.submitDps(
        { dpsId: other, signedDpsXml: signedDpsXml! },
        { transport, target: SEFIN },
      ),
    ).toMatchObject({ kind: "definitive", code: "DPS_ID_MISMATCH", sent: false });
    expect(
      await nacional.submitDps(
        { dpsId: dpsId!, signedDpsXml: signedDpsXml! },
        { transport, target: { id: "sefin-nacional", environment: "producao" } },
      ),
    ).toMatchObject({ kind: "definitive", code: "ENVIRONMENT_MISMATCH", sent: false });
    expect(requests).toHaveLength(0);
  });

  it("Campinas envia na base nova (guia de 18/09/2026) com RSA-SHA1", async () => {
    const { requests, transport } = recorder(authorized());
    const outcome = await nacional.issue({ dps: campinasInput }, ctx(transport, CAMPINAS));
    expect(outcome.kind).toBe("success");
    expect(requests[0]!.url).toBe("https://preprod-nfseapi.ima.sp.gov.br/notafiscal-ws/nfse");
    expect(outcome.signedDpsXml).toContain("xmldsig#rsa-sha1");
  });

  it("rejeição 400 com erros estruturados é definitiva e preserva todos os códigos", async () => {
    const { transport } = recorder({ status: 400, body: fixture("rejeicao-e0714.json") });
    const outcome = await nacional.issue({ dps: nationalInput }, ctx(transport));
    expect(outcome).toMatchObject({
      kind: "definitive",
      code: "ADN_REJECTED",
      sent: true,
      httpStatus: 400,
    });
    expect(outcome.kind === "definitive" && outcome.rejections).toEqual([
      {
        code: "E0714",
        message: "Algoritmo de assinatura não suportado (mensagem sintética de teste).",
        complement: "SignatureMethod rsa-sha256",
      },
      {
        code: "E0316",
        message: "cNBS obrigatório (mensagem sintética de teste).",
        complement: null,
      },
    ]);
  });

  it("'já existe NFS-e para a DPS' é incerto: reconciliar pela consulta", async () => {
    const { transport } = recorder({ status: 400, body: fixture("rejeicao-dps-existente.json") });
    const outcome = await nacional.issue({ dps: nationalInput }, ctx(transport));
    expect(outcome).toMatchObject({ kind: "uncertain", code: "DPS_ALREADY_EXISTS" });
  });

  it.each([
    ["no código", { Codigo: "DPS_DUPLICADA" }],
    ["no complemento", { Codigo: "E9", Descricao: "Rejeição", Complemento: "DPS já existe" }],
  ])("duplicidade sinalizada %s também é incerta", async (_label, erro) => {
    const { transport } = recorder({ status: 400, body: JSON.stringify({ erros: [erro] }) });
    const outcome = await nacional.issue({ dps: nationalInput }, ctx(transport));
    expect(outcome).toMatchObject({ kind: "uncertain", code: "DPS_ALREADY_EXISTS" });
  });

  it("2xx fora do formato da Sefin é incerto, com diagnóstico sem valores (09/10/2026)", async () => {
    const { transport } = recorder({
      status: 201,
      body: JSON.stringify({ numero: "987", protocolo: "abc", [CHAVE]: 1 }),
      contentType: "application/json",
    });
    const outcome = await nacional.issue({ dps: campinasInput }, ctx(transport, CAMPINAS));
    expect(outcome).toMatchObject({
      kind: "uncertain",
      code: "RESPONSE_UNREADABLE",
      httpStatus: 201,
      diagnostic: {
        httpStatus: 201,
        contentType: "application/json",
        body: "json-object",
        keys: ["numero", "protocolo"],
      },
    });
    const { signedDpsXml: _xml, ...rest } = outcome;
    expect(JSON.stringify(rest)).not.toMatch(/987|abc|3{50}/);
  });

  it("timeout não tem diagnóstico; 'DPS já existe' tem", async () => {
    const lost = await nacional.issue(
      { dps: nationalInput },
      ctx(recorder(new Error("timeout")).transport),
    );
    expect(lost).toMatchObject({ kind: "uncertain", diagnostic: null });
    const duplicate = await nacional.issue(
      { dps: nationalInput },
      ctx(recorder({ status: 400, body: fixture("rejeicao-dps-existente.json") }).transport),
    );
    expect(duplicate).toMatchObject({
      kind: "uncertain",
      code: "DPS_ALREADY_EXISTS",
      diagnostic: { httpStatus: 400, body: "json-object" },
    });
  });

  it("rejeição só com código é incerta: sem texto não se descarta duplicidade", async () => {
    const { transport } = recorder({
      status: 400,
      body: JSON.stringify({ erros: [{ Codigo: "E0001" }] }),
    });
    const outcome = await nacional.issue({ dps: nationalInput }, ctx(transport));
    expect(outcome).toMatchObject({
      kind: "uncertain",
      code: "RESPONSE_UNREADABLE",
      rejections: [{ code: "E0001", message: "", complement: null }],
    });
  });

  it.each([
    [500, "ADN_UNAVAILABLE"],
    [502, "ADN_UNAVAILABLE"],
    [503, "ADN_UNAVAILABLE"],
    [429, "ADN_RATE_LIMITED"],
    [401, "ADN_ACCESS_DENIED"],
    [403, "ADN_ACCESS_DENIED"],
  ])("HTTP %s é transitório (%s), inclusive com corpo HTML", async (status, code) => {
    const { transport } = recorder({ status, body: fixture("gateway-503.html") });
    const outcome = await nacional.issue({ dps: nationalInput }, ctx(transport));
    expect(outcome).toMatchObject({ kind: "transient", code, httpStatus: status });
    expect(outcome.dpsId).toBe(buildDpsId(nationalInput));
  });

  it("exceção do transporte após o envio (timeout) é incerta", async () => {
    const { transport } = recorder(new Error("timeout de 30s"));
    const outcome = await nacional.issue({ dps: nationalInput }, ctx(transport));
    expect(outcome).toMatchObject({
      kind: "uncertain",
      code: "TRANSPORT_UNCERTAIN",
      httpStatus: null,
      dpsId: buildDpsId(nationalInput),
    });
    expect(outcome.signedDpsXml).toContain("<Signature");
  });

  it.each([
    ["4xx sem JSON", { status: 400, body: "<html>bad request</html>" }, "RESPONSE_UNREADABLE"],
    ["4xx JSON sem erros", { status: 422, body: "{}" }, "RESPONSE_UNREADABLE"],
    [
      "201 sem NFS-e",
      { status: 201, body: JSON.stringify({ chaveAcesso: CHAVE }) },
      "RESPONSE_UNREADABLE",
    ],
    ["201 não-JSON", { status: 201, body: "ok" }, "RESPONSE_UNREADABLE"],
    [
      "201 com gzip corrompido",
      { status: 201, body: JSON.stringify({ chaveAcesso: CHAVE, nfseXmlGZipB64: "bm9wZQ==" }) },
      "RESPONSE_UNREADABLE",
    ],
    [
      "201 com chave fora do formato",
      {
        status: 201,
        body: JSON.stringify({ chaveAcesso: "123", nfseXmlGZipB64: gzipB64(NFSE_XML) }),
      },
      "RESPONSE_UNREADABLE",
    ],
    ["408", { status: 408, body: "" }, "HTTP_UNEXPECTED"],
    ["302", { status: 302, body: "" }, "HTTP_UNEXPECTED"],
  ])("%s é incerto", async (_label, response, code) => {
    const { transport } = recorder(response);
    const outcome = await nacional.issue({ dps: nationalInput }, ctx(transport));
    expect(outcome).toMatchObject({ kind: "uncertain", code });
  });

  it("transporte que devolve objeto inválido é incerto", async () => {
    const transport = async () => ({ status: 201 }) as unknown as NfseHttpResponse;
    const outcome = await nacional.issue({ dps: nationalInput }, ctx(transport));
    expect(outcome).toMatchObject({ kind: "uncertain", code: "TRANSPORT_UNCERTAIN" });
  });

  it("tpAmb divergente do ambiente é definitivo e nada é enviado", async () => {
    const { requests, transport } = recorder();
    const outcome = await nacional.issue(
      { dps: nationalInput },
      ctx(transport, { id: "sefin-nacional", environment: "producao" }),
    );
    expect(outcome).toMatchObject({
      kind: "definitive",
      code: "ENVIRONMENT_MISMATCH",
      sent: false,
    });
    expect(requests).toHaveLength(0);
  });

  it("entrada inválida é definitiva, com mensagem pt-BR, e nada é enviado", async () => {
    const { requests, transport } = recorder();
    const valores = { ...nationalInput.valores, vServ: "1.234" };
    const outcome = await nacional.issue({ dps: { ...nationalInput, valores } }, ctx(transport));
    expect(outcome).toMatchObject({ kind: "definitive", code: "DECIMAL_PRECISION", sent: false });
    expect(outcome.kind === "definitive" && !outcome.sent && outcome.message).toMatch(
      /casas decimais/,
    );
    expect(requests).toHaveLength(0);
  });
});

describe("consultByDps", () => {
  const dpsId = buildDpsId(nationalInput);

  it("200 com chave recupera a autorização", async () => {
    const { requests, transport } = recorder({
      status: 200,
      body: JSON.stringify({ chaveAcesso: CHAVE }),
    });
    expect(await nacional.consultByDps(dpsId, { transport, target: SEFIN })).toEqual({
      kind: "found",
      dpsId,
      chaveAcesso: CHAVE,
      httpStatus: 200,
    });
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: `https://sefin.producaorestrita.nfse.gov.br/SefinNacional/dps/${dpsId}`,
    });
  });

  it("Campinas consulta em {base}/dps/{id} (prova de 09/10/2026, #197)", async () => {
    const { requests, transport } = recorder({
      status: 200,
      body: JSON.stringify({
        tipoAmbiente: 2,
        versaoAplicativo: "x",
        dataHoraProcessamento: "2026-10-09T10:00:00-03:00",
        chaveAcesso: CHAVE,
      }),
    });
    expect(await nacional.consultByDps(dpsId, { transport, target: CAMPINAS })).toMatchObject({
      kind: "found",
      chaveAcesso: CHAVE,
    });
    expect(requests[0]!.url).toBe(
      `https://preprod-nfseapi.ima.sp.gov.br/notafiscal-ws/nfse/dps/${dpsId}`,
    );
  });

  it("aceita a chave como Id da NFS-e (NFS + 50 dígitos) e devolve só os dígitos", async () => {
    const { transport } = recorder({
      status: 200,
      body: JSON.stringify({ chaveAcesso: `NFS${CHAVE}` }),
    });
    expect(await nacional.consultByDps(dpsId, { transport, target: CAMPINAS })).toMatchObject({
      kind: "found",
      chaveAcesso: CHAVE,
    });
  });

  it.each([
    // Envelope do padrão nacional, como a IMA devolve no 404 de DPS ausente.
    { tipoAmbiente: 2, versaoAplicativo: "1.0", dataHoraProcessamento: "2026-10-09T10:00:00" },
    { erros: [{ Codigo: "E0001", Descricao: "DPS não encontrada" }] },
    { erro: { codigo: "E0001", descricao: "DPS não encontrada" } },
    { alertas: [{ codigo: "A1", mensagem: "Não encontrada" }] },
  ])("404 com o JSON do fisco confirma inexistência (%#)", async (body) => {
    const { transport } = recorder({ status: 404, body: JSON.stringify(body) });
    expect(await nacional.consultByDps(dpsId, { transport, target: SEFIN })).toEqual({
      kind: "not-found",
      dpsId,
      httpStatus: 404,
    });
  });

  it.each([
    [
      { status: 404, body: "", contentType: null },
      { httpStatus: 404, contentType: null, body: "empty", keys: [] },
    ],
    [
      {
        status: 404,
        body: "<!DOCTYPE html><html><body>Not Found</body></html>",
        contentType: "text/html; charset=UTF-8",
      },
      { httpStatus: 404, contentType: "text/html", body: "html", keys: [] },
    ],
    [
      // Erro de rota do servidor de aplicação: JSON, mas não o do fisco.
      {
        status: 404,
        body: JSON.stringify({
          timestamp: "2026-10-09T13:00:00.000+00:00",
          status: 404,
          error: "Not Found",
          path: "/notafiscal-ws/dps/x",
        }),
        contentType: "application/json",
      },
      {
        httpStatus: 404,
        contentType: "application/json",
        body: "json-object",
        keys: ["timestamp", "status", "error", "path"],
      },
    ],
    [
      { status: 404, body: "{}", contentType: "application/json" },
      { httpStatus: 404, contentType: "application/json", body: "json-object", keys: [] },
    ],
    [
      { status: 404, body: "Not Found", contentType: "text/plain" },
      { httpStatus: 404, contentType: "text/plain", body: "text", keys: [] },
    ],
  ])(
    "404 sem o JSON do fisco é inconclusivo e não libera reenvio (%#)",
    async (reply, diagnostic) => {
      const { transport } = recorder(reply);
      expect(await nacional.consultByDps(dpsId, { transport, target: CAMPINAS })).toEqual({
        kind: "uncertain",
        dpsId,
        code: "CONSULT_INCONCLUSIVE",
        httpStatus: 404,
        diagnostic,
      });
    },
  );

  it("o diagnóstico guarda só nomes de chaves, nunca valores", async () => {
    const { transport } = recorder({
      status: 200,
      body: JSON.stringify({
        numeroNfse: "123",
        [CHAVE]: "chave como nome",
        "nome com espaço": 1,
        dados: { chave: CHAVE },
      }),
      contentType: "application/json;charset=utf-8",
    });
    const outcome = await nacional.consultByDps(dpsId, { transport, target: CAMPINAS });
    expect(outcome).toEqual({
      kind: "uncertain",
      dpsId,
      code: "CONSULT_INCONCLUSIVE",
      httpStatus: 200,
      diagnostic: {
        httpStatus: 200,
        contentType: "application/json",
        body: "json-object",
        keys: ["numeroNfse", "dados"],
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("123");
    expect(JSON.stringify(outcome)).not.toContain(CHAVE);
  });

  it.each([
    [{ status: 200, body: "{}" }, "uncertain", "CONSULT_INCONCLUSIVE"],
    [{ status: 200, body: "<html/>" }, "uncertain", "CONSULT_INCONCLUSIVE"],
    [{ status: 400, body: fixture("rejeicao-e0714.json") }, "uncertain", "CONSULT_INCONCLUSIVE"],
    [{ status: 401, body: "" }, "transient", "ADN_ACCESS_DENIED"],
    [{ status: 429, body: "" }, "transient", "ADN_RATE_LIMITED"],
    [{ status: 503, body: fixture("gateway-503.html") }, "transient", "ADN_UNAVAILABLE"],
    [new Error("ECONNRESET"), "transient", "TRANSPORT_FAILED"],
  ])("resposta sem chave não autoriza reenvio (%#)", async (reply, kind, code) => {
    const { transport } = recorder(reply);
    const outcome = await nacional.consultByDps(dpsId, { transport, target: SEFIN });
    expect(outcome).toMatchObject({ kind, code });
  });

  it("recusa Id fora do formato antes de chamar o transporte", async () => {
    const { requests, transport } = recorder();
    await expect(nacional.consultByDps("DPS-x/../", { transport, target: SEFIN })).rejects.toThrow(
      /45 caracteres/,
    );
    expect(requests).toHaveLength(0);
  });
});

describe("consultByAccessKey", () => {
  it("baixa e descompacta a NFS-e", async () => {
    const { requests, transport } = recorder({
      status: 200,
      body: JSON.stringify({ chaveAcesso: CHAVE, nfseXmlGZipB64: gzipB64(NFSE_XML) }),
    });
    expect(await nacional.consultByAccessKey(CHAVE, { transport, target: CAMPINAS })).toEqual({
      kind: "found",
      chaveAcesso: CHAVE,
      nfseXml: NFSE_XML,
      httpStatus: 200,
    });
    expect(requests[0]!.url).toBe(
      `https://preprod-nfseapi.ima.sp.gov.br/notafiscal-ws/nfse/${CHAVE}`,
    );
  });

  it("404, indisponibilidade e corpo ilegível", async () => {
    const replies = recorder(
      { status: 404, body: JSON.stringify({ tipoAmbiente: 2, versaoAplicativo: "1.0" }) },
      { status: 404, body: "<html><body>Not Found</body></html>" },
      { status: 502, body: "" },
      { status: 200, body: "{}" },
    );
    const q = { transport: replies.transport, target: SEFIN };
    expect(await nacional.consultByAccessKey(CHAVE, q)).toMatchObject({ kind: "not-found" });
    expect(await nacional.consultByAccessKey(CHAVE, q)).toMatchObject({
      kind: "uncertain",
      code: "CONSULT_INCONCLUSIVE",
      diagnostic: { httpStatus: 404, body: "html", keys: [] },
    });
    expect(await nacional.consultByAccessKey(CHAVE, q)).toMatchObject({ kind: "transient" });
    expect(await nacional.consultByAccessKey(CHAVE, q)).toMatchObject({
      kind: "uncertain",
      code: "CONSULT_INCONCLUSIVE",
    });
  });
});

describe("cancel", () => {
  const event: CancelEventInput = {
    tpAmb: 2,
    verAplic: "FiscalNfseTest_1.0",
    dhEvento: "2026-08-29T10:00:00-03:00",
    cnpjAutor: PRESTADOR_CNPJ,
    chNFSe: CHAVE,
    cMotivo: "1",
    xMotivo: "Erro na emissao da nota fiscal",
  };
  const eventXml = "<evento>sintético</evento>";

  it("registra o evento assinado e devolve o XML do evento", async () => {
    const { requests, transport } = recorder({
      status: 201,
      body: JSON.stringify({ eventoXmlGZipB64: gzipB64(eventXml) }),
    });
    const outcome = await nacional.cancel({ event }, ctx(transport, CAMPINAS));
    expect(outcome).toMatchObject({
      kind: "success",
      eventId: `PRE${CHAVE}101101`,
      eventXml,
      alreadyRegistered: false,
    });
    expect(requests[0]!.url).toBe(
      `https://preprod-nfseapi.ima.sp.gov.br/notafiscal-ws/nfse/${CHAVE}/eventos`,
    );
    const sent = gunzipB64(JSON.parse(requests[0]!.body!).pedidoRegistroEventoXmlGZipB64);
    expect(sent).toContain("xmldsig#rsa-sha1");
    expect(verifySignature(sent, signerKeys().certificatePem)).toBe(true);
  });

  it("submitCancelEvent reenvia o pedido persistido e confere o Id contra a chave", async () => {
    const signed = await nacional.cancel(
      { event },
      ctx(recorder({ status: 201, body: "{}" }).transport),
    );
    const { requests, transport } = recorder({ status: 201, body: "{}" });
    const input = {
      eventId: signed.eventId!,
      chNFSe: CHAVE,
      signedEventXml: signed.signedEventXml!,
    };
    expect(await nacional.submitCancelEvent(input, { transport, target: SEFIN })).toMatchObject({
      kind: "success",
      eventId: `PRE${CHAVE}101101`,
    });
    expect(gunzipB64(JSON.parse(requests[0]!.body!).pedidoRegistroEventoXmlGZipB64)).toBe(
      signed.signedEventXml,
    );
    expect(
      await nacional.submitCancelEvent(
        { ...input, chNFSe: "4".repeat(50) },
        { transport, target: SEFIN },
      ),
    ).toMatchObject({ kind: "definitive", code: "EVENT_ID_MISMATCH", sent: false });
    expect(requests).toHaveLength(1);
  });

  it("2xx sem XML do evento ainda é sucesso", async () => {
    const { transport } = recorder({ status: 200, body: "{}" });
    expect(await nacional.cancel({ event }, ctx(transport))).toMatchObject({
      kind: "success",
      eventXml: null,
    });
  });

  it("evento já registrado é sucesso marcado", async () => {
    const { transport } = recorder({
      status: 400,
      body: JSON.stringify({
        erros: [{ Codigo: "E0840", Descricao: "Evento já registrado (sintético)" }],
      }),
    });
    expect(await nacional.cancel({ event }, ctx(transport))).toMatchObject({
      kind: "success",
      alreadyRegistered: true,
    });
  });

  it("evento duplicado sinalizado só no código também é sucesso marcado", async () => {
    const { transport } = recorder({
      status: 400,
      body: JSON.stringify({ erros: [{ Codigo: "EVENTO_DUPLICADO" }] }),
    });
    expect(await nacional.cancel({ event }, ctx(transport))).toMatchObject({
      kind: "success",
      alreadyRegistered: true,
    });
  });

  it("rejeição de evento só com código é incerta", async () => {
    const { transport } = recorder({
      status: 400,
      body: JSON.stringify({ erros: [{ codigo: "E0840" }] }),
    });
    expect(await nacional.cancel({ event }, ctx(transport))).toMatchObject({
      kind: "uncertain",
      code: "RESPONSE_UNREADABLE",
    });
  });

  it("rejeição, indisponibilidade e timeout", async () => {
    const replies = recorder(
      {
        status: 400,
        body: JSON.stringify({ erros: [{ codigo: "E1", mensagem: "Prazo expirado" }] }),
      },
      { status: 503, body: "" },
      new Error("socket hang up"),
    );
    const c = ctx(replies.transport);
    expect(await nacional.cancel({ event }, c)).toMatchObject({
      kind: "definitive",
      code: "ADN_REJECTED",
      rejections: [{ code: "E1", message: "Prazo expirado", complement: null }],
    });
    expect(await nacional.cancel({ event }, c)).toMatchObject({ kind: "transient" });
    expect(await nacional.cancel({ event }, c)).toMatchObject({
      kind: "uncertain",
      code: "TRANSPORT_UNCERTAIN",
    });
  });

  it("entrada inválida não chega ao transporte", async () => {
    const { requests, transport } = recorder();
    const outcome = await nacional.cancel(
      { event: { ...event, xMotivo: "curto" } },
      ctx(transport),
    );
    expect(outcome).toMatchObject({ kind: "definitive", code: "EVENT_FIELD_INVALID", sent: false });
    expect(requests).toHaveLength(0);
  });
});

describe("extractRejections", () => {
  it("tolera variações de caixa, mensagem de topo e lixo", () => {
    expect(extractRejections({ errors: [{ code: "X1", message: "m" }] })).toEqual([
      { code: "X1", message: "m", complement: null },
    ]);
    expect(extractRejections({ mensagem: "Falha geral" })).toEqual([
      { code: null, message: "Falha geral", complement: null },
    ]);
    expect(extractRejections({ erros: [null, 1, {}] })).toEqual([]);
    expect(extractRejections(null)).toEqual([]);
  });
});
