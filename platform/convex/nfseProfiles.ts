import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { companyAudit, requireCompany } from "./lib/companyAccess";
import { deny } from "./lib/organizationAccess";
import { environment } from "./lib/projectValues";
import { dpsSequenceView, nfseProfileFields, nfseProfileView } from "./lib/nfseProfileValues";
import {
  dpsSequencesOf,
  nfseProfileOf,
  normalizeNfseProfile,
  profileSeries,
  profileView,
  sameProfile,
  sequenceView,
} from "./lib/nfseProfile";

const scope = { organizationId: v.id("organizations"), companyId: v.id("companies") };
/** Highest DPS number of the layout (nDPS, 15 digits). */
const MAX_DPS_NUMBER = 999_999_999_999_999;

/** Any member with access to the company reads the profile; `null` until one is saved. */
export const get = query({
  args: { ...scope, contextKey: v.string() },
  returns: v.union(v.null(), nfseProfileView),
  handler: async (ctx, { organizationId, companyId }) => {
    await requireCompany(ctx, organizationId, companyId);
    const profile = await nfseProfileOf(ctx, companyId);
    return profile ? profileView(profile) : null;
  },
});

/**
 * Creates (`expectedVersion` 0) or replaces the profile. Same rule as the company registration
 * and certificates: owner or admin of the organization, never on the demonstration company.
 */
export const save = mutation({
  args: { ...scope, ...nfseProfileFields, expectedVersion: v.number() },
  returns: v.object({ version: v.number(), changed: v.boolean() }),
  handler: async (ctx, { organizationId, companyId, expectedVersion, ...input }) => {
    const { user, company } = await requireCompany(ctx, organizationId, companyId, true);
    if (company.kind === "demonstration") return deny("DEMONSTRATION_READ_ONLY");
    const current = await nfseProfileOf(ctx, companyId);
    if ((current?.version ?? 0) !== expectedVersion) return deny("NFSE_PROFILE_CHANGED");
    const fields = normalizeNfseProfile(input, company.address.state);
    const now = Date.now();
    if (!current) {
      await ctx.db.insert("nfseProfiles", {
        organizationId,
        companyId,
        ...fields,
        version: 1,
        updatedBy: user._id,
        createdAt: now,
        updatedAt: now,
      });
      await companyAudit(ctx, company, user._id, "company.nfse_profile_created");
      return { version: 1, changed: true };
    }
    const version = current.version;
    // Saving the same profile again is not a change: no new version, no audit entry.
    if (sameProfile(current, fields)) return { version, changed: false };
    // `replace` drops optional fields the new profile no longer has (IM, regApTribSN...).
    await ctx.db.replace("nfseProfiles", current._id, {
      organizationId,
      companyId,
      ...fields,
      version: version + 1,
      updatedBy: user._id,
      createdAt: current.createdAt,
      updatedAt: now,
    });
    await companyAudit(ctx, company, user._id, "company.nfse_profile_updated");
    return { version: version + 1, changed: true };
  },
});

/**
 * DPS numbering of the company: every series of the profile in both environments, plus any
 * series that already has a sequence. Any member with access to the company reads it.
 */
export const sequences = query({
  args: { ...scope, contextKey: v.string() },
  returns: v.array(dpsSequenceView),
  handler: async (ctx, { organizationId, companyId }) => {
    await requireCompany(ctx, organizationId, companyId);
    const profile = await nfseProfileOf(ctx, companyId);
    const rows = await dpsSequencesOf(ctx, companyId);
    const keys = new Map(rows.map((row) => [`${row.environment}:${row.series}`, row]));
    const views = rows.map(sequenceView);
    for (const env of ["sandbox", "production"] as const)
      for (const series of profile ? profileSeries(profile) : [])
        if (!keys.has(`${env}:${series}`))
          views.push({
            environment: env,
            series,
            start: 1,
            next: 1,
            locked: false,
            startSetAt: null,
          });
    return views.sort((a, b) =>
      a.environment === b.environment
        ? Number(a.series) - Number(b.series)
        : a.environment === "sandbox"
          ? -1
          : 1,
    );
  },
});

/**
 * Sets the first DPS number of a series of the profile in an environment, for a company that
 * already issued with that series outside the platform. Allowed only while the platform has not
 * reserved any number of the series and environment: afterwards the numbering never moves.
 * Owner or admin, never on the demonstration company; audited (`company.nfse_dps_start_set`).
 */
export const setDpsStart = mutation({
  args: { ...scope, environment, series: v.string(), start: v.number() },
  returns: v.object({ series: v.string(), start: v.number(), changed: v.boolean() }),
  handler: async (ctx, { organizationId, companyId, environment: env, series, start }) => {
    const { user, company } = await requireCompany(ctx, organizationId, companyId, true);
    if (company.kind === "demonstration") return deny("DEMONSTRATION_READ_ONLY");
    const profile = await nfseProfileOf(ctx, companyId);
    if (!profile) return deny("NFSE_PROFILE_REQUIRED");
    const normalized = /^\d{1,5}$/.test(series.trim()) ? String(Number(series.trim())) : "";
    if (!profileSeries(profile).includes(normalized)) return deny("INVALID_DPS_SERIES");
    if (!Number.isSafeInteger(start) || start < 1 || start > MAX_DPS_NUMBER)
      return deny("INVALID_DPS_START");
    const row = await ctx.db
      .query("dpsSequences")
      .withIndex("by_companyId_and_environment_and_series", (q) =>
        q.eq("companyId", companyId).eq("environment", env).eq("series", normalized),
      )
      .unique();
    if (row && row.last >= (row.start ?? 1)) return deny("DPS_START_LOCKED");
    if ((row?.start ?? 1) === start) return { series: normalized, start, changed: false };
    // The same row the reservation patches: Convex serializes this write with any concurrent
    // request, so a number is never reserved under the old start after this commits.
    const now = Date.now();
    const fields = {
      last: start - 1,
      start,
      startSetBy: user._id,
      startSetAt: now,
      updatedAt: now,
    };
    if (row) await ctx.db.patch("dpsSequences", row._id, fields);
    else
      await ctx.db.insert("dpsSequences", {
        organizationId,
        companyId,
        environment: env,
        series: normalized,
        ...fields,
      });
    await companyAudit(ctx, company, user._id, "company.nfse_dps_start_set");
    return { series: normalized, start, changed: true };
  },
});
