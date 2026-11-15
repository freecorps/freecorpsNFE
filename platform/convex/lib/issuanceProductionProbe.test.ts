import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import * as certificateTransport from "./certificateTransport";
// Same source module the platform resolves under test, so the XSD catalog is registered once.
import * as fiscalNfse from "../../../packages/fiscal-nfse/src/index";
import { gzipB64 } from "../../../packages/fiscal-nfse/src/index";
import { usePlatformEnvironment } from "../../../tests/helpers/platform";
import {
  target50,
  stub,
  NOW,
  SEFIN,
  KEY,
  json,
  nfseOf,
  fixture,
  type Fixture,
  code,
  authorized,
} from "../../../tests/helpers/issuanceProduction";

/**
 * Fiscal production (ADR 0004 §8): the operator probe and the read-only verification.
 * Every company, key and certificate is synthetic, and the mTLS call is replaced: nothing here
 * reaches a tax authority.
 */
vi.mock("../../../deploy/issuance-production.json", () => ({
  default: {
    version: 1,
    deployment: "brave-otter-123",
    url: "https://brave-otter-123.convex.cloud",
  },
}));

// ---------------------------------------------------------------------------------------------
// Issuance in `production`. The data is prepared on the loopback stack, then the deployment
// profile is switched; the requests come from an API key, which needs no session.

