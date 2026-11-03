import assert from "node:assert/strict";

export async function recoverSeed(h, scope) {
  assert.ok(Number.isSafeInteger(scope.seeded) && scope.seeded >= 1);
  const fields = { companyId: scope.companyId, environment: "sandbox" };
  let documents = 0,
    versions = 0;
  const pending = async () =>
    (
      await h.rows("fiscalDocuments", "by_companyId_environment_listedAt", fields, 1001, [
        "_id",
        "fiscalKey",
      ])
    ).filter(
      (d) => d._id !== scope.source.doc._id && Number(d.fiscalKey.slice(22)) >= scope.seeded,
    );
  // A reindexed original can occupy the first row of a 1,000-copy partial batch.
  for (;;) {
    const docs = await pending();
    if (!docs.length) break;
    for (const doc of docs) {
      const rows = await h.rows("documentListings", "by_documentId", { documentId: doc._id }, 8, [
        "_id",
      ]);
      if (rows.length)
        await h.remove(
          "documentListings",
          rows.map((r) => r._id),
        );
    }
    await h.remove(
      "fiscalDocuments",
      docs.map((d) => d._id),
    );
    documents += docs.length;
  }
  assert.equal((await pending()).length, 0);
  for (;;) {
    const rows = (
      await h.rows(
        "documentVersions",
        "by_artifactId",
        { artifactId: scope.source.version.artifactId },
        1001,
        ["_id", "code"],
      )
    ).filter(
      (v) =>
        v._id !== scope.source.version._id &&
        v.code.startsWith("HOSTED_PROOF_") &&
        Number(v.code.slice(13)) >= scope.seeded,
    );
    if (!rows.length) break;
    await h.remove(
      "documentVersions",
      rows.map((v) => v._id),
    );
    versions += rows.length;
  }
  return {
    removedPartialDocuments: documents,
    removedPartialVersions: versions,
    resumeAt: scope.seeded,
  };
}
