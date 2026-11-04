/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../platform/convex/_generated/api";
import * as captureReleaseModule from "../platform/convex/captureRelease";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import { environmentServed } from "../platform/convex/lib/environmentAccess";
import {
  CAPTURE_TERMS_ARCHIVE,
  CAPTURE_TERMS_REACCEPT_DAYS,
  CAPTURE_TERMS_SHA256,
  CAPTURE_TERMS_VERSION,
  captureTermsExpired,
  termsStanding,
} from "../platform/convex/lib/fiscalCaptureRelease";
import { fiscalCaptureOf } from "../platform/convex/lib/captureCore";
import {
  person,
  platformTest,
  syntheticApiKey,
  usePlatformEnvironment,
  type Role,
} from "./helpers/platform";

/**
 * ADR 0007, amendment of 22/10/2026: the company's owner or admin releases the fiscal capture in
 * the console; Freecorps withdraws it in an emergency, blocking a new release, and unblocks it.
 */
usePlatformEnvironment({
  siteUrl: "http://localhost:5208",
  convexSiteUrl: "http://127.0.0.1:3268",
  secret: "synthetic-release-secret",
});
beforeEach(() => vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled"));

const CNPJ = "11222333000181";
const operator = {
  operator: "ana-freecorps",
  reason: "Suspensão sintética",
  runId: "4242",
  runAttempt: 1,
};

async function scope(
  options: {
    certificate?: "active" | "foreign" | "none";
    role?: Role;
    t?: ReturnType<typeof platformTest>;
  } = {},
) {
  const t = options.t ?? platformTest();
  const prepared = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(syntheticApiKey()),
    suffix: crypto.randomUUID(),
  });
  await t.run(async (ctx) => {
    await ctx.db.patch("companies", prepared.companyId, { cnpj: CNPJ, kind: "declared" });
    if ((options.certificate ?? "active") === "none") return;
    const membership = (await ctx.db
      .query("memberships")
      .filter((q) => q.eq(q.field("organizationId"), prepared.organizationId))
      .first())!;
    const certificateId = await ctx.db.insert("certificates", {
      organizationId: prepared.organizationId,
      companyId: prepared.companyId,
      version: 1,
      state: "active",
      uploaderId: "sintetico",
      membershipId: membership._id,
      membershipVersion: membership.version,
      metadata: {
        fingerprint: "c".repeat(64),
        subject: "CN=Empresa sintética",
        cnpj: options.certificate === "foreign" ? "99888777000166" : CNPJ,
        notBefore: Date.now() - 86_400_000,
        notAfter: Date.now() + 365 * 86_400_000,
      },
      envelopeRevision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("certificateHeads", {
      organizationId: prepared.organizationId,
      companyId: prepared.companyId,
      nextVersion: 2,
      latestId: certificateId,
      activeId: certificateId,
    });
  });
  const member = await person(t, prepared.organizationId, options.role ?? "owner", {
    companyId: prepared.companyId,
  });
  const ids = { organizationId: prepared.organizationId, companyId: prepared.companyId };
  const enable = (args: { minIntervalHours?: number; terms?: string } = {}) =>
    member.mutation(api.captureRelease.enable, {
      ...ids,
      minIntervalHours: 2,
      terms: CAPTURE_TERMS_VERSION,
      ...args,
    });
  const disable = () => member.mutation(api.captureRelease.disable, ids);
  const status = () => member.query(api.captureRelease.status, ids);
  const freecorps = (kind: "emergency_withdraw" | "unblock") =>
    t.mutation(internal.captureRelease.set, { ...ids, kind, ...operator });
  const served = (purpose: "documents:read" | "connections:write") =>
    t.run(async (ctx) =>
      environmentServed(
        ctx,
        (await ctx.db.get("companies", prepared.companyId))!,
        "production",
        purpose,
      ),
    );
  /** An active production stream of the company, as `captures.activate` leaves it. */
  const productionStream = () =>
    t.run((ctx) =>
      ctx.db.insert("captureStreams", {
        organizationId: prepared.organizationId,
        projectId: prepared.projectId,
        companyId: prepared.companyId,
        environment: "production",
        identity: CNPJ,
        service: "nfe-distribution",
        state: "active",
        version: 1,
        checkpoint: "0",
        mode: "distNSU",
        nextAllowedAt: Date.now() + 3_600_000,
        received: 0,
        createdAt: Date.now(),
      }),
    );
  const stream = (id: Awaited<ReturnType<typeof productionStream>>) =>
    t.run(async (ctx) => (await ctx.db.get("captureStreams", id))!);
  return {
    t,
    ...prepared,
    member,
    enable,
    disable,
    status,
    freecorps,
    served,
    productionStream,
    stream,
  };
}

describe("captura fiscal pelo console", () => {
  it("o gestor ativa e desativa; desativada, sobra só a leitura", async () => {
    const s = await scope();
    expect(await s.status()).toMatchObject({
      available: true,
      state: "none",
      canManage: true,
      requirements: { declared: true, certificate: true },
      terms: CAPTURE_TERMS_VERSION,
      acceptedTerms: null,
    });
    expect(await s.served("documents:read")).toBe(false);
    expect(await s.enable()).toEqual({ version: 1, revokedKeys: 0 });
    expect(await s.status()).toMatchObject({
      state: "released",
      minIntervalHours: 2,
      acceptedTerms: {
        version: CAPTURE_TERMS_VERSION,
        acceptedAt: expect.any(Number),
        acceptedBy: "Pessoa sintética",
      },
    });
    expect(await s.served("connections:write")).toBe(true);
    expect(await s.disable()).toEqual({ version: 2 });
    expect(await s.served("connections:write")).toBe(false);
    expect(await s.served("documents:read")).toBe(true);
    const events = await s.t.run((ctx) => ctx.db.query("captureReleaseEvents").collect());
    expect(events.map((e) => [e.kind, e.released, e.terms ?? null, e.termsSha256 ?? null])).toEqual(
      [
        ["console_release", true, CAPTURE_TERMS_VERSION, CAPTURE_TERMS_SHA256],
        ["console_withdraw", false, null, null],
      ],
    );
    expect((await s.status()).acceptedTerms).toBeNull();
    expect(events.every((e) => e.membershipId === s.member.membershipId)).toBe(true);
    const audit = await s.t.run((ctx) => ctx.db.query("operationalAudit").collect());
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["capture.fiscal_released", "capture.fiscal_withdrawn"]),
    );
  });
  it("a versão aceita segue a liberação: o intervalo a mantém, o corte e a retirada a tiram", async () => {
    const s = await scope();
    await s.enable();
    const accepted = (await s.status()).acceptedTerms;
    const event = await s.t.run((ctx) =>
      ctx.db
        .query("captureReleaseEvents")
        .withIndex("by_companyId_and_version", (q) =>
          q.eq("companyId", s.companyId).eq("version", 1),
        )
        .unique(),
    );
    expect(accepted).toEqual({
      version: CAPTURE_TERMS_VERSION,
      acceptedAt: event!.createdAt,
      acceptedBy: "Pessoa sintética",
    });
    await s.member.mutation(api.captureRelease.updateInterval, {
      organizationId: s.organizationId,
      companyId: s.companyId,
      minIntervalHours: 6,
    });
    expect((await s.status()).acceptedTerms).toEqual(accepted);
    // A release from before #428 recorded the version only: it still names the text.
    await s.t.run(async (ctx) => {
      const event = await ctx.db
        .query("captureReleaseEvents")
        .withIndex("by_companyId_and_version", (q) =>
          q.eq("companyId", s.companyId).eq("version", 1),
        )
        .unique();
      await ctx.db.patch("captureReleaseEvents", event!._id, { termsSha256: undefined });
    });
    expect((await s.status()).acceptedTerms).toEqual(accepted);
    // The deployment's cut reads as withdrawn: no terms hold.
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "");
    expect(await s.status()).toMatchObject({ state: "withdrawn", acceptedTerms: null });
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
    await s.freecorps("emergency_withdraw");
    expect(await s.status()).toMatchObject({ blocked: true, acceptedTerms: null });
  });
  it.each(["developer", "operator", "viewer"] as const)(
    "%s vê a versão e o horário do aceite, sem o nome de quem aceitou",
    async (role) => {
      const s = await scope();
      await s.enable();
      const other = await person(s.t, s.organizationId, role, { companyId: s.companyId });
      const seen = await other.query(api.captureRelease.status, {
        organizationId: s.organizationId,
        companyId: s.companyId,
      });
      expect(seen.acceptedTerms).toEqual({
        version: CAPTURE_TERMS_VERSION,
        acceptedAt: expect.any(Number),
        acceptedBy: null,
      });
    },
  );
  it("o admin vê o nome de quem aceitou, também depois que a pessoa saiu", async () => {
    const s = await scope();
    await s.enable();
    await s.t.run((ctx) =>
      ctx.db.patch("memberships", s.member.membershipId, { state: "removed", name: "Ex-gestora" }),
    );
    const admin = await person(s.t, s.organizationId, "admin", { companyId: s.companyId });
    const seen = await admin.query(api.captureRelease.status, {
      organizationId: s.organizationId,
      companyId: s.companyId,
    });
    expect(seen.acceptedTerms?.acceptedBy).toBe("Ex-gestora");
  });
  it("revoga as chaves de produção que alcançam a empresa, e só elas", async () => {
    const s = await scope();
    await s.t.run(async (ctx) => {
      const key = (await ctx.db.get("apiKeys", s.keyId))!;
      await ctx.db.patch("apiKeys", key._id, { environment: "production" });
      const { _id, _creationTime, ...copy } = key;
      await ctx.db.insert("apiKeys", { ...copy, keyHash: "sandbox-key" });
    });
    expect((await s.enable()).revokedKeys).toBe(1);
    const keys = await s.t.run((ctx) => ctx.db.query("apiKeys").collect());
    expect(keys.map((k) => [k.environment, k.revokedAt !== null])).toEqual(
      expect.arrayContaining([
        ["production", true],
        ["sandbox", false],
      ]),
    );
  });
  it.each([
    [{ terms: "outra-versao" }, "CAPTURE_RELEASE_TERMS_REQUIRED"],
    [{ minIntervalHours: 0 }, "CAPTURE_RELEASE_INTERVAL_INVALID"],
    [{ minIntervalHours: 25 }, "CAPTURE_RELEASE_INTERVAL_INVALID"],
    [{ minIntervalHours: 1.5 }, "CAPTURE_RELEASE_INTERVAL_INVALID"],
  ])("recusa ativar com %o", async (override, code) => {
    const s = await scope();
    await expect(s.enable(override)).rejects.toThrow(code);
    expect(await s.served("connections:write")).toBe(false);
  });
  it.each(["none", "foreign"] as const)(
    "recusa sem o A1 da própria empresa (%s)",
    async (certificate) => {
      const s = await scope({ certificate });
      expect((await s.status()).requirements.certificate).toBe(false);
      await expect(s.enable()).rejects.toThrow("CAPTURE_RELEASE_CERTIFICATE_REQUIRED");
    },
  );
  it.each(["operator", "viewer"] as const)(
    "%s vê a situação mas não ativa nem desativa",
    async (role) => {
      const s = await scope({ role });
      expect((await s.status()).canManage).toBe(false);
      await expect(s.enable()).rejects.toThrow("SCOPE_DENIED");
      await expect(s.disable()).rejects.toThrow("SCOPE_DENIED");
    },
  );
  it("sem a chave do deployment, ou em demonstração, a captura fiscal não existe", async () => {
    const s = await scope();
    vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
    expect((await s.status()).available).toBe(false);
    await expect(s.enable()).rejects.toThrow("CAPTURE_RELEASE_UNAVAILABLE");
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
    await s.t.run((ctx) => ctx.db.patch("companies", s.companyId, { kind: "demonstration" }));
    await expect(s.enable()).rejects.toThrow("CAPTURE_RELEASE_DEMONSTRATION_DENIED");
  });
  it("recusa ativar em organização em encerramento", async () => {
    const s = await scope();
    await s.t.run((ctx) =>
      ctx.db.insert("organizationClosures", {
        organizationId: s.organizationId,
        state: "closing",
        requestedAt: Date.now(),
        exportUntil: Date.now() + 30 * 86_400_000,
        purgeBy: Date.now() + 37 * 86_400_000,
        generation: 1,
      }),
    );
    await expect(s.enable()).rejects.toThrow();
  });
});