describe("emissão em production", () => {
  usePlatformEnvironment({
    siteUrl: "http://localhost:5199",
    convexSiteUrl: "http://127.0.0.1:3258",
    secret: "synthetic-issuance-production",
    now: NOW,
  });
  afterEach(() => vi.restoreAllMocks());

  // -------------------------------------------------------------------------------------------
  // Operator probe and read-only verification on the fiscal production deployment.

  const ADN = "https://adn.nfse.gov.br";
  const probeArgs = (f: Fixture, extra: Record<string, unknown> = {}) => ({
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    operator: "operador-freecorps",
    reason: "Fase 4 (#198): prova de mTLS e adesão em produção",
    ...extra,
  });
  const probe = (f: Fixture, extra: Record<string, unknown> = {}) =>
    f.t.action(internal.issuanceProbe.verify, probeArgs(f, extra));
  const verifyIssued = (f: Fixture, issuanceId: string, extra: Record<string, unknown> = {}) =>
    f.t.action(internal.issuanceProbe.verifyIssued, {
      ...probeArgs(f, { reason: "Fase 4 (#198): conferência da nota autorizada", ...extra }),
      issuanceId: issuanceId as Id<"issuances">,
    });
  const history = (f: Fixture) => f.t.run((ctx) => ctx.db.query("issuanceProbeEvents").collect());
  const certificateActors = (f: Fixture) =>
    f.t.run(async (ctx) =>
      (await ctx.db.query("certificateAudit").collect())
        .filter((row) => row.action.startsWith("nfse-probe"))
        .map((row) => `${row.action}:${row.result}:${row.actor}`),
    );
  /** The authorities of production, replaced; every call is recorded. */
  function productionAuthority(answers: { dpsKey?: string | null; nfse?: string | null } = {}) {
    return vi
      .spyOn(certificateTransport, "certificateRequest")
      .mockImplementation(async (target) => {
        if (target.url.startsWith(`${SEFIN}/dps/`))
          return answers.dpsKey
            ? json(200, { tipoAmbiente: 1, chaveAcesso: answers.dpsKey })
            : json(404, {
                tipoAmbiente: 1,
                erros: [{ Codigo: "E2220", Descricao: "Não encontrada" }],
              });
        if (target.url.startsWith(`${SEFIN}/nfse/`) && answers.nfse)
          return json(200, { nfseXmlGZipB64: gzipB64(answers.nfse) });
        if (target.url.endsWith("/convenio"))
          return json(200, {
            parametrosConvenio: { aderenteAmbienteNacional: 1, aderenteEmissorNacional: 1 },
          });
        if (target.url.startsWith(`${ADN}/parametrizacao/`)) return json(200, { Aliq: 2 });
        return json(404, { erros: [{ Codigo: "E2220", Descricao: "Não encontrado" }] });
      });
  }

  it("o probe de produção recusa empresa fora da lista e registra a recusa só no histórico", async () => {
    const f = await fixture();
    const fake = productionAuthority();
    f.onProduction("");
    expect(await code(probe(f))).toBe("ISSUANCE_PROBE_DISABLED");
    expect(fake).not.toHaveBeenCalled();
    expect(await certificateActors(f)).toEqual(["nfse-probe-production:denied:operator:freecorps"]);
    expect(await history(f)).toEqual([
      expect.objectContaining({
        kind: "probe",
        environment: "producao",
        result: "denied",
        code: "ISSUANCE_PROBE_DISABLED",
        operator: "operador-freecorps",
      }),
    ]);
  });

  it("fora do deployment de produção fiscal não há probe de produção nem verificação", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    const fake = productionAuthority({ dpsKey: KEY });
    stub({ ...target50, FNFE_ISSUANCE_ENV: undefined, FNFE_NFSE_PRODUCTION_COMPANIES: undefined });
    expect(await code(probe(f))).toBe("ISSUANCE_PROBE_DISABLED");
    expect(await code(verifyIssued(f, issuance.id))).toBe("ISSUANCE_PROBE_DISABLED");
    expect(fake).not.toHaveBeenCalled();
    expect((await history(f)).map((row) => `${row.kind}:${row.environment}:${row.result}`)).toEqual(
      ["probe:producao-restrita:denied", "verify-issued:producao-restrita:denied"],
    );
  });

  it("recusa operador ou motivo inválido e empresa de demonstração, sem histórico", async () => {
    const f = await fixture();
    f.onProduction();
    const fake = productionAuthority();
    for (const extra of [
      { operator: "operador@freecorps" },
      { reason: "curto" },
      { reason: "Motivo sintético ‮ invertido" },
    ])
      expect(await code(probe(f, extra))).toBe("INVALID_REQUEST");
    expect(await history(f)).toEqual([]);
    expect(fake).not.toHaveBeenCalled();
  });

  it("verifica só emissão autorizada em production, da própria empresa", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    await f.gate(true);
    const fake = productionAuthority({ dpsKey: KEY });
    // Still processing: nothing to verify.
    const processing = await f.request("ainda-processando");
    expect(await code(verifyIssued(f, processing.issuance.id))).toBe("ISSUANCE_NOT_AUTHORIZED");
    // An issuance of another company is never found, nor read.
    const other = await f.t.run(async (ctx) => {
      const company = (await ctx.db.get("companies", f.scope.companyId))!;
      const { _id, _creationTime, ...rest } = company;
      return ctx.db.insert("companies", { ...rest, cnpj: "11444777000161" });
    });
    expect(
      await code(
        f.t.action(internal.issuanceProbe.verifyIssued, {
          ...probeArgs(f, { companyId: other }),
          issuanceId: issuance.id as Id<"issuances">,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(fake).not.toHaveBeenCalled();
  });

  it("probe de produção: só GET, só Sefin e ADN de produção, histórico com o login", async () => {
    const f = await fixture();
    f.onProduction();
    const fake = productionAuthority();
    const result = await probe(f, {
      municipalityCode: "3550308",
      productionAdhesion: true,
      parameters: { serviceCode: "010501", competence: "2026-10", production: true },
    });
    expect(result.consultations).toEqual([
      expect.objectContaining({
        target: "sefin-nacional",
        host: "sefin.nfse.gov.br",
        outcome: "not-found",
        httpStatus: 404,
      }),
    ]);
    expect(result.adhesion).toEqual([
      expect.objectContaining({
        source: "adn-producao",
        host: "adn.nfse.gov.br",
        aderenteEmissorNacional: 1,
      }),
    ]);
    expect(new Set(result.parameters.map((row) => row.host))).toEqual(new Set(["adn.nfse.gov.br"]));
    for (const [target] of fake.mock.calls) {
      expect(target.body).toBeUndefined();
      expect(["https://sefin.nfse.gov.br", "https://adn.nfse.gov.br"]).toContain(
        new URL(target.url).origin,
      );
      expect(target.allowedOrigins).toEqual([new URL(target.url).origin]);
    }
    const rows = await history(f);
    expect(rows.map((row) => row.result)).toEqual(["authorized", "success"]);
    expect(rows[1]).toMatchObject({
      kind: "probe",
      environment: "producao",
      operator: "operador-freecorps",
      startedId: rows[0]!._id,
    });
    expect(rows[1]!.reads!.length).toBe(fake.mock.calls.length);
    // The customer's certificate audit carries the generic operator only.
    // The customer sees that the A1 was used against the production, never by whom.
    expect(await certificateActors(f)).toEqual([
      "nfse-probe-production:authorized:operator:freecorps",
      "nfse-probe-production:success:operator:freecorps",
    ]);
    expect((await f.rows()).numbers).toEqual([]);
  });

  it("verifica a nota autorizada: uma única NFS-e para o Id, só com GET, sem mudar nada", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    const before = await f.issuanceRow(issuance.id);
    f.onProduction();
    const dps = await f.dpsOf(issuance.id);
    const fake = productionAuthority({ dpsKey: KEY, nfse: nfseOf(dps) });
    const result = await verifyIssued(f, issuance.id);
    expect(result).toMatchObject({
      dpsId: issuance.dpsId,
      accessKey: KEY,
      dps: { outcome: "found", accessKey: KEY },
      nfse: { outcome: "found", dpsMatches: true },
      single: true,
    });
    expect(fake.mock.calls.map(([target]) => [target.body, target.url])).toEqual([
      [undefined, `${SEFIN}/dps/${issuance.dpsId}`],
      [undefined, `${SEFIN}/nfse/${KEY}`],
    ]);
    expect(await f.issuanceRow(issuance.id)).toEqual(before);
    const rows = await history(f);
    expect(rows[1]).toMatchObject({
      kind: "verify-issued",
      result: "success",
      issuanceId: issuance.id,
      single: true,
    });
  });

  it("verificação aponta quando a Sefin responde outra nota para o Id", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    const otherKey = `3550308${"5".repeat(43)}`;
    const foreign = nfseOf('<DPS><infDPS Id="DPS-outra"></infDPS></DPS>');
    productionAuthority({ dpsKey: otherKey, nfse: foreign });
    const result = await verifyIssued(f, issuance.id);
    expect(result).toMatchObject({
      dps: { outcome: "found", accessKey: otherKey },
      nfse: { dpsMatches: false },
      single: false,
    });
    expect((await history(f)).at(-1)).toMatchObject({ result: "success", single: false });
  });

  it("verifica só nota autorizada ou cancelada, em production", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    const fake = productionAuthority({ dpsKey: KEY });
    const id = issuance.id as Id<"issuances">;
    for (const change of [{ state: "rejected" as const }, { environment: "sandbox" as const }]) {
      const before = (await f.issuanceRow(issuance.id))!;
      await f.t.run((ctx) => ctx.db.patch("issuances", id, change));
      expect(await code(verifyIssued(f, issuance.id))).toBe("ISSUANCE_NOT_AUTHORIZED");
      await f.t.run((ctx) =>
        ctx.db.patch("issuances", id, { state: before.state, environment: before.environment }),
      );
    }
    expect(fake).not.toHaveBeenCalled();
  });

  it("o probe de produção recusa um host fora da lista fixa, sem chamada", async () => {
    const f = await fixture();
    f.onProduction();
    const fake = productionAuthority();
    const real = fiscalNfse.resolveEndpoint;
    vi.spyOn(fiscalNfse, "resolveEndpoint").mockImplementation((target) => ({
      ...real(target),
      host: "sefin.nfse.example",
    }));
    expect(await code(probe(f))).toBe("PROBE_HOST_DENIED");
    expect(fake).not.toHaveBeenCalled();
    expect((await history(f)).map((row) => row.result)).toEqual(["authorized", "failed"]);
  });

  it("o transporte do probe só faz GET sem corpo", async () => {
    const f = await fixture();
    f.onProduction();
    const fake = productionAuthority();
    vi.spyOn(fiscalNfse.nacional, "consultByDps").mockImplementation(async (_, io) => {
      await io.transport({ method: "POST", url: `${SEFIN}/nfse`, headers: {}, body: "{}" });
      throw new Error("unreachable");
    });
    expect(await code(probe(f))).toBe("PROBE_GET_ONLY");
    expect(fake).not.toHaveBeenCalled();
  });

  it("falha de transporte na verificação grava failed, sem single", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    vi.spyOn(certificateTransport, "certificateRequest").mockImplementation(async () => {
      throw new Error("CERTIFICATE_TIMEOUT");
    });
    const result = await verifyIssued(f, issuance.id);
    expect(result).toMatchObject({ single: null, dps: { transportError: "CERTIFICATE_TIMEOUT" } });
    const last = (await history(f)).at(-1)!;
    expect(last).toMatchObject({ kind: "verify-issued", result: "failed" });
    expect(last).not.toHaveProperty("single");
  });

  it("toda recusa depois do operador válido fica no histórico, com o código", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    await f.gate(true);
    const fake = productionAuthority({ dpsKey: KEY });
    const other = await f.t.run((ctx) =>
      ctx.db.insert("organizations", {
        name: "Outra organização sintética",
        slug: `outra-${crypto.randomUUID()}`,
        ownerCount: 1,
        memberCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const processing = await f.request("ainda-processando-historico");
    expect(await code(probe(f, { organizationId: other }))).toBe("NOT_FOUND");
    expect(
      await code(
        f.t.action(internal.issuanceProbe.verifyIssued, {
          ...probeArgs(f, { organizationId: other }),
          issuanceId: issuance.id as Id<"issuances">,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(await code(verifyIssued(f, processing.issuance.id))).toBe("ISSUANCE_NOT_AUTHORIZED");
    // Without a usable certificate.
    await f.t.run(async (ctx) => {
      const head = (await ctx.db.query("certificateHeads").first())!;
      await ctx.db.patch("certificateHeads", head._id, { activeId: undefined });
    });
    expect(await code(probe(f))).toBe("CERTIFICATE_UNAVAILABLE");
    f.onProduction("");
    expect(await code(probe(f))).toBe("CERTIFICATE_UNAVAILABLE");
    expect(fake).not.toHaveBeenCalled();
    const rows = await history(f);
    expect(rows.map((row) => `${row.kind}:${row.result}:${row.code}`)).toEqual([
      "probe:denied:NOT_FOUND",
      "verify-issued:denied:NOT_FOUND",
      "verify-issued:denied:ISSUANCE_NOT_AUTHORIZED",
      "probe:denied:CERTIFICATE_UNAVAILABLE",
      "probe:denied:CERTIFICATE_UNAVAILABLE",
    ]);
    expect(rows.every((row) => row.operator === "operador-freecorps")).toBe(true);
  });

  it("empresa de demonstração: recusa com histórico", async () => {
    const f = await fixture({ kind: "demonstration" });
    f.onProduction();
    expect(await code(probe(f))).toBe("ISSUANCE_DEMONSTRATION_DENIED");
    expect((await history(f)).map((row) => `${row.result}:${row.code}`)).toEqual([
      "denied:ISSUANCE_DEMONSTRATION_DENIED",
    ]);
  });

  it("verificação recusa empresa fora da lista, com histórico", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    const fake = productionAuthority({ dpsKey: KEY });
    f.onProduction("");
    expect(await code(verifyIssued(f, issuance.id))).toBe("ISSUANCE_PROBE_DISABLED");
    expect(fake).not.toHaveBeenCalled();
    expect((await history(f)).at(-1)).toMatchObject({
      kind: "verify-issued",
      result: "denied",
      code: "ISSUANCE_PROBE_DISABLED",
      issuanceId: issuance.id,
    });
  });

  it("verifica só emissão para producao e sefin-nacional, com chave", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    const fake = productionAuthority({ dpsKey: KEY });
    const id = issuance.id as Id<"issuances">;
    const before = (await f.issuanceRow(issuance.id))!;
    for (const change of [
      { transport: "producao-restrita" as const },
      { target: "campinas-adn" },
      { accessKey: undefined },
    ]) {
      await f.t.run((ctx) => ctx.db.patch("issuances", id, change));
      expect(await code(verifyIssued(f, issuance.id))).toBe("ISSUANCE_NOT_AUTHORIZED");
      await f.t.run((ctx) =>
        ctx.db.patch("issuances", id, {
          transport: before.transport,
          target: before.target,
          accessKey: before.accessKey,
        }),
      );
    }
    expect(fake).not.toHaveBeenCalled();
  });

  it("verifica nota cancelada", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    await f.t.run((ctx) =>
      ctx.db.patch("issuances", issuance.id as Id<"issuances">, { state: "cancelled" }),
    );
    productionAuthority({ dpsKey: KEY, nfse: nfseOf(await f.dpsOf(issuance.id)) });
    expect(await verifyIssued(f, issuance.id)).toMatchObject({ single: true });
  });

  it.each([
    ["a mesma chave, mas a NFS-e de outra DPS", { sameKey: true, sameDps: false }],
    ["outra chave, com a NFS-e da mesma DPS", { sameKey: false, sameDps: true }],
  ])("single é falso com %s", async (_, answer) => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    const dps = await f.dpsOf(issuance.id);
    productionAuthority({
      dpsKey: answer.sameKey ? KEY : `3550308${"6".repeat(43)}`,
      nfse: nfseOf(answer.sameDps ? dps : '<DPS><infDPS Id="DPS-outra"></infDPS></DPS>'),
    });
    expect(await verifyIssued(f, issuance.id)).toMatchObject({ single: false });
    expect((await history(f)).at(-1)).toMatchObject({ result: "success", single: false });
  });

  it("DPS sem resposta conclusiva deixa single nulo", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    productionAuthority({ dpsKey: null, nfse: null });
    expect(await verifyIssued(f, issuance.id)).toMatchObject({
      dps: { outcome: "not-found" },
      single: null,
    });
    expect((await history(f)).at(-1)).toMatchObject({ result: "success", single: null });
  });

  it("o fechamento só vale para uma linha autorizada da mesma empresa, uma vez", async () => {
    const f = await fixture();
    f.onProduction();
    productionAuthority();
    await probe(f);
    const rows = await history(f);
    const started = rows[0]!;
    const certificate = (await f.t.run((ctx) => ctx.db.query("certificates").first()))!;
    const close = (
      eventId: Id<"issuanceProbeEvents">,
      companyId = f.scope.companyId,
      certificateId = certificate._id,
    ) =>
      f.t.mutation(internal.certificateUse.completeProbe, {
        organizationId: f.scope.organizationId,
        companyId,
        eventId,
        certificateId,
        version: certificate.version,
        result: "success",
        reads: [],
      });
    // A second closing, a closing of the closing row itself, or by another company, adds nothing.
    const other = await f.t.run(async (ctx) => {
      const company = (await ctx.db.get("companies", f.scope.companyId))!;
      const { _id, _creationTime, ...rest } = company;
      return ctx.db.insert("companies", { ...rest, cnpj: "11444777000161" });
    });
    // Another company with its own certificate cannot close a run still open of this company.
    const otherCertificate = await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = certificate;
      return ctx.db.insert("certificates", { ...rest, companyId: other });
    });
    const open = await f.t.mutation(internal.certificateUse.authorizeProbe, {
      ...probeArgs(f),
      kind: "probe",
    });
    if ("denied" in open) throw new Error("expected an authorized run");
    await close(open.eventId, other, otherCertificate);
    expect((await history(f)).filter((row) => row.startedId === open.eventId)).toEqual([]);
    await close(started._id);
    await close(rows[1]!._id);
    // A denied row is never closed.
    f.onProduction("");
    await code(probe(f));
    const denied = (await history(f)).at(-1)!;
    await close(denied._id);
    expect((await history(f)).length).toBe(4);
  });
});
