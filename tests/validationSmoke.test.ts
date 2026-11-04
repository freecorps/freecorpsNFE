import { expect, it, vi } from "vite-plus/test";
import { smokeCredentials, smokeValidation } from "../scripts/lib/validation-smoke.mjs";
import { publishRevision } from "../scripts/lib/validation-deploy.mjs";
import {
  smokeFailureDetails,
  sanitizeSmokeDiagnostic,
  smokeRequestId,
} from "../scripts/lib/smoke-diagnostic.mjs";
import { proveSmokeDiagnostics, proveSmokeSummary } from "../scripts/validation/prove-smoke-diagnostics.mjs";

it("distinguishes controlled failures through the real smoke and publication paths", async () => {
  const results = await proveSmokeDiagnostics();
  expect(results).toHaveLength(25);
  expect(
    proveSmokeSummary(results.find((result) => result.scenario === "primary-and-cleanup")!.receipt),
  ).toMatchObject({ result: "passed" });
});

it("rejects untrusted diagnostics, oversized identifiers and known credentials", () => {
  const unsafe = {
    phase: "secret",
    service: "secret",
    code: "secret",
    httpStatus: 999,
    expectedSha: "secret",
    observedSha: "x".repeat(10000),
    requestId: "x".repeat(10000),
    payload: "secret",
    cookie: "secret",
  };
  expect(sanitizeSmokeDiagnostic(unsafe)).toEqual({
    phase: "smoke",
    service: "unknown",
    code: "UNKNOWN",
  });
  expect(smokeFailureDetails(Object.assign(new Error("secret"), { diagnostic: unsafe }))).toEqual({
    diagnostic: { phase: "smoke", service: "unknown", code: "UNKNOWN" },
  });
  const id = "12345678-1234-4234-8234-123456789abc";
  expect(smokeRequestId(new Headers({ "x-request-id": id }), [id])).toBeUndefined();
  expect(smokeRequestId(new Headers({ "cf-ray": "abcdef1234567890-GRU" }))).toBe(
    "abcdef1234567890-GRU",
  );
});

const sha = "a".repeat(40);
const credentials = { email: "viewer@validation.invalid", password: "synthetic-password-only" };
function responses() {
  return [
    Response.json({ sha, environment: "validation" }),
    Response.json({
      sha,
      status: "ok",
      appEnv: "validation",
      productEnv: "sandbox",
      fiscalEnv: "disabled",
      issuanceEnv: "disabled",
    }),
    new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html" } }),
    new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html" } }),
    Response.json(
      {},
      {
        headers: {
          "Set-Better-Auth-Cookie":
            "__Secure-better-auth.session_token=synthetic-session; Path=/; Secure; HttpOnly, other=value; Path=/",
        },
      },
    ),
    Response.json({ token: "synthetic-jwt" }),
    Response.json({
      status: "success",
      value: { status: "authorized", environment: "validation", role: "viewer" },
    }),
    Response.json({ success: true }),
    Response.json({ status: "error" }),
  ];
}

