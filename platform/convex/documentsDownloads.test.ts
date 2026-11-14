import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { api } from "./_generated/api";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { errorResponse } from "../../packages/contracts/src/external";
import { insertFiscal, patchFiscal } from "./lib/capacityCore";
import { insertOriginal } from "./lib/originalStore";
import { actor, documentsFixture } from "../../tests/helpers/documents";

/** Download tickets and originals: expiry, unknown tickets, integrity and limits. */
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5190",
    CONVEX_SITE_URL: "http://127.0.0.1:3239",
    BETTER_AUTH_SECRET: "synthetic-import-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("download tickets expire and membership removal invalidates issued tickets", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const viewer = await actor(f.t, f.scope.organizationId);
  const token = await viewer.client.mutation(api.documentDownloads.ticket, {
    ...f.queryScope,
    artifactId: imported.version.artifactId,
  });
  const request = () =>
    f.t.fetch("/v1/document-download", {
      headers: { Origin: "http://localhost:5190", "X-Download-Token": token.token },
    });
  expect((await request()).status).toBe(200);
  await f.t.run((ctx) => ctx.db.patch("memberships", viewer.membershipId, { state: "removed" }));
  expect((await request()).status).toBe(404);
  await expect(
    viewer.client.action(api.documentContentNode.documentDetailRead, {
      ...f.queryScope,
      documentId: imported.file.documentId!,
    }),
  ).rejects.toThrow();
  const owner = await actor(f.t, f.scope.organizationId),
    expiring = await owner.client.mutation(api.documentDownloads.ticket, {
      ...f.queryScope,
      artifactId: imported.version.artifactId,
    });
  vi.setSystemTime(Date.now() + 60_001);
  expect(
    (
      await f.t.fetch("/v1/document-download", {
        headers: { Origin: "http://localhost:5190", "X-Download-Token": expiring.token },
      })
    ).status,
  ).toBe(404);
});
it("ticket de download desconhecido, fora do console, de outro original ou com acesso trocado responde 404 sem auditar nem cobrar (#134)", async () => {
  const f = await documentsFixture(),
    other = await documentsFixture(f.t);
  const imported = await f.importXml(),
    foreign = await other.importXml();
  const owner = await actor(f.t, f.scope.organizationId);
  const issue = () =>
    owner.client.mutation(api.documentDownloads.ticket, {
      ...f.queryScope,
      artifactId: imported.version.artifactId,
    });
  const download = (token: string, origin = "http://localhost:5190", search = "") =>
    f.t.fetch(`/v1/document-download${search}`, {
      headers: { Origin: origin, "X-Download-Token": token },
    });
  const refused = async (response: Response) => {
    expect(response.status).toBe(404);
    expect(errorResponse.parse(await response.json()).error.code).toBe("NOT_FOUND");
  };
  const effects = () =>
    f.t.run(async (ctx) => ({
      audits: (await ctx.db.query("operationalAudit").collect()).filter(
        (row) => row.action === "http.documentDownload",
      ).length,
      charges: (await ctx.db.query("capacityEvents").collect()).filter(
        (row) => row.metric === "downloadsBytes",
      ).length,
    }));
  // Control: an intact ticket downloads, and that download is audited and charged.
  const ticket = await issue();
  expect((await download(ticket.token)).status).toBe(200);
  const before = await effects();
  expect(before.audits).toBeGreaterThan(0);
  expect(before.charges).toBeGreaterThan(0);

  await refused(await download("x".repeat(72)));
  await refused(await download(ticket.token, "https://exemplo.invalid"));
  await refused(await download(ticket.token, "http://localhost:5190", "?download=1"));
  // A ticket whose row names another organization's original.
  const swapped = await issue(),
    swappedHash = await hashApiKey(swapped.token);
  await f.t.run(async (ctx) => {
    const row = (await ctx.db
      .query("documentDownloads")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", swappedHash))
      .unique())!;
    await ctx.db.patch("documentDownloads", row._id, { artifactId: foreign.version.artifactId });
  });
  await refused(await download(swapped.token));
  // The member's access changed after the ticket was issued: still a manager, another version.
  const changed = await issue();
  await f.t.run((ctx) =>
    ctx.db.patch("memberships", owner.membershipId, { role: "admin", version: 2 }),
  );
  await refused(await download(changed.token));
  expect(await effects()).toEqual(before);
});
it("refuses to serve a hot original whose stored file no longer matches the recorded hash (#110)", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const artifactId = imported.version.artifactId;
  const artifact = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", artifactId)))!;
  // `patchFiscal` and `insertFiscal` refuse the originals' rows in the type and at runtime: only
  // `lib/originalStore.ts` writes them.
  await expect(
    f.t.run((ctx) =>
      // @ts-expect-error The XML originals' rows are written only by lib/originalStore.ts.
      patchFiscal(ctx, "documentArtifacts", artifactId, { sha256: "0".repeat(64) }),
    ),
  ).rejects.toThrow("ORIGINAL_WRITER");
  const { _id, _creationTime, ...copy } = artifact;
  await expect(
    f.t.run((ctx) =>
      // @ts-expect-error The XML originals' rows are written only by lib/originalStore.ts.
      insertFiscal(ctx, "documentArtifacts", copy),
    ),
  ).rejects.toThrow("ORIGINAL_WRITER");
  // Its single writer records only a hash and size that describe the stored file.
  await expect(
    f.t.run((ctx) =>
      insertOriginal(ctx, { ...copy, storageId: artifact.storageId!, sha256: "0".repeat(64) }),
    ),
  ).rejects.toThrow("INVALID_FILE");
  // Nor a hot row that carries a cold object's hash or size.
  for (const cold of [{ objectSha256: "0".repeat(64) }, { objectSize: artifact.size }])
    await expect(
      f.t.run((ctx) => insertOriginal(ctx, { ...copy, storageId: artifact.storageId!, ...cold })),
    ).rejects.toThrow("INVALID_FILE");

  // A file swapped under the row, same size and other bytes, by a write outside ingestion.
  const swapped = await f.t.run(async (ctx) => {
    const bytes = new Uint8Array(await (await ctx.storage.get(artifact.storageId!))!.arrayBuffer());
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 1;
    const storageId = await ctx.storage.store(new Blob([bytes]));
    await ctx.db.patch("documentArtifacts", artifactId, { storageId });
    return storageId;
  });
  expect(swapped).not.toBe(artifact.storageId);
  const charges = () =>
    f.t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("capacityEvents")
            .withIndex("by_organizationId_and_metric_and_key", (q) =>
              q.eq("organizationId", f.scope.organizationId).eq("metric", "downloadsBytes"),
            )
            .collect()
        ).length,
    );
  const before = await charges();
  const rest = await f.get(`/v1/document-artifacts/${artifactId}/original`);
  expect(rest.status).toBe(404);
  expect(errorResponse.parse(await rest.json()).error.code).toBe("ORIGINAL_UNAVAILABLE");
  const owner = await actor(f.t, f.scope.organizationId);
  const ticket = await owner.client.mutation(api.documentDownloads.ticket, {
    ...f.queryScope,
    artifactId,
  });
  const console = await f.t.fetch("/v1/document-download", {
    headers: { Origin: "http://localhost:5190", "X-Download-Token": ticket.token },
  });
  expect(console.status).toBe(404);
  expect(errorResponse.parse(await console.json()).error.code).toBe("ORIGINAL_UNAVAILABLE");
  // A refused download charges nothing.
  expect(await charges()).toBe(before);
  // A file of another size is refused the same way.
  await f.t.run(async (ctx) => {
    const bytes = await (await ctx.storage.get(artifact.storageId!))!.arrayBuffer();
    const storageId = await ctx.storage.store(new Blob([bytes, new Uint8Array([0x0a])]));
    await ctx.db.patch("documentArtifacts", artifactId, { storageId });
  });
  const longer = await f.get(`/v1/document-artifacts/${artifactId}/original`);
  expect(longer.status).toBe(404);
  expect(errorResponse.parse(await longer.json()).error.code).toBe("ORIGINAL_UNAVAILABLE");

  // The row back on its own file serves it again.
  await f.t.run((ctx) =>
    ctx.db.patch("documentArtifacts", artifactId, { storageId: artifact.storageId }),
  );
  expect((await f.get(`/v1/document-artifacts/${artifactId}/original`)).status).toBe(200);
});
it("limita downloads antes do storage e da auditoria, compartilhando o orçamento entre tickets", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const reader = await actor(f.t, f.scope.organizationId);
  const args = { ...f.queryScope, artifactId: imported.version.artifactId };
  const first = await reader.client.mutation(api.documentDownloads.ticket, args);
  const second = await reader.client.mutation(api.documentDownloads.ticket, args);
  const download = (token: string) =>
    f.t.fetch("/v1/document-download", {
      headers: { Origin: "http://localhost:5190", "X-Download-Token": token },
    });
  for (let i = 0; i < 60; i++) expect((await download(first.token)).status).toBe(200);
  const before = await f.t.run((ctx) => ctx.db.query("operationalAudit").collect());
  // If the handler reaches storage after saturation, it would report ORIGINAL_UNAVAILABLE.
  await f.t.run(async (ctx) => {
    const artifact = await ctx.db.get("documentArtifacts", imported.version.artifactId);
    await ctx.storage.delete(artifact!.storageId!);
  });
  for (let i = 0; i < 20; i++) {
    const denied = await download(second.token);
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("1");
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5190");
  }
  const after = await f.t.run((ctx) => ctx.db.query("operationalAudit").collect());
  expect(after).toHaveLength(before.length + 1);
  expect(after.at(-1)?.action).toBe("http.rateLimited");
  await f.t.run((ctx) => ctx.db.patch("memberships", reader.membershipId, { state: "removed" }));
  expect((await download(second.token)).status).toBe(404);
});
