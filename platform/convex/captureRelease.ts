import { normalizeCnpj } from "@freecorps/contracts";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { buildSha } from "./buildInfo";
import { certificateHead } from "./lib/certificateAccess";
import { findCompany } from "./lib/companyAccess";
import { baseEnvironment } from "./lib/environmentAccess";
import {
  CAPTURE_TERMS_SHA256,
  CAPTURE_TERMS_VERSION,
  captureFiscalHalt,
  captureFiscalHalted,
  captureRelease,
  captureReleaseState,
  fiscalCaptureEnabled,
  ownCertificate,
  termsEvent,
  termsStanding,
} from "./lib/fiscalCaptureRelease";
import { FREECORPS_OPERATOR, gateRequest } from "./lib/issuanceGate";
import { recordAudit } from "./lib/operationalAudit";
import {
  deny,
  limitOrganizationAction,
  requireMembership,
  type CustodyOption,
} from "./lib/organizationAccess";
import { closureOf } from "./lib/organizationClosure";
import { pauseOperation } from "./lib/operationCore";
import { captureAudit } from "./lib/captureCore";
import { CAPTURE_HOUR, releaseIntervalHours } from "./lib/captureValues";
import { superviseCompany } from "./lib/captureSupervision";
import { RELEASE_WITHDRAWN_EVENT } from "./lib/webhookAccess";
import { emitEvent } from "./lib/webhookOutbox";
import { clockOf } from "./lib/clock";

const MAX_PROJECTS = 200;
const MAX_KEYS_PER_PROJECT = 500;
const scope = { organizationId: v.id("organizations"), companyId: v.id("companies") };
const manager = (m: Doc<"memberships">) => m.role === "owner" || m.role === "admin";
/** Minimum hours between queries at the end of the queue: a whole number from 1 to 24. */
const validInterval = (hours: number) => Number.isSafeInteger(hours) && hours >= 1 && hours <= 24;

/** The active certificate of the company, if it is the company's own A1. */
async function activeOwnCertificate(ctx: QueryCtx, company: Doc<"companies">) {
  const head = await certificateHead(ctx, company._id);
  const cert = head?.activeId ? await ctx.db.get("certificates", head.activeId) : null;
  return !!cert && ownCertificate(company, cert, clockOf(ctx));
}

/**
 * Revokes every production key of the organization that reaches the company, so that a key
 * created before the release never starts working by it: production keys are issued again after
 * the release (ADR 0007, §2).
 */
async function revokeProductionKeys(ctx: MutationCtx, company: Doc<"companies">, now: number) {
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", company.organizationId))
    .take(MAX_PROJECTS + 1);
  if (projects.length > MAX_PROJECTS) return deny("CAPTURE_RELEASE_KEYS_UNBOUNDED");
  let revoked = 0;
  for (const project of projects) {
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
      .take(MAX_KEYS_PER_PROJECT + 1);
    if (keys.length > MAX_KEYS_PER_PROJECT) return deny("CAPTURE_RELEASE_KEYS_UNBOUNDED");
    for (const key of keys)
      if (
        key.environment === "production" &&
        key.revokedAt === null &&
        key.companyIds.includes(company._id)
      ) {
        await ctx.db.patch("apiKeys", key._id, { revokedAt: now });
        revoked++;
      }
  }
  return revoked;
}

/**
 * Stops the company's production stream when its release is withdrawn: the operation pauses
 * (an IO already sent stays uncertain, for the reconciliation) and the stream pauses with the
 * code, so nothing is scheduled again. Resuming needs a new release.
 *
 * `withdrawn` names the release version that held until now (a released company losing it): the
 * stream then emits its last event, `connection.release_withdrawn`, also when it was already
 * paused (its version moves then too), keyed by that version. It is emitted here, before the release changes, and its
 * delivery keeps the permission the withdrawal takes away from the other events
 * (`endpointAllowed`), so the integration hears of it after losing production (#422).
 */
