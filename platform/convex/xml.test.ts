import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { validationTarget } from "../../scripts/lib/validation.mjs";
import { processNfe } from "../../packages/fiscal-nfe/src/index";
import { corpus, fixture } from "../../tests/helpers/nfe-corpus";
import { modules } from "../../tests/helpers/convex-modules";
beforeEach(() => {
  for (const [name, value] of Object.entries(validationTarget.environment))
    vi.stubEnv(name, value as string);
});
afterEach(() => vi.unstubAllEnvs());
it.each(corpus.cases)("Node adapter preserves corpus result: $id", async ({ id }) => {
  const bytes = new Uint8Array(fixture(id));
  const result = await convexTest(schema, modules).action(internal.xml.validate, {
    bytes: bytes.buffer,
    evaluatedAt: corpus.evaluatedAt,
  });
  expect(JSON.parse(result.json)).toEqual(
    processNfe(bytes, { source: "synthetic", evaluatedAt: corpus.evaluatedAt }),
  );
});
it("Node adapter preserves the size rejection one byte over 2 MiB", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 1).fill(0x78);
  const result = await convexTest(schema, modules).action(internal.xml.validate, {
    bytes: bytes.buffer,
    evaluatedAt: corpus.evaluatedAt,
  });
  const expected = processNfe(bytes, { source: "synthetic", evaluatedAt: corpus.evaluatedAt });
  expect(expected.checks.parsing.code).toBe("XML_TOO_LARGE");
  expect(JSON.parse(result.json)).toEqual(expected);
});
it("refuses the proof action in a fiscal production environment", async () => {
  vi.stubEnv("FISCAL_ENV", "production");
  await expect(
    convexTest(schema, modules).action(internal.xml.validate, {
      bytes: new Uint8Array(fixture("invoice-signed")).buffer,
      evaluatedAt: corpus.evaluatedAt,
    }),
  ).rejects.toThrow("Invalid platform configuration");
});
