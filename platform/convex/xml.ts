"use node";
import { v } from "convex/values";
import { processNfe } from "@freecorps/fiscal-nfe";
import { internalAction } from "./_generated/server";
import { requirePlatformEnvironment } from "./environment";

// Internal runtime proof; ingestion, storage and access checks belong to the import domain.
export const validate = internalAction({
  args: { bytes: v.bytes(), evaluatedAt: v.string() },
  returns: v.object({ json: v.string(), runtime: v.string() }),
  handler: async (_ctx, { bytes, evaluatedAt }) => {
    requirePlatformEnvironment();
    return {
      json: JSON.stringify(processNfe(new Uint8Array(bytes), { source: "synthetic", evaluatedAt })),
      runtime: process.version,
    };
  },
});
