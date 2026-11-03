import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { backendRequest, validationTarget } from "./validation.mjs";

/** Check persisted ownership, not only IDs carried by a resumable private file. */
export async function assertSyntheticScope(h, state, scope) {
  assert.match(state.suffix, /^hosted-79-80-[a-f0-9-]{36}$/);
  const expected = {
    organizationId: scope.organizationId,
    companyId: scope.companyId,
    projectId: scope.projectId,
    keyId: scope.keyId,
    ownerMembershipId: scope.ownerMembershipId,
  };
  const actual = await h.query(`
    const s = ${JSON.stringify(expected)};
    const org = await ctx.db.get(s.organizationId), company = await ctx.db.get(s.companyId), project = await ctx.db.get(s.projectId);
    const key = await ctx.db.get(s.keyId);
    const owner = await ctx.db.get(s.ownerMembershipId);
    return { slug: org?.slug ?? null, companyOrganization: company?.organizationId ?? null, projectOrganization: project?.organizationId ?? null,
      keyOrganization: key?.organizationId ?? null, keyProject: key?.projectId ?? null, keyHash: key?.keyHash ?? null,
      keyCreator: key?.creatorMembershipId ?? null, projectCreator: project?.creatorMembershipId ?? null,
      ownerOrganization: owner?.organizationId ?? null, ownerRole: owner?.role ?? null, ownerState: owner?.state ?? null,
      ownerUser: owner?.authUserId ?? null };
  `);
  assert.equal(actual.slug, scope.suffix);
  assert.ok(scope.suffix.startsWith(`${state.suffix}-`));
  assert.equal(actual.companyOrganization, scope.organizationId);
  assert.equal(actual.projectOrganization, scope.organizationId);
  assert.equal(actual.keyOrganization, scope.organizationId);
  assert.equal(actual.keyProject, scope.projectId);
  assert.equal(actual.keyHash, scope.keyHash);
  assert.equal(actual.keyCreator, scope.ownerMembershipId);
  assert.equal(actual.projectCreator, scope.ownerMembershipId);
  assert.equal(actual.ownerOrganization, scope.organizationId);
  assert.equal(actual.ownerRole, "owner");
  assert.equal(actual.ownerState, "active");
  assert.ok(actual.ownerUser === scope.suffix || actual.ownerUser === state.actor?.subject);
  if (scope.source) {
    const source = await h.query(`
      const doc = await ctx.db.get(${JSON.stringify(scope.source.doc._id)});
      const version = await ctx.db.get(${JSON.stringify(scope.source.version._id)});
      const artifact = version ? await ctx.db.get(version.artifactId) : null;
      return { organizationId: doc?.organizationId ?? null, companyId: doc?.companyId ?? null,
        versionId: doc?.publishedVersionId ?? null, artifactId: version?.artifactId ?? null,
        artifactOrganization: artifact?.organizationId ?? null, artifactCompany: artifact?.companyId ?? null };
    `);
    assert.equal(source.organizationId, scope.organizationId);
    assert.equal(source.companyId, scope.companyId);
    assert.equal(source.versionId, scope.source.version._id);
    assert.equal(source.artifactId, scope.source.version.artifactId);
    assert.equal(source.artifactOrganization, scope.organizationId);
    assert.equal(source.artifactCompany, scope.companyId);
  }
  if (scope.organizationId === state.scopes?.[0]?.organizationId) {
    const fixtures = await h.query(`
      const projects = await Promise.all(${JSON.stringify(state.monitorProjects ?? [])}.map(id => ctx.db.get(id)));
      const monitors = await Promise.all(${JSON.stringify(state.monitors ?? [])}.map(id => ctx.db.get(id)));
      const certificate = ${state.syntheticCertificate ? `await ctx.db.get(${JSON.stringify(state.syntheticCertificate)})` : "null"};
      const stream = ${state.syntheticStream ? `await ctx.db.get(${JSON.stringify(state.syntheticStream)})` : "null"};
      return { projects: projects.map(p => ({ organizationId: p?.organizationId, reference: p?.externalReference })),
        monitors: monitors.map(m => ({ organizationId: m?.organizationId, companyId: m?.companyId })),
        certificate: certificate ? { organizationId: certificate.organizationId, companyId: certificate.companyId, fingerprint: certificate.metadata?.fingerprint } : null,
        stream: stream ? { organizationId: stream.organizationId, companyId: stream.companyId, identity: stream.identity } : null };
    `);
    for (const [i, project] of fixtures.projects.entries()) {
      assert.equal(project.organizationId, scope.organizationId);
      assert.equal(project.reference, `${state.suffix}-monitor-${i}`);
    }
    for (const record of fixtures.monitors
      .concat([fixtures.certificate, fixtures.stream])
      .filter(Boolean)) {
      assert.equal(record.organizationId, scope.organizationId);
      assert.equal(record.companyId, scope.companyId);
    }
    if (state.syntheticCertificate)
      assert.equal(fixtures.certificate?.fingerprint, "synthetic-no-pfx");
    if (state.syntheticStream) assert.equal(fixtures.stream?.identity, state.suffix);
  }
}