describe("intervalo mínimo sem desativar (#432)", () => {
  const change = (s: Awaited<ReturnType<typeof scope>>, minIntervalHours: number) =>
    s.member.mutation(api.captureRelease.updateInterval, {
      organizationId: s.organizationId,
      companyId: s.companyId,
      minIntervalHours,
    });
  const events = (s: Awaited<ReturnType<typeof scope>>) =>
    s.t.run((ctx) => ctx.db.query("captureReleaseEvents").collect());

  it("o gestor muda o intervalo; a liberação continua, com a mesma versão, e o histórico guarda quem", async () => {
    const s = await scope();
    await s.enable({ minIntervalHours: 2 });
    expect(await change(s, 6)).toEqual({ minIntervalHours: 6, changed: true, nextAllowedAt: null });
    expect(await s.status()).toMatchObject({ state: "released", minIntervalHours: 6 });
    expect(await s.served("connections:write")).toBe(true);
    const release = await s.t.run((ctx) => ctx.db.query("captureReleases").unique());
    // The queued queries pin this version: an interval change keeps it.
    expect(release).toMatchObject({ version: 1, minIntervalHours: 6, released: true });
    expect((await events(s)).map((e) => [e.version, e.kind, e.minIntervalHours])).toEqual([
      [1, "console_release", 2],
      [2, "console_interval", 6],
    ]);
    expect((await events(s))[1]!.membershipId).toBe(s.member.membershipId);
    const audit = await s.t.run((ctx) => ctx.db.query("operationalAudit").collect());
    expect(audit.map((a) => a.action)).toContain("capture.fiscal_interval_changed");
    // The same value again records nothing.
    expect(await change(s, 6)).toEqual({
      minIntervalHours: 6,
      changed: false,
      nextAllowedAt: null,
    });
    expect(await events(s)).toHaveLength(2);
    // Withdrawing after it takes the next version, above the interval's event.
    expect(await s.disable()).toEqual({ version: 3 });
  });
  it("um stream fora do fim da fila conhecido não muda de horário", async () => {
    const s = await scope();
    await s.enable({ minIntervalHours: 1 });
    const id = await s.productionStream();
    const before = await s.stream(id);
    expect((await change(s, 24)).nextAllowedAt).toBeNull();
    expect(await s.stream(id)).toEqual(before);
  });
  it.each([0, 25, 1.5])("recusa o intervalo %s", async (hours) => {
    const s = await scope();
    await s.enable();
    await expect(change(s, hours)).rejects.toThrow("CAPTURE_RELEASE_INTERVAL_INVALID");
    expect((await s.status()).minIntervalHours).toBe(2);
  });
  it.each(["operator", "viewer"] as const)("%s não muda o intervalo", async (role) => {
    const s = await scope({ role });
    await expect(change(s, 4)).rejects.toThrow("SCOPE_DENIED");
  });
  it("outra organização não muda o intervalo da empresa", async () => {
    const a = await scope();
    await a.enable();
    const b = await scope({ t: a.t });
    // B's manager, with A's organization and company: not a member there.
    await expect(
      b.member.mutation(api.captureRelease.updateInterval, {
        organizationId: a.organizationId,
        companyId: a.companyId,
        minIntervalHours: 12,
      }),
    ).rejects.toThrow();
    // B's own organization with A's company: the company is not B's.
    await expect(
      b.member.mutation(api.captureRelease.updateInterval, {
        organizationId: b.organizationId,
        companyId: a.companyId,
        minIntervalHours: 12,
      }),
    ).rejects.toThrow("NOT_FOUND");
    expect((await a.status()).minIntervalHours).toBe(2);
  });
  it("recusa sem liberação, com bloqueio, fora do deployment e em encerramento", async () => {
    const s = await scope();
    await expect(change(s, 4)).rejects.toThrow("CAPTURE_RELEASE_NOT_RELEASED");
    await s.enable();
    vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
    await expect(change(s, 4)).rejects.toThrow("CAPTURE_RELEASE_UNAVAILABLE");
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
    await s.t.run((ctx) =>
      ctx.db.insert("organizationClosures", {
        organizationId: s.organizationId,
        state: "closing",
        requestedAt: Date.now(),
        exportUntil: Date.now() + 30 * 86_400_000,
        purgeBy: Date.now() + 37 * 86_400_000,
        generation: 1,
      }),
    );
    await expect(change(s, 4)).rejects.toThrow("ORGANIZATION_CLOSED");
    const blocked = await scope({ t: s.t });
    await blocked.enable();
    await blocked.freecorps("emergency_withdraw");
    await expect(change(blocked, 4)).rejects.toThrow("CAPTURE_RELEASE_BLOCKED");
    const releases = await s.t.run((ctx) => ctx.db.query("captureReleases").collect());
    expect(releases.map((r) => r.minIntervalHours)).toEqual([2, 2]);
  });
  it("tem o mesmo limite de tentativas de ativar e desativar", async () => {
    const s = await scope();
    await s.enable();
    for (let i = 0; i < 9; i++) await change(s, i % 2 ? 2 : 3);
    await expect(change(s, 4)).rejects.toThrow("RATE_LIMITED");
  });
});

