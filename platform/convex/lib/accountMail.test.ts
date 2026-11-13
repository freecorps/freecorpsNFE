import { afterEach, expect, it, vi } from "vite-plus/test";
import { createAccountMailProvider, deliverMail } from "./accountMail";
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
const service = {
  provider: "mail" as const,
  apiUrl: "https://mail.development.invalid",
  apiKey: "synthetic-key",
};
const accepted = () => Response.json({ id: "email-1" });
function remote(extra: { siteUrl?: string } = {}) {
  return createAccountMailProvider({
    provider: "remote",
    service,
    from: "sender@development.invalid",
    allowedRecipients: [message.email],
    ...extra,
  });
}
it("renders invitation codes as a distinct purpose without weakening OTP validation", async () => {
  const fetch = vi.fn().mockImplementation(async () => accepted());
  vi.stubGlobal("fetch", fetch);
  const provider = remote();
  await provider.send({ ...message, type: "organization-invitation", otp: "a".repeat(64) });
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toMatchObject({
    subject: "Convite para uma organização na Freecorps Fiscal",
  });
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body).text).toContain("72 horas");
  await expect(provider.send({ ...message, otp: "a".repeat(64) })).rejects.toThrow(
    "Invalid account code",
  );
  await expect(provider.send({ ...message, type: "organization-invitation" })).rejects.toThrow(
    "Invalid account code",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("links the invitation with the code in the fragment, never in the query", async () => {
  const fetch = vi.fn().mockImplementation(async () => accepted());
  vi.stubGlobal("fetch", fetch);
  const provider = remote({ siteUrl: "https://console.development.invalid/ignored/path?x=1" });
  const otp = "b".repeat(64);
  await provider.send({ ...message, type: "organization-invitation", otp });
  const body = JSON.parse(fetch.mock.calls[0]?.[1].body);
  const link = `https://console.development.invalid/accept-invitation#code=${otp}`;
  expect(body.text).toContain(link);
  expect(body.text).toContain(`Seu código de convite: ${otp}`);
  expect(body.html).toContain(`<a href="${link}">`);
  expect(body.text).not.toContain("?code=");
  // Account codes never carry a link.
  await provider.send(message);
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body).text).not.toContain("accept-invitation");
});
it("posts to the mail service with the deployment's key and explicit recipients", async () => {
  const fetch = vi.fn().mockImplementation(async () => accepted());
  vi.stubGlobal("fetch", fetch);
  const provider = remote();
  await provider.send(message);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toBe("https://mail.development.invalid/emails");
  const headers = new Headers(fetch.mock.calls[0]?.[1].headers);
  expect(headers.get("authorization")).toBe("Bearer synthetic-key");
  expect(headers.get("idempotency-key")).toBeTruthy();
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toMatchObject({
    to: [message.email],
    from: '"Freecorps Fiscal · Validação" <sender@development.invalid>',
  });
  await expect(
    provider.send({ ...message, email: "unapproved@development.invalid" }),
  ).rejects.toThrow("not allowed");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("a refusal is rejected; a 5xx or no answer is unavailable, and is never retried", async () => {
  const fetch = vi.fn(async () =>
    Response.json(
      { statusCode: 403, name: "invalid_from_address", message: "no" },
      { status: 403 },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(remote().send(message)).rejects.toThrow("Account email provider rejected delivery");
  fetch.mockImplementation(async () => new Response("private provider body", { status: 503 }));
  await expect(remote().send(message)).rejects.toThrow("Account email provider unavailable");
  fetch.mockImplementation(async () => {
    throw new TypeError("network");
  });
  await expect(remote().send(message)).rejects.toThrow("Account email provider unavailable");
  expect(fetch).toHaveBeenCalledTimes(3);
});
it("refuses to build the remote adapter without a provider", () => {
  expect(() =>
    createAccountMailProvider({
      provider: "remote",
      service: null,
      from: "sender@development.invalid",
      allowedRecipients: [message.email],
    }),
  ).toThrow("requires credentials");
});
it("delivers with the caller's idempotency key on every retry, and tells refused from uncertain", async () => {
  const fetch = vi.fn(async () => new Response("busy", { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  const mail = {
    from: "operacao@development.invalid",
    name: 'Freecorps "Fiscal"\r\n',
    to: ["plantao@development.invalid"],
    subject: "Alerta",
    text: "Texto",
    idempotencyKey: "capture-alert/a1",
  };
  expect(await deliverMail(service, mail, { timeoutMs: 1000, retries: 2 })).toBe("uncertain");
  expect(fetch).toHaveBeenCalledTimes(3);
  const keys = fetch.mock.calls.map((call: any) =>
    new Headers(call[1].headers).get("idempotency-key"),
  );
  expect(new Set(keys)).toEqual(new Set(["capture-alert/a1"]));
  expect(JSON.parse((fetch.mock.calls[0] as any)[1].body).from).toBe(
    '"Freecorps Fiscal" <operacao@development.invalid>',
  );
  fetch.mockImplementation(async () => Response.json({ message: "bad" }, { status: 422 }));
  expect(await deliverMail(service, mail, { timeoutMs: 1000, retries: 2 })).toBe("failed");
  fetch.mockImplementation(async () => accepted());
  expect(await deliverMail(service, mail, { timeoutMs: 1000, retries: 2 })).toBe("sent");
});

const emailSending = {
  provider: "cloudflare" as const,
  accountId: "ffffffffffffffffffffffffffffffff",
  apiKey: "synthetic-key",
};
const cloudflareMail = {
  from: "sender@development.invalid",
  name: "Freecorps Fiscal",
  to: [message.email],
  subject: "Assunto",
  text: "Texto",
};
it("Email Sending: posts to the operator's account and requires the recipient queued, never bounced", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ success: true, result: { queued: [message.email], permanent_bounces: [] } }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await deliverMail(emailSending, cloudflareMail, { timeoutMs: 1000, retries: 0 })).toBe(
    "sent",
  );
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(
    "https://api.cloudflare.com/client/v4/accounts/ffffffffffffffffffffffffffffffff/email/sending/send",
  );
  expect(JSON.parse(init.body as string)).toMatchObject({
    to: [message.email],
    from: { address: "sender@development.invalid", name: "Freecorps Fiscal" },
  });
  for (const [body, outcome] of [
    [
      { success: true, result: { delivered: [message.email], permanent_bounces: [message.email] } },
      "failed",
    ],
    [{ success: true, result: { queued: ["other@development.invalid"] } }, "uncertain"],
    [{ success: false }, "uncertain"],
  ] as const) {
    fetch.mockImplementation(async () => Response.json(body));
    expect(await deliverMail(emailSending, cloudflareMail, { timeoutMs: 1000, retries: 0 })).toBe(
      outcome,
    );
  }
  fetch.mockImplementation(async () => new Response("private provider body", { status: 403 }));
  expect(await deliverMail(emailSending, cloudflareMail, { timeoutMs: 1000, retries: 0 })).toBe(
    "failed",
  );
  fetch.mockImplementation(async () => new Response("x".repeat(32769)));
  expect(await deliverMail(emailSending, cloudflareMail, { timeoutMs: 1000, retries: 0 })).toBe(
    "uncertain",
  );
  // No retry: one call per attempt.
  expect(fetch).toHaveBeenCalledTimes(6);
});
it("Email Sending through the account adapter: codes go out, a refusal throws", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ success: true, result: { queued: [message.email] } }),
  );
  vi.stubGlobal("fetch", fetch);
  const provider = createAccountMailProvider({
    provider: "remote",
    service: emailSending,
    from: "sender@development.invalid",
    allowedRecipients: [message.email],
  });
  await provider.send(message);
  fetch.mockImplementation(async () => new Response("{}", { status: 500 }));
  await expect(provider.send(message)).rejects.toThrow("Account email provider unavailable");
});