/** Operator credential stays outside the checkout. Only persistent validation is accepted. */
export function hostedProof(credentialPath) {
  const credential = JSON.parse(readFileSync(credentialPath, "utf8"));
  assert.equal(credential.deploymentName, validationTarget.deploymentName);
  assert.equal(credential.deploymentType, "dev");
  assert.equal(credential.url, validationTarget.url);
  assert.equal(validationTarget.url, "https://modest-seal-118.convex.cloud");
  assert.ok(typeof credential.adminKey === "string" && credential.adminKey.length > 20);
  for (const name of [
    "CONVEX_DEPLOY_KEY",
    "CONVEX_SELF_HOSTED_URL",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
  ])
    assert.ok(!process.env[name], `Remove inherited ${name}`);
  const context = { target: validationTarget, key: credential.adminKey };
  async function rpc(kind, path, args = {}) {
    return (await backendRequest(context, `/api/${kind}`, { path, args, format: "json" })).value;
  }
  async function component(path, args) {
    return (
      await backendRequest(context, "/api/function", {
        path,
        args,
        componentPath: "betterAuth",
        format: "json",
      })
    ).value;
  }
  async function asUser(identity, kind, path, args) {
    const acting = {
      ...context,
      key: `${context.key}:${Buffer.from(JSON.stringify({ issuer: context.target.siteUrl, ...identity })).toString("base64")}`,
    };
    const res = await fetch(`${context.target.url}/api/${kind}`, {
      method: "POST",
      headers: { Authorization: `Convex ${acting.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    if (result.status !== "success") {
      let data = result.errorData;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          data = null;
        }
      }
      throw new Error(
        typeof data?.code === "string" && /^[A-Z_]+$/.test(data.code)
          ? data.code
          : "Hosted call rejected",
      );
    }
    return result.value;
  }
  async function query(body) {
    const source = `import {query} from "convex:/_system/repl/wrappers.js";
      export default query({handler: async(ctx) => {${body}}});`;
    return (
      await backendRequest(context, "/api/run_test_function", {
        adminKey: context.key,
        args: {},
        bundle: { path: "testQuery.js", source },
        format: "json",
      })
    ).value;
  }
  async function candidate(source, args) {
    return (
      await backendRequest(context, "/api/run_test_function", {
        adminKey: context.key,
        args,
        bundle: { path: "testQuery.js", source },
        format: "json",
      })
    ).value;
  }
  async function preflight() {
    const vars = Object.fromEntries(
      (await rpc("query", "_system/cli/queryEnvironmentVariables")).map(({ name, value }) => [
        name,
        value,
      ]),
    );
    for (const [name, value] of Object.entries({
      APP_ENV: "validation",
      PRODUCT_ENV: "sandbox",
      FISCAL_ENV: "disabled",
      FNFE_CRONS: "off",
      WEBHOOK_MODE: "disabled",
    }))
      assert.equal(vars[name], value, `Unexpected ${name}`);
    const health = await (await fetch(`${context.target.siteUrl}/health`)).json();
    const frontend = await (await fetch(`${context.target.consoleUrl}/build.json`)).json();
    assert.equal(health.status, "ok");
    assert.equal(health.appEnv, "validation");
    assert.equal(health.productEnv, "sandbox");
    assert.equal(health.fiscalEnv, "disabled");
    assert.match(health.sha, /^[a-f0-9]{40}$/);
    assert.equal(frontend.environment, "validation");
    assert.equal(frontend.sha, health.sha);
    const crons = await rpc("query", "_system/frontend/listCronJobs");
    assert.equal(crons.length, 0);
    return { target: context.target, health, frontend, registeredCrons: crons.length };
  }
  async function add(table, documents) {
    assert.ok(documents.length > 0 && documents.length <= 4096);
    const result = await rpc("mutation", "_system/frontend/addDocument", { table, documents });
    assert.equal(result.success, true);
  }
  async function patch(table, ids, fields) {
    assert.ok(ids.length > 0 && ids.length <= 1000);
    assert.equal(
      (await rpc("mutation", "_system/frontend/patchDocumentsFields", { table, ids, fields }))
        .success,
      true,
    );
  }
  async function rows(table, index, fields, limit = 1000, select) {
    assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 4000);
    const eq = Object.entries(fields)
      .map(([k, v]) => `.eq(${JSON.stringify(k)},${JSON.stringify(v)})`)
      .join("");
    const projection = select
      ? `.map(row=>Object.fromEntries(${JSON.stringify(select)}.map(k=>[k,row[k]])))`
      : "";
    return query(
      `return (await ctx.db.query(${JSON.stringify(table)}).withIndex(${JSON.stringify(index)},q=>q${eq}).order("desc").take(${limit}))${projection};`,
    );
  }
  async function logs(cursor) {
    let response;
    try {
      response = await fetch(`${context.target.url}/api/stream_function_logs?cursor=${cursor}`, {
        headers: { Authorization: `Convex ${context.key}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      if (error.name === "TimeoutError") return { cursor, entries: [], idle: true };
      throw error;
    }
    assert.equal(response.status, 200);
    const data = await response.json();
    // Never persist console messages, return values, identities or exception content.
    return {
      cursor: data.newCursor,
      entries: data.entries
        .filter((e) => e.kind === "Completion")
        .map((e) => ({
          identifier: e.identifier,
          componentPath: e.componentPath ?? null,
          udfType: e.udfType,
          executionTime: e.executionTime,
          timestamp: e.timestamp,
          executionId: e.executionId,
          cachedResult: e.cachedResult,
          error: !!e.error,
          usageStats: e.usageStats,
          occRetries: e.occInfo?.retryCount ?? 0,
          occTable: e.occInfo?.tableName ?? null,
        })),
    };
  }
  async function remove(table, ids) {
    assert.ok(ids.length > 0 && ids.length <= 4000);
    assert.equal(
      (
        await rpc("mutation", "_system/frontend/deleteDocuments", {
          toDelete: ids.map((id) => ({ id, tableName: table })),
        })
      ).success,
      true,
    );
  }
  return {
    rpc,
    component,
    asUser,
    query,
    candidate,
    preflight,
    add,
    patch,
    rows,
    logs,
    remove,
    target: context.target,
  };
}
