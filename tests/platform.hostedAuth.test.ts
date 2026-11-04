import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { api, components, internal } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
import { signAuthRequest } from "../platform/auth-transport";
import { accountPolicy, recipientAllowed } from "../platform/account-policy.mjs";
import { accountSenderName } from "../platform/convex/lib/accountMail";
import { modules } from "./helpers/convex-modules";

const origin = "https://freecorpsnfe-validation.freecorps.workers.dev";
const site = "https://modest-seal-118.convex.site";
const secret = "a".repeat(64);
const email = "controlled@validation.invalid";
const missing = "missing@validation.invalid";
const password = "synthetic-hosted-password-only";
let messages: { to: string[]; text: string }[];
beforeEach(() => {
  messages = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_789_075_210_000);
  for (const [name, value] of Object.entries({
    APP_ENV: "validation",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    WEBHOOK_MODE: "disabled",
    EMAIL_MODE: "cloudflare",
    SITE_URL: origin,
    CONVEX_SITE_URL: site,
    BETTER_AUTH_SECRET: "synthetic-better-auth-secret-not-for-deployment",
    AUTH_PROXY_MODE: "signed",
    AUTH_PROXY_SECRET: secret,
    CLOUDFLARE_EMAIL_API_TOKEN: "synthetic-provider-token-only",
    ACCOUNT_EMAIL_FROM: "sender@validation.invalid",
    ACCOUNT_EMAIL_RECIPIENTS: `${email},${missing}`,
  }))
    vi.stubEnv(name, value);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      messages.push(body);
      return Response.json({
        success: true,
        result: { queued: body.to, delivered: [], permanent_bounces: [] },
      });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}
