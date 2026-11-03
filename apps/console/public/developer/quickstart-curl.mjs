// SPDX-License-Identifier: MIT
/*
MIT License

Copyright (c) 2026 FREECORPS TECNOLOGIA DA INFORMACAO LTDA

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
import { execFile } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Defina ${name}`);
  return value;
};
const base = new URL(required("FREECORPS_BASE_URL"));
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  base.pathname !== "/" ||
  (base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)))
)
  throw new Error("Origem inválida");
const secret = required("FREECORPS_API_KEY"),
  companyId = required("FREECORPS_COMPANY_ID"),
  intent = required("FREECORPS_IDEMPOTENCY_KEY");
const xmlPath = required("FREECORPS_XML"),
  bytes = readFileSync(xmlPath);
const directory = mkdtempSync(join(tmpdir(), "freecorps-curl-"));
const configString = (value) => JSON.stringify(value).replaceAll("\\u", "u");
// Every failure starts with the step it happened in, so the same code tells where to act.
let step = "reserva";
// curl's config is sent through stdin, so keys never enter process arguments or files; curl
// also runs without FREECORPS_API_KEY in its environment.
const curlEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== "FREECORPS_API_KEY"),
);
async function curl(path, method = "GET", body, key, upload) {
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error(`${step}: Origem de upload inesperada`);
  const headers = upload
    ? [`X-Upload-Token: ${upload}`, "Content-Type: application/xml"]
    : [
        `Authorization: Bearer ${secret}`,
        "X-Environment: sandbox",
        "Content-Type: application/json",
      ];
  if (key) headers.push(`Idempotency-Key: ${key}`);
  const headerFile = join(directory, "response-headers.txt");
  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    "30",
    "--dump-header",
    headerFile,
    "--config",
    "-",
    "--request",
    method,
    "--url",
    url.href,
  ];
  if (body !== undefined) {
    const file = join(directory, "request.json");
    writeFileSync(file, JSON.stringify(body));
    args.push("--data-binary", `@${file}`);
  }
  if (upload) args.push("--data-binary", `@${xmlPath}`);
  const output = await new Promise((resolve, reject) => {
    const child = execFile(
      process.platform === "win32" ? "curl.exe" : "curl",
      args,
      { maxBuffer: 4_000_000, env: curlEnv },
      (error, stdout) =>
        error
          ? reject(
              new Error(`${step}: curl falhou; consulte o estado da importação antes de repetir`),
            )
          : resolve(stdout),
    );
    child.stdin.end(headers.map((h) => `header = ${configString(h)}`).join("\n") + "\n");
  });
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`${step}: resposta sem JSON; confira a URL da API`);
  }
  if (value.error) {
    const error = new Error(`${step}: ${value.error.code}; requestId=${value.requestId}`);
    error.code = value.error.code;
    const retryAfter = /^retry-after:\s*(\d+)/im.exec(readFileSync(headerFile, "utf8"));
    error.retryAfter = retryAfter ? Number(retryAfter[1]) : 0;
    throw error;
  }
  return value.data;
}
try {
  const body = {
    companyId,
    files: [
      {
        name: "demonstracao.xml",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  const reserved = await curl("/v1/imports", "POST", body, intent);
  const repeated = await curl("/v1/imports", "POST", body, intent);
  if (reserved.importId !== repeated.importId || !repeated.reused)
    throw new Error("reserva: Identidade mudou");
  const path = `/v1/imports/${encodeURIComponent(reserved.importId)}/files/${encodeURIComponent(reserved.fileIds[0])}`;
  step = "importação";
  let batch = await curl(`/v1/imports/${encodeURIComponent(reserved.importId)}`);
  if (batch.files[0].state === "reserved") {
    step = "envio";
    const ticket = await curl(`${path}/upload`, "POST", {});
    try {
      await curl(ticket.url, "POST", undefined, undefined, ticket.token);
    } catch (error) {
      batch = await curl(`/v1/imports/${encodeURIComponent(reserved.importId)}`);
      if (batch.files[0].state !== "uploaded") throw error;
    }
  }
  step = "confirmação";
  const accepted = await curl(`${path}/confirm`, "POST", {});
  step = "processamento";
  // One query per second fits the key's REST budget (60 per minute, shared with every call of
  // the key); a 429 waits for Retry-After instead of failing, within the same 2 minutes.
  const deadline = Date.now() + 120_000;
  while (true) {
    let operation;
    try {
      operation = await curl(`/v1/operations/${encodeURIComponent(accepted.operationId)}`);
    } catch (error) {
      const wait = Math.max(1, error.retryAfter ?? 0) * 1000;
      if (error.code !== "RATE_LIMITED" || Date.now() + wait >= deadline) throw error;
      await delay(wait);
      continue;
    }
    if (operation.state === "succeeded") break;
    if (["failed", "paused"].includes(operation.state) || Date.now() >= deadline)
      throw new Error(
        `processamento: Operação ${operation.state}${operation.code ? ` (${operation.code})` : ""}`,
      );
    await delay(1000);
  }
  step = "resultado";
  batch = await curl(`/v1/imports/${encodeURIComponent(reserved.importId)}`);
  const documentId = batch.files[0].documentId,
    query = `companyId=${encodeURIComponent(companyId)}`;
  // A processed file without a document carries its diagnosis, such as COMPANY_MISMATCH.
  if (!documentId) throw new Error(`resultado: ${batch.files[0].code ?? "sem documento"}`);
  step = "documento";
  const document = await curl(`/v1/documents/${encodeURIComponent(documentId)}/json?${query}`);
  const items = [];
  let cursor;
  step = "itens";
  do {
    const page = await curl(
      `/v1/documents/${encodeURIComponent(documentId)}/items?${query}&versionId=${encodeURIComponent(document.version.id)}&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    items.push(...page.page);
    cursor = page.nextCursor;
  } while (cursor);
  console.log(
    JSON.stringify({
      importId: reserved.importId,
      operationId: accepted.operationId,
      documentId,
      reused: repeated.reused,
      contractVersion: document.contractVersion,
      total: document.summary.total,
      items: items.map((item) => ({
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total: item.total,
      })),
      resourceVersion: document.summary.resourceVersion,
      sha256: document.version.sha256,
    }),
  );
} finally {
  if (dirname(resolve(directory)) === resolve(tmpdir()))
    rmSync(directory, { recursive: true, force: true });
}
