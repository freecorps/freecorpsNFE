/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, components, internal } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import { fixture } from "./helpers/export-fixture";
import { consoleProjectFor } from "./helpers/console";

/**
 * "Console sem projeto" (ADR 0005): people work on the company with their membership, their
 * access to the company and their role, without a project or its grant. API keys keep needing
 * the grant. The matrix below runs every console domain against the same set of actors.
 */
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5202",
    CONVEX_SITE_URL: "http://127.0.0.1:3262",
    BETTER_AUTH_SECRET: "synthetic-console-access",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type F = Awaited<ReturnType<typeof fixture>>;
type Role = "owner" | "admin" | "operator" | "viewer" | "developer";

async function login(f: F) {
  const now = Date.now();
  const user = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Pessoa sintética",
        email: `${crypto.randomUUID()}@development.invalid`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        expiresAt: now + 3600_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return { user, client: f.t.withIdentity({ subject: user._id, sessionId: session._id }) };
}
async function member(
  f: F,
  role: Role,
  options: { organizationId?: Id<"organizations">; company?: boolean } = {},
) {
  const { user, client } = await login(f);
  const organizationId = options.organizationId ?? f.scope.organizationId;
  const ids = await f.t.run(async (ctx) => {
    const membershipId = await ctx.db.insert("memberships", {
      organizationId,
      authUserId: user._id,
      name: user.name,
      email: user.email,
      role,
      state: "active",
      version: 1,
      joinedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const grantId =
      options.company === false
        ? null
        : await ctx.db.insert("companyGrants", {
            organizationId,
            companyId: f.scope.companyId,
            membershipId,
            membershipEpoch: 0,
            active: true,
            version: 1,
            updatedAt: Date.now(),
          });
    return { membershipId, grantId };
  });
  return { client, ...ids };
}

function code(promise: Promise<unknown>) {
  return promise.then(
    () => "OK",
    (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
  );
}

async function actors(f: F) {
  const otherOrganizationId = await f.t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: "Outra organização",
      slug: `outra-${crypto.randomUUID()}`,
      ownerCount: 1,
      memberCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  const otherOwner = await member(f, "owner", {
    organizationId: otherOrganizationId,
    company: false,
  });
  const removed = await member(f, "operator");
  const revoked = await member(f, "operator");
  await f.t.run(async (ctx) => {
    await ctx.db.patch("memberships", removed.membershipId, { state: "removed", version: 2 });
    await ctx.db.patch("companyGrants", revoked.grantId!, { active: false, version: 2 });
  });
  return {
    owner: await member(f, "owner", { company: false }),
    admin: await member(f, "admin", { company: false }),
    operator: await member(f, "operator"),
    viewer: await member(f, "viewer"),
    developer: await member(f, "developer"),
    /** Operator of the organization without access to this company. */
    outsider: await member(f, "operator", { company: false }),
    /** Owner of another organization: its session has no membership here. */
    otherOrganization: otherOwner,
    /** Verified login with no membership at all. */
    noMembership: await login(f),
    removed,
    revoked,
  };
}
type Actors = Awaited<ReturnType<typeof actors>>;
type Client = Actors["owner"]["client"];

/**
 * Expected answer per actor. `pass` stands for the exact answer of an authorized call, given
 * per check (`OK`, or the domain refusal that only comes after the access check).
 */
const READ = {
  owner: "pass",
  admin: "pass",
  operator: "pass",
  viewer: "pass",
  developer: "SCOPE_DENIED",
  outsider: "NOT_FOUND",
  otherOrganization: "ACCESS_DENIED",
  noMembership: "ACCESS_DENIED",
  removed: "ACCESS_DENIED",
  revoked: "NOT_FOUND",
} as const satisfies Record<keyof Actors, string>;
const WRITE = { ...READ, viewer: "SCOPE_DENIED" } as const;
/**
 * Records that already have a project (a batch, an operation): a developer is answered through
 * the integrations it manages, so a record it does not manage is `NOT_FOUND`.
 */
const RECORD_READ = { ...READ, developer: "NOT_FOUND" } as const;
const RECORD_WRITE = { ...WRITE, developer: "NOT_FOUND" } as const;
/** A record of an integration project: people with a writing role are sent to the integration. */
const INTEGRATION_WRITE = {
  ...RECORD_WRITE,
  owner: "INTEGRATION_RECORD",
  admin: "INTEGRATION_RECORD",
  operator: "INTEGRATION_RECORD",
} as const;

async function matrix(
  all: Actors,
  expected: Record<keyof Actors, string>,
  call: (client: Client) => Promise<unknown>,
  authorized = "OK",
) {
  const answers: Record<string, string> = {};
  const wanted: Record<string, string> = {};
  for (const name of Object.keys(expected) as Array<keyof Actors>) {
    answers[name] = await code(call(all[name].client));
    wanted[name] = expected[name] === "pass" ? authorized : expected[name];
  }
  expect(answers).toEqual(wanted);
}
/** A boolean query as an answer of the matrix: `false` becomes `FALSE`. */
const truthy = (promise: Promise<boolean>) =>
  promise.then((value) => {
    if (!value) throw { data: { code: "FALSE" } };
  });

describe("console sem projeto: matriz de acesso por domínio", () => {
  async function setup() {
    const f = await fixture();
    const all = await actors(f);
    const scope = {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox" as const,
    };
    // The integration loses its grant entirely: nothing below depends on it.
    await f.t.run(async (ctx) => {
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
        )
        .unique())!;
      await ctx.db.patch("projectCompanies", grant._id, { active: false });
    });
    return { f, all, scope };
  }

  it("contexto da empresa", async () => {
    const { f, all } = await setup();
    const context = (client: Client) =>
      client.query(api.consoleCompany.context, {
        organizationId: f.scope.organizationId,
        company: f.scope.companyId,
        contextKey: "matriz",
      });
    expect(await context(all.owner.client)).toMatchObject({
      canRead: true,
      canWrite: true,
      canManage: true,
    });
    expect(await context(all.operator.client)).toMatchObject({ canWrite: true, canManage: false });
    expect(await context(all.viewer.client)).toMatchObject({ canRead: true, canWrite: false });
    expect(await context(all.developer.client)).toMatchObject({ canRead: false, canWrite: false });
    expect(await context(all.outsider.client)).toBeNull();
    expect(await context(all.revoked.client)).toBeNull();
    expect(await code(context(all.removed.client))).toBe("ACCESS_DENIED");
    expect(await code(context(all.noMembership.client))).toBe("ACCESS_DENIED");
  });

  it("empresa única: a mesma resposta de contexto, só com uma empresa acessível", async () => {
    const { f, all } = await setup();
    const sole = (client: Client, organizationId = f.scope.organizationId) =>
      client.query(api.consoleCompany.sole, { organizationId, contextKey: "matriz" });
    const context = (client: Client) =>
      client.query(api.consoleCompany.context, {
        organizationId: f.scope.organizationId,
        company: f.scope.companyId,
        contextKey: "matriz",
      });
    // One company in the organization: whoever can open it gets exactly what `context` answers.
    for (const name of ["owner", "admin", "operator", "viewer", "developer"] as const) {
      const answer = await sole(all[name].client);
      expect(answer?.id).toBe(f.scope.companyId);
      expect(answer).toEqual(await context(all[name].client));
    }
    // Without access to it, nothing: no grant, a revoked grant.
    expect(await sole(all.outsider.client)).toBeNull();
    expect(await sole(all.revoked.client)).toBeNull();
    // Another organization's owner, a login without membership and a removed member are refused.
    for (const name of ["otherOrganization", "noMembership", "removed"] as const)
      expect(await code(sole(all[name].client))).toBe("ACCESS_DENIED");

    // The other organization's owner asking for its own (empty) organization sees nothing here.
    const otherOrganizationId = await f.t.run(async (ctx) => {
      const membership = (await ctx.db.get("memberships", all.otherOrganization.membershipId))!;
      return membership.organizationId;
    });
    expect(await sole(all.otherOrganization.client, otherOrganizationId)).toBeNull();

    // A grant row pointing at another organization's company is not an answer: the outsider gets
    // a forged grant to a company of the other organization and still sees nothing.
    /** Another company like the fixture's, with the fields that set it apart. */
    const copyCompany = (fields: { organizationId?: Id<"organizations">; cnpj: string }) =>
      f.t.run(async (ctx) => {
        const { _id, _creationTime, ...company } = (await ctx.db.get(
          "companies",
          f.scope.companyId,
        ))!;
        return ctx.db.insert("companies", { ...company, ...fields });
      });
    const foreignCompanyId = await copyCompany({
      organizationId: otherOrganizationId,
      cnpj: "11222333000181",
    });
    await f.t.run(async (ctx) => {
      await ctx.db.insert("companyGrants", {
        organizationId: f.scope.organizationId,
        companyId: foreignCompanyId,
        membershipId: all.outsider.membershipId,
        membershipEpoch: 0,
        active: true,
        version: 1,
        updatedAt: Date.now(),
      });
    });
    expect(await sole(all.outsider.client)).toBeNull();

    // A second company: managers have a choice to make; a member with access to only one of them
    // keeps it, and with access to both has a choice too.
    const secondCompanyId = await copyCompany({ cnpj: "11444777000161" });
    expect(await sole(all.owner.client)).toBeNull();
    expect(await sole(all.admin.client)).toBeNull();
    expect((await sole(all.operator.client))?.id).toBe(f.scope.companyId);
    await f.t.run((ctx) =>
      ctx.db.insert("companyGrants", {
        organizationId: f.scope.organizationId,
        companyId: secondCompanyId,
        membershipId: all.operator.membershipId,
        membershipEpoch: 0,
        active: true,
        version: 1,
        updatedAt: Date.now(),
      }),
    );
    expect(await sole(all.operator.client)).toBeNull();
    // The outsider is granted only the second one: that is its company.
    await f.t.run((ctx) =>
      ctx.db.insert("companyGrants", {
        organizationId: f.scope.organizationId,
        companyId: secondCompanyId,
        membershipId: all.outsider.membershipId,
        membershipEpoch: 0,
        active: true,
        version: 1,
        updatedAt: Date.now(),
      }),
    );
    expect((await sole(all.outsider.client))?.id).toBe(secondCompanyId);
  });

  it("importação de XML: lê tudo da empresa, escreve só no lote do console", async () => {
    const { f, all, scope } = await setup();
    await matrix(all, READ, (client) => client.query(api.imports.recent, scope));
    const files = [{ name: "nota.xml", size: 10, sha256: "a".repeat(64) }];
    await matrix(all, WRITE, (client) =>
      client.mutation(api.imports.reserve, { ...scope, key: crypto.randomUUID(), files }),
    );
    // A console batch: writers upload and confirm; confirming before the bytes is refused only
    // after the access check.
    const own = await all.owner.client.mutation(api.imports.reserve, {
      ...scope,
      key: "matriz",
      files,
    });
    const fileId = own.fileIds[0]!;
    await matrix(all, READ, (client) =>
      client.query(api.imports.selected, { ...scope, batch: own.importId }).then((row) => {
        if (!row) throw { data: { code: "NOT_FOUND" } };
      }),
    );
    await matrix(all, RECORD_READ, (client) =>
      client.query(api.imports.get, { importId: own.importId }),
    );
    await matrix(all, RECORD_WRITE, (client) => client.mutation(api.imports.upload, { fileId }));
    await matrix(
      all,
      RECORD_WRITE,
      (client) => client.mutation(api.imports.confirm, { fileId }),
      "UPLOAD_EXPIRED",
    );
    await matrix(all, RECORD_WRITE, (client) => client.mutation(api.imports.cancel, { fileId }));
    // The integration's batch (from the fixture): readable, never writable by people.
    const batch = await f.t.run(async (ctx) => {
      const row = (
        await ctx.db
          .query("imports")
          .withIndex("by_organizationId_and_companyId_and_environment", (q) =>
            q
              .eq("organizationId", f.scope.organizationId)
              .eq("companyId", f.scope.companyId)
              .eq("environment", "sandbox"),
          )
          .collect()
      ).find((row) => row.projectId === f.scope.projectId)!;
      const file = (await ctx.db
        .query("importFiles")
        .withIndex("by_importId", (q) => q.eq("importId", row._id))
        .first())!;
      const version = await ctx.db
        .query("documentVersions")
        .withIndex("by_operationId_entryIndex", (q) =>
          q.eq("operationId", file.operationId!).eq("entryIndex", undefined),
        )
        .unique();
      return { id: row._id, fileId: file._id, versionId: version!._id };
    });
    await matrix(all, RECORD_READ, (client) =>
      client.query(api.imports.get, { importId: batch.id }),
    );
    await matrix(all, RECORD_READ, (client) =>
      client.query(api.contentRead.importDetailToken, {
        fileId: batch.fileId,
        versionId: batch.versionId,
        expectedScope: scope,
      }),
    );
    await matrix(all, RECORD_READ, (client) =>
      client.action(api.documentContentNode.importDetailRead, {
        fileId: batch.fileId,
        versionId: batch.versionId,
        expectedScope: scope,
      }),
    );
    const integration = INTEGRATION_WRITE;
    await matrix(all, integration, (client) =>
      client.mutation(api.imports.upload, { fileId: batch.fileId }),
    );
    await matrix(all, integration, (client) =>
      client.mutation(api.imports.confirm, { fileId: batch.fileId }),
    );
    await matrix(all, integration, (client) =>
      client.mutation(api.imports.cancel, { fileId: batch.fileId }),
    );
    await matrix(all, integration, (client) =>
      client.mutation(api.importProcessing.reprocess, { fileId: batch.fileId, key: "matriz" }),
    );
  });

  it("consulta de documentos, downloads e exportação", async () => {
    const { f, all, scope } = await setup();
    const documentId = f.documentId;
    const doc = { ...scope, documentId };
    const page = { cursor: null, limit: 10 };
    await matrix(all, READ, (client) => client.query(api.documents.list, { ...scope, ...page }));
    await matrix(all, READ, (client) =>
      client.action(api.documentContentNode.documentDetailRead, doc),
    );
    // The reactive token of each B6 reader answers to exactly the same roles as its action.
    await matrix(all, READ, (client) => client.query(api.contentRead.documentDetailToken, doc));
    const detail = await all.viewer.client.action(api.documentContentNode.documentDetailRead, doc);
    await matrix(all, READ, (client) =>
      client.query(api.contentRead.documentItemsToken, {
        ...doc,
        ...page,
        versionId: detail.version.id,
      }),
    );
    await matrix(all, READ, (client) =>
      client.query(api.contentRead.documentVersionsToken, { ...doc, ...page }),
    );
    await matrix(all, READ, (client) =>
      client.action(api.documentContentNode.documentItemsRead, {
        ...doc,
        ...page,
        versionId: detail.version.id,
      }),
    );
    await matrix(all, READ, (client) =>
      client.action(api.documentContentNode.documentVersionsRead, { ...doc, ...page }),
    );
    await matrix(all, READ, (client) => client.query(api.documents.files, { ...doc, ...page }));
    await matrix(all, READ, (client) =>
      client.query(api.documents.unclassified, { ...scope, ...page }),
    );
    await matrix(all, READ, (client) => client.query(api.documents.unclassifiedCount, scope));
    await matrix(all, { ...READ, viewer: "FALSE" }, (client) =>
      truthy(client.query(api.documents.canProcess, scope)),
    );
    await matrix(all, READ, (client) =>
      client.mutation(api.documentDownloads.ticket, {
        ...scope,
        artifactId: detail.version.artifactId,
      }),
    );
    // Exports are limited per organization (two running, two a minute): free the budget.
    const freeExports = () =>
      f.t.run(async (ctx) => {
        for (const job of await ctx.db.query("documentExports").collect())
          if (job.state === "running")
            await ctx.db.patch("documentExports", job._id, { state: "failed" });
      });
    await matrix(all, READ, async (client) => {
      await freeExports();
      vi.setSystemTime(Date.now() + 61_000);
      return client.mutation(api.exports.create, {
        organizationId: scope.organizationId,
        selection: { kind: "document", companyId: scope.companyId, documentId },
        key: crypto.randomUUID(),
      });
    });
    // The document is the company's: people with a writing role reprocess and rebuild it.
    await matrix(all, WRITE, (client) =>
      client.mutation(api.documents.reprocess, { ...doc, key: crypto.randomUUID() }),
    );
    await matrix(all, WRITE, (client) => client.mutation(api.documents.rebuild, doc));
  });

  it("emissão NFS-e", async () => {
    const { all, scope } = await setup();
    await matrix(all, READ, (client) =>
      client.query(api.issuanceConsole.list, {
        ...scope,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    );
    // The demonstration company answers after the access check, never before.
    await matrix(
      all,
      WRITE,
      (client) =>
        client.mutation(api.issuanceConsole.request, {
          ...scope,
          idempotencyKey: crypto.randomUUID(),
          input: {
            activityCode: "licenca",
            competence: "2026-10",
            issuerEmail: "fiscal@prestador.example",
            market: "domestic",
            taker: {
              kind: "national",
              document: "11.444.777/0001-61",
              name: "Tomador Sintético Ltda",
              address: {
                municipalityCode: "3550308",
                postalCode: "01001-000",
                street: "Praça da Sé",
                number: "100",
                district: "Sé",
              },
            },
            description: "Licença de uso de software",
            amount: { currency: "BRL", value: "1000" },
            issRate: "2.5",
            issWithheld: false,
          },
        }),
      "ISSUANCE_DEMONSTRATION_DENIED",
    );
  });

  it("captura de NF-e: lê a da empresa, controla só a do console", async () => {
    const { f, all, scope } = await setup();
    await matrix(all, READ, (client) => client.query(api.captures.get, scope));
    await matrix(
      all,
      WRITE,
      (client) => client.mutation(api.captures.activate, scope),
      "CAPTURE_DEMONSTRATION_DENIED",
    );
    const stream = async (projectId: Id<"projects">) =>
      f.t.run(async (ctx) => {
        const existing = await ctx.db
          .query("captureStreams")
          .withIndex("by_companyId_environment", (q) =>
            q.eq("companyId", f.scope.companyId).eq("environment", "sandbox"),
          )
          .unique();
        if (existing) await ctx.db.delete("captureStreams", existing._id);
        return ctx.db.insert("captureStreams", {
          organizationId: f.scope.organizationId,
          projectId,
          companyId: f.scope.companyId,
          environment: "sandbox",
          identity: "00000000000191",
          service: "nfe-distribution",
          version: 1,
          state: "paused",
          checkpoint: "000000000000000",
          mode: "distNSU",
          nextAllowedAt: 0,
          received: 0,
          createdAt: Date.now(),
        });
      });
    const version = async (id: Id<"captureStreams">) =>
      (await f.t.run((ctx) => ctx.db.get("captureStreams", id)))!.version;
    const integration = await stream(f.scope.projectId);
    await matrix(all, READ, (client) => client.query(api.captures.get, scope));
    await matrix(
      all,
      {
        ...WRITE,
        owner: "INTEGRATION_RECORD",
        admin: "INTEGRATION_RECORD",
        operator: "INTEGRATION_RECORD",
      },
      async (client) =>
        client.mutation(api.captures.control, {
          ...scope,
          action: "pause",
          expectedVersion: await version(integration),
        }),
    );
    const own = await stream(await consoleProjectFor(f.t, f.scope.organizationId));
    await matrix(all, WRITE, async (client) =>
      client.mutation(api.captures.control, {
        ...scope,
        action: "pause",
        expectedVersion: await version(own),
      }),
    );
    // Releasing for a transfer is for managers only, checked before anything else.
    const managers = {
      owner: "pass",
      admin: "pass",
      operator: "ACCESS_DENIED",
      viewer: "ACCESS_DENIED",
      developer: "ACCESS_DENIED",
      outsider: "ACCESS_DENIED",
      otherOrganization: "ACCESS_DENIED",
      noMembership: "ACCESS_DENIED",
      removed: "ACCESS_DENIED",
      revoked: "ACCESS_DENIED",
    };
    await matrix(all, managers, async (client) =>
      client.mutation(api.captures.release, { ...scope, expectedVersion: await version(own) }),
    );
  });

  it("consulta cadastral", async () => {
    const { f, all, scope } = await setup();
    const cnpj = await f.t.run(
      async (ctx) => (await ctx.db.get("companies", f.scope.companyId))!.cnpj,
    );
    await matrix(
      all,
      WRITE,
      (client) =>
        client.mutation(api.registry.refresh, { ...scope, cnpj, key: crypto.randomUUID() }),
      "DEMONSTRATION_READ_ONLY",
    );
  });

  it("controle de operações: lê todas da empresa, controla só as do console", async () => {
    const { f, all } = await setup();
    const integrationOp = await f.t.run(async (ctx) => {
      const op = await ctx.db
        .query("operations")
        .withIndex("by_projectId_companyId_environment_state_nextAttemptAt", (q) =>
          q.eq("projectId", f.scope.projectId),
        )
        .first();
      return op!._id;
    });
    const consoleOp = (
      await all.owner.client.mutation(internal.operations.reserve, {
        organizationId: f.scope.organizationId,
        projectId: await consoleProjectFor(f.t, f.scope.organizationId),
        companyId: f.scope.companyId,
        environment: "sandbox",
        key: "matriz-operacao",
        request: "{}",
        task: {
          name: "console.proof",
          scope: "documents:import",
          workload: "import",
          executor: "testing/operationProof:execute",
        },
      })
    ).operationId;
    // A developer reads an operation only through a project it manages; none here.
    for (const operationId of [integrationOp, consoleOp])
      await matrix(all, { ...READ, developer: "NOT_FOUND" }, (client) =>
        client.query(api.operations.get, { operationId }),
      );
    // A stale generation is refused only after the access check, for pause and retry.
    for (const action of ["pause", "retry"] as const) {
      await matrix(
        all,
        { ...WRITE, developer: "NOT_FOUND" },
        (client) =>
          client.mutation(api.operations.control, {
            operationId: consoleOp,
            action,
            expectedGeneration: 999,
          }),
        "OPERATION_CONFLICT",
      );
      await matrix(
        all,
        {
          ...WRITE,
          developer: "NOT_FOUND",
          owner: "INTEGRATION_RECORD",
          admin: "INTEGRATION_RECORD",
          operator: "INTEGRATION_RECORD",
        },
        (client) =>
          client.mutation(api.operations.control, {
            operationId: integrationOp,
            action,
            expectedGeneration: 999,
          }),
      );
    }
  });

  it("municípios e NCM seguem o acesso à empresa, para qualquer papel", async () => {
    const { f, all } = await setup();
    await matrix(
      all,
      {
        ...READ,
        developer: "pass",
        outsider: "ACCESS_DENIED",
        revoked: "ACCESS_DENIED",
      },
      (client) =>
        client.query(api.references.search, {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          contextKey: "matriz",
          dataset: "municipalities",
          date: "2026-10-09",
          q: "São Paulo",
        }),
      // No table is published in this database: the answer after the access check.
      "REFERENCE_UNAVAILABLE",
    );
  });

  it("uma API key continua exigindo a concessão do projeto", async () => {
    const { f } = await setup();
    const list = await f.request(`/v1/documents?companyId=${f.scope.companyId}`);
    expect(list.status).toBe(404);
    const reserve = await f.request(
      "/v1/imports",
      "POST",
      {
        companyId: f.scope.companyId,
        files: [{ name: "n.xml", size: 10, sha256: "b".repeat(64) }],
      },
      "sem-concessao",
    );
    expect(reserve.status).toBe(404);
    // Restoring the grant restores the key, without anyone touching the console project.
    await f.t.run(async (ctx) => {
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
        )
        .unique())!;
      await ctx.db.patch("projectCompanies", grant._id, { active: true });
    });
    expect((await f.request(`/v1/documents?companyId=${f.scope.companyId}`)).status).toBe(200);
  });

  it("o projeto do console é único, não aparece em Integrações e não aceita chave nem webhook", async () => {
    const { f, all, scope } = await setup();
    const files = [{ name: "nota.xml", size: 10, sha256: "c".repeat(64) }];
    await all.operator.client.mutation(api.imports.reserve, { ...scope, key: "um", files });
    await all.owner.client.mutation(api.imports.reserve, { ...scope, key: "dois", files });
    const consoles = await f.t.run(async (ctx) =>
      (
        await ctx.db
          .query("projects")
          .withIndex("by_organizationId", (q) => q.eq("organizationId", f.scope.organizationId))
          .collect()
      ).filter((project) => project.kind === "console"),
    );
    expect(consoles).toHaveLength(1);
    const consoleId = consoles[0]!._id;
    const listed = await all.owner.client.query(api.projects.list, {
      organizationId: f.scope.organizationId,
      contextKey: "matriz",
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(listed.page.map((project) => project.id)).not.toContain(consoleId);
    expect(
      await all.owner.client.query(api.projects.get, {
        organizationId: f.scope.organizationId,
        projectId: consoleId,
        contextKey: "matriz",
      }),
    ).toBeNull();
    const target = { organizationId: f.scope.organizationId, projectId: consoleId };
    expect(
      await code(
        all.owner.client.mutation(api.projects.update, {
          ...target,
          name: "Outro nome",
          state: "disabled",
          expectedVersion: 1,
        }),
      ),
    ).toBe("ACCESS_DENIED");
    expect(
      await code(
        all.owner.client.mutation(api.projects.grantCompany, {
          ...target,
          companyId: f.scope.companyId,
          scopes: ["documents:read"],
          environments: ["sandbox"],
          expectedVersion: 0,
        }),
      ),
    ).toBe("ACCESS_DENIED");
    expect(
      await code(
        all.owner.client.action(api.keys.create, {
          ...target,
          name: "Chave",
          scopes: ["documents:read"],
          environment: "sandbox",
          companyIds: [f.scope.companyId],
          expiresAt: Date.now() + 86_400_000,
        }),
      ),
    ).not.toBe("OK");
    expect(
      await code(
        all.owner.client.mutation(api.webhooks.create, {
          ...target,
          companyId: f.scope.companyId,
          environment: "sandbox",
          name: "Destino",
          url: "https://receiver.example.com/webhook",
          events: ["document.received"],
        }),
      ),
    ).not.toBe("OK");
    // Even a forged key on the console project is refused as an invalid key.
    await f.t.run(async (ctx) => {
      const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
      await ctx.db.patch("apiKeys", key._id, { projectId: consoleId, projectEpoch: 0 });
    });
    expect((await f.request(`/v1/documents?companyId=${f.scope.companyId}`)).status).toBe(401);
    // The company listing follows the same key rule.
    const companies = await f.request("/v1/companies?limit=20");
    expect(companies.status).toBe(401);
    expect((await companies.json()).error.code).toBe("INVALID_API_KEY");
  });
});

describe("console sem projeto: execução e idempotência", () => {
  const task = {
    name: "console.proof",
    scope: "documents:import" as const,
    workload: "import" as const,
    executor: "testing/operationProof:execute",
  };
  async function accepted(f: F, client: Client, key: string, companyId = f.scope.companyId) {
    return client.mutation(internal.operations.reserve, {
      organizationId: f.scope.organizationId,
      projectId: await consoleProjectFor(f.t, f.scope.organizationId),
      companyId,
      environment: "sandbox",
      key,
      request: "{}",
      task,
    });
  }
  async function claimed(f: F, operationId: Id<"operations">) {
    const claim = await f.t.mutation(internal.operations.claim, { operationId, generation: 1 });
    const op = (await f.t.run((ctx) => ctx.db.get("operations", operationId)))!;
    return { claim, op };
  }

  it.each(["viewer", "developer", "company"] as const)(
    "o worker pausa o trabalho aceito pelo operador depois de %s",
    async (change) => {
      const f = await fixture();
      const operator = await member(f, "operator");
      const { operationId } = await accepted(f, operator.client, `depois-${change}`);
      await f.t.run(async (ctx) => {
        if (change === "company")
          await ctx.db.patch("companyGrants", operator.grantId!, { active: false, version: 2 });
        else await ctx.db.patch("memberships", operator.membershipId, { role: change, version: 2 });
      });
      const { claim, op } = await claimed(f, operationId);
      expect(claim).toBeNull();
      expect(op).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
      // The operator kept as is still runs its work.
      const other = await member(f, "operator");
      const kept = await accepted(f, other.client, `mantido-${change}`);
      expect((await claimed(f, kept.operationId)).claim).not.toBeNull();
    },
  );

  it("a chave de idempotência do console não atravessa empresas nem projetos de integração", async () => {
    const f = await fixture();
    const owner = await member(f, "owner", { company: false });
    const second = await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...company } = (await ctx.db.get(
        "companies",
        f.scope.companyId,
      ))!;
      return ctx.db.insert("companies", { ...company, cnpj: "11444777000161" });
    });
    const first = await accepted(f, owner.client, "mesma-chave");
    // Same key, same request: the same operation.
    expect(await accepted(f, owner.client, "mesma-chave")).toEqual({
      operationId: first.operationId,
      reused: true,
    });
    // Same key for another company of the organization: a different request.
    expect(await code(accepted(f, owner.client, "mesma-chave", second))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
    // A member who reaches only the other company is not told the key exists.
    const narrow = await member(f, "operator", { company: false });
    await f.t.run((ctx) =>
      ctx.db.insert("companyGrants", {
        organizationId: f.scope.organizationId,
        companyId: second,
        membershipId: narrow.membershipId,
        membershipEpoch: 0,
        active: true,
        version: 1,
        updatedAt: Date.now(),
      }),
    );
    expect(await code(accepted(f, narrow.client, "mesma-chave", second))).toBe("NOT_FOUND");
    // A person never reaches an integration's namespace, not even to reuse its request.
    const integrationKey = await f.t.run(async (ctx) => {
      const record = await ctx.db
        .query("idempotencyRecords")
        .withIndex("by_organizationId_and_projectId_and_name_and_key", (q) =>
          q.eq("organizationId", f.scope.organizationId).eq("projectId", f.scope.projectId),
        )
        .first();
      return record!;
    });
    const op = (await f.t.run((ctx) => ctx.db.get("operations", integrationKey.operationId)))!;
    expect(
      await code(
        owner.client.mutation(internal.operations.reserve, {
          organizationId: f.scope.organizationId,
          projectId: f.scope.projectId,
          companyId: op.companyId,
          environment: "sandbox",
          key: integrationKey.key,
          request: op.request,
          task: op.task,
        }),
      ),
    ).toBe("NOT_FOUND");
  });
});
