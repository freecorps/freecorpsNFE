import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import schema from "./schema";
import { internal, api, components } from "./_generated/api";
import { register } from "../test-setup";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { distributionXml, nsu } from "../../tests/helpers/distribution";
import { consoleProjectFor } from "../../tests/helpers/console";
import { capturePlan, person } from "../../tests/helpers/platform";
import { fixture as corpus } from "../../tests/helpers/nfe-corpus";
import { parseDistribution } from "../../packages/fiscal-nfe/src/distribution";
import { payload } from "./lib/documentCore";
import type { Claim } from "./lib/operationCore";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePlatformEnvironment } from "./environment";
import type { FiscalProofPolicy } from "./lib/fiscalProof";
import * as certificateRuntime from "./lib/certificateRuntime";
import { modules } from "../../tests/helpers/convex-modules";
vi.mock("./buildInfo", () => ({ buildSha: "a".repeat(40) }));
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5198",
    CONVEX_SITE_URL: "http://127.0.0.1:3255",
    BETTER_AUTH_SECRET: "synthetic-capture",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}
async function human(
  t: ReturnType<typeof setup>,
  organizationId: Id<"organizations">,
  role: "owner" | "admin" | "operator" | "developer" | "viewer",
) {
  const now = Date.now();
  const user = await t.mutation(components.betterAuth.adapter.create, {
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
  const session = await t.mutation(components.betterAuth.adapter.create, {
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
  const membershipId = await t.run((ctx) =>
    ctx.db.insert("memberships", {
      organizationId,
      authUserId: user._id,
      name: user.name,
      email: user.email,
      role,
      state: "active",
      version: 1,
      joinedAt: now,
      updatedAt: now,
    }),
  );
  return {
    membershipId,
    client: t.withIdentity({
      subject: user._id,
      sessionId: session._id,
      issuer: "http://127.0.0.1:3245",
    }),
  };
}

async function fixture(t = setup()) {
  const secret = `fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`,
    keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  await t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", scope.keyId))!;
    const scopes = [...key.scopes, "connections:read", "documents:read"] as const;
    await ctx.db.patch("apiKeys", key._id, {
      scopes: [...scopes],
      expiresAt: Date.now() + 10 * 86400_000,
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { scopes: [...scopes] });
    await ctx.db.patch("companies", scope.companyId, { kind: "declared" });
    const id = await ctx.db.insert("certificates", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      version: 1,
      state: "active",
      uploaderId: "proof",
      membershipId: key.creatorMembershipId,
      membershipVersion: 1,
      metadata: {
        fingerprint: "synthetic",
        subject: "test",
        cnpj: "00000000000191",
        notBefore: Date.now() - 1000,
        notAfter: Date.now() + 30 * 86400_000,
      },
      envelope: {
        format: 1,
        keyVersion: "synthetic",
        pfx: new ArrayBuffer(0),
        password: new ArrayBuffer(0),
        wrappedKey: new ArrayBuffer(0),
      },
      envelopeRevision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("certificateHeads", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      nextVersion: 2,
      activeId: id,
      latestId: id,
    });
  });
  const args = { keyHash, environment: "sandbox", companyId: scope.companyId };
  const command = async (
    action?: "activate" | "sync" | "pause" | "resume",
    expectedVersion?: number,
  ) =>
    JSON.parse(
      await t.mutation(internal.captureRest.dispatch, {
        ...args,
        ...(action ? { action } : {}),
        ...(expectedVersion ? { expectedVersion } : {}),
      }),
    ) as {
      id: Doc<"captureStreams">["_id"];
      version: number;
      operationId: Doc<"operations">["_id"];
      nextAllowedAt: number;
      checkpoint: string;
      state: string;
    };
  return { t, scope, args, secret, command };
}
async function claim(f: Awaited<ReturnType<typeof fixture>>) {
  const view = await f.command();
  const op = (await f.t.run((ctx) => ctx.db.get("operations", view.operationId)))!;
  vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
  const claimed = (await f.t.mutation(internal.operations.claim, {
    operationId: op._id,
    generation: op.generation,
  }))!;
  const token = { operationId: op._id, generation: claimed.generation, fence: claimed.fence };
  await f.t.mutation(internal.operations.beginEffect, token);
  return token;
}
async function raw(f: Awaited<ReturnType<typeof fixture>>, token: Claim, bytes: Buffer) {
  const input = (await f.t.mutation(internal.captureProcessing.prepare, token))!;
  const rawId = await f.t.run((ctx) => ctx.storage.store(new Blob([Uint8Array.from(bytes)])));
  const batchId = (await f.t.mutation(internal.captureProcessing.raw, {
    ...token,
    rawId,
    rawHash: createHash("sha256").update(bytes).digest("hex"),
    nsu: input.nsu,
    mode: input.mode,
  }))!;
  return batchId;
}
async function persist(f: Awaited<ReturnType<typeof fixture>>, token: Claim, bytes: Buffer) {
  const batchId = await raw(f, token, bytes),
    parsed = parseDistribution(bytes, "sandbox");
  await f.t.mutation(internal.captureProcessing.describe, {
    ...token,
    batchId,
    status: parsed.status,
    lastNsu: parsed.lastNsu,
    maxNsu: parsed.maxNsu,
    count: parsed.envelopes.length,
  });
  for (const [position, e] of parsed.envelopes.entries()) {
    const storageId = await f.t.run((ctx) => ctx.storage.store(new Blob([Uint8Array.from(e.xml)])));
    expect(
      await f.t.mutation(internal.captureProcessing.envelope, {
        ...token,
        batchId,
        position,
        nsu: e.nsu,
        schema: e.schema,
        sha256: e.sha256,
        size: e.xml.length,
        storageId,
      }),
    ).toBe(true);
  }
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "success", response: "{}" },
  });
  return batchId;
}
it("isolates the fiscal identity globally and deduplicates concurrent manual activation", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.command("activate"), f.command("activate")]);
  expect(a.id).toBe(b.id);
  expect(a.operationId).toBe(b.operationId);
  const other = await fixture(f.t);
  await expect(other.command("activate")).rejects.toThrow("STREAM_CONFLICT");
  expect(await f.t.run((ctx) => ctx.db.query("captureStreams").collect())).toHaveLength(1);
});
it("persists envelopes before monotonic checkpoint and publishes each document only once", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  const bytes = distributionXml({
    envelopes: [
      { nsu: 1, xml: corpus("summary-authorized") },
      { nsu: 2, xml: corpus("invoice-authorized") },
    ],
  });
  await persist(f, token, bytes);
  expect((await f.command()).checkpoint).toBe(nsu(0));
  await f.t.mutation(internal.operations.checkpoint, token);
  expect((await f.command()).checkpoint).toBe(nsu(2));
  await f.t.mutation(internal.operations.publish, token);
  expect(await f.t.mutation(internal.operations.publish, token)).toBe(false);
  const envelopes = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
  for (const e of envelopes)
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const docs = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  expect(docs).toHaveLength(1);
  expect(docs[0]?.completeness).toBe(2);
  const artifacts = await f.t.run((ctx) => ctx.db.query("documentArtifacts").collect());
  expect(artifacts.every((a) => a.source === "distribution-xml")).toBe(true);
  const usage = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
  expect(usage.filter((event) => event.metric === "captures")).toHaveLength(1);
  expect(usage.filter((event) => event.metric === "documents")).toHaveLength(1);
  expect(usage.find((event) => event.metric === "bytes")).toMatchObject({
    state: "committed",
    quantity: bytes.length + artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
  });
  expect(await f.t.run((ctx) => ctx.db.query("outboxEvents").collect())).toHaveLength(2);
});
it("captures an NF-e with its purpose and both declared totals in the public payload", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  // Credit note with vNFTot apart from vNF; the edited XML loses its signature, not its identity.
  const xml = corpus("invoice-authorized")
    .toString()
    .replace("<finNFe>1</finNFe>", "<finNFe>5</finNFe><tpNFCredito>04</tpNFCredito>")
    .replace("</ICMSTot>", "</ICMSTot><vNFTot>27.15</vNFTot>");
  await persist(f, token, distributionXml({ envelopes: [{ nsu: 1, xml: Buffer.from(xml) }] }));
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  for (const e of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const [doc] = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  const version = (await f.t.run((ctx) =>
    ctx.db.get("documentVersions", doc!.publishedVersionId!),
  ))!;
  const data = payload(version);
  if (data.kind !== "invoice") throw new Error("invoice required");
  expect(data.purpose).toEqual({
    code: "5",
    label: "Nota de crédito",
    creditNoteType: { code: "04", label: "Redução de valores" },
    debitNoteType: null,
    inconsistencies: [],
  });
  expect(data.total).toBe("24.69");
  expect(data.declaredTotals).toEqual({ vNF: "24.69", vNFTot: "27.15" });
});
it("captures an NT 2026.008 invoice valid for PL_010g and publishes its net values", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(
    f,
    token,
    distributionXml({ envelopes: [{ nsu: 1, xml: corpus("invoice-net-values") }] }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  for (const e of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const [doc] = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  const version = (await f.t.run((ctx) =>
    ctx.db.get("documentVersions", doc!.publishedVersionId!),
  ))!;
  expect(version.code).toBe("IMPORTED");
  expect(JSON.parse(version.result!).checks.xsd.code).toBe("XSD_VALID");
  const data = payload(version);
  if (data.kind !== "invoice") throw new Error("invoice required");
  expect(data.nt2026008).toEqual({ vProdLiqTot: "22.45" });
  const [item] = await f.t.run((ctx) => ctx.db.query("documentItems").collect());
  expect(JSON.parse(item!.data).nt2026008.vProdLiq.declared).toBe("22.45");
});
it("captures an NT 2026.006 invoice and publishes its payment links", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(
    f,
    token,
    distributionXml({ envelopes: [{ nsu: 1, xml: corpus("invoice-payment-link") }] }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  for (const e of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const [doc] = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  const version = (await f.t.run((ctx) =>
    ctx.db.get("documentVersions", doc!.publishedVersionId!),
  ))!;
  expect(version.code).toBe("IMPORTED");
  expect(JSON.parse(version.result!).checks.xsd.code).toBe("XSD_VALID");
  const data = payload(version);
  if (data.kind !== "invoice") throw new Error("invoice required");
  expect(data.nt2026006?.gPgtoVinc?.map((link) => [link.nPag, link.tpMeioPgto])).toEqual([
    ["1", "03"],
    ["2", "17"],
  ]);
});
it("captures a supplier RTC event summary into the history of the captured NF-e (#389)", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  const unsupported = corpus("event-summary-112150")
    .toString()
    .replace("<tpEvento>112150</tpEvento>", "<tpEvento>211110</tpEvento>");
  await persist(
    f,
    token,
    distributionXml({
      envelopes: [
        { nsu: 1, xml: corpus("invoice-authorized"), schema: "procNFe_v4.00.xsd" },
        { nsu: 2, xml: corpus("event-summary-112150"), schema: "resEvento_v1.01.xsd" },
        { nsu: 3, xml: unsupported, schema: "resEvento_v1.01.xsd" },
      ],
    }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  for (const e of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const [doc, ...others] = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  expect(others).toEqual([]);
  const versions = await f.t.run((ctx) => ctx.db.query("documentVersions").collect());
  const byCode = Object.fromEntries(versions.map((v) => [v.kind + ":" + v.code, v]));
  expect(byCode["event-summary:IMPORTED"]?.documentId).toBe(doc!._id);
  // The deferred type keeps its original and its code, outside the document history.
  const rejected = versions.find((v) => v.code === "XML_EVENT_UNSUPPORTED")!;
  expect(rejected.documentId).toBeUndefined();
  // Fiscal data is not lost: the envelope's exact bytes stay stored, hashed and downloadable.
  const sha256 = createHash("sha256").update(unsupported).digest("hex");
  const envelopes = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
  expect(envelopes.find((e) => e.nsu === nsu(3))).toMatchObject({
    sha256,
    artifactId: rejected.artifactId,
  });
  const artifact = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", rejected.artifactId)))!;
  expect(artifact).toMatchObject({ sha256, source: "distribution-xml" });
  const stored = await f.t.run(async (ctx) =>
    (await ctx.storage.get(artifact.storageId!))!.arrayBuffer(),
  );
  expect(Buffer.from(stored)).toEqual(Buffer.from(unsupported));
  const headers = { Authorization: `Bearer ${f.secret}`, "X-Environment": "sandbox" };
  const listed = (
    await (
      await f.t.fetch(`/v1/document-artifacts?companyId=${f.scope.companyId}`, { headers })
    ).json()
  ).data.page.find((entry: { id: string }) => entry.id === String(artifact._id));
  expect(listed).toMatchObject({ sha256, code: "XML_EVENT_UNSUPPORTED", originalAvailable: true });
  const original = await f.t.fetch(
    `/v1/document-artifacts/${artifact._id}/original?companyId=${f.scope.companyId}`,
    { headers },
  );
  expect(original.status).toBe(200);
  expect(Buffer.from(await original.arrayBuffer())).toEqual(Buffer.from(unsupported));
  const event = payload(byCode["event-summary:IMPORTED"]!);
  expect(event).toMatchObject({
    kind: "event-summary",
    type: "112150",
    description: "Atualização da Data de Previsão de Entrega",
  });
});
it("captures a 110300 payment link event and its summary into the captured NF-e history (#405)", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(
    f,
    token,
    distributionXml({
      envelopes: [
        { nsu: 1, xml: corpus("invoice-authorized"), schema: "procNFe_v4.00.xsd" },
        { nsu: 2, xml: corpus("event-110300"), schema: "procEventoNFe_v1.00.xsd" },
        { nsu: 3, xml: corpus("event-summary-110300"), schema: "resEvento_v1.01.xsd" },
      ],
    }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  for (const e of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const [doc, ...others] = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  expect(others).toEqual([]);
  const versions = await f.t.run((ctx) => ctx.db.query("documentVersions").collect());
  const byCode = Object.fromEntries(versions.map((v) => [v.kind + ":" + v.code, v]));
  for (const kind of ["event", "event-summary"]) {
    expect(byCode[kind + ":IMPORTED"]?.documentId).toBe(doc!._id);
    expect(payload(byCode[kind + ":IMPORTED"]!)).toMatchObject({
      kind,
      type: "110300",
      description: "Vinculação Pagamento",
    });
  }
});
it("keeps a captured issuer's event by another CNPJ outside the NF-e history (#532)", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(
    f,
    token,
    distributionXml({
      envelopes: [
        { nsu: 1, xml: corpus("invoice-authorized"), schema: "procNFe_v4.00.xsd" },
        { nsu: 2, xml: corpus("event-110111-other-author"), schema: "procEventoNFe_v1.00.xsd" },
        { nsu: 3, xml: corpus("event-summary-other-author"), schema: "resEvento_v1.01.xsd" },
      ],
    }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  for (const e of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const [doc, ...others] = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  expect(others).toEqual([]);
  const versions = await f.t.run((ctx) => ctx.db.query("documentVersions").collect());
  expect(versions.filter((v) => v.documentId === doc!._id).map((v) => v.kind)).toEqual(["invoice"]);
  const refused = versions.filter((v) => v.code === "IDENTITY_INVALID");
  expect(refused).toHaveLength(2);
  const envelopes = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
  for (const version of refused) {
    expect(version.documentId).toBeUndefined();
    const artifact = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", version.artifactId)))!;
    expect(envelopes.map((e) => e.artifactId)).toContain(artifact._id);
  }
});
it("checks capture and byte quotas before reserving the source window", async () => {
  const f = await fixture();
  await f.t.mutation(internal.usage.assignPlan, {
    organizationId: f.scope.organizationId,
    name: "Quota",
    startsAt: Date.now() - 1,
    endsAt: Date.now() + 100000,
    limits: { imports: null, bytes: 0, captures: 10, registry: null, deliveries: null },
    concurrency: 2,
    actor: "test",
    reason: "quota",
    expectedVersion: 0,
  });
  await f.command("activate");
  const token = await claim(f);
  const before = await f.command();
  expect(await f.t.mutation(internal.captureProcessing.prepare, token)).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.get("operations", token.operationId))).toMatchObject({
    state: "paused",
    code: "QUOTA_EXCEEDED",
    uncertain: false,
  });
  expect((await f.command()).nextAllowedAt).toBe(before.nextAllowedAt);
  expect(
    (await f.t.run((ctx) => ctx.db.query("usageEvents").collect())).filter(
      (e) => e.metric === "captures" || e.metric === "bytes",
    ),
  ).toHaveLength(0);
});
it("does not checkpoint an incomplete raw batch", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  const batchId = await raw(f, token, distributionXml());
  await f.t.mutation(internal.captureProcessing.describe, {
    ...token,
    batchId,
    status: "138",
    lastNsu: nsu(1),
    maxNsu: nsu(1),
    count: 1,
  });
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "success", response: "{}" },
  });
  await expect(f.t.mutation(internal.operations.checkpoint, token)).rejects.toThrow(
    "BATCH_INCOMPLETE",
  );
  expect((await f.command()).checkpoint).toBe(nsu(0));
});
it("cooldown survives manual sync, pause/resume and generic operation retry", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(f, token, distributionXml());
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  let state = await f.command();
  const until = state.nextAllowedAt;
  expect(until).toBeGreaterThan(Date.now());
  expect((await f.command("sync", state.version)).operationId).toBe(state.operationId);
  state = await f.command("pause", state.version);
  state = await f.command("resume", state.version);
  const newer = await claim(f);
  const input = (await f.t.mutation(internal.captureProcessing.prepare, newer))!;
  expect(input.waitUntil).toBe(until);
  expect(input.waitUntil).toBeGreaterThan(Date.now());
});
it("recovers raw response after crash without another source call; old lease cannot commit", async () => {
  const f = await fixture();
  await f.command("activate");
  const old = await claim(f);
  await raw(
    f,
    old,
    distributionXml({ envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }] }),
  );
  vi.setSystemTime(Date.now() + 60_001);
  await f.t.mutation(internal.operations.recoverOne, { operationId: old.operationId });
  const op = (await f.t.run((ctx) => ctx.db.get("operations", old.operationId)))!;
  vi.setSystemTime(op.nextAttemptAt);
  await f.t.action(internal.operationWorker.run, {
    operationId: op._id,
    generation: op.generation,
  });
  expect((await f.command()).checkpoint).toBe(nsu(1));
  expect(await f.t.mutation(internal.operations.checkpoint, old)).toBe(false);
  expect(await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect())).toHaveLength(1);
});
it("reconciles an uncertain source response with consNSU only after the global window", async () => {
  const f = await fixture();
  await f.command("activate");
  const old = await claim(f);
  await f.t.mutation(internal.captureProcessing.prepare, old);
  vi.setSystemTime(Date.now() + 60_001);
  await f.t.mutation(internal.operations.recoverOne, { operationId: old.operationId });
  const newer = await claim(f);
  const input = (await f.t.mutation(internal.captureProcessing.prepare, newer))!;
  expect(input.mode).toBe("consNSU");
  expect(input.nsu).toBe(nsu(1));
  expect(input.waitUntil).toBeGreaterThan(Date.now());
  const reserved = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
  expect(reserved.filter((event) => event.metric === "captures")).toHaveLength(1);
  expect(reserved.find((event) => event.metric === "bytes")).toMatchObject({
    state: "reserved",
    quantity: 18 * 1024 * 1024,
  });
  vi.setSystemTime(input.waitUntil!);
  await f.t.mutation(internal.operations.recoverOne, { operationId: newer.operationId });
  const final = await claim(f);
  const bytes = distributionXml();
  await persist(f, final, bytes);
  const committed = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
  expect(committed.filter((event) => event.metric === "captures")).toHaveLength(1);
  expect(committed.filter((event) => event.metric === "bytes")).toHaveLength(1);
  expect(committed.find((event) => event.metric === "bytes")).toMatchObject({
    state: "committed",
    quantity: bytes.length,
  });
  const total = await f.t.run((ctx) => ctx.db.query("usageTotals").collect());
  expect(total.find((row) => row.metric === "bytes")).toMatchObject({
    committed: bytes.length,
    reserved: 0,
  });
});
it("releases capture byte reservation when transport is disabled before receiving a batch", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await f.t.mutation(internal.captureProcessing.prepare, token);
  await f.t.mutation(internal.captureProcessing.failed, {
    ...token,
    code: "FISCAL_TRANSPORT_DISABLED",
  });
  const events = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
  expect(events.find((event) => event.metric === "bytes")?.state).toBe("released");
  const totals = await f.t.run((ctx) => ctx.db.query("usageTotals").collect());
  expect(totals.find((row) => row.metric === "bytes")).toMatchObject({ committed: 0, reserved: 0 });
});

