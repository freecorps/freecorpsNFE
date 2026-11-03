"use node";
import { createHash, randomBytes } from "node:crypto";
import { v, jsonToConvex } from "convex/values";
import { internalAction, env } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  certificateKeyring,
  currentCertificateKeyring,
  decryptCertificate,
  rewrapCertificate,
} from "../lib/certificateCrypto";
import { validateCertificate } from "../lib/certificateValidation";
import { requireLocalProof } from "./operationProof";
export const environmentVersions = internalAction({
  args: {},
  returns: v.object({ generated: v.array(v.string()), current: v.array(v.string()) }),
  handler: async () => {
    requireLocalProof();
    return {
      generated: Object.keys(certificateKeyring(env.FNFE_PLATFORM_CERT_KEYS).keys),
      current: Object.keys(certificateKeyring(process.env.FNFE_PLATFORM_CERT_KEYS).keys),
    };
  },
});

export const verify = internalAction({
  args: { organizationId: v.id("organizations") },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const snapshot = jsonToConvex(
      JSON.parse(await ctx.runQuery(internal.testing.restoreProof.inspect, args)),
    ) as { certificates: Doc<"certificates">[] };
    const ring = currentCertificateKeyring();
    const receipts = [];
    for (const cert of snapshot.certificates) {
      if (cert.uploaderId !== "synthetic-restore81" || !cert.envelope || !cert.metadata)
        throw new Error("RESTORE_PROOF_SCOPE");
      const context = {
        organizationId: cert.organizationId,
        companyId: cert.companyId,
        id: cert._id,
        version: cert.version,
      };
      if (!ring.keys[cert.envelope.keyVersion])
        throw new Error(
          `CERTIFICATE_KEY_UNAVAILABLE:${cert.envelope.keyVersion}:${Object.keys(ring.keys).join(",")}`,
        );
      const material = decryptCertificate(ring, context, cert.envelope);
      try {
        const metadata = validateCertificate(material.pfx, material.password, cert.metadata.cnpj);
        if (metadata.fingerprint !== cert.metadata.fingerprint)
          throw new Error("RESTORE_FINGERPRINT_MISMATCH");
        const pfxSha256 = createHash("sha256").update(material.pfx).digest("hex");
        const failures: Record<string, string> = {};
        const wrong = {
          ...ring,
          keys: { ...ring.keys, [cert.envelope.keyVersion]: randomBytes(32).toString("hex") },
        };
        for (const [scenario, invoke] of [
          [
            "missing-key",
            () => decryptCertificate({ active: "missing", keys: {} }, context, cert.envelope!),
          ],
          ["wrong-key", () => decryptCertificate(wrong, context, cert.envelope!)],
          [
            "wrong-version",
            () => decryptCertificate(ring, context, { ...cert.envelope!, keyVersion: "missing" }),
          ],
          [
            "wrong-context",
            () =>
              decryptCertificate(ring, { ...context, companyId: "other-company" }, cert.envelope!),
          ],
        ] as const) {
          try {
            invoke().dispose();
            throw new Error("NEGATIVE_CASE_ACCEPTED");
          } catch (error) {
            if (error instanceof Error && error.message === "NEGATIVE_CASE_ACCEPTED") throw error;
            failures[scenario] =
              scenario === "missing-key" || scenario === "wrong-version"
                ? "CERTIFICATE_KEY_UNAVAILABLE"
                : "AUTHENTICATION_REJECTED";
          }
        }
        const rotated = {
          active: "recovery",
          keys: { ...ring.keys, recovery: randomBytes(32).toString("hex") },
        };
        const rewrapped = rewrapCertificate(rotated, context, cert.envelope);
        const reopened = decryptCertificate(
          { active: "recovery", keys: { recovery: rotated.keys.recovery } },
          context,
          rewrapped,
        );
        try {
          if (!reopened.pfx.equals(material.pfx) || !reopened.password.equals(material.password))
            throw new Error("RESTORE_ROTATION_MISMATCH");
        } finally {
          reopened.dispose();
        }
        receipts.push({
          id: cert._id,
          version: cert.version,
          state: cert.state,
          keyVersion: cert.envelope.keyVersion,
          fingerprint: metadata.fingerprint,
          pfxSha256,
          rotation: "preserved",
          failures,
        });
      } finally {
        material.dispose();
      }
    }
    if (receipts.length !== 2) throw new Error("RESTORE_CERTIFICATES_MISSING");
    return JSON.stringify({ runtime: process.version, certificates: receipts });
  },
});
