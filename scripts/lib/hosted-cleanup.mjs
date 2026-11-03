import assert from "node:assert/strict";

/** Removes only the generated metadata copies; original imports/audit remain for investigation. */
export async function cleanupHosted(h, state) {
  const report = {
    recordedAt: new Date().toISOString(),
    removed: { documentListings: 0, fiscalDocuments: 0, documentVersions: 0 },
    revokedKeys: 0,
    enabledMonitors: 0,
    deduplicatedOriginalListings: 0,
  };
  // Separate organizations have disjoint indexed ranges and document IDs.
  await Promise.all(
    state.scopes.map(async (s) => {
      const organization = await h.query(
        `return await ctx.db.get(${JSON.stringify(s.organizationId)});`,
      );
      assert.equal(organization.slug, s.suffix);
      assert.ok(s.suffix.startsWith(`${state.suffix}-`));
      await h.patch("apiKeys", [s.keyId], { revokedAt: Date.now() });
      report.revokedKeys++;
      const monitors = await h.rows(
        "operationalMonitors",
        "by_organizationId",
        { organizationId: s.organizationId },
        20,
      );
      for (const m of monitors)
        await h.patch("operationalMonitors", [m._id], {
          enabled: false,
          generation: m.generation + 1,
        });
      const targets = [
        [
          "documentListings",
          "by_companyId_environment_filterKey_date",
          { companyId: s.companyId, environment: "sandbox" },
          ["_id", "documentId"],
          (row) => row.documentId !== s.source.doc._id,
        ],
        [
          "fiscalDocuments",
          "by_companyId_environment_listedAt",
          { companyId: s.companyId, environment: "sandbox" },
          ["_id"],
          (row) => row._id !== s.source.doc._id,
        ],
        [
          "documentVersions",
          "by_artifactId",
          { artifactId: s.source.version.artifactId },
          ["_id", "code"],
          (row) => row._id !== s.source.version._id && row.code.startsWith("HOSTED_PROOF_"),
        ],
      ];
      for (const [table, index, fields, select, belongs] of targets) {
        for (;;) {
          // Larger system-deletion batches timed out on hosted validation. Versions
          // also contain XML projections, so keep every table within this bound.
          const batch = 1000;
          const rows = (await h.rows(table, index, fields, batch, select)).filter(belongs);
          if (!rows.length) break;
          const ids = rows.map((row) => row._id);
          // Disjoint IDs permit four bounded system calls per organization.
          // Finish all of them before selecting the next page.
          const removeBatch = async () => {
            const results = await Promise.allSettled(
              Array.from({ length: Math.ceil(ids.length / 250) }, (_, index) =>
                h.remove(table, ids.slice(index * 250, (index + 1) * 250)),
              ),
            );
            const failed = results.find((result) => result.status === "rejected");
            if (failed) throw failed.reason;
          };
          try {
            await removeBatch();
          } catch {
            // Administrative deletion is idempotent; retry one transient failure only.
            await removeBatch();
          }
          report.removed[table] += rows.length;
          if (report.removed[table] % 20000 < batch)
            console.log(JSON.stringify({ table, removedThisPass: report.removed[table] }));
        }
        console.log(JSON.stringify({ table, removed: report.removed[table] }));
      }
      // An early seed runner could observe the original moving to the head of listedAt.
      // Retain one identical projection per filter and remove only redundant synthetic rows.
      const originals = await h.rows(
        "documentListings",
        "by_documentId",
        { documentId: s.source.doc._id },
        100,
      );
      assert.ok(originals.length < 100);
      const seen = new Set(),
        redundant = [];
      for (const row of originals.toSorted((a, b) => a._creationTime - b._creationTime)) {
        assert.equal(row.companyId, s.companyId);
        assert.equal(row.environment, "sandbox");
        assert.equal(row.date, s.source.doc.createdAt);
        if (seen.has(row.filterKey)) redundant.push(row._id);
        else seen.add(row.filterKey);
      }
      assert.equal(seen.size, 4);
      if (redundant.length) await h.remove("documentListings", redundant);
      report.deduplicatedOriginalListings += redundant.length;
      const docs = await h.rows(
        "fiscalDocuments",
        "by_companyId_environment_listedAt",
        { companyId: s.companyId, environment: "sandbox" },
        2,
        ["_id"],
      );
      assert.deepEqual(
        docs.map((d) => d._id),
        [s.source.doc._id],
      );
      const retired = await h.rows(
        "operationalMonitors",
        "by_organizationId",
        { organizationId: s.organizationId },
        20,
      );
      report.enabledMonitors += retired.filter((m) => m.enabled).length;
    }),
  );
  assert.equal(report.enabledMonitors, 0);
  report.result = "passed";
  report.removedCountScope =
    "This invocation only; an interrupted cleanup may have removed earlier batches. Final original-only document check is authoritative.";
  report.retained =
    "Original synthetic imports, operations, monitor samples and audit. Keys revoked; monitor chains fenced. Existing unrelated records untouched.";
  return report;
}
