import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { PLATFORM_PLANS } from "./lib/planCatalog";
import { recordUsage, requireQuota, reserveUsage } from "./lib/usageCore";
import { RESERVATION_TTL } from "./lib/importValues";
import { ConvexError } from "convex/values";
import { usagePeriod } from "./lib/usageValues";
import { fixture as xml } from "../../tests/helpers/nfe-corpus";
import {
  person,
  platformTest,
  SYNTHETIC_ISSUER_CNPJ,
  type PlatformTest,
} from "../../tests/helpers/platform";

/**
 * ADR 0010, decisions 10 and 11: in Production the free tier admits new imports while the month
 * has fewer than 100 new notes, one per company and access key. Synthetic XML of the NF-e corpus;
 * every fixture below shares one access key, issued by the synthetic issuer CNPJ.
 *
 * A deployment imports only in its base environment (`environmentServed`): the sandbox ones, as
 * the hosted site, import in Sandbox, and a production one (here the #50 profile) in Production.
 * Each request runs under the profile of its environment, over the same database.
 */
const profiles = {
  sandbox: {
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5211",
    CONVEX_SITE_URL: "http://127.0.0.1:3271",
    BETTER_AUTH_SECRET: "synthetic-free-notes",
  },
  production: {
    APP_ENV: "validation",
    PRODUCT_ENV: "production",
    FNFE_PROOF_FISCAL_ENV: "production",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "disabled",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    BETTER_AUTH_SECRET: "synthetic-free-notes",
  },
};
/** The deployment profile that serves `environment`. */
function on(environment: "sandbox" | "production") {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(profiles[environment])) vi.stubEnv(name, value);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 20, 12));
  on("sandbox");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
/** Recipient of the corpus NF-e, author of its 210200 manifestation (fictitious). */
const RECIPIENT_CNPJ = "00000000000191";
type Environment = "sandbox" | "production";