it.each(["app", "backoffice", "persisted-before-fix"] as const)(
  "resumes distribution after uncertain first IO and 589 at maxNSU zero via %s",
  async (entry) => {
    const f = await fixture();
    await f.command("activate");
    const old = await claim(f);
    await f.t.mutation(internal.captureProcessing.prepare, old);
    await f.t.mutation(internal.operations.recordOutcome, {
      ...old,
      outcome: {
        kind: "uncertain",
        code: "SOURCE_RESULT_UNCERTAIN",
        notBefore: Date.now() + 3600_000,
      },
    });
    const active = await f.command();
    const paused = await f.command("pause", active.version);
    vi.setSystemTime(paused.nextAllowedAt);
    await f.command("resume", paused.version);
    const token = await claim(f);
    const input = (await f.t.mutation(internal.captureProcessing.prepare, token))!;
    expect(input).toMatchObject({ mode: "consNSU", nsu: nsu(1) });
    await persist(f, token, distributionXml({ status: "589", last: 0, max: 0 }));
    await f.t.mutation(internal.operations.checkpoint, token);
    await f.t.mutation(internal.operations.publish, token);
    const view = await f.command();
    const stored = await f.t.run((ctx) => ctx.db.get("captureStreams", view.id));
    expect(stored).toMatchObject({
      state: "attention",
      code: "SOURCE_589",
      checkpoint: nsu(0),
      mode: "distNSU",
    });
    expect(view.nextAllowedAt).toBeGreaterThanOrEqual(Date.now() + 3600_000);
    if (entry === "persisted-before-fix") {
      await f.t.run((ctx) =>
        ctx.db.patch("captureStreams", view.id, { mode: "consNSU", sourceCursor: undefined }),
      );
    }
    if (entry === "backoffice") {
      // The stream is the integration's: the console reads it but does not resume it.
      const owner = await human(f.t, f.scope.organizationId, "owner");
      await expect(
        owner.client.mutation(api.captures.control, {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          environment: "sandbox",
          action: "resume",
          expectedVersion: view.version,
        }),
      ).rejects.toThrow("INTEGRATION_RECORD");
    }
    await f.command("resume", view.version);
    const waiting = await claim(f);
    const beforeWindow = (await f.t.mutation(internal.captureProcessing.prepare, waiting))!;
    expect(beforeWindow).toMatchObject({
      mode: "distNSU",
      nsu: nsu(0),
      waitUntil: view.nextAllowedAt,
    });
    await f.t.mutation(internal.operations.recordOutcome, {
      ...waiting,
      outcome: { kind: "wait", code: "SOURCE_COOLDOWN", notBefore: view.nextAllowedAt },
    });
    vi.setSystemTime(view.nextAllowedAt);
    const retry = await claim(f);
    expect(await f.t.mutation(internal.captureProcessing.prepare, retry)).toMatchObject({
      mode: "distNSU",
      nsu: nsu(0),
    });
    await persist(f, retry, distributionXml({ status: "137", last: 0, max: 0 }));
    await f.t.mutation(internal.operations.checkpoint, retry);
    expect((await f.command()).checkpoint).toBe(nsu(0));
    expect(await f.t.run((ctx) => ctx.db.get("captureStreams", view.id))).toMatchObject({
      code: "NO_DOCUMENTS",
      mode: "distNSU",
    });
    expect(await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect())).toHaveLength(0);
  },
);

