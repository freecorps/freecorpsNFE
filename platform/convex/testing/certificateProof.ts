"use node";
import { v } from "convex/values";
import { internalAction, env } from "../_generated/server";
import { envelope } from "../lib/certificateValues";
import { currentCertificateKeyring, decryptCertificate } from "../lib/certificateCrypto";
import { validateCertificate } from "../lib/certificateValidation";
import { certificateRequest } from "../lib/certificateTransport";

/** Internal, synthetic-only test boundary. It cannot select arbitrary remote hosts. */
export const run = internalAction({
  args: {
    envelope,
    context: v.object({
      organizationId: v.string(),
      companyId: v.string(),
      id: v.string(),
      version: v.number(),
    }),
    scenario: v.union(
      v.literal("ok"),
      v.literal("slow"),
      v.literal("large"),
      v.literal("redirect"),
      v.literal("host"),
      v.literal("trust"),
    ),
  },
  returns: v.object({
    runtime: v.string(),
    code: v.string(),
    fingerprint: v.optional(v.string()),
    peer: v.optional(v.string()),
  }),
  handler: async (_ctx, args) => {
    const origin = env.FNFE_CERT_PROOF_ORIGIN,
      ca = env.FNFE_CERT_PROOF_CA;
    if (
      process.env.FISCAL_ENV !== "disabled" ||
      process.env.PRODUCT_ENV !== "sandbox" ||
      !["development", "validation"].includes(process.env.APP_ENV ?? "") ||
      !origin ||
      !/^https:\/\/[a-z0-9.-]+\.pinggy-free\.link:\d+$/.test(origin) ||
      !ca ||
      args.context.organizationId !== "synthetic-77" ||
      args.context.companyId !== "synthetic-company-77"
    )
      throw new Error("CERTIFICATE_PROOF_DISABLED");
    const material = decryptCertificate(currentCertificateKeyring(), args.context, args.envelope);
    try {
      const metadata = validateCertificate(material.pfx, material.password, "00000000000191");
      const response = await certificateRequest(
        {
          url: `${origin}/${args.scenario}`,
          allowedOrigins: args.scenario === "host" ? [] : [origin],
          ca: args.scenario === "trust" ? undefined : ca,
          timeoutMs: args.scenario === "slow" ? 3000 : 15000,
          maxBytes: 1024,
        },
        material,
      );
      if (response.status !== 200) throw new Error("CERTIFICATE_PROOF_HTTP");
      const peer: unknown = JSON.parse(response.body.toString());
      if (
        !peer ||
        typeof peer !== "object" ||
        !("fingerprint" in peer) ||
        typeof peer.fingerprint !== "string" ||
        peer.fingerprint !== metadata.fingerprint
      )
        throw new Error("CERTIFICATE_PROOF_IDENTITY");
      return {
        runtime: process.version,
        code: "OK",
        fingerprint: metadata.fingerprint,
        peer: peer.fingerprint,
      };
    } catch (error) {
      return {
        runtime: process.version,
        code:
          error instanceof Error && /^CERTIFICATE_[A-Z_]+$/.test(error.message)
            ? error.message
            : "CERTIFICATE_PROOF_FAILED",
      };
    } finally {
      material.dispose();
    }
  },
});
