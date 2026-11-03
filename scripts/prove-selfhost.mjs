import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { load, call, cli, configure, build, root, sha, run, compose } from "./lib/selfhost.mjs";
import {
  saveCustody,
  readCustody,
  restoreCustody,
  fileHash,
  recoveryKeys,
} from "./lib/recovery-custody.mjs";
import { proveQuickstarts, independentReceiver } from "./lib/sdk-proof.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { get } from "node:https";

const [mode, name, extra] = process.argv.slice(2);
// CLI subprocesses and backend restarts can outlive pooled HTTP connections.
const fetch = (url, options = {}) =>
  globalThis.fetch(url, {
    ...options,
    headers: { ...options.headers, Connection: "close" },
  });
const source = load(name);
const output = join(root, ".ci-results/82");
mkdirSync(output, { recursive: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const privateFile = join(source.directory, "proof-private.json");
// Recovery must work with the original server stopped and its environment unavailable.
const inspectedInstance = mode === "restore" ? load(extra) : source;
const containerId = compose(inspectedInstance, ["ps", "--quiet", "backend"]).trim();
const runningImage = run("docker", ["inspect", "--format", "{{.Image}}", containerId]).trim();
const imageInfo = JSON.parse(run("docker", ["image", "inspect", runningImage]))[0];
assert.ok(
  imageInfo.RepoDigests.includes(inspectedInstance.backendImage),
  "Imagem executada difere da fixada",
);
const report = {
  codeSha: sha(),
  runnerSha256: hash(readFileSync(new URL(import.meta.url))),
  dirty: run("git", ["status", "--porcelain"]).trim() !== "",
  recordedAt: new Date().toISOString(),
  mode,
  backendImage: inspectedInstance.backendImage,
  runningImage,
  backendRevision: imageInfo.Config.Labels["org.opencontainers.image.revision"],
  backendVersion: await (await fetch(inspectedInstance.cloud + "/version")).text(),
  system: `${process.platform}/${process.arch}`,
  node: process.version,
  docker: run("docker", ["--version"]).trim(),
  compose: run("docker", ["compose", "version"]).trim(),
  source: { cloud: source.cloud, site: source.site },
  scenarios: [],
  result: "running",
};
const save = (state) => writeFileSync(privateFile, JSON.stringify(state), { mode: 0o600 });
let cookie = "";
async function auth(target, path, body) {
  const response = await fetch(`${target.frontend}/api/auth/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: target.frontend,
      "Content-Type": "application/json",
      "Better-Auth-Cookie": cookie,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const newCookie = response.headers.get("set-better-auth-cookie");
  if (newCookie)
    cookie = newCookie.match(/(?:__Secure-)?better-auth\.session_token=[^;,\s]+/)?.[0] ?? cookie;
  assert.ok(response.ok, `auth ${path}: ${response.status}`);
  return response.json();
}
async function login(target, state) {
  cookie = "";
  await auth(target, "sign-in/email", { email: state.email, password: state.password });
  const { token } = await auth(target, "convex/token");
  assert.ok(token);
  return token;
}
async function userCall(target, token, kind, path, args) {
  const response = await fetch(`${target.cloud}/api/${kind}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const result = await response.json();
  assert.equal(result.status, "success", `${path}: ${result.errorMessage ?? response.status}`);
  return result.value;
}
async function rest(target, key, path, method = "GET", body) {
  const response = await fetch(target.site + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "X-Environment": "sandbox",
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${result.error?.code ?? response.status}`);
  return result.data;
}
async function inspect(target, state) {
  const token = await login(target, state);
  const organization = await userCall(target, token, "query", "organizations:context", {
    slug: state.slug,
    contextKey: "selfhost-proof",
  });
  const project = await userCall(target, token, "query", "projects:get", {
    organizationId: state.organizationId,
    projectId: state.projectId,
    contextKey: "selfhost-proof",
  });
  assert.equal(organization?.id, state.organizationId);
  assert.equal(project?.id, state.projectId);
  const document = await rest(
    target,
    state.apiKey,
    `/v1/documents/${state.documentId}?companyId=${state.companyId}`,
  );
  const files = [];
  for (const fileId of state.fileIds)
    files.push(await call(target, "action", "testing/importProof:original", { fileId }));
  return { domainHash: hash(JSON.stringify({ organization, project, document })), document, files };
}
try {
  assert.equal(report.dirty, false, "O ensaio exige checkout limpo antes de alterar a instalação");
  assert.deepEqual(await call(inspectedInstance, "query", "_system/frontend/listCronJobs"), []);
  if (mode === "prepare") {
    assert.equal((await fetch(source.frontend + "/app/direct-route")).status, 200);
    assert.equal((await fetch(source.frontend + "/private.env")).status, 404);
    assert.equal((await fetch(source.frontend + "/%2e%2e%2fsecret.txt")).status, 403);
    assert.equal(
      (
        await fetch(source.frontend + "/api/auth/sign-up/email", {
          method: "POST",
          headers: { Origin: "https://foreign.invalid" },
          body: "{}",
        })
      ).status,
      403,
    );
    report.scenarios.push("built-spa-direct-route-private-path-and-cross-origin-denials");
    const state = {
      preparedSha: (await (await fetch(source.frontend + "/build.json")).json()).sha,
      email: `selfhost-${randomUUID()}@development.invalid`,
      password: randomBytes(24).toString("base64url"),
    };
    assert.match(state.preparedSha, /^[a-f0-9]{40}$/);
    report.installedFrontendSha = state.preparedSha;
    await auth(source, "sign-up/email", { ...state, name: "Operador da instalação própria" });
    const messages = await call(source, "query", "mail:inbox", { email: state.email });
    await auth(source, "email-otp/verify-email", { email: state.email, otp: messages[0].otp });
    const token = await login(source, state);
    const rpc = (kind, path, args) => userCall(source, token, kind, path, args);
    Object.assign(
      state,
      await rpc("mutation", "organizations:create", {
        name: "Instalação própria sintética",
        slug: `selfhost-${randomUUID()}`,
      }),
    );
    const org = { organizationId: state.organizationId };
    Object.assign(
      state,
      await rpc("mutation", "onboarding:start", {
        ...org,
        mode: "demonstration",
        expectedVersion: 0,
      }),
    );
    Object.assign(
      state,
      await rpc("mutation", "projects:create", {
        ...org,
        name: "Consumidor sintético",
        externalReference: randomUUID(),
      }),
    );
    const scopes = ["documents:read", "documents:import", "webhooks:manage"];
    await rpc("mutation", "projects:grantCompany", {
      ...org,
      projectId: state.projectId,
      companyId: state.companyId,
      scopes,
      environments: ["sandbox"],
      expectedVersion: 0,
    });
    const key = await rpc("action", "keys:create", {
      ...org,
      projectId: state.projectId,
      name: "Ensaio de instalação",
      scopes,
      environment: "sandbox",
      companyIds: [state.companyId],
      expiresAt: Date.now() + 7 * 86_400_000,
    });
    state.apiKey = key.secretOnce;
    state.keyId = key.keyId;
    save(state);
    report.scenarios.push(
      "real-signup-email-collector-verification-login",
      "public-organization-onboarding-project-grant-scoped-key",
    );
  } else if (mode === "journey") {
    const state = JSON.parse(readFileSync(privateFile, "utf8"));
    let secrets = [],
      tunnel,
      endpoint;
    const receiver = await independentReceiver({
      database: join(source.directory, `receiver-${randomUUID()}.sqlite`),
      secrets: () => secrets,
      options: () => ({ baseUrl: source.site, apiKey: state.apiKey, environment: "sandbox" }),
    });
    const received = [];
    const server = createServer(async (request, response) => {
      if (request.url === "/ready" && request.method === "GET") {
        response.writeHead(204).end();
        return;
      }
      if (request.url !== "/hook" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 262144) {
            response.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const headers = Object.fromEntries(
          Object.entries(request.headers).filter(([, value]) => typeof value === "string"),
        );
        const result = await receiver.receive(Buffer.concat(chunks), headers);
        received.push(result);
        response.writeHead(result.status).end();
      } catch {
        response.writeHead(503).end();
      }
    });
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      assert.ok(extra, "Passe o caminho do cloudflared para expor somente o receptor sintético");
      report.cloudflared = {
        version: run(extra, ["--version"]).trim(),
        sha256: hash(readFileSync(extra)),
      };
      tunnel = spawn(
        extra,
        [
          "tunnel",
          "--no-autoupdate",
          "--protocol",
          "http2",
          "--url",
          `http://127.0.0.1:${server.address().port}`,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const tunnelUrl = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Tunnel timeout")), 60_000);
        const onData = (chunk) => {
          const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (match) {
            clearTimeout(timeout);
            resolve(match[0]);
          }
        };
        tunnel.stdout.on("data", onData);
        tunnel.stderr.on("data", onData);
        tunnel.on("error", reject);
      });
      report.receiverOrigin = tunnelUrl;
      console.log(`Receptor sintético: ${tunnelUrl}`);
      const resolver = new Resolver();
      if (process.env.FNFE_PROOF_DNS) resolver.setServers(process.env.FNFE_PROOF_DNS.split(","));
      report.dnsResolver = process.env.FNFE_PROOF_DNS ?? "operating-system";
      for (let i = 0; i < 90; i++) {
        try {
          const addresses = process.env.FNFE_PROOF_DNS
            ? await resolver.resolve4(new URL(tunnelUrl).hostname)
            : null;
          const status = addresses
            ? await new Promise((resolve, reject) => {
                const request = get(
                  tunnelUrl + "/ready",
                  {
                    signal: AbortSignal.timeout(3000),
                    lookup: (_host, options, callback) =>
                      options.all
                        ? callback(null, [{ address: addresses[0], family: 4 }])
                        : callback(null, addresses[0], 4),
                  },
                  (response) => {
                    response.resume();
                    resolve(response.statusCode);
                  },
                );
                request.on("error", reject);
              })
            : (await fetch(tunnelUrl + "/ready", { signal: AbortSignal.timeout(3000) })).status;
          if (status === 204) {
            delete report.readinessError;
            break;
          }
        } catch (error) {
          report.readinessError = error.code ?? error.cause?.code ?? error.name;
        }
        if (i % 15 === 0)
          console.log(`Aguardando HTTPS: ${i}, ${report.readinessError ?? "resposta pendente"}`);
        if (i === 89) throw new Error("HTTPS receiver unavailable");
        await delay(1000);
      }
      cli(source, ["env", "set", "WEBHOOK_MODE", "https"]);
      endpoint = await rest(source, state.apiKey, "/v1/webhook-endpoints", "POST", {
        companyId: state.companyId,
        name: "Receptor da instalação própria",
        url: tunnelUrl + "/hook",
        events: ["document.received", "document.updated", "import.completed"],
      });
      secrets = [{ version: 1, secret: endpoint.secret }];
      report.quickstarts = await proveQuickstarts({
        baseUrl: source.site,
        apiKey: state.apiKey,
        companyId: state.companyId,
        xmlPath: join(root, "apps/console/public/examples/nfe-demonstracao.xml"),
      });
      state.documentId = report.quickstarts.sdk.documentId;
      state.fileIds = [];
      for (const importId of new Set([
        report.quickstarts.sdk.importId,
        report.quickstarts.curl.importId,
      ])) {
        const imported = await rest(source, state.apiKey, `/v1/imports/${importId}`);
        state.fileIds.push(...imported.files.map((file) => file.id));
      }
      for (let i = 0; i < 120 && receiver.documentReads() === 0; i++) await delay(500);
      assert.ok(
        receiver.documentReads() > 0,
        "Signed event must trigger authenticated document read",
      );
      assert.ok(received.some((result) => result.code === "APPLIED"));
      report.receiver = receiver.inspect();
      report.documentReads = receiver.documentReads();
      report.scenarios.push(
        "independent-sdk-curl-idempotency-and-document-query",
        "https-signed-outbox-to-independent-receiver-and-authenticated-read",
      );
      save(state);
    } finally {
      report.received = received;
      try {
        if (endpoint)
          await rest(
            source,
            state.apiKey,
            `/v1/webhook-endpoints/${endpoint.endpoint.id}`,
            "PATCH",
            {
              name: endpoint.endpoint.name,
              url: endpoint.endpoint.url,
              events: endpoint.endpoint.events,
              active: false,
              expectedVersion: endpoint.endpoint.version,
            },
          );
      } finally {
        try {
          cli(source, ["env", "set", "WEBHOOK_MODE", "disabled"]);
          report.transportRestored = true;
        } finally {
          tunnel?.kill();
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
          receiver.close();
        }
      }
    }
  } else if (mode === "upgrade") {
    const state = JSON.parse(readFileSync(privateFile, "utf8"));
    const previousBuild = await (await fetch(source.frontend + "/build.json")).json();
    assert.notEqual(
      previousBuild.sha,
      sha(),
      "A atualização precisa de um commit diferente do instalado inicialmente",
    );
    report.previousCodeSha = previousBuild.sha;
    report.previousBackendHealth = await (await fetch(source.site + "/health")).json();
    assert.match(previousBuild.sha, /^[a-f0-9]{40}$/);
    assert.equal(
      report.previousBackendHealth.sha,
      previousBuild.sha,
      "Backend e console precisam partir da mesma revisão identificada",
    );
    const before = await inspect(source, state);
    const started = Date.now();
    report.backendHealth = await configure(source);
    build(source);
    report.frontendBuild = await (await fetch(source.frontend + "/build.json")).json();
    assert.equal(report.frontendBuild.sha, sha());
    compose(source, ["restart", "backend"]);
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(source.site + "/health")).ok) break;
      } catch {
        /* Restart */
      }
      await delay(500);
    }
    const after = await inspect(source, state);
    assert.deepEqual(after, before);
    await login(source, state);
    report.durationMs = Date.now() - started;
    report.domainHash = after.domainHash;
    report.files = after.files;
    report.scenarios.push("compatible-code-redeploy-and-container-restart-preserve-data-and-login");
    const snapshot = join(mkdtempSync(join(tmpdir(), "fnfe82-snapshot-")), "snapshot.zip");
    state.snapshotStarted = Date.now();
    cli(source, ["export", "--include-file-storage", "--path", snapshot]);
    state.snapshot = snapshot;
    state.snapshotCodeSha = sha();
    state.snapshotImage = runningImage;
    state.snapshotSha256 = fileHash(snapshot);
    state.custody = join(mkdtempSync(join(tmpdir(), "fnfe82-custody-")), "keys.json");
    state.custodySha256 = saveCustody(source.env, state.custody, state.snapshotSha256);
    state.before = after;
    save(state);
    report.snapshotSha256 = state.snapshotSha256;
    report.custodyKeys = recoveryKeys;
  } else if (mode === "restore") {
    const destination = load(extra);
    assert.notEqual(destination.cloud, source.cloud);
    const state = JSON.parse(readFileSync(privateFile, "utf8"));
    // Validate both copies before any destination write, including function publication.
    const keys = readCustody(
      state.custody,
      state.custodySha256,
      state.snapshot,
      state.snapshotSha256,
    );
    assert.equal(
      state.snapshotCodeSha,
      sha(),
      "Restore exige o código do snapshot; migração tem ensaio próprio",
    );
    assert.equal(state.snapshotImage, runningImage, "Imagem de destino difere do backup");
    await call(destination, "query", "testing/restoreProof:assertEmpty");
    report.destinationHealth = await configure(destination);
    build(destination);
    report.destinationBuild = await (await fetch(destination.frontend + "/build.json")).json();
    assert.equal(report.destinationBuild.sha, sha());
    assert.equal(report.destinationHealth.sha, sha());
    const destinationContainer = compose(destination, ["ps", "--quiet", "backend"]).trim();
    report.destinationImage = run("docker", [
      "inspect",
      "--format",
      "{{.Image}}",
      destinationContainer,
    ]).trim();
    assert.equal(report.destinationImage, runningImage);
    await call(destination, "query", "testing/restoreProof:assertEmpty");
    const started = Date.now();
    cli(destination, ["import", state.snapshot, "--replace", "--yes"]);
    // Environment is not part of a Convex snapshot. Recover application keys from separate custody.
    restoreCustody(destination.env, keys);
    cli(destination, ["env", "set", "--from-file", destination.env, "--force"]);
    const after = await inspect(destination, state);
    assert.deepEqual(after, state.before);
    await login(destination, state);
    assert.deepEqual(await call(destination, "query", "_system/frontend/listCronJobs"), []);
    report.rtoMs = Date.now() - started;
    report.snapshotAgeMs = started - state.snapshotStarted;
    report.snapshotSha256 = hash(readFileSync(state.snapshot));
    report.domainHash = after.domainHash;
    report.files = after.files;
    report.destination = { cloud: destination.cloud, site: destination.site };
    report.custodyKeys = recoveryKeys;
    report.scenarios.push(
      "empty-independent-docker-volume-restore-with-storage",
      "public-organization-project-document-original-hashes-and-scoped-api-preserved",
      "separate-key-custody-and-restored-account-login",
    );
  } else throw new Error("Use prepare|journey|upgrade|restore <origem> [cloudflared|destino]");
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = error.message;
  if (error.cause?.code) report.transportCode = error.cause.code;
  process.exitCode = 1;
}
writeFileSync(join(output, `${mode}.json`), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ mode, result: report.result, error: report.error }));
