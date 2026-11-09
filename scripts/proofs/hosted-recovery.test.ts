import { it, expect, vi } from "vite-plus/test";
import { recoverSeed } from "../lib/hosted-recover-seed.mjs";
import { prepareMonitorFixtures, assertMonitorSamples } from "../lib/hosted-monitor-drill.mjs";
import { OPERATION_SOURCES } from "../../platform/convex/lib/operationSources";

type Row = Record<string, unknown> & { _id: string };
function memoryStore(failAfter?: string) {
  const tables: Record<string, Row[]> = {};
  let serial = 0,
    interrupted = false;
  return {
    tables,
    async rows(table: string, _index: string, fields: Record<string, unknown>, limit: number) {
      return (tables[table] ?? [])
        .filter((r) => Object.entries(fields).every(([k, v]) => r[k] === v))
        .slice(0, limit);
    },
    async add(table: string, rows: Record<string, unknown>[]) {
      (tables[table] ??= []).push(...rows.map((r) => ({ ...r, _id: String(++serial) })));
      if (!interrupted && table === failAfter) {
        interrupted = true;
        throw new Error("lost response after commit");
      }
    },
    async remove(table: string, ids: string[]) {
      tables[table] = tables[table].filter((r) => !ids.includes(r._id));
    },
  };
}

it("removes all 1,000 partial documents before their versions when the original is reindexed first", async () => {
  const h = memoryStore();
  const key = (n: number) => "0".repeat(22) + String(n).padStart(22, "0");
  const fields = { companyId: "company", environment: "sandbox" };
  h.tables.fiscalDocuments = [
    { _id: "original", ...fields, fiscalKey: key(0) },
    ...Array.from({ length: 1000 }, (_, i) => ({
      _id: `doc-${i + 2}`,
      ...fields,
      fiscalKey: key(i + 2),
    })),
    { _id: "committed", ...fields, fiscalKey: key(1) },
  ];
  h.tables.documentVersions = [
    { _id: "original-version", artifactId: "artifact", code: "original" },
    ...Array.from({ length: 1000 }, (_, i) => ({
      _id: `v-${i + 2}`,
      artifactId: "artifact",
      code: `HOSTED_PROOF_${i + 2}`,
    })),
    { _id: "committed-version", artifactId: "artifact", code: "HOSTED_PROOF_1" },
  ];
  h.tables.documentListings = h.tables.fiscalDocuments.flatMap((d) =>
    Array.from({ length: 4 }, (_, i) => ({ _id: `${d._id}-${i}`, documentId: d._id })),
  );
  const remove = h.remove.bind(h);
  h.remove = async (table, ids) => {
    if (table === "documentVersions")
      expect(h.tables.fiscalDocuments.map((d) => d._id)).toEqual(["original", "committed"]);
    await remove(table, ids);
  };
  expect(
    await recoverSeed(h, {
      companyId: "company",
      seeded: 2,
      source: {
        doc: { _id: "original" },
        version: { _id: "original-version", artifactId: "artifact" },
      },
    }),
  ).toEqual({ removedPartialDocuments: 1000, removedPartialVersions: 1000, resumeAt: 2 });
  expect(h.tables.documentVersions.map((v) => v._id)).toEqual([
    "original-version",
    "committed-version",
  ]);
  expect(h.tables.documentListings).toHaveLength(8);
});

it.each(["projects", "webhookDeliveries", "operationalMonitors"])(
  "resumes preparation after a committed %s response is lost",
  async (table) => {
    const h = memoryStore(table);
    const state = {
      suffix: "hosted-proof",
      scopes: [
        {
          organizationId: "org",
          companyId: "company",
          projectId: "source",
          ownerMembershipId: "owner",
        },
      ],
      monitors: [] as string[],
      monitorProjects: [] as string[],
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(prepareMonitorFixtures(h, state, { version: 1 }, () => {})).rejects.toThrow(
        "lost response",
      );
      await prepareMonitorFixtures(h, state, { version: 1 }, () => {});
      expect(state.monitors).toHaveLength(20);
      expect(new Set(state.monitorProjects).size).toBe(20);
      expect(h.tables.projects).toHaveLength(20);
      expect(h.tables.operationalMonitors).toHaveLength(20);
      expect(h.tables.operations).toHaveLength(20 * 102);
      expect(h.tables.operationalFailures).toHaveLength(20 * OPERATION_SOURCES.length * 101);
      expect(h.tables.webhookEndpoints).toHaveLength(20 * 20);
      expect(h.tables.webhookDeliveries).toHaveLength(20 * 100);
      expect(h.tables.outboxEvents).toHaveLength(20);
      expect(h.tables.projectCompanies).toHaveLength(20);
    } finally {
      log.mockRestore();
    }
  },
);

it("checks baseline and bounded candidate samples without accepting the wrong mode", () => {
  const samples = (lease: number, source: number) => [
    {
      metrics: [
        { kind: "lease", value: lease, capped: true },
        {
          kind: "source",
          sources: OPERATION_SOURCES.map(() => ({ count: source, capped: true })),
        },
      ],
    },
  ];
  const limits = { lease: 1, source: 3 };
  expect(() => assertMonitorSamples(samples(101, 101), "baseline", limits)).not.toThrow();
  expect(() => assertMonitorSamples(samples(2, 4), "candidate", limits)).not.toThrow();
  expect(() =>
    assertMonitorSamples(samples(101, 101), "candidate", { lease: 100, source: 100 }),
  ).not.toThrow();
  expect(() => assertMonitorSamples(samples(2, 4), "baseline", limits)).toThrow();
  expect(() => assertMonitorSamples(samples(101, 101), "candidate", limits)).toThrow();
  expect(() => assertMonitorSamples([], "candidate", limits)).toThrow();
  // A monitor that skips a source, like the four-source reader before #111, fails the drill.
  const missing = samples(2, 4);
  missing[0]!.metrics[1]!.sources!.pop();
  expect(() => assertMonitorSamples(missing, "candidate", limits)).toThrow();
});
