// Browser proofs need a local relay: the API deliberately does not enable browser CORS.
// Binds only to loopback and forwards only /v1/ to this worktree's local backend.
import { createServer } from "node:http";
import { worktreePaths } from "../../../scripts/lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "../../../scripts/lib/worktree/deployment.mjs";
import { currentLocalSiteUrl } from "../../../scripts/lib/worktree/env-file.mjs";
import { assertLinkedWorktree } from "../../../scripts/lib/worktree/state.mjs";

const paths = worktreePaths();
assertLinkedWorktree(paths);
if (paths.app !== "platform") throw new Error("Local platform worktree required");
const target = localUrls(readLocalConfig(paths)).site;
const origin = currentLocalSiteUrl(paths);
const port = Number(process.argv[2] ?? 5431);
createServer(async (request, response) => {
  if (request.headers.origin !== origin || !request.url?.startsWith("/v1/")) {
    response.writeHead(403).end();
    return;
  }
  const cors = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Environment, Idempotency-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "Cache-Control, X-Content-Type-Options",
  };
  if (request.method === "OPTIONS") {
    response.writeHead(204, cors).end();
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2097152) throw new Error("Body limit exceeded");
      chunks.push(chunk);
    }
    const headers = {};
    for (const name of ["authorization", "content-type", "x-environment", "idempotency-key"])
      if (request.headers[name]) headers[name] = request.headers[name];
    const upstream = await fetch(target + request.url, {
      method: request.method,
      headers,
      redirect: "error",
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    response.writeHead(upstream.status, { ...Object.fromEntries(upstream.headers), ...cors });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    response.writeHead(502, cors).end("Local proof relay failed");
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`Local proof relay http://127.0.0.1:${port} -> ${target}`),
);
