import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decimal } from "@freecorps/fiscal-core";
import { FreecorpsClient } from "@freecorps/freecorpsnfe-sdk";
import { verifyWebhook } from "@freecorps/freecorpsnfe-sdk/webhooks";

assert.equal(decimal("12.3456789012").coefficient, "123456789012");
assert.equal(
  typeof new FreecorpsClient({
    baseUrl: "https://example.invalid",
    apiKey: "synthetic",
    environment: "sandbox",
    fetch: () => {
      throw new Error("Network is forbidden in this proof");
    },
  }).call,
  "function",
);
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
console.log(
  JSON.stringify({ runtime: process.version, vectors: vectors.length, exactDecimal: "passed" }),
);
