/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { internal } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import { totalFor } from "../platform/convex/lib/usageCore";
import { reserveCapacity } from "../platform/convex/lib/capacityCore";
import { uploadTicket } from "../platform/convex/imports";
import type { Id } from "../platform/convex/_generated/dataModel";

/**
 * #559: concurrent admissions of one organization must not all rewrite the organization's stock
 * total and capacity account when nothing is gated by them.
 */
const modules = import.meta.glob("../platform/convex/**/*.ts");
const PERIOD = "2026-09";
type Tester = Awaited<ReturnType<typeof fixture>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5199",
    CONVEX_SITE_URL: "http://127.0.0.1:3257",
    BETTER_AUTH_SECRET: "synthetic-usage-test-only",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}
async function organization(t: Tester, secret: string) {
  return t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(secret),
    suffix: crypto.randomUUID(),
  });
}
const assignPlan = (t: Tester, organizationId: Id<"organizations">, imports: number) =>
  t.mutation(internal.usage.assignPlan, {
    organizationId,
    name: "Plano de teste",
    startsAt: Date.now() - 1,
    endsAt: Date.now() + 86400000,
    limits: { imports, bytes: 100000, captures: 2, registry: 1, deliveries: 1 },
    concurrency: 1,
    actor: "local-test",
    reason: "Synthetic proof",
    expectedVersion: 0,
  });
const admit = (t: Tester, secret: string, companyId: Id<"companies">, key: string) =>
  t.fetch("/v1/imports", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "X-Environment": "sandbox",
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({
      companyId,
      files: [{ name: "nota.xml", size: 10, sha256: "a".repeat(64) }],
    }),
  });
const stock = (t: Tester) =>
  t.run(async (ctx) => ({
    events: await ctx.db.query("capacityEvents").collect(),
    totals: await ctx.db.query("capacityTotals").collect(),
    account: await ctx.db.query("capacityAccounts").first(),
  }));

it("with the capacity policy off, admission leaves the stock to the upload", async () => {
  const t = await fixture();
  const secret = `fnfe_${"l".repeat(43)}`;
  const org = await organization(t, secret);
  await assignPlan(t, org.organizationId, 10);
  const response = await admit(t, secret, org.companyId, "stock");
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as { data: { fileIds: string[] } };
  const admitted = await stock(t);
  expect(admitted.events).toHaveLength(0);
  expect(admitted.totals).toHaveLength(0);
  expect(admitted.account).toMatchObject({ ready: true });
  expect(admitted.account?.revision).toBeUndefined();
  // The upload reserves the file's bytes before storing any of them (`importUpload.inspect`).
  const fileId = data.fileIds[0] as Id<"importFiles">;
  const ticket = await t.run(async (ctx) => uploadTicket(ctx, fileId, await hashApiKey(secret)));
  await t.mutation(internal.importUpload.inspect, { tokenHash: await hashApiKey(ticket.token) });
  const uploading = await stock(t);
  expect(uploading.events).toMatchObject([
    { key: `import:${fileId}`, metric: "filesBytes", quantity: 10, state: "reserved" },
  ]);
  expect(uploading.totals).toMatchObject([{ metric: "filesBytes", reserved: 10, committed: 0 }]);
  // A ready account is not rewritten by stock writes.
  expect(uploading.account?.revision).toBeUndefined();
});

it("stock writes raise the account revision only while a recount may be running", async () => {
  const t = await fixture();
  const org = await organization(t, `fnfe_${"m".repeat(43)}`);
  const accountId = await t.run((ctx) =>
    ctx.db.insert("capacityAccounts", {
      organizationId: org.organizationId,
      ready: true,
      phase: 0,
      cursor: null,
      updatedAt: Date.now(),
    }),
  );
  const write = (key: string) =>
    t.run((ctx) => reserveCapacity(ctx, org.organizationId, "filesBytes", key, 5, true));
  await write("ready-1");
  expect((await t.run((ctx) => ctx.db.get("capacityAccounts", accountId)))?.revision).toBe(
    undefined,
  );
  // Not ready: an inventory or recount is in progress and must learn of every stock write.
  await t.run((ctx) => ctx.db.patch("capacityAccounts", accountId, { ready: false }));
  await write("recount-1");
  await write("recount-2");
  expect((await t.run((ctx) => ctx.db.get("capacityAccounts", accountId)))?.revision).toBe(2);
  const total = await t.run((ctx) =>
    ctx.db
      .query("capacityTotals")
      .withIndex("by_organizationId_and_period_and_metric", (q) =>
        q.eq("organizationId", org.organizationId).eq("period", "stock").eq("metric", "filesBytes"),
      )
      .unique(),
  );
  expect(total).toMatchObject({ reserved: 15, committed: 0 });
});

it("concurrent REST admissions of two organizations admit exactly each balance, once per key", async () => {
  const t = await fixture();
  const secrets = [`fnfe_${"j".repeat(43)}`, `fnfe_${"k".repeat(43)}`];
  const orgs = await Promise.all(secrets.map((secret) => organization(t, secret)));
  await assignPlan(t, orgs[0]!.organizationId, 7);
  await assignPlan(t, orgs[1]!.organizationId, 1000);
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, k) =>
      admit(t, secrets[k % 2]!, orgs[k % 2]!.companyId, `key-${k}`),
    ),
  );
  const statuses = responses.map((r) => r.status);
  expect(statuses.filter((s, k) => k % 2 === 0 && s === 200)).toHaveLength(7);
  expect(statuses.filter((s, k) => k % 2 === 0 && s === 429)).toHaveLength(3);
  expect(statuses.filter((s, k) => k % 2 === 1 && s === 200)).toHaveLength(10);
  // A replay of an accepted key returns the same batch and adds nothing.
  const accepted = statuses.findIndex((s, k) => k % 2 === 0 && s === 200);
  const first = (await responses[accepted]!.json()) as { data: { importId: string } };
  const replay = await admit(t, secrets[0]!, orgs[0]!.companyId, `key-${accepted}`);
  expect(((await replay.json()) as { data: { importId: string } }).data.importId).toBe(
    first.data.importId,
  );
  for (const [i, units] of [
    [0, 7],
    [1, 10],
  ] as const) {
    expect(
      await t.run((ctx) => totalFor(ctx, orgs[i]!.organizationId, "sandbox", PERIOD, "imports")),
    ).toMatchObject({ committed: 0, reserved: units });
    // Not `bytes`: `reserveImport` reserves both metrics in one Promise.all, and under concurrent
    // calls convex-test lets the bytes write of a refused admission land after its rollback.
  }
  // Nothing gated by stock, nothing written to it.
  expect((await stock(t)).totals).toHaveLength(0);
});
