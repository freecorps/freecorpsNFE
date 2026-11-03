import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";
import workpool from "@convex-dev/workpool/convex.config";
import { v } from "convex/values";

const app = defineApp({
  env: {
    FNFE_COLD_ARCHIVE: v.optional(v.string()),
    FNFE_CAPTURE_TRANSPORT: v.optional(v.string()),
    FNFE_FISCAL_PROOF: v.optional(v.string()),
    FNFE_PLATFORM_CERT_KEYS: v.optional(v.string()),
    FNFE_CERT_PROOF_ORIGIN: v.optional(v.string()),
    FNFE_CERT_PROOF_CA: v.optional(v.string()),
    FNFE_NFSE_SANDBOX_TRANSPORT: v.optional(v.string()),
    FNFE_NFSE_RESTRICTED_COMPANIES: v.optional(v.string()),
    FNFE_ISSUANCE_ENV: v.optional(v.string()),
    FNFE_NFSE_PRODUCTION_COMPANIES: v.optional(v.string()),
  },
});
app.use(betterAuth);
app.use(rateLimiter);
app.use(workpool, { name: "importPool" });
app.use(workpool, { name: "capturePool" });
app.use(workpool, { name: "webhookPool" });
app.use(workpool, { name: "exportPool" });
app.use(workpool, { name: "issuancePool" });
app.use(workpool, { name: "contentPool" });
export default app;
