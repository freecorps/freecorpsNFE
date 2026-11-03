import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requirePlatformEnvironment } from "./environment";
import { verifyStripeSignature } from "./lib/stripeEvent";
import { MAX_EVENT_BYTES } from "./lib/stripeValues";
import { billingConfig, readBillingEnvelope } from "./lib/billingStripe";

/**
 * `POST /v1/billing/stripe/events`: Freecorps' own Stripe account, for the subscriptions of the
 * platform plans (#556). Not the per-project connection of ADR 0006. The signature is the proof;
 * the event only says whom to reconcile, and the reconciliation reads Stripe again. Once
 * recorded the answer is 200, so a resend changes nothing; 5xx only when nothing was recorded.
 */
const answer = (status: number, code: string) =>
  Response.json({ code }, { status, headers: { "Cache-Control": "no-store" } });

export const route = httpAction(async (ctx, request) => {
  const { installation } = requirePlatformEnvironment();
  const config = billingConfig(installation);
  if (!config) return answer(404, "NOT_FOUND");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_EVENT_BYTES) return answer(413, "EVENT_TOO_LARGE");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_EVENT_BYTES)
    return answer(413, "EVENT_TOO_LARGE");
  const signature = await verifyStripeSignature(
    body,
    request.headers.get("stripe-signature"),
    config.webhookSecret,
    Math.floor(Date.now() / 1000),
  );
  if (signature !== "ok") return answer(400, signature);
  const event = readBillingEnvelope(body);
  if (event === "INVALID") return answer(400, "EVENT_INVALID");
  if (event === null) return answer(200, "EVENT_NOT_HANDLED");
  await ctx.runMutation(internal.billing.recordEvent, {
    stripeEventId: event.id,
    type: event.type,
    livemode: event.livemode,
    objectId: event.objectId,
    ...(event.customerId ? { customerId: event.customerId } : {}),
    ...(event.chargeId ? { chargeId: event.chargeId } : {}),
    ...(event.amountCents !== undefined ? { amountCents: event.amountCents } : {}),
    ...(event.review ? { review: event.review } : {}),
    // A test event never touches live billing, nor the reverse.
    modeMatches: event.livemode === config.livemode,
  });
  return answer(200, "RECEIVED");
});
