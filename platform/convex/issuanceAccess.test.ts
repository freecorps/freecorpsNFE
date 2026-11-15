import { describe, expect, it, vi } from "vite-plus/test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { person, usePlatformEnvironment } from "../../tests/helpers/platform";
// Same source module the platform resolves under test (vite.config.ts aliases the
// workspace packages to src), so the XSD catalog is registered once.
import { nacional } from "../../packages/fiscal-nfse/src/index";
import * as fiscalBuild from "../../packages/fiscal-nfse/src/build";
import {
  fixture,
  type Fixture,
  domestic,
  code,
  request,
  cancel,
  drive,
  simulation,
  claimOperation,
} from "../../tests/helpers/issuance";

/**
 * Who may issue: access, isolation between organizations and the environment gates.
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

describe("acesso, isolamento e gates", () => {
  it("isola organizações e empresas, recusa papéis sem escrita e mantém a concessão das API keys", async () => {
    const f = await fixture();
    const accepted = await request(f, "isolada", domestic());
    const other = await fixture(f.t);
    const ask = (client: Fixture["owner"], where: Fixture["where"], key: string) =>
      client.mutation(internal.issuance.request, {
        ...where,
        idempotencyKey: key,
        input: domestic(),
      });
    // Another organization's owner cannot use this company nor read this issuance.
    expect(await code(ask(other.owner, f.where, "x"))).not.toBe("OK");
    expect(
      await code(
        other.owner.query(internal.issuance.get, {
          ...other.where,
          issuanceId: accepted.issuance.id,
        }),
      ),
    ).toBe("NOT_FOUND");
    // With a project selector, the row still proves its own project.
    expect(
      await code(
        f.owner.query(internal.issuance.get, { ...f.keyWhere, issuanceId: accepted.issuance.id }),
      ),
    ).toBe("NOT_FOUND");
    // Another company of the same organization.
    expect(
      await code(
        f.owner.query(internal.issuance.get, {
          ...f.where,
          companyId: other.where.companyId,
          issuanceId: accepted.issuance.id,
        }),
      ),
    ).not.toBe("OK");
    // People need no project grant: company access and a writing role.
    await f.t.run(async (ctx) => {
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.where.companyId),
        )
        .unique())!;
      await ctx.db.patch("projectCompanies", grant._id, { scopes: ["documents:import"] });
    });
    const viewer = await person(f.t, f.where.organizationId, "viewer", {
      companyId: f.where.companyId,
    });
    expect(await code(ask(viewer, f.where, "v"))).toBe("SCOPE_DENIED");
    expect(
      (await viewer.query(internal.issuance.get, { ...f.where, issuanceId: accepted.issuance.id }))
        .id,
    ).toBe(accepted.issuance.id);
    const developer = await person(f.t, f.where.organizationId, "developer", {
      companyId: f.where.companyId,
    });
    expect(await code(ask(developer, f.where, "d"))).toBe("SCOPE_DENIED");
    const operator = await person(f.t, f.where.organizationId, "operator", {
      companyId: f.where.companyId,
    });
    expect(await code(ask(operator, f.where, "o"))).toBe("OK");
    // A member without access to the company is not told it exists.
    const outsider = await person(f.t, f.where.organizationId, "operator");
    expect(await code(ask(outsider, f.where, "fora"))).toBe("NOT_FOUND");
    // A person never reserves under an integration project, even with its grant.
    expect(await code(ask(f.owner, f.keyWhere, "integracao"))).toBe("NOT_FOUND");
    // An API key still needs `documents:issue` in the key and in its project's grant.
    const byKey = (key: string) =>
      f.t.mutation(internal.issuance.request, {
        ...f.keyWhere,
        keyHash: f.keyHash,
        idempotencyKey: key,
        input: domestic(),
      });
    expect(await code(byKey("k-sem-concessao"))).toBe("NOT_FOUND");
    await f.t.run(async (ctx) => {
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.where.companyId),
        )
        .unique())!;
      await ctx.db.patch("projectCompanies", grant._id, {
        scopes: ["documents:import", "documents:issue", "documents:cancel"],
      });
      await ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:cancel"] });
    });
    expect(await code(byKey("k"))).toBe("SCOPE_DENIED");
    await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:issue"] }));
    expect(await code(byKey("k"))).toBe("OK");
    // The key's listing shows its project's issuances only; the console's are not there.
    const byKeyList = await f.t.query(internal.issuance.list, {
      ...f.keyWhere,
      keyHash: f.keyHash,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(byKeyList.page.map((row) => row.id)).not.toContain(accepted.issuance.id);
    // A key never reaches the console project.
    expect(
      await code(
        f.t.query(internal.issuance.get, {
          ...f.where,
          keyHash: f.keyHash,
          issuanceId: accepted.issuance.id,
        }),
      ),
    ).not.toBe("OK");
    // Without a session nothing is accepted.
    expect(
      await code(
        f.t.mutation(internal.issuance.request, {
          ...f.where,
          idempotencyKey: "n",
          input: domestic(),
        }),
      ),
    ).not.toBe("OK");
  });

  it("chave revogada depois da preparação não marca nem envia a DPS", async () => {
    const f = await fixture();
    const accepted = await f.t.mutation(internal.issuance.request, {
      ...f.keyWhere,
      keyHash: f.keyHash,
      idempotencyKey: "revogada",
      input: domestic(),
    });
    const operationId = accepted.issuance.operationId;
    const token = await claimOperation(f.t, operationId);
    expect(await f.t.mutation(internal.issuanceProcessing.prepareIssue, token)).toMatchObject({
      state: "processing",
      allowed: true,
    });
    await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
    expect(await f.t.mutation(internal.issuanceProcessing.markSubmitted, token)).toBe("lost");
    const after = await f.t.run(async (ctx) => ({
      op: (await ctx.db.get("operations", operationId))!,
      issuance: (await ctx.db.get("issuances", accepted.issuance.id as Id<"issuances">))!,
      events: await ctx.db.query("issuanceEvents").collect(),
    }));
    // Nothing left, so nothing is uncertain: a retry is a plain attempt, not a reconciliation.
    expect(after.op).toMatchObject({
      state: "paused",
      code: "ACCESS_REVOKED",
      stage: "ready",
      uncertain: false,
    });
    expect(after.issuance).toMatchObject({ state: "processing", submissions: 0 });
    expect(after.events.map((event) => event.kind)).not.toContain("submitted");
  });

  it("a tentativa do worker com a chave revogada antes do envio não transmite a DPS", async () => {
    const f = await fixture();
    const accepted = await f.t.mutation(internal.issuance.request, {
      ...f.keyWhere,
      keyHash: f.keyHash,
      idempotencyKey: "revogada-no-worker",
      input: domestic(),
    });
    // The key falls inside the attempt, after the preparation and right before the send.
    const original = fiscalBuild.buildDps;
    const revocation: Promise<unknown>[] = [];
    vi.spyOn(fiscalBuild, "buildDps").mockImplementation((...args) => {
      if (revocation.length === 0)
        revocation.push(
          f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() })),
        );
      return original(...args);
    });
    const send = vi.spyOn(nacional, "submitDps");
    try {
      const op = await drive(f.t, accepted.issuance.operationId);
      await Promise.all(revocation);
      expect(fiscalBuild.buildDps).toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(op).toMatchObject({ state: "paused", code: "ACCESS_REVOKED", uncertain: false });
      expect(await simulation(f.t, accepted.issuance.dpsId)).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("membro rebaixado depois da preparação não marca nem envia o cancelamento", async () => {
    const f = await fixture();
    const accepted = await request(f, "base", domestic());
    await drive(f.t, accepted.issuance.operationId);
    const requested = await cancel(f, "cancelar", accepted.issuance.id, "Serviço em duplicidade");
    const operationId = requested.issuance.cancellation!.operationId;
    const token = await claimOperation(f.t, operationId);
    expect(await f.t.mutation(internal.issuanceProcessing.prepareCancel, token)).toMatchObject({
      state: "processing",
      allowed: true,
    });
    await f.t.run(async (ctx) => {
      const op = (await ctx.db.get("operations", operationId))!;
      await ctx.db.patch("memberships", op.sourceMembershipId!, { role: "viewer" });
    });
    expect(await f.t.mutation(internal.issuanceProcessing.markCancelSubmitted, token)).toBe("lost");
    const after = await f.t.run(async (ctx) => ({
      op: (await ctx.db.get("operations", operationId))!,
      cancellation: (await ctx.db.query("issuanceCancellations").unique())!,
      issuance: (await ctx.db.get("issuances", accepted.issuance.id as Id<"issuances">))!,
      events: await ctx.db.query("issuanceEvents").collect(),
    }));
    expect(after.op).toMatchObject({
      state: "paused",
      code: "ACCESS_REVOKED",
      stage: "ready",
      uncertain: false,
    });
    expect(after.cancellation).toMatchObject({ state: "processing", submissions: 0 });
    expect(after.events.map((event) => event.kind)).not.toContain("cancel_submitted");
    expect(after.issuance.state).toBe("authorized");
  });

  it("o gate de produção só é avaliado depois do acesso e não vaza o seu estado", async () => {
    const f = await fixture();
    const other = await fixture(f.t);
    const viewer = await person(f.t, f.where.organizationId, "viewer", {
      companyId: f.where.companyId,
    });
    const production = { ...f.where, environment: "production" as const };
    const ask = (client: Fixture["owner"], key: string) =>
      client.mutation(internal.issuance.request, {
        ...production,
        idempotencyKey: key,
        input: domestic(),
      });
    const askCancel = (client: Fixture["owner"], key: string) =>
      client.mutation(internal.issuance.cancel, {
        ...production,
        idempotencyKey: key,
        issuanceId: "inexistente",
        reasonCode: "1",
        reason: "Cancelamento sintético do gate de produção",
      });
    const answers = async (round: string) => ({
      owner: [await code(ask(f.owner, round)), await code(askCancel(f.owner, round))],
      viewer: [await code(ask(viewer, round)), await code(askCancel(viewer, round))],
      otherOrganization: [
        await code(ask(other.owner, round)),
        await code(askCancel(other.owner, round)),
      ],
    });
    const closed = await answers("fechado");
    // The sandbox deployment never changes the gate, from the workflow or otherwise.
    expect(
      await code(
        f.t.mutation(internal.issuance.setProductionGate, {
          organizationId: f.where.organizationId,
          companyId: f.where.companyId,
          kind: "enable",
          operator: "operador-freecorps",
          approver: "aprovador-freecorps",
          runId: "123",
          runAttempt: 1,
          reason: "Prova sintética do gate de produção",
        }),
      ),
    ).toBe("ISSUANCE_GATE_DEPLOYMENT_DENIED");
    // A gate row left open (e.g. by a restore) changes nothing here.
    await f.t.run((ctx) =>
      ctx.db.insert("issuanceGates", {
        organizationId: f.where.organizationId,
        companyId: f.where.companyId,
        production: true,
        actor: "operador-freecorps",
        reason: "Linha sintética de gate aberto",
        version: 1,
        updatedAt: Date.now(),
      }),
    );
    const open = await answers("aberto");
    // Every deployment is sandbox: access refuses `production` before the gate, open or closed.
    expect(closed).toEqual({
      owner: ["NOT_FOUND", "NOT_FOUND"],
      viewer: ["NOT_FOUND", "NOT_FOUND"],
      otherOrganization: ["ACCESS_DENIED", "ACCESS_DENIED"],
    });
    expect(open).toEqual(closed);
    const state = await f.t.run(async (ctx) => ({
      events: await ctx.db.query("issuanceGateEvents").collect(),
      audit: (await ctx.db.query("operationalAudit").collect()).map((a) => a.action),
    }));
    expect(state.events).toEqual([]);
    expect(state.audit).not.toContain("issuance.production_enabled");
    expect(await code(request(f, "sandbox-segue", domestic()))).toBe("OK");
  });
});