it.each(["known-gap", "regressed-max", "inconsistent-boundary", "distNSU"])(
  "589 does not discard reconciliation evidence for %s",
  async (scenario) => {
    const f = await fixture();
    const view = await f.command("activate");
    await f.t.run((ctx) =>
      ctx.db.patch("captureStreams", view.id, {
        mode: scenario === "distNSU" ? "distNSU" : "consNSU",
        checkpoint: nsu(scenario === "regressed-max" ? 2 : 0),
        ...(scenario === "known-gap" ? { sourceCursor: nsu(3) } : {}),
      }),
    );
    const token = await claim(f);
    const bytes = distributionXml({
      status: "589",
      last: 0,
      max: scenario === "inconsistent-boundary" ? 1 : 0,
    });
    await persist(f, token, bytes);
    await f.t.mutation(internal.operations.checkpoint, token);
    const stream = await f.t.run((ctx) => ctx.db.get("captureStreams", view.id));
    expect(stream).toMatchObject({
      state: "attention",
      code: "SOURCE_589",
      mode: scenario === "distNSU" ? "distNSU" : "consNSU",
      checkpoint: nsu(scenario === "regressed-max" ? 2 : 0),
    });
    if (scenario === "known-gap") expect(stream?.sourceCursor).toBe(nsu(3));
    expect(stream!.nextAllowedAt).toBeGreaterThanOrEqual(Date.now() + 3600_000);
  },
);
it("preserves cursor on source conflict and exposes no other customer's identity", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(f, token, distributionXml({ status: "656", last: 10, max: 10 }));
  await f.t.mutation(internal.operations.checkpoint, token);
  const stream = await f.command();
  expect(stream).toMatchObject({ checkpoint: nsu(0), state: "attention" });
  expect(stream.nextAllowedAt).toBeGreaterThan(Date.now());
  const events = await f.t.run((ctx) => ctx.db.query("outboxEvents").collect());
  expect(events[0]?.type).toBe("connection.attention_required");
  expect(events[0]?.body).not.toContain("cnpj");
});
it("revoked key, wrong scope and foreign company cannot read or resume", async () => {
  const f = await fixture();
  await f.command("activate");
  const other = await fixture(f.t);
  await expect(
    f.t.mutation(internal.captureRest.dispatch, { ...f.args, companyId: other.scope.companyId }),
  ).rejects.toThrow("NOT_FOUND");
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:read"] }));
  await expect(f.command()).rejects.toThrow("SCOPE_DENIED");
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  await expect(f.command()).rejects.toThrow("INVALID_API_KEY");
});

