import { companyCapabilities, organizationCapabilities } from "@freecorps/contracts";
import { v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { requirePlatformEnvironment } from "./environment";
import { baseEnvironment, environmentServed } from "./lib/environmentAccess";
import {
  captureRelease,
  captureReleaseState,
  fiscalCaptureEnabled,
  ownCertificate,
} from "./lib/fiscalCaptureRelease";
import { stoppedByCut } from "./lib/captureAttention";
import { certificateHead } from "./lib/certificateAccess";
import { findCompany } from "./lib/companyAccess";
import { consoleTasks, tasksValue, type DeclaredFacts } from "./lib/consoleTasks";
import { importFileState } from "./lib/importCore";
import { importFileOutcome, needsAttention } from "./lib/importOutcome";
import { MAX_IMPORT_FILES } from "./lib/importValues";
import { transportModeFor } from "./lib/issuanceCore";
import { nfseProfileOf } from "./lib/nfseProfile";
import {
  originOf,
  READ_ROLES,
  recordOrigin,
  WRITE_ROLES,
  type RecordOrigin,
} from "./lib/operationAccess";
import { deny, requireMembership } from "./lib/organizationAccess";
import { notesQuotaStop, planFor } from "./lib/usageCore";
import { noteLimit } from "./lib/usageValues";
import { canManageProject } from "./lib/projectAccess";

/**
 * Início of an organization in the console: what happened this month, what needs action and
 * how far each task is (`tasks`). Everything is limited to the companies the member reaches
 * (`findCompany`: managers see all, the others only the companies granted to them), and the
 * fiscal part to the roles that read fiscal work (a developer reads it through integrations).
 *
 * The query is bounded: at most MAX_COMPANIES companies and, per company, the newest
 * MAX_ROWS issuances and documents of the month and MAX_IMPORTS imports. A count that reached
 * its limit comes with `partial`, so the screen says "ou mais" instead of a wrong number.
 * The clock comes from the client (`monthStart`, `asOf`): a query does not read the time.
 */
const MAX_COMPANIES = 10;
const MAX_ROWS = 100;
const MAX_IMPORTS = 5;
const MAX_PENDING = 10;
const MAX_PROJECTS = 20;
const MAX_KEYS = 20;
const EXPIRY_WINDOW = 30 * 86_400_000;
/**
 * A production capture without an answered query for this long is a pending item: the source
 * suspends the NSU generation of a CNPJ not queried for 60 days (#422).
 */
const CAPTURE_QUIET = 30 * 86_400_000;
const MAX_MONTH = 32 * 86_400_000;

const pendingKind = v.union(
  v.literal("issuance-rejected"),
  v.literal("issuance-reconciling"),
  v.literal("issuance-paused"),
  v.literal("certificate-expiring"),
  v.literal("certificate-expired"),
  v.literal("import-failed"),
  v.literal("capture-attention"),
  v.literal("capture-quiet"),
);
type PendingKind = Infer<typeof pendingKind>;
const summaryValue = v.object({
  environment: v.union(v.literal("sandbox"), v.literal("production")),
  /** Companies the member reaches, up to the limit. */
  companies: v.object({ count: v.number(), truncated: v.boolean() }),
  /** `null` for a role that does not read fiscal work in the console (developer). */
  month: v.union(
    v.null(),
    v.object({
      issuances: v.object({
        authorized: v.number(),
        processing: v.number(),
        rejected: v.number(),
        cancelled: v.number(),
      }),
      received: v.number(),
      /**
       * Documents received this month in production, for the companies whose fiscal capture was
       * released (ADR 0007); `null` when no company the member reaches has production.
       */
      production: v.union(v.null(), v.object({ received: v.number() })),
      failedImports: v.number(),
      partial: v.boolean(),
    }),
  ),
  pending: v.array(
    v.object({
      kind: pendingKind,
      companyId: v.id("companies"),
      companyName: v.string(),
      /** Issuance, import or capture stream id for the direct link; `null` for a certificate. */
      recordId: v.union(v.string(), v.null()),
      at: v.number(),
      /** Why a production capture is in attention, so the Início says it (#432). */
      code: v.optional(v.string()),
      /** The attention came from the Freecorps cut by variable, now over (#601, `stoppedByCut`). */
      freecorpsCut: v.optional(v.boolean()),
      /** The plan caps the capture by new notes, and its `QUOTA_EXCEEDED` is that limit (ADR 0010), as `captures.get` says them. */
      countsNotes: v.optional(v.boolean()),
      notesQuota: v.optional(v.boolean()),
      /**
       * Who activated a capture in attention, as the capture panel says it (`captures.get`): on an
       * integration's capture, the Início says the integration resumes (#607).
       */
      origin: v.optional(recordOrigin),
    }),
  ),
  /** Readiness by task (#510), in `lib/consoleTasks.ts`. */
  tasks: tasksValue,
});

const urgent = (kind: PendingKind) => kind.startsWith("certificate") || kind.startsWith("capture");

async function reachableCompanies(ctx: QueryCtx, membership: Doc<"memberships">) {
  if (companyCapabilities(membership.role).manage) {
    const rows = await ctx.db
      .query("companies")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", membership.organizationId))
      .take(MAX_COMPANIES + 1);
    return { companies: rows.slice(0, MAX_COMPANIES), truncated: rows.length > MAX_COMPANIES };
  }
  const grants = await ctx.db
    .query("companyGrants")
    .withIndex("by_membershipId_and_membershipEpoch_and_active", (q) =>
      q
        .eq("membershipId", membership._id)
        .eq("membershipEpoch", membership.companyAccessEpoch ?? 0)
        .eq("active", true),
    )
    .take(MAX_COMPANIES + 1);
  const companies: Doc<"companies">[] = [];
  for (const grant of grants.slice(0, MAX_COMPANIES)) {
    // The same rule every console function applies, so the Início never shows more.
    const access = await findCompany(ctx, membership, grant.companyId);
    if (access) companies.push(access.company);
  }
  return { companies, truncated: grants.length > MAX_COMPANIES };
}

/**
 * Whether an active integration this member manages exists, and whether one has a key that still
 * works; `null` for a role that does not manage integrations.
 */
async function integrationState(ctx: QueryCtx, membership: Doc<"memberships">, asOf: number) {
  if (!organizationCapabilities(membership.role).manageIntegrations) return null;
  const projects = (
    await ctx.db
      .query("projects")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", membership.organizationId))
      .take(MAX_PROJECTS)
  ).filter((project) => project.state === "active" && canManageProject(membership, project));
  if (!projects.length) return { project: false, key: false };
  for (const project of projects) {
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
      .take(MAX_KEYS);
    if (
      keys.some(
        (key) =>
          key.revokedAt === null &&
          key.expiresAt > asOf &&
          key.projectEpoch === project.accessEpoch,
      )
    )
      return { project: true, key: true };
  }
  return { project: true, key: false };
}

export const summary = query({
  args: {
    organizationId: v.id("organizations"),
    /** Start of the member's current month, in its own time zone. */
    monthStart: v.number(),
    /** Client clock, rounded by the caller; certificates expire relative to it. */
    asOf: v.number(),
    contextKey: v.string(),
  },
  returns: summaryValue,
  handler: async (ctx, { organizationId, monthStart, asOf }) => {
    requirePlatformEnvironment();
    const { membership } = await requireMembership(ctx, organizationId);
    if (
      !Number.isFinite(monthStart) ||
      !Number.isFinite(asOf) ||
      monthStart > asOf ||
      asOf - monthStart > MAX_MONTH
    )
      return deny("INVALID_REQUEST");
    const environment = baseEnvironment();
    const { companies, truncated } = await reachableCompanies(ctx, membership);
    const integrationFacts = await integrationState(ctx, membership, asOf);
    const base = {
      environment: environment as "sandbox" | "production",
      companies: { count: companies.length, truncated },
    };
    const facts = {
      role: membership.role,
      manage: companyCapabilities(membership.role).manage,
      write: WRITE_ROLES.includes(membership.role),
      // A demonstration company exists only in the sandbox (`environmentServed`).
      companies: companies
        .filter((company) => environment === "sandbox" || company.kind !== "demonstration")
        .map((company) => company._id),
      demonstrationCompanyId:
        environment === "sandbox"
          ? (companies.find((company) => company.kind === "demonstration")?._id ?? null)
          : null,
      documentCompanyId: null as Doc<"companies">["_id"] | null,
      declared: [] as DeclaredFacts[],
      // The task is the simulated sandbox issuance; the fiscal production one is not it.
      issuanceAvailable: environment === "sandbox",
      // The same answer as `captureRelease.status.available`.
      captureAvailable: environment === "sandbox" && fiscalCaptureEnabled(),
      integration: integrationFacts,
    };
    if (!READ_ROLES.includes(membership.role))
      return { ...base, month: null, pending: [], tasks: consoleTasks(facts) };

    const issuances = { authorized: 0, processing: 0, rejected: 0, cancelled: 0 };
    let received = 0,
      failedImports = 0,
      partial = truncated;
    let production = false,
      productionReceived = 0;
    const pending: Array<{
      kind: PendingKind;
      companyId: Doc<"companies">["_id"];
      companyName: string;
      recordId: string | null;
      at: number;
      code?: string;
      freecorpsCut?: boolean;
      countsNotes?: boolean;
      notesQuota?: boolean;
      origin?: RecordOrigin;
    }> = [];

    for (const company of companies) {
      const at = { companyId: company._id, companyName: company.name };

      const monthIssuances = await ctx.db
        .query("issuances")
        .withIndex("by_organizationId_and_companyId_and_environment_and_createdAt", (q) =>
          q
            .eq("organizationId", organizationId)
            .eq("companyId", company._id)
            .eq("environment", environment)
            .gte("createdAt", monthStart),
        )
        .order("desc")
        .take(MAX_ROWS + 1);
      if (monthIssuances.length > MAX_ROWS) partial = true;
      for (const issuance of monthIssuances.slice(0, MAX_ROWS)) {
        issuances[issuance.state] += 1;
        if (issuance.state === "rejected")
          pending.push({
            ...at,
            kind: "issuance-rejected",
            recordId: issuance._id,
            at: issuance.updatedAt,
          });
        else if (issuance.state === "processing") {
          const operation = await ctx.db.get("operations", issuance.operationId);
          if (operation?.state === "reconciling" || operation?.state === "paused")
            pending.push({
              ...at,
              kind: operation.state === "paused" ? "issuance-paused" : "issuance-reconciling",
              recordId: issuance._id,
              at: issuance.updatedAt,
            });
        }
      }

      const documents = await ctx.db
        .query("fiscalDocuments")
        .withIndex("by_companyId_environment_listedAt", (q) =>
          q.eq("companyId", company._id).eq("environment", environment).gte("listedAt", monthStart),
        )
        .take(MAX_ROWS + 1);
      if (documents.length > MAX_ROWS) partial = true;
      received += documents
        .slice(0, MAX_ROWS)
        .filter(
          (document) =>
            document.organizationId === organizationId && document.direction !== "emitted",
        ).length;

      const imports = await ctx.db
        .query("imports")
        .withIndex("by_organizationId_and_companyId_and_environment", (q) =>
          q
            .eq("organizationId", organizationId)
            .eq("companyId", company._id)
            .eq("environment", environment),
        )
        .order("desc")
        .take(MAX_IMPORTS + 1);
      const monthImports = imports.filter((batch) => batch.createdAt >= monthStart);
      if (monthImports.length > MAX_IMPORTS) partial = true;
      for (const batch of monthImports.slice(0, MAX_IMPORTS)) {
        const files = await ctx.db
          .query("importFiles")
          .withIndex("by_importId", (q) => q.eq("importId", batch._id))
          .take(MAX_IMPORT_FILES);
        let failed = false;
        for (const file of files) {
          // The document's result, not the processing's: a succeeded processing can end with a
          // refused XML (#507). One such file marks the batch once; the others change nothing
          // (#285).
          if (needsAttention(importFileOutcome(await importFileState(ctx, file)))) {
            failed = true;
            break;
          }
        }
        if (failed) {
          failedImports += 1;
          pending.push({ ...at, kind: "import-failed", recordId: batch._id, at: batch.createdAt });
        }
      }

      // Any document of the base environment, not only this month's: the import task asks for a
      // first one. This month's, already read, answer first; a demonstration company only counts
      // where it is served, in the sandbox.
      const importable = environment === "sandbox" || company.kind !== "demonstration";
      if (
        importable &&
        !facts.documentCompanyId &&
        documents.some(
          // The same rows the index query below reads: an issued NFS-e not yet published
          // (`completeness: -1`) is not a first document.
          (document) => document.organizationId === organizationId && document.completeness >= 0,
        )
      )
        facts.documentCompanyId = company._id;
      if (importable && !facts.documentCompanyId) {
        const first = await ctx.db
          .query("fiscalDocuments")
          .withIndex("by_organizationId_and_companyId_and_environment_and_completeness", (q) =>
            q
              .eq("organizationId", organizationId)
              .eq("companyId", company._id)
              .eq("environment", environment)
              .gte("completeness", 0),
          )
          .first();
        if (first) facts.documentCompanyId = company._id;
      }

      let released = false,
        started = false;
      if (
        environment !== "production" &&
        (await environmentServed(ctx, company, "production", "documents:read"))
      ) {
        // Released or withdrawn: what was captured in production stays readable (ADR 0007).
        const captured = await ctx.db
          .query("fiscalDocuments")
          .withIndex("by_companyId_environment_listedAt", (q) =>
            q
              .eq("companyId", company._id)
              .eq("environment", "production")
              .gte("listedAt", monthStart),
          )
          .take(MAX_ROWS + 1);
        if (captured.length > MAX_ROWS) partial = true;
        production = true;
        productionReceived += captured
          .slice(0, MAX_ROWS)
          .filter(
            (document) =>
              document.organizationId === organizationId && document.direction !== "emitted",
          ).length;
        // Only while released: a withdrawn capture is the company's decision, not a pending item.
        if ((await captureReleaseState(ctx, company)) === "released") {
          released = true;
          const stream = await ctx.db
            .query("captureStreams")
            .withIndex("by_companyId_environment", (q) =>
              q.eq("companyId", company._id).eq("environment", "production"),
            )
            .first();
          const lastQuery = stream ? (stream.lastSuccessAt ?? stream.createdAt) : 0;
          started = stream?.organizationId === organizationId && stream.state !== "paused";
          if (stream?.organizationId === organizationId && stream.state === "attention")
            pending.push({
              ...at,
              kind: "capture-attention",
              recordId: stream._id,
              at: stream.lastAttemptAt ?? lastQuery,
              ...(stream.code ? { code: stream.code } : {}),
              ...(stoppedByCut(stream) ? { freecorpsCut: true } : {}),
              ...(noteLimit(await planFor(ctx, organizationId), "captures", "production") !== null
                ? { countsNotes: true }
                : {}),
              ...((await notesQuotaStop(ctx, stream, stream.code)) ? { notesQuota: true } : {}),
              origin: await originOf(ctx, stream),
            });
          else if (stream?.organizationId === organizationId && asOf - lastQuery >= CAPTURE_QUIET)
            pending.push({ ...at, kind: "capture-quiet", recordId: stream._id, at: lastQuery });
        }
      }

      if (company.kind === "declared") {
        const head = await certificateHead(ctx, company._id);
        const certificate = head?.activeId ? await ctx.db.get("certificates", head.activeId) : null;
        const notAfter =
          certificate?.state === "active" && certificate.companyId === company._id
            ? (certificate.metadata?.notAfter ?? null)
            : null;
        if (notAfter !== null && notAfter <= asOf)
          pending.push({ ...at, kind: "certificate-expired", recordId: null, at: notAfter });
        else if (notAfter !== null && notAfter - asOf <= EXPIRY_WINDOW)
          pending.push({ ...at, kind: "certificate-expiring", recordId: null, at: notAfter });
        const profile = await nfseProfileOf(ctx, company._id);
        facts.declared.push({
          companyId: company._id,
          certificate: !!certificate && ownCertificate(company, certificate, asOf),
          profile: profile?.organizationId === organizationId,
          certificateForIssuance:
            transportModeFor({ environment, companyId: company._id }) !== "simulated",
          released,
          // A Freecorps block makes `captureRelease.enable` refuse the release.
          releaseBlocked:
            facts.captureAvailable && !released && !!(await captureRelease(ctx, company))?.blocked,
          started,
        });
      }
    }

    return {
      ...base,
      month: {
        issuances,
        received,
        production: production ? { received: productionReceived } : null,
        failedImports,
        partial,
      },
      // Certificates and captures first (they stop issuing and capturing), then the newest
      // issuances and imports.
      pending: pending
        .sort((a, b) => (urgent(a.kind) === urgent(b.kind) ? b.at - a.at : urgent(a.kind) ? -1 : 1))
        .slice(0, MAX_PENDING),
      tasks: consoleTasks(facts),
    };
  },
});
