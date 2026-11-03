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
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FreecorpsClient } from "@freecorps/sdk";

// Run from a clean consumer after installing the SDK tarball. Never log credentials or tickets.
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Defina ${name}`);
  return value;
};
const client = new FreecorpsClient({
  baseUrl: required("FREECORPS_BASE_URL"),
  apiKey: required("FREECORPS_API_KEY"),
  environment: "sandbox",
});
const companyId = required("FREECORPS_COMPANY_ID"),
  bytes = readFileSync(required("FREECORPS_XML"));
const idempotencyKey = required("FREECORPS_IDEMPOTENCY_KEY");
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
const input = { path: {}, query: {}, body };
const reserved = (await client.call("reserveImport", input, { idempotencyKey })).data;
const repeated = (await client.call("reserveImport", input, { idempotencyKey })).data;
if (reserved.importId !== repeated.importId || !repeated.reused)
  throw new Error("Identidade da reserva mudou");
const path = { importId: reserved.importId, fileId: reserved.fileIds[0]! };
let batch = (
  await client.call("getImport", { path: { importId: path.importId }, query: {}, body: {} })
).data;
if (batch.files[0]!.state === "reserved") {
  const ticket = (await client.call("createUpload", { path, query: {}, body: {} })).data;
  try {
    await client.upload(ticket, bytes);
  } catch (error) {
    const current = (
      await client.call("getImport", { path: { importId: path.importId }, query: {}, body: {} })
    ).data;
    if (current.files[0]!.state !== "uploaded") throw error;
  }
}
const accepted = (await client.call("confirmImport", { path, query: {}, body: {} })).data;
const deadline = Date.now() + 120_000;
while (true) {
  const operation = (
    await client.call("getOperation", {
      path: { operationId: accepted.operationId },
      query: {},
      body: {},
    })
  ).data;
  if (operation.state === "succeeded") break;
  if (["failed", "paused"].includes(operation.state) || Date.now() >= deadline)
    throw new Error(`Operação ${operation.state}: ${operation.code}`);
  await delay(500);
}
batch = (await client.call("getImport", { path: { importId: path.importId }, query: {}, body: {} }))
  .data;
const documentId = batch.files[0]!.documentId;
if (!documentId) throw new Error("O XML não produziu um documento consultável");
const document = (
  await client.call("documentJson", { path: { documentId }, query: { companyId }, body: {} })
).data;
const original = await client.downloadOriginal({
  artifactId: document.version.artifactId,
  companyId,
});
if (createHash("sha256").update(original).digest("hex") !== body.files[0]!.sha256)
  throw new Error("Original divergente");
const items = [];
let cursor: string | undefined;
do {
  const page = (
    await client.call("documentItems", {
      path: { documentId },
      query: {
        companyId,
        versionId: document.version.id,
        limit: 25,
        ...(cursor ? { cursor } : {}),
      },
      body: {},
    })
  ).data;
  items.push(...page.page);
  cursor = page.nextCursor ?? undefined;
} while (cursor);
console.log(
  JSON.stringify({
    importId: path.importId,
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
