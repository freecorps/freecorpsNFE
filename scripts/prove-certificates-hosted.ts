import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import https from "node:https";
import { once } from "node:events";
import { join } from "node:path";
import { formatEnvFile } from "./lib/worktree/env-file.mjs";
import type { TLSSocket } from "node:tls";
import { syntheticCertificate, syntheticServer } from "../tests/helpers/certificates";
import { encryptCertificate } from "../platform/convex/lib/certificateCrypto";

const root = process.cwd(),
  output = join(root, ".ci-results/77");
mkdirSync(output, { recursive: true });
const target: { name: string; type: string; reference: string } = JSON.parse(
  readFileSync(join(output, "hosted-target.json"), "utf8"),
);
assert.equal(target.type, "dev");
assert.equal(target.reference, "dev/issue-77-certificates-proof");
assert.match(target.name, /^[a-z]+-[a-z]+-\d+$/);
assert.notEqual(target.name, "modest-seal-118");
const keyFile = join(output, "hosted.env");
const key = /^CONVEX_DEPLOY_KEY=(.+)$/m.exec(readFileSync(keyFile, "utf8"))?.[1]?.trim();
assert.ok(key?.startsWith(`dev:${target.name}|`));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
assert.equal(git("status", "--porcelain"), "", "Commit the candidate before hosted proof");
const sha = git("rev-parse", "HEAD"),
  material = syntheticCertificate();
let serverMaterial = syntheticServer("initial.invalid");
const ring = { active: "proof-v1", keys: { "proof-v1": randomBytes(32).toString("hex") } };
const context = {
  organizationId: "synthetic-77",
  companyId: "synthetic-company-77",
  id: "synthetic-certificate-77",
  version: 1,
};
const encrypted = encryptCertificate(ring, context, material.pfx, material.password);
const fingerprint = new X509Certificate(material.cert).fingerprint256
  .replaceAll(":", "")
  .toLowerCase();
const received: Array<{ path: string; fingerprint: string; authorized: boolean }> = [];
const server = https.createServer(
  { ...serverMaterial, ca: material.cert, requestCert: true, rejectUnauthorized: true },
  (request, response) => {
    const socket = request.socket as TLSSocket;
    const peer = socket.getPeerCertificate().fingerprint256.replaceAll(":", "").toLowerCase();
    received.push({ path: request.url ?? "", fingerprint: peer, authorized: socket.authorized });
    if (request.url === "/slow") return;
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "https://untrusted.invalid" });
      response.end();
      return;
    }
    response.end(
      request.url === "/large" ? "x".repeat(8192) : JSON.stringify({ fingerprint: peer }),
    );
  },
);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
let tunnel: ReturnType<typeof spawn> | undefined;
const buildFile = join(root, "platform/convex/buildInfo.ts"),
  originalBuild = readFileSync(buildFile);
const commandEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(CONVEX_|VITE_|FNFE_|CLERK_|BETTER_AUTH_|VALIDATION_)/.test(name),
  ),
);
function cli(args: string[]) {
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules/convex/bin/main.js"), ...args, "--env-file", keyFile],
    { cwd: join(root, "platform"), env: commandEnv, stdio: "inherit", windowsHide: true },
  );
  assert.equal(result.status, 0, `Convex ${args[0]} failed`);
}
const report: {
  codeSha: string;
  target: typeof target;
  endpoint?: string;
  cases: unknown[];
  received: typeof received;
  result: string;
} = { codeSha: sha, target, cases: [], received, result: "running" };
let configured = false;
const sshKey = join(output, `tunnel-${randomBytes(8).toString("hex")}`);
try {
  execFileSync("ssh-keygen", ["-t", "ed25519", "-f", sshKey, "-N", ""], {
    windowsHide: true,
    stdio: "ignore",
  });
  const activeTunnel = spawn(
    "ssh",
    [
      "-F",
      process.platform === "win32" ? "NUL" : "/dev/null",
      "-T",
      "-p",
      "443",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "IdentityAgent=none",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${join(output, "known_hosts")}`,
      "-o",
      "ConnectTimeout=20",
      "-i",
      sshKey,
      "-o",
      "ServerAliveInterval=15",
      "-R",
      `0:127.0.0.1:${address.port}`,
      "tcp@free.pinggy.io",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  tunnel = activeTunnel;
  const origin = await new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("TCP tunnel did not start")), 30_000);
    let log = "";
    const chunk = (data: Buffer) => {
      log += data.toString();
      const match = /tcp:\/\/([a-z0-9.-]+\.pinggy-free\.link:\d+)/.exec(log);
      if (match) {
        clearTimeout(timer);
        accept(`https://${match[1]}`);
      }
    };
    activeTunnel.stdout.on("data", chunk);
    activeTunnel.stderr.on("data", chunk);
    activeTunnel.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    activeTunnel.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("TCP tunnel exited"));
    });
  });
  report.endpoint = origin;
  serverMaterial = syntheticServer(new URL(origin).hostname);
  server.setSecureContext({ ...serverMaterial, ca: material.cert });
  const variables = {
    APP_ENV: "validation",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "disabled",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
    FNFE_PLATFORM_CERT_KEYS: JSON.stringify(ring),
    FNFE_CERT_PROOF_ORIGIN: origin,
    FNFE_CERT_PROOF_CA: serverMaterial.cert,
  };
  const variablesFile = join(output, "backend.env");
  writeFileSync(variablesFile, formatEnvFile(variables, "Synthetic certificate proof only."), {
    mode: 0o600,
  });
  console.log(`target: dev (${target.name}, isolated certificate proof), code ${sha}`);
  cli(["env", "set", "--from-file", variablesFile, "--force"]);
  configured = true;
  writeFileSync(buildFile, `export const buildSha: string | null = ${JSON.stringify(sha)};\n`);
  cli(["deploy", "--yes"]);
  const health = await (await fetch(`https://${target.name}.convex.site/health`)).json();
  assert.equal(health.sha, sha);
  assert.equal(health.fiscalEnv, "disabled");
  for (const [scenario, expected] of Object.entries({
    ok: "OK",
    slow: "CERTIFICATE_TIMEOUT",
    large: "CERTIFICATE_RESPONSE_LIMIT",
    redirect: "CERTIFICATE_REDIRECT_DENIED",
    host: "CERTIFICATE_HOST_DENIED",
    trust: "CERTIFICATE_NETWORK_ERROR",
  })) {
    const response = await fetch(`https://${target.name}.convex.cloud/api/action`, {
      method: "POST",
      headers: { Authorization: `Convex ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "testing/certificateProof:run",
        format: "json",
        args: {
          context,
          scenario,
          envelope: {
            ...encrypted,
            pfx: { $bytes: Buffer.from(encrypted.pfx).toString("base64") },
            password: { $bytes: Buffer.from(encrypted.password).toString("base64") },
            wrappedKey: { $bytes: Buffer.from(encrypted.wrappedKey).toString("base64") },
          },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    assert.equal(result.status, "success", "Hosted action failed");
    report.cases.push({ scenario, expected, observed: result.value });
    assert.equal(result.value.code, expected, scenario);
    if (scenario === "ok") assert.equal(result.value.peer, fingerprint);
  }
  assert.ok(
    received.length >= 4 &&
      received.every((item) => item.authorized && item.fingerprint === fingerprint),
  );
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  throw error;
} finally {
  writeFileSync(buildFile, originalBuild);
  try {
    if (configured) cli(["env", "remove", "FNFE_CERT_PROOF_ORIGIN"]);
  } finally {
    tunnel?.kill();
    rmSync(sshKey, { force: true });
    rmSync(`${sshKey}.pub`, { force: true });
    server.closeAllConnections();
    server.close();
    material.pfx.fill(0);
    material.password.fill(0);
    writeFileSync(join(output, "hosted.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  }
}