it("preserves the smoke failure through the publication receipt without remote secrets", async () => {
  const pending = responses();
  pending[4] = new Response("private credentials and cookies", {
    status: 401,
    headers: { "x-request-id": "12345678-1234-4234-8234-123456789abc" },
  });
  const record = vi.fn();
  const noop = async () => {};
  await expect(
    publishRevision(
      sha,
      {
        preflight: noop,
        build: noop,
        eligible: async () => true,
        backend: noop,
        frontend: noop,
        probe: async () => ({ key: "persistence-v1", nonce: "synthetic" }),
        smoke: () => smokeValidation(sha, credentials, async () => pending.shift()!),
      },
      record,
    ),
  ).rejects.toThrow("state=partial");
  expect(record.mock.lastCall?.[0]).toMatchObject({
    state: "partial",
    phase: "smoke",
    diagnostic: {
      phase: "login",
      service: "auth",
      code: "AUTH_FAILED",
      httpStatus: 401,
      expectedSha: sha,
      requestId: "12345678-1234-4234-8234-123456789abc",
    },
  });
  expect(JSON.stringify(record.mock.calls)).not.toContain("private credentials");
});
it("uses synthetic credentials, compares both services, performs an authenticated query and revokes its session", async () => {
  const pending = responses();
  const request = vi.fn(async () => pending.shift()!);
  expect(await smokeValidation(sha, credentials, request)).toEqual({
    sha,
    authenticatedOperation: "passed",
    revocation: "passed",
  });
  expect(pending).toHaveLength(0);
  const calls = request.mock.calls as unknown as [string, RequestInit][];
  expect(calls[5][1].headers).toMatchObject({
    "Better-Auth-Cookie": "__Secure-better-auth.session_token=synthetic-session",
  });
  expect(calls[6][1].headers).toMatchObject({ Authorization: "Bearer synthetic-jwt" });
  expect(calls.every(([, options]) => options.redirect === "error")).toBe(true);
});
it("cleans up its session if the authenticated operation fails and never prints auth payloads", async () => {
  const pending = responses();
  pending[6] = Response.json({ status: "error", errorMessage: "private credentials" });
  const request = vi.fn(async () => pending.shift()!);
  await expect(smokeValidation(sha, credentials, request)).rejects.toThrow("AUTH_FAILED");
  expect(request).toHaveBeenCalledTimes(8);
  expect((request.mock.calls as unknown as [string][])[7][0]).toMatch(/sign-out$/);
});
it("refuses stale backend revisions before login and requires a reserved synthetic identity", async () => {
  const pending = responses();
  pending[1] = Response.json({
    sha: "b".repeat(40),
    appEnv: "validation",
    status: "ok",
    productEnv: "sandbox",
    fiscalEnv: "disabled",
  });
  const request = vi.fn(async () => pending.shift()!);
  await expect(smokeValidation(sha, credentials, request, { attempts: 1 })).rejects.toThrow(
    "SHA_MISMATCH",
  );
  expect(request).toHaveBeenCalledTimes(2);
  expect(() =>
    smokeCredentials({
      VALIDATION_SMOKE_EMAIL: "customer@example.com",
      VALIDATION_SMOKE_PASSWORD: credentials.password,
    }),
  ).toThrow();
  expect(
    smokeCredentials({
      VALIDATION_SMOKE_EMAIL: credentials.email,
      VALIDATION_SMOKE_PASSWORD: credentials.password,
    }),
  ).toEqual(credentials);
});

it("refuses a backend that reports the NFS-e fiscal production before login", async () => {
  const pending = responses();
  pending[1] = Response.json({
    sha,
    appEnv: "validation",
    status: "ok",
    productEnv: "sandbox",
    fiscalEnv: "disabled",
    issuanceEnv: "production",
  });
  const request = vi.fn(async () => pending.shift()!);
  await expect(smokeValidation(sha, credentials, request, { attempts: 1 })).rejects.toThrow(
    "ENVIRONMENT_MISMATCH",
  );
  expect(request).toHaveBeenCalledTimes(2);
});

it("waits for edge propagation before authentication without retrying sign-in", async () => {
  const pending = [
    Response.json({ sha: "b".repeat(40), environment: "validation" }),
    Response.json({
      sha,
      status: "ok",
      appEnv: "validation",
      productEnv: "sandbox",
      fiscalEnv: "disabled",
      issuanceEnv: "disabled",
    }),
    ...responses(),
  ];
  const request = vi.fn(async () => pending.shift()!);
  const pause = vi.fn(async () => {});
  await expect(smokeValidation(sha, credentials, request, { pause })).resolves.toMatchObject({
    sha,
  });
  expect(pause).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledTimes(11);
});

// Strict since #198, PR 6: every revision since #337 reports `issuanceEnv`. The validation target
// still serving a build before #337 is an older revision, retried until the published one answers.
const beforeIssuanceEnv = (revision: string) =>
  Response.json({
    sha: revision,
    status: "ok",
    appEnv: "validation",
    productEnv: "sandbox",
    fiscalEnv: "disabled",
  });

it("an older build without issuanceEnv is a revision still being replaced, retried", async () => {
  const pending = [
    Response.json({ sha, environment: "validation" }),
    beforeIssuanceEnv("b".repeat(40)),
    ...responses(),
  ];
  const request = vi.fn(async () => pending.shift()!);
  const pause = vi.fn(async () => {});
  await expect(smokeValidation(sha, credentials, request, { pause })).resolves.toMatchObject({
    sha,
  });
  expect(pause).toHaveBeenCalledOnce();
});

it("the published SHA without issuanceEnv is the wrong deployment", async () => {
  const pending = responses();
  pending[1] = beforeIssuanceEnv(sha);
  const request = vi.fn(async () => pending.shift()!);
  await expect(smokeValidation(sha, credentials, request, { attempts: 1 })).rejects.toThrow(
    "ENVIRONMENT_MISMATCH",
  );
  expect(request).toHaveBeenCalledTimes(2);
});
