/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../platform/convex/_generated/api";
import type { Doc, Id } from "../platform/convex/_generated/dataModel";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import {
  RECOVERY_BACKOFF,
  RECOVERY_BACKOFF_LIMIT,
  RECOVERY_BACKOFF_MS,
  RECOVERY_HOURLY_LIMIT,
  recoverySlot,
} from "../platform/convex/lib/captureGap";
import { SITE_CAPTURE_ACTION, SITE_CAPTURE_HOURLY_LIMIT } from "../platform/convex/lib/siteCapture";
import * as certificateCrypto from "../platform/convex/lib/certificateCrypto";
import * as certificateTransport from "../platform/convex/lib/certificateTransport";
import * as webhookNetwork from "../platform/convex/lib/webhookNetwork";
import { encryptSecret } from "../platform/convex/lib/webhookSecrets";
import { verifyWebhook } from "../packages/contracts/src/webhooks";
import { capturePlan, person, platformTest, type Role } from "./helpers/platform";
import { distributionXml, nsu } from "./helpers/distribution";
import { fixture as corpus } from "./helpers/nfe-corpus";
import { CAPTURE_TERMS_VERSION } from "../platform/convex/lib/fiscalCaptureRelease";

/**
 * #419: a gap in a production capture of the site. A recoverable gap is recovered in a chain of
 * `consNSU`, within the hourly budget; the bottom the source no longer has (137) is located and
 * waits for the owner to accept its loss, with a reason, after which the stream goes on with `distNSU`.
 * The source is simulated behind the real worker, vault and `certificateRequest` (mTLS) path.
 */
vi.mock("../platform/convex/buildInfo", () => ({ buildSha: "a".repeat(40) }));
const CNPJ = "00000000000191";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const development = {
  APP_ENV: "development",
  PRODUCT_ENV: "sandbox",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  EMAIL_MODE: "local",
  WEBHOOK_MODE: "disabled",
  SITE_URL: "http://localhost:5219",
  CONVEX_SITE_URL: "http://127.0.0.1:3279",
  BETTER_AUTH_SECRET: "synthetic-capture-gap",
};
const site = {
  APP_ENV: "installation",
  PRODUCT_ENV: "sandbox",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  EMAIL_MODE: "disabled",
  WEBHOOK_MODE: "disabled",
  AUTH_PROXY_MODE: "signed",
  AUTH_PROXY_SECRET: "b".repeat(64),
  SITE_URL: "https://console.operator.invalid",
  CONVEX_SITE_URL: "https://api.operator.invalid",
  API_URL: "https://rest.operator.invalid",
  BETTER_AUTH_SECRET: "synthetic-capture-gap",
  FNFE_CAPTURE_FISCAL: "enabled",
  FNFE_CAPTURE_TRANSPORT: "sefaz",
};
const stub = (profile: Record<string, string>) => {
  for (const [name, value] of Object.entries(profile)) vi.stubEnv(name, value);
};
beforeEach(() => {
  vi.useFakeTimers();
  stub(development);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/**
 * The distribution of one CNPJ, as NT 2014.002 v1.40 describes it: `distNSU` returns up to 50
 * NSUs above the one asked, in order, from the oldest still distributed (§3.5); `consNSU` returns
 * the NSU asked or 137 when the source no longer has it (§3.6). `distributed` lets a test drop
 * NSUs from `distNSU` that `consNSU` still finds, the distribution failure §3.6 describes.
 */
class Source {
  max = 0;
  available: (n: number) => boolean = () => true;
  distributed: (n: number) => boolean = (n) => this.available(n);
  requests: { at: number; mode: "distNSU" | "consNSU"; nsu: number }[] = [];
  /** The `consNSU` (1-based) the source answers 656, once. */
  blockAt: number | undefined;
  answer(body: string) {
    const dist = /<ultNSU>(\d{15})<\/ultNSU>/.exec(body);
    const cons = /<NSU>(\d{15})<\/NSU>/.exec(body);
    const asked = Number((dist ?? cons)![1]);
    this.requests.push({ at: Date.now(), mode: dist ? "distNSU" : "consNSU", nsu: asked });
    const envelope = (n: number) => ({ nsu: n, xml: corpus("summary-authorized") });
    if (cons && this.blockAt === this.consNSU().length) {
      // Another system of the CNPJ spent the quota: the source blocks this query.
      this.blockAt = undefined;
      return distributionXml({ status: "656", environment: "1", last: asked, max: this.max });
    }
    if (cons) {
      if (asked > this.max)
        return distributionXml({ status: "589", environment: "1", max: this.max });
      return this.available(asked)
        ? distributionXml({
            environment: "1",
            last: asked,
            max: this.max,
            envelopes: [envelope(asked)],
          })
        : distributionXml({ status: "137", environment: "1", last: asked, max: this.max });
    }
    const found: number[] = [];
    for (let n = asked + 1; n <= this.max && found.length < 50; n++)
      if (this.distributed(n)) found.push(n);
    return found.length
      ? distributionXml({ environment: "1", max: this.max, envelopes: found.map(envelope) })
      : distributionXml({ status: "137", environment: "1", last: this.max, max: this.max });
  }
  /** How many `consNSU` left in the hour ending at each request: the most of any hour. */
  busiestHour(since = 0) {
    const cons = this.requests
      .filter((r) => r.mode === "consNSU" && r.at >= since)
      .map((r) => r.at);
    return Math.max(0, ...cons.map((at) => cons.filter((t) => t > at - HOUR && t <= at).length));
  }
  consNSU() {
    return this.requests.filter((r) => r.mode === "consNSU").map((r) => r.nsu);
  }
}

/** A released company with its own A1, served by the site profile, and the simulated source. */
async function siteFixture() {
  vi.unstubAllEnvs();
  stub(development);
  const t = platformTest();
  const keyHash = await hashApiKey(
    `fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`,
  );
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  // Production capture requires the organization's plan with finite quotas (#429).
  await capturePlan(t, scope.organizationId);
  await t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", scope.keyId))!;
    const scopes = [...key.scopes, "connections:read", "documents:read"] as const;
    await ctx.db.patch("apiKeys", key._id, {
      scopes: [...scopes],
      environment: "production",
      expiresAt: Date.now() + 400 * DAY,
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: [...scopes],
      environments: ["sandbox", "production"],
    });
    await ctx.db.patch("companies", scope.companyId, { kind: "declared", cnpj: CNPJ });
    const id = await ctx.db.insert("certificates", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      version: 1,
      state: "active",
      uploaderId: "proof",
      membershipId: key.creatorMembershipId,
      membershipVersion: 1,
      metadata: {
        fingerprint: "c".repeat(64),
        subject: "test",
        cnpj: CNPJ,
        notBefore: Date.now() - 1000,
        notAfter: Date.now() + 400 * DAY,
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
    const eventId = await ctx.db.insert("captureReleaseEvents", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      version: 1,
      kind: "console_release",
      terms: CAPTURE_TERMS_VERSION,
      released: true,
      blocked: false,
      minIntervalHours: 1,
      revokedKeys: 0,
      reason: "Liberação sintética",
      buildSha: null,
      deployment: "",
      createdAt: Date.now(),
    });
    await ctx.db.insert("captureReleases", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      released: true,
      releasedBefore: true,
      blocked: false,
      minIntervalHours: 1,
      actor: "member:synthetic",
      reason: "Liberação sintética",
      version: 1,
      updatedAt: Date.now(),
      eventId,
    });
  });
  stub(site);
  const source = new Source();
  vi.spyOn(certificateCrypto, "currentCertificateKeyring").mockReturnValue({} as never);
  vi.spyOn(certificateCrypto, "decryptCertificate").mockReturnValue({
    pfx: Buffer.alloc(0),
    password: Buffer.alloc(0),
    dispose() {},
  });
  vi.spyOn(certificateTransport, "certificateRequest").mockImplementation(async (request) => ({
    status: 200,
    body: source.answer((request as { body: string }).body),
  }));
  /** A person of the organization, signed in now: sessions last an hour, the tests skip days. */
  const manager = (role: Role = "owner") =>
    person(t, scope.organizationId, role, { companyId: scope.companyId });
  const consoleScope = {
    organizationId: scope.organizationId,
    companyId: scope.companyId,
    environment: "production" as const,
  };
  /** The owner starts the company's production capture in the console. */
  const start = async () =>
    (await (await manager()).mutation(api.captures.activate, consoleScope)).id;
  const stream = (id: Id<"captureStreams">) =>
    t.run(async (ctx) => (await ctx.db.get("captureStreams", id))!);
  /** One worker run of the stream's operation at its time: the real executor and checkpoint. */
  async function step(id: Id<"captureStreams">) {
    const current = await stream(id);
    const op = (await t.run((ctx) => ctx.db.get("operations", current.operationId!)))!;
    vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
    await t.action(internal.operationWorker.run, {
      operationId: op._id,
      generation: op.generation,
    });
  }
  /** Runs the stream until `done` holds for it; fails if it never settles. */
  async function until(id: Id<"captureStreams">, done: (s: Doc<"captureStreams">) => boolean) {
    for (let n = 0; n < 200; n++) {
      const current = await stream(id);
      if (done(current)) return current;
      await step(id);
    }
    throw new Error("A captura não chegou ao estado esperado.");
  }
  const view = async () => (await manager("viewer")).query(api.captures.get, consoleScope);
  return { t, scope, keyHash, source, manager, consoleScope, start, stream, step, until, view };
}
type Fixture = Awaited<ReturnType<typeof siteFixture>>;

