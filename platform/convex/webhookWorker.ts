"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { signWebhook, type WebhookSecret } from "@freecorps/contracts";
import { decryptSecret } from "./lib/webhookSecrets";
import { postWebhook, WebhookNetworkError } from "./lib/webhookNetwork";
export const run = internalAction({
  args: { deliveryId: v.id("webhookDeliveries"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.runMutation(internal.webhookDelivery.claim, args);
    if (!claim) return null;
    const start = Date.now();
    let signed = false;
    try {
      const e = claim.endpoint;
      const secrets: WebhookSecret[] = [
        {
          version: e.secretVersion,
          secret: await decryptSecret(e.secret, `${e._id}:${e.secretVersion}`),
        },
      ];
      if (e.previousSecret && e.previousVersion && (e.previousUntil ?? 0) > Date.now())
        secrets.push({
          version: e.previousVersion,
          secret: await decryptSecret(e.previousSecret, `${e._id}:${e.previousVersion}`),
          validUntil: e.previousUntil!,
        });
      const headers = await signWebhook(
        new TextEncoder().encode(claim.event.body),
        {
          "x-fnfe-event-id": claim.event.eventId,
          "x-fnfe-delivery-id": claim.deliveryId,
          "x-fnfe-resource-version": String(claim.event.resourceVersion),
          "x-fnfe-webhook-version": "1",
        },
        secrets,
        Date.now(),
      );
      signed = true;
      if (
        !(await ctx.runQuery(internal.webhookDelivery.canSend, {
          ...args,
          endpointVersion: e.version,
          now: Date.now(),
        }))
      )
        return null;
      const response = await postWebhook(e.url, claim.event.body, { ...headers });
      await ctx.runMutation(internal.webhookDelivery.outcome, {
        ...args,
        status: response.status,
        ...(response.retryAt ? { retryAt: response.retryAt } : {}),
        durationMs: Date.now() - start,
        code: "HTTP_RESPONSE",
      });
    } catch (error) {
      await ctx.runMutation(internal.webhookDelivery.outcome, {
        ...args,
        durationMs: Date.now() - start,
        code:
          error instanceof WebhookNetworkError
            ? error.code
            : signed
              ? "NETWORK_ERROR"
              : "SIGNING_UNAVAILABLE",
      });
    }
    return null;
  },
});
