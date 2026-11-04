import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { capacityTotal } from "./lib/capacityCore";
import { EXPORT_WINDOW } from "./lib/organizationClosure";
import { PLATFORM_PLANS } from "./lib/planCatalog";
import { PURGE_ARCHIVE_WAIT } from "./organizationClosure";
import { actor, fixture } from "../../tests/helpers/export-fixture";
import {
  enablePix,
  person,
  platformTest,
  syntheticApiKey,
  usePlatformEnvironment,
} from "../../tests/helpers/platform";

/**
 * What an organization keeps in cold custody (ADR 0009, §§2-3), for each state of its run: the
 * revocations, the non-fiscal reads and the plan exception pass; fiscal reads and every other
 * write refuse `ORGANIZATION_ARCHIVED`, a public 409. Runs are written straight to the database:
 * freezing still refuses open organizations. Organizations, keys and addresses are synthetic.
 */
const NOW = Date.UTC(2026, 9, 29, 12);
const DAY = 86_400_000;
usePlatformEnvironment({
  siteUrl: "http://localhost:5207",
  convexSiteUrl: "http://127.0.0.1:3267",
  secret: "synthetic-cold-custody",
  now: NOW,
});
beforeEach(() => {
  vi.stubEnv("WEBHOOK_MODE", "https");
  vi.stubEnv("FNFE_WEBHOOK_MASTER_KEY", "cd".repeat(32));
});

type State = Doc<"coldArchiveRuns">["state"];
const CUSTODY: State[] = ["frozen", "sealed", "verified", "deleting", "archived", "restoring"];
const ARCHIVING: State[] = ["frozen", "sealed", "verified", "deleting", "restoring"];
const EVENTS = ["document.received"] as const;

type Fixture = Awaited<ReturnType<typeof custodyFixture>>;

function runFields(organizationId: Id<"organizations">, state: State) {
  return {
    organizationId,
    key: `synthetic-custody-${organizationId}`,
    version: 1,
    state,
    reason: "free_inactive" as const,
    noticeAt: NOW - 40 * DAY,
    eligibleAt: NOW - 10 * DAY,
    retainUntil: NOW + 365 * DAY,
    createdAt: NOW - 40 * DAY,
    updatedAt: NOW - DAY,
    phase: 0,
    cursor: null,
    rows: 0,
    files: 0,
    bytes: 0,
    digest: "",
    ...(state === "archived" ? { verifiedAt: NOW - 2 * DAY } : {}),
  };
}

/** The export fixture (a document imported by a key), with the reads and webhooks of §2. */
async function custodyFixture() {
  const f = await fixture();
  const scopes = ["documents:read", "documents:import", "companies:read", "webhooks:manage"];
  const endpointId = await f.t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    await ctx.db.patch("apiKeys", key._id, { scopes: scopes as typeof key.scopes });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { scopes: scopes as typeof grant.scopes });
    return ctx.db.insert("webhookEndpoints", {
      organizationId: f.scope.organizationId,
      projectId: f.scope.projectId,
      companyId: f.scope.companyId,
      environment: "sandbox",
      name: "Destino sintético",
      url: "https://receiver.example.com/webhook",
      events: [...EVENTS],
      active: true,
      version: 1,
      secretVersion: 1,
      secret: "",
      projectEpoch: 0,
      grantEpoch: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
  const owner = await actor(f, "owner");
  const runId = await f.t.run((ctx) =>
    ctx.db.insert("coldArchiveRuns", runFields(f.scope.organizationId, "notice")),
  );
  const enter = (state: State) =>
    f.t.run((ctx) => ctx.db.patch("coldArchiveRuns", runId, { state }));
  const endpoint = () =>
    f.t.run(async (ctx) => (await ctx.db.get("webhookEndpoints", endpointId))!);
  const json = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as { data?: unknown; error?: { code: string } },
  });
  return { ...f, endpointId, owner, runId, enter, endpoint, json };
}