/** First query reads NSU 1; then the capture stays `days` without a query. */
async function quietFor(f: Fixture, days: number) {
  f.source.max = 1;
  const id = await f.start();
  await f.until(id, (s) => s.checkpoint === nsu(1) && s.state === "active");
  const quietSince = (await f.stream(id)).lastSuccessAt!;
  vi.setSystemTime(Date.now() + days * DAY);
  return { id, quietSince };
}
const envelopes = (f: Fixture) =>
  f.t.run(async (ctx) =>
    (await ctx.db.query("captureEnvelopes").collect()).map((e) => ({
      nsu: Number(e.nsu),
      admitted: !!e.operationId,
    })),
  );
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, n) => from + n);
const acceptArgs = (f: Fixture, version: number, from: number, to: number) => ({
  ...f.consoleScope,
  expectedVersion: version,
  from: nsu(from),
  to: nsu(to),
  reason: REASON,
});
/** The owner's reason for accepting a loss (#442). */
const REASON = "Notas do período conferidas no portal da Receita; o resto não volta mais.";
/** Reasons the server refuses: empty, blank, too long, or with a control character. */
const BAD_REASONS = [
  ["vazio", ""],
  ["só espaços", "   \n  "],
  ["acima de 500 caracteres", "a".repeat(501)],
  ["com caractere de controle", "conferido\u0000"],
] as const;
const lostAttention = (s: Doc<"captureStreams">) =>
  s.state === "attention" && s.code === "RECONCILIATION_UNAVAILABLE";

/** The `connection.history_limited` events in the outbox (#442). */
const historyEvents = (f: Fixture) =>
  f.t.run(async (ctx) =>
    (await ctx.db.query("outboxEvents").collect()).filter(
      (event) => event.type === "connection.history_limited",
    ),
  );