it("o console lê a captura de integração, mas só controla a do projeto do console", async () => {
  const f = await fixture();
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const grantTo = (
    membershipId: Id<"memberships">,
    organizationId = f.scope.organizationId,
    companyId = f.scope.companyId,
  ) =>
    f.t.run((ctx) =>
      ctx.db.insert("companyGrants", {
        organizationId,
        companyId,
        membershipId,
        membershipEpoch: 0,
        active: true,
        version: 1,
        updatedAt: Date.now(),
      }),
    );
  // The integration activates through its key: the stream belongs to its project.
  const active = await f.command("activate");
  const owner = await human(f.t, f.scope.organizationId, "owner"),
    operator = await human(f.t, f.scope.organizationId, "operator"),
    viewer = await human(f.t, f.scope.organizationId, "viewer"),
    developer = await human(f.t, f.scope.organizationId, "developer"),
    stranger = await human(f.t, f.scope.organizationId, "operator");
  for (const person of [operator, viewer, developer]) await grantTo(person.membershipId);
  // The console sees who controls it before any action.
  const integration = await f.t.run(
    async (ctx) => (await ctx.db.get("projects", f.scope.projectId))!.name,
  );
  expect(await viewer.client.query(api.captures.get, scope)).toMatchObject({
    id: active.id,
    origin: { kind: "integration", integration },
  });
  await expect(developer.client.query(api.captures.get, scope)).rejects.toThrow("SCOPE_DENIED");
  await expect(stranger.client.query(api.captures.get, scope)).rejects.toThrow("NOT_FOUND");
  const control = (
    person: typeof operator,
    action: "pause" | "resume",
    version: number,
    where = scope,
  ) => person.client.mutation(api.captures.control, { ...where, action, expectedVersion: version });
  await expect(control(viewer, "pause", active.version)).rejects.toThrow("SCOPE_DENIED");
  await expect(control(developer, "pause", active.version)).rejects.toThrow("SCOPE_DENIED");
  await expect(control(stranger, "pause", active.version)).rejects.toThrow("NOT_FOUND");
  // Writing on the integration's stream belongs to the integration, for every role.
  await expect(control(operator, "pause", active.version)).rejects.toThrow("INTEGRATION_RECORD");
  await expect(control(owner, "pause", active.version)).rejects.toThrow("Prova de operações");
  await expect(
    owner.client.mutation(api.captures.release, { ...scope, expectedVersion: active.version }),
  ).rejects.toThrow("INTEGRATION_RECORD");
  expect((await f.command()).state).not.toBe("paused");
  // A stream activated in the console belongs to the console project: people control it, and
  // another integration's key does not see or take it.
  const second = await fixture(f.t);
  // Another CNPJ: the stream identity is the CNPJ, environment and service.
  await f.t.run((ctx) =>
    ctx.db.patch("companies", second.scope.companyId, { cnpj: "11444777000161" }),
  );
  const where = {
    organizationId: second.scope.organizationId,
    companyId: second.scope.companyId,
    environment: "sandbox" as const,
  };
  const manager = await human(f.t, second.scope.organizationId, "owner");
  const worker = await human(f.t, second.scope.organizationId, "operator");
  const reader = await human(f.t, second.scope.organizationId, "viewer");
  for (const person of [worker, reader])
    await grantTo(person.membershipId, second.scope.organizationId, second.scope.companyId);
  const created = await manager.client.mutation(api.captures.activate, where);
  const stream = await f.t.run(async (ctx) => {
    const row = (await ctx.db.get("captureStreams", created.id))!;
    const op = (await ctx.db.get("operations", row.operationId!))!;
    return { row, op, project: (await ctx.db.get("projects", row.projectId))! };
  });
  expect(stream.project.kind).toBe("console");
  expect(stream.op.projectId).toBe(stream.row.projectId);
  await expect(second.command("activate")).rejects.toThrow("STREAM_CONFLICT");
  expect(await second.command()).toBeNull();
  await expect(control(reader, "pause", created.version, where)).rejects.toThrow("SCOPE_DENIED");
  const paused = await control(worker, "pause", created.version, where);
  expect(paused.state).toBe("paused");
  const resumed = await control(worker, "resume", paused.version, where);
  const op = (await f.t.run((ctx) => ctx.db.get("operations", resumed.operationId!)))!;
  vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
  expect(
    await f.t.mutation(internal.operations.claim, { operationId: op._id, generation: 1 }),
  ).not.toBeNull();
  // Only managers authorize a transfer.
  await expect(
    worker.client.mutation(api.captures.release, { ...where, expectedVersion: resumed.version }),
  ).rejects.toThrow();
});

/** Hands the company's stream (and its current operation) to another project, as a fixture. */
async function moveStream(f: Awaited<ReturnType<typeof fixture>>, projectId: Id<"projects">) {
  await f.t.run(async (ctx) => {
    const stream = (await ctx.db
      .query("captureStreams")
      .withIndex("by_companyId_environment", (q) =>
        q.eq("companyId", f.scope.companyId).eq("environment", "sandbox"),
      )
      .unique())!;
    await ctx.db.patch("captureStreams", stream._id, { projectId });
    if (stream.operationId) await ctx.db.patch("operations", stream.operationId, { projectId });
  });
}