/** One more key of the fixture's project, so each state revokes its own. */
function extraKey(f: Fixture) {
  return f.t.run(async (ctx) => {
    const { _id, _creationTime, ...key } = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    return ctx.db.insert("apiKeys", {
      ...key,
      keyHash: await hashApiKey(syntheticApiKey()),
      name: "Chave a revogar",
    });
  });
}
function certificate(f: Fixture) {
  return f.t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    return ctx.db.insert("certificates", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      version: 1,
      state: "active",
      uploaderId: "synthetic-custody",
      membershipId: key.creatorMembershipId,
      membershipVersion: 1,
      metadata: {
        fingerprint: crypto.randomUUID(),
        subject: "test",
        cnpj: "00000000000191",
        notBefore: NOW - DAY,
        notAfter: NOW + 60 * DAY,
      },
      envelope: {
        format: 1,
        keyVersion: "synthetic",
        pfx: new ArrayBuffer(0),
        password: new ArrayBuffer(0),
        wrappedKey: new ArrayBuffer(0),
      },
      envelopeRevision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
}
const stripeConfig = {
  market: "domestic" as const,
  description: "{itens}",
  invoices: true,
  checkouts: false,
  foreignWithoutNif: "hold" as const,
  refundPolicy: "notify" as const,
};
function connection(f: Fixture) {
  return f.t.run((ctx) =>
    ctx.db.insert("stripeConnections", {
      organizationId: f.scope.organizationId,
      projectId: f.scope.projectId,
      companyId: f.scope.companyId,
      environment: "sandbox",
      name: "Stripe sintético",
      active: true,
      config: stripeConfig,
      secret: "",
      projectEpoch: 0,
      grantEpoch: 0,
      version: 1,
      createdBy: "synthetic",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}
/** Another integration project with the fixture's company, to revoke its access. */
function integration(f: Fixture) {
  return f.t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    const projectId = await ctx.db.insert("projects", {
      organizationId: f.scope.organizationId,
      name: "Integração a revogar",
      externalReference: crypto.randomUUID(),
      state: "active",
      version: 1,
      accessEpoch: 0,
      creatorMembershipId: key.creatorMembershipId,
      creatorEpoch: 0,
      createdAt: NOW,
    });
    await ctx.db.insert("projectCompanies", {
      organizationId: f.scope.organizationId,
      projectId,
      companyId: f.scope.companyId,
      scopes: ["documents:read"],
      environments: ["sandbox"],
      active: true,
      version: 1,
      accessEpoch: 0,
    });
    return projectId;
  });
}
function invitation(f: Fixture) {
  return f.t.run(async (ctx) => {
    const issuer = (await ctx.db.get("apiKeys", f.scope.keyId))!.creatorMembershipId;
    return ctx.db.insert("invitations", {
      organizationId: f.scope.organizationId,
      email: `${crypto.randomUUID()}@development.invalid`,
      role: "viewer",
      tokenHash: crypto.randomUUID(),
      status: "pending",
      expiresAt: NOW + 3600_000,
      issuerMembershipId: issuer,
      issuerVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
}
async function editBody(f: Fixture, changes: Record<string, unknown> = {}) {
  const current = await f.endpoint();
  return {
    name: current.name,
    url: current.url,
    events: current.events,
    active: false,
    expectedVersion: current.version,
    ...changes,
  };
}

describe("Organização arquivada: o que continua permitido (ADR 0009, §2)", () => {
  it("revoga chave, credenciais, acessos, membros e convites pelo console em todo estado frio", async () => {
    const f = await custodyFixture();
    const client = f.owner.client;
    const org = f.scope.organizationId;
    for (const state of ["notice", ...CUSTODY] as State[]) {
      await f.enter(state);
      // Revoking a key or a credential is never blocked by the archive.
      const keyId = await extraKey(f);
      await client.mutation(api.keys.revoke, {
        organizationId: org,
        projectId: f.scope.projectId,
        keyId,
      });
      const certId = await certificate(f);
      await client.mutation(api.certificates.revoke, {
        organizationId: org,
        companyId: f.scope.companyId,
        id: certId,
      });
      // In the notice the usual path holds (it needs a declared company with an NFS-e profile).
      const connectionId = await connection(f);
      if (state !== "notice")
        await client.mutation(api.stripe.updateConnection, {
          connectionId,
          expectedVersion: 1,
          name: "Stripe sintético",
          config: stripeConfig,
          active: false,
        });
      const projectId = await integration(f);
      await client.mutation(api.projects.revokeCompany, {
        organizationId: org,
        projectId,
        companyId: f.scope.companyId,
        expectedVersion: 1,
      });
      const viewer = await actor(f, "viewer");
      await client.mutation(api.organizations.removeMember, {
        organizationId: org,
        membershipId: viewer.membershipId,
        expectedVersion: 1,
      });
      const invitationId = await invitation(f);
      await client.mutation(api.invitations.revoke, { organizationId: org, invitationId });
      // Withdrawing the capture release reaches its own rule, not the archive.
      await expect(
        client.mutation(api.captureRelease.disable, {
          organizationId: org,
          companyId: f.scope.companyId,
        }),
      ).rejects.toThrow("CAPTURE_RELEASE_NOT_RELEASED");
      const after = await f.t.run(async (ctx) => ({
        key: await ctx.db.get("apiKeys", keyId),
        cert: await ctx.db.get("certificates", certId),
        connection: await ctx.db.get("stripeConnections", connectionId),
        member: await ctx.db.get("memberships", viewer.membershipId),
        invitation: await ctx.db.get("invitations", invitationId),
        grant: await ctx.db
          .query("projectCompanies")
          .withIndex("by_projectId_and_companyId", (q) =>
            q.eq("projectId", projectId).eq("companyId", f.scope.companyId),
          )
          .unique(),
      }));
      expect(after.key?.revokedAt, state).not.toBeNull();
      expect(after.cert?.state, state).toBe("revoked");
      expect(after.connection?.active, state).toBe(state === "notice");
      expect(after.member?.state, state).toBe("removed");
      expect(after.invitation?.status, state).toBe("revoked");
      expect(after.grant?.active, state).toBe(false);
    }
  });

  it("lê o que não é fiscal no console e recusa escrita e leitura fiscal com ORGANIZATION_ARCHIVED", async () => {
    const f = await custodyFixture();
    const client = f.owner.client;
    const org = f.scope.organizationId;
    const page = { cursor: null, numItems: 10 };
    const scope = {
      organizationId: org,
      projectId: f.scope.projectId,
      companyId: f.scope.companyId,
      environment: "sandbox" as const,
    };
    for (const state of CUSTODY) {
      await f.enter(state);
      expect(
        (
          await client.query(api.organizations.members, {
            organizationId: org,
            contextKey: "k",
            paginationOpts: page,
          })
        ).page.length,
      ).toBeGreaterThan(0);
      expect(
        (
          await client.query(api.companies.list, {
            organizationId: org,
            contextKey: "k",
            paginationOpts: page,
          })
        ).page,
      ).toHaveLength(1);
      expect(
        await client.query(api.keys.list, {
          organizationId: org,
          projectId: f.scope.projectId,
          contextKey: "k",
          paginationOpts: page,
        }),
      ).toBeTruthy();
      expect(await client.query(api.webhooks.list, scope)).toHaveLength(1);
      expect(await client.query(api.archiveNotice.status, { organizationId: org })).toMatchObject({
        state,
        archivedAt: state === "archived" ? NOW - DAY : null,
      });
      await expect(
        client.query(api.consoleHome.summary, {
          organizationId: org,
          monthStart: NOW,
          asOf: NOW,
          contextKey: "k",
        }),
      ).rejects.toThrow("ORGANIZATION_ARCHIVED");
      await expect(
        client.mutation(api.projects.create, {
          organizationId: org,
          name: "Nova",
          externalReference: "nova",
        }),
      ).rejects.toThrow("ORGANIZATION_ARCHIVED");
      await expect(
        client.mutation(api.webhooks.test, { endpointId: f.endpointId, key: "synthetic-test-key" }),
      ).rejects.toThrow("ORGANIZATION_ARCHIVED");
      // The console keeps only switching an endpoint off and rotating its secret.
      const current = await f.endpoint();
      const edit = {
        endpointId: f.endpointId,
        expectedVersion: current.version,
        name: current.name,
        url: current.url,
        events: [...EVENTS],
      };
      await expect(client.mutation(api.webhooks.update, { ...edit, active: true })).rejects.toThrow(
        "ORGANIZATION_ARCHIVED",
      );
      await expect(
        client.mutation(api.webhooks.update, { ...edit, name: "Outro", active: false }),
      ).rejects.toThrow("ORGANIZATION_ARCHIVED");
      expect(await client.mutation(api.webhooks.update, { ...edit, active: false })).toMatchObject({
        active: false,
        version: current.version + 1,
      });
      const rotated = await client.mutation(api.webhooks.rotate, {
        endpointId: f.endpointId,
        expectedVersion: current.version + 1,
        overlapMs: 0,
      });
      expect(rotated.endpoint.secretVersion).toBe(current.secretVersion + 1);
      await expect(
        client.mutation(api.stripe.updateConnection, {
          connectionId: await connection(f),
          expectedVersion: 1,
          name: "Stripe sintético",
          config: stripeConfig,
          active: true,
        }),
      ).rejects.toThrow("ORGANIZATION_ARCHIVED");
      vi.advanceTimersByTime(61_000);
    }
  });

  it("REST: leituras não fiscais cobradas, desligar e rotacionar webhook; fiscal responde 409", async () => {
    const f = await custodyFixture();
    await f.t.mutation(internal.plans.configure, {
      enabled: true,
      expectedVersion: 0,
      filesBytes: 20 * 2 ** 30,
      databaseBytes: 2 * 2 ** 30,
      custodyCents: 100_000,
      freeMonthlyCents: 10_000,
      admissionsUntil: NOW + DAY,
      evidence: "synthetic-cold-custody",
    });
    await enablePix(f.t);
    await f.t.run((ctx) =>
      ctx.db.insert("usagePlans", {
        organizationId: f.scope.organizationId,
        catalogTier: "intermediate",
        name: "Plano sintético",
        startsAt: NOW - DAY,
        endsAt: NOW - 1,
        limits: { ...PLATFORM_PLANS.intermediate.limits },
        capacity: { ...PLATFORM_PLANS.intermediate.capacity },
        concurrency: 2,
        version: 1,
        updatedAt: NOW,
      }),
    );
    const reads = () =>
      f.t.run(
        async (ctx) =>
          (await capacityTotal(ctx, f.scope.organizationId, "restReads", Date.now()))?.committed ??
          0,
      );
    const company = f.scope.companyId;
    for (const state of CUSTODY) {
      await f.enter(state);
      const before = await reads();
      for (const path of [
        "/v1/companies",
        `/v1/companies/${company}`,
        "/v1/capabilities",
        `/v1/webhook-endpoints?companyId=${company}`,
      ]) {
        const answer = await f.json(await f.request(path));
        expect(answer.status, `${state} ${path}`).toBe(200);
      }
      expect(await reads(), state).toBe(before + 4);
      // Fiscal reads: the archive's own answer, never NOT_FOUND nor SCOPE_DENIED, and not charged.
      for (const path of [
        `/v1/documents/${f.documentId}?companyId=${company}`,
        `/v1/webhook-endpoints/${f.endpointId}`,
      ]) {
        const answer = await f.json(await f.request(path));
        expect(answer.status, `${state} ${path}`).toBe(409);
        expect(answer.body.error?.code).toBe("ORGANIZATION_ARCHIVED");
      }
      expect(await reads(), state).toBe(before + 4);
      const write = await f.json(
        await f.request(
          "/v1/imports",
          "POST",
          { companyId: company, files: [{ name: "nota.xml", size: 10, sha256: "0".repeat(64) }] },
          `cold-${state}`,
        ),
      );
      expect([write.status, write.body.error?.code]).toEqual([409, "ORGANIZATION_ARCHIVED"]);
      // PATCH only switches the endpoint off; any other field is refused.
      const renamed = await f.json(
        await f.request(
          `/v1/webhook-endpoints/${f.endpointId}`,
          "PATCH",
          await editBody(f, { name: "Outro" }),
        ),
      );
      expect([renamed.status, renamed.body.error?.code]).toEqual([409, "ORGANIZATION_ARCHIVED"]);
      const on = await f.json(
        await f.request(
          `/v1/webhook-endpoints/${f.endpointId}`,
          "PATCH",
          await editBody(f, { active: true }),
        ),
      );
      expect([on.status, on.body.error?.code]).toEqual([409, "ORGANIZATION_ARCHIVED"]);
      const off = await f.json(
        await f.request(`/v1/webhook-endpoints/${f.endpointId}`, "PATCH", await editBody(f)),
      );
      expect(off.status, state).toBe(200);
      expect(off.body.data).toMatchObject({ active: false });
      const version = (await f.endpoint()).version;
      const rotated = await f.json(
        await f.request(`/v1/webhook-endpoints/${f.endpointId}/rotate-secret`, "POST", {
          expectedVersion: version,
          overlapMs: 0,
        }),
      );
      expect(rotated.status, state).toBe(200);
      vi.advanceTimersByTime(61_000);
    }
  });

  it("chave de outra organização nunca usa essas exceções", async () => {
    const f = await custodyFixture();
    await f.enter("archived");
    const secret = syntheticApiKey("c");
    const other = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash: await hashApiKey(secret),
      suffix: crypto.randomUUID(),
    });
    const foreign = (path: string, method = "GET", body?: unknown) =>
      f.t.fetch(path, {
        method,
        headers: {
          Authorization: `Bearer ${secret}`,
          "X-Environment": "sandbox",
          "Idempotency-Key": "foreign-1",
          "Content-Type": "application/json",
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      });
    for (const [path, method, body] of [
      [`/v1/webhook-endpoints?companyId=${f.scope.companyId}`, "GET", undefined],
      [`/v1/webhook-endpoints/${f.endpointId}`, "PATCH", await editBody(f)],
      [
        `/v1/webhook-endpoints/${f.endpointId}/rotate-secret`,
        "POST",
        { expectedVersion: 1, overlapMs: 0 },
      ],
    ] as const) {
      const answer = await f.json(await foreign(path, method, body));
      expect([answer.status, answer.body.error?.code], path).toEqual([404, "NOT_FOUND"]);
    }
    expect((await f.endpoint()).active).toBe(true);
    // A member of the other organization reaches nothing of the archived one.
    const stranger = await person(f.t, other.organizationId, "owner");
    await expect(
      stranger.mutation(api.keys.revoke, {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        keyId: f.scope.keyId,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      stranger.mutation(api.webhooks.update, { endpointId: f.endpointId, ...(await editBody(f)) }),
    ).rejects.toThrow();
    expect((await f.endpoint()).active).toBe(true);
    expect((await f.t.run((ctx) => ctx.db.get("apiKeys", f.scope.keyId)))!.revokedAt).toBeNull();
  });
});

describe("Plano e encerramento em custódia (ADR 0009, §2)", () => {
  async function planOrganization() {
    const t = platformTest();
    await t.mutation(internal.plans.configure, {
      enabled: true,
      expectedVersion: 0,
      filesBytes: 20 * 2 ** 30,
      databaseBytes: 2 * 2 ** 30,
      custodyCents: 100_000,
      freeMonthlyCents: 10_000,
      admissionsUntil: NOW + DAY,
      evidence: "synthetic-cold-custody",
    });
    await enablePix(t);
    const organizationId = await t.run((ctx) =>
      ctx.db.insert("organizations", {
        name: "Custódia",
        slug: `custodia-${crypto.randomUUID().slice(0, 8)}`,
        ownerCount: 1,
        memberCount: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const owner = await person(t, organizationId, "owner");
    const runId = await t.run((ctx) =>
      ctx.db.insert("coldArchiveRuns", runFields(organizationId, "notice")),
    );
    return { t, organizationId, owner, runId };
  }

  it.each(ARCHIVING)("contratar plano em %s responde ORGANIZATION_ARCHIVING", async (state) => {
    const p = await planOrganization();
    await p.t.run((ctx) => ctx.db.patch("coldArchiveRuns", p.runId, { state }));
    await expect(
      p.owner.mutation(api.plans.requestPaid, {
        organizationId: p.organizationId,
        tier: "intermediate",
        key: "synthetic-request-1",
      }),
    ).rejects.toThrow("ORGANIZATION_ARCHIVING");
    await expect(
      p.owner.mutation(api.plans.claimFree, { organizationId: p.organizationId }),
    ).rejects.toThrow("ORGANIZATION_ARCHIVING");
  });

  it.each(["notice", "archived"] as State[])("contratar plano em %s é aceito", async (state) => {
    const p = await planOrganization();
    await p.t.run((ctx) => ctx.db.patch("coldArchiveRuns", p.runId, { state }));
    const request = await p.owner.mutation(api.plans.requestPaid, {
      organizationId: p.organizationId,
      tier: "intermediate",
      key: "synthetic-request-1",
    });
    expect(request.amountCents).toBe(PLATFORM_PLANS.intermediate.monthlyCents);
  });

  it.each(["deleting", "restoring"] as State[])(
    "encerramento pedido em %s é aceito e o expurgo espera o run",
    async (state) => {
      const p = await planOrganization();
      await p.t.run((ctx) => ctx.db.patch("coldArchiveRuns", p.runId, { state }));
      const slug = (await p.t.run((ctx) => ctx.db.get("organizations", p.organizationId)))!.slug;
      await p.owner.mutation(api.organizationClosure.close, {
        organizationId: p.organizationId,
        confirmation: slug,
      });
      const closure = () =>
        p.t.run(
          async (ctx) =>
            (await ctx.db
              .query("organizationClosures")
              .withIndex("by_organizationId", (q) => q.eq("organizationId", p.organizationId))
              .unique())!,
        );
      vi.setSystemTime(NOW + EXPORT_WINDOW + 1);
      const first = await closure();
      await p.t.mutation(internal.organizationClosure.purge, {
        closureId: first._id,
        generation: first.generation,
      });
      const waiting = await closure();
      expect(waiting.state).toBe("closing");
      expect(waiting.generation).toBe(first.generation + 1);
      expect(await p.t.run((ctx) => ctx.db.get("organizations", p.organizationId))).not.toBeNull();
      // Once the run settles, the next check purges.
      await p.t.run((ctx) => ctx.db.patch("coldArchiveRuns", p.runId, { state: "archived" }));
      vi.advanceTimersByTime(PURGE_ARCHIVE_WAIT);
      await p.t.mutation(internal.organizationClosure.purge, {
        closureId: first._id,
        generation: waiting.generation,
      });
      expect((await closure()).state).not.toBe("closing");
    },
  );
});
