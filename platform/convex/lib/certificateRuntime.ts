"use node";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { Infer } from "convex/values";
import type { Claim } from "./operationCore";
import type { deferralAudit } from "./captureValues";
import { currentCertificateKeyring, decryptCertificate } from "./certificateCrypto";
import { certificateRequest, type TransportTarget } from "./certificateTransport";

/**
 * Opens the pinned certificate of the claimed operation for the duration of `use`, which may
 * sign and make several mTLS calls with the same material. Authorization and completion are
 * audited once per attempt, as in `transportWithCertificate`; the material is disposed at the
 * end and never returned, logged or persisted.
 */
export async function withCertificate<T>(
  ctx: Pick<ActionCtx, "runMutation">,
  claim: Claim,
  use: (material: { pfx: Buffer; password: Buffer }) => Promise<T>,
): Promise<T> {
  const cert: Doc<"certificates"> | null = await ctx.runMutation(
    internal.certificateUse.authorize,
    claim,
  );
  if (!cert?.envelope) throw new Error("CERTIFICATE_UNAVAILABLE");
  let material: ReturnType<typeof decryptCertificate> | undefined;
  let completionAttempted = false;
  try {
    material = decryptCertificate(
      currentCertificateKeyring(),
      { ...cert, id: cert._id },
      cert.envelope,
    );
    const result = await use(material);
    completionAttempted = true;
    const current: boolean = await ctx.runMutation(internal.certificateUse.complete, {
      ...claim,
      result: "success",
    });
    if (!current) throw new Error("CERTIFICATE_CHANGED");
    return result;
  } catch (error) {
    if (!completionAttempted)
      await ctx.runMutation(internal.certificateUse.complete, { ...claim, result: "failed" });
    throw error;
  } finally {
    material?.dispose();
  }
}

/**
 * The vault refused the attempt, so the request was never made (#421). `code` is the pause code
 * of the operation or, with `defer`, the code it waits with until `defer.until`. `cut` is the
 * vault's reading of the Freecorps cut, made with the reading that decided the code (#601).
 */
export class RefusedBeforeSend extends Error {
  readonly code: string;
  readonly defer: { until: number; audit: Infer<typeof deferralAudit> } | undefined;
  readonly cut: boolean | undefined;
  constructor(code: string, defer?: RefusedBeforeSend["defer"], cut?: boolean) {
    super(code);
    this.name = "RefusedBeforeSend";
    this.code = code;
    this.defer = defer;
    this.cut = cut;
  }
}

/**
 * One mTLS request with the pinned certificate of the claimed operation. It throws
 * `RefusedBeforeSend` only from the lines below that run before `decryptCertificate` and
 * `certificateRequest`, the single network call, so that error proves nothing left; any other
 * error may come after the request and proves nothing.
 */
export async function transportWithCertificate(
  ctx: Pick<ActionCtx, "runMutation">,
  claim: Claim,
  target: TransportTarget,
) {
  const decision = await ctx.runMutation(internal.certificateUse.authorizeTransport, claim);
  if ("refused" in decision)
    throw new RefusedBeforeSend(decision.refused, decision.defer, decision.cut);
  const cert: Doc<"certificates"> = decision.certificate;
  if (!cert.envelope) throw new RefusedBeforeSend("CERTIFICATE_UNAVAILABLE");
  let material: ReturnType<typeof decryptCertificate> | undefined;
  let completionAttempted = false;
  try {
    material = decryptCertificate(
      currentCertificateKeyring(),
      { ...cert, id: cert._id },
      cert.envelope,
    );
    const response = await certificateRequest(target, material);
    completionAttempted = true;
    const current: boolean = await ctx.runMutation(internal.certificateUse.complete, {
      ...claim,
      result: "success",
    });
    if (!current) {
      response.body.fill(0);
      throw new Error("CERTIFICATE_CHANGED");
    }
    return response;
  } catch (error) {
    if (!completionAttempted)
      await ctx.runMutation(internal.certificateUse.complete, { ...claim, result: "failed" });
    throw error;
  } finally {
    material?.dispose();
  }
}
