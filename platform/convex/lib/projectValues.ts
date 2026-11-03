import { v } from "convex/values";
import { integrationScopes } from "@freecorps/contracts";

export const integrationScope = v.union(...integrationScopes.map((s) => v.literal(s)));
export const environment = v.union(v.literal("sandbox"), v.literal("production"));
export const projectState = v.union(v.literal("active"), v.literal("disabled"));
export const projectSummary = v.object({
  id: v.id("projects"),
  name: v.string(),
  externalReference: v.string(),
  state: projectState,
  version: v.number(),
  createdAt: v.number(),
});
export const keySummary = v.object({
  id: v.id("apiKeys"),
  name: v.string(),
  prefix: v.string(),
  scopes: v.array(integrationScope),
  environment,
  companyIds: v.array(v.id("companies")),
  expiresAt: v.number(),
  revokedAt: v.union(v.number(), v.null()),
  rotatedAt: v.union(v.number(), v.null()),
  projectInvalidated: v.boolean(),
  concessionsChanged: v.boolean(),
  rotationAvailable: v.boolean(),
  currentCompanyIds: v.array(v.id("companies")),
  createdAt: v.number(),
});
export const keyInput = {
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  name: v.string(),
  scopes: v.array(integrationScope),
  environment,
  companyIds: v.array(v.id("companies")),
  expiresAt: v.number(),
};
export const secretOnce = v.object({ keyId: v.id("apiKeys"), secretOnce: v.string() });
