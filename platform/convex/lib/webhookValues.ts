import { v } from "convex/values";
const subscribable = [
  v.literal("document.received"),
  v.literal("document.updated"),
  v.literal("document.event_received"),
  v.literal("import.completed"),
  v.literal("connection.attention_required"),
  v.literal("connection.release_withdrawn"),
  v.literal("connection.history_limited"),
  v.literal("issuance.authorized"),
  v.literal("issuance.rejected"),
  v.literal("issuance.cancelled"),
  v.literal("issuance.cancellation_rejected"),
] as const;
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
