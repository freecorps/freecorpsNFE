import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import type { lookup } from "node:dns/promises";
import { once } from "node:events";
import {
  syntheticCertificate,
  syntheticServer,
  legacySyntheticCertificate,
} from "../tests/helpers/certificates";
import { certificateRequest } from "../platform/convex/lib/certificateTransport";

async function main(legacy = false) {
  const material = legacy ? legacySyntheticCertificate() : syntheticCertificate(),
    serverMaterial = syntheticServer("controlled.test");
  let authenticated = false;
  let posted = "";
  const server = https.createServer(
    { ...serverMaterial, ca: material.cert, requestCert: true, rejectUnauthorized: true },
    (request, response) => {
      authenticated = (request.socket as TLSSocket).authorized;
      if (request.url === "/soap") {
        assert.equal(request.method, "POST");
        assert.equal(request.headers.soapaction, '"distribution"');
        request.on("data", (chunk: Buffer) => {
          posted += chunk.toString();
        });
        request.on("end", () => response.end("received"));
        return;
      }
      if (request.url === "/slow") return;
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "https://untrusted.invalid" });
        response.end();
        return;
      }
      response.end(request.url === "/large" ? "x".repeat(8192) : "ok");
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server");
  const origin = `https://controlled.test:${address.port}`;
  // Only socket routing is injected. TLS, SNI, chain validation and HTTPS use real Node code.
  const dependencies = {
    resolve: (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as typeof lookup,
    request: ((
      url: URL,
      options: https.RequestOptions,
      callback: Parameters<typeof https.request>[2],
    ) =>
      https.request(
        url,
        {
          ...options,
          lookup: (_host, opts, done) =>
            opts.all
              ? done(null, [{ address: "127.0.0.1", family: 4 }])
              : done(null, "127.0.0.1", 4),
        },
        callback,
      )) as typeof https.request,
  };
  const target = {
    url: origin + "/",
    allowedOrigins: [origin],
    ca: serverMaterial.cert,
    timeoutMs: 1000,
    maxBytes: 1024,
  };
  try {
    assert.equal((await certificateRequest(target, material, dependencies)).body.toString(), "ok");
    assert.equal(authenticated, true);
    const post = await certificateRequest(
      {
        ...target,
        url: origin + "/soap",
        body: "<synthetic />",
        headers: { SOAPAction: '"distribution"', "Content-Type": "text/xml" },
      },
      material,
      dependencies,
    );
    assert.equal(post.body.toString(), "received");
    assert.equal(posted, "<synthetic />");
    await assert.rejects(
      certificateRequest({ ...target, url: origin + "/large" }, material, dependencies),
      /CERTIFICATE_RESPONSE_LIMIT/,
    );
    await assert.rejects(
      certificateRequest({ ...target, url: origin + "/redirect" }, material, dependencies),
      /CERTIFICATE_REDIRECT_DENIED/,
    );
    await assert.rejects(
      certificateRequest(
        { ...target, url: origin + "/slow", timeoutMs: 100 },
        material,
        dependencies,
      ),
      /CERTIFICATE_TIMEOUT/,
    );
    await assert.rejects(
      certificateRequest({ ...target, ca: material.cert }, material, dependencies),
      /CERTIFICATE_NETWORK_ERROR/,
    );
    await assert.rejects(
      certificateRequest(
        {
          ...target,
          url: `https://wrong.test:${address.port}`,
          allowedOrigins: [`https://wrong.test:${address.port}`],
        },
        material,
        dependencies,
      ),
      /CERTIFICATE_NETWORK_ERROR/,
    );
    await assert.rejects(
      certificateRequest({ ...target, allowedOrigins: [] }, material, dependencies),
      /CERTIFICATE_HOST_DENIED/,
    );
    await assert.rejects(
      certificateRequest(target, material, {
        ...dependencies,
        resolve: (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup,
      }),
      /CERTIFICATE_HOST_DENIED/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
await main();
await main(true);
mkdirSync(".ci-results/77", { recursive: true });
const report = {
  codeSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  environment: "node-loopback",
  syntheticOnly: true,
  recordedAt: new Date().toISOString(),
  result: "passed",
  runtime: process.version,
  cases: [
    "mutual-tls",
    "mutual-tls-soap-post",
    "legacy-rc2-pfx-mutual-tls-and-all-negative-cases",
    "response-limit",
    "redirect",
    "timeout",
    "wrong-trust",
    "wrong-server-identity",
    "host-allowlist",
    "private-address",
  ],
};
writeFileSync(".ci-results/77/local-tls.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
