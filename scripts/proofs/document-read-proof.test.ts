import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vite-plus/test";
import { loadReadFixtures } from "../lib/document-read-proof.mjs";

const matrix = () =>
  ["invoice", "service-invoice-batch", ...Array<string>(3).fill("service-invoice")].map(
    (kind, index) => ({
      model: kind === "invoice" ? "55" : "nfse",
      kind,
      content: {
        result: JSON.stringify({ document: { kind, number: String(index) }, documentCount: 3 }),
        items: [],
        ...(kind === "invoice" ? { fiscalEvidence: "{}", snapshot: "{}" } : {}),
      },
    }),
  );

it("accepts the complete matrix and rejects empty, partial, duplicate and malformed fixtures before backend calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-proof-"));
  const path = join(dir, "fixtures.json");
  const source = await readFile("scripts/proofs/prove-document-content-local.mjs", "utf8");
  try {
    await writeFile(path, JSON.stringify(matrix()));
    expect(await loadReadFixtures(path)).toHaveLength(5);
    const duplicate = matrix();
    duplicate[4] = duplicate[3];
    const noEvidence = matrix();
    delete noEvidence[0].content.snapshot;
    for (const input of [[], matrix().slice(1), duplicate, noEvidence, {}, "private.invalid"]) {
      await writeFile(path, JSON.stringify(input));
      let calls = 0;
      let failed = false;
      // Execute the actual CLI preparation block, with all backend calls intercepted.
      const start = source.indexOf("try {\n  const fixtures");
      const end = source.indexOf("report.passed = !failed;");
      await runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
        reading: true,
        process: { argv: ["", "", "3250", "--read", path] },
        loadReadFixtures,
        call: () => {
          calls++;
          throw new Error("UNEXPECTED_BACKEND_CALL");
        },
        report: {},
        get failed() {
          return failed;
        },
        set failed(value: boolean) {
          failed = value;
        },
      });
      expect(failed).toBe(true);
      expect(calls).toBe(0);
      await expect(loadReadFixtures(path)).rejects.toThrow("READ_FIXTURES_INVALID");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