describe("emergência e desbloqueio da Freecorps", () => {
  it("a emergência retira e bloqueia; o desbloqueio só permite ativar de novo", async () => {
    const s = await scope();
    await s.enable();
    expect(await s.freecorps("emergency_withdraw")).toEqual({
      organizationId: s.organizationId,
      companyId: s.companyId,
      released: false,
      blocked: true,
      version: 2,
    });
    expect(await s.served("connections:write")).toBe(false);
    expect(await s.served("documents:read")).toBe(true);
    expect((await s.status()).blocked).toBe(true);
    await expect(s.enable()).rejects.toThrow("CAPTURE_RELEASE_BLOCKED");
    expect(await s.freecorps("unblock")).toMatchObject({
      released: false,
      blocked: false,
      version: 3,
    });
    expect(await s.served("connections:write")).toBe(false);
    expect((await s.enable()).version).toBe(4);
    const events = await s.t.run((ctx) => ctx.db.query("captureReleaseEvents").collect());
    expect(events.map((e) => e.operator ?? null)).toEqual([
      null,
      "ana-freecorps",
      "ana-freecorps",
      null,
    ]);
  });
  it("bloquear uma empresa nunca liberada não abre produção, nem para leitura", async () => {
    const s = await scope();
    await s.freecorps("emergency_withdraw");
    expect(await s.served("documents:read")).toBe(false);
    expect((await s.status()).state).toBe("none");
    await expect(s.enable()).rejects.toThrow("CAPTURE_RELEASE_BLOCKED");
  });
  it("recusa run inválido e deployment de produção", async () => {
    const s = await scope();
    await expect(
      s.t.mutation(internal.captureRelease.set, {
        organizationId: s.organizationId,
        companyId: s.companyId,
        kind: "emergency_withdraw",
        ...operator,
        runId: "abc",
      }),
    ).rejects.toThrow("ISSUANCE_GATE_RUN_INVALID");
    for (const [name, value] of Object.entries({
      APP_ENV: "validation",
      PRODUCT_ENV: "production",
      FNFE_PROOF_FISCAL_ENV: "production",
      EMAIL_MODE: "disabled",
      SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    }))
      vi.stubEnv(name, value);
    await expect(s.freecorps("emergency_withdraw")).rejects.toThrow(
      "CAPTURE_RELEASE_DEPLOYMENT_DENIED",
    );
  });
});

