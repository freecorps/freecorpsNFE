import { defineTable } from "convex/server";
import { v } from "convex/values";
import { scopeFields } from "./operationValues";
import { issuanceTaker } from "./issuanceValues";
import {
  stripeCharge,
  stripeConnectionConfig,
  stripeEventState,
  stripeRefundAction,
  stripeReversal,
} from "./stripeValues";

export const stripeTables = {
  /**
   * One Stripe webhook endpoint of a project, for one company and environment (ADR 0006). The
   * epochs pin the grant in force when it was created or last saved: a revoked grant or project
   * stops it, and a new grant does not bring it back until someone with access saves it again.
   */
  stripeConnections: defineTable({
    ...scopeFields,
    name: v.string(),
    active: v.boolean(),
    config: stripeConnectionConfig,
    /** `whsec_…` of the Stripe endpoint, encrypted (context `stripe:{id}`); empty until set. */
    secret: v.string(),
    secretSetAt: v.optional(v.number()),
    projectEpoch: v.number(),
    grantEpoch: v.number(),
    lastEventAt: v.optional(v.number()),
    lastFailureAt: v.optional(v.number()),
    lastFailureCode: v.optional(v.string()),
    version: v.number(),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_projectId_and_companyId_and_environment", ["projectId", "companyId", "environment"])
    .index("by_companyId_and_environment", ["companyId", "environment"])
    .index("by_organizationId", ["organizationId"]),
  /**
   * One row per Stripe event received with a valid signature, deduplicated by the Stripe event id.
   * Holds what Stripe said about the customer (personal data: retention `closure`).
   */
  stripeEvents: defineTable({
    ...scopeFields,
    connectionId: v.id("stripeConnections"),
    stripeEventId: v.string(),
    type: v.string(),
    livemode: v.boolean(),
    state: stripeEventState,
    /** Why it was ignored or failed, or what the refund did; a code, never free text. */
    code: v.optional(v.string()),
    charge: v.optional(stripeCharge),
    /** `in_…`/`cs_…` of the charge, also on the refund rows once matched. */
    chargeId: v.optional(v.string()),
    paymentIntentId: v.optional(v.string()),
    reversal: v.optional(stripeReversal),
    /** Fields still missing for an issuance (`pending_data`). */
    missing: v.optional(v.array(v.string())),
    /** Taker completed by a person in the console; wins over what Stripe sent. */
    taker: v.optional(issuanceTaker),
    completedBy: v.optional(v.string()),
    issuanceId: v.optional(v.id("issuances")),
    /**
     * New issuance after a rejected one: the idempotency key becomes `stripe:{id}:{attempt}`,
     * because a rejection spent the DPS number and the corrected request differs.
     */
    attempt: v.optional(v.number()),
    /** On the charge row: what a full refund or lost dispute did to its NFS-e. */
    refundAction: v.optional(stripeRefundAction),
    refundEventId: v.optional(v.id("stripeEvents")),
    receivedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_connectionId_and_stripeEventId", ["connectionId", "stripeEventId"])
    .index("by_connectionId_and_chargeId", ["connectionId", "chargeId"])
    .index("by_connectionId_and_paymentIntentId", ["connectionId", "paymentIntentId"])
    .index("by_connectionId_and_receivedAt", ["connectionId", "receivedAt"])
    .index("by_connectionId_and_state_and_receivedAt", ["connectionId", "state", "receivedAt"])
    .index("by_issuanceId", ["issuanceId"])
    .index("by_organizationId", ["organizationId"]),
};
