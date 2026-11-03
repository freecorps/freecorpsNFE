// Runs apps/console/e2e/m0.mjs offline: Playwright and axe resolve to fakes, fetch answers as the
// published validation revision. Only the values typed into the page are recorded.
import { register } from "node:module";

register(new URL("./hooks.mjs", import.meta.url));

const sha = process.env.VALIDATION_E2E_SHA;
const answers = {
  "/build.json": { sha, environment: "validation" },
  "/health": {
    sha,
    status: "ok",
    appEnv: "validation",
    productEnv: "sandbox",
    fiscalEnv: "disabled",
    issuanceEnv: "disabled",
  },
  "/api/query": { status: "error" },
};
// With M0_FAKE_SHELL=1, the backend answers the fake browser's session (see playwright.mjs): the
// token names the role, accepted until the page signs out.
const session = (globalThis.m0FakeSession ??= { role: null, signedOut: false });
function convexQuery(options) {
  const { path } = JSON.parse(options.body);
  const role = /^Bearer fake-jwt:(\w+)$/.exec(options.headers?.Authorization ?? "")?.[1];
  const valid = role && role === session.role && !session.signedOut;
  if (path === "access:overview" && valid && role !== "none")
    return { status: "success", value: { role, environment: "validation" } };
  if (path === "access:diagnostics" && valid && role === "operator")
    return { status: "success", value: {} };
  return { status: "error" };
}
globalThis.fetch = async (url, options = {}) => {
  const pathname = new URL(url).pathname;
  const answer =
    process.env.M0_FAKE_SHELL === "1" && pathname === "/api/query"
      ? convexQuery(options)
      : answers[pathname];
  if (!answer) throw new Error("Unexpected request in the offline M0 run");
  return new Response(JSON.stringify(answer), { status: 200 });
};