describe("desbloquear nunca retira (#424)", () => {
  it("recusa desbloquear empresa liberada e não bloqueada, sem tocar a liberação nem o stream", async () => {
    const s = await scope();
    await s.enable();
    const id = await s.productionStream();
    await expect(s.freecorps("unblock")).rejects.toThrow("CAPTURE_RELEASE_NOT_BLOCKED");
    expect(await s.status()).toMatchObject({ state: "released", blocked: false });
    expect(await s.served("connections:write")).toBe(true);
    expect(await s.stream(id)).toMatchObject({ state: "active", version: 1 });
    const events = await s.t.run((ctx) => ctx.db.query("captureReleaseEvents").collect());
    expect(events.map((e) => e.kind)).toEqual(["console_release"]);
  });
  it("recusa desbloquear empresa sem registro e empresa retirada pela própria empresa", async () => {
    const s = await scope();
    await expect(s.freecorps("unblock")).rejects.toThrow("CAPTURE_RELEASE_NOT_BLOCKED");
    await s.enable();
    await s.disable();
    await expect(s.freecorps("unblock")).rejects.toThrow("CAPTURE_RELEASE_NOT_BLOCKED");
    expect((await s.status()).state).toBe("withdrawn");
  });
  it.each(["console", "emergency"] as const)(
    "toda retirada pausa o stream de produção (%s)",
    async (path) => {
      const s = await scope();
      await s.enable();
      const id = await s.productionStream();
      if (path === "console") await s.disable();
      else await s.freecorps("emergency_withdraw");
      expect(await s.stream(id)).toMatchObject({
        state: "paused",
        code: "CAPTURE_RELEASE_WITHDRAWN",
        version: 2,
      });
      const audit = await s.t.run((ctx) => ctx.db.query("captureAudit").collect());
      expect(audit.map((a) => a.action)).toContain("release_withdrawn");
    },
  );
  it("emergência, desbloqueio e parada geral não são funções públicas", () => {
    // Only the workflows reach them, with the site's deploy key; no member, key or client.
    const visibility = (fn: unknown) => {
      const { isPublic, isInternal } = fn as { isPublic?: boolean; isInternal?: boolean };
      return { isPublic: isPublic ?? false, isInternal: isInternal ?? false };
    };
    for (const fn of [captureReleaseModule.set, captureReleaseModule.setHalt])
      expect(visibility(fn)).toEqual({ isPublic: false, isInternal: true });
    for (const fn of [captureReleaseModule.enable, captureReleaseModule.disable])
      expect(visibility(fn)).toEqual({ isPublic: true, isInternal: false });
  });
  it("o desbloqueio depois da emergência não mexe no stream já pausado", async () => {
    const s = await scope();
    await s.enable();
    const id = await s.productionStream();
    await s.freecorps("emergency_withdraw");
    await s.freecorps("unblock");
    expect(await s.stream(id)).toMatchObject({ state: "paused", version: 2 });
    expect(await s.status()).toMatchObject({ state: "withdrawn", blocked: false });
  });
});

