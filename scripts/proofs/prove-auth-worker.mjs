import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { verifyAuthRequest } from "../../platform/auth-transport.ts";
import { repoRoot } from "../lib/repo-root.mjs";

// Use the actual workerd and bundler pinned by Wrangler, with no network services.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, Response, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");
const root = repoRoot;
const temporary = mkdtempSync(join(tmpdir(), "fnfe-auth-worker-"));
const secret = "a".repeat(64);
const origin = "https://freecorpsnfe-validation.freecorps.workers.dev";
let upstreamCalls = 0;
let runtime;
try {
  const outfile = join(temporary, "worker.mjs");
  await build({
    entryPoints: [join(root, "apps/console/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile,
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: "validation-auth-proof",
      modules: true,
      script: readFileSync(outfile, "utf8"),
      compatibilityDate: "2026-09-09",
      cf: { colo: "TST" },
      bindings: { AUTH_PROXY_SECRET: secret },
      serviceBindings: { ASSETS: () => new Response("synthetic asset") },
      outboundService: async (request) => {
        upstreamCalls++;
        assert.equal(request.url, "https://modest-seal-118.convex.site/api/auth/sign-in/email");
        assert.equal(request.headers.get("x-forwarded-for"), null);
        assert.equal(
          await verifyAuthRequest(request, new Uint8Array(await request.arrayBuffer()), secret),
          "203.0.113.7",
        );
        return Response.json(
          { success: true },
          { headers: { "set-better-auth-cookie": "synthetic", "set-cookie": "refused" } },
        );
      },
    }),
  );
  const headers = {
    Origin: origin,
    "Content-Type": "application/json",
    "cf-connecting-ip": "203.0.113.7",
    "x-forwarded-for": "192.0.2.99",
  };
  const result = await runtime.dispatchFetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { success: true });
  assert.equal(result.headers.get("set-better-auth-cookie"), "synthetic");
  assert.equal(result.headers.get("set-cookie"), null);
  const denied = await runtime.dispatchFetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { ...headers, Origin: "https://foreign.invalid" },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  assert.equal(upstreamCalls, 1);
  assert.equal(await (await runtime.dispatchFetch(`${origin}/login`)).text(), "synthetic asset");
  const output = join(root, ".browser-results/auth-worker");
  mkdirSync(output, { recursive: true });
  const report = {
    codeSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    ),
    runtime: "workerd-local",
    result: "passed",
    checks: [
      "signed-upstream",
      "forged-forwarding-stripped",
      "cookie-header-transport",
      "foreign-origin-refused",
      "asset-dispatch",
    ],
    externalRequests: 0,
  };
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await runtime?.dispose();
  rmSync(temporary, { recursive: true, force: true });
}
