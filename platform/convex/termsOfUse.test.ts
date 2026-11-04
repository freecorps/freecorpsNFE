/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vite-plus/test";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { publicError } from "./lib/publicErrors";
import {
  person,
  platformTest,
  usePlatformEnvironment,
  type PlatformTest,
} from "../../tests/helpers/platform";

/**
 * Terms of use accepted in the console (#586). The archive is empty until D06; here each test
 * publishes synthetic versions (`publish`), to prove the flow before any text exists. The clock
 * stays still, because sessions and keys expire: a version in its notice entered the console
 * today, and one in effect entered it more than 30 days ago. Every organization, person and key
 * is synthetic.
 */
const terms = vi.hoisted(() => ({
  version: null as string | null,
  archive: {} as Record<string, { sha256: string; since: string }>,
}));
vi.mock("./lib/termsOfUseArchive", () => ({
  get TERMS_OF_USE_ARCHIVE() {
    return terms.archive;
  },
  get TERMS_OF_USE_VERSION() {
    return terms.version;
  },
}));

const FIRST = "termos-de-uso-a",
  SECOND = "termos-de-uso-b";
const hash = { [FIRST]: "a".repeat(64), [SECOND]: "b".repeat(64) };
/** Makes `version` current, entered in the console on `since`. */
function publish(version: typeof FIRST | typeof SECOND, since: string) {
  terms.archive = { ...terms.archive, [version]: { sha256: hash[version], since } };
  terms.version = version;
}
function reset() {
  terms.version = null;
  terms.archive = {};
}
// Today is 10/12/2026. Entered today: in effect on 09/01/2027, midnight in Brasília (03:00 UTC).
// Entered on 01/11/2026: in effect since 01/12/2026.
const TODAY = "2026-12-10",
  NOTICE_ENDS = Date.UTC(2027, 0, 9, 3),
  LONG_AGO = "2026-11-01",
  IN_EFFECT_SINCE = Date.UTC(2026, 11, 1, 3);

usePlatformEnvironment({
  siteUrl: "http://localhost:5207",
  convexSiteUrl: "http://127.0.0.1:3273",
  secret: "synthetic-terms-of-use-secret",
  now: Date.UTC(2026, 11, 10, 15),
});

const task = {
  name: "proof.import",
  workload: "import" as const,
  scope: "documents:import" as const,
  executor: "testing/operationTransport:execute",
  reconciler: "testing/operationTransport:reconcile",
  checkpoint: "testing/operationProof:checkpoint",
};

/** An organization from before the terms, with an owner, an admin, a viewer and an API key. */
async function existing(t: PlatformTest) {
  const keyHash = await hashApiKey(
    `fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "t")}`,
  );
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  const command = (key: string) =>
    t.mutation(internal.operations.reserve, {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      companyId: scope.companyId,
      environment: "sandbox",
      keyHash,
      key,
      request: '{"a":1}',
      task,
    });
  const owner = await person(t, scope.organizationId, "owner");
  const upload = (key: string) =>
    owner.mutation(api.imports.reserve, {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      environment: "sandbox",
      key,
      files: [{ name: "nota.xml", size: 10, sha256: "c".repeat(64) }],
    });
  const slug = (await t.run((ctx) => ctx.db.get("organizations", scope.organizationId)))!.slug;
  return {
    ...scope,
    slug,
    command,
    upload,
    owner,
    admin: await person(t, scope.organizationId, "admin"),
    viewer: await person(t, scope.organizationId, "viewer"),
  };
}
const acceptances = (t: PlatformTest, organizationId: Id<"organizations">) =>
  t.run((ctx) =>
    ctx.db
      .query("termsOfUseAcceptances")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .collect(),
  );

