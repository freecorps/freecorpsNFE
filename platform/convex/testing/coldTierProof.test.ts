import { randomInt } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vite-plus/test";
import { internal } from "../_generated/api";
import { importAll } from "../../../tests/helpers/document-footprint";
import { usePlatformEnvironment } from "../../../tests/helpers/platform";

usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-cold-tier-proof",
});

const FIXTURE = "tests/fixtures/nfe/4.00/invoice-authorized.xml";

/**
 * The parsed content of the cold tier proofs (#689): the real import of the fixture XML gives
 * the `result` and items that `testing/coldTierProof:seed` stores, so the readers project the
 * synthetic notes as imported ones. With `FNFE_COLD_FIXTURE`, writes them for the runners.
 */
it("seeds proof notes from the parsed fixture and stores their phase B content", async () => {
  const xml = await readFile(FIXTURE);
  const { t } = await importAll([xml], { contentBlobs: true });
  const content = await t.run(async (ctx) => {
    const version = (await ctx.db.query("documentVersions").first())!;
    const items = await ctx.db
      .query("documentItems")
      .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
      .collect();
    return { result: version.result!, items: items.map((item) => item.data) };
  });
  expect(JSON.parse(content.result).document.kind).toBe("invoice");
  if (process.env.FNFE_COLD_FIXTURE)
    await writeFile(process.env.FNFE_COLD_FIXTURE, JSON.stringify(content), "utf8");

  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "0".repeat(64),
    suffix: "cold689-test",
  });
  const { keyId: _key, ...ids } = scope;
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(xml)])));
  const fiscalKey = () =>
    `${Array.from({ length: 20 }, () => randomInt(10)).join("")}55${Array.from({ length: 22 }, () => randomInt(10)).join("")}`;
  await expect(
    t.mutation(internal.testing.coldTierProof.seed, {
      ...ids,
      storageId,
      ageDays: 500,
      fiscalKey: "1".repeat(44),
      ...content,
    }),
  ).rejects.toThrow("COLD_PROOF_SCOPE");
  const key = fiscalKey();
  const seeded = await t.mutation(internal.testing.coldTierProof.seed, {
    ...ids,
    storageId,
    ageDays: 500,
    fiscalKey: key,
    ...content,
  });
  await t.mutation(internal.importProcessing.published, { operationId: seeded.operationId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const state = JSON.parse(
    await t.query(internal.testing.coldTierProof.inspect, {
      organizationId: scope.organizationId,
    }),
  );
  const note = state.notes.find((n: { documentId: string }) => n.documentId === seeded.documentId);
  expect(note.fiscalKey).toBe(key);
  expect(note.versions[0].contentStored).toBe(true);
  const read = JSON.parse(
    await t.action(internal.testing.coldTierProof.read, { documentId: seeded.documentId }),
  );
  expect(read).toMatchObject({
    contentTier: "hot",
    originalTier: "hot",
    items: content.items.length,
  });
}, 60_000);