async function stopProductionStream(
  ctx: MutationCtx,
  company: Doc<"companies">,
  code: string,
  withdrawn: number | null,
) {
  const stream = await ctx.db
    .query("captureStreams")
    .withIndex("by_companyId_environment", (q) =>
      q.eq("companyId", company._id).eq("environment", "production"),
    )
    .first();
  if (!stream || stream.organizationId !== company.organizationId) return;
  if (stream.state !== "paused") {
    const op = stream.operationId ? await ctx.db.get("operations", stream.operationId) : null;
    if (op && !["succeeded", "failed", "paused"].includes(op.state))
      await pauseOperation(ctx, op, code);
    await ctx.db.patch("captureStreams", stream._id, {
      state: "paused",
      version: stream.version + 1,
      code,
    });
    await captureAudit(ctx, stream, "release_withdrawn");
  } else if (withdrawn !== null)
    // Already paused (by the company, or since an earlier withdrawal): the event is still a new
    // fact of the stream, so its version moves and a receiver keeping the last version per
    // resource does not drop it as a repeat. The code the stream had stays.
    await ctx.db.patch("captureStreams", stream._id, { version: stream.version + 1 });
  if (withdrawn === null) return;
  const current = (await ctx.db.get("captureStreams", stream._id))!;
  await emitEvent(ctx, {
    organizationId: current.organizationId,
    companyId: current.companyId,
    projectId: current.projectId,
    environment: "production",
    type: RELEASE_WITHDRAWN_EVENT,
    resourceType: "connection",
    resourceId: current._id,
    resourceVersion: current.version,
    logicalKey: `connection:${current._id}:release_withdrawn:${withdrawn}`,
    operationIds: current.operationId ? [current.operationId] : [],
  });
}

type Change = {
  kind: Doc<"captureReleaseEvents">["kind"];
  released: boolean;
  blocked: boolean;
  minIntervalHours: number;
  actor: string;
  reason: string;
  revokedKeys: number;
  person:
    | { membershipId: Id<"memberships">; terms?: string; termsSha256?: string }
    | { operator: string; actor?: string; runId: string; runAttempt: number };
};
/**
 * Appends the history row and rewrites the current state in the same transaction, plus the
 * operational audit. A withdraw of a company never released only leaves the history; a block
 * creates the state with `releasedBefore: false`, which keeps production closed.
 *
 * Every change that leaves the company without the release stops its production stream here,
 * whatever the caller: a withdrawn release never leaves a stream scheduled with its operation
 * dead (#424). Stopping a stream already paused only emits the last event, when a release held.
 */
async function record(
  ctx: MutationCtx,
  company: Doc<"companies">,
  current: Doc<"captureReleases"> | null,
  change: Change,
) {
  if (!change.released)
    await stopProductionStream(
      ctx,
      company,
      "CAPTURE_RELEASE_WITHDRAWN",
      current?.released ? current.version : null,
    );
  const last = await ctx.db
    .query("captureReleaseEvents")
    .withIndex("by_companyId_and_version", (q) => q.eq("companyId", company._id))
    .order("desc")
    .first();
  const version = Math.max(last?.version ?? 0, current?.version ?? 0) + 1;
  const now = Date.now();
  const eventId = await ctx.db.insert("captureReleaseEvents", {
    organizationId: company.organizationId,
    companyId: company._id,
    version,
    kind: change.kind,
    released: change.released,
    blocked: change.blocked,
    minIntervalHours: change.minIntervalHours,
    revokedKeys: change.revokedKeys,
    reason: change.reason,
    ...change.person,
    buildSha,
    deployment: process.env.CONVEX_CLOUD_URL ?? "",
    createdAt: now,
  });
  const fields = {
    organizationId: company.organizationId,
    companyId: company._id,
    released: change.released,
    releasedBefore: change.released || (current?.releasedBefore ?? false),
    blocked: change.blocked,
    minIntervalHours: change.minIntervalHours,
    actor: change.actor,
    reason: change.reason,
    version,
    updatedAt: now,
    eventId,
  };
  if (current) await ctx.db.replace("captureReleases", current._id, fields);
  else if (change.released || change.blocked) await ctx.db.insert("captureReleases", fields);
  await recordAudit(ctx, {
    organizationId: company.organizationId,
    companyId: company._id,
    environment: "production",
    actor: change.actor,
    action: change.released
      ? "capture.fiscal_released"
      : change.kind === "unblock"
        ? "capture.fiscal_unblocked"
        : "capture.fiscal_withdrawn",
    target: company._id,
  });
  // A released company is supervised from now on (#422); the check stops once withdrawn.
  if (change.released) await superviseCompany(ctx, company);
  return version;
}

