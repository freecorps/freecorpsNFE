import { accountPolicy } from "../account-policy.mjs";
import { installationOrigin } from "../installation";
import { productEnvironmentOf, proofFiscalTarget } from "./lib/fiscalProof";
import {
  ISSUANCE_PRODUCTION_COMPANIES,
  ISSUANCE_PRODUCTION_MARK,
  isIssuanceProductionDeployment,
  issuanceProductionForbiddenVariables,
  issuanceProductionMisconfigured,
} from "./lib/issuanceProduction";

/**
 * Profiles the platform runs under (`APP_ENV`): the loopback development stack, the controlled
 * validation deployment and the hosted installation. All keep crons off; the profile never
 * selects the product environment or the fiscal transport, which keep their own gates.
 */
export const platformProfiles = ["development", "validation", "installation"] as const;
export type PlatformProfile = (typeof platformProfiles)[number];

/** Checks the deployment against its profile. Accounts are separate from fiscal integrations. */
export function requirePlatformEnvironment() {
  const profile: PlatformProfile =
    process.env.APP_ENV === "development" || process.env.APP_ENV === "installation"
      ? process.env.APP_ENV
      : "validation";
  const local = profile === "development";
  const installation = profile === "installation";
  // The throwaway preview of the read evaluation (#642) runs no platform profile, and a platform
  // deployment never opens the hosted proof functions (`testing/operationProof.ts`).
  if (process.env.FNFE_HOSTED_PROOF !== undefined)
    throw new Error("Invalid platform configuration: FNFE_HOSTED_PROOF");
  if (installation) {
    installationOrigin(process.env.SITE_URL);
    installationOrigin(process.env.CONVEX_SITE_URL);
    // Public REST address served by the Worker; direct backend calls are refused.
    installationOrigin(process.env.API_URL);
    if (process.env.AUTH_PROXY_MODE !== "signed" || process.env.FISCAL_ENV !== "disabled")
      throw new Error(
        "Invalid installation configuration: signed proxy and disabled fiscal transport required",
      );
    // The site captures through the company release (ADR 0007, phase 4), never the #50 policy.
    if (process.env.FNFE_FISCAL_PROOF !== undefined)
      throw new Error("Invalid platform configuration: FNFE_FISCAL_PROOF");
    if (![undefined, "", "disabled", "sefaz"].includes(process.env.FNFE_CAPTURE_TRANSPORT))
      throw new Error("Invalid platform configuration: FNFE_CAPTURE_TRANSPORT");
  }
  // Real transport is an explicit opt-in, with one fiscal production per purpose. The capture
  // reads the production only on the dedicated #50 target, marked at publish; the NFS-e issuance
  // only on the deployment versioned in `deploy/issuance-production.json` (below). On both, the
  // platform environment is production too.
  if (process.env.FNFE_PROOF_FISCAL_ENV && proofFiscalTarget() !== "production")
    throw new Error("Invalid platform configuration: FNFE_PROOF_FISCAL_ENV");
  const fiscalTarget = proofFiscalTarget();
  // Fiscal production of the NFS-e issuance: only the versioned deployment, marked, in the
  // installation profile. The mark elsewhere (even empty), or the named deployment without it,
  // is refused instead of being ignored.
  if (issuanceProductionMisconfigured())
    throw new Error(`Invalid platform configuration: ${ISSUANCE_PRODUCTION_MARK}`);
  const issuanceProduction = isIssuanceProductionDeployment();
  if (issuanceProduction) {
    for (const name of issuanceProductionForbiddenVariables)
      // Present at all, even empty, is refused: the deployment never carries them.
      if (process.env[name] !== undefined)
        throw new Error(`Invalid platform configuration: ${name}`);
    if (![undefined, "", "disabled"].includes(process.env.FNFE_CAPTURE_TRANSPORT))
      throw new Error("Invalid platform configuration: FNFE_CAPTURE_TRANSPORT");
  } else if (process.env[ISSUANCE_PRODUCTION_COMPANIES] !== undefined)
    // The list of companies of the fiscal production belongs to that deployment only.
    throw new Error(`Invalid platform configuration: ${ISSUANCE_PRODUCTION_COMPANIES}`);
  const fiscalEnv =
    process.env.FISCAL_ENV === fiscalTarget && process.env.FNFE_CAPTURE_TRANSPORT === "sefaz"
      ? fiscalTarget
      : "disabled";
  if (
    local &&
    (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.CONVEX_SITE_URL ?? "") ||
      !/^http:\/\/localhost:\d+$/.test(process.env.SITE_URL ?? ""))
  )
    throw new Error("Local platform requires loopback backend and frontend");
  const expected = {
    APP_ENV: profile,
    PRODUCT_ENV: issuanceProduction ? "production" : productEnvironmentOf(fiscalTarget),
    FISCAL_ENV: fiscalEnv,
    FNFE_CRONS: "off",
    SITE_URL:
      local || installation
        ? process.env.SITE_URL
        : "https://freecorpsnfe-validation.freecorps.workers.dev",
  };
  if (!["disabled", "https"].includes(process.env.WEBHOOK_MODE ?? ""))
    throw new Error("Invalid platform configuration: WEBHOOK_MODE");
  for (const [name, value] of Object.entries(expected)) {
    if (process.env[name] !== value) {
      throw new Error(`Invalid platform configuration: ${name}`);
    }
  }
  let accounts: ReturnType<typeof accountPolicy>;
  try {
    accounts = accountPolicy(process.env, local);
  } catch {
    throw new Error("Invalid platform configuration: accounts");
  }
  return {
    profile,
    local,
    installation,
    appEnv: profile,
    productEnv: expected.PRODUCT_ENV,
    siteUrl: process.env.SITE_URL!,
    apiUrl: installation ? process.env.API_URL! : process.env.CONVEX_SITE_URL!,
    accounts,
    fiscalEnv,
    /** `production` only on the fiscal production deployment of the NFS-e issuance. */
    issuanceEnv: issuanceProduction ? ("production" as const) : ("disabled" as const),
    /**
     * `enabled` when the hosted site may query the source for released companies: both site
     * switches on (`lib/siteCapture.ts`). It says nothing about whether any company is released.
     */
    captureFiscal:
      installation &&
      !issuanceProduction &&
      expected.PRODUCT_ENV === "sandbox" &&
      process.env.FNFE_CAPTURE_FISCAL === "enabled" &&
      process.env.FNFE_CAPTURE_TRANSPORT === "sefaz"
        ? ("enabled" as const)
        : ("disabled" as const),
  };
}
