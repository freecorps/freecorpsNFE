import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Id } from "../_generated/dataModel";
import * as certificateRuntime from "./certificateRuntime";
import * as certificateTransport from "./certificateTransport";
// Same source module the platform resolves under test, so the XSD catalog is registered once.
import * as fiscalNfse from "../../../packages/fiscal-nfse/src/index";
import { gzipB64 } from "../../../packages/fiscal-nfse/src/index";
import { usePlatformEnvironment } from "../../../tests/helpers/platform";
import {
  NOW,
  SEFIN,
  KEY,
  json,
  nfseOf,
  fixture,
  type Fixture,
  code,
  authority,
  authorized,
} from "../../../tests/helpers/issuanceProduction";

/**
 * Fiscal production (ADR 0004 §8): reconciliation of a submitted issuance, the origin lock, the
 * policy marks and the cancellation of a real invoice.
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
  // Reconciliation of a submitted issuance: a consultation under the cancellation rule (the list,
  // not the gate); a resend is a new submission and needs the gate on.

  /** The Sefin of production, scripted: each submission in turn, and whether the DPS exists. */
  function scripted(f: Fixture, submits: Array<"timeout" | "authorize" | "duplicate">) {
    const state = { issuanceId: "", sent: "", exists: false };
    const spy = vi
      .spyOn(certificateTransport, "certificateRequest")
      .mockImplementation(async (target) => {
        if (target.url === `${SEFIN}/nfse` && target.body !== undefined) {
          state.sent = await f.dpsOf(state.issuanceId);
          const next = submits.shift() ?? "authorize";
          if (next === "timeout") {
            state.exists = true;
            throw new Error("CERTIFICATE_TIMEOUT");
          }
          if (next === "duplicate")
            return json(400, {
              tipoAmbiente: 1,
              erros: [
                {
                  codigo: "E0014",
                  mensagem: "Já existe NFS-e emitida para esta DPS.",
                  complemento: null,
                },
              ],
            });
          state.exists = true;
          return json(201, { chaveAcesso: KEY, nfseXmlGZipB64: gzipB64(nfseOf(state.sent)) });
        }
        if (target.url.startsWith(`${SEFIN}/dps/`) && target.body === undefined)
          return state.exists
            ? json(200, { tipoAmbiente: 1, chaveAcesso: KEY })
            : json(404, {
                tipoAmbiente: 1,
                erros: [{ Codigo: "E2220", Descricao: "Não encontrada" }],
              });
        if (target.url === `${SEFIN}/nfse/${KEY}` && target.body === undefined)
          return json(200, { nfseXmlGZipB64: gzipB64(nfseOf(state.sent)) });
        return json(404, { erros: [{ Codigo: "E2220", Descricao: "Não encontrado" }] });
      });
    const posts = () =>
      spy.mock.calls.filter(([target]) => target.body !== undefined).map(([target]) => target.url);
    return { spy, state, posts };
  }
  /** Accepted with the gate on, and the first submission lost on the way back. */
  async function timedOut(f: Fixture, key: string, lost: { exists: boolean }) {
    f.onProduction();
    await f.gate(true);
    const fake = scripted(f, ["timeout"]);
    const accepted = await f.request(key);
    fake.state.issuanceId = accepted.issuance.id;
    expect((await f.drive(accepted.issuance.operationId)).state).toBe("reconciling");
    fake.state.exists = lost.exists;
    return { fake, accepted };
  }

  it("timeout e gate desligado: a consulta acha a NFS-e e autoriza, sem reenviar", async () => {
    const f = await fixture();
    const { fake, accepted } = await timedOut(f, "timeout-gate-desligado", { exists: true });
    await f.gate(false);
    expect((await f.drive(accepted.issuance.operationId)).state).toBe("succeeded");
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "authorized",
      accessKey: KEY,
      recoveredByConsult: true,
      submissions: 1,
    });
    expect(fake.posts()).toEqual([`${SEFIN}/nfse`]);
  });

  it("timeout e gate desligado: a consulta não acha e nada é reenviado até religar", async () => {
    const f = await fixture();
    const { fake, accepted } = await timedOut(f, "timeout-404", { exists: false });
    await f.gate(false);
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "ISSUANCE_RESEND_BLOCKED",
    });
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "ISSUANCE_RESEND_BLOCKED",
    });
    expect(fake.posts()).toEqual([`${SEFIN}/nfse`]);
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "processing",
      submissions: 1,
    });
    // With the gate on again, the 404 allows one resend of the same DPS, and it is authorized.
    await f.gate(true);
    expect((await f.drive(accepted.issuance.operationId)).state).toBe("succeeded");
    expect(fake.posts()).toEqual([`${SEFIN}/nfse`, `${SEFIN}/nfse`]);
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "authorized",
      submissions: 2,
    });
  });

  it("timeout e empresa fora da lista: nada sai, nem a consulta", async () => {
    const f = await fixture();
    const { fake, accepted } = await timedOut(f, "timeout-fora-da-lista", { exists: true });
    const calls = fake.spy.mock.calls.length;
    f.onProduction("");
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(fake.spy.mock.calls.length).toBe(calls);
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({ state: "processing" });
  });

  it('"DPS já existe" vai à reconciliação, que acha a nota sem novo envio', async () => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    const fake = scripted(f, ["duplicate"]);
    const accepted = await f.request("dps-ja-existe");
    fake.state.issuanceId = accepted.issuance.id;
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "DPS_ALREADY_EXISTS",
    });
    fake.state.exists = true;
    expect((await f.drive(accepted.issuance.operationId)).state).toBe("succeeded");
    expect(fake.posts()).toEqual([`${SEFIN}/nfse`]);
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "authorized",
      recoveredByConsult: true,
    });
  });

  it("gate ligado em outra organização não libera a empresa, no pedido nem na tentativa", async () => {
    const f = await fixture();
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
    const moveGate = (organizationId: Id<"organizations">) =>
      f.t.run(async (ctx) => {
        const row = (await ctx.db.query("issuanceGates").first())!;
        await ctx.db.patch("issuanceGates", row._id, { organizationId });
      });
    f.onProduction();
    await f.gate(true);
    await moveGate(other);
    expect(await code(f.request("gate-alheio"))).toBe("ISSUANCE_PRODUCTION_DISABLED");
    await moveGate(f.scope.organizationId);
    const fake = authority(f);
    const accepted = await f.request("gate-alheio-na-tentativa");
    await moveGate(other);
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(fake.spy).not.toHaveBeenCalled();
  });

  it("a trava de origem numa emissão já enviada mantém a reconciliação, sem novo envio", async () => {
    const f = await fixture();
    const { fake, accepted } = await timedOut(f, "origem-ja-enviada", { exists: false });
    const posts = fake.posts().length;
    const real = fiscalNfse.resolveEndpoint;
    vi.spyOn(fiscalNfse, "resolveEndpoint").mockImplementation((target) => ({
      ...real(target),
      host: "sefin.nfse.example",
    }));
    const vault = vi.spyOn(certificateRuntime, "withCertificate");
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "ISSUANCE_TARGET_INVALID",
    });
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "processing",
      submissions: 1,
    });
    expect(vault).not.toHaveBeenCalled();
    expect(fake.posts()).toHaveLength(posts);
  });

  /** Closes the list after the vault handed out the A1, before the submission is marked. */
  function closeListInsideTheVault(f: Fixture) {
    const real = certificateRuntime.withCertificate;
    vi.spyOn(certificateRuntime, "withCertificate").mockImplementationOnce(
      async (ctx, claim, use) =>
        real(ctx, claim, async (material) => {
          f.onProduction("");
          return use(material);
        }),
    );
  }

  it("a marca do envio confere a política na mesma transação: lista fechada no meio, nada sai", async () => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    const fake = authority(f);
    const accepted = await f.request("fecha-antes-da-marca");
    closeListInsideTheVault(f);
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "rejected",
      submissions: 0,
    });
    expect(fake.spy).not.toHaveBeenCalled();
  });

  it("a marca do cancelamento confere a política na mesma transação: lista fechada no meio, nada sai", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    const fake = authority(f);
    await f.cancel("cancelar-fecha-antes-da-marca", issuance.id);
    const [cancellation] = (await f.rows()).cancellations;
    closeListInsideTheVault(f);
    expect(await f.drive(cancellation!.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(await f.issuanceRow(issuance.id)).toMatchObject({ state: "authorized" });
    expect(fake.spy).not.toHaveBeenCalled();
  });

  it("emissão marcada como enviada sem a DPS gravada nunca monta nem envia DPS nova", async () => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    const fake = authority(f);
    const accepted = await f.request("enviada-sem-dps");
    // As if the submission had been marked and the persisted DPS were lost.
    await f.t.run((ctx) =>
      ctx.db.patch("issuances", accepted.issuance.id as Id<"issuances">, { submissions: 1 }),
    );
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "DPS_UNAVAILABLE",
    });
    expect(await f.dpsOf(accepted.issuance.id)).toBe("");
    expect(fake.spy).not.toHaveBeenCalled();
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "processing",
      submissions: 1,
    });
  });

  it("a trava de origem recusa outro host de produção antes do cofre", async () => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    const fake = authority(f);
    const accepted = await f.request("outro-host");
    const real = fiscalNfse.resolveEndpoint;
    vi.spyOn(fiscalNfse, "resolveEndpoint").mockImplementation((target) => ({
      ...real(target),
      host: "sefin.nfse.example",
    }));
    const vault = vi.spyOn(certificateRuntime, "withCertificate");
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TARGET_INVALID",
    });
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "rejected",
      submissions: 0,
    });
    expect(vault).not.toHaveBeenCalled();
    expect(fake.spy).not.toHaveBeenCalled();
    expect((await f.rows()).uses).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // Cancellation of a real invoice: the gate is not needed, the list is (ADR 0004 §8, 3rd amendment).

  it("recusa o marcador do simulador no motivo do cancelamento de nota real", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    for (const reason of [
      "Cancelamento sintético [simular:rejeicao]",
      "Motivo [SIMULAR:timeout] de teste",
    ])
      expect(await code(f.cancel(`motivo-${reason.length}`, issuance.id, reason))).toBe(
        "CANCEL_REASON_INVALID",
      );
    expect((await f.rows()).cancellations).toEqual([]);
  });

  it("cancela nota real com o gate desligado, se a empresa continua na lista", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    await f.gate(false);
    const fake = authority(f);
    fake.track(issuance.id);
    await f.cancel("cancelar-gate-desligado", issuance.id);
    const [cancellation] = (await f.rows()).cancellations;
    expect(await f.drive(cancellation!.operationId)).toMatchObject({ state: "succeeded" });
    expect(await f.issuanceRow(issuance.id)).toMatchObject({ state: "cancelled" });
    expect(fake.calls()).toEqual([`POST ${SEFIN}/nfse/${KEY}/eventos`]);
    expect((await f.rows()).uses.slice(-2)).toEqual([
      "nfse-production:authorized",
      "nfse-production:success",
    ]);
  });

  it("recusa cancelar nota real com a empresa fora da lista, antes e durante a operação", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    const fake = authority(f);
    f.onProduction("");
    expect(await code(f.cancel("cancelar-fora-da-lista", issuance.id))).toBe(
      "ISSUANCE_PRODUCTION_DISABLED",
    );
    expect((await f.rows()).cancellations).toEqual([]);
    // Accepted while listed, then the company leaves the list: nothing is sent.
    f.onProduction();
    await f.cancel("cancelar-e-sair-da-lista", issuance.id);
    const [cancellation] = (await f.rows()).cancellations;
    f.onProduction("");
    expect(await f.drive(cancellation!.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(await f.issuanceRow(issuance.id)).toMatchObject({ state: "authorized" });
    expect(fake.spy).not.toHaveBeenCalled();
  });
});