describe("lacuna recuperável", () => {
  it("recupera em lote, sem esperar uma hora entre NSU, e respeita o teto de consNSU por hora", async () => {
    const f = await siteFixture();
    const { id } = await quietFor(f, 1);
    // The distribution skipped 2..14 (a failure §3.6 describes); consNSU still finds them.
    f.source.max = 30;
    f.source.distributed = (n) => n === 1 || n >= 15;
    const gapAt = Date.now();
    await f.step(id);
    const found = await f.stream(id);
    expect(found).toMatchObject({
      state: "active",
      checkpoint: nsu(1),
      mode: "consNSU",
      sourceCursor: nsu(30),
      code: "NSU_GAP",
    });
    expect(found.recovery).toMatchObject({ queuePending: false });
    // The first consNSU goes a second later, not an hour.
    expect(found.nextAllowedAt).toBeLessThanOrEqual(gapAt + 2000);
    const done = await f.until(id, (s) => s.mode === "distNSU");
    expect(done).toMatchObject({ state: "active", checkpoint: nsu(30) });
    expect(done.recovery).toBeUndefined();
    // Each missing NSU asked once; 15..30 came stored and went in sequence without a query.
    expect(f.source.consNSU()).toEqual(range(2, 14));
    expect(f.source.busiestHour()).toBe(RECOVERY_HOURLY_LIMIT);
    const cons = f.source.requests.filter((r) => r.mode === "consNSU");
    // The first ten in under a minute; the eleventh waits for the first to leave the hour.
    expect(cons[RECOVERY_HOURLY_LIMIT - 1]!.at - cons[0]!.at).toBeLessThan(60_000);
    expect(cons[RECOVERY_HOURLY_LIMIT]!.at).toBeGreaterThanOrEqual(cons[0]!.at + HOUR);
    expect((await envelopes(f)).every((e) => e.admitted)).toBe(true);
    expect((await envelopes(f)).map((e) => e.nsu).sort((a, b) => a - b)).toEqual(range(1, 30));
    // No attention, no failure on the way.
    const audit = await f.t.run((ctx) => ctx.db.query("captureAudit").collect());
    expect(audit.some((row) => row.action === "RECONCILIATION_UNAVAILABLE")).toBe(false);
  });

  it("com a fila ainda pendente, volta ao distNSU logo depois de fechar a lacuna", async () => {
    const f = await siteFixture();
    const { id } = await quietFor(f, 1);
    f.source.max = 80;
    f.source.distributed = (n) => n === 1 || n >= 4;
    await f.step(id);
    expect((await f.stream(id)).recovery).toMatchObject({ queuePending: true });
    const done = await f.until(id, (s) => s.mode === "distNSU");
    expect(done.checkpoint).toBe(nsu(53));
    const at = Date.now();
    expect(done.nextAllowedAt).toBeLessThanOrEqual(at + 2000);
    await f.until(id, (s) => s.checkpoint === nsu(80));
    expect(f.source.consNSU()).toEqual([2, 3]);
    expect(f.source.requests.filter((r) => r.mode === "distNSU").map((r) => r.nsu)).toEqual([
      0, 1, 53,
    ]);
  });

  it("o teto por hora do site também vale para a recuperação", async () => {
    const f = await siteFixture();
    const { id } = await quietFor(f, 1);
    f.source.max = 20;
    f.source.distributed = (n) => n === 1 || n >= 10;
    await f.step(id);
    const oldest = Date.now() - 10 * 60_000;
    await f.t.run(async (ctx) => {
      const head = (await ctx.db
        .query("certificateHeads")
        .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
        .unique())!;
      const cert = (await ctx.db.get("certificates", head.activeId!))!;
      for (let n = 0; n < SITE_CAPTURE_HOURLY_LIMIT; n++)
        await ctx.db.insert("certificateAudit", {
          organizationId: cert.organizationId,
          companyId: cert.companyId,
          certificateId: cert._id,
          version: cert.version,
          actor: "system",
          action: SITE_CAPTURE_ACTION,
          result: "authorized",
          createdAt: oldest + n,
        });
    });
    const before = f.source.requests.length;
    await f.step(id);
    expect(f.source.requests).toHaveLength(before);
    const waiting = await f.stream(id);
    expect(waiting).toMatchObject({
      state: "active",
      mode: "consNSU",
      nextAllowedAt: oldest + HOUR,
    });
    const op = (await f.t.run((ctx) => ctx.db.get("operations", waiting.operationId!)))!;
    expect(op).toMatchObject({ state: "retry_wait", code: "SOURCE_COOLDOWN", attempts: 0 });
  });
});

describe("recuo depois de um 656", () => {
  it("um 656 na recuperação espera a hora e, por 24 h, usa metade do teto", async () => {
    const f = await siteFixture();
    const { id } = await quietFor(f, 1);
    // 2..31 missing from the distribution, still found by consNSU; the third consNSU gets 656.
    f.source.max = 40;
    f.source.distributed = (n) => n === 1 || n >= 32;
    f.source.blockAt = 3;
    const blocked = await f.until(id, (s) => s.code === "SOURCE_CONSUMPTION_BLOCKED");
    expect(blocked).toMatchObject({ state: "attention", mode: "consNSU", checkpoint: nsu(3) });
    const at = f.source.requests.at(-1)!.at;
    expect(blocked.nextAllowedAt).toBeGreaterThanOrEqual(at + HOUR);
    const audit = await f.t.run((ctx) => ctx.db.query("captureAudit").collect());
    expect(audit.filter((row) => row.action === RECOVERY_BACKOFF)).toHaveLength(1);
    // Resumed after the hour, the recovery runs at half the budget for the day.
    vi.setSystemTime(blocked.nextAllowedAt + 1);
    const resumedAt = Date.now();
    await (
      await f.manager()
    ).mutation(api.captures.control, {
      ...f.consoleScope,
      action: "resume",
      expectedVersion: blocked.version,
    });
    const done = await f.until(id, (s) => s.mode === "distNSU");
    expect(done).toMatchObject({ state: "active", checkpoint: nsu(40) });
    // 2 and 3 before the block; 4, answered 656, asked again after the hour; then 5..31.
    expect(f.source.consNSU()).toEqual([2, 3, 4, ...range(4, 31)]);
    expect(f.source.busiestHour(resumedAt)).toBe(RECOVERY_BACKOFF_LIMIT);
    // 29 queries at 3 an hour: the recovery ends before the day of backoff.
    expect(f.source.requests.at(-2)!.at - resumedAt).toBeLessThan(RECOVERY_BACKOFF_MS);
  });

  it("o teto é contado numa hora deslizante e volta ao normal 24 h depois do 656", async () => {
    const f = await siteFixture();
    const { id } = await quietFor(f, 0);
    const now = Date.now();
    const slot = () => f.t.run((ctx) => recoverySlot(ctx, id, now));
    const reserve = (count: number, from: number) =>
      f.t.run(async (ctx) => {
        const stream = (await ctx.db.get("captureStreams", id))!;
        for (let n = 0; n < count; n++)
          await ctx.db.insert("captureAudit", {
            streamId: id,
            organizationId: stream.organizationId,
            action: "reconciliation_started",
            actor: "system",
            checkpoint: stream.checkpoint,
            createdAt: from + n * 60_000,
          });
      });
    const backoff = (createdAt: number) =>
      f.t.run(async (ctx) => {
        const stream = (await ctx.db.get("captureStreams", id))!;
        await ctx.db.insert("captureAudit", {
          streamId: id,
          organizationId: stream.organizationId,
          action: RECOVERY_BACKOFF,
          actor: "system",
          checkpoint: stream.checkpoint,
          createdAt,
        });
      });
    // Five in the last hour: one more fits.
    await reserve(RECOVERY_HOURLY_LIMIT - 1, now - 50 * 60_000);
    expect(await slot()).toBe(now);
    // The sixth fills the hour: the next waits until the oldest leaves it.
    await reserve(1, now - 10 * 60_000);
    expect(await slot()).toBe(now - 50 * 60_000 + HOUR);
    // A 656 a day and an hour ago no longer halves it; one an hour ago does.
    await backoff(now - RECOVERY_BACKOFF_MS - HOUR);
    expect(await slot()).toBe(now - 50 * 60_000 + HOUR);
    await backoff(now - HOUR);
    // Halved: of the three most recent (10, 46 and 47 min ago), the oldest leaves at 13 min.
    expect(await slot()).toBe(now - 47 * 60_000 + HOUR);
  });
});