describe("empresa pelo CNPJ (#424)", () => {
  const byCnpj = (
    s: Awaited<ReturnType<typeof scope>>,
    cnpj: string,
    extra: Record<string, unknown> = {},
  ) =>
    s.t.mutation(internal.captureRelease.set, {
      cnpj,
      kind: "emergency_withdraw",
      ...operator,
      ...extra,
    });
  it("aceita o CNPJ com ou sem pontuação e devolve a empresa resolvida", async () => {
    const s = await scope();
    await s.enable();
    expect(await byCnpj(s, "11.222.333/0001-81")).toMatchObject({
      organizationId: s.organizationId,
      companyId: s.companyId,
      blocked: true,
    });
    expect(await s.served("connections:write")).toBe(false);
  });
  it("CNPJ em duas organizações não escolhe nenhuma: exige a organização", async () => {
    const a = await scope();
    const b = await scope({ t: a.t });
    await expect(byCnpj(a, CNPJ)).rejects.toThrow("CAPTURE_RELEASE_COMPANY_AMBIGUOUS");
    expect((await a.status()).blocked).toBe(false);
    expect((await b.status()).blocked).toBe(false);
    expect(await byCnpj(a, CNPJ, { organizationId: b.organizationId })).toMatchObject({
      organizationId: b.organizationId,
      companyId: b.companyId,
    });
    expect((await a.status()).blocked).toBe(false);
    expect((await b.status()).blocked).toBe(true);
  });
  it("recusa CNPJ inválido, alvo duplo ou ausente e organização que não é a da empresa", async () => {
    const s = await scope();
    const other = await scope({ t: s.t });
    await expect(byCnpj(s, "11222333000182")).rejects.toThrow("CAPTURE_RELEASE_CNPJ_INVALID");
    await expect(byCnpj(s, CNPJ, { companyId: s.companyId })).rejects.toThrow(
      "CAPTURE_RELEASE_TARGET_INVALID",
    );
    await expect(
      s.t.mutation(internal.captureRelease.set, { kind: "emergency_withdraw", ...operator }),
    ).rejects.toThrow("CAPTURE_RELEASE_TARGET_INVALID");
    await expect(
      s.t.mutation(internal.captureRelease.set, {
        organizationId: other.organizationId,
        companyId: s.companyId,
        kind: "emergency_withdraw",
        ...operator,
      }),
    ).rejects.toThrow("NOT_FOUND");
    await expect(byCnpj(s, "00000000000191")).rejects.toThrow("NOT_FOUND");
    const events = await s.t.run((ctx) => ctx.db.query("captureReleaseEvents").collect());
    expect(events).toEqual([]);
  });
});