it("transfers only with both managers, once, preserving checkpoint/window and isolating old ownership", async () => {
  const f = await fixture(),
    other = await fixture(f.t);
  await f.command("activate");
  const token = await claim(f);
  await persist(
    f,
    token,
    distributionXml({
      last: 1,
      max: 3,
      envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
    }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  const before = await f.command();
  // Transfers are a console write: only a stream of the console project is released.
  await moveStream(f, await consoleProjectFor(f.t, f.scope.organizationId));
  const owner = await human(f.t, f.scope.organizationId, "owner");
  const recipient = await human(f.t, other.scope.organizationId, "owner");
  const viewer = await human(f.t, f.scope.organizationId, "viewer");
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const target = {
    ...scope,
    organizationId: other.scope.organizationId,
    companyId: other.scope.companyId,
  };
  await expect(
    viewer.client.mutation(api.captures.release, { ...scope, expectedVersion: before.version }),
  ).rejects.toThrow();
  await expect(
    viewer.client.mutation(api.captures.control, {
      ...scope,
      action: "pause",
      expectedVersion: before.version,
    }),
  ).rejects.toThrow();
  const released = await owner.client.mutation(api.captures.release, {
    ...scope,
    expectedVersion: before.version,
  });
  await expect(
    recipient.client.mutation(api.captures.activate, { ...target, transferToken: "wrong" }),
  ).rejects.toThrow("STREAM_CONFLICT");
  const transferred = await recipient.client.mutation(api.captures.activate, {
    ...target,
    transferToken: released.token,
  });
  expect(transferred).toMatchObject({
    state: "paused",
    checkpoint: before.checkpoint,
    nextAllowedAt: before.nextAllowedAt,
    received: 0,
    operationId: null,
  });
  // The same CNPJ's source: its end of queue goes with the checkpoint (#494). Guards against
  // a transfer resetting `sourceMaxNsu`, which would hide the queue from the receiver.
  expect(await recipient.client.query(api.captures.get, target)).toMatchObject({
    checkpoint: nsu(1),
    sourceMaxNsu: nsu(3),
  });
  expect(await owner.client.query(api.captures.get, scope)).toBeNull();
  await expect(
    owner.client.mutation(api.captures.activate, { ...scope, transferToken: released.token }),
  ).rejects.toThrow("STREAM_CONFLICT");
  const resumed = await recipient.client.mutation(api.captures.control, {
    ...target,
    action: "resume",
    expectedVersion: transferred.version,
  });
  const operation = await f.t.run((ctx) => ctx.db.get("operations", resumed.operationId!));
  expect(operation?.organizationId).toBe(other.scope.organizationId);
  expect(
    (await f.t.run((ctx) => ctx.db.get("certificates", operation!.certificate!.id)))?.companyId,
  ).toBe(other.scope.companyId);
});

it("blocks transfer during uncertain IO and rejects an expired authorization", async () => {
  const f = await fixture(),
    other = await fixture(f.t);
  const owner = await human(f.t, f.scope.organizationId, "owner"),
    recipient = await human(f.t, other.scope.organizationId, "owner");
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const state = await f.command("activate");
  const token = await claim(f);
  await f.t.mutation(internal.captureProcessing.prepare, token);
  // The worker's operation and the stream move together to the console project.
  await moveStream(f, await consoleProjectFor(f.t, f.scope.organizationId));
  const view = () => owner.client.query(api.captures.get, scope).then((row) => row!);
  await expect(
    owner.client.mutation(api.captures.release, { ...scope, expectedVersion: state.version }),
  ).rejects.toThrow("RECONCILIATION_REQUIRED");
  await persist(f, token, distributionXml());
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  const current = await view();
  expect(current.origin).toEqual({ kind: "console", integration: null });
  const released = await owner.client.mutation(api.captures.release, {
    ...scope,
    expectedVersion: current.version,
  });
  vi.setSystemTime(released.expiresAt + 1);
  await expect(
    recipient.client.mutation(api.captures.activate, {
      ...scope,
      organizationId: other.scope.organizationId,
      companyId: other.scope.companyId,
      transferToken: released.token,
    }),
  ).rejects.toThrow("STREAM_CONFLICT");
});

it("refuses a transfer code with nothing to receive, writing nothing (#461)", async () => {
  const f = await fixture();
  const owner = await human(f.t, f.scope.organizationId, "owner"),
    operator = await human(f.t, f.scope.organizationId, "operator");
  // The operator reaches the company, so only the role decides.
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: operator.membershipId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const rows = () =>
    f.t.run(async (ctx) => ({
      streams: await ctx.db.query("captureStreams").collect(),
      audit: (await ctx.db.query("captureAudit").collect()).length,
      operations: (await ctx.db.query("operations").collect()).length,
      projects: (await ctx.db.query("projects").collect()).length,
    }));
  // No stream for the CNPJ: a code (any, even empty) neither creates nor resumes a capture.
  const empty = await rows();
  expect(empty.streams).toEqual([]);
  for (const transferToken of ["codigo-errado", ""])
    await expect(
      owner.client.mutation(api.captures.activate, { ...scope, transferToken }),
    ).rejects.toThrow("TRANSFER_NOT_FOUND");
  // Receiving is for managers, as with a stream to receive.
  await expect(
    operator.client.mutation(api.captures.activate, { ...scope, transferToken: "codigo" }),
  ).rejects.toThrow("ACCESS_DENIED");
  // Not even the console project of the first console write.
  expect(await rows()).toEqual(empty);
  // Without a code, the activation is the same as before.
  const started = await operator.client.mutation(api.captures.activate, scope);
  expect(started).toMatchObject({ state: "active" });
  // The stream is already this company's: the code does not show it as received.
  const own = await rows();
  for (const transferToken of ["codigo-errado", ""])
    await expect(
      owner.client.mutation(api.captures.activate, { ...scope, transferToken }),
    ).rejects.toThrow("TRANSFER_NOT_FOUND");
  expect(await rows()).toEqual(own);
  expect(await owner.client.mutation(api.captures.activate, scope)).toMatchObject({
    version: started.version,
  });
});

it("tells the console the source's last NSU and a query still waiting for its answer", async () => {
  const f = await fixture();
  const owner = await human(f.t, f.scope.organizationId, "owner");
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const view = () => owner.client.query(api.captures.get, scope).then((row) => row!);
  await f.command("activate");
  const token = await claim(f);
  await f.t.mutation(internal.captureProcessing.prepare, token);
  // Sent, not answered: the attempt is newer than any answer and the source's end is unknown.
  const sent = await view();
  expect(sent.sourceMaxNsu).toBeNull();
  expect(sent.lastSuccessAt).toBeNull();
  expect(sent.lastAttemptAt).toBeGreaterThan(0);
  await persist(
    f,
    token,
    distributionXml({
      last: 1,
      max: 5,
      envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
    }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  const read = await view();
  expect(read).toMatchObject({ checkpoint: nsu(1), sourceMaxNsu: nsu(5) });
  expect(read.lastSuccessAt).toBeGreaterThanOrEqual(read.lastAttemptAt!);
  // A day of the general stop writes one row an hour with no answer (#494): the source's end
  // stays the one the last answer gave.
  await deferredRows(f.t, read.id, 24);
  expect(await view()).toMatchObject({ checkpoint: nsu(1), sourceMaxNsu: nsu(5) });
});
it.each([
  ["656", "SOURCE_CONSUMPTION_BLOCKED"],
  ["589", "SOURCE_589"],
  ["593", "SOURCE_593"],
])("a %s refusal keeps the source's last NSU of the last answer (#494)", async (status, code) => {
  const f = await fixture();
  const owner = await human(f.t, f.scope.organizationId, "owner");
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const view = () => owner.client.query(api.captures.get, scope).then((row) => row!);
  await f.command("activate");
  const answered = await claim(f);
  await persist(
    f,
    answered,
    distributionXml({
      last: 1,
      max: 5,
      envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
    }),
  );
  await f.t.mutation(internal.operations.checkpoint, answered);
  await f.t.mutation(internal.operations.publish, answered);
  expect(await view()).toMatchObject({ checkpoint: nsu(1), sourceMaxNsu: nsu(5) });
  // The refusal is committed (its code reaches the stream), but its `maxNSU` is not the queue's end.
  const refused = await claim(f);
  await persist(f, refused, distributionXml({ status, last: 1, max: 1 }));
  await f.t.mutation(internal.operations.checkpoint, refused);
  expect(await view()).toMatchObject({ code, checkpoint: nsu(1), sourceMaxNsu: nsu(5) });
  // The next answer, a 137 at the end of the queue, does move it.
  const stopped = await f.command();
  await f.command("resume", stopped.version);
  vi.setSystemTime(Math.max(Date.now(), stopped.nextAllowedAt));
  const empty = await claim(f);
  await persist(f, empty, distributionXml({ status: "137", last: 1, max: 1 }));
  await f.t.mutation(internal.operations.checkpoint, empty);
  // An hour later the person's session is gone: read the stream `captures.get` returns from.
  expect(await f.t.run((ctx) => ctx.db.get("captureStreams", stopped.id))).toMatchObject({
    code: "NO_DOCUMENTS",
    checkpoint: nsu(1),
    sourceMaxNsu: nsu(1),
  });
});
/** Audit rows without an answer, as the general stop (#424) writes once an hour. */
async function deferredRows(
  t: ReturnType<typeof setup>,
  streamId: Id<"captureStreams">,
  count: number,
) {
  await t.run(async (ctx) => {
    const stream = (await ctx.db.get("captureStreams", streamId))!;
    for (let i = 0; i < count; i++)
      await ctx.db.insert("captureAudit", {
        streamId,
        organizationId: stream.organizationId,
        action: "fiscal_halt_deferred",
        actor: "system",
        checkpoint: stream.checkpoint,
        createdAt: Date.now(),
      });
  });
}

it("recovers a gap by consNSU and does not duplicate the already persisted later envelope", async () => {
  const f = await fixture();
  await f.command("activate");
  const first = await claim(f);
  await persist(
    f,
    first,
    distributionXml({
      envelopes: [
        { nsu: 1, xml: corpus("summary-authorized") },
        { nsu: 3, xml: corpus("invoice-authorized") },
      ],
    }),
  );
  await f.t.mutation(internal.operations.checkpoint, first);
  await f.t.mutation(internal.operations.publish, first);
  expect((await f.command()).checkpoint).toBe(nsu(1));
  const manager = await human(f.t, f.scope.organizationId, "owner");
  const version = (await f.command()).version;
  const release = () =>
    manager.client.mutation(api.captures.release, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox",
      expectedVersion: version,
    });
  // The integration's stream is not the console's to release.
  await expect(release()).rejects.toThrow("INTEGRATION_RECORD");
  // Even in the console project, a known gap blocks the transfer.
  await moveStream(f, await consoleProjectFor(f.t, f.scope.organizationId));
  await expect(release()).rejects.toThrow("RECONCILIATION_REQUIRED");
  await moveStream(f, f.scope.projectId);
  // One consNSU for the missing NSU 2; the NSU 3 already stored goes in sequence without
  // another query (#419), and the stream is back to distNSU at the cursor.
  const state = await f.command();
  vi.setSystemTime(state.nextAllowedAt);
  const next = await claim(f);
  expect(await f.t.mutation(internal.captureProcessing.prepare, next)).toMatchObject({
    mode: "consNSU",
    nsu: nsu(2),
  });
  await persist(
    f,
    next,
    distributionXml({ last: 3, max: 3, envelopes: [{ nsu: 2, xml: corpus("event-110111") }] }),
  );
  await f.t.mutation(internal.operations.checkpoint, next);
  await f.t.mutation(internal.operations.publish, next);
  expect(await f.command()).toMatchObject({ checkpoint: nsu(3), state: "active" });
  const stream = await f.t.run(async (ctx) => (await ctx.db.query("captureStreams").first())!);
  expect(stream.mode).toBe("distNSU");
  expect(stream.recovery).toBeUndefined();
  const saved = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
  expect(saved).toHaveLength(3);
  expect(saved.every((e) => e.operationId)).toBe(true);
});

it("stops repeated NSU without shortening the window or duplicating an import", async () => {
  const f = await fixture();
  await f.command("activate");
  const bytes = distributionXml({
    envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
    max: 10,
  });
  for (let i = 0; i < 2; i++) {
    const current = await f.command();
    vi.setSystemTime(Math.max(Date.now(), current.nextAllowedAt));
    const token = await claim(f);
    await persist(f, token, bytes);
    await f.t.mutation(internal.operations.checkpoint, token);
    await f.t.mutation(internal.operations.publish, token);
  }
  expect(await f.command()).toMatchObject({ state: "attention", checkpoint: nsu(1) });
  expect((await f.command()).nextAllowedAt).toBeGreaterThanOrEqual(Date.now() + 3_600_000);
  expect(await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect())).toHaveLength(1);
});

it("certificate revocation fences a reserved source call", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await f.t.run(async (ctx) => {
    const cert = (await ctx.db.query("certificates").first())!;
    await ctx.db.patch("certificates", cert._id, { state: "revoked" });
  });
  expect(await f.t.mutation(internal.captureProcessing.prepare, token)).toBeNull();
  expect(
    await f.t.mutation(internal.operations.recordOutcome, {
      ...token,
      outcome: { kind: "uncertain", code: "SYNTHETIC_RESPONSE" },
    }),
  ).toBe(false);
  expect((await f.command()).state).toBe("attention");
  expect((await f.command()).checkpoint).toBe(nsu(0));
});

it("resumes a partially persisted batch without leaking or duplicating the first envelope", async () => {
  const f = await fixture();
  await f.command("activate");
  const old = await claim(f);
  const bytes = distributionXml({
    envelopes: [
      { nsu: 1, xml: corpus("summary-authorized") },
      { nsu: 2, xml: corpus("invoice-authorized") },
    ],
  });
  const batchId = await raw(f, old, bytes);
  await f.t.mutation(internal.captureProcessing.describe, {
    ...old,
    batchId,
    status: "138",
    lastNsu: nsu(2),
    maxNsu: nsu(2),
    count: 2,
  });
  const e = parseDistribution(bytes, "sandbox").envelopes[0]!;
  const storageId = await f.t.run((ctx) =>
    ctx.storage.store(new Blob([Uint8Array.from(e.xml)], { type: "application/xml" })),
  );
  await f.t.mutation(internal.captureProcessing.envelope, {
    ...old,
    batchId,
    position: 0,
    nsu: e.nsu,
    schema: e.schema,
    sha256: e.sha256,
    storageId,
    size: e.xml.length,
  });
  vi.setSystemTime(Date.now() + 60_001);
  await f.t.mutation(internal.operations.recoverOne, { operationId: old.operationId });
  const op = (await f.t.run((ctx) => ctx.db.get("operations", old.operationId)))!;
  vi.setSystemTime(op.nextAttemptAt);
  await f.t.action(internal.operationWorker.run, {
    operationId: op._id,
    generation: op.generation,
  });
  expect((await f.command()).checkpoint).toBe(nsu(2));
  expect(await f.t.run((ctx) => ctx.db.query("documentArtifacts").collect())).toHaveLength(2);
  expect(
    await f.t.mutation(internal.captureProcessing.envelope, {
      ...old,
      batchId,
      position: 0,
      nsu: e.nsu,
      schema: e.schema,
      sha256: e.sha256,
      storageId,
      size: e.xml.length,
    }),
  ).toBe(false);
});

it("keeps an unavailable persisted batch in attention instead of silently querying again", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  const batchId = await raw(f, token, distributionXml());
  await f.t.run(async (ctx) => {
    const batch = (await ctx.db.get("captureBatches", batchId))!;
    await ctx.storage.delete(batch.rawId);
  });
  const result = await f.t.action(internal.captureWorker.execute, { ...token, request: "{}" });
  expect(result).toEqual({ kind: "definitive", code: "BATCH_UNAVAILABLE" });
  expect(await f.command()).toMatchObject({ state: "attention", checkpoint: nsu(0) });
});

