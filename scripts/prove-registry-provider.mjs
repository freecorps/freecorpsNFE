import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { lookupOpenCnpj } from "../platform/convex/lib/registryProvider.ts";

// Explicit standalone online proof. Does not seed a database or store source payloads.
const report = {
  observedAt: new Date().toISOString(),
  codeSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
  adapterSha256: createHash("sha256")
    .update(readFileSync(new URL("../platform/convex/lib/registryProvider.ts", import.meta.url)))
    .digest("hex"),
  provider: "opencnpj",
  environment: "public-provider-read-only",
  results: [],
};
for (const cnpj of ["00000000000191", "00000000E08G12"]) {
  const requests = [];
  const result = await lookupOpenCnpj(cnpj, async (url, init) => {
    const response = await fetch(url, init);
    requests.push({
      url: url instanceof Request ? url.url : String(url),
      status: response.status,
      date: response.headers.get("date"),
      cacheControl: response.headers.get("cache-control"),
    });
    return response;
  });
  report.results.push({
    cnpj,
    status: result.status,
    requests,
    sourceUpdatedAt: null,
    normalizedSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    hasName: Boolean(result.data?.name),
    hasAddress: Boolean(result.data?.address.street),
    storedRawPayload: false,
  });
}
mkdirSync(".ci-results/registry", { recursive: true });
writeFileSync(".ci-results/registry/provider.json", JSON.stringify(report, null, 2) + "\n");
for (const result of report.results) assert.equal(result.status, "found", result.cnpj);
console.log("OpenCNPJ: numeric and alphanumeric live lookups passed; sanitized receipt saved.");