describe("parada geral (#424)", () => {
  const halt = (s: Awaited<ReturnType<typeof scope>>, kind: "halt" | "resume") =>
    s.t.mutation(internal.captureRelease.setHalt, { kind, ...operator });
  it("para, repete a parada sem falhar e só religa o que está parado", async () => {
    const s = await scope();
    await s.enable();
    await expect(halt(s, "resume")).rejects.toThrow("CAPTURE_FISCAL_NOT_HALTED");
    expect(await halt(s, "halt")).toEqual({ halted: true, version: 1 });
    expect(await s.t.query(internal.captureRelease.haltState, {})).toEqual({ halted: true });
    expect(await halt(s, "halt")).toEqual({ halted: true, version: 2 });
    expect(await halt(s, "resume")).toEqual({ halted: false, version: 3 });
    await expect(halt(s, "resume")).rejects.toThrow("CAPTURE_FISCAL_NOT_HALTED");
    expect(await s.t.query(internal.captureRelease.haltState, {})).toEqual({ halted: false });
    const rows = await s.t.run((ctx) => ctx.db.query("captureFiscalHalts").collect());
    expect(rows.map((r) => [r.version, r.kind, r.operator, r.runId])).toEqual([
      [1, "halt", "ana-freecorps", "4242"],
      [2, "halt", "ana-freecorps", "4242"],
      [3, "resume", "ana-freecorps", "4242"],
    ]);
    // The general stop neither withdraws nor releases a company.
    expect((await s.status()).state).toBe("released");
    const events = await s.t.run((ctx) => ctx.db.query("captureReleaseEvents").collect());
    expect(events.map((e) => e.kind)).toEqual(["console_release"]);
  });
  it("recusa run inválido e deployment de produção", async () => {
    const s = await scope();
    await expect(
      s.t.mutation(internal.captureRelease.setHalt, { kind: "halt", ...operator, runId: "abc" }),
    ).rejects.toThrow("ISSUANCE_GATE_RUN_INVALID");
    for (const [name, value] of Object.entries({
      APP_ENV: "validation",
      PRODUCT_ENV: "production",
      FNFE_PROOF_FISCAL_ENV: "production",
      EMAIL_MODE: "disabled",
      SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    }))
      vi.stubEnv(name, value);
    await expect(halt(s, "halt")).rejects.toThrow("CAPTURE_RELEASE_DEPLOYMENT_DENIED");
    const rows = await s.t.run((ctx) => ctx.db.query("captureFiscalHalts").collect());
    expect(rows).toEqual([]);
  });
});

describe("selo da captura fiscal e leituras de Produção (#433)", () => {
  const listed = async (s: Awaited<ReturnType<typeof scope>>, role: Role = "owner") => {
    const member =
      role === "owner"
        ? s.member
        : await person(s.t, s.organizationId, role, { companyId: s.companyId });
    const page = await member.query(api.companies.list, {
      organizationId: s.organizationId,
      contextKey: "k",
      paginationOpts: { numItems: 20, cursor: null },
    });
    const company = await member.query(api.companies.get, {
      organizationId: s.organizationId,
      companyId: s.companyId,
      contextKey: "k",
    });
    return {
      list: page.page.find((row) => row.id === s.companyId)?.fiscalCapture,
      get: company?.fiscalCapture,
    };
  };
  const production = (s: Awaited<ReturnType<typeof scope>>) => ({
    organizationId: s.organizationId,
    companyId: s.companyId,
    environment: "production" as const,
  });

  it("segue a liberação e a situação do painel, na lista e na empresa", async () => {
    const s = await scope();
    expect(await listed(s)).toEqual({ list: null, get: null });
    await s.enable();
    expect(await listed(s)).toEqual({ list: "not-started", get: "not-started" });
    const id = await s.productionStream();
    expect(await listed(s)).toEqual({ list: "active", get: "active" });
    await s.t.run((ctx) => ctx.db.patch("captureStreams", id, { state: "paused" }));
    expect(await listed(s)).toEqual({ list: "paused", get: "paused" });
    await s.t.run((ctx) => ctx.db.patch("captureStreams", id, { state: "attention" }));
    expect(await listed(s)).toEqual({ list: "attention", get: "attention" });
    // Turned off by the company: its decision, not a badge.
    await s.disable();
    expect(await listed(s)).toEqual({ list: null, get: null });
  });
  it("a parada geral da Freecorps no site aparece como parada, não como ativa", async () => {
    const s = await scope();
    await s.enable();
    await s.productionStream();
    vi.stubEnv("APP_ENV", "installation");
    await s.t.run((ctx) =>
      ctx.db.insert("captureFiscalHalts", {
        version: 1,
        kind: "halt",
        halted: true,
        operator: "ana-freecorps",
        reason: "Parada sintética",
        runId: "1",
        runAttempt: 1,
        buildSha: null,
        deployment: "",
        createdAt: Date.now(),
      }),
    );
    const view = await s.t.run(async (ctx) => {
      const company = (await ctx.db.get("companies", s.companyId))!;
      return fiscalCaptureOf(ctx, { role: "viewer" }, company);
    });
    expect(view).toEqual({ fiscalCapture: "halted", fiscalCaptureTermsDeadline: null });
  });
  it("só para quem lê a captura, com o acesso das outras leituras", async () => {
    const s = await scope();
    await s.enable();
    await s.productionStream();
    expect(await listed(s, "viewer")).toEqual({ list: "active", get: "active" });
    expect(await listed(s, "operator")).toEqual({ list: "active", get: "active" });
    // The developer does not read captures in the console.
    expect(await listed(s, "developer")).toEqual({ list: null, get: null });
    // Another organization does not see the company at all.
    const other = await scope({ t: s.t });
    const stranger = await person(s.t, other.organizationId, "owner");
    expect(
      await stranger.query(api.companies.get, {
        organizationId: other.organizationId,
        companyId: s.companyId,
        contextKey: "k",
      }),
    ).toBeNull();
  });
  it("o histórico e os resumos de Produção só existem com a captura fiscal usada", async () => {
    const s = await scope();
    await expect(s.member.query(api.captures.history, production(s))).rejects.toThrow("NOT_FOUND");
    await expect(s.member.query(api.documents.summaryCount, production(s))).rejects.toThrow(
      "NOT_FOUND",
    );
    await s.enable();
    expect(await s.member.query(api.captures.history, production(s))).toEqual([]);
    await s.productionStream();
    expect(await s.member.query(api.captures.history, production(s))).toEqual([]);
    expect(await s.member.query(api.documents.summaryCount, production(s))).toEqual({
      count: 0,
      more: false,
    });
    // Turned off, what was captured stays readable.
    await s.disable();
    expect(await s.member.query(api.captures.history, production(s))).toEqual([]);
    const other = await scope({ t: s.t });
    const stranger = await person(s.t, other.organizationId, "owner");
    await expect(stranger.query(api.captures.history, production(s))).rejects.toThrow();
    await expect(
      stranger.query(api.captures.history, {
        ...production(s),
        organizationId: other.organizationId,
      }),
    ).rejects.toThrow("NOT_FOUND");
  });
});

