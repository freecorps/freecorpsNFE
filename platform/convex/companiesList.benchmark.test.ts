import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import * as companies from "./companies";
import { captureTask } from "./lib/captureValues";
import { fixture, actor } from "../../tests/helpers/export-fixture";
import { CAPTURE_TERMS_VERSION } from "./lib/fiscalCaptureRelease";
import { benchmarkLimits } from "../../scripts/lib/budget.mjs";

/**
 * Reads of `companies.list` with the fiscal capture badge (#433) at the page size the server
 * allows (`boundedPagination`, 50): every company released, with a production stream and its
 * operation, against the same page without any release. The badge reads at most the release, the
 * stream, its operation and the general stop per company; no row costs a query of its own.
 */
const NOW = Date.UTC(2026, 9, 23, 15);
const PAGE = 50;
// Tetos em budget.json: aumentar um pede a label budget-increase na PR.
const LIMITS = benchmarkLimits("companiesList", [
  "bytesRead",
  "documentsRead",
  "databaseQueries",
  "captureDocumentsReadPerCompany",
  "captureDatabaseQueriesPerCompany",
] as const);

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
    SITE_URL: "http://localhost:5202",
    CONVEX_SITE_URL: "http://127.0.0.1:3262",
    BETTER_AUTH_SECRET: "synthetic-companies-secret",
    FNFE_CAPTURE_FISCAL: "enabled",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type Metrics = { databaseQueries: number; documentsRead: number; bytesRead: number };
type ListArgs = {
  organizationId: Id<"organizations">;
  contextKey: string;
  paginationOpts: { numItems: number; cursor: string | null };
};
const handler = (
  companies.list as unknown as {
    _handler: (
      ctx: QueryCtx,
      args: ListArgs,
    ) => Promise<{ page: Array<{ fiscalCapture: unknown }> }>;
  }
)._handler;

async function scenario(released: boolean) {
  let last: Metrics | null = null;
  const measured = query({
    args: {
      organizationId: v.id("organizations"),
      contextKey: v.string(),
      paginationOpts: paginationOptsValidator,
    },
    handler: async (ctx, args) => {
      const result = await handler(ctx, args);
      const metrics = await ctx.meta.getTransactionMetrics();
      last = {
        databaseQueries: metrics.databaseQueries.used,
        documentsRead: metrics.documentsRead.used,
        bytesRead: metrics.bytesRead.used,
      };
      return result;
    },
  });
  const f = await fixture({
    "../../platform/convex/companies.ts": async () => ({ ...companies, list: measured }),
  });
  const owner = await actor(f);
  await f.t.run(async (ctx) => {
    const company = (await ctx.db.get("companies", f.scope.companyId))!;
    const { _id, _creationTime, ...fields } = company;
    void [_id, _creationTime];
    for (let c = 0; c < PAGE; c++) {
      const companyId =
        c === 0
          ? company._id
          : await ctx.db.insert("companies", {
              ...fields,
              name: `Empresa ${c}`,
              cnpj: String(c).padStart(14, "0"),
            });
      if (!released) continue;
      const release = {
        organizationId: f.scope.organizationId,
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
      const where = {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId,
        environment: "production" as const,
      };
      const operationId = await ctx.db.insert("operations", {
        ...where,
        task: captureTask,
        request: "{}",
        requestHash: "a".repeat(64),
        projectEpoch: 0,
        grantEpoch: 0,
        state: "paused",
        stage: "ready",
        generation: 1,
        fence: 1,
        attempts: 1,
        maxAttempts: 5,
        leaseUntil: 0,
        nextAttemptAt: NOW,
        backoffMs: 1000,
        jitterMs: 0,
        uncertain: false,
        code: "QUOTA_EXCEEDED",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("captureStreams", {
        ...where,
        identity: String(c).padStart(14, "0"),
        service: "nfe-distribution",
        state: "active",
        version: 3,
        checkpoint: "000000000000101",
        mode: "distNSU",
        nextAllowedAt: NOW,
        lastAttemptAt: NOW - 3_600_000,
        lastSuccessAt: NOW - 3_600_000,
        operationId,
        received: 101,
        createdAt: NOW - 86_400_000,
      });
    }
  });
  const page = await owner.client.query(api.companies.list, {
    organizationId: f.scope.organizationId,
    contextKey: "benchmark-433",
    paginationOpts: { numItems: PAGE, cursor: null },
  });
  expect(page.page).toHaveLength(PAGE);
  // An active stream whose operation stopped is in attention, as the panel says.
  expect(new Set(page.page.map((row) => row.fiscalCapture))).toEqual(
    new Set([released ? "attention" : null]),
  );
  return last!;
}

it("measures the companies' page with the fiscal capture badge at the page limit", async () => {
  const results = {
    "sem captura fiscal": await scenario(false),
    "todas com captura fiscal": await scenario(true),
  };
  if (process.env.COMPANIES_BENCHMARK) {
    mkdirSync(".ci-results/433", { recursive: true });
    writeFileSync(".ci-results/433/companies-list.json", JSON.stringify(results, null, 2) + "\n");
  }
  const base = results["sem captura fiscal"],
    all = results["todas com captura fiscal"];
  // Each company adds the release, the stream and its operation (and the general stop, read
  // only on the site): a fixed number of point reads, never a page of its own.
  expect(all.documentsRead - base.documentsRead).toBeLessThanOrEqual(
    LIMITS.captureDocumentsReadPerCompany * PAGE,
  );
  expect(all.databaseQueries - base.databaseQueries).toBeLessThanOrEqual(
    LIMITS.captureDatabaseQueriesPerCompany * PAGE,
  );
  expect(all.bytesRead).toBeLessThan(LIMITS.bytesRead);
  expect(all.documentsRead).toBeLessThan(LIMITS.documentsRead);
  expect(all.databaseQueries).toBeLessThan(LIMITS.databaseQueries);
});
