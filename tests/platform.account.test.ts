/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { api, components, internal } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";

const modules = import.meta.glob("../platform/convex/**/*.ts");
const email = "account@development.invalid";
const password = "synthetic-password-in-local-test";
beforeEach(() => {
  for (const [name, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5182",
    CONVEX_SITE_URL: "http://127.0.0.1:3225",
    BETTER_AUTH_SECRET: "synthetic-secret-for-offline-local-tests-only",
  }))
    vi.stubEnv(name, value);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}
it("replaces the previous local OTP for the same address and purpose", async () => {
  const t = setup();
  await t.mutation(internal.mail.capture, { email, otp: "11111111", type: "email-verification" });
  await t.mutation(internal.mail.capture, { email, otp: "22222222", type: "forget-password" });
  await t.mutation(internal.mail.capture, {
    email: " ACCOUNT@DEVELOPMENT.INVALID ",
    otp: "33333333",
    type: "email-verification",
  });
  const inbox = await t.query(internal.mail.inbox, { email });
  expect(inbox.map((mail) => mail.otp).sort()).toEqual(["22222222", "33333333"]);
  expect(await t.run((ctx) => ctx.db.query("developmentMail").collect())).toHaveLength(2);
});
it("normalizes collector addresses consistently on writes and indexed reads", async () => {
  const t = setup();
  await t.mutation(internal.mail.capture, {
    email: "  Account@Development.Invalid  ",
    otp: "12345678",
    type: "email-verification",
  });
  const inbox = await t.query(internal.mail.inbox, { email });
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({ email, otp: "12345678" });
  expect(await t.query(internal.mail.inbox, { email: " ACCOUNT@DEVELOPMENT.INVALID " })).toEqual(
    inbox,
  );
});
it("preserves independent organization invitations while replacing OTPs", async () => {
  const t = setup();
  for (const otp of ["invitation-one", "invitation-two"])
    await t.mutation(internal.mail.capture, { email, otp, type: "organization-invitation" });
  expect((await t.query(internal.mail.inbox, { email })).map((mail) => mail.otp).sort()).toEqual([
    "invitation-one",
    "invitation-two",
  ]);
});
it("allows only the configured origin for auth GET and credentialed preflight", async () => {
  const t = setup();
  for (const origin of ["http://localhost:5182", "https://foreign.invalid"])
    for (const method of ["GET", "OPTIONS"]) {
      const response = await t.fetch("/api/auth/get-session", {
        method,
        headers: {
          Origin: origin,
          ...(method === "OPTIONS"
            ? {
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "better-auth-cookie",
              }
            : {}),
        },
      });
      if (origin === "http://localhost:5182") {
        expect(response.status).toBeLessThan(400);
        expect(response.headers.get("access-control-allow-origin")).toBe(origin);
        expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      } else expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
});
function post(t: ReturnType<typeof setup>, path: string, body: object) {
  return t.fetch(`/api/auth${path}`, {
    method: "POST",
    headers: {
      Origin: "http://localhost:5182",
      "Content-Type": "application/json",
      "Better-Auth-Cookie": "",
    },
    body: JSON.stringify(body),
  });
}
async function signup(t: ReturnType<typeof setup>) {
  const response = await post(t, "/sign-up/email", { email, password, name: "Conta sintética" });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.token).toBeNull();
  const [message] = await t.query(internal.mail.inbox, { email });
  expect(message.type).toBe("email-verification");
  expect(message.otp).toMatch(/^\d{8}$/);
  return message.otp;
}
it("requires verification, consumes the code once, resets a password and revokes the existing session", async () => {
  const t = setup();
  const otp = await signup(t);
  expect((await post(t, "/sign-in/email", { email, password })).status).toBe(403);
  expect((await post(t, "/email-otp/verify-email", { email, otp: "invalid" })).status).toBe(400);
  expect((await post(t, "/email-otp/verify-email", { email, otp })).status).toBe(200);
  expect((await post(t, "/email-otp/verify-email", { email, otp })).status).toBe(400);
  const login = await post(t, "/sign-in/email", { email, password });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .get("set-better-auth-cookie")
    ?.match(/(?:__Secure-)?better-auth\.session_token=[^;,\s]+/)?.[0];
  expect(cookie).toBeTruthy();
  const session = () =>
    t.fetch("/api/auth/get-session", {
      headers: { Origin: "http://localhost:5182", "Better-Auth-Cookie": cookie! },
    });
  const authenticated = await (await session()).json();
  const client = t.withIdentity({
    subject: authenticated.user.id,
    sessionId: authenticated.session.id,
    issuer: "http://127.0.0.1:3225",
  });
  expect(await client.query(api.account.profile, {})).toEqual({
    name: "Conta sintética",
    emailVerified: true,
    organization: null,
  });
  await expect(client.query(api.access.overview, {})).rejects.toThrow("ACCESS_DENIED");
  const known = await post(t, "/email-otp/request-password-reset", { email });
  const unknown = await post(t, "/email-otp/request-password-reset", {
    email: "missing@development.invalid",
  });
  expect(known.status).toBe(200);
  expect(unknown.status).toBe(known.status);
  expect(await unknown.json()).toEqual(await known.json());
  expect(await t.query(internal.mail.inbox, { email: "missing@development.invalid" })).toEqual([]);
  const reset = (await t.query(internal.mail.inbox, { email })).find(
    (m) => m.type === "forget-password",
  )!;
  const newPassword = "replacement-password-in-local-test";
  expect(
    (await post(t, "/email-otp/reset-password", { email, otp: reset.otp, password: newPassword }))
      .status,
  ).toBe(200);
  expect(await (await session()).json()).toBeNull();
  await expect(client.query(api.account.profile, {})).rejects.toThrow("UNAUTHENTICATED");
  expect(
    (await post(t, "/email-otp/reset-password", { email, otp: reset.otp, password })).status,
  ).toBe(400);
  expect((await post(t, "/sign-in/email", { email, password })).status).toBe(401);
  expect((await post(t, "/sign-in/email", { email, password: newPassword })).status).toBe(200);
});
it("rejects expired codes and prevents mailbox access in a hosted environment", async () => {
  const t = setup();
  const otp = await signup(t);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 11 * 60_000);
  expect((await post(t, "/email-otp/verify-email", { email, otp })).status).toBe(400);
  // The query does not read the clock: the expired code stays listed with its deadline.
  const [expired] = await t.query(internal.mail.inbox, { email });
  expect(expired!.expiresAt).toBeLessThan(Date.now());
  vi.stubEnv("APP_ENV", "validation");
  vi.stubEnv("EMAIL_MODE", "disabled");
  vi.stubEnv("SITE_URL", "https://freecorpsnfe-validation.freecorps.workers.dev");
  await expect(t.query(internal.mail.inbox, { email })).rejects.toThrow(
    "Local mailbox unavailable",
  );
});
it("isolates local databases, checks origins and disables passwordless sign-in", async () => {
  const a = setup(),
    b = setup();
  await signup(a);
  expect(await b.query(internal.mail.inbox, { email })).toEqual([]);
  await expect(a.query(api.account.profile, {})).rejects.toThrow("UNAUTHENTICATED");
  expect((await post(a, "/sign-in/email-otp", { email, otp: "00000000" })).status).toBe(404);
  const foreign = await a.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { Origin: "https://foreign.invalid", "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Foreign" }),
  });
  expect(foreign.status).toBe(403);
  vi.stubEnv("CONVEX_SITE_URL", "https://modest-seal-118.convex.site");
  await expect(a.query(api.account.capabilities, {})).rejects.toThrow("loopback");
});
it("offers registration, recovery, invitations and e-mail change in the local profile, whose mail is captured", async () => {
  expect(await setup().query(api.account.capabilities, {})).toEqual({
    registration: true,
    emailRecovery: true,
    invitationEmail: true,
    emailChange: true,
  });
});
it("allows only one concurrent verification and bounds attempts", async () => {
  const t = setup();
  const otp = await signup(t);
  const attempts = await Promise.all([
    post(t, "/email-otp/verify-email", { email, otp }),
    post(t, "/email-otp/verify-email", { email, otp }),
  ]);
  expect(attempts.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 400]);
  await post(t, "/email-otp/request-password-reset", { email });
  const code = (await t.query(internal.mail.inbox, { email })).find(
    (m) => m.type === "forget-password",
  )!.otp;
  for (let i = 0; i < 3; i++)
    expect(
      (await post(t, "/email-otp/reset-password", { email, otp: "invalid", password })).status,
    ).toBe(400);
  const exhausted = await post(t, "/email-otp/reset-password", { email, otp: code, password });
  expect(exhausted.status).toBe(429);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
  const afterRateWindow = await post(t, "/email-otp/reset-password", {
    email,
    otp: code,
    password,
  });
  expect(afterRateWindow.status).toBe(403);
  expect((await afterRateWindow.json()).code).toBe("TOO_MANY_ATTEMPTS");
});
it("denies removed accounts and expired sessions through the protected profile", async () => {
  const t = setup();
  const otp = await signup(t);
  await post(t, "/email-otp/verify-email", { email, otp });
  const login = await post(t, "/sign-in/email", { email, password });
  const cookie = login.headers
    .get("set-better-auth-cookie")!
    .match(/better-auth\.session_token=[^;,\s]+/)![0];
  const response = await t.fetch("/api/auth/get-session", {
    headers: { Origin: "http://localhost:5182", "Better-Auth-Cookie": cookie },
  });
  const session = await response.json();
  const client = t.withIdentity({ subject: session.user.id, sessionId: session.session.id });
  expect(await client.query(api.account.profile, {})).toMatchObject({ emailVerified: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.now();
  vi.setSystemTime(now + 7 * 24 * 60 * 60 * 1000 + 1000);
  // Past `expiresAt` a mutation refuses. A query does not read the clock, and the JWT it already
  // holds lasts at most 15 minutes (#43); Better Auth issues no new token and drops the row.
  await expect(client.query(api.account.profile, {})).resolves.toMatchObject({
    emailVerified: true,
  });
  await expect(client.mutation(api.account.rename, { name: "Outro nome" })).rejects.toThrow(
    "UNAUTHENTICATED",
  );
  await expect(
    client.action(api.account.requestEmailChange, { email: "outro@development.invalid" }),
  ).rejects.toThrow("UNAUTHENTICATED");
  const expired = await t.fetch("/api/auth/get-session", {
    headers: { Origin: "http://localhost:5182", "Better-Auth-Cookie": cookie },
  });
  expect(await expired.json()).toBeNull();
  await expect(client.query(api.account.profile, {})).rejects.toThrow("UNAUTHENTICATED");
  vi.setSystemTime(now);
  await t.mutation(components.betterAuth.adapter.deleteOne, {
    input: { model: "user", where: [{ field: "_id", value: session.user.id }] },
  });
  await expect(client.query(api.account.profile, {})).rejects.toThrow("UNAUTHENTICATED");
});
