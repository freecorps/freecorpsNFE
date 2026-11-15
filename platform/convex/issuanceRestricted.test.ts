import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { platformTest, usePlatformEnvironment } from "../../tests/helpers/platform";
import type { IssuanceInput } from "./lib/issuanceValues";
import https from "node:https";
import * as certificateRuntime from "./lib/certificateRuntime";
import { restrictedTransportAllowed, transportModeFor } from "./lib/issuanceCore";
import { requirePlatformEnvironment } from "./environment";
// Same source module the platform resolves under test (vite.config.ts aliases the
// workspace packages to src), so the XSD catalog is registered once.
import {
  gzipB64,
  validateDpsXml,
  validatePedRegEventoXml,
} from "../../packages/fiscal-nfse/src/index";
import {
  PRODREST,
  fixture,
  type Fixture,
  domestic,
  exported,
  code,
  request,
  cancel,
  view,
  drive,
  xmlOf,
  campinasProfile,
  campinasTaker,
  installCertificate,
  openRestricted,
  certificateUses,
  claimOperation,
  fakeAuthority,
} from "../../tests/helpers/issuance";

/**
 * Phase 3: real transport to the restricted production, with a synthetic A1 made in memory.
 * Every company, CNPJ, CPF and taker is synthetic; nothing here reaches a tax authority, so
 * nothing here proves an authorization.
 */
const NOW = Date.UTC(2026, 9, 8, 15); // Thursday, 08/10/2026 12:00 in Brasília

usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-issuance",
  now: NOW,
});

