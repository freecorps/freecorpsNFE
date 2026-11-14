import { legacyNfseImport } from "./nfse";
import { createHash } from "node:crypto";
import { expect } from "vite-plus/test";
import { internal, api } from "../../platform/convex/_generated/api";
import { person, platformTest } from "./platform";
import { hashApiKey } from "../../platform/convex/lib/apiKeyCrypto";
import { fixture as xmlFixture } from "./nfe-corpus";
import { processNfe } from "../../packages/fiscal-nfe/src/index";
import type { Id } from "../../platform/convex/_generated/dataModel";

// Fixtures of the XML import suites: a company with a key and people, and a completed import.
/** `legacy`: NFS-e batches go through the retired ABRASF reader (`legacyNfseImport`). */
export async function fixture(bytes = xmlFixture("invoice-signed"), legacy = false) {
  const t = platformTest(legacy ? legacyNfseImport() : {});
  const secret = `fnfe_${"b".repeat(43)}`,
    keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  const model = processNfe(bytes).normalized!.document;
  if (model.kind !== "invoice") throw new Error("Expected invoice");
  await t.run((ctx) => ctx.db.patch("companies", scope.companyId, { cnpj: model.issuer.document }));
  const headers = {
    Authorization: `Bearer ${secret}`,
    "X-Environment": "sandbox",
    "Content-Type": "application/json",
  };
  async function request(path: string, method = "POST", body?: unknown, key = "first") {
    return t.fetch(path, {
      method,
      headers: { ...headers, "Idempotency-Key": key },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  }
  async function reserve(data = bytes, key = "first") {
    const response = await request(
      "/v1/imports",
      "POST",
      {
        companyId: scope.companyId,
        files: [
          {
            name: "nota.xml",
            size: data.length,
            sha256: createHash("sha256").update(data).digest("hex"),
          },
        ],
      },
      key,
    );
    expect(response.status).toBe(200);
    return (await response.json()).data as {
      importId: Id<"imports">;
      fileIds: Id<"importFiles">[];
      reused: boolean;
    };
  }
  async function upload(batch: Awaited<ReturnType<typeof reserve>>, data = bytes) {
    const response = await request(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/upload`,
    );
    expect(response.status).toBe(200);
    const ticket = (await response.json()).data as { token: string };
    return t.fetch("/v1/import-upload", {
      method: "POST",
      headers: { "X-Upload-Token": ticket.token },
      body: new Uint8Array(data),
    });
  }
  async function confirm(batch: Awaited<ReturnType<typeof reserve>>) {
    const response = await request(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/confirm`,
    );
    expect(response.status).toBe(200);
    return (await response.json()).data as { operationId: Id<"operations">; reused: boolean };
  }
  async function result(batch: Awaited<ReturnType<typeof reserve>>) {
    const response = await request(`/v1/imports/${batch.importId}`, "GET");
    expect(response.status).toBe(200);
    return (await response.json()).data as {
      files: Array<{
        code: string;
        state: string;
        result: string | null;
        documentId: string | null;
        versionId: string | null;
      }>;
    };
  }
  return { t, scope, bytes, request, reserve, upload, confirm, result, keyHash };
}

export async function completedImport() {
  const f = await fixture();
  const batch = await f.reserve(xmlFixture("invoice-authorized"));
  await f.upload(batch, xmlFixture("invoice-authorized"));
  const accepted = await f.confirm(batch);
  await f.t.action(internal.operationWorker.run, {
    operationId: accepted.operationId,
    generation: 1,
  });
  const owner = await person(f.t, f.scope.organizationId, "owner");
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const full = await owner.query(api.imports.get, { importId: batch.importId });
  const file = full.files[0]!;
  if (!file.versionId) throw new Error("Expected completed version");
  return {
    ...f,
    integration: f.scope,
    batch,
    owner,
    scope,
    full,
    detailArgs: { fileId: file.id, versionId: file.versionId, expectedScope: scope },
  };
}
