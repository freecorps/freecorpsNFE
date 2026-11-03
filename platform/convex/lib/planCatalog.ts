import { v } from "convex/values";

export const catalogTier = v.union(
  v.literal("free"),
  v.literal("intermediate"),
  v.literal("large"),
);
export const assignedTier = v.union(catalogTier, v.literal("custom"));
export const isCatalogTier = (tier: string): tier is typeof catalogTier.type =>
  tier === "free" || tier === "intermediate" || tier === "large";
export const paidTier = v.union(v.literal("intermediate"), v.literal("large"));
export const planCapacity = v.object({
  filesBytes: v.number(),
  databaseBytes: v.number(),
  companies: v.number(),
  members: v.number(),
  projects: v.number(),
  downloadsBytes: v.number(),
  exportsCount: v.number(),
  exportsBytes: v.number(),
  restReads: v.number(),
});
export type CatalogTier = typeof catalogTier.type;
const MiB = 2 ** 20;
const GiB = 2 ** 30;
/**
 * Integer cents; no shared vendor allowance is granted afresh to each customer. `annualCents` is
 * 12 months for the price of 10 (ADR 0010, decision 4.2), sold only once `annualEnabled` holds.
 */
export const PLATFORM_PLANS = {
  free: {
    name: "Gratuito",
    monthlyCents: 0,
    concurrency: 1,
    // In Production, 100 new notes a month gate imports and captures together (ADR 0010,
    // decision 10); `imports` and `captures` stay the sandbox's test quota.
    limits: {
      imports: 100,
      captures: 100,
      registry: 10,
      bytes: 64 * MiB,
      deliveries: 300,
      notes: 100,
    },
    capacity: {
      filesBytes: 128 * MiB,
      databaseBytes: 32 * MiB,
      companies: 1,
      members: 2,
      projects: 1,
      downloadsBytes: 256 * MiB,
      exportsCount: 2,
      exportsBytes: 256 * MiB,
      restReads: 2000,
    },
    custodyCents: 6000,
    monthlySubsidyCents: 1700,
  },
  intermediate: {
    name: "Intermediário",
    monthlyCents: 14900,
    annualCents: 149000,
    concurrency: 2,
    limits: { imports: 1000, captures: 1000, registry: 100, bytes: 128 * MiB, deliveries: 3000 },
    capacity: {
      filesBytes: 512 * MiB,
      databaseBytes: 64 * MiB,
      companies: 5,
      members: 5,
      projects: 3,
      downloadsBytes: GiB,
      exportsCount: 10,
      exportsBytes: GiB,
      restReads: 10000,
    },
    custodyCents: 10800,
    monthlySubsidyCents: 0,
  },
  large: {
    name: "Grande",
    monthlyCents: 49900,
    annualCents: 499000,
    concurrency: 4,
    limits: { imports: 5000, captures: 5000, registry: 500, bytes: 512 * MiB, deliveries: 15000 },
    capacity: {
      filesBytes: 2 * GiB,
      databaseBytes: 256 * MiB,
      companies: 10,
      members: 15,
      projects: 10,
      downloadsBytes: 4 * GiB,
      exportsCount: 30,
      exportsBytes: 4 * GiB,
      restReads: 50000,
    },
    custodyCents: 28000,
    monthlySubsidyCents: 0,
  },
} as const;