describe("novos termos para quem já liberou (#428)", () => {
  /** Day after the deadline to accept the current version, counted from its `since`. */
  const deadline =
    Date.parse(`${CAPTURE_TERMS_ARCHIVE[CAPTURE_TERMS_VERSION]!.since}T00:00:00-03:00`) +
    CAPTURE_TERMS_REACCEPT_DAYS * 86_400_000;
  /** A release accepted under an older version, as one released before the current text. */
  async function olderRelease(role: Role = "owner") {
    const s = await scope({ role });
    if (role !== "owner") {
      const owner = await person(s.t, s.organizationId, "owner", { companyId: s.companyId });
      await owner.mutation(api.captureRelease.enable, {
        organizationId: s.organizationId,
        companyId: s.companyId,
        minIntervalHours: 2,
        terms: CAPTURE_TERMS_VERSION,
      });
    } else await s.enable();
    await s.t.run(async (ctx) => {
      const event = (await ctx.db
        .query("captureReleaseEvents")
        .withIndex("by_companyId_and_version", (q) =>
          q.eq("companyId", s.companyId).eq("version", 1),
        )
        .unique())!;
      await ctx.db.patch("captureReleaseEvents", event._id, {
        terms: "captura-fiscal-2026-01-01",
        termsSha256: undefined,
      });
    });
    const accept = (terms = CAPTURE_TERMS_VERSION) =>
      s.member.mutation(api.captureRelease.acceptTerms, {
        organizationId: s.organizationId,
        companyId: s.companyId,
        terms,
      });
    const expired = () =>
      s.t.run(async (ctx) =>
        captureTermsExpired(ctx, (await ctx.db.get("companies", s.companyId))!, Date.now()),
      );
    return { ...s, accept, expired };
  }
  afterEach(() => vi.useRealTimers());

  it("o prazo conta da data da versão atual, à meia-noite de Brasília", () => {
    expect(termsStanding(CAPTURE_TERMS_VERSION)).toBeNull();
    expect(termsStanding("captura-fiscal-2026-01-01")).toEqual({
      version: CAPTURE_TERMS_VERSION,
      deadline,
    });
    expect(termsStanding(null)).toEqual({ version: CAPTURE_TERMS_VERSION, deadline });
  });
  it("antes do prazo a captura segue e o console pede o aceite; depois, as consultas esperam", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(deadline - 60_000);
    const s = await olderRelease();
    // The console compares the deadline with its clock: the query never reads it (#45).
    expect((await s.status()).termsUpdate).toEqual({ version: CAPTURE_TERMS_VERSION, deadline });
    expect(await s.expired()).toBe(false);
    vi.setSystemTime(deadline);
    expect((await s.status()).termsUpdate).toEqual({ version: CAPTURE_TERMS_VERSION, deadline });
    expect(await s.expired()).toBe(true);
    // Waiting for the terms is not a withdrawal: production, keys and reading stay.
    expect(await s.status()).toMatchObject({ state: "released", blocked: false });
    expect(await s.served("documents:read")).toBe(true);
  });
  it("o gestor aceita: a liberação continua, com a mesma versão, e o histórico guarda quem e o hash", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(deadline + 86_400_000);
    const s = await olderRelease();
    const before = await s.t.run(async (ctx) =>
      ctx.db
        .query("captureReleases")
        .withIndex("by_companyId", (q) => q.eq("companyId", s.companyId))
        .unique(),
    );
    expect(await s.accept()).toEqual({ terms: CAPTURE_TERMS_VERSION });
    const [release, events] = await s.t.run(async (ctx) => [
      await ctx.db
        .query("captureReleases")
        .withIndex("by_companyId", (q) => q.eq("companyId", s.companyId))
        .unique(),
      await ctx.db.query("captureReleaseEvents").collect(),
    ]);
    expect(release!.version).toBe(before!.version);
    expect(release!.released).toBe(true);
    expect(events.at(-1)).toMatchObject({
      kind: "console_terms",
      released: true,
      terms: CAPTURE_TERMS_VERSION,
      termsSha256: CAPTURE_TERMS_SHA256,
      minIntervalHours: 2,
    });
    expect(release!.termsEventId).toBe(events.at(-1)!._id);
    const status = await s.status();
    expect(status.termsUpdate).toBeNull();
    expect(status.acceptedTerms).toEqual({
      version: CAPTURE_TERMS_VERSION,
      acceptedAt: events.at(-1)!.createdAt,
      acceptedBy: "Pessoa sintética",
    });
    expect(await s.expired()).toBe(false);
    // The interval keeps the acceptance; a new release starts from its own.
    await s.member.mutation(api.captureRelease.updateInterval, {
      organizationId: s.organizationId,
      companyId: s.companyId,
      minIntervalHours: 6,
    });
    expect((await s.status()).acceptedTerms!.acceptedAt).toBe(events.at(-1)!.createdAt);
    await expect(s.accept()).rejects.toThrow("CAPTURE_TERMS_ALREADY_ACCEPTED");
  });
  it("recusa outra versão, quem não é gestor, empresa sem liberação ou bloqueada", async () => {
    const s = await olderRelease();
    await expect(s.accept("captura-fiscal-2026-01-01")).rejects.toThrow(
      "CAPTURE_RELEASE_TERMS_REQUIRED",
    );
    const viewer = await olderRelease("viewer");
    await expect(viewer.accept()).rejects.toThrow("SCOPE_DENIED");
    await s.freecorps("emergency_withdraw");
    await expect(s.accept()).rejects.toThrow("CAPTURE_RELEASE_BLOCKED");
    const off = await scope();
    await expect(
      off.member.mutation(api.captureRelease.acceptTerms, {
        organizationId: off.organizationId,
        companyId: off.companyId,
        terms: CAPTURE_TERMS_VERSION,
      }),
    ).rejects.toThrow("CAPTURE_RELEASE_NOT_RELEASED");
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "");
    await expect(s.accept()).rejects.toThrow("CAPTURE_RELEASE_UNAVAILABLE");
  });
  it("o selo da empresa diz que a captura espera os novos termos", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(deadline);
    const s = await olderRelease();
    await s.productionStream();
    vi.stubEnv("APP_ENV", "installation");
    const view = () =>
      s.t.run(async (ctx) => {
        const company = (await ctx.db.get("companies", s.companyId))!;
        return fiscalCaptureOf(ctx, { role: "viewer" }, company);
      });
    // A mutation answers with its clock; the companies' queries return the deadline, which the
    // console compares with its own (#45).
    expect(await view()).toEqual({ fiscalCapture: "terms", fiscalCaptureTermsDeadline: deadline });
    // The same reading in a query's context, which carries no scheduler.
    const inQuery = await s.t.run(async ({ scheduler: _scheduler, ...ctx }) => {
      const company = (await ctx.db.get("companies", s.companyId))!;
      return fiscalCaptureOf(ctx, { role: "viewer" }, company);
    });
    expect(inQuery).toEqual({ fiscalCapture: "active", fiscalCaptureTermsDeadline: deadline });
    vi.stubEnv("APP_ENV", "development");
    await s.accept();
    vi.stubEnv("APP_ENV", "installation");
    expect(await view()).toEqual({ fiscalCapture: "active", fiscalCaptureTermsDeadline: null });
  });
});

