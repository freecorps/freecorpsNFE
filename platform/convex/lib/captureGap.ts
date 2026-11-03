import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { CAPTURE_HOUR, captureProcessingTask } from "./captureValues";
import { continueOperation } from "./operationCore";
import { PROCESSOR_VERSION } from "./importValues";
import { deny } from "./organizationAccess";

/**
 * Gap recovery of a capture stream (#419). NT 2014.002 v1.40 numbers each actor's documents
 * without gaps (§3.6) and by order of reception at the Ambiente Nacional (§3.5), and keeps them
 * for 90 days after that reception (§3, §3.5, §3.6). A `distNSU` response that starts above the
 * checkpoint + 1 therefore means a gap: documents the stream never read. Each missing NSU is
 * asked with `consNSU`, which the NT limits to 20 queries per hour with `consChNFe` (§3.11.4.2),
 * and nothing else in the NT spaces them: the hour it asks for is after a 137 or the end of the
 * queue in `distNSU` (§3.5, §3.11.4.1) and after a 656. So the recovery chains its queries, one
 * second apart, up to `RECOVERY_HOURLY_LIMIT` in any sliding hour (half of it for a day after a
 * 656), and waits only when that budget, the source or the site's own ceiling
 * (`SITE_CAPTURE_HOURLY_LIMIT`) says so.
 *
 * A `consNSU` answered 137 is an NSU the source no longer has: past the 90 days, or never
 * generated, which the NT tells the actor to disregard (§3.6). Older NSUs leave the window
 * first, so the unavailable part of a gap is its bottom. The recovery then looks for where it
 * ends: the top of the gap first (one query settles the usual case, a stream quiet for more than
 * 90 days, where nothing of the gap is left), then by halves. The NSUs recovered on the way stay
 * stored and are admitted in order once the checkpoint reaches them. At the limit, the stream
 * waits in attention for the owner to accept the loss of that bottom part
 * (`captures.acceptGap`), and only of it.
 */

/**
 * `consNSU` queries per stream in any hour: a third of the NT's 20 (§3.11.4.2), which the CNPJ's
 * other systems (ERP, accountant) share and whose 656 blocks them too. Counted over a sliding
 * hour, so no clock hour, however the source counts it, holds more.
 */
export const RECOVERY_HOURLY_LIMIT = 6;
/**
 * After a 656 of the stream, the recovery uses half of the budget, at least one an hour, for a
 * day (`recovery_backoff` in `captureAudit`): a 656 says someone else spends the CNPJ's quota.
 */
export const RECOVERY_BACKOFF_MS = 24 * CAPTURE_HOUR;
export const RECOVERY_BACKOFF_LIMIT = Math.max(1, Math.floor(RECOVERY_HOURLY_LIMIT / 2));
/** The `captureAudit` action that opens a day of halved recovery budget. */
export const RECOVERY_BACKOFF = "recovery_backoff";
/** Shortest spacing between two queries of a recovery, as for a pending `distNSU` queue. */
export const RECOVERY_STEP_MS = 1000;
/** The attention code of a gap whose unavailable part is known and waits for a decision. */
export const GAP_UNAVAILABLE = "RECONCILIATION_UNAVAILABLE";
/** Stored envelopes admitted per transaction, above what a gap can hold (50 + its probes). */
const ADMIT_LIMIT = 200;

type Recovery = NonNullable<Doc<"captureStreams">["recovery"]>;
type Position = Pick<Doc<"captureStreams">, "_id" | "checkpoint" | "sourceCursor">;

/** The NSU `step` after `nsu`, in the source's 15-digit form. */
export const nsuAfter = (nsu: string, step = 1n) =>
  (BigInt(nsu) + step).toString().padStart(15, "0");

/** A recovery starting now, from what the stream knew before the response that revealed it. */
export function newRecovery(
  stream: Doc<"captureStreams">,
  batch: Pick<Doc<"captureBatches">, "mode" | "lastNsu" | "maxNsu">,
  now = Date.now(),
): Recovery {
  return (
    stream.recovery ?? {
      detectedAt: now,
      ...(stream.lastSuccessAt !== undefined ? { quietSince: stream.lastSuccessAt } : {}),
      // Only a `distNSU` answer tells the queue; in `consNSU`, `ultNSU` is the NSU asked.
      queuePending:
        batch.mode === "distNSU" &&
        !!batch.lastNsu &&
        !!batch.maxNsu &&
        batch.lastNsu < batch.maxNsu,
    }
  );
}

/**
 * The lowest NSU known to exist above the gap: the first envelope already stored above the
 * checkpoint, or the one after the source cursor. Null when nothing is known missing above the
 * checkpoint. Called once stored envelopes in sequence were admitted.
 */
