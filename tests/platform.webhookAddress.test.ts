import { expect, it } from "vite-plus/test";
import { isPublicWebhookAddress } from "../platform/convex/lib/publicAddress";
import { normalizeWebhookUrl } from "../platform/convex/lib/webhookUrl";

// Regras puras de URL e endereço público de webhook, de platform/convex/lib/.
// O transporte que as aplica fica em tests/webhookTransport.test.ts.
it("normaliza aliases DNS para a mesma URL de destino", () => {
  expect(normalizeWebhookUrl("https://EXAMPLE.com.:443/hook#fragment")).toBe(
    normalizeWebhookUrl("https://example.com/hook"),
  );
});

it.each([
  "0.0.0.0",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.0.0.1",
  "192.0.2.1",
  "192.168.1.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.1",
  "fc00::1",
  "fe80::1",
  "ff02::1",
  "2001:db8::1",
  "2002:7f00:1::",
  "64:ff9b::7f00:1",
  "3fff::1",
  "not-an-ip",
])("bloqueia endereço não público %s", (address) =>
  expect(isPublicWebhookAddress(address)).toBe(false),
);

it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])(
  "permite endereço público %s",
  (address) => expect(isPublicWebhookAddress(address)).toBe(true),
);

it.each([
  "http://example.com",
  "https://localhost",
  "https://localhost.",
  "https://x.local",
  "https://x.internal",
  "https://127.1",
  "https://2130706433",
  "https://0x7f000001",
  "https://[::1]",
  "https://user:password@example.com",
])("cadastro recusa destino %s", (url) => expect(() => normalizeWebhookUrl(url)).toThrow());
