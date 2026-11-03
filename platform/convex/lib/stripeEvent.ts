import { hojeBrasilia } from "@freecorps/fiscal-nfse/pure";
import type { IssuanceInput } from "./issuanceValues";
import { FOREIGN_CURRENCIES } from "./issuanceValues";
import { takerDocumentOf } from "./nfseProfileRules";
import { splitStreet } from "./stripeAddress";
import {
  SIGNATURE_TOLERANCE_S,
  type StripeCharge,
  type StripeConnectionConfig,
  type StripeCustomer,
  type StripeEventType,
  type StripeReversal,
  STRIPE_EVENT_TYPES,
} from "./stripeValues";

/**
 * Pure side of the Stripe connection (ADR 0006): the `Stripe-Signature` check, the reading of
 * the event body and the issuance request built from a paid charge. No database, no network.
 */

const encoder = new TextEncoder();
function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Stripe signs `{t}.{body}` with HMAC SHA-256 and the endpoint secret. The header may carry
 * several `v1` (during a secret roll on the Stripe side); any match passes. `now` in seconds.
 */
export async function verifyStripeSignature(
  body: string,
  header: string | null,
  secret: string,
  now: number,
): Promise<"ok" | "SIGNATURE_MISSING" | "SIGNATURE_INVALID" | "SIGNATURE_EXPIRED"> {
  if (!header || header.length > 2048) return "SIGNATURE_MISSING";
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [name, value] = part.split("=", 2).map((s) => s.trim());
    if (name === "t" && value) timestamp = value;
    if (name === "v1" && value && /^[a-f0-9]{64}$/.test(value)) signatures.push(value);
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signatures.length) return "SIGNATURE_MISSING";
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = hex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)),
  );
  if (!signatures.some((s) => sameText(s, expected))) return "SIGNATURE_INVALID";
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_TOLERANCE_S) return "SIGNATURE_EXPIRED";
  return "ok";
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
const str = (value: unknown, max = 500): string | undefined => {
  if (typeof value !== "string") return undefined;
  // Control characters never reach a DPS; collapse whitespace like the issuance does.
  const text = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, max) : undefined;
};
const int = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
/** `id` of an expandable Stripe field: the string itself or the expanded object's id. */
const ref = (value: unknown) => str(value, 255) ?? str(obj(value)?.id, 255);

export interface StripeEnvelope {
  id: string;
  type: StripeEventType;
  livemode: boolean;
  created: number;
  object: Json;
}
/** The event when the type is one the connection handles; `null` for any other type. */
export function readEnvelope(body: string): StripeEnvelope | null | "INVALID" {
  let event: Json | undefined;
  try {
    event = obj(JSON.parse(body));
  } catch {
    return "INVALID";
  }
  const id = str(event?.id, 255);
  const type = str(event?.type, 100);
  const object = obj(obj(event?.data)?.object);
  const created = int(event?.created);
  if (!event || !id || !id.startsWith("evt_") || !type || !object || created === undefined)
    return "INVALID";
  if (!(STRIPE_EVENT_TYPES as readonly string[]).includes(type)) return null;
  return { id, type: type as StripeEventType, livemode: event.livemode === true, created, object };
}

