/** Public webhook wire contract. No Convex, network or queue dependencies. */
export declare const webhookEvents: readonly ["document.received", "document.updated", "document.event_received", "import.completed", "connection.attention_required", "connection.release_withdrawn", "connection.history_limited", "issuance.authorized", "issuance.rejected", "issuance.cancelled", "issuance.cancellation_rejected"];
export type WebhookEventType = (typeof webhookEvents)[number];
export type WebhookResourceType = "document" | "import" | "endpoint" | "connection" | "issuance";
/** Resource carried by each event type; the receiver reads it back through the API. */
export declare function webhookResourceType(type: WebhookEventType | "webhook.test"): WebhookResourceType;
/** Integration scope the endpoint's project (and key) needs to subscribe to the event. */
export declare function webhookEventScope(type: WebhookEventType): "documents:read" | "connections:read" | "documents:cancel" | "documents:issue" | "documents:import";
export declare const webhookContractVersion: "1";
export declare const webhookToleranceMs = 300000;
/**
 * The fact `connection.history_limited` carries (#442): the NSU range the organization's Owner
 * accepted as lost in the console, and the role that decided. The range is not readable anywhere
 * else in the API, and it never changes, so it travels in the event. No person, no reason: the
 * reason is free text that stays in the console's audit.
 */
export interface HistoryLimitedData {
    lost: {
        from: string;
        to: string;
    };
    decidedBy: "owner";
}
export declare const HISTORY_LIMITED_EVENT = "connection.history_limited";
export interface WebhookEnvelope {
    eventId: string;
    type: WebhookEventType | "webhook.test";
    version: "1";
    occurredAt: number;
    environment: "sandbox" | "production";
    companyId: string;
    resource: {
        type: WebhookResourceType;
        id: string;
        /**
         * The first ID of a resource that came back from the cold archive under a new ID (ADR 0009,
         * §6); absent otherwise. A receiver that deduplicates by ID recognizes the resource by it.
         */
        originalId?: string;
        version: number;
    };
    synthetic: boolean;
    /** Only in `connection.history_limited`; every other event has identifiers only. */
    data?: HistoryLimitedData;
}
export interface WebhookHeaders {
    "x-fnfe-event-id": string;
    "x-fnfe-delivery-id": string;
    "x-fnfe-resource-version": string;
    "x-fnfe-webhook-version": string;
    "x-fnfe-signature": string;
}
export interface WebhookSecret {
    version: number;
    secret: string;
    validUntil?: number;
}
export type WebhookVerification = {
    ok: true;
    event: WebhookEnvelope;
    deliveryId: string;
    secretVersion: number;
} | {
    ok: false;
    code: "HEADERS_INVALID" | "TIMESTAMP_INVALID" | "SIGNATURE_INVALID" | "BODY_INVALID";
};
export declare function signWebhook(body: Uint8Array, headers: Omit<WebhookHeaders, "x-fnfe-signature">, secrets: WebhookSecret[], timestamp: number): Promise<WebhookHeaders>;
export declare function verifyWebhook(input: {
    body: Uint8Array;
    headers: Record<string, string | undefined>;
    secrets: WebhookSecret[];
    now: number;
    toleranceMs?: number;
}): Promise<WebhookVerification>;
