import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { signWebhook } from "../packages/contracts/src/webhooks.ts";
import { createWebhookReceiver } from "../examples/webhook-receiver.mjs";
const vectors = JSON.parse(
  readFileSync(new URL("../packages/contracts/fixtures/webhooks.json", import.meta.url), "utf8"),
);
mkdirSync(".ci-results/73", { recursive: true });
const database = `.ci-results/73/contract-${crypto.randomUUID()}.sqlite`;
let vector = vectors[0];
const create = () =>
  createWebhookReceiver({ database, secrets: () => vector.secrets, clock: () => vector.now });
let receiver = create();
const results = [];
for (vector of vectors) {
  const bytes = new TextEncoder().encode(vector.body);
  if (vector.producer) {
    const { "x-fnfe-signature": _signature, ...headers } = vector.headers;
    assert.deepEqual(await signWebhook(bytes, headers, vector.secrets, vector.now), vector.headers);
  }
  const result = await receiver.receive(bytes, vector.headers);
  assert.equal(result.status, vector.expected === "OK" ? 204 : 400, vector.name);
  if (vector.expected !== "OK") assert.equal(result.code, vector.expected, vector.name);
  results.push({ name: vector.name, ...result });
}
assert.deepEqual(
  results.slice(0, 3).map((r) => r.code),
  ["APPLIED", "DUPLICATE", "STALE_VERSION"],
);
receiver.close();
receiver = create();
vector = vectors[0];
assert.equal(
  (await receiver.receive(new TextEncoder().encode(vector.body), vector.headers)).code,
  "DUPLICATE",
);
const state = receiver.inspect();
assert.deepEqual(state, { events: 2, resources: [{ version: 3, effects: 1 }] });
receiver.close();
writeFileSync(
  ".ci-results/73/contract-receiver.json",
  JSON.stringify({ result: "passed", vectors: results, restart: "DUPLICATE", state }, null, 2) +
    "\n",
);
console.log(
  `${vectors.length} shared vectors passed; duplicate, out-of-order and restart preserve one business effect.`,
);
