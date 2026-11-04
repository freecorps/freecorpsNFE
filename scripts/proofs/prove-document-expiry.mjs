import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { referenceLocal } from "../lib/reference-local.mjs";
import { worktreePaths } from "../lib/worktree/paths.mjs";
import { readLocalConfig } from "../lib/worktree/deployment.mjs";
import { prepareScope, headers, hash } from "../lib/hosted-fixtures.mjs";

// Native runtime proof, deliberately restricted to this worktree's loopback backend.
const { rpc, urls } = referenceLocal(process.cwd());
const config = readLocalConfig(worktreePaths(process.cwd()));
const h = {
  add: async (table, documents) =>
    assert.equal(
      (await rpc("mutation", "_system/frontend/addDocument", { table, documents })).success,
      true,
    ),
  rows: async (table, index, fields) => {
    const eq = Object.entries(fields)
      .map(([k, v]) => `.eq(${JSON.stringify(k)},${JSON.stringify(v)})`)
      .join("");
    const response = await fetch(`${urls.cloud}/api/run_test_function`, {
      method: "POST",
      headers: { Authorization: `Convex ${config.adminKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        adminKey: config.adminKey,
        args: {},
        format: "json",
        bundle: {
          path: "testQuery.js",
          source: `import {query} from "convex:/_system/repl/wrappers.js"; export default query({handler:async(ctx)=>ctx.db.query(${JSON.stringify(table)}).withIndex(${JSON.stringify(index)},q=>q${eq}).take(2)});`,
        },
      }),
    });
    const result = await response.json();
    assert.equal(result.status, "success");
    return result.value;
  },
};
const scope = await prepareScope(h, `expiry-proof-${randomUUID()}`);
await rpc("mutation", "_system/frontend/patchDocumentsFields", {
  table: "apiKeys",
  ids: [scope.keyId],
  fields: { expiresAt: Date.now() + 3000 },
});
const url = `${urls.site}/v1/documents?companyId=${scope.companyId}&limit=50`;
const before = await fetch(url, { headers: headers(scope) });
assert.equal(before.status, 200);
assert.equal((await before.json()).data.page.length, 0);
await delay(3200);
const after = await fetch(url, { headers: headers(scope) });
assert.equal(after.status, 401);
assert.equal((await after.json()).error.code, "INVALID_API_KEY");
const report = {
  recordedAt: new Date().toISOString(),
  runtime: "native-local",
  url: urls.site,
  result: "passed",
  firstRead: before.status,
  afterClockExpiry: after.status,
  runnerSha256: hash(readFileSync(new URL(import.meta.url))),
  sourceSha256: hash(readFileSync("platform/convex/documentRest.ts")),
  scope:
    "Real HTTP route after warming an indexed empty page, same request/key, wall clock advanced without patching the key or redeploying. No fiscal IO.",
};
mkdirSync(".ci-results/hosted-79-80", { recursive: true });
writeFileSync(".ci-results/hosted-79-80/expiry.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
