import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inspectTarball } from "../lib/distribution.mjs";
import { sdkTarballPath } from "../lib/sdk-artifact.mjs";
import { signWebhook } from "../../packages/contracts/src/webhooks.ts";

if (!process.versions.bun) throw new Error("Execute com Bun fixado");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const codeSha = git("rev-parse", "HEAD");
const dirty = !!git("status", "--porcelain");
// Never certify an existing tarball by stamping the current checkout's SHA on it.
execFileSync(process.execPath, ["scripts/contracts/build-sdk.mjs"], { stdio: "inherit" });
const consumer = mkdtempSync(join(tmpdir(), "freecorps-sdk-consumer-"));
const tarball = resolve(sdkTarballPath());
inspectTarball(tarball, "@freecorps/freecorpsnfe-sdk");
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "@freecorps/freecorpsnfe-sdk": `file:${tarball.replaceAll("\\", "/")}` },
  }),
);
execFileSync(process.execPath, ["install", "--ignore-scripts"], { cwd: consumer, stdio: "pipe" });
for (const name of ["quickstart.ts", "quickstart-curl.mjs", "sdk-webhook-receiver.mjs"])
  copyFileSync(`examples/${name}`, join(consumer, name));
copyFileSync("packages/contracts/fixtures/webhooks.json", join(consumer, "vectors.json"));
// `connection.history_limited` (#442), the one event with `data`, signed by the producer contract:
// the packaged verifier must return the range, and the example receiver keeps it once.
{
  const now = 1_800_000_000_000;
  const body = JSON.stringify({
    eventId: "event-history-limited",
    type: "connection.history_limited",
    version: "1",
    occurredAt: now,
    environment: "sandbox",
    companyId: "company",
    resource: { type: "connection", id: "connection", version: 7 },
    synthetic: false,
    data: { lost: { from: "000000000000002", to: "000000000000040" }, decidedBy: "owner" },
  });
  const secrets = [{ version: 1, secret: "synthetic-history-limited" }];
  const headers = await signWebhook(
    new TextEncoder().encode(body),
    {
      "x-fnfe-event-id": "event-history-limited",
      "x-fnfe-delivery-id": "delivery-history-limited",
      "x-fnfe-resource-version": "7",
      "x-fnfe-webhook-version": "1",
    },
    secrets,
    now,
  );
  writeFileSync(
    join(consumer, "history-limited.json"),
    JSON.stringify({ body, headers, secrets, now }),
  );
}
writeFileSync(
  join(consumer, "sdk-client.mjs"),
  'export { FreecorpsClient } from "@freecorps/freecorpsnfe-sdk";\n',
);
writeFileSync(
  join(consumer, "verify.mjs"),
  `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyWebhook } from "@freecorps/freecorpsnfe-sdk/webhooks";
import { FreecorpsClient } from "@freecorps/freecorpsnfe-sdk";
import { createReceiver } from "./sdk-webhook-receiver.mjs";
let requests = 0;
const options = { baseUrl: "https://example.invalid", apiKey: "synthetic", environment: "sandbox", maxRetries: 0,
  fetch: async (url, init) => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(init.signal.aborted, false, "Largest supported timeout must not overflow");
    return String(url).includes("document-artifacts") ? new Response("<synthetic/>") :
      Response.json({ data: { id: "import", createdAt: 1, files: [] }, requestId: "timeout-proof" });
  }
};
for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER])
  assert.throws(() => new FreecorpsClient({ ...options, timeoutMs }));
assert.equal(requests, 0);
const sdk = new FreecorpsClient({ ...options, timeoutMs: 2_147_483_647 });
await sdk.call("getImport", { path: { importId: "import" }, query: {}, body: {} });
assert.equal(new TextDecoder().decode(await sdk.downloadOriginal({ artifactId: "artifact", companyId: "company" })), "<synthetic/>");
assert.equal(requests, 2);
const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
let vector = vectors[0], reads = 0;
const client = { async call() { reads++; return { data: { summary: { resourceVersion: vector.body ? JSON.parse(vector.body).resource.version : 3 } } }; } };
const create = () => createReceiver({ database: "receiver.sqlite", secrets: () => vector.secrets, now: () => vector.now, client });
let receiver = create(); const results = [];
for (vector of vectors) {
  const body = new TextEncoder().encode(vector.body);
  const verified = await verifyWebhook({ body, headers: vector.headers, secrets: vector.secrets, now: vector.now });
  assert.equal(verified.ok ? "OK" : verified.code, vector.expected, vector.name);
  const result = await receiver.receive(body, vector.headers);
  assert.equal(result.status, vector.expected === "OK" ? 204 : 400, vector.name);
  results.push({ name: vector.name, code: result.code });
}
assert.deepEqual(results.slice(0,3).map(r=>r.code), ["APPLIED","DUPLICATE","STALE_VERSION"]);
receiver.close(); receiver=create(); vector=vectors[0];
assert.equal((await receiver.receive(new TextEncoder().encode(vector.body),vector.headers)).code,"DUPLICATE");
assert.equal(reads,1); const state=receiver.inspect(); receiver.close();
vector = JSON.parse(readFileSync(new URL("./history-limited.json", import.meta.url), "utf8"));
const lost = { from: "000000000000002", to: "000000000000040" };
const historyBytes = new TextEncoder().encode(vector.body);
const historyVerified = await verifyWebhook({ body: historyBytes, headers: vector.headers, secrets: vector.secrets, now: vector.now });
assert.equal(historyVerified.ok, true, "history_limited");
assert.deepEqual(historyVerified.event.data, { lost, decidedBy: "owner" });
receiver = create();
const historyLimited = [(await receiver.receive(historyBytes, vector.headers)).code, (await receiver.receive(historyBytes, vector.headers)).code];
assert.deepEqual(historyLimited, ["APPLIED", "DUPLICATE"]);
assert.deepEqual(receiver.inspect().historyLimits, [{ ...lost, decidedBy: "owner" }]);
assert.equal(reads, 1, "A connection event reads no document");
receiver.close();
console.log(JSON.stringify({ vectors: results, authenticatedDocumentReads: reads, state, restart: "DUPLICATE", historyLimited: { codes: historyLimited, lost }, timeout: { rejectedBeforeIO: 7, maximum: 2_147_483_647, json: "passed", download: "passed" } }));
`,
);
const stdout = execFileSync("node", ["verify.mjs"], { cwd: consumer, encoding: "utf8" });
writeFileSync(
  join(consumer, "typecheck.ts"),
  `
import { FreecorpsClient } from "@freecorps/freecorpsnfe-sdk";
const client = new FreecorpsClient({ baseUrl: "https://example.invalid", apiKey: "synthetic", environment: "sandbox" });
const result = await client.call("documentItems", { path: { documentId: "doc" }, query: { companyId: "company", versionId: "version" }, body: {} });
const exact: string = result.data.page[0]!.unitPrice;
// @ts-expect-error Monetary values cannot become binary floating point.
const number: number = result.data.page[0]!.unitPrice;
// @ts-expect-error The required version must be provided.
await client.call("documentItems", { path: { documentId: "doc" }, query: { companyId: "company" }, body: {} });
void exact; void number;
`,
);
writeFileSync(
  join(consumer, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      types: [],
      lib: ["ES2023", "DOM", "DOM.Iterable"],
    },
    include: ["typecheck.ts"],
  }),
);
execFileSync(
  process.execPath,
  [resolve("node_modules/typescript/bin/tsc"), "-p", join(consumer, "tsconfig.json")],
  { stdio: "pipe" },
);
const report = {
  codeSha,
  runnerSha: codeSha,
  dirty,
  rebuiltFromCheckout: true,
  result: "passed",
  typecheck: "passed; exact decimals and required version checked from packaged declarations",
  consumer,
  runtime: execFileSync("node", ["--version"], { encoding: "utf8" }).trim(),
  tarballSha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"),
  ...JSON.parse(stdout),
};
const lock = readFileSync(join(consumer, "bun.lock"), "utf8");
assert.ok(
  !/"(?:convex|react(?:-dom)?|better-auth|wrangler|@convex-dev\/[^"/]+|@clerk\/[^"/]+|@cloudflare\/[^"/]+)"/.test(
    lock,
  ),
);
assert.equal(git("rev-parse", "HEAD"), codeSha, "Checkout changed during package proof");
assert.equal(!!git("status", "--porcelain"), dirty, "Checkout changed during package proof");
mkdirSync(".ci-results/74", { recursive: true });
writeFileSync(".ci-results/74/package.json", JSON.stringify(report, null, 2) + "\n");
console.log(`Consumidor independente aprovado: ${report.vectors.length} vetores; ${consumer}`);
