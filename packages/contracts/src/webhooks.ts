// SPDX-License-Identifier: MIT
// Copyright (c) 2026 FREECORPS TECNOLOGIA DA INFORMACAO LTDA
/** Public webhook wire contract. No Convex, network or queue dependencies. */
export const webhookEvents = [
  "document.received",
  "document.updated",
  "document.event_received",
  "import.completed",
  "connection.attention_required",
  "connection.release_withdrawn",
  "connection.history_limited",
  "issuance.authorized",
  "issuance.rejected",
  "issuance.cancelled",
  "issuance.cancellation_rejected",
] as const;
export type WebhookEventType = (typeof webhookEvents)[number];
export type WebhookResourceType = "document" | "import" | "endpoint" | "connection" | "issuance";
/** Resource carried by each event type; the receiver reads it back through the API. */
export function webhookResourceType(type: WebhookEventType | "webhook.test"): WebhookResourceType {
  if (type === "webhook.test") return "endpoint";
  if (type === "import.completed") return "import";
  if (type.startsWith("connection.")) return "connection";
  if (type.startsWith("issuance.")) return "issuance";
  return "document";
}
/** Integration scope the endpoint's project (and key) needs to subscribe to the event. */
export function webhookEventScope(type: WebhookEventType) {
  if (type.startsWith("document.")) return "documents:read" as const;
  if (type.startsWith("connection.")) return "connections:read" as const;
  if (type === "issuance.cancelled" || type === "issuance.cancellation_rejected")
    return "documents:cancel" as const;
  if (type.startsWith("issuance.")) return "documents:issue" as const;
  return "documents:import" as const;
}
export const webhookContractVersion = "1" as const;
export const webhookToleranceMs = 300_000;
/**
 * The fact `connection.history_limited` carries (#442): the NSU range the organization's Owner
 * accepted as lost in the console, and the role that decided. The range is not readable anywhere
 * else in the API, and it never changes, so it travels in the event. No person, no reason: the
 * reason is free text that stays in the console's audit.
 */