/** Stripe minor units to exact decimal text. Only 2-decimal currencies are accepted later. */
export function minorToDecimal(minor: number) {
  const digits = String(minor).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function customerOf(details: Json | undefined, address: Json | undefined, taxIds: unknown) {
  const ids = Array.isArray(taxIds)
    ? taxIds
        .map(obj)
        .map((t) => ({ type: str(t?.type, 40), value: str(t?.value, 60) }))
        .filter((t): t is { type: string; value: string } => !!t.type && !!t.value)
        .slice(0, 10)
    : [];
  const customer: StripeCustomer = { taxIds: ids };
  const set = (key: Exclude<keyof StripeCustomer, "taxIds">, value: string | undefined) => {
    if (value) customer[key] = value;
  };
  set("name", str(details?.name, 300));
  set("email", str(details?.email, 254));
  set("country", str(address?.country, 2)?.toUpperCase());
  set("state", str(address?.state, 60));
  set("city", str(address?.city, 60));
  set("postalCode", str(address?.postal_code, 20));
  set("line1", str(address?.line1, 255));
  set("line2", str(address?.line2, 255));
  return customer;
}

export type ChargeReading =
  | { kind: "charge"; charge: StripeCharge }
  | { kind: "reversal"; reversal: StripeReversal }
  | { kind: "ignored"; code: string };

/**
 * What a handled event means. `invoice.paid` covers subscriptions (first payment and renewals);
 * a Checkout Session counts only in `payment` mode, because a subscription checkout also
 * produces an `invoice.paid`, and only once paid (async methods pay later).
 */
export function readCharge(event: StripeEnvelope): ChargeReading {
  const o = event.object;
  if (event.type === "invoice.paid") {
    const id = str(o.id, 255);
    const amount = int(o.amount_paid);
    if (!id || !id.startsWith("in_") || amount === undefined)
      return { kind: "ignored", code: "EVENT_MALFORMED" };
    if (amount <= 0) return { kind: "ignored", code: "ZERO_AMOUNT" };
    const lines = obj(o.lines)?.data;
    // API versions before 2025-03-31 carry `payment_intent`; later ones list `payments`.
    const payment = Array.isArray(obj(o.payments)?.data)
      ? obj(obj((obj(o.payments)!.data as unknown[])[0])?.payment)
      : undefined;
    const paymentIntentId = ref(o.payment_intent) ?? ref(payment?.payment_intent);
    const paidAt = int(obj(o.status_transitions)?.paid_at) ?? event.created;
    const reference = str(o.number, 100);
    return {
      kind: "charge",
      charge: {
        kind: "invoice",
        id,
        ...(reference ? { reference } : {}),
        ...(paymentIntentId ? { paymentIntentId } : {}),
        currency: (str(o.currency, 3) ?? "").toUpperCase(),
        amount: minorToDecimal(amount),
        paidAt: paidAt * 1000,
        items: Array.isArray(lines)
          ? lines
              .map((line) => str(obj(line)?.description, 300))
              .filter((d): d is string => !!d)
              .slice(0, 20)
          : [],
        customer: customerOf(
          { name: o.customer_name, email: o.customer_email },
          obj(o.customer_address),
          o.customer_tax_ids,
        ),
      },
    };
  }
  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const id = str(o.id, 255);
    const amount = int(o.amount_total);
    if (!id || !id.startsWith("cs_") || amount === undefined)
      return { kind: "ignored", code: "EVENT_MALFORMED" };
    if (o.mode !== "payment") return { kind: "ignored", code: "CHECKOUT_NOT_PAYMENT" };
    if (o.payment_status !== "paid") return { kind: "ignored", code: "NOT_PAID" };
    if (amount <= 0) return { kind: "ignored", code: "ZERO_AMOUNT" };
    const details = obj(o.customer_details);
    const paymentIntentId = ref(o.payment_intent);
    return {
      kind: "charge",
      charge: {
        kind: "checkout",
        id,
        ...(paymentIntentId ? { paymentIntentId } : {}),
        currency: (str(o.currency, 3) ?? "").toUpperCase(),
        amount: minorToDecimal(amount),
        paidAt: event.created * 1000,
        items: [],
        customer: customerOf(details, obj(details?.address), details?.tax_ids),
      },
    };
  }
  if (event.type === "charge.refunded") {
    const id = str(o.id, 255);
    const amount = int(o.amount);
    const refunded = int(o.amount_refunded);
    if (!id || amount === undefined || refunded === undefined)
      return { kind: "ignored", code: "EVENT_MALFORMED" };
    const paymentIntentId = ref(o.payment_intent);
    return {
      kind: "reversal",
      reversal: {
        kind: "refund",
        id,
        ...(paymentIntentId ? { paymentIntentId } : {}),
        total: o.refunded === true || refunded >= amount,
      },
    };
  }
  // charge.dispute.closed
  const id = str(o.id, 255);
  if (!id) return { kind: "ignored", code: "EVENT_MALFORMED" };
  const paymentIntentId = ref(o.payment_intent);
  return {
    kind: "reversal",
    reversal: {
      kind: "dispute",
      id,
      ...(paymentIntentId ? { paymentIntentId } : {}),
      total: o.status === "lost",
    },
  };
}

export type IssuancePlan =
  | { kind: "ignored"; code: string }
  | { kind: "failed"; code: string }
  | { kind: "pending"; market: "domestic" | "export"; missing: string[] }
  | { kind: "ready"; input: IssuanceInput };

