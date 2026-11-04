import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { measureAfter, scenarios } from "../../tests/helpers/document-footprint";
import { usePlatformEnvironment } from "../../tests/helpers/platform";

/**
 * The footprint per note after phase B of ADR 0010, beside the baseline of B1
 * (`document-footprint.json`). With FNFE_FOOTPRINT_WRITE=1 it rewrites
 * docs/v1.0/evidence/642/document-footprint-after.json.
 */
usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-footprint-secret",
});

it("measures each note after the cleanup and compares it with the baseline", async () => {
  const baseline = JSON.parse(
    readFileSync(
      new URL("../../docs/v1.0/evidence/642/document-footprint.json", import.meta.url),
      "utf8",
    ),
  ) as { scenarios: { id: string; documentBytesPerNote: number; allTablesBytesPerNote: number }[] };
  const scenariosAfter = [];
  for (const scenario of scenarios()) {
    const after = await measureAfter(scenario);
    const before = baseline.scenarios.find((s) => s.id === scenario.id)!;
    // Every version with a blob lost its inline copy, and the document tables shrank.
    expect(after.clearedVersions).toBe(Math.round(after.versionsPerNote * after.notes));
    expect(after.documentBytesPerNote).toBeLessThan(before.documentBytesPerNote);
    scenariosAfter.push({
      ...after,
      before: {
        documentBytesPerNote: before.documentBytesPerNote,
        allTablesBytesPerNote: before.allTablesBytesPerNote,
      },
      documentRatio: Number((after.documentBytesPerNote / before.documentBytesPerNote).toFixed(3)),
    });
  }
  const report = {
    format: "document-footprint-after/1",
    sizeMethod: "getDocumentSize de convex/values, IDs de 32 caracteres, sem índices",
    environment: "sandbox (convex-test)",
    baseline: "document-footprint.json (B1)",
    scenarios: scenariosAfter,
  };
  if (process.env.FNFE_FOOTPRINT_WRITE === "1")
    writeFileSync(
      new URL("../../docs/v1.0/evidence/642/document-footprint-after.json", import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
}, 180_000);