export async function gapCeiling(ctx: QueryCtx, stream: Position) {
  const stored = await ctx.db
    .query("captureEnvelopes")
    .withIndex("by_streamId_nsu", (q) => q.eq("streamId", stream._id).gt("nsu", stream.checkpoint))
    .first();
  if (stored) return stored.nsu;
  if (stream.sourceCursor && stream.sourceCursor > stream.checkpoint)
    return nsuAfter(stream.sourceCursor);
  return null;
}

/** The `consNSU` budget of the stream's current hour: halved for a day after a 656. */
export async function recoveryLimit(ctx: QueryCtx, streamId: Id<"captureStreams">, now: number) {
  const backoff = await ctx.db
    .query("captureAudit")
    .withIndex("by_streamId_and_action_and_createdAt", (q) =>
      q
        .eq("streamId", streamId)
        .eq("action", RECOVERY_BACKOFF)
        .gt("createdAt", now - RECOVERY_BACKOFF_MS),
    )
    .first();
  return backoff ? RECOVERY_BACKOFF_LIMIT : RECOVERY_HOURLY_LIMIT;
}

/**
 * When the stream may send its next `consNSU`: now, or when the oldest of the last `limit`
 * leaves the sliding hour. Every `consNSU` the stream reserved counts
 * (`reconciliation_started`), answered or not, as the source may have counted it. `distNSU` does
 * not: the NT's hourly limit covers `consNSU` and `consChNFe` (§3.11.4.2), and the stream sends
 * no `consChNFe`.
 */
export async function recoverySlot(ctx: QueryCtx, streamId: Id<"captureStreams">, now: number) {
  const limit = await recoveryLimit(ctx, streamId, now);
  const recent = await ctx.db
    .query("captureAudit")
    .withIndex("by_streamId_and_action_and_createdAt", (q) =>
      q
        .eq("streamId", streamId)
        .eq("action", "reconciliation_started")
        .gt("createdAt", now - CAPTURE_HOUR),
    )
    .order("desc")
    .take(limit);
  return recent.length < limit ? now : recent.at(-1)!.createdAt + CAPTURE_HOUR;
}

/** Turns a stored envelope into its `documents.capture` operation, under `op`'s access. */
export async function admitEnvelope(
  ctx: MutationCtx,
  op: Doc<"operations">,
  envelope: Doc<"captureEnvelopes">,
) {
  const artifact = (await ctx.db.get("documentArtifacts", envelope.artifactId))!;
  if (artifact.organizationId !== op.organizationId || artifact.companyId !== op.companyId)
    return deny("OPERATION_CONFLICT");
  const operationId = await continueOperation(
    ctx,
    op,
    captureProcessingTask,
    JSON.stringify({ artifactId: envelope.artifactId, processorVersion: PROCESSOR_VERSION }),
    Date.now(),
    false,
  );
  await ctx.db.patch("captureEnvelopes", envelope._id, { operationId });
  await ctx.db.patch("documentArtifacts", envelope.artifactId, {
    processingOperationId: operationId,
  });
}

/**
 * Moves the checkpoint over the envelopes already stored right after it, in order, admitting
 * the ones never admitted: what a gap recovery or an accepted loss put in sequence. No query.
 */
export async function admitStored(
  ctx: MutationCtx,
  op: Doc<"operations">,
  streamId: Id<"captureStreams">,
  checkpoint: string,
  received: number,
) {
  for (let n = 0; n < ADMIT_LIMIT; n++) {
    const next = nsuAfter(checkpoint);
    const envelope = await ctx.db
      .query("captureEnvelopes")
      .withIndex("by_streamId_nsu", (q) => q.eq("streamId", streamId).eq("nsu", next))
      .unique();
    if (!envelope) break;
    if (!envelope.operationId) {
      await admitEnvelope(ctx, op, envelope);
      received++;
    }
    checkpoint = next;
  }
  return { checkpoint, received };
}

/**
 * A source cursor that only a 656 set (#421): before it, a 656 took its `ultNSU`, the last query
 * made for the CNPJ by any system (NT §3.11.4.1, "Observação"), as the cursor and put the stream
 * in `consNSU`, one NSU per hour. That is the unread queue, not a gap: nothing is stored above
 * the checkpoint, the cursor equals the `ultNSU` of a 656 of this stream, and no `distNSU`
 * response ever returned it. Such a stream reads the queue with `distNSU` from the checkpoint,
 * as a 656 now leaves it.
 */