async function fixture(t: PlatformTest = platformTest()) {
  const secrets = {
    sandbox: `fnfe_${crypto.randomUUID().replaceAll("-", "")}${"c".repeat(11)}`,
    production: `fnfe_${crypto.randomUUID().replaceAll("-", "")}${"d".repeat(11)}`,
  };
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(secrets.sandbox),
    suffix: crypto.randomUUID(),
  });
  const productionKey = await hashApiKey(secrets.production);
  await t.run(async (ctx) => {
    // A demonstration company is served only in Sandbox.
    await ctx.db.patch("companies", scope.companyId, {
      cnpj: SYNTHETIC_ISSUER_CNPJ,
      kind: "declared",
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { environments: ["sandbox", "production"] });
    // Valid past an import reservation's expiry, which some cases wait for.
    await ctx.db.patch("apiKeys", scope.keyId, { expiresAt: Date.now() + 30 * 86400_000 });
    const { _id, _creationTime, ...key } = (await ctx.db.get("apiKeys", scope.keyId))!;
    await ctx.db.insert("apiKeys", { ...key, keyHash: productionKey, environment: "production" });
  });
  /** Another company of the organization, granted to the project in both environments. */
  async function company(cnpj: string) {
    return t.run(async (ctx) => {
      const { _id, _creationTime, ...own } = (await ctx.db.get("companies", scope.companyId))!;
      const companyId = await ctx.db.insert("companies", { ...own, cnpj });
      await ctx.db.insert("projectCompanies", {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        companyId,
        scopes: ["documents:import"],
        environments: ["sandbox", "production"],
        active: true,
        version: 1,
        accessEpoch: 0,
      });
      for (const key of await ctx.db.query("apiKeys").collect())
        if (key.projectId === scope.projectId)
          await ctx.db.patch("apiKeys", key._id, {
            companyIds: [...key.companyIds, companyId],
            grantEpochs: [...key.grantEpochs, 0],
          });
      return companyId;
    });
  }
  const request = (environment: Environment, path: string, key: string, body?: unknown) => {
    on(environment);
    return t.fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${secrets[environment]}`,
        "X-Environment": environment,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  /** The admission of an import of one file, or of each of `bytes`; `key` repeats an earlier one. */
  const reserve = (
    environment: Environment,
    bytes: Uint8Array | Uint8Array[],
    options: { key?: string; companyId?: Id<"companies"> } = {},
  ) =>
    request(environment, "/v1/imports", options.key ?? crypto.randomUUID(), {
      companyId: options.companyId ?? scope.companyId,
      files: (Array.isArray(bytes) ? bytes : [bytes]).map((data, n) => ({
        name: `nota-${n}.xml`,
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      })),
    });
  async function admitted(response: Response) {
    if (response.status !== 200) throw new Error(await response.text());
    return (await response.json()).data as {
      importId: Id<"imports">;
      fileIds: Id<"importFiles">[];
      reused: boolean;
    };
  }
  /** Upload, confirmation and processing of an admitted one-file import, as the worker runs it. */
  async function finish(
    environment: Environment,
    batch: Awaited<ReturnType<typeof admitted>>,
    bytes: Uint8Array,
    process = true,
  ) {
    const base = await upload(environment, batch, bytes);
    const confirmed = await request(environment, `${base}/confirm`, crypto.randomUUID(), {});
    expect(confirmed.status).toBe(200);
    const { operationId } = (await confirmed.json()).data as { operationId: Id<"operations"> };
    if (process) await run(environment, operationId);
    return operationId;
  }
  /** The upload of an admitted one-file import, without its confirmation. */
  async function upload(
    environment: Environment,
    batch: Awaited<ReturnType<typeof admitted>>,
    bytes: Uint8Array,
  ) {
    const base = `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}`;
    const ticket = await request(environment, `${base}/upload`, crypto.randomUUID(), {});
    expect(ticket.status).toBe(200);
    const sent = await t.fetch("/v1/import-upload", {
      method: "POST",
      headers: { "X-Upload-Token": ((await ticket.json()).data as { token: string }).token },
      body: new Uint8Array(bytes),
    });
    expect(sent.status).toBe(200);
    return base;
  }
  async function run(environment: Environment, operationId: Id<"operations">) {
    on(environment);
    const op = (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
    await t.action(internal.operationWorker.run, { operationId, generation: op.generation });
    expect((await t.run((ctx) => ctx.db.get("operations", operationId)))!.state).toBe("succeeded");
  }
  /** One XML imported into a company, from the admission to the published documents. */
  async function importXml(
    environment: Environment,
    id: string | Uint8Array,
    companyId: Id<"companies"> = scope.companyId,
  ) {
    const bytes = typeof id === "string" ? xml(id) : id;
    const batch = await admitted(await reserve(environment, bytes, { companyId }));
    await finish(environment, batch, bytes);
    return batch;
  }
  const plan = (
    limits: (typeof PLATFORM_PLANS)[keyof typeof PLATFORM_PLANS]["limits"],
    organizationId = scope.organizationId,
    expectedVersion = 0,
  ) =>
    t.mutation(internal.usage.assignPlan, {
      organizationId,
      name: "Plano sintético com as cotas do catálogo",
      startsAt: 0,
      endsAt: null,
      limits,
      concurrency: 2,
      actor: "test",
      reason: "cotas do catálogo",
      expectedVersion,
    });
  /** Notes already counted this month in the organization, as other imports or captures left them. */
  const counted = (
    n: number,
    environment: Environment = "production",
    metric: "documents" | "imports" | "captures" = "documents",
    organizationId = scope.organizationId,
  ) =>
    t.run(async (ctx) => {
      for (let i = 0; i < n; i++)
        await recordUsage(
          ctx,
          organizationId,
          environment,
          metric,
          `earlier:${crypto.randomUUID()}`,
          1,
          metric === "documents",
        );
    });
  return {
    t,
    scope,
    company,
    reserve,
    admitted,
    upload,
    finish,
    run,
    importXml,
    plan,
    counted,
    request,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** What the owner reads in Uso e limites: confirmed plus reserved, per environment. */
async function usage(f: Fixture, period = usagePeriod(Date.now())) {
  const owner = await person(f.t, f.scope.organizationId, "owner");
  const view = await owner.query(api.usage.overview, {
    organizationId: f.scope.organizationId,
    period,
    contextKey: "test",
  });
  const of = (environment: Environment, metric: string) => {
    const row = view.environments[environment].find((r) => r.metric === metric)!;
    return row.committed + row.reserved;
  };
  return {
    plan: view.plan,
    notes: of("production", "documents"),
    sandboxDocuments: of("sandbox", "documents"),
    imports: (environment: Environment) => of(environment, "imports"),
  };
}
/** The plan's quota refusal, told apart from the technical rate limit by its message. */
async function refused(response: Response) {
  if (response.status !== 429) throw new Error(await response.text());
  const { error } = (await response.json()) as {
    error: { code: string; message: string; retryable: boolean };
  };
  expect(error).toMatchObject({ code: "RATE_LIMITED", retryable: false });
  expect(error.message).toMatch(/^Cota do plano atingida\./);
  // The plan's numbers stay inside: the public body carries no `limit`.
  expect(error).not.toHaveProperty("limit");
  expect(Object.keys(error).sort()).toEqual(["code", "message", "retryable"]);
}
const fiscalDocuments = (f: Fixture) => f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());

it("o Gratuito em Produção admite com 99 notas e recusa a admissão seguinte com 100", async () => {
  const f = await fixture();
  await f.plan(PLATFORM_PLANS.free.limits);
  await f.counted(99);
  const kept = await f.reserve("production", xml("invoice-authorized"), { key: "kept" });
  const batch = await f.admitted(kept);
  await f.finish("production", batch, xml("invoice-authorized"));
  expect((await usage(f)).notes).toBe(100);
  await refused(await f.reserve("production", xml("invoice-signed")));
  // The admission already made is answered again, without counting another file or note.
  const again = await f.admitted(
    await f.reserve("production", xml("invoice-authorized"), { key: "kept" }),
  );
  expect(again).toMatchObject({ importId: batch.importId, reused: true });
  expect(await usage(f)).toMatchObject({ notes: 100 });
  expect((await usage(f)).imports("production")).toBe(1);
});

it("uma importação admitida com 99 notas entra inteira mesmo depois de outra nota chegar a 100", async () => {
  const f = await fixture();
  await f.plan(PLATFORM_PLANS.free.limits);
  await f.counted(99);
  const bytes = xml("invoice-authorized");
  const batch = await f.admitted(await f.reserve("production", bytes));
  // A capture of the organization reaches the limit before this file is processed.
  await f.counted(1);
  await f.finish("production", batch, bytes);
  expect(await fiscalDocuments(f)).toHaveLength(1);
  expect((await fiscalDocuments(f))[0]).toMatchObject({
    environment: "production",
    completeness: 2,
  });
  expect((await usage(f)).notes).toBe(101);
  await refused(await f.reserve("production", xml("invoice-signed")));
});

it("resumo, XML completo e evento da mesma chave contam uma nota; reprocessar e reimportar não somam", async () => {
  const f = await fixture();
  await f.plan(PLATFORM_PLANS.free.limits);
  const first = await f.importXml("production", "summary-authorized");
  await f.importXml("production", "invoice-authorized");
  await f.importXml("production", "event-110111");
  // The same full XML again, as a new intent: another file, the same note.
  await f.importXml("production", "invoice-authorized");
  expect(await fiscalDocuments(f)).toHaveLength(1);
  const reprocess = await f.request(
    "production",
    `/v1/imports/${first.importId}/files/${first.fileIds[0]}/reprocess`,
    "reprocess-summary",
    {},
  );
  expect(reprocess.status).toBe(200);
  await f.run(
    "production",
    ((await reprocess.json()).data as { operationId: Id<"operations"> }).operationId,
  );
  const after = await usage(f);
  expect(after.notes).toBe(1);
  expect(after.imports("production")).toBe(4);
});

it("a mesma chave em duas empresas da organização conta duas notas", async () => {
  const f = await fixture();
  await f.plan(PLATFORM_PLANS.free.limits);
  const recipient = await f.company(RECIPIENT_CNPJ);
  await f.importXml("production", "invoice-authorized");
  // The recipient's manifestation carries the same access key, in its own company.
  await f.importXml("production", "event-210200-other-author", recipient);
  const docs = await fiscalDocuments(f);
  expect(new Set(docs.map((doc) => doc.fiscalKey)).size).toBe(1);
  expect(new Set(docs.map((doc) => doc.companyId))).toEqual(
    new Set([f.scope.companyId, recipient]),
  );
  expect((await usage(f)).notes).toBe(2);
});

it("o Sandbox mantém 100 importações, fica fora da conta de notas, e Produção não conta arquivos", async () => {
  const f = await fixture();
  await f.plan(PLATFORM_PLANS.free.limits);
  await f.importXml("sandbox", "invoice-authorized");
  expect(await usage(f)).toMatchObject({ notes: 0, sandboxDocuments: 1 });
  // Production at its limit leaves the sandbox admitting, up to its own 100 files.
  await f.counted(100);
  await f.counted(98, "sandbox", "imports");
  await f.admitted(await f.reserve("sandbox", xml("invoice-signed")));
  await refused(await f.reserve("sandbox", xml("invoice-signed")));
  // In Production the files do not count toward a quota of their own: 150 files with no note.
  const g = await fixture(f.t);
  await g.plan(PLATFORM_PLANS.free.limits, g.scope.organizationId);
  await g.counted(150, "production", "imports");
  await g.admitted(await g.reserve("production", xml("invoice-signed")));
});

it("os planos pagos continuam limitados por arquivos e consultas, sem cota de notas", async () => {
  expect("notes" in PLATFORM_PLANS.intermediate.limits).toBe(false);
  expect("notes" in PLATFORM_PLANS.large.limits).toBe(false);
  const f = await fixture();
  await f.plan(PLATFORM_PLANS.intermediate.limits);
  await f.counted(500);
  await f.counted(999, "production", "imports");
  await f.admitted(await f.reserve("production", xml("invoice-authorized")));
  await refused(await f.reserve("production", xml("invoice-signed")));
  expect((await usage(f)).plan?.limits).toEqual(PLATFORM_PLANS.intermediate.limits);
});

it("a cota de notas de uma organização não recusa a outra", async () => {
  const f = await fixture();
  const g = await fixture(f.t);
  await f.plan(PLATFORM_PLANS.free.limits);
  await g.plan(PLATFORM_PLANS.free.limits, g.scope.organizationId);
  await f.counted(100);
  await refused(await f.reserve("production", xml("invoice-authorized")));
  await g.importXml("production", "invoice-authorized");
  expect((await usage(g)).notes).toBe(1);
  expect((await usage(f)).notes).toBe(100);
});

it("a virada do mês civil UTC zera a contagem de notas", async () => {
  vi.setSystemTime(Date.UTC(2026, 9, 31, 23, 59));
  const f = await fixture();
  await f.plan(PLATFORM_PLANS.free.limits);
  await f.counted(100);
  await refused(await f.reserve("production", xml("invoice-authorized")));
  vi.setSystemTime(Date.UTC(2026, 10, 1, 0, 0));
  await f.importXml("production", "invoice-authorized");
  expect((await usage(f, "2026-10")).notes).toBe(100);
  expect((await usage(f, "2026-11")).notes).toBe(1);
});

it("reservas sem envio contam como notas pendentes, e a expiração de uma libera a vaga", async () => {
  const f = await fixture();
  await f.plan(PLATFORM_PLANS.free.limits);
  await f.counted(98);
  const first = await f.admitted(
    await f.reserve("production", xml("invoice-authorized"), { key: "first" }),
  );
  await f.admitted(await f.reserve("production", xml("invoice-signed")));
  // 98 notes and 2 files not yet sent: the limit is reached before any upload.
  expect((await usage(f)).notes).toBe(100);
  await refused(await f.reserve("production", xml("invoice-net-values")));
  // The same admission again counts nothing more.
  expect(
    await f.admitted(await f.reserve("production", xml("invoice-authorized"), { key: "first" })),
  ).toMatchObject({ importId: first.importId, reused: true });
  expect((await usage(f)).notes).toBe(100);
  // The first reservation expires unsent: its place is free again.
  vi.setSystemTime(Date.now() + RESERVATION_TTL + 1);
  await f.t.mutation(internal.imports.expire, { importId: first.importId });
  expect((await usage(f)).notes).toBe(99);
  await f.admitted(await f.reserve("production", xml("invoice-net-values")));
  await refused(await f.reserve("production", xml("invoice-payment-link")));
});

it("cancelar no console e expirar depois do envio devolvem a nota pendente; um arquivo confirmado a guarda", async () => {
  const f = await fixture();
  await f.plan(PLATFORM_PLANS.free.limits);
  // A console import, cancelled before upload.
  on("production");
  const owner = await person(f.t, f.scope.organizationId, "owner");
  const bytes = xml("invoice-authorized");
  const own = await owner.mutation(api.imports.reserve, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "production",
    key: "console-import",
    files: [
      {
        name: "nota.xml",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  });
  expect((await usage(f)).notes).toBe(1);
  await owner.mutation(api.imports.cancel, { fileId: own.fileIds[0]! });
  expect((await usage(f)).notes).toBe(0);
  // One file sent and never confirmed; another confirmed and not yet processed.
  const sent = await f.admitted(await f.reserve("production", xml("invoice-signed")));
  await f.upload("production", sent, xml("invoice-signed"));
  const confirmed = await f.admitted(await f.reserve("production", bytes));
  const operationId = await f.finish("production", confirmed, bytes, false);
  expect((await usage(f)).notes).toBe(2);
  vi.setSystemTime(Date.now() + RESERVATION_TTL + 1);
  for (const batch of [sent, confirmed])
    await f.t.mutation(internal.imports.expire, { importId: batch.importId });
  // The sent file gave its place back; the confirmed one keeps it until its processing ends.
  expect((await usage(f)).notes).toBe(1);
  await f.run("production", operationId);
  expect((await usage(f, "2026-10")).notes).toBe(1);
  expect(await fiscalDocuments(f)).toHaveLength(1);
});

it("um lote cujos arquivos passam de 100 é recusado inteiro; abaixo, entra", async () => {
  const f = await fixture();
  await f.plan(PLATFORM_PLANS.free.limits);
  await f.counted(99);
  await refused(await f.reserve("production", [xml("invoice-authorized"), xml("invoice-signed")]));
  expect((await usage(f)).notes).toBe(99);
  expect((await usage(f)).imports("production")).toBe(0);
  await f.admitted(await f.reserve("production", [xml("invoice-authorized")]));
  expect((await usage(f)).notes).toBe(100);
});

it("um arquivo processado troca a nota pendente pelas notas publicadas, ou por nenhuma", async () => {
  const f = await fixture();
  await f.plan(PLATFORM_PLANS.free.limits);
  await f.importXml("production", "invoice-authorized");
  expect((await usage(f)).notes).toBe(1);
  // A file the parser rejects publishes no note and holds none.
  await f.importXml("production", new TextEncoder().encode("<nota>não é NF-e</nota>"));
  expect((await usage(f)).notes).toBe(1);
  // A processing that fails for good gives the pending note back.
  const bytes = xml("invoice-signed");
  const batch = await f.admitted(await f.reserve("production", bytes));
  const operationId = await f.finish("production", batch, bytes, false);
  expect((await usage(f)).notes).toBe(2);
  const op = (await f.t.run((ctx) => ctx.db.get("operations", operationId)))!;
  const claimed = (await f.t.mutation(internal.operations.claim, {
    operationId,
    generation: op.generation,
  }))!;
  const token = { operationId, generation: claimed.generation, fence: claimed.fence };
  await f.t.mutation(internal.operations.beginEffect, token);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "definitive", code: "TASK_FAILED" },
  });
  expect((await f.t.run((ctx) => ctx.db.get("operations", operationId)))!.state).toBe("failed");
  expect((await usage(f)).notes).toBe(1);
});

it("a recusa pela cota de notas diz a unidade, o ambiente, o período e o limite", async () => {
  const f = await fixture();
  await f.plan(PLATFORM_PLANS.free.limits);
  await f.counted(100);
  const expected = {
    code: "QUOTA_EXCEEDED",
    metric: "documents",
    environment: "production",
    period: "2026-10",
    limit: 100,
  };
  const refusal = async (run: () => Promise<unknown>) => {
    const error = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConvexError);
    return (error as ConvexError<Record<string, string>>).data;
  };
  expect(
    await refusal(() =>
      f.t.run((ctx) => requireQuota(ctx, f.scope.organizationId, "production", "captures")),
    ),
  ).toEqual(expected);
  expect(
    await refusal(() =>
      f.t.run((ctx) =>
        reserveUsage(ctx, f.scope.organizationId, "production", "imports", "direct-file"),
      ),
    ),
  ).toEqual(expected);
  // The sandbox and a measured note are not refused.
  await f.t.run((ctx) => requireQuota(ctx, f.scope.organizationId, "sandbox", "captures"));
  await f.t.run((ctx) =>
    recordUsage(ctx, f.scope.organizationId, "production", "documents", "late-note", 1, true),
  );
});

it("o Gratuito do catálogo leva a cota de notas para a organização", async () => {
  const f = await fixture();
  await f.t.mutation(internal.plans.configure, {
    enabled: true,
    expectedVersion: 0,
    filesBytes: 10 * 2 ** 30,
    databaseBytes: 2 ** 30,
    custodyCents: 100000,
    freeMonthlyCents: 10000,
    admissionsUntil: Date.now() + 86400000,
    evidence: "synthetic-local-proof",
  });
  const owner = await person(f.t, f.scope.organizationId, "owner");
  await owner.mutation(api.plans.claimFree, { organizationId: f.scope.organizationId });
  expect((await usage(f)).plan?.limits).toEqual({
    imports: 100,
    captures: 100,
    registry: 10,
    bytes: 64 * 2 ** 20,
    deliveries: 300,
    notes: 100,
  });
});