describe("lacuna expirada", () => {
  it("137 na lacuna: localiza o limite, fica em atenção e, aceita a perda, segue em distNSU", async () => {
    const f = await siteFixture();
    const { id, quietSince } = await quietFor(f, 100);
    // 100 days later the source kept only 41..60 (§3.5: distNSU starts at the oldest it has).
    f.source.max = 60;
    f.source.available = (n) => n >= 41;
    const stuck = await f.until(id, lostAttention);
    // The bottom and then the top of the gap: two consNSU settle a gap with nothing left.
    expect(f.source.consNSU()).toEqual([2, 40]);
    expect(stuck).toMatchObject({ checkpoint: nsu(1), mode: "consNSU", sourceCursor: nsu(60) });
    const events = await f.t.run((ctx) => ctx.db.query("outboxEvents").collect());
    expect(events.filter((e) => e.type === "connection.attention_required")).toHaveLength(1);
    const read = (await f.view())!;
    expect(read.gap.lost).toMatchObject({
      from: nsu(2),
      to: nsu(40),
      count: 39,
      quietSince,
    });
    expect(read.gap.lost!.detectedAt).toBeGreaterThan(quietSince + 99 * DAY);
    const owner = await f.manager();
    const accepted = await owner.mutation(
      api.captures.acceptGap,
      acceptArgs(f, stuck.version, 2, 40),
    );
    expect(accepted).toMatchObject({
      state: "active",
      checkpoint: nsu(60),
      code: "HISTORY_LIMITED",
    });
    const after = await f.stream(id);
    expect(after).toMatchObject({ mode: "distNSU", checkpoint: nsu(60) });
    expect(after.recovery).toBeUndefined();
    expect((await envelopes(f)).filter((e) => !e.admitted)).toEqual([]);
    expect(after.received).toBe(21);
    const audit = await f.t.run((ctx) =>
      ctx.db
        .query("captureAudit")
        .withIndex("by_streamId_and_action_and_createdAt", (q) =>
          q.eq("streamId", id).eq("action", "history_limited"),
        )
        .collect(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: `member:${owner.membershipId}`,
      checkpoint: nsu(1),
      lost: { from: nsu(2), to: nsu(40), confirmedVersion: stuck.version, reason: REASON },
    });
    const later = (await f.view())!;
    expect(later.gap.lost).toBeNull();
    expect(later.gap.accepted).toEqual([
      {
        from: nsu(2),
        to: nsu(40),
        count: 39,
        acceptedAt: audit[0]!.createdAt,
        acceptedBy: "Pessoa sintética",
        reason: REASON,
      },
    ]);
    // The next query reads the queue from the source cursor with distNSU.
    const before = f.source.requests.length;
    await f.until(id, () => f.source.requests.length > before);
    expect(f.source.requests.at(-1)).toMatchObject({ mode: "distNSU", nsu: 60 });
    expect(f.source.consNSU()).toEqual([2, 40]);
  });

  it("captura parada antes da #419, presa no 137: retomar localiza o limite e então aceita", async () => {
    const f = await siteFixture();
    const { id } = await quietFor(f, 100);
    f.source.max = 60;
    f.source.available = (n) => n >= 41;
    await f.until(id, lostAttention);
    // What the code before #419 left: attention after the 137 of checkpoint + 1, no recovery.
    await f.t.run((ctx) => ctx.db.patch("captureStreams", id, { recovery: undefined }));
    const legacy = await f.stream(id);
    expect((await f.view())!.gap.lost).toBeNull();
    await expect(
      (await f.manager()).mutation(api.captures.acceptGap, acceptArgs(f, legacy.version, 2, 40)),
    ).rejects.toThrow("GAP_NOT_ACCEPTABLE");
    vi.setSystemTime(Math.max(Date.now(), legacy.nextAllowedAt));
    await (
      await f.manager()
    ).mutation(api.captures.control, {
      ...f.consoleScope,
      action: "resume",
      expectedVersion: legacy.version,
    });
    const located = await f.until(id, lostAttention);
    // Created by a consNSU 137, the recovery does not know the queue: the end-of-queue wait holds.
    expect(located.recovery).toMatchObject({ queuePending: false, unavailableTo: nsu(40) });
    expect(f.source.consNSU()).toEqual([2, 40, 2, 40]);
    expect((await f.view())!.gap.lost).toMatchObject({ from: nsu(2), to: nsu(40) });
    await (
      await f.manager()
    ).mutation(api.captures.acceptGap, acceptArgs(f, located.version, 2, 40));
    expect(await f.stream(id)).toMatchObject({ checkpoint: nsu(60), mode: "distNSU" });
  });
});

describe("lacuna mista", () => {
  it("recupera a parte que a fonte ainda tem e oferece aceitar só a perda do resto", async () => {
    const f = await siteFixture();
    const { id } = await quietFor(f, 95);
    // 2..20 left the source; 21..60 are still there, but the distribution skipped 21..40.
    f.source.max = 60;
    f.source.available = (n) => n === 1 || n >= 21;
    f.source.distributed = (n) => n === 1 || n >= 41;
    const stuck = await f.until(id, lostAttention);
    // Bottom, top, then by halves down to the limit: 8 queries, not one per NSU.
    expect(f.source.consNSU()).toEqual([2, 40, 21, 11, 16, 18, 19, 20]);
    expect((await f.view())!.gap.lost).toMatchObject({ from: nsu(2), to: nsu(20), count: 19 });
    expect(stuck.checkpoint).toBe(nsu(1));
    // Accepting a different range than the one shown is refused.
    await expect(
      (await f.manager()).mutation(api.captures.acceptGap, acceptArgs(f, stuck.version, 2, 40)),
    ).rejects.toThrow("GAP_CONFIRMATION_MISMATCH");
    await (await f.manager()).mutation(api.captures.acceptGap, acceptArgs(f, stuck.version, 2, 20));
    const recovering = await f.stream(id);
    expect(recovering).toMatchObject({ checkpoint: nsu(21), mode: "consNSU" });
    expect((await f.view())!.gap.recovering).toMatchObject({ from: nsu(22), to: nsu(39) });
    const done = await f.until(id, (s) => s.mode === "distNSU");
    expect(done).toMatchObject({ state: "active", checkpoint: nsu(60) });
    // After the limit, the rest asked once each, in order: 22..39 (21 and 40 were stored).
    expect(f.source.consNSU().slice(8)).toEqual(range(22, 39));
    expect(f.source.busiestHour()).toBeLessThanOrEqual(RECOVERY_HOURLY_LIMIT);
    const stored = await envelopes(f);
    expect(stored.map((e) => e.nsu).sort((a, b) => a - b)).toEqual([1, ...range(21, 60)]);
    expect(stored.every((e) => e.admitted)).toBe(true);
  });
});

