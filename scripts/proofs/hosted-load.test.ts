import { execFileSync } from "node:child_process";
import { it, expect } from "vite-plus/test";
import {
  loadTargets,
  remainingLoadTargets,
  runtimeUsage,
  assessLoad,
  adoptRevision,
} from "../lib/hosted-load.mjs";

it("requires an explicit previous revision and the same target before preserving a synthetic dataset", () => {
  const previousSha = "a".repeat(40),
    publishedSha = "b".repeat(40);
  const identity = {
    health: { sha: publishedSha },
    frontend: { sha: publishedSha },
    target: { deploymentName: "modest-seal-118" },
  };
  const state = {
    identity: { ...identity, health: { sha: previousSha } },
    scopes: [{ seeded: 5000 }],
  };
  const next = adoptRevision(state, identity, previousSha);
  expect(next.scopes).toEqual(state.scopes);
  expect(next.revisions[0]).toMatchObject({ previousSha, publishedSha });
  expect(state.identity.health.sha).toBe(previousSha);
  expect(() => adoptRevision(state, identity, undefined)).toThrow();
  expect(() => adoptRevision(state, identity, "c".repeat(40))).toThrow();
  expect(() => adoptRevision(state, state.identity, previousSha)).toThrow();
  expect(() =>
    adoptRevision(state, { ...identity, target: { deploymentName: "other" } }, previousSha),
  ).toThrow();
  expect(() =>
    adoptRevision(state, { ...identity, frontend: { sha: previousSha } }, previousSha),
  ).toThrow();
});

it("does not approve missing rounds, quota refusals, server errors or slow successful responses", () => {
  const observations = ["metadata", "acceptance"].flatMap((kind) =>
    [1, 2, 3].map((round) => ({
      name: `${kind}-10000-round-${round}`,
      concurrent: 20,
      requests: kind === "metadata" ? 100 : 20,
      statuses: { 200: kind === "metadata" ? 100 : 20 } as Record<number, number>,
      p95Ms: kind === "metadata" ? 800 : 1000,
    })),
  );
  expect(assessLoad(observations, [10000]).passed).toBe(true);
  expect(assessLoad(observations.slice(1), [10000]).passed).toBe(false);
  expect(assessLoad([...observations, observations[0]], [10000]).passed).toBe(false);
  expect(assessLoad(observations, [10000, 100000]).passed).toBe(false);
  expect(assessLoad([], []).passed).toBe(false);
  for (const status of [429, 503]) {
    const failed = structuredClone(observations);
    failed[3]!.statuses = { 200: 19, [status]: 1 };
    expect(assessLoad(failed, [10000]).rounds[3]).toMatchObject({
      complete: true,
      allSuccessful: false,
      withinLatency: true,
      passed: false,
    });
  }
  const slow = structuredClone(observations);
  slow[0]!.p95Ms = 801;
  expect(assessLoad(slow, [10000]).rounds[0]).toMatchObject({
    complete: true,
    allSuccessful: true,
    withinLatency: false,
    passed: false,
  });
  slow[3]!.p95Ms = 2400;
  const pilot = { metadata: 1200, acceptance: 2500 };
  expect(assessLoad(slow, [10000], pilot).passed).toBe(true);
  expect(assessLoad(slow, [10000]).passed).toBe(false);
  expect(assessLoad(slow.slice(1), [10000], pilot).passed).toBe(false);
  slow[3]!.statuses = { 200: 19, 503: 1 };
  expect(assessLoad(slow, [10000], pilot).passed).toBe(false);
  expect(() => assessLoad(slow, [10000], { ...pilot, acceptance: Infinity })).toThrow();
});

it("requires an explicit hosted load size before credentials or network access", () => {
  let stderr = "";
  try {
    execFileSync(
      process.execPath,
      [
        "scripts/proofs/prove-hosted-operations.mjs",
        "missing-private-credential.json",
        "load",
        "missing-private-state.json",
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
  } catch (error) {
    stderr = String((error as { stderr: string }).stderr);
  }
  expect(stderr).toContain("--max-documents");
  expect(stderr).not.toContain("ENOENT");
});

it("limits seed and measurement scales, including resumed asymmetric batches", () => {
  const small = loadTargets(["--max-documents", "10000"]);
  const large = loadTargets(["--max-documents", "100000"]);
  expect(remainingLoadTargets(small, [{ seeded: 1 }, { seeded: 1 }])).toEqual([10000]);
  expect(remainingLoadTargets(large, [{ seeded: 1 }, { seeded: 1 }])).toEqual([10000, 100000]);
  expect(remainingLoadTargets(large, [{ seeded: 6000 }, { seeded: 1 }])).toEqual([100000]);
  expect(() => remainingLoadTargets(small, [{ seeded: 50000 }, { seeded: 50000 }])).toThrow(
    "--max-documents",
  );
  expect(() => remainingLoadTargets(small, [])).toThrow();
  expect(() => remainingLoadTargets(small, [{ seeded: -1 }, { seeded: 1 }])).toThrow();
  for (const args of [[], ["--max-documents", "1000000"], ["--max-documents", "NaN"], ["100000"]]) {
    expect(() => loadTargets(args)).toThrow("--max-documents");
  }
});

it("includes administrative seed and test-query IO in totals without mixing API metrics", () => {
  const result = runtimeUsage([
    { identifier: "_system/frontend/addDocument", usageStats: { databaseWriteBytes: 2000 } },
    { identifier: "testQuery", usageStats: { databaseReadBytes: 1790 } },
    { identifier: "documentRest:dispatch", usageStats: { databaseReadBytes: 10 } },
    { identifier: "worker:run", componentPath: "workpool", occRetries: 1 },
    { identifier: "worker:run", componentPath: "workpool", occRetries: 2 },
  ]);
  expect(result.total).toMatchObject({
    calls: 5,
    readBytes: 1800,
    writeBytes: 2000,
    observedRetryAttempts: 2,
  });
  expect(Object.keys(result.application)).toEqual([
    "root/documentRest:dispatch",
    "workpool/worker:run",
  ]);
  expect(Object.keys(result.administration)).toEqual([
    "root/_system/frontend/addDocument",
    "root/testQuery",
  ]);
  expect(result.administration["root/testQuery"]).toMatchObject({ readBytes: 1790, writeBytes: 0 });
  expect(runtimeUsage([]).total).toMatchObject({ calls: 0, readBytes: 0, writeBytes: 0 });
});
