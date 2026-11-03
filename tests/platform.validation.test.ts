/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { internal } from "../platform/convex/_generated/api";
import { validationTarget } from "../scripts/lib/validation.mjs";

const modules = import.meta.glob("../platform/convex/**/*.ts");
const nonce = "a0b1c2d3-1234-4567-89ab-123456789abc";
beforeEach(() => {
  for (const [name, value] of Object.entries(validationTarget.environment))
    vi.stubEnv(name, value as string);
});
afterEach(() => vi.unstubAllEnvs());

it("preserves the same probe on repeat initialization and isolates separate databases", async () => {
  const a = convexTest(schema, modules);
  const b = convexTest(schema, modules);
  const id = await a.mutation(internal.validation.createProbe, { nonce });
  const before = await a.query(internal.validation.readProbe, {});
  expect(
    await a.mutation(internal.validation.createProbe, {
      nonce: "ffffffff-1234-4567-89ab-123456789abc",
    }),
  ).toBe(id);
  expect(await a.query(internal.validation.readProbe, {})).toEqual(before);
  expect(await b.query(internal.validation.readProbe, {})).toBeNull();
});

it.each(["APP_ENV", "PRODUCT_ENV", "FISCAL_ENV", "FNFE_CRONS", "EMAIL_MODE", "WEBHOOK_MODE"])(
  "rejects mutations before writing when %s is misconfigured",
  async (variable) => {
    const t = convexTest(schema, modules);
    vi.stubEnv(variable, "production");
    await expect(t.mutation(internal.validation.createProbe, { nonce })).rejects.toThrow(
      "Invalid platform configuration",
    );
    vi.stubEnv(variable, validationTarget.environment[variable]);
    expect(await t.query(internal.validation.readProbe, {})).toBeNull();
  },
);

it("limits the public HTTP interface to health and reports invalid configuration", async () => {
  const t = convexTest(schema, modules);
  const health = await t.fetch("/health");
  expect(health.status).toBe(200);
  // Unpublished development code must not claim a verified commit.
  expect((await health.json()).sha).toBeNull();
  expect((await t.fetch("/v1/issue", { method: "POST" })).status).toBe(404);
  vi.stubEnv("APP_ENV", "production");
  expect((await t.fetch("/health")).status).toBe(503);
});

it("registers no jobs even if a cron environment variable is accidentally enabled", async () => {
  vi.stubEnv("FNFE_CRONS", "on");
  const { default: crons } = await import("../platform/convex/crons");
  expect(JSON.parse((crons as unknown as { export(): string }).export())).toEqual({});
});
