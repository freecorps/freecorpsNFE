import { expect, it } from "vite-plus/test";
import { internal } from "../_generated/api";
import { MAX_DOCUMENT_CONTENT_BYTES } from "../lib/documentContent";
import {
  headroomCode,
  headroomVerdict,
  CAP,
} from "../../../scripts/lib/document-headroom-proof.mjs";
import { platformTest, usePlatformEnvironment } from "../../../tests/helpers/platform";

usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-headroom-proof",
});

it("stores past-cap content, reads it in both runtimes and removes the blob", async () => {
  const t = platformTest();
  for (const shape of ["wide", "many"] as const) {
    const size = 64 * 1024;
    const ref = await t.action(internal.testing.documentHeadroomNode.store, { size, shape });
    expect(ref.contentSize).toBeLessThanOrEqual(size);
    expect(ref.contentSize).toBeGreaterThan(size - 16 * 1024);
    for (const path of [
      internal.testing.documentHeadroomNode.read,
      internal.testing.documentHeadroomProof.read,
    ]) {
      const value = JSON.parse(await t.action(path, { ref }));
      expect(value).toMatchObject({ contentSize: ref.contentSize, items: ref.items });
    }
    // A wrong hash is refused, never read as content.
    await expect(
      t.action(internal.testing.documentHeadroomProof.read, {
        ref: { ...ref, contentSha256: "0".repeat(64) },
      }),
    ).rejects.toThrow("DOCUMENT_CONTENT_CORRUPT");
    await t.mutation(internal.testing.documentHeadroomProof.remove, { storageId: ref.storageId });
    await expect(t.action(internal.testing.documentHeadroomProof.read, { ref })).rejects.toThrow(
      "BLOB_MISSING",
    );
  }
});

it("judges the margin by the smallest Node shape and the concurrent reads at the cap", () => {
  expect(CAP).toBe(MAX_DOCUMENT_CONTENT_BYTES);
  const passed = (runtime: string, shape: string, mib: number) => ({
    runtime,
    shape,
    size: mib * 1024 * 1024,
    outcome: "passed",
  });
  const rows = [
    passed("node", "wide", 32),
    passed("node", "many", 24),
    passed("v8", "wide", 8),
    { runtime: "node", shape: "wide", concurrent: 4, passed: 4 },
    { runtime: "v8", shape: "wide", concurrent: 4, passed: 1 },
  ];
  expect(headroomVerdict(rows)).toMatchObject({ nodeFactor: 3, passed: true });
  expect(headroomVerdict([...rows.slice(0, 1), passed("node", "many", 16)]).passed).toBe(false);
  expect(
    headroomVerdict([...rows, { runtime: "node", shape: "many", concurrent: 4, passed: 3 }]).passed,
  ).toBe(false);
  expect(headroomCode("JavaScript execution ran out of memory (maximum memory usage: 64 MB)")).toBe(
    "OUT_OF_MEMORY",
  );
  expect(headroomCode("Uncaught ConvexError: secret-looking text")).toBe("PROOF_CALL_FAILED");
});
