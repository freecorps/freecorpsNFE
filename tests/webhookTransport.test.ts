import { EventEmitter } from "node:events";
import type https from "node:https";
import type { lookup } from "node:dns/promises";
import { it, expect, vi } from "vite-plus/test";
import { postWebhook, retryAfter } from "../platform/convex/lib/webhookNetwork";
function resolver(addresses: string[]) {
  return vi.fn(async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  ) as unknown as typeof lookup;
}
function transport(status = 200) {
  const response = { statusCode: status, headers: { "retry-after": "60" }, destroy: vi.fn() };
  const request = Object.assign(new EventEmitter(), { end: vi.fn() });
  const send = vi.fn((_url, _options, callback) => {
    queueMicrotask(() => callback(response));
    return request;
  });
  return { request, send: send as unknown as typeof https.request, spy: send, response };
}
it.each([
  "127.0.0.1",
  "10.0.0.1",
  "169.254.169.254",
  "100.100.100.200",
  "172.16.0.1",
  "192.168.1.1",
  "::1",
  "::ffff:127.0.0.1",
  "fe80::1",
  "fc00::1",
  "2001:db8::1",
])("rejects internal and reserved DNS %s before opening a socket", async (address) => {
  const t = transport();
  await expect(
    postWebhook(
      "https://receiver.example.com/",
      "{}",
      {},
      { resolve: resolver([address]), request: t.send },
    ),
  ).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  expect(t.spy).not.toHaveBeenCalled();
});
it.each([
  "http://receiver.example.com",
  "https://receiver.example.com:8443",
  "https://user:pass@receiver.example.com",
  "https://127.0.0.1",
  "https://metadata.internal",
  "https://receiver.example.com/?secret=x",
])("rejects unsafe URL %s", async (url) => {
  const t = transport();
  await expect(
    postWebhook(url, "{}", {}, { resolve: resolver(["93.184.216.34"]), request: t.send }),
  ).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  expect(t.spy).not.toHaveBeenCalled();
});
it("pins the DNS address to the socket, keeps TLS verification, refuses mixed DNS and never follows redirects", async () => {
  const t = transport(302),
    resolve = resolver(["93.184.216.34"]);
  const result = await postWebhook(
    "https://receiver.example.com/",
    '{"ação":1}',
    {},
    { resolve, request: t.send },
  );
  expect(result.status).toBe(302);
  expect(t.spy).toHaveBeenCalledTimes(1);
  const options = t.spy.mock.calls[0]![1];
  expect(options).toMatchObject({
    agent: false,
    rejectUnauthorized: true,
    servername: "receiver.example.com",
  });
  const callback = vi.fn();
  options.lookup("receiver.example.com", {}, callback);
  expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(t.request.end).toHaveBeenCalledWith('{"ação":1}');
  await expect(
    postWebhook(
      "https://receiver.example.com/",
      "{}",
      {},
      { resolve: resolver(["93.184.216.34", "127.0.0.1"]), request: t.send },
    ),
  ).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  // A new connection resolves again; a DNS change cannot reuse yesterday's approval.
  await expect(
    postWebhook(
      "https://receiver.example.com/",
      "{}",
      {},
      { resolve: resolver(["127.0.0.1"]), request: t.send },
    ),
  ).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  expect(t.spy).toHaveBeenCalledTimes(1);
});
it("bounds Retry-After seconds and HTTP dates and rejects malformed dates", () => {
  const now = 1_800_000_000_000;
  expect(retryAfter("60", now)).toBe(now + 60_000);
  expect(retryAfter(new Date(now + 60_000).toUTCString(), now)).toBe(now + 60_000);
  expect(retryAfter("9999999999999", now)).toBe(now + 86400_000);
  expect(retryAfter("-1", now)).toBeUndefined();
  expect(retryAfter("nonsense", now)).toBeUndefined();
});