describe("stream antigo em consNSU por um 656", () => {
  /** What a 656 did before #421: its `ultNSU` became the cursor and the stream went to consNSU. */
  async function blockedBefore421(f: Fixture, id: Id<"captureStreams">, cursor: number) {
    await f.t.run(async (ctx) => {
      const stream = (await ctx.db.get("captureStreams", id))!;
      // A query of the past, not the one the stream has scheduled now.
      const past = (await ctx.db.query("operations").collect()).find(
        (op) => op.task.name === "connections.sync" && op.state === "succeeded",
      )!;
      const rawId = await ctx.storage.store(new Blob(["656"]));
      await ctx.db.insert("captureBatches", {
        streamId: id,
        operationId: past._id,
        ownerVersion: stream.version,
        requestNsu: stream.checkpoint,
        mode: "distNSU",
        rawId,
        rawHash: "0".repeat(64),
        status: "656",
        lastNsu: nsu(cursor),
        maxNsu: nsu(cursor),
        envelopeCount: 0,
        saved: 0,
        committed: true,
        createdAt: Date.now(),
      });
      await ctx.db.patch("captureStreams", id, { mode: "consNSU", sourceCursor: nsu(cursor) });
    });
  }

  it("lê a fila com distNSU, 50 por consulta, em vez de um consNSU por NSU", async () => {
    const f = await siteFixture();
    const { id } = await quietFor(f, 0);
    await blockedBefore421(f, id, 90);
    f.source.max = 90;
    vi.setSystemTime(Date.now() + 2 * HOUR);
    const done = await f.until(id, (s) => s.checkpoint === nsu(90));
    expect(f.source.consNSU()).toEqual([]);
    expect(f.source.requests.map((r) => [r.mode, r.nsu])).toEqual([
      ["distNSU", 0],
      ["distNSU", 1],
      ["distNSU", 51],
    ]);
    expect(done).toMatchObject({ state: "active", mode: "distNSU", sourceCursor: nsu(90) });
    const audit = await f.t.run((ctx) => ctx.db.query("captureAudit").collect());
    expect(audit.filter((row) => row.action === "blocked_cursor_cleared")).toHaveLength(1);
  });

  it("um cursor que veio de uma resposta distNSU continua sendo lacuna", async () => {
    const f = await siteFixture();
    const { id } = await quietFor(f, 0);
    f.source.max = 30;
    f.source.distributed = (n) => n === 1 || n >= 5;
    vi.setSystemTime(Date.now() + 2 * HOUR);
    await f.step(id);
    // Without the recovery record (a gap found before #419), and a 656 with the same ultNSU.
    await f.t.run((ctx) => ctx.db.patch("captureStreams", id, { recovery: undefined }));
    await blockedBefore421(f, id, 30);
    await f.until(id, (s) => s.mode === "distNSU");
    expect(f.source.consNSU()).toEqual([2, 3, 4]);
  });
});

