import { afterEach, expect, it, vi } from "vite-plus/test";
import { createAccountMailProvider } from "../platform/convex/lib/accountMail";
const message = {
  email: "recipient@development.invalid",
  otp: "12345678",
  type: "email-verification" as const,
};
afterEach(() => vi.unstubAllGlobals());
it("uses a local collector without any HTTP and refuses disabled delivery", async () => {
  const capture = vi.fn().mockResolvedValue(null);
  await createAccountMailProvider({ provider: "local", capture }).send(message);
  expect(capture).toHaveBeenCalledWith(message);
  await expect(createAccountMailProvider({ provider: "disabled" }).send(message)).rejects.toThrow(
    "disabled",
  );
});
it("renders invitation codes as a distinct purpose without weakening OTP validation", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ success: true, result: { queued: [message.email] } }));
  vi.stubGlobal("fetch", fetch);
  const provider = createAccountMailProvider({
    provider: "cloudflare",
    apiKey: "synthetic-key",
    from: "sender@development.invalid",
    allowedRecipients: [message.email],
  });
  await provider.send({ ...message, type: "organization-invitation", otp: "a".repeat(64) });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    subject: "Convite para uma organização na Freecorps Fiscal",
  });
  expect(JSON.parse(fetch.mock.calls[0][1].body).text).toContain("72 horas");
  await expect(provider.send({ ...message, otp: "a".repeat(64) })).rejects.toThrow(
    "Invalid account code",
  );
  await expect(provider.send({ ...message, type: "organization-invitation" })).rejects.toThrow(
    "Invalid account code",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("links the invitation with the code in the fragment, never in the query", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(async () =>
      Response.json({ success: true, result: { queued: [message.email] } }),
    );
  vi.stubGlobal("fetch", fetch);
  const provider = createAccountMailProvider({
    provider: "cloudflare",
    apiKey: "synthetic-key",
    from: "sender@development.invalid",
    allowedRecipients: [message.email],
    siteUrl: "https://console.development.invalid/ignored/path?x=1",
  });
  const otp = "b".repeat(64);
  await provider.send({ ...message, type: "organization-invitation", otp });
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  const link = `https://console.development.invalid/accept-invitation#code=${otp}`;
  expect(body.text).toContain(link);
  expect(body.text).toContain(`Seu código de convite: ${otp}`);
  expect(body.html).toContain(`<a href="${link}">`);
  expect(body.text).not.toContain("?code=");
  // Account codes never carry a link.
  await provider.send(message);
  expect(JSON.parse(fetch.mock.calls[1][1].body).text).not.toContain("accept-invitation");
});
it("configures the remote adapter with a fixed endpoint and explicit recipients", async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        result: { queued: [message.email], delivered: [], permanent_bounces: [] },
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const provider = createAccountMailProvider({
    provider: "cloudflare",
    apiKey: "synthetic-key",
    from: "sender@development.invalid",
    allowedRecipients: [message.email],
  });
  await provider.send(message);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(
    "https://api.cloudflare.com/client/v4/accounts/ceccd1846b474bb179054a3c2c4a6185/email/sending/send",
  );
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    to: [message.email],
    from: { address: "sender@development.invalid" },
  });
  await expect(
    provider.send({ ...message, email: "unapproved@development.invalid" }),
  ).rejects.toThrow("not allowed");
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValue(new Response("private provider body", { status: 500 }));
  await expect(provider.send(message)).rejects.toThrow("Account email provider rejected delivery");
});

it.each([
  { success: false },
  { success: true, result: { queued: ["other@development.invalid"] } },
  { success: true, result: { delivered: [message.email], permanent_bounces: [message.email] } },
])("requires recipient acceptance without a permanent bounce", async (body) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body)),
  );
  const provider = createAccountMailProvider({
    provider: "cloudflare",
    apiKey: "synthetic-key",
    from: "sender@development.invalid",
    allowedRecipients: [message.email],
  });
  await expect(provider.send(message)).rejects.toThrow("Account email provider");
});
it("bounds malformed provider responses and does not retry ambiguous delivery", async () => {
  const fetch = vi.fn(async () => new Response("x".repeat(32769)));
  vi.stubGlobal("fetch", fetch);
  const provider = createAccountMailProvider({
    provider: "cloudflare",
    apiKey: "synthetic-key",
    from: "sender@development.invalid",
    allowedRecipients: [message.email],
  });
  await expect(provider.send(message)).rejects.toThrow("response invalid");
  expect(fetch).toHaveBeenCalledTimes(1);
});
