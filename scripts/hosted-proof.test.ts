import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, vi, afterEach } from "vite-plus/test";
import { hostedProof, assertSyntheticScope } from "./lib/hosted-proof.mjs";
import { seedMetadata } from "./lib/hosted-fixtures.mjs";

afterEach(() => vi.unstubAllEnvs());
it("keeps a concurrently reindexed original out of the synthetic batch", async () => {
  const key = (n: number) => "0".repeat(22) + String(n).padStart(22, "0");
  const add = vi.fn();
  const rows = vi
    .fn()
    .mockResolvedValueOnce([
      { _id: "version-1", code: "HOSTED_PROOF_1" },
      { _id: "version-2", code: "HOSTED_PROOF_2" },
    ])
    .mockResolvedValueOnce([
      { _id: "original", fiscalKey: key(0), createdAt: 1 },
      { _id: "copy-1", fiscalKey: key(1), createdAt: 2 },
      { _id: "copy-2", fiscalKey: key(2), createdAt: 3 },
    ]);
  await seedMetadata(
    { add, rows },
    { organizationId: "org", companyId: "company" },
    {
      doc: { _id: "original", fiscalKey: key(0), completeness: 1 },
      version: { _id: "source-version", artifactId: "artifact" },
    },
    1,
    2,
  );
  const listings = add.mock.calls.find(([table]) => table === "documentListings")![1] as {
    documentId: string;
  }[];
  expect(listings).toHaveLength(8);
  expect(new Set(listings.map((row) => row.documentId))).toEqual(new Set(["copy-1", "copy-2"]));
});
it("refuses a private checkpoint pointing at another organization's company or source", async () => {
  const state = { suffix: "hosted-79-80-00000000-0000-0000-0000-000000000000" };
  const scope = {
    suffix: `${state.suffix}-0`,
    organizationId: "ours",
    companyId: "company",
    projectId: "project",
    keyId: "key",
    keyHash: "hash",
    ownerMembershipId: "owner",
  };
  await expect(
    assertSyntheticScope(
      {
        query: async () => ({
          slug: scope.suffix,
          companyOrganization: "foreign",
          projectOrganization: "ours",
        }),
      },
      state,
      scope,
    ),
  ).rejects.toThrow();
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      slug: scope.suffix,
      companyOrganization: "ours",
      projectOrganization: "ours",
      keyOrganization: "ours",
      keyProject: "project",
      keyHash: "hash",
      keyCreator: "owner",
      projectCreator: "owner",
      ownerOrganization: "ours",
      ownerRole: "owner",
      ownerState: "active",
      ownerUser: scope.suffix,
    })
    .mockResolvedValueOnce({
      organizationId: "foreign",
      companyId: "company",
      versionId: "version",
      artifactId: "artifact",
    });
  await expect(
    assertSyntheticScope({ query }, state, {
      ...scope,
      source: { doc: { _id: "doc" }, version: { _id: "version", artifactId: "artifact" } },
    }),
  ).rejects.toThrow();
});
it("rejects another key from either a foreign organization or the same project", async () => {
  const state = { suffix: "hosted-79-80-00000000-0000-0000-0000-000000000000" };
  const scope = {
    suffix: `${state.suffix}-0`,
    organizationId: "ours",
    companyId: "company",
    projectId: "project",
    keyId: "key",
    keyHash: "hash",
    ownerMembershipId: "owner",
  };
  const valid = {
    slug: scope.suffix,
    companyOrganization: "ours",
    projectOrganization: "ours",
    keyOrganization: "ours",
    keyProject: "project",
    keyHash: "hash",
    keyCreator: "owner",
    projectCreator: "owner",
    ownerOrganization: "ours",
    ownerRole: "owner",
    ownerState: "active",
    ownerUser: scope.suffix,
  };
  await expect(
    assertSyntheticScope({ query: async () => valid }, state, scope),
  ).resolves.toBeUndefined();
  for (const change of [
    { keyOrganization: "foreign" },
    { keyProject: "other" },
    { keyHash: "other" },
    { keyCreator: "other" },
  ]) {
    await expect(
      assertSyntheticScope({ query: async () => ({ ...valid, ...change }) }, state, scope),
    ).rejects.toThrow();
  }
});
it("refuses production, another host and inherited deployment overrides before network IO", () => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-proof-"));
  const path = join(dir, "credential.json");
  const credential = {
    deploymentName: "modest-seal-118",
    deploymentType: "dev",
    url: "https://modest-seal-118.convex.cloud",
    adminKey: "synthetic-operator-credential",
  };
  try {
    for (const override of [
      { deploymentType: "prod" },
      { deploymentName: "elated-possum-295" },
      { url: "https://elated-possum-295.convex.cloud" },
    ]) {
      writeFileSync(path, JSON.stringify({ ...credential, ...override }), "utf8");
      expect(() => hostedProof(path)).toThrow();
    }
    writeFileSync(path, JSON.stringify(credential), "utf8");
    for (const variable of [
      "CONVEX_DEPLOY_KEY",
      "CONVEX_SELF_HOSTED_URL",
      "CONVEX_SELF_HOSTED_ADMIN_KEY",
    ]) {
      vi.stubEnv(variable, "unexpected");
      expect(() => hostedProof(path)).toThrow(`Remove inherited ${variable}`);
      vi.stubEnv(variable, "");
    }
    expect(hostedProof(path).target.deploymentName).toBe("modest-seal-118");
  } finally {
    rmSync(path);
    rmdirSync(dir);
  }
});
