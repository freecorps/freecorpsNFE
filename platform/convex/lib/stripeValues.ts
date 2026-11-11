import { v, type Infer } from "convex/values";

/**
 * Stripe connection (ADR 0006): a project's Stripe webhook endpoint that turns paid charges into
 * NFS-e issuances of one company and environment. The connection is the third source of an
 * operation, beside API keys and console members; its authority is the project's grant.
 */
export const STRIPE_EVENT_TYPES = [
  "invoice.paid",
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "charge.refunded",
  "charge.dispute.closed",
] as const;
export type StripeEventType = (typeof STRIPE_EVENT_TYPES)[number];
export const MAX_CONNECTIONS = 5;
/** Stripe's own limit is 1 MB per event body; nothing a paid charge carries comes close. */
export const MAX_EVENT_BYTES = 1_000_000;
/** Seconds a `Stripe-Signature` timestamp may differ from now (Stripe's default tolerance). */
export const SIGNATURE_TOLERANCE_S = 300;
export const DEFAULT_DESCRIPTION = "{itens} — cobrança {cobranca}, competência {periodo}";

/** Who the software sells to. `both`: the country of the customer's address decides. */
export const stripeMarket = v.union(v.literal("domestic"), v.literal("export"), v.literal("both"));
/** Full refund or lost dispute of a charge that became an NFS-e. */
export const stripeRefundPolicy = v.union(v.literal("notify"), v.literal("cancel"));
/** Foreign customer without a tax id: hold for a person, or issue with `nifAbsence` 2. */
export const stripeForeignWithoutNif = v.union(v.literal("hold"), v.literal("not_required"));

export const stripeConnectionConfig = v.object({
  market: stripeMarket,
  /** `code` of an activity of the NFS-e profile, per market the connection sells to. */
  domesticActivityCode: v.optional(v.string()),
  exportActivityCode: v.optional(v.string()),
  /**
   * Text of `xDescServ`. Placeholders: `{itens}` (descriptions of the invoice lines),
   * `{cobranca}` (invoice number or Stripe id) and `{periodo}` (competence, MM/AAAA).
   */
  description: v.string(),
  /** ISS rate for domestic notes of a company outside the Simples; never sent on export. */
  issRate: v.optional(v.string()),
  invoices: v.boolean(),
  checkouts: v.boolean(),
  foreignWithoutNif: stripeForeignWithoutNif,
  refundPolicy: stripeRefundPolicy,
});
export type StripeConnectionConfig = Infer<typeof stripeConnectionConfig>;

export const stripeEventState = v.union(
  v.literal("queued"),
  v.literal("issued"),
  v.literal("pending_data"),
  v.literal("ignored"),
  v.literal("failed"),
  v.literal("refund"),
);
/** What happened to an issued charge after a full refund or lost dispute. */
export const stripeRefundAction = v.union(
  v.literal("suggested"),
  v.literal("requested"),
  v.literal("failed"),
);

export const stripeTaxId = v.object({ type: v.string(), value: v.string() });
/** Customer as Stripe saw it at payment time. Every field is optional on the Stripe side. */
export const stripeCustomer = v.object({
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  country: v.optional(v.string()),
  state: v.optional(v.string()),
  city: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  line1: v.optional(v.string()),
  line2: v.optional(v.string()),
  taxIds: v.array(stripeTaxId),
});
export type StripeCustomer = Infer<typeof stripeCustomer>;
/** A paid charge, normalized from `invoice.paid` or a paid Checkout Session. */
export const stripeCharge = v.object({
  kind: v.union(v.literal("invoice"), v.literal("checkout")),
  /** `in_…` or `cs_…`: the idempotency of the issuance. */
  id: v.string(),
  /** Invoice number shown to the customer, when Stripe gave one. */
  reference: v.optional(v.string()),
  paymentIntentId: v.optional(v.string()),
  /** ISO 4217, upper case. */
  currency: v.string(),
  /** Exact decimal text with 2 places, from Stripe's minor units. */
  amount: v.string(),
  paidAt: v.number(),
  items: v.array(v.string()),
  customer: stripeCustomer,
});
export type StripeCharge = Infer<typeof stripeCharge>;
/** Full refund or lost dispute, keyed by the payment intent of the charge. */
export const stripeReversal = v.object({
  kind: v.union(v.literal("refund"), v.literal("dispute")),
  /** `ch_…` or `dp_…`. */
  id: v.string(),
  paymentIntentId: v.optional(v.string()),
  /** False on a partial refund or a dispute not lost: recorded, never cancelled. */
  total: v.boolean(),
});
export type StripeReversal = Infer<typeof stripeReversal>;

export const connectionView = v.object({
  id: v.id("stripeConnections"),
  projectId: v.id("projects"),
  companyId: v.id("companies"),
  environment: v.union(v.literal("sandbox"), v.literal("production")),
  name: v.string(),
  active: v.boolean(),
  config: stripeConnectionConfig,
  secretSet: v.boolean(),
  secretSetAt: v.union(v.number(), v.null()),
  lastEventAt: v.union(v.number(), v.null()),
  lastFailureAt: v.union(v.number(), v.null()),
  lastFailureCode: v.union(v.string(), v.null()),
  version: v.number(),
  createdAt: v.number(),
});
