import { releasedProductionScopes, type IntegrationScope } from "@freecorps/contracts";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { requirePlatformEnvironment } from "../environment";
import { captureReleaseState } from "./fiscalCaptureRelease";

export type ProductEnvironment = "sandbox" | "production";
/**
 * What a request does in an environment: an integration scope, a monitor of the company, or the
 * processing of a document the capture already stored (`capture-processing`, only the
 * `documents.capture` continuation: it reads the stored XML, never the source nor a certificate).
 */
export type EnvironmentPurpose = IntegrationScope | "observability" | "capture-processing";

/**
 * The environment every record of this deployment may use without a company release: its
 * `PRODUCT_ENV`. Dedicated targets (#50, NFS-e fiscal production) are production; the hosted
 * site, validation and development are sandbox.
 */
export function baseEnvironment(): ProductEnvironment {
  return requirePlatformEnvironment().productEnv === "production" ? "production" : "sandbox";
}

/**
 * What a sandbox deployment may serve in production for a released company (ADR 0007, §3):
 * the capture and the documents, exports, webhooks and monitors around it. Imports, issuance,
 * registry, references, certificates and company changes never run in production there.
 */
const releasedPurposes: ReadonlySet<EnvironmentPurpose> = new Set<EnvironmentPurpose>([
  ...releasedProductionScopes,
  "observability",
  "capture-processing",
]);
/**
 * What a withdrawn release keeps: reading and exporting what was already captured, and turning
 * what was already received into documents (#420). The envelopes behind the checkpoint are only
 * processed here, so cutting that would hide them for good.
 */
const withdrawnPurposes: ReadonlySet<EnvironmentPurpose> = new Set([
  "companies:read",
  "documents:read",
  "connections:read",
  "capture-processing",
]);

/**
 * Whether this deployment serves `environment` for the company and purpose. The base environment
 * is always served (a demonstration company only in sandbox). A production deployment serves
 * nothing else. A sandbox deployment serves production only for a released company and a
 * released purpose, or, after the release is withdrawn, only for reading and the processing of
 * what was already received. Every access check goes through here, never through `PRODUCT_ENV`.
 */
export async function environmentServed(
  ctx: QueryCtx,
  company: Doc<"companies">,
  environment: ProductEnvironment,
  purpose: EnvironmentPurpose,
): Promise<boolean> {
  if (company.kind === "demonstration" && environment !== "sandbox") return false;
  const base = baseEnvironment();
  if (environment === base) return true;
  if (base === "production") return false;
  if (!releasedPurposes.has(purpose)) return false;
  const release = await captureReleaseState(ctx, company);
  return release === "released" || (release === "withdrawn" && withdrawnPurposes.has(purpose));
}

/**
 * Whether a new project grant or API key may name `environment` for the company. On the hosted
 * sandbox, production only while the company's fiscal capture is released (ADR 0007): the grant
 * or key then reaches what the release serves, never imports or issuance. Other deployments
 * keep their own rule.
 */
export async function environmentOffered(
  ctx: QueryCtx,
  company: Doc<"companies">,
  environment: ProductEnvironment,
): Promise<boolean> {
  if (environment !== "production" || baseEnvironment() !== "sandbox") return true;
  return environmentServed(ctx, company, environment, "webhooks:manage");
}

/**
 * Whether the deployment serves `environment` to some company of the organization, for an
 * organization-wide read such as its export. Each company is checked again with
 * `environmentServed` before any of its records is read.
 */
export async function organizationEnvironmentServed(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  environment: ProductEnvironment,
  purpose: EnvironmentPurpose,
): Promise<boolean> {
  const base = baseEnvironment();
  if (environment === base) return true;
  if (base === "production" || !releasedPurposes.has(purpose)) return false;
  const releases = await ctx.db
    .query("captureReleases")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .take(100);
  for (const release of releases) {
    const company = await ctx.db.get("companies", release.companyId);
    if (
      company?.organizationId === organizationId &&
      (await environmentServed(ctx, company, environment, purpose))
    )
      return true;
  }
  return false;
}

/**
 * Whether a key's environment is served for at least one of its companies, for entry checks that
 * run before a company is chosen. Each company is checked again with `environmentServed`.
 */
export async function keyEnvironmentServed(
  ctx: QueryCtx,
  key: Doc<"apiKeys">,
  purpose: EnvironmentPurpose,
): Promise<boolean> {
  const base = baseEnvironment();
  if (key.environment === base) return true;
  if (base === "production" || !releasedPurposes.has(purpose)) return false;
  for (const id of key.companyIds) {
    const company = await ctx.db.get("companies", id);
    if (
      company?.organizationId === key.organizationId &&
      (await environmentServed(ctx, company, key.environment, purpose))
    )
      return true;
  }
  return false;
}
