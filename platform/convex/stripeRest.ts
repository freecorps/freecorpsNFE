import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requirePlatformEnvironment } from "./environment";
import { decryptSecret } from "./lib/webhookSecrets";
import { readEnvelope, readCharge, verifyStripeSignature } from "./lib/stripeEvent";
import { MAX_EVENT_BYTES } from "./lib/stripeValues";

/**
 * `POST /v1/stripe/connections/{connectionId}/events` (ADR 0006). The id only selects the
 * connection; the `Stripe-Signature` over the raw body is the proof. Once an event is recorded
 * the answer is 200, whatever it became: Stripe resending it changes nothing. 5xx only when
 * nothing was recorded, so that Stripe tries again.
 */
const answer = (status: number, code: string) =>
  Response.json({ code }, { status, headers: { "Cache-Control": "no-store" } });

export const route = httpAction(async (ctx, request) => {
  requirePlatformEnvironment();
  const match = /^\/v1\/stripe\/connections\/([^/]{1,64})\/events$/.exec(
    new URL(request.url).pathname,
  );
  if (!match) return answer(404, "NOT_FOUND");
  const target = await ctx.runQuery(internal.stripe.webhookTarget, { connectionId: match[1]! });
  if (!target) return answer(404, "NOT_FOUND");
  // Stripe is already calling, but nobody pasted the endpoint's secret yet: say so in the guide.
  if (target.secret === "") {
    await ctx.runMutation(internal.stripe.noteFailure, {
      connectionId: target.id,
      code: "SECRET_MISSING",
    });
    return answer(404, "NOT_FOUND");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_EVENT_BYTES) return answer(413, "EVENT_TOO_LARGE");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_EVENT_BYTES)
    return answer(413, "EVENT_TOO_LARGE");
  const secret = await decryptSecret(target.secret, `stripe:${target.id}`);
  const signature = await verifyStripeSignature(
    body,
    request.headers.get("stripe-signature"),
    secret,
    Math.floor(Date.now() / 1000),
  );
  if (signature !== "ok") {
    await ctx.runMutation(internal.stripe.noteFailure, {
      connectionId: target.id,
      code: signature,
    });
    return answer(400, signature);
  }
  const event = readEnvelope(body);
  if (event === "INVALID") {
    await ctx.runMutation(internal.stripe.noteFailure, {
      connectionId: target.id,
      code: "EVENT_INVALID",
    });
    return answer(400, "EVENT_INVALID");
  }
  // Types the connection does not handle are acknowledged and not stored.
  if (event === null) return answer(200, "EVENT_NOT_HANDLED");
  const recorded = await ctx.runMutation(internal.stripe.record, {
    connectionId: target.id,
    stripeEventId: event.id,
    type: event.type,
    livemode: event.livemode,
    reading: readCharge(event),
  });
  if (recorded.next)
    await ctx.runAction(internal.stripe.processEvent, {
      eventId: recorded.eventId,
      step: recorded.next,
    });
  return answer(200, "RECEIVED");
});