export interface HistoryLimitedData {
  lost: { from: string; to: string };
  decidedBy: "owner";
}
export const HISTORY_LIMITED_EVENT = "connection.history_limited" satisfies WebhookEventType;
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
const NSU = /^\d{15}$/;
/** `data` is present, and well formed, exactly in `connection.history_limited`. */
function validData(type: unknown, data: unknown) {
  if (type !== HISTORY_LIMITED_EVENT) return data === undefined;
  if (!data || typeof data !== "object") return false;
  const { lost, decidedBy } = data as Partial<HistoryLimitedData>;
  return (
    decidedBy === "owner" &&
    !!lost &&
    typeof lost.from === "string" &&
    typeof lost.to === "string" &&
    NSU.test(lost.from) &&
    NSU.test(lost.to) &&
    lost.from <= lost.to
  );
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
export type WebhookVerification =
  | { ok: true; event: WebhookEnvelope; deliveryId: string; secretVersion: number }
  | {
      ok: false;
      code: "HEADERS_INVALID" | "TIMESTAMP_INVALID" | "SIGNATURE_INVALID" | "BODY_INVALID";
    };
const encoder = new TextEncoder();
function signingBytes(
  timestamp: string,
  keyVersion: number,
  h: Omit<WebhookHeaders, "x-fnfe-signature">,
  body: Uint8Array,
) {
  const prefix = encoder.encode(
    `${timestamp}.${keyVersion}.${h["x-fnfe-webhook-version"]}.${h["x-fnfe-event-id"]}.${h["x-fnfe-delivery-id"]}.${h["x-fnfe-resource-version"]}.`,
  );
  const bytes = new Uint8Array(prefix.length + body.length);
  bytes.set(prefix);
  bytes.set(body, prefix.length);
  return bytes;
}
async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function signWebhook(
  body: Uint8Array,
  headers: Omit<WebhookHeaders, "x-fnfe-signature">,
  secrets: WebhookSecret[],
  timestamp: number,
): Promise<WebhookHeaders> {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("Invalid timestamp");
  const activeSecrets = secrets.filter(
    (s) => s.validUntil === undefined || timestamp < s.validUntil,
  );
  if (
    activeSecrets.length < 1 ||
    activeSecrets.length > 2 ||
    activeSecrets.some(
      (s) => !Number.isSafeInteger(s.version) || s.version < 1 || s.version > 999_999_999,
    ) ||
    new Set(activeSecrets.map((s) => s.version)).size !== activeSecrets.length
  )
    throw new Error("Invalid signing keys");
  const signatures = await Promise.all(
    activeSecrets.map(async (s) => {
      const mac = await crypto.subtle.sign(
        "HMAC",
        await key(s.secret),
        signingBytes(String(timestamp), s.version, headers, body),
      );
      return `k=${s.version},v1=${hex(mac)}`;
    }),
  );
  return { ...headers, "x-fnfe-signature": `t=${timestamp};${signatures.join(";")}` };
}
export async function verifyWebhook(input: {
  body: Uint8Array;
  headers: Record<string, string | undefined>;
  secrets: WebhookSecret[];
  now: number;
  toleranceMs?: number;
}): Promise<WebhookVerification> {
  const h = input.headers;
  const fields = [
    "x-fnfe-event-id",
    "x-fnfe-delivery-id",
    "x-fnfe-resource-version",
    "x-fnfe-webhook-version",
  ] as const;
  if (
    fields.some((f) => !h[f] || !/^[A-Za-z0-9_-]{1,128}$/.test(h[f]!)) ||
    h["x-fnfe-webhook-version"] !== "1" ||
    !/^[1-9]\d*$/.test(h["x-fnfe-resource-version"]!)
  )
    return { ok: false, code: "HEADERS_INVALID" };
  const match =
    /^t=(0|[1-9]\d{0,15});(k=[1-9]\d{0,8},v1=[0-9a-f]{64})(;k=[1-9]\d{0,8},v1=[0-9a-f]{64})?$/.exec(
      h["x-fnfe-signature"] ?? "",
    );
  if (!match) return { ok: false, code: "HEADERS_INVALID" };
  const timestamp = Number(match[1]),
    tolerance = input.toleranceMs ?? webhookToleranceMs;
  if (
    !Number.isSafeInteger(timestamp) ||
    !Number.isSafeInteger(input.now) ||
    !Number.isSafeInteger(tolerance) ||
    tolerance < 0 ||
    Math.abs(input.now - timestamp) > tolerance
  )
    return { ok: false, code: "TIMESTAMP_INVALID" };
  let verifiedVersion: number | undefined;
  for (const signature of h["x-fnfe-signature"]!.split(";").slice(1)) {
    const [versionPart, macPart] = signature.split(",");
    const version = Number(versionPart!.slice(2));
    const secret = input.secrets.find(
      (s) =>
        s.version === version &&
        (s.validUntil === undefined || (input.now < s.validUntil && timestamp < s.validUntil)),
    );
    if (!secret) continue;
    const mac = Uint8Array.from(macPart!.slice(3).match(/../g)!, (b) => parseInt(b, 16));
    if (
      await crypto.subtle.verify(
        "HMAC",
        await key(secret.secret),
        mac,
        signingBytes(
          match[1]!,
          version,
          {
            "x-fnfe-event-id": h["x-fnfe-event-id"]!,
            "x-fnfe-delivery-id": h["x-fnfe-delivery-id"]!,
            "x-fnfe-resource-version": h["x-fnfe-resource-version"]!,
            "x-fnfe-webhook-version": h["x-fnfe-webhook-version"]!,
          },
          input.body,
        ),
      )
    )
      verifiedVersion = version;
  }
  if (verifiedVersion === undefined) return { ok: false, code: "SIGNATURE_INVALID" };
  try {
    const event: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body));
    if (!event || typeof event !== "object") throw new Error();
    const e = event as Partial<WebhookEnvelope>;
    if (
      e.eventId !== h["x-fnfe-event-id"] ||
      e.version !== "1" ||
      !e.resource ||
      String(e.resource.version) !== h["x-fnfe-resource-version"] ||
      !Number.isSafeInteger(e.resource.version) ||
      typeof e.resource.id !== "string" ||
      !e.resource.id ||
      (e.resource.originalId !== undefined &&
        (typeof e.resource.originalId !== "string" ||
          !e.resource.originalId ||
          e.resource.originalId === e.resource.id)) ||
      ![...webhookEvents, "webhook.test"].includes(e.type!) ||
      !["sandbox", "production"].includes(e.environment!) ||
      typeof e.companyId !== "string" ||
      !e.companyId ||
      !Number.isSafeInteger(e.occurredAt) ||
      e.occurredAt! < 0 ||
      e.synthetic !== (e.type === "webhook.test") ||
      e.resource.type !== webhookResourceType(e.type!) ||
      !validData(e.type, e.data)
    )
      throw new Error();
    return {
      ok: true,
      event: e as WebhookEnvelope,
      deliveryId: h["x-fnfe-delivery-id"]!,
      secretVersion: verifiedVersion,
    };
  } catch {
    return { ok: false, code: "BODY_INVALID" };
  }
}
