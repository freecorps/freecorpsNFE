"use node";
import { v } from "convex/values";
import { parseNfe, processNfe } from "@freecorps/fiscal-nfe";
import { internalAction } from "./_generated/server";
import { requirePlatformEnvironment } from "./environment";

// B00 proof only. The upload, authorization and persistence boundary comes in B04.
export const extract = internalAction({
  args: { xml: v.string() },
  returns: v.object({ json: v.string(), runtime: v.string() }),
  handler: async (_ctx, { xml }) => {
    requirePlatformEnvironment();
    return { json: JSON.stringify(parseNfe(xml)), runtime: process.version };
  },
});

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