async function request(
  t: ReturnType<typeof setup>,
  path: string,
  body?: object,
  ip = "203.0.113.1",
  cookie = "",
  requestOrigin = origin,
) {
  const bytes = new TextEncoder().encode(body ? JSON.stringify(body) : "");
  const req = new Request(`${site}/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: requestOrigin,
      "Content-Type": "application/json",
      "Better-Auth-Cookie": cookie,
    },
    ...(body ? { body: bytes } : {}),
  });
  const signature = await signAuthRequest(req, bytes, ip, secret);
  for (const [key, value] of Object.entries(signature)) req.headers.set(key, value);
  return t.fetch(`/api/auth${path}`, {
    method: req.method,
    headers: req.headers,
    ...(body ? { body: bytes } : {}),
  });
}
function code() {
  return messages.at(-1)!.text.match(/\b\d{8}\b/)![0];
}
async function signup(t: ReturnType<typeof setup>) {
  const result = await request(t, "/sign-up/email", { email, password, name: "Controlled test" });
  expect(result.status).toBe(202);
  return code();
}
it("validates controlled configuration and keeps remote credentials out of local worktrees", () => {
  expect(accountPolicy({ EMAIL_MODE: "disabled" }).enabled).toBe(false);
  expect(() => accountPolicy({ EMAIL_MODE: "cloudflare" })).toThrow();
  expect(() =>
    accountPolicy({ EMAIL_MODE: "local", CLOUDFLARE_EMAIL_API_TOKEN: "private" }, true),
  ).toThrow();
  expect(() => accountPolicy({ EMAIL_MODE: "disabled", AUTH_PROXY_SECRET: secret })).toThrow();
});
it("names the sender without Validação only in the installation profile", () => {
  vi.stubEnv("APP_ENV", "installation");
  expect(accountSenderName()).toBe("Freecorps Fiscal");
  vi.stubEnv("APP_ENV", "validation");
  expect(accountSenderName()).toBe("Freecorps Fiscal · Validação");
  vi.unstubAllEnvs();
});
it("lifts the allowlist with * only in the installation profile (#428)", () => {
  const remote = {
    EMAIL_MODE: "cloudflare",
    AUTH_PROXY_MODE: "signed",
    AUTH_PROXY_SECRET: secret,
    CLOUDFLARE_EMAIL_API_TOKEN: "synthetic-provider-token",
    ACCOUNT_EMAIL_FROM: "sender@example.invalid",
    ACCOUNT_EMAIL_RECIPIENTS: "*",
  };
  const open = accountPolicy({ ...remote, APP_ENV: "installation" });
  expect(open.allowedRecipients).toBe("any");
  expect(recipientAllowed(open, "Anyone@Example.invalid")).toBe(true);
  expect(() => accountPolicy({ ...remote, APP_ENV: "validation" })).toThrow();
  expect(() =>
    accountPolicy({
      ...remote,
      ACCOUNT_EMAIL_RECIPIENTS: "*,a@example.invalid",
      APP_ENV: "installation",
    }),
  ).toThrow();
  expect(() =>
    accountPolicy({
      APP_ENV: "installation",
      EMAIL_MODE: "disabled",
      ACCOUNT_EMAIL_RECIPIENTS: "*",
    }),
  ).toThrow();
  const listed = accountPolicy({
    ...remote,
    APP_ENV: "installation",
    ACCOUNT_EMAIL_RECIPIENTS: "a@example.invalid",
  });
  expect(recipientAllowed(listed, "A@example.invalid")).toBe(true);
  expect(recipientAllowed(listed, "b@example.invalid")).toBe(false);
});
it("refuses unsigned calls, forged IPs and foreign origins before creating an account", async () => {
  const t = setup();
  expect(await t.query(api.account.capabilities, {})).toEqual({
    registration: true,
    emailRecovery: true,
    invitationEmail: true,
    emailChange: true,
  });
  const unsigned = await t.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.99",
      "x-fnfe-auth-ip": "203.0.113.99",
    },
    body: JSON.stringify({ email, password, name: "No proxy" }),
  });
  expect(unsigned.status).toBe(403);
  expect(await unsigned.json()).toEqual({ code: "AUTH_PROXY_REQUIRED" });
  expect(
    (
      await request(
        t,
        "/sign-up/email",
        { email, password, name: "Foreign" },
        undefined,
        "",
        "https://foreign.invalid",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(t, "/sign-up/email", {
        email: "outside@validation.invalid",
        password,
        name: "Outside",
      })
    ).status,
  ).toBe(202);
  expect(messages).toHaveLength(0);
  await expect(t.query(internal.mail.inbox, { email })).rejects.toThrow(
    "Local mailbox unavailable",
  );
});
it("atomically limits parallel clients and shares an IPv6 /64 bucket", async () => {
  const t = setup();
  const attempts = await Promise.all(
    Array.from({ length: 12 }, () =>
      request(t, "/sign-in/email", { email, password }, "2001:db8:1:2::1"),
    ),
  );
  expect(attempts.filter((r) => r.status === 401)).toHaveLength(5);
  expect(attempts.filter((r) => r.status === 429)).toHaveLength(7);
  expect(
    (await request(t, "/sign-in/email", { email, password }, "2001:db8:1:2::abcd")).status,
  ).toBe(429);
  expect((await request(t, "/sign-in/email", { email, password }, "2001:db8:1:3::1")).status).toBe(
    401,
  );
  vi.setSystemTime(Date.now() + 61_000);
  expect((await request(t, "/sign-in/email", { email, password }, "2001:db8:1:2::2")).status).toBe(
    401,
  );
});
it.each(["validation", "installation"])(
  "preserva a sessão por sete dias e renova após 24 horas em %s",
  async (environment) => {
    vi.stubEnv("APP_ENV", environment);
    vi.stubEnv("API_URL", "https://api.example.invalid");
    const t = setup();
    const otp = await signup(t);
    expect((await request(t, "/email-otp/verify-email", { email, otp })).status).toBe(200);
    const startedAt = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const login = await request(t, "/sign-in/email", { email, password });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .get("set-better-auth-cookie")!
      .match(/__Secure-better-auth\.session_token=[^;,\s]+/)![0];

    // Voltar à tarde precisa recuperar o login sem renovar antes das 24 horas.
    vi.setSystemTime(startedAt + 8 * 60 * 60 * 1000);
    const afternoon = await (await request(t, "/get-session", undefined, undefined, cookie)).json();
    expect(afternoon?.user.email).toBe(email);
    expect(new Date(afternoon.session.expiresAt).getTime()).toBe(startedAt + 7 * day);
    const actor = t.withIdentity({ subject: afternoon.user.id, sessionId: afternoon.session.id });
    expect(await actor.query(api.account.profile, {})).toMatchObject({ emailVerified: true });

    vi.setSystemTime(startedAt + day);
    const renewedResponse = await request(t, "/get-session", undefined, undefined, cookie);
    const renewed = await renewedResponse.json();
    expect(renewed?.session.id).toBe(afternoon.session.id);
    expect(new Date(renewed.session.expiresAt).getTime()).toBe(startedAt + 8 * day);
    expect(renewedResponse.headers.get("set-better-auth-cookie")).toContain("Max-Age=604800");

    // Sem novo acesso, até a sessão renovada vence e o backend recusa o acesso.
    vi.setSystemTime(startedAt + 8 * day + 1000);
    await expect(actor.query(api.account.profile, {})).rejects.toThrow("UNAUTHENTICATED");
    expect(
      await (await request(t, "/get-session", undefined, undefined, cookie)).json(),
    ).toBeNull();
  },
);

it("verifies, recovers without account enumeration, and revokes the old password and session", async () => {
  const t = setup();
  const otp = await signup(t);
  expect((await request(t, "/sign-in/email", { email, password })).status).toBe(403);
  expect((await request(t, "/email-otp/verify-email", { email, otp })).status).toBe(200);
  expect((await request(t, "/email-otp/verify-email", { email, otp })).status).toBe(400);
  const login = await request(t, "/sign-in/email", { email, password });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .get("set-better-auth-cookie")!
    .match(/__Secure-better-auth\.session_token=[^;,\s]+/)![0];
  const session = await (await request(t, "/get-session", undefined, undefined, cookie)).json();
  const actor = t.withIdentity({ subject: session.user.id, sessionId: session.session.id });
  expect(await actor.query(api.account.profile, {})).toMatchObject({ emailVerified: true });
  const known = await request(t, "/email-otp/request-password-reset", { email });
  const resetCode = code();
  const unknown = await request(t, "/email-otp/request-password-reset", { email: missing });
  expect(known.status).toBe(202);
  expect(unknown.status).toBe(known.status);
  expect(await unknown.json()).toEqual(await known.json());
  expect(messages.some((m) => m.to.includes(missing))).toBe(false);
  const replacement = "replacement-synthetic-hosted-password";
  expect(
    (
      await request(t, "/email-otp/reset-password", {
        email,
        otp: resetCode,
        password: replacement,
      })
    ).status,
  ).toBe(200);
  await expect(actor.query(api.account.profile, {})).rejects.toThrow("UNAUTHENTICATED");
  expect(await (await request(t, "/get-session", undefined, undefined, cookie)).json()).toBeNull();
  expect((await request(t, "/sign-in/email", { email, password })).status).toBe(401);
  expect((await request(t, "/sign-in/email", { email, password: replacement })).status).toBe(200);
});
it("rejects expired codes and reports provider failure without echoing provider data", async () => {
  const t = setup();
  const otp = await signup(t);
  vi.setSystemTime(Date.now() + 601_000);
  expect((await request(t, "/email-otp/verify-email", { email, otp })).status).toBe(400);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("private provider diagnostic with token", { status: 503 })),
  );
  const resend = await request(t, "/email-otp/send-verification-otp", {
    email,
    type: "email-verification",
  });
  expect(resend.status).toBe(202);
  const result = await resend.json();
  expect(result).toEqual({ requestAccepted: true, delivery: "unconfirmed" });
  expect(JSON.stringify(result)).not.toContain("private provider diagnostic");
});
it("limits delivery per recipient across IPs and refuses a removed account", async () => {
  const t = setup();
  const otp = await signup(t);
  expect((await request(t, "/email-otp/verify-email", { email, otp })).status).toBe(200);
  for (let i = 1; i <= 3; i++) {
    const result = await request(
      t,
      "/email-otp/request-password-reset",
      { email },
      `203.0.113.${i}`,
    );
    expect(result.status).toBe(i < 3 ? 202 : 429);
  }
  const login = await request(t, "/sign-in/email", { email, password });
  const cookie = login.headers
    .get("set-better-auth-cookie")!
    .match(/__Secure-better-auth\.session_token=[^;,\s]+/)![0];
  const session = await (await request(t, "/get-session", undefined, undefined, cookie)).json();
  const actor = t.withIdentity({ subject: session.user.id, sessionId: session.session.id });
  await t.mutation(components.betterAuth.adapter.deleteOne, {
    input: { model: "user", where: [{ field: "_id", value: session.user.id }] },
  });
  await expect(actor.query(api.account.profile, {})).rejects.toThrow("UNAUTHENTICATED");
});

it("keeps unverified accounts blocked when mail is disabled and verifies only reserved fixtures internally", async () => {
  const t = setup();
  await signup(t);
  for (const name of [
    "CLOUDFLARE_EMAIL_API_TOKEN",
    "ACCOUNT_EMAIL_FROM",
    "ACCOUNT_EMAIL_RECIPIENTS",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("EMAIL_MODE", "disabled");
  expect((await request(t, "/sign-in/email", { email, password })).status).toBe(403);
  await expect(
    t.action(internal.provision.verifySyntheticAccount, { email: "real@example.com" }),
  ).rejects.toThrow("Synthetic validation email required");
  const fixture = "ci-viewer@validation.invalid";
  await t.action(internal.provision.createTestAccount, {
    email: fixture,
    password,
    name: "CI fixture",
    role: "viewer",
  });
  expect((await request(t, "/sign-in/email", { email: fixture, password })).status).toBe(200);
  expect(messages).toHaveLength(1);
});
it("rejects foreign redirects, exhausted codes and expired hosted sessions", async () => {
  const t = setup();
  const otp = await signup(t);
  for (let i = 1; i <= 3; i++) {
    expect(
      (
        await request(t, "/email-otp/verify-email", {
          email,
          otp: otp === "00000000" ? "99999999" : "00000000",
        })
      ).status,
    ).toBe(400);
  }
  vi.setSystemTime(Date.now() + 61_000);
  expect((await request(t, "/email-otp/verify-email", { email, otp })).status).toBe(400);
  await request(t, "/email-otp/send-verification-otp", { email, type: "email-verification" });
  expect((await request(t, "/email-otp/verify-email", { email, otp: code() })).status).toBe(200);
  expect(
    (
      await request(t, "/sign-in/email", {
        email,
        password,
        callbackURL: "https://foreign.invalid",
      })
    ).status,
  ).toBe(403);
  const login = await request(t, "/sign-in/email", { email, password });
  const cookie = login.headers
    .get("set-better-auth-cookie")!
    .match(/__Secure-better-auth\.session_token=[^;,\s]+/)![0];
  vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000 + 1000);
  expect(await (await request(t, "/get-session", undefined, undefined, cookie)).json()).toBeNull();
});

it.each([
  ["/email-otp/request-password-reset", false],
  ["/email-otp/request-password-reset", true],
  ["/email-otp/send-verification-otp", false],
  ["/email-otp/send-verification-otp", true],
])(
  "does not expose membership or account existence under throttling/provider failure: %s %s",
  async (path, providerFailure) => {
    const t = setup();
    await signup(t);
    vi.setSystemTime(Date.now() + 61_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (providerFailure)
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("private provider details", { status: 503 })),
      );
    for (let attempt = 1; attempt <= 4; attempt++) {
      const results = [];
      for (const candidate of [email, missing, "outside@validation.invalid"]) {
        const response = await request(
          t,
          String(path),
          { email: candidate, type: "email-verification" },
          `203.0.113.${attempt}`,
        );
        results.push({ status: response.status, body: await response.json() });
      }
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);
      expect(results[0].status).toBe(attempt <= 3 ? 202 : 429);
      expect(JSON.stringify(results)).not.toContain("private provider");
      if (attempt <= 3)
        expect(results[0].body).toEqual({ requestAccepted: true, delivery: "unconfirmed" });
    }
    if (providerFailure) expect(warn).toHaveBeenCalledWith("ACCOUNT_EMAIL_UNAVAILABLE");
  },
);
it.each([false, true])(
  "does not disclose signup allowlist membership or claim account creation, provider failure=%s",
  async (providerFailure) => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (providerFailure)
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("private", { status: 503 })),
      );
    const accepted = await request(t, "/sign-up/email", { email, password, name: "Controlled" });
    const denied = await request(t, "/sign-up/email", {
      email: "outside@validation.invalid",
      password,
      name: "Outside",
    });
    expect(accepted.status).toBe(202);
    expect(denied.status).toBe(accepted.status);
    expect(await denied.json()).toEqual(await accepted.json());
    expect(
      await t.query(components.betterAuth.adapter.findOne, {
        model: "user",
        where: [{ field: "email", value: "outside@validation.invalid" }],
      }),
    ).toBeNull();
    expect(messages.some((m) => m.to.includes("outside@validation.invalid"))).toBe(false);
  },
);
it("makes invalid code outcomes generic and disables unused email-link/change flows", async () => {
  const t = setup();
  await signup(t);
  const results = [];
  for (const candidate of [email, missing, "outside@validation.invalid"]) {
    const response = await request(t, "/email-otp/verify-email", {
      email: candidate,
      otp: "invalid-code",
    });
    results.push({ status: response.status, body: await response.json() });
  }
  expect(results[0]).toEqual(results[1]);
  expect(results[1]).toEqual(results[2]);
  expect(results[0].status).toBe(400);
  expect((await request(t, "/send-verification-email", { email })).status).toBe(404);
});
it("records date, time and IP of authenticated access and purges them after six months", async () => {
  const t = setup();
  const otp = await signup(t);
  expect((await request(t, "/email-otp/verify-email", { email, otp })).status).toBe(200);
  const records = () => t.run((ctx) => ctx.db.query("accessRecords").collect());
  expect(
    (await request(t, "/sign-in/email", { email, password: "wrong-synthetic-password" })).status,
  ).toBe(401);
  expect(await records()).toEqual([]);
  const login = await request(t, "/sign-in/email", { email, password }, "203.0.113.7");
  const cookie = login.headers
    .get("set-better-auth-cookie")!
    .match(/__Secure-better-auth\.session_token=[^;,\s]+/)![0];
  const session = await (await request(t, "/get-session", undefined, "203.0.113.7", cookie)).json();
  expect((await request(t, "/convex/token", undefined, "2001:db8::5", cookie)).status).toBe(200);
  const rows = await records();
  expect(rows.map(({ userId, ip, at }) => ({ userId, ip, at }))).toEqual([
    { userId: session.user.id, ip: "203.0.113.7", at: Date.now() },
    { userId: session.user.id, ip: "2001:db8::5", at: Date.now() },
  ]);
  expect(rows[0]!.expiresAt - rows[0]!.at).toBe(184 * 86_400_000);
  expect(await t.run((ctx) => ctx.db.query("accessRetention").collect())).toHaveLength(1);
  vi.setSystemTime(Date.now() + 184 * 86_400_000);
  expect(await t.mutation(internal.accessRecords.sweep, {})).toBe(2);
  expect(await records()).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("accessRetention").collect())).toEqual([]);
});