it("homologation requires explicit transport opt-in and rejects local synthetic mutation there", async () => {
  expect(requirePlatformEnvironment().fiscalEnv).toBe("disabled");
  vi.stubEnv("FISCAL_ENV", "homologation");
  expect(() => requirePlatformEnvironment()).toThrow();
  vi.stubEnv("FNFE_CAPTURE_TRANSPORT", "sefaz");
  expect(requirePlatformEnvironment().fiscalEnv).toBe("homologation");
  const f = await fixture();
  const stream = await f.command("activate");
  await expect(
    f.t.mutation(internal.testing.captureProof.set, { streamId: stream.id, xml: "<synthetic/>" }),
  ).rejects.toThrow("SYNTHETIC_FISCAL_ENV_REQUIRED");
  vi.stubEnv("FISCAL_ENV", "production");
  expect(() => requirePlatformEnvironment()).toThrow();
});

async function fiscalFixture() {
  const f = await fixture();
  const stream = await f.command("activate");
  const token = await claim(f);
  const certificate = await f.t.run(async (ctx) => {
    const op = (await ctx.db.get("operations", token.operationId))!;
    const cert = (await ctx.db.get("certificates", op.certificate!.id))!;
    await ctx.db.patch("certificates", cert._id, {
      metadata: { ...cert.metadata!, fingerprint: "b".repeat(64) },
    });
    return cert;
  });
  const policy: FiscalProofPolicy = {
    deploymentUrl: "https://synthetic-fiscal-123.convex.cloud",
    fiscalEnvironment: "homologation",
    sha: "a".repeat(40),
    ...f.scope,
    certificateId: certificate._id,
    certificateVersion: certificate.version,
    fingerprint: "b".repeat(64),
    cnpj: "00000000000191",
    startsAt: Date.now() - 1000,
    expiresAt: Date.now() + 2 * 3600_000,
    maxRequests: 1,
  };
  for (const [name, value] of Object.entries({
    APP_ENV: "validation",
    EMAIL_MODE: "disabled",
    FISCAL_ENV: "homologation",
    FNFE_CAPTURE_TRANSPORT: "sefaz",
    CONVEX_CLOUD_URL: policy.deploymentUrl,
    SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    FNFE_FISCAL_PROOF: JSON.stringify(policy),
  }))
    vi.stubEnv(name, value);
  return { ...f, stream, token, policy, certificate };
}

/** The dedicated #50 target marked for fiscal production: platform environment production too. */
async function productionFiscalFixture() {
  const f = await fixture();
  const certificate = await f.t.run(async (ctx) => {
    await ctx.db.patch("apiKeys", f.scope.keyId, { environment: "production" });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { environments: ["production"] });
    const head = (await ctx.db
      .query("certificateHeads")
      .filter((q) => q.eq(q.field("companyId"), f.scope.companyId))
      .unique())!;
    const cert = (await ctx.db.get("certificates", head.activeId!))!;
    await ctx.db.patch("certificates", cert._id, {
      metadata: { ...cert.metadata!, fingerprint: "b".repeat(64) },
    });
    return cert;
  });
  // The proof's production query, like any production capture, needs the plan (#429).
  await capturePlan(f.t, f.scope.organizationId);
  const policy: FiscalProofPolicy = {
    deploymentUrl: "https://synthetic-fiscal-123.convex.cloud",
    fiscalEnvironment: "production",
    sha: "a".repeat(40),
    ...f.scope,
    certificateId: certificate._id,
    certificateVersion: certificate.version,
    fingerprint: "b".repeat(64),
    cnpj: "00000000000191",
    startsAt: Date.now() - 1000,
    expiresAt: Date.now() + 2 * 3600_000,
    maxRequests: 2,
  };
  for (const [name, value] of Object.entries({
    APP_ENV: "validation",
    PRODUCT_ENV: "production",
    FNFE_PROOF_FISCAL_ENV: "production",
    EMAIL_MODE: "disabled",
    FISCAL_ENV: "production",
    FNFE_CAPTURE_TRANSPORT: "sefaz",
    CONVEX_CLOUD_URL: policy.deploymentUrl,
    SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    FNFE_FISCAL_PROOF: JSON.stringify(policy),
  }))
    vi.stubEnv(name, value);
  f.args.environment = "production";
  const stream = await f.command("activate");
  const token = await claim(f);
  return { ...f, stream, token, policy, certificate };
}

it("fiscal production exists only on the marked validation target, with production data", () => {
  vi.stubEnv("FNFE_PROOF_FISCAL_ENV", "production");
  // Local development cannot carry the mark.
  expect(() => requirePlatformEnvironment()).toThrow("FNFE_PROOF_FISCAL_ENV");
  for (const [name, value] of Object.entries({
    APP_ENV: "validation",
    EMAIL_MODE: "disabled",
    SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
  }))
    vi.stubEnv(name, value);
  // The marked target serves production data even with transport off.
  expect(() => requirePlatformEnvironment()).toThrow("PRODUCT_ENV");
  vi.stubEnv("PRODUCT_ENV", "production");
  expect(requirePlatformEnvironment()).toMatchObject({
    profile: "validation",
    productEnv: "production",
    fiscalEnv: "disabled",
  });
  vi.stubEnv("FISCAL_ENV", "homologation");
  vi.stubEnv("FNFE_CAPTURE_TRANSPORT", "sefaz");
  expect(() => requirePlatformEnvironment()).toThrow("FISCAL_ENV");
  vi.stubEnv("FISCAL_ENV", "production");
  expect(requirePlatformEnvironment().fiscalEnv).toBe("production");
  vi.stubEnv("FNFE_PROOF_FISCAL_ENV", "homologation");
  expect(() => requirePlatformEnvironment()).toThrow("FNFE_PROOF_FISCAL_ENV");
});

it("fiscal production proof reads the production distribution under its own policy", async () => {
  const f = await productionFiscalFixture();
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).not.toBeNull();
  await f.t.mutation(internal.certificateUse.complete, { ...f.token, result: "success" });
  const transport = vi.spyOn(certificateRuntime, "transportWithCertificate").mockResolvedValue({
    status: 200,
    body: distributionXml({ status: "137", last: 0, max: 0, environment: "1" }),
  });
  try {
    const result = await f.t.action(internal.captureWorker.execute, { ...f.token, request: "{}" });
    expect(result.kind).toBe("success");
    expect(transport).toHaveBeenCalledTimes(1);
    const request = transport.mock.calls[0]![2];
    expect(request.url).toBe(
      "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
    );
    expect(request.body).toContain("<tpAmb>1</tpAmb>");
  } finally {
    transport.mockRestore();
  }
});

it.each([
  ["homologation policy", { fiscalEnvironment: "homologation" }],
  ["policy without fiscal environment", { fiscalEnvironment: undefined }],
] as const)("fiscal production refuses a %s", async (_, change) => {
  const f = await productionFiscalFixture();
  vi.stubEnv("FNFE_FISCAL_PROOF", JSON.stringify({ ...f.policy, ...change }));
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
});

