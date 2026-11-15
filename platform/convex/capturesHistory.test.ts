import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import { distributionXml } from "../../tests/helpers/distribution";
import { person } from "../../tests/helpers/platform";
import { fixture as corpus } from "../../tests/helpers/nfe-corpus";
import type { Claim } from "./lib/operationCore";
import type { Id } from "./_generated/dataModel";
import { fixture, claim, persist } from "../../tests/helpers/captures";

/**
 * #433: the panel's last queries (`captures.history`) and the summaries' link
 * (`documents.summaryCount`, `documents.list` with `completeness`), read by people of the
 * organization with access to the company, from the stream's real audit.
 */
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
it("accepted losses show only the stream's organization after a transfer", async () => {
  const f = await fixture();
  await f.command("activate");
  const other = await fixture(f.t);
  const owner = await person(f.t, f.scope.organizationId, "owner");
  // One loss accepted by the organization the capture came from, one by the current one.
  await f.t.run(async (ctx) => {
    const stream = (await ctx.db.query("captureStreams").first())!;
    const accepted = (organizationId: Id<"organizations">, from: string, reason: string) =>
      ctx.db.insert("captureAudit", {
        streamId: stream._id,
        organizationId,
        action: "history_limited",
        actor: "system",
        checkpoint: stream.checkpoint,
        lost: { from, to: from, confirmedVersion: 1, reason },
        createdAt: Date.now(),
      });
    await accepted(other.scope.organizationId, "1", "Justificativa da organização anterior");
    await accepted(f.scope.organizationId, "2", "Justificativa da organização atual");
  });
  const view = await owner.query(api.captures.get, companyScope(f));
  expect(view!.gap.accepted).toEqual([
    expect.objectContaining({ from: "2", reason: "Justificativa da organização atual" }),
  ]);
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