describe("Aceitar a perda e continuar: quem pode e quando", () => {
  async function stuckGap() {
    const f = await siteFixture();
    const { id } = await quietFor(f, 100);
    f.source.max = 60;
    f.source.available = (n) => n >= 41;
    const stuck = await f.until(id, lostAttention);
    return { f, id, stuck, args: acceptArgs(f, stuck.version, 2, 40) };
  }

  it("Proprietário aceita, e o motivo vai sem os espaços das pontas", async () => {
    const { f, id, args } = await stuckGap();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    await expect(
      owner.mutation(api.captures.acceptGap, { ...args, reason: `  ${"a".repeat(500)}\n ` }),
    ).resolves.toMatchObject({ checkpoint: nsu(60) });
    const rows = await f.t.run((ctx) => ctx.db.query("captureAudit").collect());
    const row = rows.find((r) => r.streamId === id && r.action === "history_limited");
    expect(row?.lost?.reason).toBe("a".repeat(500));
    // A capture of the console has no integration to tell: no `connection.history_limited`.
    expect(await historyEvents(f)).toEqual([]);
  });

  it.each(["admin", "developer", "operator", "viewer"] as const satisfies readonly Role[])(
    "%s é recusado, mesmo com a empresa concedida",
    async (role) => {
      const { f, id, stuck, args } = await stuckGap();
      const member = await person(f.t, f.scope.organizationId, role, {
        companyId: f.scope.companyId,
      });
      await expect(member.mutation(api.captures.acceptGap, args)).rejects.toThrow("ACCESS_DENIED");
      expect(await f.stream(id)).toMatchObject({ version: stuck.version, checkpoint: nsu(1) });
    },
  );

  it.each(BAD_REASONS)("motivo %s é recusado sem efeito", async (_, reason) => {
    const { f, id, stuck, args } = await stuckGap();
    await expect(
      (await f.manager()).mutation(api.captures.acceptGap, { ...args, reason }),
    ).rejects.toThrow("GAP_REASON_INVALID");
    expect(await f.stream(id)).toMatchObject({ version: stuck.version, checkpoint: nsu(1) });
    const rows = await f.t.run((ctx) => ctx.db.query("captureAudit").collect());
    expect(rows.filter((row) => row.action === "history_limited")).toEqual([]);
  });

  it("login sem membership e Proprietário de outra organização são recusados", async () => {
    const { f, id, stuck, args } = await stuckGap();
    vi.unstubAllEnvs();
    stub(development);
    const other = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash: await hashApiKey(`fnfe_${"c".repeat(43)}`),
      suffix: crypto.randomUUID(),
    });
    stub(site);
    const outsider = await person(f.t, other.organizationId, "owner");
    // Its own organization does not reach this company; this organization does not know it.
    await expect(outsider.mutation(api.captures.acceptGap, args)).rejects.toThrow("ACCESS_DENIED");
    await expect(
      outsider.mutation(api.captures.acceptGap, { ...args, organizationId: other.organizationId }),
    ).rejects.toThrow();
    expect(await f.stream(id)).toMatchObject({ version: stuck.version, checkpoint: nsu(1) });
  });

  it("é idempotente na retentativa: um só registro e uma só consulta nova", async () => {
    const { f, id, args } = await stuckGap();
    const owner = await f.manager();
    const first = await owner.mutation(api.captures.acceptGap, args);
    const again = await owner.mutation(api.captures.acceptGap, args);
    expect(again).toEqual(first);
    const rows = await f.t.run((ctx) => ctx.db.query("captureAudit").collect());
    expect(rows.filter((row) => row.action === "history_limited")).toHaveLength(1);
    const ops = await f.t.run((ctx) => ctx.db.query("operations").collect());
    expect(
      ops.filter((op) => op.task.name === "connections.sync" && op.state === "queued"),
    ).toHaveLength(1);
    expect((await f.stream(id)).operationId).toBe(first.operationId);
  });

  it("corrida com retomar, pausar ou desativar: a versão do stream decide", async () => {
    // Pause first: the acceptance read an older version.
    const paused = await stuckGap();
    await (
      await paused.f.manager()
    ).mutation(api.captures.control, {
      ...paused.f.consoleScope,
      action: "pause",
      expectedVersion: paused.stuck.version,
    });
    await expect(
      (await paused.f.manager()).mutation(api.captures.acceptGap, paused.args),
    ).rejects.toThrow("OPERATION_CONFLICT");
    // With the new version, a paused stream has no loss to accept.
    await expect(
      (await paused.f.manager()).mutation(api.captures.acceptGap, {
        ...paused.args,
        expectedVersion: paused.stuck.version + 1,
      }),
    ).rejects.toThrow("GAP_NOT_ACCEPTABLE");
    // Accept first: a resume read the older version.
    const accepted = await stuckGap();
    await (await accepted.f.manager()).mutation(api.captures.acceptGap, accepted.args);
    await expect(
      (await accepted.f.manager()).mutation(api.captures.control, {
        ...accepted.f.consoleScope,
        action: "resume",
        expectedVersion: accepted.stuck.version,
      }),
    ).rejects.toThrow("OPERATION_CONFLICT");
    // The company turns the capture off: the stream pauses with a new version, and production
    // is read-only for the company, so the acceptance is refused before it reads the stream.
    const withdrawn = await stuckGap();
    await (
      await withdrawn.f.manager()
    ).mutation(api.captureRelease.disable, {
      organizationId: withdrawn.f.scope.organizationId,
      companyId: withdrawn.f.scope.companyId,
    });
    expect(await withdrawn.f.stream(withdrawn.id)).toMatchObject({
      state: "paused",
      version: withdrawn.stuck.version + 1,
      checkpoint: nsu(1),
    });
    await expect(
      (await withdrawn.f.manager()).mutation(api.captures.acceptGap, withdrawn.args),
    ).rejects.toThrow("NOT_FOUND");
    expect(await withdrawn.f.stream(withdrawn.id)).toMatchObject({
      state: "paused",
      checkpoint: nsu(1),
    });
  });

  it("sem lacuna perdida conhecida, não há o que aceitar", async () => {
    const f = await siteFixture();
    const { id } = await quietFor(f, 0);
    const stream = await f.stream(id);
    await expect(
      (await f.manager()).mutation(api.captures.acceptGap, acceptArgs(f, stream.version, 2, 2)),
    ).rejects.toThrow("GAP_NOT_ACCEPTABLE");
  });
});

/**
 * #442: a capture an integration started (its API key) and stuck on a gap the source no longer
 * has. The API has no action to accept a fiscal loss (a key is not a person with a role, #440),
 * and resuming through the API only locates the same limit again.
 */
