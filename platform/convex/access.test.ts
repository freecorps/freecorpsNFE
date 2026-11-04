import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import schema from "./schema";
import { api, components, internal } from "./_generated/api";
import { register } from "../test-setup";
import { validationTarget } from "../../scripts/lib/validation.mjs";
import { modules } from "../../tests/helpers/convex-modules";

beforeEach(() => {
  for (const [name, value] of Object.entries(validationTarget.environment))
    vi.stubEnv(name, value as string);
  vi.stubEnv("CONVEX_SITE_URL", validationTarget.siteUrl);
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-secret-used-only-in-isolated-tests");
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
it("rejects the sixth failed password login through the real HTTP router", async () => {
  // Keep all six attempts in one fixed window, regardless of the CI wall clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = 1_789_075_210_000;
  vi.setSystemTime(now);
  const t = setup();
  const login = () =>
    t.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        Origin: validationTarget.consoleUrl,
        "Content-Type": "application/json",
        "X-Forwarded-For": "192.0.2.46",
      },
      body: JSON.stringify({
        email: "unknown@validation.invalid",
        password: "synthetic-invalid-password",
      }),
    });
  for (let attempt = 1; attempt <= 6; attempt++) {
    const response = await login();
    expect(response.status).toBe(attempt <= 5 ? 401 : 429);
    if (attempt === 6) expect(Number(response.headers.get("x-retry-after"))).toBeGreaterThan(0);
  }
  vi.setSystemTime(now + 61_000);
  expect((await login()).status).toBe(401);
  const session = await t.fetch("/api/auth/get-session", {
    headers: { Origin: validationTarget.consoleUrl, "X-Forwarded-For": "192.0.2.46" },
  });
  expect(session.status).toBe(200);
});
async function identity(
  t: ReturnType<typeof setup>,
  role?: "operator" | "viewer",
  expired = false,
) {
  const now = Date.now();
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Test account",
        email: `test-${crypto.randomUUID()}@validation.invalid`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        expiresAt: now + (expired ? -1000 : 3600_000),
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  if (role) await t.mutation(internal.access.grant, { authUserId: user._id, role });
  return {
    client: t.withIdentity({
      subject: user._id,
      sessionId: session._id,
      issuer: validationTarget.siteUrl,
    }),
    sessionId: session._id,
  };
}
it("enforces operator, viewer and missing grant on the server", async () => {
  const t = setup();
  const operator = await identity(t, "operator");
  const viewer = await identity(t, "viewer");
  const outsider = await identity(t);
  await expect(t.query(api.access.overview, {})).rejects.toThrow("UNAUTHENTICATED");
  await expect(operator.client.query(api.access.overview, {})).resolves.toMatchObject({
    role: "operator",
  });
  // The server reports only what it checks; fiscal integrations are released per company (#625).
  await expect(operator.client.query(api.access.diagnostics, {})).resolves.toEqual({
    persistentRecordPresent: false,
  });
  await expect(viewer.client.query(api.access.overview, {})).resolves.toMatchObject({
    role: "viewer",
  });
  await expect(viewer.client.query(api.access.diagnostics, {})).rejects.toThrow("ACCESS_DENIED");
  await expect(outsider.client.query(api.access.overview, {})).rejects.toThrow("ACCESS_DENIED");
  await expect(outsider.client.query(api.access.diagnostics, {})).rejects.toThrow("ACCESS_DENIED");
  await expect(t.query(api.access.diagnostics, {})).rejects.toThrow("UNAUTHENTICATED");
});
it("rejects expired and revoked sessions even with an authenticated Convex identity", async () => {
  const t = setup();
  const expired = await identity(t, "operator", true);
  const active = await identity(t, "operator");
  await expect(expired.client.query(api.access.overview, {})).rejects.toThrow("UNAUTHENTICATED");
  await t.mutation(components.betterAuth.adapter.deleteOne, {
    input: { model: "session", where: [{ field: "_id", value: active.sessionId }] },
  });
  await expect(active.client.query(api.access.session, {})).resolves.toBeNull();
  await expect(active.client.query(api.access.overview, {})).rejects.toThrow("UNAUTHENTICATED");
});
it("does not accept a user ID supplied by the caller", async () => {
  const t = setup();
  await expect(
    t.query(api.access.overview, { authUserId: "someone-else" } as never),
  ).rejects.toThrow();
});
it("rejects public signup and unrelated origins on the actual HTTP router", async () => {
  const t = setup();
  const signup = await t.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: validationTarget.consoleUrl },
    body: JSON.stringify({
      email: "blocked@validation.invalid",
      password: "synthetic-password-for-test",
      name: "Blocked",
    }),
  });
  expect(signup.status).toBe(400);
  const cors = await t.fetch("/api/auth/get-session", {
    method: "OPTIONS",
    headers: { Origin: "https://untrusted.invalid", "Access-Control-Request-Method": "GET" },
  });
  expect(cors.headers.get("Access-Control-Allow-Origin")).not.toBe("https://untrusted.invalid");
  const trusted = await t.fetch("/api/auth/get-session", {
    method: "OPTIONS",
    headers: { Origin: validationTarget.consoleUrl, "Access-Control-Request-Method": "GET" },
  });
  expect(trusted.headers.get("Access-Control-Allow-Origin")).toBe(validationTarget.consoleUrl);
});