it("a production policy does not open the homologation target", async () => {
  const f = await fiscalFixture();
  vi.stubEnv("FNFE_FISCAL_PROOF", JSON.stringify({ ...f.policy, fiscalEnvironment: "production" }));
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
});

it("successful fiscal production step pauses without a continuation", async () => {
  const f = await productionFiscalFixture();
  await f.t.run((ctx) => ctx.db.patch("operations", f.token.operationId, { state: "succeeded" }));
  await f.t.mutation(internal.captureProcessing.published, { operationId: f.token.operationId });
  expect(await f.t.run((ctx) => ctx.db.get("captureStreams", f.stream.id))).toMatchObject({
    state: "paused",
    code: "FISCAL_PROOF_STEP_COMPLETE",
  });
  expect(await f.t.run((ctx) => ctx.db.query("operations").collect())).toHaveLength(1);
});

it("the proof runner names the console project only on a validation target", async () => {
  const f = await fixture();
  const call = () =>
    f.t.mutation(internal.captureProcessing.proofConsoleProject, {
      organizationId: f.scope.organizationId,
    });
  await expect(call()).rejects.toThrow("FISCAL_PROOF_DENIED");
  vi.stubEnv("APP_ENV", "validation");
  const id = await call();
  expect(await call()).toBe(id);
  expect(id).toBe(await consoleProjectFor(f.t, f.scope.organizationId));
});

it("fiscal proof consumes its transport budget even when the first request fails", async () => {
  const f = await fiscalFixture();
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).not.toBeNull();
  await f.t.mutation(internal.certificateUse.complete, { ...f.token, result: "failed" });
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
  vi.stubEnv(
    "FNFE_FISCAL_PROOF",
    JSON.stringify({ ...f.policy, startsAt: Date.now(), expiresAt: Date.now() + 3600_000 }),
  );
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
});

it("the capture action reads the current Node environment after its object is replaced", async () => {
  const f = await fiscalFixture();
  const previousEnv = process.env;
  vi.stubEnv("FNFE_CAPTURE_TRANSPORT", "disabled");
  process.env = { ...previousEnv, FNFE_CAPTURE_TRANSPORT: "sefaz" };
  const transport = vi.spyOn(certificateRuntime, "transportWithCertificate").mockResolvedValue({
    status: 200,
    body: distributionXml({ status: "137", last: 0, max: 0 }),
  });
  try {
    const result = await f.t.action(internal.captureWorker.execute, { ...f.token, request: "{}" });
    expect(result.kind).toBe("success");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await f.t.run((ctx) => ctx.db.query("captureBatches").collect())).toHaveLength(1);
  } finally {
    process.env = previousEnv;
    transport.mockRestore();
  }
});

it.each(["disabled", "production", ""])(
  "fiscal mode %s prevents a previously started worker from obtaining the certificate",
  async (fiscalEnv) => {
    const f = await fiscalFixture();
    vi.stubEnv("FISCAL_ENV", fiscalEnv);
    vi.stubEnv("FNFE_CAPTURE_TRANSPORT", "disabled");
    const authorization = f.t.mutation(internal.certificateUse.authorize, f.token);
    if (fiscalEnv === "disabled") await expect(authorization).resolves.toBeNull();
    else await expect(authorization).rejects.toThrow("Invalid platform configuration: FISCAL_ENV");
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("certificateAudit")
          .withIndex("by_certificateId_and_action_and_result", (q) =>
            q
              .eq("certificateId", f.certificate._id)
              .eq("action", "transport")
              .eq("result", "authorized"),
          )
          .collect(),
      ),
    ).toHaveLength(0);
  },
);

it.each([
  ["sha", "c".repeat(40)],
  ["deploymentUrl", "https://other-target-123.convex.cloud"],
  ["cnpj", "11111111000191"],
  ["companyId", "foreign"],
  ["projectId", "foreign"],
  ["organizationId", "foreign"],
  ["certificateId", "foreign"],
  ["certificateVersion", 2],
  ["fingerprint", "c".repeat(64)],
  ["maxRequests", 3],
  ["maxRequests", 0],
] as const)("fiscal proof refuses mismatched or invalid %s", async (field, value) => {
  const f = await fiscalFixture();
  vi.stubEnv("FNFE_FISCAL_PROOF", JSON.stringify({ ...f.policy, [field]: value }));
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
});

it("fiscal proof fails closed for absent policy, future or expired windows and revoked access", async () => {
  const f = await fiscalFixture();
  for (const policy of [
    "",
    "{",
    JSON.stringify({ ...f.policy, startsAt: Date.now() + 1000 }),
    JSON.stringify({ ...f.policy, startsAt: Date.now() - 2000, expiresAt: Date.now() }),
    JSON.stringify({ ...f.policy, expiresAt: Date.now() + 4 * 3600_000 }),
  ]) {
    vi.stubEnv("FNFE_FISCAL_PROOF", policy);
    expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
  }
  vi.stubEnv("FNFE_FISCAL_PROOF", JSON.stringify(f.policy));
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
});

it("fiscal proof denial before IO preserves the source window and does not invent uncertainty", async () => {
  const f = await fiscalFixture();
  vi.stubEnv("FNFE_FISCAL_PROOF", "");
  expect(await f.t.mutation(internal.captureProcessing.prepare, f.token)).toBeNull();
  const op = await f.t.run((ctx) => ctx.db.get("operations", f.token.operationId));
  expect(op).toMatchObject({ state: "paused", uncertain: false, code: "FISCAL_PROOF_DENIED" });
  const stream = await f.t.run((ctx) => ctx.db.get("captureStreams", f.stream.id));
  expect(stream?.nextAllowedAt).toBe(f.stream.nextAllowedAt);
});

it("successful fiscal proof pauses without a continuation or changing persisted checkpoint/cooldown", async () => {
  const f = await fiscalFixture();
  const nextAllowedAt = Date.now() + 3600_000;
  await f.t.run(async (ctx) => {
    await ctx.db.patch("operations", f.token.operationId, { state: "succeeded" });
    await ctx.db.patch("captureStreams", f.stream.id, { checkpoint: nsu(2), nextAllowedAt });
  });
  await f.t.mutation(internal.captureProcessing.published, { operationId: f.token.operationId });
  const stream = await f.t.run((ctx) => ctx.db.get("captureStreams", f.stream.id));
  expect(stream).toMatchObject({
    state: "paused",
    checkpoint: nsu(2),
    nextAllowedAt,
    operationId: f.token.operationId,
    code: "FISCAL_PROOF_STEP_COMPLETE",
  });
  expect(await f.t.run((ctx) => ctx.db.query("operations").collect())).toHaveLength(1);
});

it("public HTTP validates environment, selector and manual version without accepting a cursor", async () => {
  const f = await fixture();
  const call = (body: unknown, environment = "sandbox") =>
    f.t.fetch("/v1/connections/nfe", {
      method: "POST",
      headers: { Authorization: `Bearer ${f.secret}`, "X-Environment": environment },
      body: JSON.stringify(body),
    });
  const activated = await call({ companyId: f.scope.companyId, action: "activate" });
  expect(activated.status).toBe(200);
  expect(
    (await call({ companyId: f.scope.companyId, action: "sync", checkpoint: nsu(100) })).status,
  ).toBe(400);
  expect(
    (await call({ companyId: f.scope.companyId, action: "activate" }, "production")).status,
  ).toBe(403);
});

/**
 * #433: the panel's last queries (`captures.history`) and the summaries' link
 * (`documents.summaryCount`, `documents.list` with `completeness`), read by people of the
 * organization with access to the company, from the stream's real audit.
 */
