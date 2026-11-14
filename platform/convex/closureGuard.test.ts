import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import { actor } from "../../tests/helpers/export-fixture";
import { decisionGuardUntil, fiscalGuardUntil } from "./lib/retentionClasses";
import {
  DAY,
  fixture,
  type Fixture,
  settle,
  settleNow,
  at,
  code,
  slug,
  closureOf,
  seed,
  guarded,
  seedGuarded,
  type Twin,
  twin,
  production,
} from "../../tests/helpers/closure";

/** The fiscal guard keeps the conserved classes of a closed organization until its deadline. */
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5203",
    CONVEX_SITE_URL: "http://127.0.0.1:3265",
    BETTER_AUTH_SECRET: "synthetic-closure-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Rows of the guarded classes split between the twin organization and everything else. */
async function guardedRows(f: Fixture, other: Twin) {
  return f.t.run(async (ctx) => {
    const mine: Record<string, number> = {},
      theirs: Record<string, number> = {};
    for (const table of guarded) {
      const rows: { _id: string; organizationId?: string }[] = await ctx.db.query(table).collect();
      const owned = (row: (typeof rows)[number]) =>
        other.ids.has(row._id) || row.organizationId === other.organizationId;
      mine[table] = rows.filter((row) => !owned(row)).length;
      theirs[table] = rows.filter(owned).length;
    }
    return { mine, theirs };
  });
}