/** The market of a charge under the connection's configuration, or why it does not apply. */
export function marketOf(config: StripeConnectionConfig, customer: StripeCustomer) {
  const country = customer.country;
  if (config.market === "domestic")
    return country && country !== "BR" ? ("OUT_OF_MARKET" as const) : ("domestic" as const);
  if (config.market === "export") {
    if (country === "BR") return "OUT_OF_MARKET" as const;
    return "export" as const;
  }
  if (!country) return "COUNTRY_MISSING" as const;
  return country === "BR" ? ("domestic" as const) : ("export" as const);
}

export function describe(template: string, charge: StripeCharge, competence: string) {
  const [year, month] = competence.split("-");
  const text = template
    .replaceAll("{itens}", charge.items.join("; ") || "Serviço")
    .replaceAll("{cobranca}", charge.reference ?? charge.id)
    .replaceAll("{periodo}", `${month}/${year}`)
    .replace(/\s+/g, " ")
    .trim();
  return (text || "Serviço").slice(0, 2000);
}

/**
 * Issuance request for a paid charge, or what keeps it from one. `municipalityCode` is the IBGE
 * code the caller found for the customer's city and state (domestic only). `taker`, when a person
 * completed the data in the console, replaces what came from Stripe.
 */
export function planIssuance(args: {
  config: StripeConnectionConfig;
  charge: StripeCharge;
  municipalityCode?: string;
  taker?: IssuanceInput["taker"];
}): IssuancePlan {
  const { config, charge } = args;
  const c = charge.customer;
  const market = args.taker
    ? args.taker.kind === "national"
      ? "domestic"
      : "export"
    : marketOf(config, c);
  if (market === "OUT_OF_MARKET") return { kind: "ignored", code: "OUT_OF_MARKET" };
  if (market === "COUNTRY_MISSING")
    return { kind: "pending", market: "export", missing: ["country"] };
  const activityCode =
    market === "domestic" ? config.domesticActivityCode : config.exportActivityCode;
  if (!activityCode) return { kind: "failed", code: "STRIPE_ACTIVITY_MISSING" };
  if (
    market === "domestic"
      ? charge.currency !== "BRL"
      : !(FOREIGN_CURRENCIES as readonly string[]).includes(charge.currency)
  )
    return { kind: "failed", code: "STRIPE_CURRENCY_UNSUPPORTED" };
  let taker = args.taker;
  if (!taker) {
    const missing: string[] = [];
    if (!c.name) missing.push("name");
    if (!c.line1) missing.push("street");
    if (!c.postalCode) missing.push("postalCode");
    const { street, number } = splitStreet(c.line1 ?? "", "S/N");
    if (market === "domestic") {
      const document = c.taxIds.find((t) => t.type === "br_cpf" || t.type === "br_cnpj");
      if (!document) missing.push("document");
      if (!args.municipalityCode) missing.push("municipality");
      if (missing.length) return { kind: "pending", market, missing };
      taker = {
        kind: "national",
        // Stripe keeps the tax id as typed; the issuance takes it without mask and in upper case.
        document: takerDocumentOf(document!.value),
        name: c.name!,
        ...(c.email ? { email: c.email } : {}),
        address: {
          municipalityCode: args.municipalityCode!,
          postalCode: c.postalCode!,
          street,
          number,
          district: (c.line2 ?? "Não informado").slice(0, 60),
        },
      };
    } else {
      if (!c.country) missing.push("country");
      if (!c.city) missing.push("city");
      const nif = c.taxIds.find((t) => !t.type.startsWith("br_"))?.value;
      if (!nif && config.foreignWithoutNif === "hold") missing.push("nif");
      if (missing.length) return { kind: "pending", market, missing };
      taker = {
        kind: "foreign",
        ...(nif ? { nif } : { nifAbsence: 2 as const }),
        name: c.name!,
        ...(c.email ? { email: c.email } : {}),
        address: {
          country: c.country!,
          city: c.city!,
          postalCode: c.postalCode!.slice(0, 11),
          state: (c.state ?? "N/A").slice(0, 60),
          street,
          number,
          district: (c.line2 ?? "N/A").slice(0, 60),
        },
      };
    }
  }
  const competence = hojeBrasilia(new Date(charge.paidAt)).slice(0, 7);
  return {
    kind: "ready",
    input: {
      activityCode,
      competence,
      market,
      taker,
      description: describe(config.description, charge, competence),
      amount: { currency: charge.currency, value: charge.amount },
      ...(market === "domestic" && config.issRate ? { issRate: config.issRate } : {}),
      issWithheld: false,
    },
  };
}
