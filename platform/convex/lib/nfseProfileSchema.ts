import { defineTable } from "convex/server";
import { v } from "convex/values";
import { nfseProfileFields } from "./nfseProfileValues";

export const nfseProfileTables = {
  // One row per company. Every change bumps `version` and writes companyAudit; the activity list
  // is capped (MAX_ACTIVITIES), so it stays inside the row.
  nfseProfiles: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    ...nfseProfileFields,
    version: v.number(),
    updatedBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_companyId", ["companyId"]),
};