export async function cursorFromBlock(ctx: QueryCtx, stream: Doc<"captureStreams">) {
  const cursor = stream.sourceCursor;
  if (stream.mode !== "consNSU" || stream.recovery || !cursor || cursor <= stream.checkpoint)
    return false;
  const stored = await ctx.db
    .query("captureEnvelopes")
    .withIndex("by_streamId_nsu", (q) => q.eq("streamId", stream._id).gt("nsu", stream.checkpoint))
    .first();
  if (stored) return false;
  const batches = (status: string) =>
    ctx.db
      .query("captureBatches")
      .withIndex("by_streamId_and_status_and_lastNsu", (q) =>
        q.eq("streamId", stream._id).eq("status", status).eq("lastNsu", cursor),
      )
      .take(20);
  if (!(await batches("656")).length) return false;
  for (const status of ["137", "138"])
    if ((await batches(status)).some((batch) => batch.mode === "distNSU")) return false;
  return true;
}

export type RecoveryStep = {
  checkpoint: string;
  received: number;
  sourceCursor: string | undefined;
  mode: "distNSU" | "consNSU";
  code: string | undefined;
  recovery: Recovery | undefined;
  /** When the next query may go; undefined keeps the default window of an hour. */
  window: number | undefined;
};

/**
 * The stream after one durable `consNSU` answer of 137 or 138 (the 138 already checked to hold
 * exactly the NSU asked). `endOfQueueMs` is what the stream waits at the end of the queue, for
 * a recovery that ends where the source had nothing more.
 */
export async function recoveryStep(
  ctx: MutationCtx,
  op: Doc<"operations">,
  stream: Doc<"captureStreams">,
  batch: Doc<"captureBatches">,
  endOfQueueMs: number,
  now = Date.now(),
): Promise<RecoveryStep> {
  const sourceCursor = (await cursorFromBlock(ctx, stream)) ? undefined : stream.sourceCursor;
  const asked = batch.requestNsu;
  let recovery = stream.recovery;
  const searching = !!recovery?.unavailableTo;
  if (batch.status === "137" && asked > stream.checkpoint) {
    const base = newRecovery(stream, batch, now);
    const unavailableTo =
      base.unavailableTo && base.unavailableTo > asked ? base.unavailableTo : asked;
    recovery = { ...base, unavailableTo };
  }
  const { checkpoint, received } = await admitStored(
    ctx,
    op,
    stream._id,
    stream.checkpoint,
    stream.received,
  );
  const ceiling = await gapCeiling(ctx, { _id: stream._id, checkpoint, sourceCursor });
  const at = Math.max(now + RECOVERY_STEP_MS, await recoverySlot(ctx, stream._id, now));
  const base = { checkpoint, received, sourceCursor };
  const lost = recovery?.unavailableTo;
  if (recovery && lost && lost > checkpoint) {
    const rest = { ...recovery, probe: undefined };
    // Nothing known in between: the unavailable part ends here and waits for a decision.
    if (ceiling === null || ceiling === nsuAfter(lost))
      return { ...base, mode: "consNSU", code: GAP_UNAVAILABLE, recovery: rest, window: undefined };
    // The top first, then by halves: lost < probe < ceiling.
    const probe = searching
      ? nsuAfter(lost, (BigInt(ceiling) - BigInt(lost)) / 2n)
      : nsuAfter(ceiling, -1n);
    return {
      ...base,
      mode: "consNSU",
      code: "RECONCILING_GAP",
      recovery: { ...recovery, probe },
      window: at,
    };
  }
  const settled = recovery
    ? { ...recovery, unavailableTo: undefined, probe: undefined }
    : undefined;
  if (ceiling !== null)
    return { ...base, mode: "consNSU", code: "RECONCILING_GAP", recovery: settled, window: at };
  if (sourceCursor && checkpoint >= sourceCursor) {
    // Back to the queue, from the cursor: right away if the source still had one, otherwise
    // after the end-of-queue wait counted from the response that revealed the gap.
    const window = recovery?.queuePending
      ? now + RECOVERY_STEP_MS
      : Math.max(now + RECOVERY_STEP_MS, (recovery?.detectedAt ?? now) + endOfQueueMs);
    return { ...base, mode: "distNSU", code: undefined, recovery: undefined, window };
  }
  // A recovered NSU does not tell where the source's cursor is (an uncertain response).
  return {
    ...base,
    mode: "distNSU",
    code: "SOURCE_CURSOR_UNKNOWN",
    recovery: undefined,
    window: undefined,
  };
}

/**
 * The NSU range the owner may accept to lose: the bottom of a gap the source no longer has,
 * from the one after the checkpoint to the highest NSU answered 137, once nothing unknown is
 * left between it and the first NSU known to exist. Null otherwise.
 */
export async function lostRange(ctx: QueryCtx, stream: Doc<"captureStreams">) {
  const to = stream.recovery?.unavailableTo;
  if (stream.state !== "attention" || stream.code !== GAP_UNAVAILABLE || !to) return null;
  if (to <= stream.checkpoint) return null;
  const ceiling = await gapCeiling(ctx, stream);
  if (ceiling !== null && ceiling !== nsuAfter(to)) return null;
  return { from: nsuAfter(stream.checkpoint), to };
}
