import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../lib/repo-root.mjs";
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, Response, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");
const bundle = await build({
  stdin: {
    contents: `import {deliver,drain} from './apps/console/privacy-mail-worker.ts';
export default {async fetch(request,env){
 if(new URL(request.url).pathname==='/maintenance'){try{await drain(env);return new Response('ok');}catch{return new Response('failed',{status:503});}}
 const bytes=new TextEncoder().encode('Synthetic mail').buffer;
 const meta={from:'test@example.invalid',to:'privacidade@nfe.freecorps.com.br'};
 await env.INBOUND_MAIL.put('pending/test.eml',bytes,{customMetadata:meta});
 const accepted=await deliver(env,'pending/test.eml',bytes,meta);
 return Response.json({accepted,preserved:!!await env.INBOUND_MAIL.get('pending/test.eml')});
}}`,
    resolveDir: repoRoot,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
let status = 204,
  calls = 0,
  foreign = 0;
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-13",
    cf: { colo: "TST" },
    r2Buckets: ["INBOUND_MAIL"],
    bindings: {
      INBOUND_EMAIL_SECRET: "synthetic-runtime-secret",
      BACKEND_SITE_URL: "https://backend.example",
    },
    outboundService: async (request) => {
      calls++;
      if (new URL(request.url).hostname !== "backend.example") foreign++;
      return new Response(null, {
        status,
        headers: status === 307 ? { location: "https://foreign.example/" } : {},
      });
    },
  }),
);
try {
  assert.deepEqual(await (await runtime.dispatchFetch("https://test.example/delivery")).json(), {
    accepted: true,
    preserved: false,
  });
  assert.equal((await runtime.dispatchFetch("https://test.example/maintenance")).status, 200);
  status = 307;
  assert.deepEqual(await (await runtime.dispatchFetch("https://test.example/delivery")).json(), {
    accepted: false,
    preserved: true,
  });
  assert.equal((await runtime.dispatchFetch("https://test.example/maintenance")).status, 503);
  assert.equal(calls, 4);
  assert.equal(foreign, 0);
  const report = {
    runtime: "workerd-local",
    delivery: true,
    maintenance: true,
    redirectPreservesOriginal: true,
    redirectNotFollowed: true,
    externalRequests: 0,
  };
  const output = join(repoRoot, ".browser-results/privacy-worker");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(report);
} finally {
  await runtime.dispose();
}