describe("captura de integração em lacuna irrecuperável (#442)", () => {
  /** `POST`/`GET /v1/connections/nfe` with the integration's key, as the REST route sends it. */
  async function rest(
    f: Fixture,
    body: { action?: "activate" | "sync" | "pause" | "resume"; expectedVersion?: number } = {},
  ) {
    const data = await f.t.mutation(internal.captureRest.dispatch, {
      keyHash: f.keyHash,
      environment: "production",
      companyId: f.scope.companyId,
      ...body,
    });
    return JSON.parse(data) as {
      id: Id<"captureStreams">;
      version: number;
      state: string;
      code: string | null;
      checkpoint: string;
    } | null;
  }
  /** The integration starts the capture, reads NSU 1 and then stays `days` without a query. */
  async function integrationStuck(f: Fixture, days = 100) {
    f.source.max = 1;
    const id = (await rest(f, { action: "activate" }))!.id;
    await f.until(id, (s) => s.checkpoint === nsu(1) && s.state === "active");
    vi.setSystemTime(Date.now() + days * DAY);
    f.source.max = 60;
    f.source.available = (n) => n >= 41;
    const stuck = await f.until(id, lostAttention);
    expect(stuck.projectId).toBe(f.scope.projectId);
    return { id, stuck, args: acceptArgs(f, stuck.version, 2, 40) };
  }

  it("Proprietário aceita no console e a captura segue na integração, com a chave dela", async () => {
    const f = await siteFixture();
    const { id, stuck, args } = await integrationStuck(f);
    expect(f.source.consNSU()).toEqual([2, 40]);
    // REST: resuming asks the bottom of the gap again, gets the same 137 and stops in attention,
    // at the same checkpoint. Each resume spends a query and changes nothing.
    vi.setSystemTime(Math.max(Date.now(), stuck.nextAllowedAt));
    await rest(f, { action: "resume", expectedVersion: stuck.version });
    const again = await f.until(id, lostAttention);
    expect(f.source.consNSU()).toEqual([2, 40, 2]);
    expect(again.checkpoint).toBe(nsu(1));
    // REST (and the SDK, which only calls it) has no action to accept the loss.
    await expect(
      f.t.mutation(internal.captureRest.dispatch, {
        keyHash: f.keyHash,
        environment: "production",
        companyId: f.scope.companyId,
        action: "acceptGap" as "resume",
        expectedVersion: again.version,
      }),
    ).rejects.toThrow();
    // Console: the owner decides, the integration's capture goes on.
    const owner = await f.manager();
    const accepted = await owner.mutation(api.captures.acceptGap, {
      ...args,
      expectedVersion: again.version,
    });
    expect(accepted).toMatchObject({
      state: "active",
      checkpoint: nsu(60),
      code: "HISTORY_LIMITED",
    });
    const after = await f.stream(id);
    expect(after).toMatchObject({
      projectId: f.scope.projectId,
      mode: "distNSU",
      checkpoint: nsu(60),
      received: 21,
    });
    // The next query is the integration's: its project and its key, never the console's.
    const next = (await f.t.run((ctx) => ctx.db.get("operations", after.operationId!)))!;
    expect(next).toMatchObject({ projectId: f.scope.projectId, sourceKeyId: f.scope.keyId });
    expect(next.sourceMembershipId).toBeUndefined();
    const audit = await f.t.run((ctx) =>
      ctx.db
        .query("captureAudit")
        .withIndex("by_streamId_and_action_and_createdAt", (q) =>
          q.eq("streamId", id).eq("action", "history_limited"),
        )
        .collect(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: `member:${owner.membershipId}`,
      lost: { from: nsu(2), to: nsu(40), confirmedVersion: again.version, reason: REASON },
    });
    // The integration reads the new position through the API it already uses.
    expect(await rest(f)).toMatchObject({ checkpoint: nsu(60), code: "HISTORY_LIMITED" });
    const before = f.source.requests.length;
    await f.until(id, () => f.source.requests.length > before);
    expect(f.source.requests.at(-1)).toMatchObject({ mode: "distNSU", nsu: 60 });
  });

  it("a integração recebe connection.history_limited, uma vez, assinado e pelo caminho normal", async () => {
    const f = await siteFixture();
    const { id, args } = await integrationStuck(f);
    // Delivery on, as in a deployment with webhooks; the network is the receiver below.
    vi.stubEnv("WEBHOOK_MODE", "https");
    vi.stubEnv("FNFE_WEBHOOK_MASTER_KEY", "ab".repeat(32));
    const post = vi
      .spyOn(webhookNetwork, "postWebhook")
      .mockResolvedValue({ status: 204, response: "HTTP 204. Corpo remoto omitido." });
    const secret = "whsec_sintetico_442";
    /** A production endpoint of the integration's project, subscribed to `events`. */
    const endpoint = (events: Doc<"webhookEndpoints">["events"]) =>
      f.t.run(async (ctx) => {
        const project = (await ctx.db.get("projects", f.scope.projectId))!;
        const grant = (await ctx.db
          .query("projectCompanies")
          .withIndex("by_projectId_and_companyId", (q) =>
            q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
          )
          .unique())!;
        const endpointId = await ctx.db.insert("webhookEndpoints", {
          organizationId: f.scope.organizationId,
          projectId: f.scope.projectId,
          companyId: f.scope.companyId,
          environment: "production",
          name: "ERP sintético",
          url: "https://receiver.operator.invalid/hook",
          events,
          active: true,
          version: 1,
          secretVersion: 1,
          secret: "",
          projectEpoch: project.accessEpoch,
          grantEpoch: grant.accessEpoch,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        await ctx.db.patch("webhookEndpoints", endpointId, {
          secret: await encryptSecret(secret, `${endpointId}:1`),
        });
        return endpointId;
      });
    const subscribed = await endpoint(["connection.history_limited"]);
    const other = await endpoint(["connection.attention_required"]);
    const owner = await f.manager();
    const acceptedAt = Date.now();
    const accepted = await owner.mutation(api.captures.acceptGap, args);
    // Retrying, by the same owner or by another one, does not tell the integration again.
    await owner.mutation(api.captures.acceptGap, args);
    const another = await person(f.t, f.scope.organizationId, "owner");
    await another.mutation(api.captures.acceptGap, { ...args, reason: "Outro motivo" });
    const events = await historyEvents(f);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      projectId: f.scope.projectId,
      environment: "production",
      resourceType: "connection",
      resourceId: id,
      resourceVersion: accepted.version,
    });
    // The exact body: the range, the stream version, the moment and the role; no person, no reason.
    expect(JSON.parse(event.body)).toEqual({
      eventId: event.eventId,
      type: "connection.history_limited",
      version: "1",
      occurredAt: acceptedAt,
      environment: "production",
      companyId: f.scope.companyId,
      resource: { type: "connection", id, version: accepted.version },
      synthetic: false,
      data: { lost: { from: nsu(2), to: nsu(40) }, decidedBy: "owner" },
    });
    expect(event.body).not.toContain("Notas do período");
    expect(event.body).not.toContain(owner.membershipId);
    // Only the endpoint that subscribed to it gets a delivery.
    const deliveries = await f.t.run((ctx) => ctx.db.query("webhookDeliveries").collect());
    expect(deliveries.filter((d) => d.endpointId === other)).toEqual([]);
    const mine = deliveries.filter((d) => d.endpointId === subscribed);
    expect(mine).toHaveLength(1);
    // The worker signs the stored bytes and posts them; the receiver verifies with its secret.
    await f.t.action(internal.webhookWorker.run, { deliveryId: mine[0]!._id, generation: 1 });
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, headers] = post.mock.calls[0]!;
    expect(url).toBe("https://receiver.operator.invalid/hook");
    expect(body).toBe(event.body);
    expect(
      await verifyWebhook({
        body: new TextEncoder().encode(body),
        headers: { ...headers },
        secrets: [{ version: 1, secret }],
        now: Date.now(),
      }),
    ).toMatchObject({
      ok: true,
      event: {
        type: "connection.history_limited",
        resource: { id, version: accepted.version },
        data: { lost: { from: nsu(2), to: nsu(40) }, decidedBy: "owner" },
      },
    });
    const delivered = await f.t.run((ctx) => ctx.db.get("webhookDeliveries", mine[0]!._id));
    expect(delivered).toMatchObject({ state: "delivered", attempts: 1 });
  });

  /** Nothing of the stream moved: same version and checkpoint, no loss recorded. */
  async function unchanged(f: Fixture, id: Id<"captureStreams">, version: number) {
    expect(await f.stream(id)).toMatchObject({ version, checkpoint: nsu(1), state: "attention" });
    const rows = await f.t.run((ctx) => ctx.db.query("captureAudit").collect());
    expect(rows.filter((row) => row.action === "history_limited")).toEqual([]);
    expect(await historyEvents(f)).toEqual([]);
  }

  it.each(["admin", "developer", "operator", "viewer"] as const satisfies readonly Role[])(
    "%s é recusado, mesmo com a empresa concedida",
    async (role) => {
      const f = await siteFixture();
      const { id, stuck, args } = await integrationStuck(f);
      const member = await person(f.t, f.scope.organizationId, role, {
        companyId: f.scope.companyId,
      });
      await expect(member.mutation(api.captures.acceptGap, args)).rejects.toThrow("ACCESS_DENIED");
      await unchanged(f, id, stuck.version);
    },
  );

  it.each(BAD_REASONS)("motivo %s é recusado sem efeito", async (_, reason) => {
    const f = await siteFixture();
    const { id, stuck, args } = await integrationStuck(f);
    await expect(
      (await f.manager()).mutation(api.captures.acceptGap, { ...args, reason }),
    ).rejects.toThrow("GAP_REASON_INVALID");
    await unchanged(f, id, stuck.version);
  });

  it("login sem membership e Proprietário de outra organização são recusados", async () => {
    const f = await siteFixture();
    const { id, stuck, args } = await integrationStuck(f);
    const former = await person(f.t, f.scope.organizationId, "owner");
    await f.t.run((ctx) => ctx.db.delete("memberships", former.membershipId));
    await expect(former.mutation(api.captures.acceptGap, args)).rejects.toThrow();
    vi.unstubAllEnvs();
    stub(development);
    const other = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash: await hashApiKey(`fnfe_${"d".repeat(43)}`),
      suffix: crypto.randomUUID(),
    });
    stub(site);
    const outsider = await person(f.t, other.organizationId, "owner");
    await expect(outsider.mutation(api.captures.acceptGap, args)).rejects.toThrow("ACCESS_DENIED");
    // Its own organization, this company: the stream is not found there.
    await expect(
      outsider.mutation(api.captures.acceptGap, { ...args, organizationId: other.organizationId }),
    ).rejects.toThrow();
    await unchanged(f, id, stuck.version);
  });

  it.each([
    [
      "chave revogada",
      (f: Fixture) =>
        f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() })),
    ],
    [
      "concessão sem connections:write",
      (f: Fixture) =>
        f.t.run(async (ctx) => {
          const grant = (await ctx.db
            .query("projectCompanies")
            .withIndex("by_projectId_and_companyId", (q) =>
              q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
            )
            .unique())!;
          await ctx.db.patch("projectCompanies", grant._id, {
            scopes: grant.scopes.filter((scope) => scope !== "connections:write"),
          });
        }),
    ],
  ])("%s: a integração não continuaria a captura, e nada é aceito", async (_, revoke) => {
    const f = await siteFixture();
    const { id, stuck, args } = await integrationStuck(f);
    await revoke(f);
    await expect((await f.manager()).mutation(api.captures.acceptGap, args)).rejects.toThrow(
      "INTEGRATION_ACCESS_REVOKED",
    );
    await unchanged(f, id, stuck.version);
    const queued = await f.t.run((ctx) => ctx.db.query("operations").collect());
    expect(
      queued.filter((op) => op.task.name === "connections.sync" && op.state === "queued"),
    ).toEqual([]);
  });

  it("versão ou intervalo que o console não leu: recusado, sem registro nem evento", async () => {
    const f = await siteFixture();
    const { id, stuck, args } = await integrationStuck(f);
    const owner = await f.manager();
    await expect(
      owner.mutation(api.captures.acceptGap, { ...args, expectedVersion: stuck.version + 1 }),
    ).rejects.toThrow("OPERATION_CONFLICT");
    await expect(owner.mutation(api.captures.acceptGap, { ...args, to: nsu(39) })).rejects.toThrow(
      "GAP_CONFIRMATION_MISMATCH",
    );
    await unchanged(f, id, stuck.version);
  });

  it("é idempotente na retentativa: um só registro e uma só consulta nova", async () => {
    const f = await siteFixture();
    const { id, args } = await integrationStuck(f);
    const owner = await f.manager();
    const first = await owner.mutation(api.captures.acceptGap, args);
    const again = await owner.mutation(api.captures.acceptGap, args);
    expect(again).toEqual(first);
    // Another owner confirming the same range and version is the same retry: the first reason
    // stays, and an administrator is still refused.
    const other = await person(f.t, f.scope.organizationId, "owner");
    expect(
      await other.mutation(api.captures.acceptGap, { ...args, reason: "Outro motivo" }),
    ).toEqual(first);
    const admin = await person(f.t, f.scope.organizationId, "admin");
    await expect(admin.mutation(api.captures.acceptGap, args)).rejects.toThrow("ACCESS_DENIED");
    const rows = await f.t.run((ctx) => ctx.db.query("captureAudit").collect());
    expect(rows.filter((row) => row.action === "history_limited")).toHaveLength(1);
    const ops = await f.t.run((ctx) => ctx.db.query("operations").collect());
    expect(
      ops.filter((op) => op.task.name === "connections.sync" && op.state === "queued"),
    ).toHaveLength(1);
    expect((await f.stream(id)).operationId).toBe(first.operationId);
    // The integration was told once: the retries answered before the event.
    expect(await historyEvents(f)).toHaveLength(1);
  });

  it("corrida com a integração: retomar ou pausar pela API muda a versão e a aceitação é recusada", async () => {
    for (const action of ["resume", "pause"] as const) {
      const f = await siteFixture();
      const { id, stuck, args } = await integrationStuck(f);
      vi.setSystemTime(Math.max(Date.now(), stuck.nextAllowedAt));
      await rest(f, { action, expectedVersion: stuck.version });
      await expect((await f.manager()).mutation(api.captures.acceptGap, args)).rejects.toThrow(
        "OPERATION_CONFLICT",
      );
      expect((await f.stream(id)).checkpoint).toBe(nsu(1));
      expect(await historyEvents(f)).toEqual([]);
    }
  });

  it("o resto da captura continua com a integração: o console não pausa, retoma nem transfere", async () => {
    const f = await siteFixture();
    const { stuck } = await integrationStuck(f);
    const owner = await f.manager();
    for (const action of ["resume", "pause"] as const)
      await expect(
        owner.mutation(api.captures.control, {
          ...f.consoleScope,
          action,
          expectedVersion: stuck.version,
        }),
      ).rejects.toThrow("INTEGRATION_RECORD");
    await expect(
      owner.mutation(api.captures.release, { ...f.consoleScope, expectedVersion: stuck.version }),
    ).rejects.toThrow("INTEGRATION_RECORD");
  });
});
