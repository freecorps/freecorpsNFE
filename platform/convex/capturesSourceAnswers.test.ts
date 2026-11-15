import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import { distributionXml, nsu } from "../../tests/helpers/distribution";
import { fixture as corpus } from "../../tests/helpers/nfe-corpus";
import type { Id } from "./_generated/dataModel";
import { setup, human, fixture, claim, persist } from "../../tests/helpers/captures";

/**
 * What the source answered: its last NSU, refusals and the 999 attention.
 * Companies, keys and documents are synthetic; nothing here reaches a tax authority.
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
/** One query answered with `bytes`, committed and, while the stream goes on, continued. */
async function answer(f: Awaited<ReturnType<typeof fixture>>, bytes: Buffer) {
  const token = await claim(f);
  await persist(f, token, bytes);
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  return f.t.run(async (ctx) => (await ctx.db.query("captureStreams").first())!);
}
const attentionEvents = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.t.run(async (ctx) =>
    (await ctx.db.query("outboxEvents").collect()).filter(
      (event) => event.type === "connection.attention_required",
    ),
  );
it("um 999 da fonte repete a consulta, e só o terceiro seguido para a captura (#195)", async () => {
  const f = await fixture();
  await f.command("activate");
  const first = await answer(
    f,
    distributionXml({
      last: 1,
      max: 1,
      envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
    }),
  );
  expect(first).toMatchObject({ state: "active", checkpoint: nsu(1) });
  for (const count of [1, 2]) {
    const before = Date.now();
    const stream = await answer(f, distributionXml({ status: "999", last: 1, max: 1 }));
    // The stream goes on, after at least the source's hour, where it stopped.
    expect(stream).toMatchObject({
      state: "active",
      code: "SOURCE_999",
      sourceErrors: count,
      checkpoint: nsu(1),
      sourceCursor: first.sourceCursor,
      mode: first.mode,
    });
    expect(stream.recovery).toBeUndefined();
    expect(stream.nextAllowedAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(await attentionEvents(f)).toEqual([]);
  }
  const stopped = await answer(f, distributionXml({ status: "999", last: 1, max: 1 }));
  expect(stopped).toMatchObject({ state: "attention", code: "SOURCE_999", checkpoint: nsu(1) });
  expect(stopped.sourceErrors).toBeUndefined();
  expect(await attentionEvents(f)).toHaveLength(1);
  // Each 999 reaches the monitors; the two retries are in the stream's history.
  const failures = await f.t.run((ctx) => ctx.db.query("operationalFailures").collect());
  expect(failures.map((row) => [row.source, row.code])).toEqual([
    ["nfe-distribution", "SOURCE_999"],
    ["nfe-distribution", "SOURCE_999"],
    ["nfe-distribution", "SOURCE_999"],
  ]);
  const audit = await f.t.run((ctx) => ctx.db.query("captureAudit").collect());
  expect(audit.filter((row) => row.action === "source_retry")).toHaveLength(2);
  // A resume gets the retries again: one more 999 does not stop it.
  await f.command("resume", (await f.command()).version);
  expect(await answer(f, distributionXml({ status: "999", last: 1, max: 1 }))).toMatchObject({
    state: "active",
    sourceErrors: 1,
  });
});
it("um 999 seguido de resposta zera a contagem e não muda checkpoint nem cursor (#195)", async () => {
  const f = await fixture();
  await f.command("activate");
  await answer(f, distributionXml({ status: "999", last: 0, max: 0 }));
  await answer(f, distributionXml({ status: "999", last: 0, max: 0 }));
  const answered = await answer(
    f,
    distributionXml({
      last: 1,
      max: 1,
      envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
    }),
  );
  expect(answered).toMatchObject({ state: "active", checkpoint: nsu(1) });
  expect(answered.sourceErrors).toBeUndefined();
  // Two more 999 after the answer still retry: the count started over.
  for (const count of [1, 2])
    expect(await answer(f, distributionXml({ status: "999", last: 1, max: 1 }))).toMatchObject({
      state: "active",
      sourceErrors: count,
      checkpoint: nsu(1),
    });
  expect(await attentionEvents(f)).toEqual([]);
});
it("outra atenção no meio dos 999 também zera a contagem para a retomada (#195)", async () => {
  const f = await fixture();
  await f.command("activate");
  await answer(
    f,
    distributionXml({
      last: 1,
      max: 1,
      envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
    }),
  );
  await answer(f, distributionXml({ status: "999", last: 1, max: 1 }));
  await answer(f, distributionXml({ status: "999", last: 1, max: 1 }));
  // A 138 that repeats the checkpoint stops the stream with another code, not through the count.
  const repeated = await answer(
    f,
    distributionXml({
      last: 1,
      max: 1,
      envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
    }),
  );
  expect(repeated).toMatchObject({ state: "attention", code: "REPEATED_NSU" });
  expect(repeated.sourceErrors).toBeUndefined();
  await f.command("resume", (await f.command()).version);
  expect(await answer(f, distributionXml({ status: "999", last: 1, max: 1 }))).toMatchObject({
    state: "active",
    sourceErrors: 1,
  });
});
it("outro código recusado da fonte continua parando na primeira vez (#195)", async () => {
  const f = await fixture();
  await f.command("activate");
  const stream = await answer(f, distributionXml({ status: "593", last: 0, max: 0 }));
  expect(stream).toMatchObject({ state: "attention", code: "SOURCE_593" });
  expect(stream.sourceErrors).toBeUndefined();
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
