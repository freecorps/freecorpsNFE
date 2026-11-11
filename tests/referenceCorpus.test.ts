import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import manifest from "./fixtures/references/1.0/manifest.json";
import { parseReferencePayload, sha256 } from "../platform/convex/lib/referenceDataset";
import { referenceValidity } from "../packages/contracts/src/references";

it.each(manifest.files)("reproduz a origem, os hashes e a vigência de $file", async (file) => {
  const payload = readFileSync(
    new URL(`./fixtures/references/1.0/${file.file}`, import.meta.url),
    "utf8",
  );
  expect(await sha256(payload)).toBe(file.sha256);
  const data = await parseReferencePayload(payload);
  expect(data.manifest.redistribution).toBe("synthetic");
  expect(data.entries).toHaveLength(file.expected.count);
  expect(referenceValidity(data.entries[0], data.manifest, "2026-09-22")).toBe(
    file.expected.firstCodeOn20260922,
  );
  expect(referenceValidity(data.entries[1], data.manifest, "2026-09-22")).toBe(
    file.expected.secondCodeOn20260922,
  );
});
