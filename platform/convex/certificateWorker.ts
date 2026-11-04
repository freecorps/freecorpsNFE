"use node";
import { v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { certificateScope, MAX_PASSWORD_BYTES, MAX_PFX_BYTES } from "./lib/certificateValues";
import {
  currentCertificateKeyring,
  encryptCertificate,
  decryptCertificate,
  rewrapCertificate,
} from "./lib/certificateCrypto";
import { validateCertificate } from "./lib/certificateValidation";
import { deny } from "./lib/organizationAccess";

// freecorps-access: delegada — certificates.reserve confere com requireCompany antes de reservar
export const upload = action({
  args: { ...certificateScope, pfx: v.bytes(), password: v.string() },
  returns: v.id("certificates"),
  handler: async (ctx, args): Promise<Id<"certificates">> => {
    const reserved: { id: Id<"certificates">; version: number } = await ctx.runMutation(
      internal.certificates.reserve,
      {
        organizationId: args.organizationId,
        companyId: args.companyId,
      },
    );
    const pfx = Buffer.from(args.pfx),
      password = Buffer.from(args.password);
    const invalidSize =
      !pfx.length || pfx.length > MAX_PFX_BYTES || password.length > MAX_PASSWORD_BYTES;
    try {
      if (invalidSize) return deny("CERTIFICATE_SIZE");
      const encrypted = encryptCertificate(
        currentCertificateKeyring(),
        { ...args, ...reserved },
        pfx,
        password,
      );
      await ctx.runMutation(internal.certificates.save, { id: reserved.id, envelope: encrypted });
      return reserved.id;
    } catch (error) {
      const code = invalidSize
        ? "CERTIFICATE_SIZE"
        : error instanceof Error && error.message === "CERTIFICATE_KEY_UNAVAILABLE"
          ? "CERTIFICATE_KEY_UNAVAILABLE"
          : "CERTIFICATE_UPLOAD_FAILED";
      await ctx.runMutation(internal.certificates.abandon, { id: reserved.id, code });
      return deny(code);
    } finally {
      pfx.fill(0);
      password.fill(0);
    }
  },
});
export const validate = internalAction({
  args: { id: v.id("certificates") },
  returns: v.null(),
  handler: validatePendingCertificate,
});

export async function validatePendingCertificate(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  args: { id: Id<"certificates"> },
) {
  const cert: Doc<"certificates"> | null = await ctx.runQuery(
    internal.certificates.encrypted,
    args,
  );
  if (!cert?.envelope || cert.state !== "validating") return null;
  const cnpj: string | null = await ctx.runQuery(internal.certificates.validationCompany, {
    companyId: cert.companyId,
  });
  let material: ReturnType<typeof decryptCertificate> | undefined;
  let outcome: { metadata: ReturnType<typeof validateCertificate> } | { code: string };
  try {
    material = decryptCertificate(
      currentCertificateKeyring(),
      { ...cert, id: cert._id },
      cert.envelope,
    );
    const metadata = validateCertificate(material.pfx, material.password, cnpj ?? "");
    outcome = { metadata };
  } catch (error) {
    const code =
      error instanceof Error && /^CERTIFICATE_[A-Z_]+$/.test(error.message)
        ? error.message
        : "CERTIFICATE_INVALID";
    outcome = { code };
  } finally {
    material?.dispose();
  }
  // Persistence failures must not reclassify a valid PFX as invalid.
  await ctx.runMutation(internal.certificates.finish, { id: cert._id, ...outcome });
  return null;
}
// freecorps-access: delegada — certificates.authorizeRewrap confere com requireCompany
export const rewrap = action({
  args: { ...certificateScope, id: v.id("certificates") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const cert: Doc<"certificates"> = await ctx.runQuery(
      internal.certificates.authorizeRewrap,
      args,
    );
    try {
      const envelope = rewrapCertificate(
        currentCertificateKeyring(),
        { ...cert, id: cert._id },
        cert.envelope!,
      );
      await ctx.runMutation(internal.certificates.saveRewrap, {
        id: cert._id,
        revision: cert.envelopeRevision,
        envelope,
      });
    } catch {
      return deny("CERTIFICATE_ROTATION_FAILED");
    }
    return null;
  },
});
