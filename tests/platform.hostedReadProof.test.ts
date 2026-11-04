import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import { register } from "../platform/test-setup";
import schema from "../platform/convex/schema";
import { internal } from "../platform/convex/_generated/api";
import { requirePlatformEnvironment } from "../platform/convex/environment";
import { modules } from "./helpers/convex-modules";

// The throwaway preview of the pre-B5 read evaluation: no platform profile, only the marker.
const preview = {
  FNFE_HOSTED_PROOF: "preview-642",
  FNFE_CRONS: "off",
  FISCAL_ENV: "disabled",
  CONVEX_CLOUD_URL: "https://happy-otter-123.convex.cloud",
  CONVEX_SITE_URL: "https://happy-otter-123.convex.site",
};
const platformNames = [
  "APP_ENV",
  "PRODUCT_ENV",
  "SITE_URL",
  "API_URL",
  "WEBHOOK_MODE",
  "EMAIL_MODE",
  "BETTER_AUTH_SECRET",
  "AUTH_PROXY_MODE",
];
beforeEach(() => {
  for (const name of platformNames) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(preview)) vi.stubEnv(name, value);
});
afterEach(() => vi.unstubAllEnvs());

const prepare = (t: ReturnType<typeof convexTest>) =>
  t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "a".repeat(64),
    suffix: "content642-hosted",
  });

it("opens only the read evaluation functions on the marked preview, never the platform", async () => {
  const t = convexTest(schema, modules);
  expect(await prepare(t)).toMatchObject({ organizationId: expect.any(String) });
  expect(await t.action(internal.testing.coldArchiveProof.store, { xml: "<synthetic/>" })).toEqual(
    expect.any(String),
  );
  // Other local proofs keep the loopback gate, and the platform refuses the marker.
  await expect(t.query(internal.testing.restoreProof.assertEmpty, {})).rejects.toThrow(
    "Invalid platform configuration: FNFE_HOSTED_PROOF",
  );
  expect(() => requirePlatformEnvironment()).toThrow(
    "Invalid platform configuration: FNFE_HOSTED_PROOF",
  );
});

it("refuses the marker with a platform profile, credentials, crons, fiscal transport or another host", async () => {
  for (const [name, value] of [
    ["FNFE_HOSTED_PROOF", "yes"],
    ["FNFE_CRONS", undefined],
    ["FISCAL_ENV", "homologation"],
    ["CONVEX_CLOUD_URL", "http://127.0.0.1:3210"],
    ["CONVEX_CLOUD_URL", "https://convex.operator.invalid"],
    ["APP_ENV", "development"],
    ["APP_ENV", "installation"],
    ["BETTER_AUTH_SECRET", "x".repeat(32)],
    ["FNFE_CAPTURE_TRANSPORT", "sefaz"],
    ["FNFE_ISSUANCE_ENV", "production"],
  ] as const) {
    vi.stubEnv(name, value);
    await expect(prepare(convexTest(schema, modules))).rejects.toThrow(
      "Local synthetic proof only",
    );
    vi.stubEnv(name, name in preview ? preview[name as keyof typeof preview] : undefined);
  }
  expect(await prepare(convexTest(schema, modules))).toMatchObject({
    companyId: expect.any(String),
  });
});

it("publishes and reads a synthetic version through the B4 scheduler without any platform profile", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    // Publication queues the content writer in its pool (`scheduleVersionContent`).
    register(t);
    const { keyId: _key, ...ids } = await prepare(t);
    const storageId = await t.action(internal.testing.coldArchiveProof.store, {
      xml: "<synthetic/>",
    });
    const seeded = await t.mutation(internal.testing.documentContentProof.seed, {
      ...ids,
      storageId,
      model: "nfse",
    });
    await t.mutation(internal.importProcessing.published, { operationId: seeded.operationId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const read = JSON.parse(
      await t.action(internal.testing.documentReadProof.read, {
        versionId: seeded.versionId,
        inline: false,
      }),
    );
    expect(read.source).toBe("blob");
  } finally {
    vi.useRealTimers();
  }
});
