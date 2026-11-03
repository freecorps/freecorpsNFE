import { writeFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { footprint, measure, scenarios } from "./helpers/document-footprint";
import { usePlatformEnvironment } from "./helpers/platform";

/**
 * Baseline of the database footprint per note before phase B of ADR 0010. With
 * FNFE_FOOTPRINT_WRITE=1 it rewrites the receipt in docs/v1.0/evidence/642/.
 */
usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-footprint-secret",
});

it("measures each synthetic note through the real import and fits bytes per item", async () => {
  const report = await footprint();
  const byId = Object.fromEntries(report.scenarios.map((s) => [s.id, s]));
  for (const items of [1, 5, 20]) {
    const nfe = byId[`nfe-${items}`]!;
    // A summary, then the authorized procNFe of the same key: one note, two versions.
    expect(nfe).toMatchObject({ notes: 1, versionsPerNote: 2 });
    expect(nfe.tables.documentItems!.rows).toBe(items);
    expect(nfe.movable.gzipBytesPerNote).toBeLessThan(nfe.movable.rawBytesPerNote);
    expect(nfe.residualDocumentBytesPerNote).toBeLessThan(nfe.documentBytesPerNote);
  }
  expect(byId["nfse-single"]!.notes).toBe(1);
  expect(byId["nfse-batch-20"]!.notes).toBe(20);
  const { fixed, perItem } = report.regression.nfeDocumentTables;
  expect(perItem).toBeGreaterThan(0);
  // The fit reproduces the 20-item note within 1%.
  expect(Math.abs(fixed + 20 * perItem - byId["nfe-20"]!.documentBytesPerNote)).toBeLessThan(
    byId["nfe-20"]!.documentBytesPerNote / 100,
  );
  if (process.env.FNFE_FOOTPRINT_WRITE === "1")
    writeFileSync(
      new URL("../docs/v1.0/evidence/642/document-footprint.json", import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
}, 120_000);

it("repeats the same bytes for the same note", async () => {
  const [scenario] = scenarios();
  expect(await measure(scenario!)).toEqual(await measure(scenario!));
}, 60_000);