async function publishAll(f: Awaited<ReturnType<typeof fixture>>, token: Claim) {
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  const envelopes = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
  for (const e of envelopes)
    if (e.operationId)
      await f.t.action(internal.operationWorker.run, { operationId: e.operationId, generation: 1 });
}
const companyScope = (f: Awaited<ReturnType<typeof fixture>>) => ({
  organizationId: f.scope.organizationId,
  companyId: f.scope.companyId,
  environment: "sandbox" as const,
});
it("the first query of a new capture is in progress until it is answered (#433)", async () => {
  const f = await fixture();
  await f.command("activate");
  const first = await claim(f);
  await f.t.mutation(internal.captureProcessing.prepare, first);
  const viewer = await person(f.t, f.scope.organizationId, "viewer", {
    companyId: f.scope.companyId,
  });
  expect(await viewer.query(api.captures.history, companyScope(f))).toEqual([
    {
      at: expect.any(Number),
      kind: "query",
      outcome: "running",
      status: null,
      documents: null,
      code: null,
    },
  ]);
});
it("tells each query's time, result and documents, newest first (#433)", async () => {
  const f = await fixture();
  // A new session at each reading: the clock moves an hour at each query.
  const viewer = () =>
    person(f.t, f.scope.organizationId, "viewer", { companyId: f.scope.companyId });
  expect(await (await viewer()).query(api.captures.history, companyScope(f))).toEqual([]);
  await f.command("activate");
  const first = await claim(f);
  const sentAt = Date.now();
  await persist(
    f,
    first,
    distributionXml({ envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }] }),
  );
  await publishAll(f, first);
  const second = await claim(f);
  await persist(f, second, distributionXml({ last: 1 }));
  await f.t.mutation(internal.operations.checkpoint, second);
  let history = await (await viewer()).query(api.captures.history, companyScope(f));
  expect(history).toEqual([
    {
      at: expect.any(Number),
      kind: "query",
      outcome: "answered",
      status: "137",
      documents: 0,
      code: null,
    },
    { at: sentAt, kind: "query", outcome: "answered", status: "138", documents: 1, code: null },
  ]);
  expect(history[0]!.at).toBeGreaterThan(sentAt);
  // A query sent and not answered yet is still out.
  await f.t.mutation(internal.operations.publish, second);
  const third = await claim(f);
  await f.t.mutation(internal.captureProcessing.prepare, third);
  history = await (await viewer()).query(api.captures.history, companyScope(f));
  expect(history[0]).toMatchObject({ outcome: "running", documents: null });
  expect(history).toHaveLength(3);
});
it("shows a source refusal, a stop without answer and keeps at most 10 queries (#433)", async () => {
  const f = await fixture();
  const owner = await person(f.t, f.scope.organizationId, "owner");
  await f.command("activate");
  const blocked = await claim(f);
  await persist(f, blocked, distributionXml({ status: "656" }));
  await f.t.mutation(internal.operations.checkpoint, blocked);
  let [last] = await owner.query(api.captures.history, companyScope(f));
  expect(last).toMatchObject({
    outcome: "refused",
    status: "656",
    documents: null,
    code: "SOURCE_CONSUMPTION_BLOCKED",
  });
  // Fill the audit with starts: the history stops at 10, newest first.
  await f.t.run(async (ctx) => {
    const stream = (await ctx.db.query("captureStreams").first())!;
    for (let i = 0; i < 11; i++)
      await ctx.db.insert("captureAudit", {
        streamId: stream._id,
        organizationId: stream.organizationId,
        action: "query_started",
        actor: "system",
        checkpoint: stream.checkpoint,
        createdAt: Date.now() + i,
      });
    await ctx.db.insert("captureAudit", {
      streamId: stream._id,
      organizationId: stream.organizationId,
      action: "FISCAL_TRANSPORT_DISABLED",
      actor: "system",
      checkpoint: stream.checkpoint,
      createdAt: Date.now() + 20,
    });
  });
  const history = await owner.query(api.captures.history, companyScope(f));
  expect(history).toHaveLength(10);
  [last] = history;
  expect(last).toMatchObject({ outcome: "stopped", code: "FISCAL_TRANSPORT_DISABLED" });
  expect(history[1]).toMatchObject({ outcome: "unanswered" });
  expect(history.map((entry) => entry.at)).toEqual(
    history.map((entry) => entry.at).sort((a, b) => b - a),
  );
});
it("a vault refusal before the request is a query not sent (#433)", async () => {
  const f = await fixture();
  const owner = await person(f.t, f.scope.organizationId, "owner");
  await f.command("activate");
  const token = await claim(f);
  await f.t.mutation(internal.captureProcessing.prepare, token);
  await f.t.mutation(internal.captureProcessing.refusedBeforeSend, {
    ...token,
    code: "CERTIFICATE_UNAVAILABLE",
    defer: null,
  });
  const [last] = await owner.query(api.captures.history, companyScope(f));
  expect(last).toMatchObject({ outcome: "not-sent", documents: null });
});
it("the history obeys the capture's access and the stream's organization (#433)", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(f, token, distributionXml());
  await f.t.mutation(internal.operations.checkpoint, token);
  const developer = await person(f.t, f.scope.organizationId, "developer", {
    companyId: f.scope.companyId,
  });
  await expect(developer.query(api.captures.history, companyScope(f))).rejects.toThrow(
    "SCOPE_DENIED",
  );
  // A viewer without access to the company.
  const outsider = await person(f.t, f.scope.organizationId, "viewer");
  await expect(outsider.query(api.captures.history, companyScope(f))).rejects.toThrow();
  // Another organization's owner, naming this company with either organization.
  const other = await fixture(f.t);
  const stranger = await person(f.t, other.scope.organizationId, "owner");
  await expect(stranger.query(api.captures.history, companyScope(f))).rejects.toThrow();
  await expect(
    stranger.query(api.captures.history, {
      ...companyScope(f),
      organizationId: other.scope.organizationId,
    }),
  ).rejects.toThrow();
  // Rows of the organization a capture came from stay with it after a transfer.
  const owner = await person(f.t, f.scope.organizationId, "owner");
  expect(await owner.query(api.captures.history, companyScope(f))).toHaveLength(1);
  await f.t.run(async (ctx) => {
    for (const row of await ctx.db.query("captureAudit").collect())
      await ctx.db.patch("captureAudit", row._id, { organizationId: other.scope.organizationId });
  });
  expect(await owner.query(api.captures.history, companyScope(f))).toEqual([]);
});
it("counts and lists the documents that arrived only as the summary (#433)", async () => {
  const f = await fixture();
  // A new session at each reading: the clock moves an hour at each query.
  const viewer = () =>
    person(f.t, f.scope.organizationId, "viewer", { companyId: f.scope.companyId });
  expect(await (await viewer()).query(api.documents.summaryCount, companyScope(f))).toEqual({
    count: 0,
    more: false,
  });
  await f.command("activate");
  const first = await claim(f);
  await persist(
    f,
    first,
    distributionXml({ envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }] }),
  );
  await publishAll(f, first);
  expect(await (await viewer()).query(api.documents.summaryCount, companyScope(f))).toEqual({
    count: 1,
    more: false,
  });
  const list = async (filters: Record<string, unknown> = {}) =>
    (await viewer()).query(api.documents.list, {
      ...companyScope(f),
      cursor: null,
      limit: 20,
      completeness: "summary" as const,
      ...filters,
    });
  let page = await list();
  expect(page.page.map((doc) => doc.completeness)).toEqual(["summary"]);
  // The summary has no nNF: the number comes from the key, as the full XML will say (#462).
  const summarized = page.page[0]!;
  expect(summarized.number).toBe("69");
  expect((await list({ status: "cancelled" })).page).toEqual([]);
  expect((await list({ source: "imported-xml" })).page).toEqual([]);
  expect((await list({ source: "distribution-xml" })).page).toHaveLength(1);
  expect((await list({ key: page.page[0]!.key })).page).toHaveLength(1);
  // Access: the developer reads no documents in the console; another organization neither.
  const developer = await person(f.t, f.scope.organizationId, "developer", {
    companyId: f.scope.companyId,
  });
  await expect(developer.query(api.documents.summaryCount, companyScope(f))).rejects.toThrow();
  await expect(
    developer.query(api.documents.list, {
      ...companyScope(f),
      cursor: null,
      limit: 20,
      completeness: "summary",
    }),
  ).rejects.toThrow();
  const other = await fixture(f.t);
  const stranger = await person(f.t, other.scope.organizationId, "owner");
  await expect(stranger.query(api.documents.summaryCount, companyScope(f))).rejects.toThrow();
  // The full XML arrives later: the note leaves the summaries.
  const second = await claim(f);
  await persist(
    f,
    second,
    distributionXml({
      last: 2,
      envelopes: [{ nsu: 2, xml: corpus("invoice-authorized"), schema: "procNFe_v4.00.xsd" }],
    }),
  );
  await publishAll(f, second);
  expect(await (await viewer()).query(api.documents.summaryCount, companyScope(f))).toEqual({
    count: 0,
    more: false,
  });
  page = await list();
  expect(page.page).toEqual([]);
  const full = await (
    await viewer()
  ).query(api.documents.list, { ...companyScope(f), cursor: null, limit: 20, key: summarized.key });
  expect(full.page.map((doc) => [doc.id, doc.completeness, doc.number])).toEqual([
    [summarized.id, "full-xml", "69"],
  ]);
  // Rows the list hides (not published yet, emitted) come first in the index and do not take
  // the place of the summaries it shows: 120 of them, then 101 published summaries.
  await f.t.run(async (ctx) => {
    const doc = (await ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_and_companyId_and_environment_and_completeness", (q) =>
        q
          .eq("organizationId", f.scope.organizationId)
          .eq("companyId", f.scope.companyId)
          .eq("environment", "sandbox"),
      )
      .first())!;
    const { _id, _creationTime, publishedVersionId, direction, ...fields } = doc;
    void [_id, _creationTime, direction];
    for (let n = 0; n < 120; n++)
      await ctx.db.insert("fiscalDocuments", {
        ...fields,
        completeness: 1,
        ...(n % 2 ? { direction: "emitted" as const, publishedVersionId } : {}),
      });
    for (let n = 0; n < 101; n++)
      await ctx.db.insert("fiscalDocuments", {
        ...fields,
        completeness: 1,
        publishedVersionId,
      });
  });
  expect(await (await viewer()).query(api.documents.summaryCount, companyScope(f))).toEqual({
    count: 100,
    more: true,
  });
});