/** The company of a manager (owner or admin) with access to it, on a sandbox-based deployment. */
async function managedCompany(
  ctx: QueryCtx,
  args: { organizationId: Id<"organizations">; companyId: Id<"companies"> },
  options: CustodyOption = {},
) {
  const { membership } = await requireMembership(ctx, args.organizationId, options);
  const access = await findCompany(ctx, membership, args.companyId);
  if (!access) return deny("NOT_FOUND");
  const company = (await ctx.db.get("companies", args.companyId))!;
  return { membership, company };
}

const statusValue = v.object({
  available: v.boolean(),
  state: v.union(v.literal("none"), v.literal("released"), v.literal("withdrawn")),
  blocked: v.boolean(),
  minIntervalHours: v.number(),
  updatedAt: v.union(v.number(), v.null()),
  canManage: v.boolean(),
  requirements: v.object({ declared: v.boolean(), certificate: v.boolean() }),
  terms: v.string(),
  /**
   * The acceptance of the release that holds: the terms version, when, and who, by name only for
   * owners and admins, the roles that see the organization's members; `null` when off.
   */
  acceptedTerms: v.union(
    v.object({
      version: v.string(),
      acceptedAt: v.number(),
      acceptedBy: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  /**
   * A release that holds under older terms (#428): the version to accept, the deadline and
   * whether it passed, when the queries wait for the acceptance; `null` otherwise.
   */
  termsUpdate: v.union(
    // Whether `deadline` passed is the console's clock: a query never reads it (#45).
    v.object({ version: v.string(), deadline: v.number() }),
    v.null(),
  ),
});

/**
 * The acceptance of the release that holds: the last `console_terms` event, or else the
 * `console_release` event its version names (only the console releases, and an interval change
 * keeps the version), with the terms, the time and the membership. The name is the membership's
 * copy of the account's (removed members keep it; a deleted account reads "Conta excluída"), and
 * only `withName` callers get it: the member list is for owners and admins (ORGANIZATIONS.md), and
 * so is the name of who accepted.
 */
async function acceptedTerms(
  ctx: QueryCtx,
  company: Doc<"companies">,
  release: Doc<"captureReleases"> | null,
  withName: boolean,
) {
  if (!release?.released || release.organizationId !== company.organizationId) return null;
  const event = await termsEvent(ctx, release);
  if (!event) return null;
  const person =
    withName && event.membershipId ? await ctx.db.get("memberships", event.membershipId) : null;
  return {
    version: event.terms!,
    acceptedAt: event.createdAt,
    acceptedBy: person?.organizationId === company.organizationId ? person.name : null,
  };
}
/**
 * What the console shows about the company's fiscal capture: whether the deployment offers it,
 * the state, the Freecorps block, the interval and whether the person can change it. Any member
 * who reads the company sees it; only owners and admins change it.
 */
export const status = query({
  args: scope,
  returns: statusValue,
  handler: async (ctx, args) => {
    const { membership, company } = await managedCompany(ctx, args, { archived: "allowed" });
    const release = await captureRelease(ctx, company);
    const state = await captureReleaseState(ctx, company);
    const accepted =
      state === "released" ? await acceptedTerms(ctx, company, release, manager(membership)) : null;
    return {
      available: baseEnvironment() === "sandbox" && fiscalCaptureEnabled(),
      state,
      blocked: release?.blocked ?? false,
      minIntervalHours: release?.minIntervalHours ?? 1,
      updatedAt: release?.updatedAt ?? null,
      canManage: manager(membership),
      requirements: {
        declared: company.kind === "declared",
        certificate: await activeOwnCertificate(ctx, company),
      },
      terms: CAPTURE_TERMS_VERSION,
      acceptedTerms: accepted,
      termsUpdate: state === "released" ? termsStanding(accepted?.version ?? null) : null,
    };
  },
});

/**
 * The company's owner or admin releases its fiscal capture in the console (ADR 0007, amendment of
 * 22/10/2026). Requires the deployment switch, a declared company of an open organization, its own
 * active A1, the current terms and the minimum interval (1 to 24 hours), and no Freecorps block.
 * Records the version of the terms and the SHA-256 of their archived text. Revokes the company's
 * production keys.
 */
export const enable = mutation({
  args: { ...scope, minIntervalHours: v.number(), terms: v.string() },
  returns: v.object({ version: v.number(), revokedKeys: v.number() }),
  handler: async (ctx, args) => {
    const { membership, company } = await managedCompany(ctx, args);
    if (!manager(membership)) return deny("SCOPE_DENIED");
    await limitOrganizationAction(ctx, "capture-release", args.organizationId);
    if (baseEnvironment() !== "sandbox" || !fiscalCaptureEnabled())
      return deny("CAPTURE_RELEASE_UNAVAILABLE");
    if (company.kind !== "declared") return deny("CAPTURE_RELEASE_DEMONSTRATION_DENIED");
    if (args.terms !== CAPTURE_TERMS_VERSION) return deny("CAPTURE_RELEASE_TERMS_REQUIRED");
    if (!validInterval(args.minIntervalHours)) return deny("CAPTURE_RELEASE_INTERVAL_INVALID");
    if (await closureOf(ctx, args.organizationId)) return deny("ORGANIZATION_CLOSED");
    const current = await captureRelease(ctx, company);
    if (current?.blocked) return deny("CAPTURE_RELEASE_BLOCKED");
    if (current?.released) return deny("CAPTURE_RELEASE_ALREADY_RELEASED");
    if (!(await activeOwnCertificate(ctx, company)))
      return deny("CAPTURE_RELEASE_CERTIFICATE_REQUIRED");
    const revokedKeys = await revokeProductionKeys(ctx, company, Date.now());
    const version = await record(ctx, company, current, {
      kind: "console_release",
      released: true,
      blocked: false,
      minIntervalHours: args.minIntervalHours,
      actor: `member:${membership._id}`,
      reason: "Liberada no console pela empresa",
      revokedKeys,
      // The server names the text accepted: the version the console showed, and its hash.
      person: {
        membershipId: membership._id,
        terms: CAPTURE_TERMS_VERSION,
        termsSha256: CAPTURE_TERMS_SHA256,
      },
    });
    return { version, revokedKeys };
  },
});

/**
 * The company's owner or admin changes the minimum interval of a release that holds (#432),
 * without withdrawing it. The same checks as `enable`, other than terms and certificate, which
 * the release already has.
 *
 * The change is an event of its own in the history, with the person, and it keeps the release's
 * version: the queued queries pin that version (`releaseAccessVersion`), and a new one would cut
 * them as if the release had been withdrawn. The next query never comes earlier than it was
 * going to: the interval counts at the next end of the queue (`captureProcessing.checkpoint`).
 * A longer interval also postpones the next automatic query of a stream already waiting at the
 * end of the queue, to its last answered query plus the new interval; the waiting operation
 * wakes, finds the window ahead and waits again, without spending an attempt (#421).
 */
export const updateInterval = mutation({
  args: { ...scope, minIntervalHours: v.number() },
  returns: v.object({
    minIntervalHours: v.number(),
    changed: v.boolean(),
    /** The postponed next query of the production stream, when there was one to postpone. */
    nextAllowedAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const { membership, company } = await managedCompany(ctx, args);
    if (!manager(membership)) return deny("SCOPE_DENIED");
    await limitOrganizationAction(ctx, "capture-release", args.organizationId);
    if (baseEnvironment() !== "sandbox" || !fiscalCaptureEnabled())
      return deny("CAPTURE_RELEASE_UNAVAILABLE");
    if (!validInterval(args.minIntervalHours)) return deny("CAPTURE_RELEASE_INTERVAL_INVALID");
    if (await closureOf(ctx, args.organizationId)) return deny("ORGANIZATION_CLOSED");
    const current = await captureRelease(ctx, company);
    if (current?.blocked) return deny("CAPTURE_RELEASE_BLOCKED");
    if (!current?.released) return deny("CAPTURE_RELEASE_NOT_RELEASED");
    if (current.minIntervalHours === args.minIntervalHours)
      return { minIntervalHours: current.minIntervalHours, changed: false, nextAllowedAt: null };
    const last = await ctx.db
      .query("captureReleaseEvents")
      .withIndex("by_companyId_and_version", (q) => q.eq("companyId", company._id))
      .order("desc")
      .first();
    const now = Date.now();
    const actor = `member:${membership._id}`,
      reason = "Intervalo mínimo alterado no console pela empresa";
    const eventId = await ctx.db.insert("captureReleaseEvents", {
      organizationId: company.organizationId,
      companyId: company._id,
      version: Math.max(last?.version ?? 0, current.version) + 1,
      kind: "console_interval",
      released: true,
      blocked: false,
      minIntervalHours: args.minIntervalHours,
      revokedKeys: 0,
      reason,
      membershipId: membership._id,
      buildSha,
      deployment: process.env.CONVEX_CLOUD_URL ?? "",
      createdAt: now,
    });
    await ctx.db.patch("captureReleases", current._id, {
      minIntervalHours: args.minIntervalHours,
      actor,
      reason,
      updatedAt: now,
      eventId,
    });
    await recordAudit(ctx, {
      organizationId: company.organizationId,
      companyId: company._id,
      environment: "production",
      actor,
      action: "capture.fiscal_interval_changed",
      target: company._id,
    });
    return {
      minIntervalHours: args.minIntervalHours,
      changed: true,
      nextAllowedAt: await postponeAtEndOfQueue(ctx, company, args.minIntervalHours, actor),
    };
  },
});

/**
 * A longer interval applied to the production stream waiting at the end of the queue: active,
 * reading by `distNSU` with no gap to recover, nothing sent and unanswered, and the last answer
 * reaching the source's `maxNSU`. A queue still being read, a recovery or a source window keep
 * their own times, and a later time already set stays (a 656, the hourly ceiling). Returns the
 * new time, or `null` when nothing moved.
 */
async function postponeAtEndOfQueue(
  ctx: MutationCtx,
  company: Doc<"companies">,
  minIntervalHours: number,
  actor: string,
) {
  const stream = await ctx.db
    .query("captureStreams")
    .withIndex("by_companyId_environment", (q) =>
      q.eq("companyId", company._id).eq("environment", "production"),
    )
    .first();
  if (
    !stream ||
    stream.organizationId !== company.organizationId ||
    stream.state !== "active" ||
    stream.mode !== "distNSU" ||
    stream.recovery ||
    stream.lastSuccessAt === undefined ||
    (stream.lastAttemptAt ?? 0) > stream.lastSuccessAt
  )
    return null;
  if (!stream.sourceMaxNsu || stream.checkpoint < stream.sourceMaxNsu) return null;
  const next = stream.lastSuccessAt + releaseIntervalHours(minIntervalHours) * CAPTURE_HOUR;
  if (next <= stream.nextAllowedAt) return null;
  await ctx.db.patch("captureStreams", stream._id, { nextAllowedAt: next });
  await captureAudit(ctx, { ...stream, nextAllowedAt: next }, "interval_postponed", actor);
  return next;
}

/** The company's owner or admin withdraws its fiscal capture; the reading of what was captured stays. */
export const disable = mutation({
  args: scope,
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const { membership, company } = await managedCompany(ctx, args, { archived: "allowed" });
    if (!manager(membership)) return deny("SCOPE_DENIED");
    await limitOrganizationAction(ctx, "capture-release", args.organizationId);
    const current = await captureRelease(ctx, company);
    if (!current?.released) return deny("CAPTURE_RELEASE_NOT_RELEASED");
    const version = await record(ctx, company, current, {
      kind: "console_withdraw",
      released: false,
      blocked: current.blocked,
      minIntervalHours: current.minIntervalHours,
      actor: `member:${membership._id}`,
      reason: "Retirada no console pela empresa",
      revokedKeys: 0,
      person: { membershipId: membership._id },
    });
    return { version };
  },
});

/**
 * The company's owner or admin accepts the current terms for a release that holds under older ones
 * (#428), without withdrawing it. The same checks as `updateInterval`, plus the terms the console
 * showed. Like the interval, the acceptance is an event of its own and keeps the release's
 * version, so the queued queries go on; past the deadline they were waiting for it
 * (`siteCaptureDecision`) and come back at their next check, within an hour.
 */
export const acceptTerms = mutation({
  args: { ...scope, terms: v.string() },
  returns: v.object({ terms: v.string() }),
  handler: async (ctx, args) => {
    const { membership, company } = await managedCompany(ctx, args);
    if (!manager(membership)) return deny("SCOPE_DENIED");
    await limitOrganizationAction(ctx, "capture-release", args.organizationId);
    if (baseEnvironment() !== "sandbox" || !fiscalCaptureEnabled())
      return deny("CAPTURE_RELEASE_UNAVAILABLE");
    if (args.terms !== CAPTURE_TERMS_VERSION) return deny("CAPTURE_RELEASE_TERMS_REQUIRED");
    if (await closureOf(ctx, args.organizationId)) return deny("ORGANIZATION_CLOSED");
    const current = await captureRelease(ctx, company);
    if (current?.blocked) return deny("CAPTURE_RELEASE_BLOCKED");
    if (!current?.released) return deny("CAPTURE_RELEASE_NOT_RELEASED");
    if (!termsStanding((await termsEvent(ctx, current))?.terms ?? null))
      return deny("CAPTURE_TERMS_ALREADY_ACCEPTED");
    const last = await ctx.db
      .query("captureReleaseEvents")
      .withIndex("by_companyId_and_version", (q) => q.eq("companyId", company._id))
      .order("desc")
      .first();
    const now = Date.now();
    const actor = `member:${membership._id}`,
      reason = "Novos termos aceitos no console pela empresa";
    const eventId = await ctx.db.insert("captureReleaseEvents", {
      organizationId: company.organizationId,
      companyId: company._id,
      version: Math.max(last?.version ?? 0, current.version) + 1,
      kind: "console_terms",
      released: true,
      blocked: false,
      minIntervalHours: current.minIntervalHours,
      revokedKeys: 0,
      reason,
      membershipId: membership._id,
      terms: CAPTURE_TERMS_VERSION,
      termsSha256: CAPTURE_TERMS_SHA256,
      buildSha,
      deployment: process.env.CONVEX_CLOUD_URL ?? "",
      createdAt: now,
    });
    await ctx.db.patch("captureReleases", current._id, {
      actor,
      reason,
      updatedAt: now,
      eventId,
      termsEventId: eventId,
    });
    await recordAudit(ctx, {
      organizationId: company.organizationId,
      companyId: company._id,
      environment: "production",
      actor,
      action: "capture.fiscal_terms_accepted",
      target: company._id,
    });
    return { terms: CAPTURE_TERMS_VERSION };
  },
});

/**
 * The company a Freecorps workflow names: by its Convex id, with the organization as an optional
 * cross-check, or by its CNPJ (#424). A CNPJ declared in more than one organization is refused
 * with `CAPTURE_RELEASE_COMPANY_AMBIGUOUS` until the organization is given: the workflow never
 * picks one of them, nor acts on all of them.
 */
async function freecorpsTarget(
  ctx: QueryCtx,
  target: { organizationId?: Id<"organizations">; companyId?: Id<"companies">; cnpj?: string },
) {
  if ((target.companyId === undefined) === (target.cnpj === undefined))
    return deny("CAPTURE_RELEASE_TARGET_INVALID");
  if (target.companyId !== undefined) {
    const company = await ctx.db.get("companies", target.companyId);
    if (
      !company ||
      (target.organizationId !== undefined && company.organizationId !== target.organizationId)
    )
      return deny("NOT_FOUND");
    return company;
  }
  const cnpj = normalizeCnpj(target.cnpj!);
  if (!cnpj) return deny("CAPTURE_RELEASE_CNPJ_INVALID");
  const matches = await (target.organizationId !== undefined
    ? ctx.db
        .query("companies")
        .withIndex("by_organizationId_and_cnpj", (q) =>
          q.eq("organizationId", target.organizationId!).eq("cnpj", cnpj),
        )
        .take(2)
    : ctx.db
        .query("companies")
        .withIndex("by_cnpj", (q) => q.eq("cnpj", cnpj))
        .take(2));
  if (matches.length === 0) return deny("NOT_FOUND");
  if (matches.length > 1) return deny("CAPTURE_RELEASE_COMPANY_AMBIGUOUS");
  return matches[0]!;
}

const runFields = {
  operator: v.string(),
  actor: v.optional(v.string()),
  reason: v.string(),
  runId: v.string(),
  runAttempt: v.number(),
};

/**
 * Freecorps operator switch, only from the workflows (`scripts/deploy/capture-release.mjs`), without
 * approval, by a person in `authorizedActors`: `emergency_withdraw` withdraws the capture and
 * blocks the company from releasing it again; `unblock` lifts the block without releasing or
 * withdrawing anything, and is refused for a company that is not blocked
 * (`CAPTURE_RELEASE_NOT_BLOCKED`), so it never rewrites a release (#424). The company comes by id
 * or by CNPJ (`freecorpsTarget`). Nothing inside Convex proves that the call came from the
 * workflow; the control is operational (CAPTURE.md).
 */
export const set = internalMutation({
  args: {
    organizationId: v.optional(v.id("organizations")),
    companyId: v.optional(v.id("companies")),
    cnpj: v.optional(v.string()),
    kind: v.union(v.literal("emergency_withdraw"), v.literal("unblock")),
    ...runFields,
  },
  returns: v.object({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    released: v.boolean(),
    blocked: v.boolean(),
    version: v.number(),
  }),
  handler: async (ctx, { organizationId, companyId, cnpj, kind, ...change }) => {
    if (baseEnvironment() !== "sandbox") return deny("CAPTURE_RELEASE_DEPLOYMENT_DENIED");
    const request = gateRequest({ ...change, kind: "emergency_disable" });
    const company = await freecorpsTarget(ctx, { organizationId, companyId, cnpj });
    const current = await captureRelease(ctx, company);
    if (kind === "unblock" && !current?.blocked) return deny("CAPTURE_RELEASE_NOT_BLOCKED");
    const blocked = kind === "emergency_withdraw";
    // The block always comes with the release withdrawn, so the unblock keeps `released: false`
    // in practice; it keeps whatever is recorded instead of writing it.
    const released = blocked ? false : current!.released;
    const version = await record(ctx, company, current, {
      kind,
      released,
      blocked,
      minIntervalHours: current?.minIntervalHours ?? 1,
      actor: FREECORPS_OPERATOR,
      reason: request.reason,
      revokedKeys: 0,
      person: {
        operator: request.operator,
        ...(request.actor ? { actor: request.actor } : {}),
        runId: request.runId,
        runAttempt: request.runAttempt,
      },
    });
    return {
      organizationId: company.organizationId,
      companyId: company._id,
      released,
      blocked,
      version,
    };
  },
});

/**
 * Persisted general stop of the site's fiscal capture (#424), only from the workflows, without
 * approval, by a person in `authorizedActors`: `halt` refuses every production capture query of
 * every company in the gate, with the effect of removing `FNFE_CAPTURE_TRANSPORT`; `resume` lifts
 * it and opens nothing by itself (the releases, the A1 and both variables still decide). Halting
 * an already halted deployment records again, so an emergency never fails on the state; resuming
 * one that is not halted is refused (`CAPTURE_FISCAL_NOT_HALTED`).
 */
export const setHalt = internalMutation({
  args: { kind: v.union(v.literal("halt"), v.literal("resume")), ...runFields },
  returns: v.object({ halted: v.boolean(), version: v.number() }),
  handler: async (ctx, { kind, ...change }) => {
    if (baseEnvironment() !== "sandbox") return deny("CAPTURE_RELEASE_DEPLOYMENT_DENIED");
    const request = gateRequest({ ...change, kind: "emergency_disable" });
    const current = await captureFiscalHalt(ctx);
    if (kind === "resume" && !current?.halted) return deny("CAPTURE_FISCAL_NOT_HALTED");
    const halted = kind === "halt";
    const version = (current?.version ?? 0) + 1;
    await ctx.db.insert("captureFiscalHalts", {
      version,
      kind,
      halted,
      operator: request.operator,
      ...(request.actor ? { actor: request.actor } : {}),
      reason: request.reason,
      runId: request.runId,
      runAttempt: request.runAttempt,
      buildSha,
      deployment: process.env.CONVEX_CLOUD_URL ?? "",
      createdAt: Date.now(),
    });
    return { halted, version };
  },
});

/** Whether the general stop is on, for `/health`. */
export const haltState = internalQuery({
  args: {},
  returns: v.object({ halted: v.boolean() }),
  handler: async (ctx) => ({ halted: await captureFiscalHalted(ctx) }),
});
