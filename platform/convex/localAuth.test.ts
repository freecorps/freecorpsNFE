import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import schema from "./schema";
import { components, internal } from "./_generated/api";
import { register } from "../test-setup";
import { modules } from "../../tests/helpers/convex-modules";

const origin = "http://localhost:5182";
const minute = 1_800_000_000_000;
const routes = ["/get-session", "/convex/token", "/convex/jwks"];
const email = "session@development.invalid";
const password = "synthetic-local-session-password";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(minute + 1000);
  for (const [name, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: origin,
    CONVEX_SITE_URL: "http://127.0.0.1:3225",
    BETTER_AUTH_SECRET: "synthetic-local-auth-secret-for-tests-only",
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
function request(t: ReturnType<typeof setup>, route: string, cookie = "", body?: object) {
  return t.fetch(`/api/auth${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Better-Auth-Cookie": cookie,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function sessions(t: ReturnType<typeof setup>, count = 1) {
  expect((await request(t, "/sign-up/email", "", { email, password, name: "Teste" })).status).toBe(
    200,
  );
  const [mail] = await t.query(internal.mail.inbox, { email });
  expect((await request(t, "/email-otp/verify-email", "", { email, otp: mail.otp })).status).toBe(
    200,
  );
  const cookies: string[] = [];
  for (let i = 0; i < count; i++) {
    const login = await request(t, "/sign-in/email", "", { email, password });
    expect(login.status).toBe(200);
    cookies.push(
      login.headers.get("set-better-auth-cookie")!.match(/better-auth\.session_token=[^;,\s]+/)![0],
    );
  }
  expect(new Set(cookies).size).toBe(count);
  return cookies;
}

it("renews four authenticated sessions continuously across fixed windows without a second limiter", async () => {
  const t = setup();
  const cookies = await sessions(t, 4);
  for (let i = 0; i < 45; i++) {
    vi.setSystemTime(minute + 1000 + i * 3000);
    for (const route of routes) {
      const response = await request(t, route, cookies[i % cookies.length]);
      expect(response.status).toBe(200);
      const body = await response.json();
      if (route === "/get-session") expect(body.user.email).toBe(email);
      else if (route === "/convex/jwks") expect(body.keys.length).toBeGreaterThan(0);
      else expect(body.token).toEqual(expect.any(String));
    }
  }
  const oldCounters = await t.query(components.betterAuth.adapter.findMany, {
    model: "rateLimit",
    paginationOpts: { numItems: 100, cursor: null },
  });
  expect(
    oldCounters.page.filter((row: { key: string }) =>
      routes.some((route) => row.key.includes(route)),
    ),
  ).toEqual([]);
});

it.each(routes)(
  "atomically admits 30 shared requests to %s and recovers at the boundary despite traffic",
  async (route) => {
    const t = setup();
    const cookies = await sessions(t, 4);
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        t.fetch(`/api/auth${route}${i % 2 ? "?refresh=true" : ""}`, {
          headers: {
            Origin: origin,
            "Better-Auth-Cookie": cookies[i % 4],
            "x-forwarded-for": `192.0.2.${i + 1}`,
          },
        }),
      ),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(30);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(10);
    const denied = responses.find((r) => r.status === 429)!;
    expect(denied.headers.get("Retry-After")).toBe("59");
    expect(denied.headers.get("X-Retry-After")).toBe("59");
    expect((await request(t, `${route}/`, cookies[0])).status).toBe(429);
    // A separate route still has its own budget.
    expect(
      (
        await request(
          t,
          routes.find((candidate) => candidate !== route)!,
          cookies[0],
        )
      ).status,
    ).toBe(200);
    for (const elapsed of [30_000, 59_999]) {
      vi.setSystemTime(minute + elapsed);
      expect((await request(t, route, cookies[0])).status).toBe(429);
    }
    vi.setSystemTime(minute + 60_000);
    for (let i = 0; i < 30; i++) expect((await request(t, route, cookies[i % 4])).status).toBe(200);
    expect((await request(t, route, cookies[0])).status).toBe(429);
  },
);

it("does not charge preflight and does not authenticate absent, revoked or expired sessions", async () => {
  const t = setup();
  const [revoked, expired] = await sessions(t, 2);
  for (let i = 0; i < 35; i++) {
    const response = await t.fetch("/api/auth/get-session", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "better-auth-cookie",
      },
    });
    expect(response.status).toBeLessThan(400);
  }
  expect((await request(t, "/get-session", revoked)).status).toBe(200);
  expect((await request(t, "/sign-out", revoked, {})).status).toBe(200);
  for (const cookie of ["", revoked]) {
    expect(await (await request(t, "/get-session", cookie)).json()).toBeNull();
    expect((await request(t, "/convex/token", cookie)).status).toBe(401);
  }
  vi.setSystemTime(minute + 7 * 24 * 60 * 60 * 1000 + 2000);
  expect(await (await request(t, "/get-session", expired)).json()).toBeNull();
  expect((await request(t, "/convex/token", expired)).status).toBe(401);
});

it("preserves login and OTP inactivity windows when the session minute turns", async () => {
  const t = setup();
  vi.setSystemTime(minute + 59_000);
  for (let i = 0; i < 5; i++)
    expect((await request(t, "/sign-in/email", "", { email, password })).status).toBe(401);
  for (let i = 0; i < 3; i++)
    expect(
      (await request(t, "/email-otp/verify-email", "", { email, otp: "00000000" })).status,
    ).toBe(400);
  vi.setSystemTime(minute + 60_000);
  expect((await request(t, "/sign-in/email", "", { email, password })).status).toBe(429);
  expect((await request(t, "/email-otp/verify-email", "", { email, otp: "00000000" })).status).toBe(
    429,
  );
  vi.setSystemTime(minute + 120_000);
  expect((await request(t, "/sign-in/email", "", { email, password })).status).toBe(401);
  expect((await request(t, "/email-otp/verify-email", "", { email, otp: "00000000" })).status).toBe(
    400,
  );
});
