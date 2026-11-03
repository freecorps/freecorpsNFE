import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * Deployment switch of the fiscal capture on a sandbox-based deployment (ADR 0007, amendment of
 * 22/10/2026). Only `FNFE_CAPTURE_FISCAL=enabled` lets companies release it; any other value,
 * including none, is the general cut: no company can release, and every released one is read as
 * withdrawn. It fails closed and never releases a company by itself.
 */
export const CAPTURE_FISCAL_SWITCH = "FNFE_CAPTURE_FISCAL";
export const fiscalCaptureEnabled = () => process.env[CAPTURE_FISCAL_SWITCH] === "enabled";

/**
 * Persisted general stop of the site's fiscal capture (#424), the last row of
 * `captureFiscalHalts`. While halted, the gate refuses every production capture query, like the
 * transport switch removed; it only closes, and lifting it opens nothing without a released
 * company and both deployment switches.
 */
export async function captureFiscalHalt(ctx: QueryCtx) {
  return await ctx.db.query("captureFiscalHalts").withIndex("by_version").order("desc").first();
}
export const captureFiscalHalted = async (ctx: QueryCtx) =>
  (await captureFiscalHalt(ctx))?.halted ?? false;
/** Code shown on an active production stream of the site while the general stop holds. */
export const CAPTURE_FISCAL_HALTED = "CAPTURE_FISCAL_HALTED";

/**
 * Every version of the capture terms ever offered in the console: the SHA-256 of its archived text,
 * `docs/termos/arquivo/<version>.md`, which is also the text the console shows, and the day it
 * started being asked for new releases (Brasília). A version stays here after a newer one replaces
 * it: the releases accepted under it still name it, and the newer one's `since` is the day it was
 * replaced. `apps/console/src/capture-terms.test.tsx` fails if a file and its hash part ways.
 */
export const CAPTURE_TERMS_ARCHIVE: Readonly<Record<string, { sha256: string; since: string }>> = {
  "captura-fiscal-2026-10-22": {
    sha256: "46dfca81f3c7413e2001d76c011417a9fd03a1f4bb3a863af7e7811a37379daa",
    since: "2026-10-22",
  },
};
/**
 * Version of the terms the company's manager accepts in the console to release the capture. A new
 * text is a new version, archived next to the old one, and only applies to new releases.
 */
export const CAPTURE_TERMS_VERSION = "captura-fiscal-2026-10-22";
export const CAPTURE_TERMS_SHA256 = CAPTURE_TERMS_ARCHIVE[CAPTURE_TERMS_VERSION]!.sha256;

/**
 * Days a company released under an older version has to accept the current one, counted from the
 * current version's `since` (#428). Past them, its queries wait for the acceptance, as in the
 * general stop: the release, its keys and what was received stay.
 */
export const CAPTURE_TERMS_REACCEPT_DAYS = 30;
/** Code of a production stream waiting for the company to accept the current terms. */
export const CAPTURE_TERMS_PENDING = "CAPTURE_TERMS_PENDING";

/**
 * How the terms a release accepted stand against the current version: `null` when they are the
 * current one; otherwise the deadline to accept it (midnight in Brasília, `since` plus
 * `CAPTURE_TERMS_REACCEPT_DAYS`) and whether it passed. Unknown terms count as older.
 */
export function termsStanding(accepted: string | null, now = Date.now()) {
  if (accepted === CAPTURE_TERMS_VERSION) return null;
  const since = Date.parse(`${CAPTURE_TERMS_ARCHIVE[CAPTURE_TERMS_VERSION]!.since}T00:00:00-03:00`);
  const deadline = since + CAPTURE_TERMS_REACCEPT_DAYS * 86_400_000;
  return { version: CAPTURE_TERMS_VERSION, deadline, expired: now >= deadline };
}

/**
 * The console event whose terms the release holds: the last acceptance of new terms
 * (`termsEventId`), or the release itself. Releases from before #428 keep their version only in
 * that event, which their `version` names.
 */
export async function termsEvent(ctx: QueryCtx, release: Doc<"captureReleases">) {
  const event = release.termsEventId
    ? await ctx.db.get("captureReleaseEvents", release.termsEventId)
    : await ctx.db
        .query("captureReleaseEvents")
        .withIndex("by_companyId_and_version", (q) =>
          q.eq("companyId", release.companyId).eq("version", release.version),
        )
        .unique();
  return event?.organizationId === release.organizationId &&
    event.companyId === release.companyId &&
    (event.kind === "console_release" || event.kind === "console_terms") &&
    event.terms !== undefined
    ? event
    : null;
}

/** Whether a released company's production queries wait for the current terms (#428). */
export async function captureTermsExpired(
  ctx: QueryCtx,
  company: Doc<"companies">,
  now = Date.now(),
) {
  const release = await captureRelease(ctx, company);
  if (!release?.released) return false;
  return termsStanding((await termsEvent(ctx, release))?.terms ?? null, now)?.expired ?? false;
}

/**
 * Fiscal capture release of the company, from `captureReleases`:
 *
 * - `none`: never released; production does not exist for the company.
 * - `released`: production open for the capture, its documents, webhooks and monitors.
 * - `withdrawn`: released before, then withdrawn by the company or by Freecorps, or cut for the
 *   deployment: what was captured stays readable and exportable, for portability, but nothing new
 *   is captured or configured.
 */
export async function captureReleaseState(
  ctx: QueryCtx,
  company: Doc<"companies">,
): Promise<"none" | "released" | "withdrawn"> {
  const release = await captureRelease(ctx, company);
  // A block of a company never released keeps production closed, reading included.
  if (!release?.releasedBefore) return "none";
  return release.released && fiscalCaptureEnabled() ? "released" : "withdrawn";
}

export async function captureRelease(ctx: QueryCtx, company: Doc<"companies">) {
  const release = await ctx.db
    .query("captureReleases")
    .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
    .unique();
  return release?.organizationId === company.organizationId ? release : null;
}

/** The company's own A1: active, with the company's CNPJ and still valid (ADR 0003). */
export function ownCertificate(
  company: Doc<"companies">,
  cert: Doc<"certificates">,
  now = Date.now(),
) {
  return (
    cert.companyId === company._id &&
    cert.organizationId === company.organizationId &&
    cert.state === "active" &&
    cert.metadata?.cnpj === company.cnpj &&
    cert.metadata.notAfter > now
  );
}
