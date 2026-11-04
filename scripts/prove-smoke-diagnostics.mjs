import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  readFileSync,
  copyFileSync,
  rmSync,
  existsSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { smokeValidation } from "./lib/validation-smoke.mjs";
import { publishRevision } from "./lib/validation-deploy.mjs";
import { repoUrl } from "./lib/repo-root.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const requestId = "12345678-1234-4234-8234-123456789abc";
const secret = "DO-NOT-LOG-synthetic-password";
const credentials = { email: "viewer@validation.invalid", password: secret };
const header = { "x-request-id": requestId };
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
    new Response('<div id="root"></div>', { headers: { "content-type": "text/html" } }),
    new Response('<div id="root"></div>', { headers: { "content-type": "text/html" } }),
    Response.json(
      {},
      {
        headers: {
          "set-better-auth-cookie":
            "__Secure-better-auth.session_token=DO-NOT-LOG-session; Path=/; Secure",
        },
      },
    ),
    Response.json({ token: "DO-NOT-LOG-jwt" }),
    Response.json({
      status: "success",
      value: { status: "authorized", environment: "validation", role: "viewer" },
    }),
    Response.json({ success: true }),
    Response.json({ status: "error" }),
  ];
}
const failures = [
  {
    name: "transport-timeout",
    index: 0,
    response: () => new DOMException(secret, "TimeoutError"),
    phase: "revision",
    service: "frontend",
    code: "TIMEOUT",
  },
  {
    name: "transport-unavailable",
    index: 1,
    response: () => new TypeError(secret),
    phase: "revision",
    service: "backend",
    code: "UNAVAILABLE",
  },
  {
    name: "invalid-json",
    index: 0,
    response: () => new Response(secret, { headers: header }),
    phase: "revision",
    service: "frontend",
    code: "INVALID_RESPONSE",
    httpStatus: 200,
  },
  {
    name: "invalid-json-shape",
    index: 0,
    response: () => Response.json(null),
    phase: "revision",
    service: "frontend",
    code: "INVALID_RESPONSE",
    httpStatus: 200,
  },
  {
    name: "http-unavailable",
    index: 1,
    response: () => new Response(secret, { status: 503, headers: header }),
    phase: "revision",
    service: "backend",
    code: "UNAVAILABLE",
    httpStatus: 503,
  },
  {
    name: "frontend-sha",
    index: 0,
    response: () => Response.json({ sha: otherSha, environment: "validation" }),
    phase: "revision",
    service: "frontend",
    code: "SHA_MISMATCH",
    httpStatus: 200,
    observedSha: otherSha,
  },
  {
    name: "backend-sha",
    index: 1,
    response: () =>
      Response.json({
        sha: otherSha,
        status: "ok",
        appEnv: "validation",
        productEnv: "sandbox",
        fiscalEnv: "disabled",
        issuanceEnv: "disabled",
      }),
    phase: "revision",
    service: "backend",
    code: "SHA_MISMATCH",
    httpStatus: 200,
    observedSha: otherSha,
  },
  {
    name: "invalid-sha-secret",
    index: 0,
    response: () => Response.json({ sha: secret, environment: "validation" }),
    phase: "revision",
    service: "frontend",
    code: "INVALID_RESPONSE",
    httpStatus: 200,
  },
  {
    name: "wrong-environment",
    index: 0,
    response: () => Response.json({ sha, environment: secret }),
    phase: "revision",
    service: "frontend",
    code: "ENVIRONMENT_MISMATCH",
    httpStatus: 200,
  },
  {
    name: "spa-http",
    index: 2,
    response: () => new Response(secret, { status: 404 }),
    phase: "spa-login",
    service: "frontend",
    code: "HTTP_ERROR",
    httpStatus: 404,
  },
  {
    name: "spa-invalid",
    index: 3,
    response: () => new Response(secret, { headers: { "content-type": "text/html" } }),
    phase: "spa-console",
    service: "frontend",
    code: "INVALID_RESPONSE",
    httpStatus: 200,
  },
  {
    name: "login-refused",
    index: 4,
    response: () => new Response(secret, { status: 401, headers: header }),
    phase: "login",
    service: "auth",
    code: "AUTH_FAILED",
    httpStatus: 401,
  },
  {
    name: "login-missing-session",
    index: 4,
    response: () => Response.json({ secret }),
    phase: "login",
    service: "auth",
    code: "AUTH_FAILED",
    httpStatus: 200,
  },
  {
    name: "token-refused",
    index: 5,
    response: () => new Response(secret, { status: 403 }),
    phase: "token",
    service: "auth",
    code: "AUTH_FAILED",
    httpStatus: 403,
  },
  {
    name: "token-missing",
    index: 5,
    response: () => Response.json({ secret }),
    phase: "token",
    service: "auth",
    code: "AUTH_FAILED",
    httpStatus: 200,
  },
  {
    name: "query-denied",
    index: 6,
    response: () => Response.json({ status: "error", errorMessage: secret }),
    phase: "query",
    service: "backend",
    code: "AUTH_FAILED",
    httpStatus: 200,
  },
  {
    name: "logout-unavailable",
    index: 7,
    response: () => new Response(secret, { status: 503 }),
    phase: "logout",
    service: "auth",
    code: "UNAVAILABLE",
    httpStatus: 503,
  },
  {
    name: "revocation-failed",
    index: 8,
    response: () => Response.json({ status: "success", value: secret }),
    phase: "revocation",
    service: "backend",
    code: "REVOCATION_FAILED",
    httpStatus: 200,
  },
  {
    name: "revocation-invalid",
    index: 8,
    response: () => new Response(secret),
    phase: "revocation",
    service: "backend",
    code: "INVALID_RESPONSE",
    httpStatus: 200,
  },
  {
    name: "primary-and-cleanup",
    index: 6,
    response: () => Response.json({ status: "error", errorMessage: secret }),
    cleanup: true,
    phase: "query",
    service: "backend",
    code: "AUTH_FAILED",
    httpStatus: 200,
  },
  {
    name: "token-and-cleanup",
    index: 5,
    response: () => Response.json({ secret }),
    cleanup: true,
    phase: "token",
    service: "auth",
    code: "AUTH_FAILED",
    httpStatus: 200,
  },
  {
    name: "logout-transport",
    index: 7,
    response: () => new TypeError(secret),
    phase: "logout",
    service: "auth",
    code: "UNAVAILABLE",
  },
  {
    name: "body-timeout",
    index: 0,
    response: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException(secret, "TimeoutError"));
          },
        }),
      ),
    phase: "revision",
    service: "frontend",
    code: "TIMEOUT",
    httpStatus: 200,
  },
  {
    name: "body-disconnected",
    index: 0,
    response: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError(secret));
          },
        }),
      ),
    phase: "revision",
    service: "frontend",
    code: "UNAVAILABLE",
    httpStatus: 200,
  },
  {
    name: "request-id-injection",
    index: 4,
    response: () =>
      new Response(secret, {
        status: 401,
        headers: { "x-request-id": secret + "x".repeat(10_000) },
      }),
    phase: "login",
    service: "auth",
    code: "AUTH_FAILED",
    httpStatus: 401,
  },
];
export async function proveSmokeDiagnostics() {
  const results = [];
  for (const scenario of failures) {
    const pending = responses();
    pending[scenario.index] = scenario.response();
    if (scenario.cleanup) pending[7] = new Response(secret, { status: 503, headers: header });
    const calls = [];
    const request = async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      // Cleanup jumps directly here when token/query failed.
      const index = url.endsWith("/sign-out") ? 7 : calls.length - 1;
      const response = pending[index];
      if (response instanceof Error) throw response;
      return response;
    };
    let receipt;
    let error;
    let probes = 0;
    const noop = async () => {};
    try {
      await publishRevision(
        sha,
        {
          preflight: noop,
          build: noop,
          eligible: async () => true,
          backend: noop,
          frontend: noop,
          probe: async () => {
            probes++;
            return { key: "persistence-v1", nonce: "synthetic" };
          },
          smoke: () => smokeValidation(sha, credentials, request, { attempts: 1 }),
        },
        (value) => {
          receipt = value;
        },
      );
    } catch (failure) {
      error = failure;
    }
    assert.ok(error instanceof Error, scenario.name);
    assert.equal(receipt.state, "partial", scenario.name);
    assert.equal(receipt.phase, "smoke");
    assert.equal(receipt.after, null);
    assert.equal(probes, 1);
    for (const key of ["phase", "service", "code", "httpStatus", "observedSha"])
      assert.equal(receipt.diagnostic[key], scenario[key], scenario.name + "/" + key);
    assert.equal(receipt.diagnostic.expectedSha, sha);
    if (scenario.cleanup) {
      assert.equal(receipt.cleanupDiagnostic.phase, "logout");
      assert.equal(receipt.cleanupDiagnostic.code, "UNAVAILABLE");
    }
    if (scenario.index >= 5)
      assert.equal(calls.filter((url) => url.endsWith("/sign-out")).length, 1);
    assert.ok(calls.filter((url) => url.endsWith("/sign-in/email")).length <= 1);
    const serialized = JSON.stringify({ receipt, error: error.message });
    assert.ok(!serialized.includes("DO-NOT-LOG"));
    assert.ok(!serialized.includes(credentials.email));
    assert.ok(serialized.length < 2048);
    results.push({ scenario: scenario.name, result: "passed", receipt, error: error.message });
  }
  return results;
}
export function proveSmokeSummary(receipt) {
  // Copy the real CLI and its imports into a disposable directory, with no env or dependencies.
  const directory = mkdtempSync(join(tmpdir(), "fnfe-smoke-summary-"));
  const files = [
    "scripts/deploy-validation.mjs",
    "scripts/lib/validation.mjs",
    "scripts/lib/console.mjs",
    "scripts/lib/validation-deploy.mjs",
    "scripts/lib/validation-smoke.mjs",
    "scripts/lib/smoke-diagnostic.mjs",
    "scripts/lib/platform-build.mjs",
    "scripts/lib/repository.mjs",
    "scripts/lib/subprocess-environment.mjs",
    "scripts/lib/terms-notice.mjs",
    "scripts/lib/repo-root.mjs",
    "platform/account-policy.mjs",
    "platform/validation.json",
  ];
  const journal = join(directory, ".validation-results/deployment.json");
  const summary = join(directory, ".validation-results/summary.md");
  const step = join(directory, "step.md");
  let proof;
  let primary;
  const cleanupErrors = [];
  try {
    for (const file of files) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      copyFileSync(new URL(file, repoUrl), join(directory, file));
    }
    mkdirSync(dirname(journal));
    writeFileSync(journal, JSON.stringify(receipt));
    const run = (stepFile) =>
      execFileSync(
        process.execPath,
        [join(directory, "scripts/deploy-validation.mjs"), "summary"],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) =>
                /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(key),
              ),
            ),
            ...(stepFile ? { GITHUB_STEP_SUMMARY: stepFile } : {}),
          },
        },
      );
    const stdout = run();
    const artifact = readFileSync(summary, "utf8");
    assert.equal(stdout.trim(), artifact.trim());
    assert.ok(artifact.includes('"code":"AUTH_FAILED"'));
    assert.ok(artifact.includes('"phase":"logout"'));
    assert.ok(!artifact.includes("DO-NOT-LOG"));
    run(step);
    assert.equal(readFileSync(step, "utf8"), artifact);
    writeFileSync(
      journal,
      JSON.stringify({
        ...receipt,
        diagnostic: { phase: secret, code: secret, requestId: secret.repeat(1000) },
        cleanupDiagnostic: undefined,
      }),
    );
    const sanitized = run();
    assert.ok(sanitized.includes('"code":"UNKNOWN"'));
    assert.ok(!sanitized.includes("DO-NOT-LOG"));
    assert.ok(sanitized.length < 2048);
    writeFileSync(
      journal,
      JSON.stringify({ ...receipt, diagnostic: undefined, cleanupDiagnostic: undefined }),
    );
    const legacy = run();
    assert.ok(legacy.includes("Estado: partial"));
    assert.ok(!legacy.includes("undefined"));
    proof = {
      result: "passed",
      stdoutMatchesArtifact: true,
      stepSummaryMatchesArtifact: true,
      untrustedFieldsRejected: true,
      legacyReceiptSupported: true,
      sample: artifact,
    };
  } catch (error) {
    primary = error;
  } finally {
    for (const file of [...files.map((file) => join(directory, file)), journal, summary, step]) {
      try {
        rmSync(file, { force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const path of ["scripts/lib", "scripts", "platform", ".validation-results", ""]) {
      try {
        if (existsSync(join(directory, path))) rmdirSync(join(directory, path));
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (primary) throw primary;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Summary proof cleanup failed");
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await proveSmokeDiagnostics();
  const summaryProof = proveSmokeSummary(
    results.find((result) => result.scenario === "primary-and-cleanup").receipt,
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const output = process.argv[2] ?? ".validation-results/smoke-diagnostics.json";
  mkdirSync(new URL(".", pathToFileURL(output)), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        schemaVersion: 1,
        codeSha: head,
        runnerSha: head,
        workingTreeDirty:
          execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
        runtime: process.version,
        platform: process.platform,
        environment: "controlled-transport",
        dataset: "synthetic-only",
        remoteWrites: false,
        command: "node scripts/prove-smoke-diagnostics.mjs",
        results,
        summaryProof,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(results.length + " controlled smoke failures verified; " + output);
}
