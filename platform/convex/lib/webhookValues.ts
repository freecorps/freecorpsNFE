import { v } from "convex/values";
import { webhookEvents } from "@freecorps/contracts";
const subscribable = webhookEvents.map((event) => v.literal(event));
export const eventType = v.union(...subscribable, v.literal("webhook.test"));
export const subscriptionType = v.union(...subscribable);
export const deliveryState = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("retry_wait"),
  v.literal("delivered"),
  v.literal("failed"),
  v.literal("paused"),
);
export const MAX_ENDPOINTS = 20;
export const MAX_ATTEMPTS = 6;
export const MAX_RESENDS = 3;
export const LEASE_MS = 60_000;
export const MAX_RETRY_AFTER_MS = 86_400_000;
export const endpointInput = {
  name: v.string(),
  url: v.string(),
  events: v.array(subscriptionType),
};
