import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { v } from "convex/values";
import { query, type QueryCtx } from "../platform/convex/_generated/server";
import { api } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import * as home from "../platform/convex/consoleHome";
import { buildSnapshot, normalizeIssuanceInput } from "../platform/convex/lib/issuanceCore";
import { fixture, actor } from "./helpers/export-fixture";
import { CAPTURE_TERMS_VERSION } from "../platform/convex/lib/fiscalCaptureRelease";

/**
 * Reads of `consoleHome.summary` (#285) at the limits it allows: 10 reachable companies (plus
 * one that only marks `truncated`), 101 issuances and 101 received documents of the month and
 * 6 imports of 20 files per company. The rows are clones of records produced by the real
 * importer and by `buildSnapshot`, so their sizes are those of production rows.
 */
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 15, 15);
const MONTH_START = Date.UTC(2026, 9, 1, 3);
const COMPANIES = 11;
const ROWS = 101;
const IMPORTS = 6;
const FILES = 20;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5201",
    CONVEX_SITE_URL: "http://127.0.0.1:3261",
    BETTER_AUTH_SECRET: "synthetic-home-secret",
    // Only the `production` shape has releases; the others read no production at all.
    FNFE_CAPTURE_FISCAL: "enabled",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type Metrics = { databaseQueries: number; documentsRead: number; bytesRead: number; ms: number };
type Shape = {
  issuances?: "authorized" | "processing";
  documents?: boolean;
  /** State of every import file's operation. */
  imports?: "succeeded" | "failed";
  /**
   * Fiscal capture released for every company (#422): 101 documents received in production this
   * month and a production stream in attention, a pending item of the Início.
   */
  production?: boolean;
};

const summaryArgs = {
  organizationId: v.id("organizations"),
  monthStart: v.number(),
  asOf: v.number(),
  contextKey: v.string(),
};
type SummaryArgs = { organizationId: Id<"organizations">; monthStart: number; asOf: number };
const handler = (
  home.summary as unknown as {
    _handler: (ctx: QueryCtx, args: SummaryArgs) => Promise<unknown>;
  }
)._handler;

