import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";

/**
 * The versioned plan of the NFS-e fiscal production deployment (ADR 0004 §8, #198). It can name
 * no deployment (`null`) or one dedicated deployment, never the shared hosted sandbox nor the
 * validation target: their data and their customers are not fiscal production.
 */
const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
const plan = read("deploy/issuance-production.json") as {
  version: unknown;
  deployment: string | null;
  url: string | null;
  release: Record<string, string> | null;
};
const release = read("deploy/platform-release.json") as { target: { deployment: string } };
const validation = read("platform/validation.json") as { deploymentName: string; url: string };

it("o plano de produção fiscal nomeia nenhum deployment ou um só, dedicado", () => {
  expect(Object.keys(plan).sort((a, b) => a.localeCompare(b))).toEqual([
    "deployment",
    "release",
    "url",
    "version",
  ]);
  expect(plan.version).toBe(1);
  if (plan.deployment === null) {
    expect(plan.url, "url sem deployment").toBeNull();
    // Nothing to publish without a deployment (scripts/lib/issuance-release.mjs).
    expect(plan.release, "release sem deployment").toBeNull();
    return;
  }
  expect(plan.deployment).toMatch(/^[a-z]+-[a-z]+-\d+$/);
  expect(plan.url).toBe(`https://${plan.deployment}.convex.cloud`);
  expect(plan.deployment, "o sandbox hospedado não é produção fiscal").not.toBe(
    release.target.deployment,
  );
  expect(plan.deployment, "o alvo de validação não é produção fiscal").not.toBe(
    validation.deploymentName,
  );
  expect(plan.url).not.toBe(validation.url);
});