describe("Termos de uso no console (#586)", () => {
  it("sem versão em vigor, nada é pedido nem cortado", async () => {
    reset();
    const t = platformTest();
    const org = await existing(t);
    const creator = await person(t, org.organizationId, "viewer");
    expect(await creator.query(api.termsOfUse.current, {})).toBeNull();
    const created = await creator.mutation(api.organizations.create, {
      name: "Sem termos",
      slug: "sem-termos",
    });
    expect(await acceptances(t, created.organizationId)).toEqual([]);
    await expect(
      creator.mutation(api.organizations.create, {
        name: "Termos inventados",
        slug: "termos-inventados",
        termsOfUse: FIRST,
      }),
    ).rejects.toThrow("TERMS_OF_USE_OUTDATED");
    expect(
      await org.owner.query(api.termsOfUse.status, { organizationId: org.organizationId }),
    ).toEqual({ current: null, accepted: null, pending: null, canAccept: true });
    expect(
      await org.owner.query(api.organizations.context, { slug: org.slug, contextKey: "k" }),
    ).toMatchObject({ termsOfUse: null });
    await expect(
      org.owner.mutation(api.termsOfUse.accept, {
        organizationId: org.organizationId,
        terms: FIRST,
      }),
    ).rejects.toThrow("TERMS_OF_USE_OUTDATED");
    await expect(org.command("dormant")).resolves.toMatchObject({ reused: false });
    await expect(org.upload("dormant")).resolves.toMatchObject({ reused: false });
  });

  it("a organização nova nasce com o aceite do proprietário, a versão e o hash", async () => {
    reset();
    publish(FIRST, TODAY);
    const t = platformTest();
    const org = await existing(t);
    const creator = await person(t, org.organizationId, "viewer");
    expect(await creator.query(api.termsOfUse.current, {})).toEqual({
      version: FIRST,
      sha256: "a".repeat(64),
      since: Date.UTC(2026, 11, 10, 3),
      effectiveAt: NOTICE_ENDS,
    });
    for (const termsOfUse of [undefined, "termos-de-uso-antigos"])
      await expect(
        creator.mutation(api.organizations.create, {
          name: "Sem aceite",
          slug: "sem-aceite",
          ...(termsOfUse ? { termsOfUse } : {}),
        }),
      ).rejects.toThrow("TERMS_OF_USE_OUTDATED");
    // The refusal undoes the creation: the address stays free.
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("organizations")
          .withIndex("by_slug", (q) => q.eq("slug", "sem-aceite"))
          .unique(),
      ),
    ).toBeNull();
    const created = await creator.mutation(api.organizations.create, {
      name: "Com aceite",
      slug: "com-aceite",
      termsOfUse: FIRST,
    });
    const owner = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_organizationId_and_state", (q) =>
          q.eq("organizationId", created.organizationId).eq("state", "active"),
        )
        .unique(),
    );
    expect(await acceptances(t, created.organizationId)).toEqual([
      expect.objectContaining({
        membershipId: owner!._id,
        version: FIRST,
        sha256: "a".repeat(64),
        createdAt: Date.now(),
      }),
    ]);
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("organizationAudit")
          .withIndex("by_organizationId", (q) => q.eq("organizationId", created.organizationId))
          .collect(),
      ),
    ).toContainEqual(
      expect.objectContaining({ action: "organization.terms-accepted", target: FIRST }),
    );
    expect(
      await creator.query(api.termsOfUse.status, { organizationId: created.organizationId }),
    ).toEqual({
      current: expect.objectContaining({ version: FIRST }),
      accepted: {
        version: FIRST,
        sha256: "a".repeat(64),
        acceptedAt: Date.now(),
        acceptedBy: "Pessoa sintética",
      },
      pending: null,
      canAccept: true,
    });
    // Accepted at creation, it never becomes pending, in effect or not.
    publish(FIRST, LONG_AGO);
    expect(
      await creator.query(api.organizations.context, { slug: "com-aceite", contextKey: "k" }),
    ).toMatchObject({ termsOfUse: null });
  });

  it("a organização existente é avisada, perde só os comandos novos na vigência e volta com o aceite", async () => {
    reset();
    const t = platformTest();
    const org = await existing(t);
    const other = await existing(t);
    const before = await org.command("before");
    publish(FIRST, TODAY);
    expect(
      await org.viewer.query(api.organizations.context, { slug: org.slug, contextKey: "k" }),
    ).toMatchObject({ termsOfUse: { version: FIRST, effectiveAt: NOTICE_ENDS } });
    // During the notice nothing stops.
    await expect(org.command("notice")).resolves.toMatchObject({ reused: false });
    await expect(org.upload("notice")).resolves.toMatchObject({ reused: false });
    // In effect, new commands stop at every entry; an earlier request is still answered.
    publish(FIRST, LONG_AGO);
    await expect(org.command("cut")).rejects.toThrow("TERMS_OF_USE_REQUIRED");
    await expect(org.upload("cut")).rejects.toThrow("TERMS_OF_USE_REQUIRED");
    await expect(org.command("before")).resolves.toEqual({ ...before, reused: true });
    expect(publicError(new ConvexError({ code: "TERMS_OF_USE_REQUIRED" }))).toMatchObject({
      status: 403,
      error: { code: "SCOPE_DENIED", retryable: false },
    });
    // Reading goes on, for every role; only the owner accepts.
    expect(
      await org.viewer.query(api.termsOfUse.status, { organizationId: org.organizationId }),
    ).toEqual({
      current: expect.objectContaining({ version: FIRST }),
      accepted: null,
      pending: { version: FIRST, effectiveAt: IN_EFFECT_SINCE },
      canAccept: false,
    });
    for (const member of [org.admin, org.viewer])
      await expect(
        member.mutation(api.termsOfUse.accept, {
          organizationId: org.organizationId,
          terms: FIRST,
        }),
      ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      org.owner.mutation(api.termsOfUse.accept, {
        organizationId: org.organizationId,
        terms: "termos-de-uso-antigos",
      }),
    ).rejects.toThrow("TERMS_OF_USE_OUTDATED");
    // An owner of another organization reaches nothing here.
    await expect(
      other.owner.mutation(api.termsOfUse.accept, {
        organizationId: org.organizationId,
        terms: FIRST,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      other.owner.query(api.termsOfUse.status, { organizationId: org.organizationId }),
    ).rejects.toThrow("ACCESS_DENIED");
    for (let i = 0; i < 2; i++)
      expect(
        await org.owner.mutation(api.termsOfUse.accept, {
          organizationId: org.organizationId,
          terms: FIRST,
        }),
      ).toEqual({ version: FIRST });
    expect(await acceptances(t, org.organizationId)).toEqual([
      expect.objectContaining({ membershipId: org.owner.membershipId, version: FIRST }),
    ]);
    expect(await acceptances(t, other.organizationId)).toEqual([]);
    await expect(org.command("after")).resolves.toMatchObject({ reused: false });
    await expect(org.upload("after")).resolves.toMatchObject({ reused: false });
    // The name of who accepted goes to owners and admins only.
    expect(
      (await org.admin.query(api.termsOfUse.status, { organizationId: org.organizationId }))
        .accepted?.acceptedBy,
    ).toBe("Pessoa sintética");
    expect(
      (await org.viewer.query(api.termsOfUse.status, { organizationId: org.organizationId }))
        .accepted?.acceptedBy,
    ).toBeNull();
    await expect(other.command("other")).rejects.toThrow("TERMS_OF_USE_REQUIRED");
  });

  it("uma versão nova pede outro aceite, com 30 dias desde que entra no console", async () => {
    reset();
    publish(FIRST, LONG_AGO);
    const t = platformTest();
    const org = await existing(t);
    await org.owner.mutation(api.termsOfUse.accept, {
      organizationId: org.organizationId,
      terms: FIRST,
    });
    publish(SECOND, TODAY);
    expect(
      await org.owner.query(api.termsOfUse.status, { organizationId: org.organizationId }),
    ).toMatchObject({
      accepted: { version: FIRST },
      pending: { version: SECOND, effectiveAt: NOTICE_ENDS },
    });
    await expect(org.command("notice")).resolves.toMatchObject({ reused: false });
    publish(SECOND, LONG_AGO);
    await expect(org.command("cut")).rejects.toThrow("TERMS_OF_USE_REQUIRED");
    await org.owner.mutation(api.termsOfUse.accept, {
      organizationId: org.organizationId,
      terms: SECOND,
    });
    expect((await acceptances(t, org.organizationId)).map((row) => row.version)).toEqual([
      FIRST,
      SECOND,
    ]);
    await expect(org.command("after")).resolves.toMatchObject({ reused: false });
  });
});
