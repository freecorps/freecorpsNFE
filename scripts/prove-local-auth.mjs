import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { worktreePaths } from "./lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "./lib/worktree/deployment.mjs";
import { currentLocalSiteUrl } from "./lib/worktree/env-file.mjs";
import { assertLinkedWorktree } from "./lib/worktree/state.mjs";

const paths = worktreePaths();
assertLinkedWorktree(paths);
assert.equal(paths.app, "platform");
const config = readLocalConfig(paths),
  urls = localUrls(config);
const origin = currentLocalSiteUrl(paths);
assert.ok(origin && new URL(origin).hostname === "localhost");
const output = join(paths.root, ".ci-results/95");
mkdirSync(output, { recursive: true });
const label = process.argv[2] ?? "before";
assert.ok(["before", "after"].includes(label));
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const report = {
  codeSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
  runnerSha256: hash(new URL(import.meta.url)),
  authSourceSha256: hash(new URL("../platform/convex/auth.ts", import.meta.url)),
  authRequestSourceSha256: hash(new URL("../platform/convex/lib/authRequest.ts", import.meta.url)),
  fixedLimiterSourceSha256: hash(
    new URL("../platform/node_modules/@convex-dev/rate-limiter/src/shared.ts", import.meta.url),
  ),
  limiterSourceSha256: hash(
    new URL(
      "../platform/node_modules/better-auth/dist/api/rate-limiter/index.mjs",
      import.meta.url,
    ),
  ),
  environment: "anonymous-local",
  cloud: urls.cloud,
  origin,
  result: "running",
  observations: [],
};
const routes = ["/convex/token", "/get-session"];
const fixedConfig = { kind: "fixed window", rate: 30, period: 60_000, capacity: 30, start: 0 };
async function rpc(path, args, extra = {}) {
  const response = await fetch(`${urls.cloud}/api/${extra.componentPath ? "function" : "query"}`, {
    method: "POST",
    headers: { Authorization: `Convex ${config.adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json", ...extra }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  assert.equal(body.status, "success", `Local query ${path} failed`);
  return body.value;
}
async function counters() {
  if (label === "after")
    return Promise.all(
      routes.map(async (route) => {
        const value = await rpc(
          "lib:getValue",
          { name: "local-auth-session", key: `/api/auth${route}`, config: fixedConfig },
          { componentPath: "rateLimiter" },
        );
        return { route, remaining: value.value, windowStart: value.ts };
      }),
    );
  const data = await rpc(
    "adapter:findMany",
    { model: "rateLimit", paginationOpts: { numItems: 100, cursor: null } },
    { componentPath: "betterAuth" },
  );
  return data.page
    .filter((row) => row.key.includes("get-session") || row.key.includes("convex/token"))
    .map((row) => ({
      route: row.key.includes("convex/token") ? "convex/token" : "get-session",
      count: row.count,
      lastRequest: row.lastRequest,
    }));
}
async function request(path, cookie, body) {
  const response = await fetch(`${urls.site}/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Better-Auth-Cookie": cookie ?? "",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  return response;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function assertAuthenticated(response, route, email) {
  const body = await response.json();
  if (route === "/get-session") {
    assert.equal(body?.user?.email, email, "Session must still identify the synthetic account");
    assert.ok(body?.session?.id, "Session must be present");
  } else {
    assert.ok(typeof body?.token === "string", "Renewal must return a JWT");
    // Exercise the token against the real protected Convex query, without saving it.
    const profile = await fetch(`${urls.cloud}/api/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${body.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "account:profile", args: {}, format: "json" }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await profile.json();
    report.protectedProfiles ??= [];
    report.protectedProfiles.push({
      at: Date.now(),
      status: profile.status,
      authenticated: result.status === "success" && result.value?.emailVerified === true,
    });
    assert.equal(result.status, "success", "Renewed JWT must authenticate the protected profile");
    assert.equal(result.value?.emailVerified, true, "Protected profile must be verified");
  }
}
async function proveBurstAndRecovery(sessions, email) {
  // Align to a fresh server window, never reset or manipulate the stored budget.
  const serverNow = await rpc("lib:getServerTime", {}, { componentPath: "rateLimiter" });
  await pause(60_000 - (serverNow % 60_000) + 250);
  report.burst = {};
  for (const route of routes) {
    const startedAt = Date.now();
    const results = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const response = await request(route, sessions[i % sessions.length]);
        const result = {
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
          xRetryAfter: response.headers.get("x-retry-after"),
        };
        await response.arrayBuffer();
        return result;
      }),
    );
    report.burst[route] = { startedAt, elapsedMs: Date.now() - startedAt, results };
    assert.equal(
      results.filter((r) => r.status === 200).length,
      30,
      "Burst must admit exactly 30 requests per route",
    );
    assert.equal(
      results.filter((r) => r.status === 429).length,
      10,
      "Burst must reject exactly 10 requests per route",
    );
    assert.ok(
      results
        .filter((r) => r.status === 429)
        .every(
          (r) =>
            Number(r.retryAfter) >= 1 &&
            Number(r.retryAfter) <= 60 &&
            r.retryAfter === r.xRetryAfter,
        ),
      "429 must expose the remaining window",
    );
  }
  report.burstCounters = await counters();
  assert.ok(
    report.burstCounters.every((c) => c.remaining === 0),
    "Burst must consume both persistent budgets",
  );
  const window = report.burstCounters[0].windowStart;
  assert.ok(
    report.burstCounters.every((c) => c.windowStart === window),
    "Both bursts must fit in one window",
  );
  report.recovery = [];
  // Keep requesting through the boundary: recovery cannot rely on inactivity.
  const pending = new Set(routes);
  const deadline = Date.now() + 65_000;
  while (pending.size && Date.now() < deadline) {
    await pause(3000);
    for (const route of pending) {
      const response = await request(route, sessions[0]);
      report.recovery.push({
        route,
        at: Date.now(),
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
      });
      if (response.status === 200) {
        await assertAuthenticated(response, route, email);
        pending.delete(route);
      } else {
        assert.equal(
          response.status,
          429,
          "Exhausted session route must return 429 until the next window",
        );
        await response.arrayBuffer();
      }
    }
  }
  assert.equal(pending.size, 0, "Both routes must recover with continuous requests");
  report.recoveryCounters = await counters();
  assert.ok(
    report.recoveryCounters.every((c) => c.windowStart === window + 60_000 && c.remaining === 29),
    "Recovery must happen in the next fixed window with a full budget",
  );
}
try {
  assert.deepEqual(await rpc("_system/frontend/listCronJobs", {}), []);
  console.log("Waiting 65 seconds before setup to isolate prior local auth traffic");
  await pause(65000);
  const email = `local-auth-${crypto.randomUUID()}@development.invalid`,
    password = `test-${crypto.randomUUID()}`;
  assert.equal(
    (await request("/sign-up/email", null, { email, password, name: "Diagnóstico local" })).status,
    200,
  );
  const mail = await rpc("mail:inbox", { email });
  assert.equal(
    (
      await request("/email-otp/verify-email", null, {
        email,
        otp: mail.find((m) => m.type === "email-verification").otp,
      })
    ).status,
    200,
  );
  const sessions = [];
  for (let i = 0; i < 4; i++) {
    const login = await request("/sign-in/email", null, { email, password });
    assert.equal(login.status, 200, "Synthetic login");
    const cookie = login.headers
      .get("set-better-auth-cookie")
      ?.match(/(?:__Secure-)?better-auth\.session_token=[^;,\s]+/)?.[0];
    assert.ok(cookie, "Expected synthetic session cookie");
    sessions.push(cookie);
  }
  assert.equal(new Set(sessions).size, 4, "Distinct authenticated sessions");
  report.before = await counters();
  const started = Date.now();
  for (let i = 0; i < (label === "after" ? 45 : 32); i++) {
    if (i) await pause(3000);
    const statuses = {};
    for (const route of routes) {
      const response = await request(route, sessions[i % sessions.length]);
      statuses[route] = response.status;
      if (response.status === 200) await assertAuthenticated(response, route, email);
      else await response.arrayBuffer();
    }
    report.observations.push({
      sequence: i + 1,
      elapsedMs: Date.now() - started,
      statuses,
      counters: await counters(),
    });
    if (i % 8 === 0 || Object.values(statuses).includes(429))
      console.log(JSON.stringify({ sequence: i + 1, elapsedMs: Date.now() - started, statuses }));
  }
  if (label === "after") await proveBurstAndRecovery(sessions, email);
  console.log("Waiting 65 seconds without session traffic to measure recovery");
  await pause(65000);
  report.afterIdle = {};
  for (const route of ["/convex/token", "/get-session"])
    report.afterIdle[route] = (await request(route, sessions[0])).status;
  report.countersAfterIdle = await counters();
  report.loginBudget = [];
  for (let i = 0; i < 6; i++)
    report.loginBudget.push((await request("/sign-in/email", null, { email, password })).status);
  report.otpBudget = [];
  for (let i = 0; i < 4; i++)
    report.otpBudget.push(
      (await request("/email-otp/verify-email", null, { email, otp: "00000000" })).status,
    );
  assert.deepEqual(
    report.loginBudget,
    [200, 200, 200, 200, 200, 429],
    "Local login limit unchanged",
  );
  assert.deepEqual(report.otpBudget, [400, 400, 400, 429], "Local OTP limit unchanged");
  if (label === "after") {
    const jwks = await rpc(
      "lib:getValue",
      { name: "local-auth-session", key: "/api/auth/convex/jwks", config: fixedConfig },
      { componentPath: "rateLimiter" },
    );
    report.jwksCounter = { remaining: jwks.value, windowStart: jwks.ts };
    assert.ok(
      jwks.ts > 0 && jwks.value < 30,
      "Protected queries must exercise the fixed-window JWKS budget",
    );
  }
  assert.ok(
    Object.values(report.afterIdle).every((status) => status === 200),
    "Session must recover after idle",
  );
  assert.ok(
    report.observations.every((item) =>
      Object.values(item.statuses).every((status) => status === 200),
    ),
    "Continuous session traffic was rate limited",
  );
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failure = error instanceof assert.AssertionError ? error.message : "Local proof failed";
  process.exitCode = 1;
} finally {
  writeFileSync(join(output, `${label}.json`), JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      result: report.result,
      failure: report.failure,
      requests: report.observations.length,
      afterIdle: report.afterIdle,
    }),
  );
}