describe("produção restrita (fase 3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("só sai do simulador com a variável e a empresa na lista; produção nunca é restrita", () => {
    const company = "jd7abc" as Id<"companies">;
    const sandbox = { environment: "sandbox" as const, companyId: company };
    expect(transportModeFor(sandbox)).toBe("simulated");
    vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "producao-restrita");
    expect(transportModeFor(sandbox)).toBe("simulated");
    vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", "outra1, jd7abc");
    expect([...requirePlatformEnvironment().restrictedCompanies]).toEqual(["outra1", "jd7abc"]);
    expect(transportModeFor(sandbox)).toBe("producao-restrita");
    expect(transportModeFor({ ...sandbox, companyId: "outra2" as Id<"companies"> })).toBe(
      "simulated",
    );
    // A malformed list fails closed for everyone.
    vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", "jd7abc,../x");
    expect(transportModeFor(sandbox)).toBe("simulated");
    vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", company);
    vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "producao");
    expect(transportModeFor(sandbox)).toBe("simulated");
    vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "producao-restrita");
    // PRODUCT_ENV=production does not match the local profile: it is refused before the list is
    // read, instead of a loose `false`. The production transport is chosen without the profile.
    vi.stubEnv("PRODUCT_ENV", "production");
    expect(() => restrictedTransportAllowed(company)).toThrow(
      "Invalid platform configuration: PRODUCT_ENV",
    );
    expect(transportModeFor({ environment: "production", companyId: company })).toBe("producao");
  });

  it("a variável sozinha não tira do simulador as empresas fora da lista", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted("outraempresa");
    const authority = fakeAuthority();
    const accepted = await request(f, "fora-da-lista", domestic());
    expect(accepted.issuance.transport).toBe("simulated");
    await drive(f.t, accepted.issuance.operationId);
    expect((await view(f, accepted.issuance.id)).state).toBe("authorized");
    expect(authority).not.toHaveBeenCalled();
    expect(await certificateUses(f)).toEqual([]);
  });

  it("emite pela Sefin de produção restrita com o A1 do cofre, assinado e só para a origem do alvo", async () => {
    const f = await fixture();
    const certificateId = await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = fakeAuthority();
    const accepted = await request(f, "restrita-sefin", domestic());
    expect(accepted.issuance).toMatchObject({
      transport: "producao-restrita",
      target: "sefin-nacional",
    });
    const op = await f.t.run((ctx) => ctx.db.get("operations", accepted.issuance.operationId));
    expect(op?.certificate).toEqual({ id: certificateId, version: 1 });
    expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("retry_wait");
    expect(authority).toHaveBeenCalledTimes(1);
    const [target] = authority.mock.calls[0]!;
    expect(target.url).toBe("https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse");
    expect(target.allowedOrigins).toEqual(["https://sefin.producaorestrita.nfse.gov.br"]);
    expect(JSON.parse(target.body!)).toHaveProperty("dpsXmlGZipB64");
    const done = await view(f, accepted.issuance.id);
    expect(done.artifacts.find((a) => a.kind === "dps")?.signed).toBe(true);
    const [dps] = await xmlOf(f.t, done.id, "dps");
    expect(dps).toContain("<tpAmb>2</tpAmb>");
    expect(dps).toContain("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256");
    // Its own audited purpose: the capture proof budget (`transport`) is never spent.
    expect(await certificateUses(f)).toEqual([
      "nfse-transport:authorized",
      "nfse-transport:success",
    ]);
  });

  it("Campinas vai à homologação da IMA, com RSA-SHA1", async () => {
    const f = await fixture(platformTest(), { profile: campinasProfile() });
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = fakeAuthority();
    const accepted = await request(
      f,
      "restrita-ima",
      domestic({ taker: campinasTaker, issRate: "2" }),
    );
    expect(accepted.issuance).toMatchObject({
      transport: "producao-restrita",
      target: "campinas-adn",
    });
    await drive(f.t, accepted.issuance.operationId);
    const [target] = authority.mock.calls[0]!;
    expect(target.url).toBe("https://preprod-nfseapi.ima.sp.gov.br/notafiscal-ws/nfse");
    expect(target.allowedOrigins).toEqual(["https://preprod-nfseapi.ima.sp.gov.br"]);
    const [dps] = await xmlOf(f.t, accepted.issuance.id as Id<"issuances">, "dps");
    expect(dps).toContain("http://www.w3.org/2000/09/xmldsig#rsa-sha1");
  });

  /**
   * Phase 3 criterion (#197) from 01/11/2026: the Simples provider in Campinas exports through
   * the Sefin Nacional (rule C6). The restricted Sefin is simulated here; the real proof is the
   * runbook in docs/operacao/emissao-nfse.md, section 8. Foreign taker identified by NIF or by
   * cNaoNIF 1 or 2 (E0226 forbids 0).
   */
  describe("exportação de Simples de Campinas na Sefin restrita (C6)", () => {
    const SEFIN = "https://sefin.producaorestrita.nfse.gov.br/SefinNacional";
    const KEY = `3509502${"4".repeat(43)}`;
    const json = (status: number, body: unknown) => ({
      status,
      body: Buffer.from(JSON.stringify(body)),
      contentType: "application/json",
    });
    const simplesCampinas = () =>
      campinasProfile({ opSimpNac: 3, regApTribSN: 1, municipalRegistration: "1234567" });
    const base = exported().taker as Extract<IssuanceInput["taker"], { kind: "foreign" }>;
    const { nif: _nif, ...withoutNif } = base;
    const takers = {
      NIF: base,
      "cNaoNIF-1": { ...withoutNif, nifAbsence: 1 as const },
      "cNaoNIF-2": { ...withoutNif, nifAbsence: 2 as const },
    };
    /**
     * Olinda answers only for Friday 30/10/2026: 31/10 and 01/11 are a weekend and 02/11 is a
     * holiday (Finados), so an issue on 01/11 to 03/11 freezes the 30/10 bulletin.
     */
    function ptaxOnlyOn30October() {
      return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : input.toString();
        return Response.json(
          url.includes("'10-30-2026'")
            ? { value: [{ cotacaoVenda: 5.4321, tipoBoletim: "Fechamento" }] }
            : { value: [] },
        );
      });
    }

    it("a meia-noite de 01/11 em Brasília separa a IMA (C5) da Sefin (C6)", async () => {
      vi.setSystemTime(Date.parse("2026-11-01T02:59:59Z")); // 31/10 23:59:59 in Brasília
      const f = await fixture(platformTest(), { profile: simplesCampinas() });
      const before = await request(f, "c6-antes", exported({ issueDate: undefined }));
      expect(before.issuance).toMatchObject({ target: "campinas-adn", issueDate: "2026-10-31" });
      vi.setSystemTime(Date.parse("2026-11-01T03:00:00Z")); // 01/11 00:00:00 in Brasília
      const after = await request(
        f,
        "c6-depois",
        exported({ issueDate: undefined, competence: "2026-11" }),
      );
      expect(after.issuance).toMatchObject({ target: "sefin-nacional", issueDate: "2026-11-01" });
    });

    it("recusa alíquota na exportação do Simples sem retenção antes de reservar número", async () => {
      vi.setSystemTime(Date.UTC(2026, 10, 3, 15));
      const f = await fixture(platformTest(), { profile: simplesCampinas() });
      const input = exported({ issueDate: "2026-11-03", competence: "2026-11", issRate: "2" });
      expect(await code(request(f, "c6-aliquota", input))).toBe("ISSUANCE_ISS_NOT_LEVIED");
      expect(await f.t.run((ctx) => ctx.db.query("dpsSequences").collect())).toEqual([]);
    });

    // Tuesday 03/11 with each identification, and Sunday 01/11 (the first C6 day).
    const cases = [
      ...Object.entries(takers).map(([name, taker]) => ({ name, taker, day: 3 })),
      { name: "cNaoNIF-2-em-01-11", taker: takers["cNaoNIF-2"], day: 1 },
    ];
    // Olinda is asked from the day before the issue back to Friday 30/10.
    const lookback: Record<number, string[]> = {
      1: ["10-31-2026", "10-30-2026"],
      3: ["11-02-2026", "11-01-2026", "10-31-2026", "10-30-2026"],
    };

    for (const { name, taker, day } of cases)
      it(`tomador com ${name}: autoriza e cancela na Sefin restrita, sem IM, alíquota nem IBSCBS`, async () => {
        const issueDate = `2026-11-0${day}`;
        vi.setSystemTime(Date.UTC(2026, 10, day, 15)); // 12:00 in Brasília
        const f = await fixture(platformTest(), { profile: simplesCampinas() });
        await installCertificate(f);
        openRestricted(f.where.companyId);
        const olinda = ptaxOnlyOn30October();
        const accepted = await request(
          f,
          `c6-${name}`,
          exported({ taker, issueDate, competence: "2026-11" }),
        );
        expect(accepted.issuance).toMatchObject({
          transport: "producao-restrita",
          target: "sefin-nacional",
          series: "1",
          issueDate,
        });
        const id = accepted.issuance.id as Id<"issuances">;
        let sent = "";
        const authority = fakeAuthority().mockImplementation(async (target) => {
          if (target.url === `${SEFIN}/nfse` && target.body !== undefined) {
            sent = (await xmlOf(f.t, id, "dps"))[0]!;
            const nfse =
              `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}">` +
              `<nNFSe>11</nNFSe>${sent.replace(/^<\?xml[^>]*\?>/, "")}</infNFSe></NFSe>`;
            return json(201, { chaveAcesso: KEY, nfseXmlGZipB64: gzipB64(nfse) });
          }
          if (target.url === `${SEFIN}/nfse/${KEY}/eventos` && target.body !== undefined)
            return json(201, { eventoXmlGZipB64: gzipB64("<evento>sintético</evento>") });
          return json(404, { erros: [{ Codigo: "E2220", Descricao: "Não encontrado" }] });
        });
        expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("succeeded");
        const done = await view(f, accepted.issuance.id);
        expect(done).toMatchObject({ state: "authorized", accessKey: KEY, nfseNumber: "11" });
        expect(done.exchange).toMatchObject({
          rate: "5.432100",
          quoteDate: "2026-10-30",
          brlAmount: "5432.10",
          source: "ptax-bcb",
        });
        const asked = olinda.mock.calls.map(
          ([input]) =>
            /'(\d{2}-\d{2}-\d{4})'/.exec(
              input instanceof Request ? input.url : input.toString(),
            )?.[1],
        );
        expect(asked).toEqual(lookback[day]);

        expect(validateDpsXml(sent, PRODREST)).toEqual({ valid: true });
        expect(sent).toContain("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256");
        for (const piece of [
          "<tpAmb>2</tpAmb>",
          "<cLocEmi>3509502</cLocEmi>",
          "<serie>1</serie>",
          "<regApTribSN>1</regApTribSN>",
          "<cNBS>111032200</cNBS>",
          "<vServ>5432.10</vServ>",
          "<tpMoeda>220</tpMoeda><vServMoeda>1000.00</vServMoeda>",
          "<tribISSQN>3</tribISSQN><cPaisResult>US</cPaisResult><tpRetISSQN>1</tpRetISSQN></tribMun>",
          "nifAbsence" in taker
            ? `<toma><cNaoNIF>${taker.nifAbsence}</cNaoNIF>`
            : "<toma><NIF>98-7654321</NIF>",
        ])
          expect(sent).toContain(piece);
        // The profile has an IM, cTribMun and IBS/CBS: none of them reaches the Sefin.
        for (const piece of ["<IM>", "<pAliq>", "<cTribMun>", "<IBSCBS>", "<dest>"])
          expect(sent).not.toContain(piece);

        await cancel(
          f,
          `c6-cancelar-${name}`,
          accepted.issuance.id,
          "Teste de integração sem valor",
        );
        const cancellation = await f.t.run((ctx) => ctx.db.query("issuanceCancellations").first());
        await drive(f.t, cancellation!.operationId);
        expect((await view(f, accepted.issuance.id)).state).toBe("cancelled");
        const [event] = await xmlOf(f.t, id, "cancel-request");
        expect(validatePedRegEventoXml(event!)).toEqual({ valid: true });
        expect(authority.mock.calls.map(([target]) => target.url)).toEqual([
          `${SEFIN}/nfse`,
          `${SEFIN}/nfse/${KEY}/eventos`,
        ]);
        for (const [target] of authority.mock.calls)
          expect(target.allowedOrigins).toEqual(["https://sefin.producaorestrita.nfse.gov.br"]);
      });
  });

  /**
   * Prova de 09/10/2026 (#197): o envio à IMA voltou 2xx fora do formato da Sefin e a consulta
   * ia a `/notafiscal-ws/dps/{id}`, rota inexistente; o 404 liberou o reenvio. Agora a consulta
   * vai a `{base}/dps/{id}`, baixa a NFS-e em `{base}/{chave}` e autoriza sem reenviar.
   */
  describe("reconciliação na IMA (#197)", () => {
    const BASE = "https://preprod-nfseapi.ima.sp.gov.br/notafiscal-ws/nfse";
    const KEY = `3509502${"2".repeat(43)}`;
    const json = (status: number, body: unknown) => ({
      status,
      body: Buffer.from(JSON.stringify(body)),
      contentType: "application/json",
    });
    const nfseOf = (dps: string) =>
      `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}">` +
      `<nNFSe>7</nNFSe>${dps.replace(/^<\?xml[^>]*\?>/, "")}</infNFSe></NFSe>`;
    async function campinasIssue(idempotencyKey: string) {
      const f = await fixture(platformTest(), { profile: campinasProfile() });
      await installCertificate(f);
      openRestricted(f.where.companyId);
      const accepted = await request(
        f,
        idempotencyKey,
        domestic({ taker: campinasTaker, issRate: "2" }),
      );
      return { f, accepted, id: accepted.issuance.id as Id<"issuances"> };
    }
    async function attemptsOf(f: Fixture, operationId: Id<"operations">) {
      return f.t.run((ctx) =>
        ctx.db
          .query("operationAttempts")
          .withIndex("by_operationId_and_generation_and_fence", (q) =>
            q.eq("operationId", operationId),
          )
          .collect(),
      );
    }

    it("envio ilegível guarda o diagnóstico; a consulta encontra, baixa e autoriza sem reenviar", async () => {
      const { f, accepted, id } = await campinasIssue("ima-reconcilia");
      let dps = "";
      const authority = fakeAuthority().mockImplementation(async (target) => {
        if (target.url === BASE && target.body !== undefined) {
          dps = (await xmlOf(f.t, id, "dps"))[0]!;
          return json(201, { tipoAmbiente: 2, idDps: accepted.issuance.dpsId, numero: "7" });
        }
        if (target.url === `${BASE}/dps/${accepted.issuance.dpsId}`)
          return json(200, { tipoAmbiente: 2, chaveAcesso: KEY });
        if (target.url === `${BASE}/${KEY}`)
          return json(200, { nfseXmlGZipB64: gzipB64(nfseOf(dps)) });
        return { status: 404, body: Buffer.from("<html>Not Found</html>") };
      });
      const first = await drive(f.t, accepted.issuance.operationId);
      expect(first).toMatchObject({ state: "reconciling", code: "RESPONSE_UNREADABLE" });
      const [attempt] = await attemptsOf(f, accepted.issuance.operationId);
      expect(attempt).toMatchObject({
        mode: "execute",
        code: "RESPONSE_UNREADABLE",
        diagnostic: {
          httpStatus: 201,
          contentType: "application/json",
          body: "json-object",
          keys: ["tipoAmbiente", "idDps", "numero"],
        },
      });
      // Names only: neither the DPS Id nor the number reach the attempt.
      expect(JSON.stringify(attempt)).not.toContain(accepted.issuance.dpsId);
      const done = await drive(f.t, accepted.issuance.operationId);
      expect(done.state).toBe("succeeded");
      expect(await f.t.run((ctx) => ctx.db.get("issuances", id))).toMatchObject({
        state: "authorized",
        accessKey: KEY,
        recoveredByConsult: true,
        submissions: 1,
      });
      expect(authority.mock.calls.map(([target]) => target.url)).toEqual([
        BASE,
        `${BASE}/dps/${accepted.issuance.dpsId}`,
        `${BASE}/${KEY}`,
      ]);
    });

    it("404 sem o JSON do fisco na consulta não reenvia e guarda o diagnóstico", async () => {
      const { f, accepted } = await campinasIssue("ima-404");
      const authority = fakeAuthority().mockImplementation(async (target) =>
        target.body !== undefined
          ? json(201, {})
          : {
              status: 404,
              body: Buffer.from("<!DOCTYPE html><html><body>404</body></html>"),
              contentType: "text/html;charset=utf-8",
            },
      );
      await drive(f.t, accepted.issuance.operationId);
      const op = await drive(f.t, accepted.issuance.operationId, 2);
      expect(op).toMatchObject({ state: "reconciling", code: "CONSULT_INCONCLUSIVE" });
      const posts = authority.mock.calls.filter(([target]) => target.body !== undefined);
      expect(posts).toHaveLength(1);
      const attempts = await attemptsOf(f, accepted.issuance.operationId);
      expect(attempts.map((a) => [a.mode, a.code])).toEqual([
        ["execute", "RESPONSE_UNREADABLE"],
        ["reconcile", "CONSULT_INCONCLUSIVE"],
        ["reconcile", "CONSULT_INCONCLUSIVE"],
      ]);
      expect(attempts[1]!.diagnostic).toEqual({
        httpStatus: 404,
        contentType: "text/html",
        body: "html",
        keys: [],
      });
      expect((await view(f, accepted.issuance.id)).state).toBe("processing");
    });

    it("'DPS já existe' continua levando a reconciliar, não a rejeitar", async () => {
      const { f, accepted } = await campinasIssue("ima-duplicada");
      fakeAuthority().mockImplementation(async (target) =>
        target.body !== undefined
          ? json(400, { erros: [{ Codigo: "E0014", Descricao: "DPS já existe" }] })
          : json(200, { tipoAmbiente: 2 }),
      );
      const op = await drive(f.t, accepted.issuance.operationId);
      expect(op).toMatchObject({
        state: "reconciling",
        code: "DPS_ALREADY_EXISTS",
        uncertain: true,
      });
      expect((await view(f, accepted.issuance.id)).state).toBe("processing");
    });

    it("chave de NFS-e de outra DPS não autoriza nem reenvia", async () => {
      const { f, accepted, id } = await campinasIssue("ima-outra-dps");
      let dps = "";
      const authority = fakeAuthority().mockImplementation(async (target) => {
        if (target.body !== undefined) {
          dps = (await xmlOf(f.t, id, "dps"))[0]!;
          return json(201, {});
        }
        if (target.url.includes("/dps/")) return json(200, { chaveAcesso: KEY });
        const other = dps.replaceAll(
          accepted.issuance.dpsId,
          `${accepted.issuance.dpsId.slice(0, -1)}9`,
        );
        return json(200, { nfseXmlGZipB64: gzipB64(nfseOf(other)) });
      });
      await drive(f.t, accepted.issuance.operationId);
      const op = await drive(f.t, accepted.issuance.operationId);
      expect(op).toMatchObject({ state: "reconciling", code: "NFSE_DPS_MISMATCH" });
      expect(await f.t.run((ctx) => ctx.db.get("issuances", id))).toMatchObject({
        state: "processing",
        submissions: 1,
      });
      expect(authority.mock.calls.filter(([target]) => target.body !== undefined)).toHaveLength(1);
    });
  });

  it("busca a PTAX na Olinda e só lá, sem certificado", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    fakeAuthority();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ value: [{ cotacaoVenda: 5.4321, tipoBoletim: "Fechamento" }] }),
      );
    const accepted = await request(f, "restrita-usd", exported());
    await drive(f.t, accepted.issuance.operationId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [input, init] = fetchSpy.mock.calls[0]!;
    const url = input instanceof Request ? input.url : input.toString();
    expect(url).toMatch(/^https:\/\/olinda\.bcb\.gov\.br\/olinda\/servico\/PTAX\//);
    expect(url).toContain("'10-04-2026'");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect((await view(f, accepted.issuance.id)).exchange).toMatchObject({
      rate: "5.432100",
      quoteDate: "2026-10-04",
      source: "ptax-bcb",
      brlAmount: "5432.10",
    });
  });

  it("o simulado nunca abre rede nem o cofre, da PTAX ao cancelamento", async () => {
    const f = await fixture();
    await installCertificate(f);
    const authority = fakeAuthority();
    const vault = vi.spyOn(certificateRuntime, "withCertificate");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const socket = vi.spyOn(https, "request");
    const accepted = await request(f, "simulado", exported());
    expect(accepted.issuance.transport).toBe("simulated");
    await drive(f.t, accepted.issuance.operationId);
    expect((await view(f, accepted.issuance.id)).state).toBe("authorized");
    await cancel(f, "simulado-cancelar", accepted.issuance.id, "Teste do simulado sem rede");
    const cancellation = await f.t.run((ctx) => ctx.db.query("issuanceCancellations").first());
    await drive(f.t, cancellation!.operationId);
    expect((await view(f, accepted.issuance.id)).state).toBe("cancelled");
    for (const spy of [authority, vault, fetchSpy, socket]) expect(spy).not.toHaveBeenCalled();
    expect(await certificateUses(f)).toEqual([]);
  });

  it("o cofre nega a emissão fora da política, inclusive produção, e audita a recusa", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const accepted = await request(f, "cofre", domestic());
    const token = await claimOperation(f.t, accepted.issuance.operationId);
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).not.toBeNull();
    // The company left the list while the operation waited.
    vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", "");
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    // The capture homologation variables do not open the NFS-e purpose.
    vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "");
    vi.stubEnv("FISCAL_ENV", "homologation");
    vi.stubEnv("FNFE_CAPTURE_TRANSPORT", "sefaz");
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    vi.stubEnv("FISCAL_ENV", "disabled");
    vi.stubEnv("FNFE_CAPTURE_TRANSPORT", "");
    // Real production is refused by the vault even with the restricted transport open.
    openRestricted(f.where.companyId);
    await f.t.run((ctx) =>
      ctx.db.patch("issuances", accepted.issuance.id as Id<"issuances">, { transport: "producao" }),
    );
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    expect(await certificateUses(f)).toEqual([
      "nfse-transport:authorized",
      "nfse-transport:denied",
      "nfse-transport:denied",
      "nfse-transport:denied",
    ]);
  });

  it("o alvo da #50 nunca recebe o A1 da emissão, nem com o marcador de produção e o gate", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const accepted = await request(f, "alvo-50", domestic());
    const token = await claimOperation(f.t, accepted.issuance.operationId);
    // The gate as if open: no deployment but the fiscal production one can change it.
    await f.t.run((ctx) =>
      ctx.db.insert("issuanceGates", {
        organizationId: f.where.organizationId,
        companyId: f.where.companyId,
        production: true,
        actor: "operador-freecorps",
        reason: "Prova sintética: o alvo da #50 não emite",
        version: 1,
        updatedAt: Date.now(),
      }),
    );
    // The issuance and its operation as if accepted in production on that target.
    await f.t.run(async (ctx) => {
      await ctx.db.patch("operations", token.operationId, { environment: "production" });
      await ctx.db.patch("issuances", accepted.issuance.id as Id<"issuances">, {
        environment: "production",
        transport: "producao",
      });
    });
    // The #50 capture target: validation profile, production data, capture transport open.
    for (const [name, value] of Object.entries({
      APP_ENV: "validation",
      PRODUCT_ENV: "production",
      FNFE_PROOF_FISCAL_ENV: "production",
      FISCAL_ENV: "production",
      FNFE_CAPTURE_TRANSPORT: "sefaz",
      EMAIL_MODE: "disabled",
      SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
      CONVEX_CLOUD_URL: "https://modest-seal-118.convex.cloud",
      FNFE_NFSE_SANDBOX_TRANSPORT: "",
      FNFE_NFSE_RESTRICTED_COMPANIES: "",
    }))
      vi.stubEnv(name, value);
    // Without the mark the target runs, and the vault refuses and audits the refusal.
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    expect(await certificateUses(f)).toEqual(["nfse-production:denied"]);
    // With the mark the target does not even run: the profile refuses it before the vault.
    vi.stubEnv("FNFE_ISSUANCE_ENV", "production");
    await expect(f.t.mutation(internal.certificateUse.authorize, token)).rejects.toThrow(
      "FNFE_ISSUANCE_ENV",
    );
    expect(await certificateUses(f)).toEqual(["nfse-production:denied"]);
  });

  it("recusa do cofre no meio da tentativa: política fechada para de vez, certificado recusado espera", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = fakeAuthority();
    // The policy closes after the executor read it open, and the vault refuses.
    const closed = await request(f, "politica-fecha", domestic());
    vi.spyOn(certificateRuntime, "withCertificate").mockImplementationOnce(async () => {
      vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", "");
      throw new Error("CERTIFICATE_UNAVAILABLE");
    });
    expect(await drive(f.t, closed.issuance.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(await view(f, closed.issuance.id)).toMatchObject({
      state: "rejected",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    // The policy stays open and only the certificate is refused: wait for a usable one.
    openRestricted(f.where.companyId);
    const waiting = await request(f, "certificado-recusado", domestic());
    vi.spyOn(certificateRuntime, "withCertificate").mockImplementationOnce(async () => {
      throw new Error("CERTIFICATE_UNAVAILABLE");
    });
    expect(await drive(f.t, waiting.issuance.operationId)).toMatchObject({
      state: "retry_wait",
      code: "CERTIFICATE_UNAVAILABLE",
    });
    expect((await view(f, waiting.issuance.id)).state).toBe("processing");
    expect(authority).not.toHaveBeenCalled();
  });

  /** The next vault use closes the restricted policy and refuses, as if both raced the attempt. */
  function closeOnNextVaultUse() {
    vi.spyOn(certificateRuntime, "withCertificate").mockImplementationOnce(async () => {
      vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", "");
      throw new Error("CERTIFICATE_UNAVAILABLE");
    });
  }

  it("emissão já enviada uma vez não é rejeitada quando o cofre recusa e a política fecha", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = fakeAuthority();
    const accepted = await request(f, "enviada-uma-vez", domestic());
    // The first attempt reaches the (synthetic, unavailable) authority: one submission.
    expect(await drive(f.t, accepted.issuance.operationId)).toMatchObject({ state: "retry_wait" });
    expect(authority).toHaveBeenCalled();
    const sent = await f.t.run((ctx) =>
      ctx.db.get("issuances", accepted.issuance.id as Id<"issuances">),
    );
    expect(sent!.submissions).toBe(1);
    closeOnNextVaultUse();
    expect(await drive(f.t, accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "CERTIFICATE_UNAVAILABLE",
    });
    expect(await view(f, accepted.issuance.id)).toMatchObject({ state: "processing" });
  });

  it("cancelamento: sem envio, política fechada falha de vez e a nota segue autorizada; com envio, reconcilia", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = fakeAuthority();
    const accepted = await request(f, "para-cancelar", domestic());
    const issuanceId = accepted.issuance.id as Id<"issuances">;
    // Authorized as if the restricted authority had answered.
    await f.t.run(async (ctx) => {
      await ctx.db.patch("issuances", issuanceId, {
        state: "authorized",
        accessKey: "3".repeat(50),
      });
      await ctx.db.patch("operations", accepted.issuance.operationId as Id<"operations">, {
        state: "succeeded",
      });
    });
    const cancellationOf = async (key: string) => {
      await cancel(f, key, issuanceId, "Prova sintética do cancelamento restrito");
      const rows = await f.t.run((ctx) => ctx.db.query("issuanceCancellations").collect());
      return rows.at(-1)!;
    };

    const unsent = await cancellationOf("cancelar-sem-envio");
    closeOnNextVaultUse();
    expect(await drive(f.t, unsent.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(await f.t.run((ctx) => ctx.db.get("issuanceCancellations", unsent._id))).toMatchObject({
      state: "rejected",
      submissions: 0,
    });
    expect(await view(f, issuanceId)).toMatchObject({ state: "authorized" });
    expect(authority).not.toHaveBeenCalled();

    openRestricted(f.where.companyId);
    const sent = await cancellationOf("cancelar-com-envio");
    expect(await drive(f.t, sent.operationId)).toMatchObject({ state: "retry_wait" });
    expect(authority).toHaveBeenCalled();
    expect(
      (await f.t.run((ctx) => ctx.db.get("issuanceCancellations", sent._id)))!.submissions,
    ).toBe(1);
    closeOnNextVaultUse();
    expect(await drive(f.t, sent.operationId)).toMatchObject({
      state: "reconciling",
      code: "CERTIFICATE_UNAVAILABLE",
    });
    expect(await f.t.run((ctx) => ctx.db.get("issuanceCancellations", sent._id))).toMatchObject({
      state: "processing",
    });
    expect(await view(f, issuanceId)).toMatchObject({ state: "authorized" });
  });

  it("desligar a variável com a emissão na fila para o executor antes de enviar", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = fakeAuthority();
    const accepted = await request(f, "revogada", domestic());
    vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "simulated");
    await drive(f.t, accepted.issuance.operationId);
    expect(await view(f, accepted.issuance.id)).toMatchObject({
      state: "rejected",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(authority).not.toHaveBeenCalled();
  });
});
