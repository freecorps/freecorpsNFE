import { writeFile } from "node:fs/promises";
import { expect, it, vi } from "vite-plus/test";
import { internal } from "../_generated/api";
import { importAll, nfeWithItems } from "../../../tests/helpers/document-footprint";
import { nfseXml } from "../../../tests/helpers/nfse";
import { usePlatformEnvironment } from "../../../tests/helpers/platform";

usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-read-proof",
});

it("reads full fiscal fixtures, refuses foreign scope and damaged references", async () => {
  const fixtures = [];
  for (const [model, xml] of [
    ["55", nfeWithItems(1).full],
    ["nfse", Buffer.from(nfseXml([1, 2, 3]))],
  ] as const) {
    const { t } = await importAll([xml], { contentBlobs: true });
    const versions = await t.run((ctx) => ctx.db.query("documentVersions").collect());
    for (const version of versions) {
      await expect(
        t.action(internal.testing.documentReadProof.read, {
          versionId: version._id,
          inline: false,
        }),
      ).rejects.toThrow("SYNTHETIC_SCOPE");
      await expect(
        t.action(internal.testing.documentReadNodeProof.read, {
          versionId: version._id,
          inline: false,
        }),
      ).rejects.toThrow("SYNTHETIC_SCOPE");
      const content = await t.run(async (ctx) => {
        const op = (await ctx.db.get("operations", version.operationId))!;
        await ctx.db.patch("organizations", op.organizationId, { slug: "content642-test" });
        await ctx.db.patch("documentVersions", version._id, { processorVersion: "synthetic/1" });
        const items = await ctx.db
          .query("documentItems")
          .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
          .collect();
        const evidence = (await ctx.db.query("documentFiscalEvidence").collect()).find(
          (row) => row.versionId === version._id,
        );
        return {
          result: version.result,
          items: items.map((item) => item.data),
          ...(version.fiscalEvidence ? { fiscalEvidence: version.fiscalEvidence } : {}),
          ...(evidence ? { snapshot: evidence.snapshot } : {}),
        };
      });
      fixtures.push({ model, kind: version.kind, content });
      const args = { versionId: version._id, inline: false };
      const blob = JSON.parse(await t.action(internal.testing.documentReadProof.read, args));
      const inline = JSON.parse(
        await t.action(internal.testing.documentReadProof.read, { ...args, inline: true }),
      );
      const nodeRead = async (inline: boolean) =>
        JSON.parse(
          JSON.parse(
            await t.action(internal.testing.documentReadNodeProof.read, { ...args, inline }),
          ).payload,
        );
      expect((await nodeRead(false)).projection).toEqual(blob.projection);
      expect((await nodeRead(true)).projection).toEqual(inline.projection);
      expect(blob.projection).toEqual(inline.projection);
      expect(blob.source).toBe("blob");
      await t.mutation(internal.testing.documentReadProof.damage, {
        versionId: version._id,
        missing: false,
      });
      await expect(t.action(internal.testing.documentReadProof.read, args)).rejects.toThrow(
        "DOCUMENT_CONTENT_CORRUPT",
      );
      await expect(nodeRead(false)).rejects.toThrow("DOCUMENT_CONTENT_CORRUPT");
      await t.mutation(internal.testing.documentReadProof.damage, {
        versionId: version._id,
        missing: true,
      });
      await expect(t.action(internal.testing.documentReadProof.read, args)).rejects.toThrow(
        "BLOB_MISSING",
      );
      await expect(nodeRead(false)).rejects.toThrow("BLOB_MISSING");
      // With a missing blob, scope denial must still precede the storage error.
      const organizationId = await t.run(async (ctx) => {
        const op = (await ctx.db.get("operations", version.operationId))!;
        await ctx.db.patch("organizations", op.organizationId, { slug: "foreign-proof" });
        return op.organizationId;
      });
      await expect(nodeRead(false)).rejects.toThrow("SYNTHETIC_SCOPE");
      vi.stubEnv("APP_ENV", "installation");
      await expect(nodeRead(false)).rejects.toThrow(
        "Installation requires an explicit HTTPS origin",
      );
      vi.stubEnv("APP_ENV", "development");
      await t.run((ctx) =>
        ctx.db.patch("organizations", organizationId, { slug: "content642-test" }),
      );
      await t.run((ctx) =>
        ctx.db.patch("documentVersions", version._id, { contentStorageId: undefined }),
      );
      expect(
        JSON.parse(await t.action(internal.testing.documentReadProof.read, args)).projection,
      ).toEqual(inline.projection);
      expect((await nodeRead(false)).projection).toEqual(inline.projection);
      vi.stubEnv("APP_ENV", "installation");
      await expect(nodeRead(false)).rejects.toThrow();
      vi.stubEnv("APP_ENV", "development");
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  expect(fixtures.some((f) => f.content.snapshot && f.content.fiscalEvidence)).toBe(true);
  if (process.env.FNFE_READ_FIXTURES)
    await writeFile(process.env.FNFE_READ_FIXTURES, JSON.stringify(fixtures), "utf8");
}, 60_000);
