import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "./_generated/api";
import { person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { VER_APLIC } from "./lib/issuanceValues";
// Same source module the platform resolves under test (vite.config.ts aliases the
// workspace packages to src), so the XSD catalog is registered once.
import {
  MAX_XML_BYTES,
  nacional,
  validatePedRegEventoXml,
} from "../../packages/fiscal-nfse/src/index";
import * as fiscalBuild from "../../packages/fiscal-nfse/src/build";
import * as fiscalEvents from "../../packages/fiscal-nfse/src/events";
import {
  fixture,
  type Fixture,
  domestic,
  code,
  request,
  cancel,
  view,
  drive,
  xmlOf,
  simulation,
} from "../../tests/helpers/issuance";

/**
 * Issuance outcomes: idempotency and numbering, the XML limit, uncertain outcomes and cancellation.
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

describe("idempotência e numeração", () => {
  it("a mesma chave devolve o mesmo efeito, antes e depois da autorização", async () => {
    const f = await fixture();
    const first = await request(f, "same", domestic());
    const again = await request(
      f,
      "same",
      domestic({ description: "  Licença de uso de software,  outubro de 2026 " }),
    );
    expect(again).toMatchObject({ reused: true, issuance: { id: first.issuance.id, number: 1 } });
    await drive(f.t, first.issuance.operationId);
    // A later profile change does not reopen an accepted request.
    await f.t.run(async (ctx) => {
      const profile = (await ctx.db.query("nfseProfiles").first())!;
      await ctx.db.patch("nfseProfiles", profile._id, { activities: [] });
    });
    expect(await request(f, "same", domestic())).toMatchObject({
      reused: true,
      issuance: { id: first.issuance.id, state: "authorized" },
    });
    expect(
      await code(request(f, "same", domestic({ amount: { currency: "BRL", value: "999" } }))),
    ).toBe("IDEMPOTENCY_CONFLICT");
    const counts = await f.t.run(async (ctx) => ({
      issuances: (await ctx.db.query("issuances").collect()).length,
      sequence: (await ctx.db.query("dpsSequences").first())?.last,
    }));
    expect(counts).toEqual({ issuances: 1, sequence: 1 });
  });

  it("pedidos concorrentes recebem números distintos e sequenciais", async () => {
    const f = await fixture();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => request(f, `concorrente-${i}`, domestic())),
    );
    const numbers = results.map((r) => r.issuance.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(results.map((r) => r.issuance.dpsId)).size).toBe(6);
    expect((await f.t.run((ctx) => ctx.db.query("dpsSequences").first()))?.last).toBe(6);
  });

  it("rejeição definitiva consome o número sem reutilizá-lo", async () => {
    const f = await fixture();
    const rejected = await request(
      f,
      "rejeitar",
      domestic({ description: "Teste [simular:rejeicao]" }),
    );
    const op = await drive(f.t, rejected.issuance.operationId);
    expect(op).toMatchObject({ state: "failed", code: "ADN_REJECTED" });
    const done = await view(f, rejected.issuance.id);
    expect(done).toMatchObject({ state: "rejected", code: "ADN_REJECTED", number: 1 });
    expect(done.rejections[0]).toMatchObject({ code: "SIM100" });
    expect(done.accessKey).toBeNull();
    const next = await request(f, "depois", domestic());
    expect(next.issuance.number).toBe(2);
    expect(await code(cancel(f, "c", rejected.issuance.id, "Cancelamento de nota rejeitada"))).toBe(
      "ISSUANCE_NOT_CANCELLABLE",
    );
  });
});

describe("limite de XML da emissão", () => {
  afterEach(() => vi.restoreAllMocks());
  // Multibyte text proves that the limit measures UTF-8 bytes, not string length.
  const oversized = () => "é".repeat(MAX_XML_BYTES / 2 + 1);

  it("rejeita DPS local acima do teto sem envio nem nova tentativa", async () => {
    const f = await fixture();
    const build = fiscalBuild.buildDps;
    vi.spyOn(fiscalBuild, "buildDps").mockImplementation((input) => ({
      ...build(input),
      xml: oversized(),
    }));
    const accepted = await request(f, "dps-grande", domestic());
    const operationId = accepted.issuance.operationId;
    expect(await drive(f.t, operationId, 2)).toMatchObject({
      state: "failed",
      code: "NFSE_XML_LIMIT",
      uncertain: false,
    });
    expect(await view(f, accepted.issuance.id)).toMatchObject({
      state: "rejected",
      code: "NFSE_XML_LIMIT",
      artifacts: [],
    });
    expect(await simulation(f.t, accepted.issuance.dpsId)).toBeNull();
    expect(await f.t.run((ctx) => ctx.db.query("operationAttempts").collect())).toHaveLength(1);
  });

  it("rejeita pedido local de cancelamento acima do teto e preserva a nota", async () => {
    const f = await fixture();
    const accepted = await request(f, "nota", domestic());
    await drive(f.t, accepted.issuance.operationId);
    const build = fiscalEvents.buildCancelEvent;
    vi.spyOn(fiscalEvents, "buildCancelEvent").mockImplementation((input) => ({
      ...build(input),
      xml: oversized(),
    }));
    const submit = vi.spyOn(nacional, "submitCancelEvent");
    const requested = await cancel(
      f,
      "cancelar",
      accepted.issuance.id,
      "Erro na emissão sintética",
    );
    expect(await drive(f.t, requested.issuance.cancellation!.operationId, 2)).toMatchObject({
      state: "failed",
      code: "NFSE_XML_LIMIT",
      uncertain: false,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(await view(f, accepted.issuance.id)).toMatchObject({
      state: "authorized",
      cancellation: { state: "rejected", code: "NFSE_XML_LIMIT" },
    });
    expect(await xmlOf(f.t, accepted.issuance.id, "cancel-request")).toEqual([]);
  });

  it("resposta autorizada acima do teto fica incerta e é recuperada sem reenviar DPS", async () => {
    const f = await fixture();
    const submit = nacional.submitDps.bind(nacional);
    const sent = vi.spyOn(nacional, "submitDps").mockImplementationOnce(async (...args) => {
      const result = await submit(...args);
      return result.kind === "success" ? { ...result, nfseXml: oversized() } : result;
    });
    const accepted = await request(f, "resposta-grande", domestic());
    expect(await drive(f.t, accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "NFSE_XML_LIMIT",
      uncertain: true,
    });
    expect((await view(f, accepted.issuance.id)).state).toBe("processing");
    expect(await xmlOf(f.t, accepted.issuance.id, "dps")).toHaveLength(1);
    expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("succeeded");
    expect(sent).toHaveBeenCalledTimes(1);
    expect(await view(f, accepted.issuance.id)).toMatchObject({ state: "authorized" });
  });

  it("evento recebido acima do teto reconcilia o cancelamento com o pedido preservado", async () => {
    const f = await fixture();
    const accepted = await request(f, "nota", domestic());
    await drive(f.t, accepted.issuance.operationId);
    const submit = nacional.submitCancelEvent.bind(nacional);
    vi.spyOn(nacional, "submitCancelEvent").mockImplementationOnce(async (...args) => {
      const result = await submit(...args);
      return result.kind === "success" ? { ...result, eventXml: oversized() } : result;
    });
    const requested = await cancel(
      f,
      "cancelar",
      accepted.issuance.id,
      "Erro na emissão sintética",
    );
    const operationId = requested.issuance.cancellation!.operationId;
    expect(await drive(f.t, operationId)).toMatchObject({
      state: "reconciling",
      code: "NFSE_XML_LIMIT",
      uncertain: true,
    });
    const before = await xmlOf(f.t, accepted.issuance.id, "cancel-request");
    expect(before).toHaveLength(1);
    expect((await drive(f.t, operationId)).state).toBe("succeeded");
    expect(await xmlOf(f.t, accepted.issuance.id, "cancel-request")).toEqual(before);
    expect(await view(f, accepted.issuance.id)).toMatchObject({ state: "cancelled" });
  });
});

describe("desfechos incertos e reconciliação", () => {
  it("indisponibilidade transitória volta a tentar, consultando antes de reenviar", async () => {
    const f = await fixture();
    const accepted = await request(
      f,
      "503",
      domestic({ description: "Teste [simular:indisponivel]" }),
    );
    const first = await drive(f.t, accepted.issuance.operationId);
    expect(first).toMatchObject({ state: "retry_wait", code: "ADN_UNAVAILABLE", uncertain: false });
    const done = await drive(f.t, accepted.issuance.operationId);
    expect(done.state).toBe("succeeded");
    expect((await view(f, accepted.issuance.id)).state).toBe("authorized");
    expect((await simulation(f.t, accepted.issuance.dpsId))?.posts).toBe(2);
  });

  it("timeout com nota autorizada: a reconciliação encontra a NFS-e sem reenviar", async () => {
    const f = await fixture();
    const accepted = await request(
      f,
      "timeout",
      domestic({ description: "Teste [simular:timeout]" }),
    );
    const lost = await drive(f.t, accepted.issuance.operationId);
    expect(lost).toMatchObject({
      state: "reconciling",
      uncertain: true,
      code: "TRANSPORT_UNCERTAIN",
    });
    expect((await view(f, accepted.issuance.id)).state).toBe("processing");
    const done = await drive(f.t, accepted.issuance.operationId);
    expect(done.state).toBe("succeeded");
    const recovered = await f.t.run((ctx) => ctx.db.get("issuances", accepted.issuance.id));
    expect(recovered).toMatchObject({
      state: "authorized",
      recoveredByConsult: true,
      submissions: 1,
    });
    expect((await simulation(f.t, accepted.issuance.dpsId))?.posts).toBe(1);
    const attempts = await f.t.run((ctx) =>
      ctx.db
        .query("operationAttempts")
        .withIndex("by_operationId_and_generation_and_fence", (q) =>
          q.eq("operationId", accepted.issuance.operationId),
        )
        .collect(),
    );
    expect(attempts.map((a) => a.mode)).toEqual(["execute", "reconcile"]);
  });

  it("timeout sem nota: a consulta confirma ausência e reenvia o mesmo XML e nDPS", async () => {
    const f = await fixture();
    const accepted = await request(f, "perda", domestic({ description: "Teste [simular:perda]" }));
    expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("reconciling");
    const before = await xmlOf(f.t, accepted.issuance.id, "dps");
    expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("succeeded");
    const done = await view(f, accepted.issuance.id);
    expect(done).toMatchObject({ state: "authorized", number: 1 });
    expect(await xmlOf(f.t, accepted.issuance.id, "dps")).toEqual(before);
    expect((await simulation(f.t, accepted.issuance.dpsId))?.posts).toBe(2);
    expect((await f.t.run((ctx) => ctx.db.get("issuances", done.id)))?.submissions).toBe(2);
  });

  it("retomada manual de emissão incerta com tentativas esgotadas reconcilia sem reenviar (#197)", async () => {
    const f = await fixture();
    const accepted = await request(
      f,
      "presa",
      domestic({ description: "Teste [simular:timeout]" }),
    );
    const operationId = accepted.issuance.operationId;
    expect((await drive(f.t, operationId)).state).toBe("reconciling");
    // The state observed on #197: every attempt spent, paused while uncertain.
    await f.t.run((ctx) =>
      ctx.db.patch("operations", operationId, {
        state: "paused",
        stage: "calling",
        code: "RECONCILIATION_REQUIRED",
        generation: 9,
        attempts: 6,
        maxAttempts: 6,
        recoveryAttempts: 5,
        uncertain: true,
        leaseUntil: 0,
        recoveryAt: undefined,
        workId: undefined,
      }),
    );
    const retry = (actor: typeof f.owner) =>
      actor.mutation(api.operations.control, {
        operationId,
        action: "retry",
        expectedGeneration: 9,
      });
    const viewer = await person(f.t, f.scope.organizationId, "viewer", {
      companyId: f.scope.companyId,
    });
    expect(await code(retry(viewer))).toBe("SCOPE_DENIED");
    const other = await fixture(f.t);
    expect(await code(retry(other.owner))).toBe("ACCESS_DENIED");
    expect((await f.t.run((ctx) => ctx.db.get("operations", operationId)))?.state).toBe("paused");
    await retry(f.owner);
    expect(await f.t.run((ctx) => ctx.db.get("operations", operationId))).toMatchObject({
      state: "reconciling",
      code: "MANUAL_RECONCILE",
      attempts: 6,
      maxAttempts: 7,
    });
    const done = await drive(f.t, operationId);
    expect(done).toMatchObject({ state: "succeeded", attempts: 7 });
    expect(await f.t.run((ctx) => ctx.db.get("issuances", accepted.issuance.id))).toMatchObject({
      state: "authorized",
      recoveredByConsult: true,
      submissions: 1,
    });
    expect((await simulation(f.t, accepted.issuance.dpsId))?.posts).toBe(1);
    const attempts = await f.t.run((ctx) =>
      ctx.db
        .query("operationAttempts")
        .withIndex("by_operationId_and_generation_and_fence", (q) =>
          q.eq("operationId", operationId),
        )
        .collect(),
    );
    expect(attempts.map((a) => a.mode)).toEqual(["execute", "reconcile"]);
  });

  it("DPS duplicada no reenvio é incerta e se resolve pela consulta, nunca por rejeição", async () => {
    const f = await fixture();
    const accepted = await request(
      f,
      "dup",
      domestic({ description: "Teste [simular:duplicada]" }),
    );
    expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("reconciling");
    const second = await drive(f.t, accepted.issuance.operationId);
    expect(second).toMatchObject({ state: "reconciling", code: "DPS_ALREADY_EXISTS" });
    const done = await drive(f.t, accepted.issuance.operationId);
    expect(done.state).toBe("succeeded");
    expect((await view(f, accepted.issuance.id)).state).toBe("authorized");
    expect((await simulation(f.t, accepted.issuance.dpsId))?.posts).toBe(2);
  });
});

describe("cancelamento", () => {
  async function authorized(f: Fixture, key = "base") {
    const accepted = await request(f, key, domestic());
    await drive(f.t, accepted.issuance.operationId);
    return accepted.issuance.id;
  }

  it("cancela, preserva pedido e evento, e um pedido repetido não cria outro efeito", async () => {
    const f = await fixture();
    const id = await authorized(f);
    const reason = "Serviço faturado em duplicidade";
    const requested = await cancel(f, "cancelar", id, reason);
    expect(requested).toMatchObject({
      reused: false,
      issuance: { state: "authorized", cancellation: { state: "processing", sequence: 1 } },
    });
    const op = await drive(f.t, requested.issuance.cancellation!.operationId);
    expect(op.state).toBe("succeeded");
    const done = await view(f, id);
    expect(done).toMatchObject({
      state: "cancelled",
      cancellation: { state: "registered", alreadyRegistered: false },
    });
    const [event] = await xmlOf(f.t, id, "cancel-request");
    expect(event).toContain(`Id="PRE${done.accessKey}101101"`);
    // The official XSD has no nPedRegEvento; the sequence stays internal.
    expect(event).not.toContain("nPedRegEvento");
    expect(event).toContain(`<verAplic>${VER_APLIC}</verAplic>`);
    expect(validatePedRegEventoXml(event!)).toEqual({ valid: true });
    expect(await xmlOf(f.t, id, "cancel-event")).toHaveLength(1);
    expect(await cancel(f, "cancelar", id, reason)).toMatchObject({ reused: true });
    expect(await cancel(f, "outra-chave", id, "Outro motivo qualquer de teste")).toMatchObject({
      reused: true,
      issuance: { state: "cancelled" },
    });
    expect((await f.t.run((ctx) => ctx.db.query("issuanceCancellations").collect())).length).toBe(
      1,
    );
  });

  it("cancelamento rejeitado mantém a nota autorizada e o próximo usa o pedido seguinte", async () => {
    const f = await fixture();
    const id = await authorized(f);
    const rejected = await cancel(f, "c1", id, "Pedido sintético [simular:rejeicao]");
    const op = await drive(f.t, rejected.issuance.cancellation!.operationId);
    expect(op).toMatchObject({ state: "failed", code: "ADN_REJECTED" });
    const after = await view(f, id);
    expect(after).toMatchObject({
      state: "authorized",
      cancellation: { state: "rejected", code: "ADN_REJECTED" },
    });
    expect(after.cancellation?.rejections[0]?.code).toBe("SIM200");
    const retry = await cancel(f, "c2", id, "Erro na emissão da nota sintética");
    expect(retry.issuance.cancellation?.sequence).toBe(2);
    await drive(f.t, retry.issuance.cancellation!.operationId);
    expect((await view(f, id)).state).toBe("cancelled");
  });

  it("timeout no cancelamento reenvia o mesmo pedido e aceita 'evento já registrado'", async () => {
    const f = await fixture();
    const id = await authorized(f);
    const requested = await cancel(f, "c", id, "Pedido sintético [simular:timeout]");
    const operationId = requested.issuance.cancellation!.operationId;
    expect((await drive(f.t, operationId)).state).toBe("reconciling");
    expect((await drive(f.t, operationId)).state).toBe("succeeded");
    expect(await view(f, id)).toMatchObject({
      state: "cancelled",
      cancellation: { alreadyRegistered: true },
    });
    expect(await xmlOf(f.t, id, "cancel-request")).toHaveLength(1);
  });
});