async function scenario(shape: Shape) {
  let last: Metrics | null = null;
  // Same handler, measured from inside the transaction: auth is included, as in the console.
  const measured = query({
    args: summaryArgs,
    handler: async (ctx, args) => {
      const begun = performance.now();
      const result = await handler(ctx, args);
      const ms = performance.now() - begun;
      const metrics = await ctx.meta.getTransactionMetrics();
      last = {
        databaseQueries: metrics.databaseQueries.used,
        documentsRead: metrics.documentsRead.used,
        bytesRead: metrics.bytesRead.used,
        ms,
      };
      return result;
    },
  });
  const f = await fixture({
    "../../platform/convex/consoleHome.ts": async () => ({ ...home, summary: measured }),
  });
  const owner = await actor(f);
  await f.t.run(async (ctx) => {
    const company = (await ctx.db.get("companies", f.scope.companyId))!;
    const document = (await ctx.db.get("fiscalDocuments", f.documentId))!;
    const batch = (await ctx.db.query("imports").first())!;
    const file = (await ctx.db.query("importFiles").first())!;
    const importOperation = (await ctx.db.get(
      "operations",
      (file.processingOperationId ?? file.operationId)!,
    ))!;
    const strip = <T extends { _id: unknown; _creationTime: number }>(row: T) => {
      const { _id, _creationTime, ...fields } = row;
      void [_id, _creationTime];
      return fields;
    };
    const profileFields = {
      municipalityCode: "3550308",
      opSimpNac: 1 as const,
      regEspTrib: 0 as const,
      dpsSeries: "1",
      activities: [
        {
          code: "licenca",
          label: "Licenciamento de software",
          cnae: "6203100",
          lc116Item: "01.05",
          cTribNac: "010501",
          nbs: "111032200",
        },
      ],
      version: 1,
      updatedBy: "synthetic",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const request = normalizeIssuanceInput({
      activityCode: "licenca",
      competence: "2026-10",
      issuerEmail: "fiscal@prestador.example",
      market: "domestic",
      taker: {
        kind: "national",
        document: "11.444.777/0001-61",
        name: "Tomador Sintético Ltda",
        email: "contas@tomador.example",
        address: {
          municipalityCode: "3550308",
          postalCode: "01001-000",
          street: "Praça da Sé",
          number: "100",
          district: "Sé",
        },
      },
      description: "Licença de uso de software, outubro de 2026",
      amount: { currency: "BRL", value: "1000" },
      issRate: "2.5",
      issWithheld: false,
    });
    for (let c = 0; c < COMPANIES; c++) {
      const companyId =
        c === 0
          ? company._id
          : await ctx.db.insert("companies", { ...strip(company), name: `Empresa ${c}` });
      await ctx.db.patch("companies", companyId, { kind: "declared" });
      const where = {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId,
        environment: "sandbox" as const,
      };
      await ctx.db.insert("nfseProfiles", {
        organizationId: where.organizationId,
        companyId,
        ...profileFields,
      });
      const profile = (await ctx.db
        .query("nfseProfiles")
        .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
        .unique())!;
      const certificateId = await ctx.db.insert("certificates", {
        organizationId: where.organizationId,
        companyId,
        version: 1,
        state: "active",
        uploaderId: "synthetic",
        membershipId: owner.membershipId,
        membershipVersion: 1,
        metadata: {
          fingerprint: "a".repeat(64),
          subject: "CN=EMPRESA SINTETICA LTDA:11222333000181",
          cnpj: company.cnpj,
          notBefore: NOW - 100 * DAY,
          notAfter: NOW + 200 * DAY,
        },
        envelopeRevision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("certificateHeads", {
        organizationId: where.organizationId,
        companyId,
        nextVersion: 2,
        latestId: certificateId,
        activeId: certificateId,
      });
      if (shape.issuances) {
        const snapshot = buildSnapshot({
          request,
          company: { ...company, _id: companyId },
          profile,
          environment: "sandbox",
          transport: "simulated",
          now: NOW,
        });
        for (let n = 1; n <= ROWS; n++) {
          const operationId = await ctx.db.insert("operations", {
            ...strip(importOperation),
            ...where,
            task: {
              name: "nfse.issue",
              workload: "issuance",
              scope: "documents:issue",
              executor: "issuance",
            },
            request: JSON.stringify(request),
            state: shape.issuances === "processing" ? "running" : "succeeded",
          });
          const dpsId = `DPS${String(n).padStart(42, "0")}`;
          const frozen = JSON.stringify({ ...snapshot, series: "1", number: n, dpsId });
          await ctx.db.insert("issuances", {
            ...where,
            operationId,
            state: shape.issuances,
            transport: "simulated",
            target: snapshot.target,
            series: "1",
            number: n,
            dpsId,
            snapshot: frozen,
            snapshotSha256: "b".repeat(64),
            submissions: 1,
            version: 2,
            createdAt: NOW - n * 60_000,
            updatedAt: NOW - n * 60_000,
          });
        }
      }
      if (shape.documents)
        for (let n = 0; n < ROWS; n++)
          if (c > 0 || n > 0)
            await ctx.db.insert("fiscalDocuments", {
              ...strip(document),
              companyId,
              fiscalKey: `${c}`.padStart(4, "0") + `${n}`.padStart(40, "0"),
              listedAt: NOW - n * 60_000,
            });
      if (shape.production) {
        const release = {
          organizationId: where.organizationId,
          companyId,
          released: true,
          blocked: false,
          minIntervalHours: 1,
          reason: "Liberação sintética",
        };
        const eventId = await ctx.db.insert("captureReleaseEvents", {
          ...release,
          version: 1,
          kind: "console_release",
          terms: CAPTURE_TERMS_VERSION,
          revokedKeys: 0,
          buildSha: null,
          deployment: "",
          createdAt: NOW,
        });
        await ctx.db.insert("captureReleases", {
          ...release,
          releasedBefore: true,
          actor: "member:synthetic",
          version: 1,
          updatedAt: NOW,
          eventId,
        });
        await ctx.db.insert("captureStreams", {
          ...where,
          environment: "production",
          identity: company.cnpj,
          service: "nfe-distribution",
          state: "attention",
          code: "SOURCE_CONSUMPTION_BLOCKED",
          version: 3,
          checkpoint: "000000000000101",
          mode: "distNSU",
          nextAllowedAt: NOW,
          lastAttemptAt: NOW - DAY,
          lastSuccessAt: NOW - 2 * DAY,
          received: ROWS,
          createdAt: NOW - 60 * DAY,
        });
        for (let n = 0; n < ROWS; n++)
          await ctx.db.insert("fiscalDocuments", {
            ...strip(document),
            companyId,
            environment: "production",
            fiscalKey: `p${c}`.padStart(4, "0") + `${n}`.padStart(40, "0"),
            listedAt: NOW - n * 60_000,
          });
      }
      if (shape.imports)
        for (let n = 0; n < IMPORTS; n++) {
          const importId =
            c === 0 && n === 0
              ? batch._id
              : await ctx.db.insert("imports", {
                  ...strip(batch),
                  companyId,
                  key: `bench-${c}-${n}`,
                  createdAt: NOW - (n + 1) * 60_000,
                });
          for (let position = c === 0 && n === 0 ? 1 : 0; position < FILES; position++) {
            const operationId = await ctx.db.insert("operations", {
              ...strip(importOperation),
              ...where,
              state: shape.imports,
            });
            await ctx.db.insert("importFiles", {
              ...strip(file),
              importId,
              position,
              operationId,
              processingOperationId: operationId,
            });
          }
        }
    }
  });
  if (shape.imports === "failed")
    await f.t.run(async (ctx) => {
      const first = (await ctx.db.query("importFiles").first())!;
      await ctx.db.patch("operations", (first.processingOperationId ?? first.operationId)!, {
        state: "failed",
      });
    });
  const runs: Metrics[] = [];
  let summary: Awaited<ReturnType<typeof owner.client.query<typeof api.consoleHome.summary>>>;
  for (let run = 0; run < 5; run++) {
    summary = await owner.client.query(api.consoleHome.summary, {
      organizationId: f.scope.organizationId,
      monthStart: MONTH_START,
      asOf: NOW,
      contextKey: "benchmark-285",
    });
    runs.push(last!);
  }
  const ms = runs.map((run) => run.ms).sort((a, b) => a - b)[2]!;
  // Five imports per company are counted; the sixth only marks the month partial.
  expect(summary!.month?.failedImports).toBe(shape.imports === "failed" ? 50 : 0);
  expect(summary!.companies).toEqual({ count: 10, truncated: true });
  if (shape.production) {
    // 100 counted per company, the 101st only marks the month partial.
    expect(summary!.month?.production).toEqual({ received: 1000 });
    expect(summary!.pending.filter((item) => item.kind === "capture-attention")).toHaveLength(10);
  } else expect(summary!.month?.production).toBeNull();
  return { ...runs[0]!, ms: Math.round(ms) };
}

it("measures the Início summary at the limits it allows", async () => {
  const results: Record<string, Metrics> = {
    "só a preparação": await scenario({}),
    "emissões autorizadas": await scenario({ issuances: "authorized" }),
    "emissões em processamento": await scenario({ issuances: "processing" }),
    "documentos recebidos": await scenario({ documents: true }),
    importações: await scenario({ imports: "succeeded" }),
    "importações com falha": await scenario({ imports: "failed" }),
    "captura em Produção": await scenario({ production: true }),
    "tudo no limite": await scenario({
      issuances: "processing",
      documents: true,
      imports: "succeeded",
      production: true,
    }),
  };
  if (process.env.HOME_BENCHMARK) {
    mkdirSync(".ci-results/285", { recursive: true });
    writeFileSync(".ci-results/285/summary.json", JSON.stringify(results, null, 2) + "\n");
  }
  const all = results["tudo no limite"]!;
  // The query stays well inside a Convex transaction (16 MiB, 32 000 documents, 4 096 ranges).
  expect(all.bytesRead).toBeLessThan(16 * 2 ** 20);
  expect(all.documentsRead).toBeLessThan(32_000);
  expect(all.databaseQueries).toBeLessThan(4_096);
});