it("guarda as classes conservadas até o fim do prazo, respeita a retenção legal e expurga só a organização encerrada", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await seed(f, owner.membershipId);
  await production(f);
  await f.t.mutation(internal.accessRecords.recordActor, {
    actor: `key:${f.scope.keyId}`,
    ip: "203.0.113.9",
  });
  const organizationId = f.scope.organizationId;
  const other = await twin(f);
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  await at(f, closed.exportUntil + 1);
  let closure = (await closureOf(f))!;
  expect(closure.state).toBe("purged");
  // The guard waits in a job checked again at most weekly.
  expect(closure.scheduledId).toBeDefined();
  const guardUntil = fiscalGuardUntil(closure.requestedAt);
  const decisions = await f.t.query(internal.organizationClosure.decisions, {
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(decisions.page).toEqual([
    expect.objectContaining({ organizationId, state: "purged", guardUntil, expiredAt: null }),
  ]);

  await seedGuarded(f, "production");
  const kept = await guardedRows(f, other);
  const empty = guarded.filter((table) => kept.mine[table] === 0);
  expect(empty, "every guarded table needs a row of the closed organization").toEqual([]);
  const files = await f.t.run(async (ctx) =>
    (await ctx.db.system.query("_storage").collect()).map((file) => file._id),
  );
  const access = await f.t.run(
    async (ctx) => (await ctx.db.query("accessRecords").collect()).length,
  );

  // Right before the deadline the job only checks again.
  vi.setSystemTime(guardUntil - 1);
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect(await guardedRows(f, other)).toEqual(kept);
  closure = (await closureOf(f))!;

  // A legal hold, operator only, validated on the server.
  const hold = (args: Partial<{ reference: string; responsible: string; reviewAt: number }>) =>
    f.t.mutation(internal.fiscalGuard.hold, {
      organizationId,
      reference: "fiscalizacao-2032-01",
      responsible: "operacao-sintetica",
      reviewAt: guardUntil + 30 * DAY,
      ...args,
    });
  expect(await code(hold({ reference: "  " }))).toBe("INVALID_REQUEST");
  expect(await code(hold({ responsible: "x".repeat(201) }))).toBe("INVALID_REQUEST");
  expect(await code(hold({ reviewAt: Date.now() }))).toBe("INVALID_REQUEST");
  const ghost = await f.t.run(async (ctx) => {
    const id = await ctx.db.insert("organizations", {
      name: "Inexistente",
      slug: crypto.randomUUID(),
      ownerCount: 0,
      memberCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.delete("organizations", id);
    return id;
  });
  expect(
    await code(
      f.t.mutation(internal.fiscalGuard.hold, {
        organizationId: ghost,
        reference: "x",
        responsible: "y",
        reviewAt: guardUntil,
      }),
    ),
  ).toBe("NOT_FOUND");
  expect(await hold({})).toBe("held");
  expect(await hold({ reviewAt: guardUntil + 60 * DAY })).toBe("held");
  // A hold on another organization does not keep this one.
  expect(
    await f.t.mutation(internal.fiscalGuard.hold, {
      organizationId: other.organizationId,
      reference: "outro-processo",
      responsible: "operacao-sintetica",
      reviewAt: guardUntil + DAY,
    }),
  ).toBe("held");
  expect(
    (
      await f.t.query(internal.fiscalGuard.holds, {
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).page,
  ).toHaveLength(2);

  // Past the deadline, and past the review date, the hold keeps every row.
  for (const time of [guardUntil, guardUntil + 61 * DAY]) {
    vi.setSystemTime(time);
    await f.t.mutation(internal.fiscalGuard.expire, {
      closureId: closure._id,
      generation: closure.generation,
    });
    expect(await guardedRows(f, other)).toEqual(kept);
    closure = (await closureOf(f))!;
    expect(closure.expiredAt).toBeUndefined();
  }

  expect(
    await code(f.t.mutation(internal.fiscalGuard.release, { organizationId, reference: "outro" })),
  ).toBe("NOT_FOUND");
  expect(
    await f.t.mutation(internal.fiscalGuard.release, {
      organizationId,
      reference: "fiscalizacao-2032-01",
    }),
  ).toEqual({ active: 0 });
  const releasedAt = Date.now();
  await settle(f);
  closure = (await closureOf(f))!;
  expect(closure.expiredAt).toBeDefined();
  // The hold kept the guard past 31/12/2031, so the extra year counts from its release.
  const decisionUntil = decisionGuardUntil(releasedAt);
  expect(decisionUntil).toBe(Date.UTC(2034, 0, 1) + 3 * 3_600_000);
  // Only ids, dates and the state of its own job are left.
  expect(Object.keys(closure).sort()).toEqual(
    [
      "_creationTime",
      "_id",
      "decisionUntil",
      "expiredAt",
      "exportUntil",
      "generation",
      "organizationId",
      "purgeBy",
      "purgedAt",
      "requestedAt",
      "scheduledId",
      "state",
    ].sort(),
  );
  expect(closure.decisionUntil).toBe(decisionUntil);
  const holdRows = () =>
    f.t.run((ctx) =>
      ctx.db
        .query("retentionHolds")
        .collect()
        .then((rows) => rows.map(({ _id, _creationTime, ...row }) => row)),
    );
  expect(await holdRows()).toEqual([
    {
      organizationId,
      reviewAt: guardUntil + 60 * DAY,
      createdAt: expect.any(Number),
      releasedAt,
    },
    expect.objectContaining({ organizationId: other.organizationId, reference: "outro-processo" }),
  ]);
  expect(
    (
      await f.t.query(internal.organizationClosure.decisions, {
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).page,
  ).toEqual([
    expect.objectContaining({ organizationId, removed: null, guardUntil, decisionUntil }),
  ]);

  const after = await guardedRows(f, other);
  expect(
    Object.values(after.mine).every((n) => n === 0),
    JSON.stringify(after.mine),
  ).toBe(true);
  expect(after.theirs).toEqual(kept.theirs);
  await f.t.run(async (ctx) => {
    const left = (await ctx.db.system.query("_storage").collect()).map((file) => file._id);
    expect(left).toEqual([other.storageId]);
    expect(files.length).toBeGreaterThan(2);
    expect(await ctx.db.get("organizations", other.organizationId)).not.toBeNull();
    // Access records keep their own 184 days; the closure record stays as the decision.
    expect((await ctx.db.query("accessRecords").collect()).length).toBe(access);
  });

  // Running it again changes nothing, and a late hold cannot bring anything back.
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect(await guardedRows(f, other)).toEqual(after);
  expect(await hold({ reviewAt: Date.now() + DAY })).toBe("expired");

  // The decision stays until its own deadline, then goes with the holds of this organization.
  const forget = async (time: number) => {
    vi.setSystemTime(time);
    const current = (await closureOf(f))!;
    await f.t.mutation(internal.fiscalGuard.forget, {
      closureId: current._id,
      generation: current.generation,
    });
    await settleNow(f);
  };
  await forget(decisionUntil - 1);
  expect(await closureOf(f)).not.toBeNull();
  expect(await holdRows()).toHaveLength(2);
  await forget(decisionUntil);
  expect(await closureOf(f)).toBeNull();
  expect(await holdRows()).toEqual([
    expect.objectContaining({ organizationId: other.organizationId, reference: "outro-processo" }),
  ]);
  expect(await guardedRows(f, other)).toEqual(after);
  // Nothing is left to hold, release or reapply; running the job again changes nothing.
  await f.t.mutation(internal.fiscalGuard.forget, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect(await code(hold({ reviewAt: Date.now() + DAY }))).toBe("NOT_FOUND");
  expect(
    await f.t.mutation(internal.organizationClosure.reapply, {
      organizationId,
      requestedAt: closure.requestedAt,
    }),
  ).toBe("absent");
});

it("conserva a decisão até o fim da guarda mais um ano e só depois do expurgo fiscal", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  const other = await twin(f);
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  await at(f, closed.exportUntil + 1);
  let closure = (await closureOf(f))!;
  const guardUntil = fiscalGuardUntil(closure.requestedAt);
  const decisionUntil = decisionGuardUntil(guardUntil);
  expect(decisionUntil).toBe(Date.UTC(2033, 0, 1) + 3 * 3_600_000);
  const run = async (time: number) => {
    vi.setSystemTime(time);
    const current = (await closureOf(f))!;
    await f.t.mutation(internal.fiscalGuard.forget, {
      closureId: current._id,
      generation: current.generation,
    });
  };

  // Released holds of both organizations, more than one batch of this one.
  await f.t.run(async (ctx) => {
    for (let i = 0; i < 450; i++)
      await ctx.db.insert("retentionHolds", {
        organizationId,
        reference: `processo-${i}`,
        responsible: "operacao-sintetica",
        reviewAt: Date.now() + DAY,
        createdAt: Date.now(),
        releasedAt: Date.now(),
      });
    await ctx.db.insert("retentionHolds", {
      organizationId: other.organizationId,
      reference: "outro-processo",
      responsible: "operacao-sintetica",
      reviewAt: Date.now() + DAY,
      createdAt: Date.now(),
      releasedAt: Date.now(),
    });
  });
  const holds = () =>
    f.t.run(async (ctx) => {
      const rows = await ctx.db.query("retentionHolds").collect();
      const mine = rows.filter((row) => row.organizationId === organizationId);
      return {
        mine: mine.length,
        named: mine.filter((row) => row.reference !== undefined).length,
        theirs: rows.filter((row) => row.organizationId === other.organizationId),
      };
    });
  const theirs = (await holds()).theirs;

  // Before the fiscal purge ends, nothing of the decision goes, however late it is.
  await run(decisionUntil + 365 * DAY);
  expect(await closureOf(f)).toEqual(closure);
  expect(await holds()).toEqual({ mine: 450, named: 450, theirs });

  // The fiscal purge at its exact deadline; the references go in batches right after it.
  vi.setSystemTime(guardUntil);
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: (await closureOf(f))!.generation,
  });
  await settleNow(f);
  closure = (await closureOf(f))!;
  expect(closure.expiredAt).toBeDefined();
  expect(closure.decisionUntil).toBe(decisionUntil);
  expect(await holds()).toEqual({ mine: 450, named: 0, theirs });
  // The next check is scheduled, at most a week ahead.
  const job = await f.t.run((ctx) =>
    ctx.db.system.get("_scheduled_functions", closure.scheduledId!),
  );
  expect(job?.name).toContain("forget");
  expect(job?.scheduledTime).toBe(guardUntil + 7 * DAY);

  // A hold still active (a restore, or a row out of the expected path) keeps everything.
  const active = await f.t.run((ctx) =>
    ctx.db.insert("retentionHolds", {
      organizationId,
      reference: "fiscalizacao-tardia",
      responsible: "operacao-sintetica",
      reviewAt: decisionUntil + DAY,
      createdAt: Date.now(),
    }),
  );
  await run(decisionUntil);
  expect(await closureOf(f)).not.toBeNull();
  expect((await holds()).mine).toBe(451);
  vi.setSystemTime(decisionUntil - 1);
  expect(
    await f.t.mutation(internal.fiscalGuard.release, {
      organizationId,
      reference: "fiscalizacao-tardia",
    }),
  ).toEqual({ active: 0 });
  expect((await f.t.run((ctx) => ctx.db.get("retentionHolds", active)))?.releasedAt).toBe(
    decisionUntil - 1,
  );

  // One instant before the deadline nothing goes; at the deadline, batch by batch, all of it.
  await run(decisionUntil - 1);
  expect(await closureOf(f)).not.toBeNull();
  expect(await holds()).toEqual({ mine: 451, named: 0, theirs });
  await run(decisionUntil);
  expect((await holds()).mine).toBe(251);
  expect(await closureOf(f)).not.toBeNull();
  await settleNow(f);
  expect(await closureOf(f)).toBeNull();
  expect(await holds()).toEqual({ mine: 0, named: 0, theirs });
  await f.t.run(async (ctx) => {
    expect(await ctx.db.query("organizationClosures").collect()).toEqual([]);
    expect(await ctx.db.get("organizations", other.organizationId)).not.toBeNull();
  });
  // Running it again changes nothing.
  await f.t.mutation(internal.fiscalGuard.forget, {
    closureId: closure._id,
    generation: closure.generation + 10,
  });
  expect(await holds()).toEqual({ mine: 0, named: 0, theirs });
});

it("após um restore, rearma o prazo da decisão e trata os encerramentos expirados antes dele", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  await at(f, closed.exportUntil + 1);
  let closure = (await closureOf(f))!;
  const guardUntil = fiscalGuardUntil(closure.requestedAt);
  vi.setSystemTime(guardUntil);
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  await settleNow(f);
  // A closure expired by the previous version: no job, no deadline, the old fields and a named hold.
  await f.t.run(async (ctx) => {
    const row = (await ctx.db.query("organizationClosures").first())!;
    await ctx.scheduler.cancel(row.scheduledId!);
    await ctx.db.patch("organizationClosures", row._id, {
      scheduledId: undefined,
      decisionUntil: undefined,
      requestedBy: "member:legacy",
      revoked: true,
      removed: 32,
      expired: 48,
    });
    await ctx.db.insert("retentionHolds", {
      organizationId,
      reference: "fiscalizacao-antiga",
      responsible: "operacao-sintetica",
      reviewAt: guardUntil - DAY,
      createdAt: guardUntil - 30 * DAY,
      releasedAt: guardUntil - 2 * DAY,
    });
  });
  const closures = () => f.t.query(internal.retentionRecovery.inspect, { phase: 0, cursor: null });
  expect((await closures()).missing).toBe(1);
  await f.t.mutation(internal.retentionRecovery.recover, { phase: 0, cursor: null });
  await settleNow(f);
  expect((await closures()).missing).toBe(0);
  closure = (await closureOf(f))!;
  expect(closure).toEqual(
    expect.objectContaining({ decisionUntil: decisionGuardUntil(guardUntil) }),
  );
  for (const field of ["requestedBy", "revoked", "removed", "expired"])
    expect(closure).not.toHaveProperty(field);
  const hold = await f.t.run((ctx) => ctx.db.query("retentionHolds").first());
  expect(hold).not.toHaveProperty("reference");
  expect(hold).not.toHaveProperty("responsible");
  // Recovering again changes nothing.
  await f.t.mutation(internal.retentionRecovery.recover, { phase: 0, cursor: null });
  await settleNow(f);
  expect((await closureOf(f))!.generation).toBe(closure.generation);

  // A snapshot restored after the deadline: the recovered job removes the decision at once.
  await f.t.run(async (ctx) => {
    await ctx.scheduler.cancel(closure.scheduledId!);
  });
  vi.setSystemTime(closure.decisionUntil!);
  expect((await closures()).missing).toBe(1);
  await f.t.mutation(internal.retentionRecovery.recover, { phase: 0, cursor: null });
  await settleNow(f);
  expect(await closureOf(f)).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.query("retentionHolds").collect())).toEqual([]);
  expect((await closures()).missing).toBe(0);
});

it("após um restore, rearma a guarda das organizações já expurgadas", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await production(f);
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId: f.scope.organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  await at(f, closed.exportUntil + 1);
  // A snapshot without the job, or a closure purged before the guard existed.
  await f.t.run(async (ctx) => {
    const closure = (await ctx.db.query("organizationClosures").first())!;
    expect(closure.state).toBe("purged");
    await ctx.scheduler.cancel(closure.scheduledId!);
    await ctx.db.patch("organizationClosures", closure._id, { scheduledId: undefined });
  });
  const closures = () => f.t.query(internal.retentionRecovery.inspect, { phase: 0, cursor: null });
  expect((await closures()).missing).toBe(1);
  await f.t.mutation(internal.retentionRecovery.recover, { phase: 0, cursor: null });
  await settleNow(f);
  expect((await closures()).missing).toBe(0);
  const recovered = (await closureOf(f))!;
  await f.t.mutation(internal.retentionRecovery.recover, { phase: 0, cursor: null });
  await settleNow(f);
  expect((await closureOf(f))!.generation).toBe(recovered.generation);
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.documentId))).not.toBeNull();
});

it("para o expurgo da guarda sem apagar nada quando a árvore alcança outra organização", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await production(f);
  const other = await twin(f);
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId: f.scope.organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  await at(f, closed.exportUntil + 1);
  // A corrupted link: an artifact of the other organization under one of this organization.
  const foreign = await f.t.run(async (ctx) => {
    const parent = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first())!;
    const { _id, _creationTime, ...rest } = parent;
    return ctx.db.insert("documentArtifacts", {
      ...rest,
      organizationId: other.organizationId,
      documentId: undefined,
      parentArtifactId: parent._id,
      entryIndex: 0,
    });
  });
  const closure = (await closureOf(f))!;
  const before = await guardedRows(f, other);
  vi.setSystemTime(fiscalGuardUntil(closure.requestedAt));
  await expect(
    f.t.mutation(internal.fiscalGuard.expire, {
      closureId: closure._id,
      generation: closure.generation,
    }),
  ).rejects.toThrow("Cross-organization artifact");
  expect(await guardedRows(f, other)).toEqual(before);
  expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", foreign))).not.toBeNull();
  expect((await closureOf(f))!.expiredAt).toBeUndefined();
});