describe("ambientes do seletor do console (ADR 0007, §1)", () => {
  const offered = (
    who: { query: Awaited<ReturnType<typeof scope>>["member"]["query"] },
    id: Awaited<ReturnType<typeof scope>>["organizationId"],
  ) => who.query(api.deployment.environments, { organizationId: id });
  it("antes da primeira liberação, Produção só para o gestor, que a ativa lá dentro", async () => {
    const s = await scope();
    const viewer = await person(s.t, s.organizationId, "viewer");
    const operator = await person(s.t, s.organizationId, "operator");
    expect(await offered(s.member, s.organizationId)).toEqual(["sandbox", "production"]);
    expect(await offered(viewer, s.organizationId)).toEqual(["sandbox"]);
    expect(await offered(operator, s.organizationId)).toEqual(["sandbox"]);
    // Without the deployment's switch, nobody is offered a Produção never released.
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "disabled");
    expect(await offered(s.member, s.organizationId)).toEqual(["sandbox"]);
  });
  it("depois da primeira liberação, Produção para todo membro, e fica depois de desativada", async () => {
    const s = await scope();
    const viewer = await person(s.t, s.organizationId, "viewer");
    await s.enable();
    // Every member sees it: it is only the view, each function checks the company again.
    expect(await offered(viewer, s.organizationId)).toEqual(["sandbox", "production"]);
    await s.disable();
    expect(await offered(viewer, s.organizationId)).toEqual(["sandbox", "production"]);
    // The documents stay for reading even with the deployment's switch off.
    vi.stubEnv("FNFE_CAPTURE_FISCAL", "disabled");
    expect(await offered(viewer, s.organizationId)).toEqual(["sandbox", "production"]);
  });
  it("uma liberação de outra organização não abre Produção, e quem não é membro é recusado", async () => {
    const s = await scope();
    await s.enable();
    const other = await scope({ t: s.t });
    const viewer = await person(s.t, other.organizationId, "viewer");
    expect(await offered(viewer, other.organizationId)).toEqual(["sandbox"]);
    await expect(offered(other.member, s.organizationId)).rejects.toThrow();
    await expect(
      s.t.query(api.deployment.environments, { organizationId: s.organizationId }),
    ).rejects.toThrow();
  });
  it("um bloqueio sem liberação anterior não abre Produção para quem não é gestor", async () => {
    const s = await scope();
    const viewer = await person(s.t, s.organizationId, "viewer");
    await s.freecorps("emergency_withdraw");
    expect(await offered(viewer, s.organizationId)).toEqual(["sandbox"]);
  });
});
