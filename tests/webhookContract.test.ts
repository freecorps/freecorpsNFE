import { createHmac } from "node:crypto";
import { expect, it } from "vite-plus/test";
import vectors from "../packages/contracts/fixtures/webhooks.json";
import {
  signWebhook,
  verifyWebhook,
  type WebhookEnvelope,
} from "../packages/contracts/src/webhooks";
const timestamp = 1_800_000_000_000;
const event: WebhookEnvelope = {
  eventId: "event-73",
  type: "document.updated",
  version: "1",
  occurredAt: timestamp,
  environment: "sandbox",
  companyId: "company-73",
  resource: { type: "document", id: "document-73", version: 2 },
  synthetic: false,
};
const body = new TextEncoder().encode(JSON.stringify(event));
const headers = {
  "x-fnfe-event-id": event.eventId,
  "x-fnfe-delivery-id": "delivery-73",
  "x-fnfe-resource-version": "2",
  "x-fnfe-webhook-version": "1",
};
const secrets = [{ version: 1, secret: "synthetic-secret-73" }];
it("refuses signing key sets that cannot be represented by the verifier's grammar", async () => {
  for (const keys of [[], [1, 2, 3], [1, 1], [0], [-1], [1.5], [1_000_000_000], [NaN]]) {
    await expect(
      signWebhook(
        body,
        headers,
        keys.map((version) => ({ version, secret: "synthetic" })),
        timestamp,
      ),
    ).rejects.toThrow("Invalid signing keys");
  }
  const signed = await signWebhook(
    body,
    headers,
    [{ version: 999_999_999, secret: "synthetic" }],
    timestamp,
  );
  expect(
    await verifyWebhook({
      body,
      headers: { ...signed },
      secrets: [{ version: 999_999_999, secret: "synthetic" }],
      now: timestamp,
    }),
  ).toMatchObject({ ok: true });
});
it.each(vectors)("shared producer/consumer vector: $name", async (vector) => {
  const bytes = new TextEncoder().encode(vector.body);
  if (vector.producer) {
    const { "x-fnfe-signature": _signature, ...unsigned } = vector.headers;
    expect(await signWebhook(bytes, unsigned, vector.secrets, vector.now)).toEqual(vector.headers);
  }
  const result = await verifyWebhook({ ...vector, body: bytes });
  expect(result.ok ? "OK" : result.code).toBe(vector.expected);
});
it("verifies issuance events only with the issuance resource", async () => {
  for (const [type, resource, expected] of [
    ["issuance.authorized", "issuance", "OK"],
    ["issuance.cancellation_rejected", "issuance", "OK"],
    ["issuance.cancelled", "document", "BODY_INVALID"],
    ["document.updated", "issuance", "BODY_INVALID"],
  ] as const) {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ...event, type, resource: { ...event.resource, type: resource } }),
    );
    const signed = await signWebhook(bytes, headers, secrets, timestamp);
    const result = await verifyWebhook({
      body: bytes,
      headers: { ...signed },
      secrets,
      now: timestamp,
    });
    expect(result.ok ? "OK" : result.code).toBe(expected);
  }
});
it("carries data only in connection.history_limited, with the lost NSU range and the role", async () => {
  const connection = { ...event.resource, type: "connection" as const };
  const data = { lost: { from: "000000000000002", to: "000000000000040" }, decidedBy: "owner" };
  for (const [type, payload, expected] of [
    ["connection.history_limited", data, "OK"],
    ["connection.history_limited", undefined, "BODY_INVALID"],
    ["connection.history_limited", { ...data, decidedBy: "admin" }, "BODY_INVALID"],
    ["connection.history_limited", { ...data, lost: { from: "2", to: "40" } }, "BODY_INVALID"],
    [
      "connection.history_limited",
      { ...data, lost: { from: data.lost.to, to: data.lost.from } },
      "BODY_INVALID",
    ],
    ["connection.attention_required", data, "BODY_INVALID"],
    ["connection.attention_required", undefined, "OK"],
  ] as const) {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ...event, type, resource: connection, data: payload }),
    );
    const signed = await signWebhook(bytes, headers, secrets, timestamp);
    const result = await verifyWebhook({
      body: bytes,
      headers: { ...signed },
      secrets,
      now: timestamp,
    });
    expect(result.ok ? "OK" : result.code).toBe(expected);
    if (result.ok) expect(result.event.data).toEqual(payload);
  }
});
it("matches independent Node HMAC over original UTF-8 bytes and the exact headers", async () => {
  const signed = await signWebhook(body, headers, secrets, timestamp);
  const expected = createHmac("sha256", secrets[0]!.secret)
    .update(`${timestamp}.1.1.event-73.delivery-73.2.`)
    .update(body)
    .digest("hex");
  expect(signed["x-fnfe-signature"]).toBe(`t=${timestamp};k=1,v1=${expected}`);
  expect(await verifyWebhook({ body, headers: { ...signed }, secrets, now: timestamp })).toEqual({
    ok: true,
    event,
    deliveryId: "delivery-73",
    secretVersion: 1,
  });
});
it("rejects byte changes, header changes, wrong secrets and timestamps on either side of tolerance", async () => {
  const signed = await signWebhook(body, headers, secrets, timestamp);
  const verify = (overrides: Partial<Parameters<typeof verifyWebhook>[0]>) =>
    verifyWebhook({ body, headers: { ...signed }, secrets, now: timestamp, ...overrides });
  expect(
    await verify({ body: new TextEncoder().encode(JSON.stringify(event, null, 2)) }),
  ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  for (const field of Object.keys(headers))
    expect(
      await verify({ headers: { ...signed, [field]: `${signed[field as keyof typeof signed]}9` } }),
    ).toMatchObject({ ok: false });
  expect(await verify({ secrets: [{ version: 1, secret: "wrong" }] })).toMatchObject({
    ok: false,
    code: "SIGNATURE_INVALID",
  });
  for (const now of [timestamp - 300_001, timestamp + 300_001, NaN])
    expect(await verify({ now })).toMatchObject({ ok: false, code: "TIMESTAMP_INVALID" });
  expect(await verify({ now: timestamp + 300_000 })).toMatchObject({ ok: true });
  expect(
    await verify({ headers: { ...signed, "x-fnfe-signature": "t=nan;k=1,v1=abc" } }),
  ).toMatchObject({ ok: false });
});
it("accepts both keys only inside rotation and signs retries with a fresh timestamp", async () => {
  const keys = [
    { version: 2, secret: "new-synthetic" },
    { ...secrets[0]!, validUntil: timestamp + 1000 },
  ];
  const signed = await signWebhook(body, headers, keys, timestamp);
  for (const secret of keys)
    expect(
      await verifyWebhook({ body, headers: { ...signed }, secrets: [secret], now: timestamp }),
    ).toMatchObject({ ok: true, secretVersion: secret.version });
  expect(
    await verifyWebhook({
      body,
      headers: { ...signed },
      secrets: [keys[1]!],
      now: timestamp + 1000,
    }),
  ).toMatchObject({ ok: false });
  const retry = await signWebhook(body, headers, keys, timestamp + 600_000);
  expect(retry["x-fnfe-signature"]).not.toContain("k=1,");
  expect(
    await verifyWebhook({ body, headers: { ...retry }, secrets: keys, now: timestamp + 600_000 }),
  ).toMatchObject({ ok: true });
  expect(retry["x-fnfe-event-id"]).toBe(signed["x-fnfe-event-id"]);
});
