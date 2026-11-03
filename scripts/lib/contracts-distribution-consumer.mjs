import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { membershipRoles, formatCnpj, webhookEvents } from "@freecorps/contracts";
import { apiVersion, exactDecimal } from "@freecorps/contracts/external";
import { membershipRoles as roles } from "@freecorps/contracts/organizations";
import { referenceDataset } from "@freecorps/contracts/references";
import { registryLookup } from "@freecorps/contracts/registry";
import { verifyWebhook } from "@freecorps/contracts/webhooks";

assert.equal(apiVersion, "8.0.0");
assert.deepEqual(roles, membershipRoles);
assert.ok(webhookEvents.includes("document.received"));
assert.equal(formatCnpj("11222333000181"), "11.222.333/0001-81");
assert.ok(exactDecimal.safeParse("1.10").success);
assert.ok(referenceDataset.safeParse("ncm").success);
assert.equal(typeof registryLookup.parse, "function");
const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
for (const vector of vectors) {
  const result = await verifyWebhook({
    body: new TextEncoder().encode(vector.body),
    headers: vector.headers,
    secrets: vector.secrets,
    now: vector.now,
  });
  assert.equal(result.ok ? "OK" : result.code, vector.expected, vector.name);
}
console.log(JSON.stringify({ apiVersion, subpaths: 6, webhookVectors: vectors.length }));
