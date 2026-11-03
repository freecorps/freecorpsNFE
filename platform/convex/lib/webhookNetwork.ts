"use node";
import https from "node:https";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isPublicWebhookAddress } from "./publicAddress";
import { normalizeWebhookUrl } from "./webhookUrl";
import { MAX_RETRY_AFTER_MS } from "./webhookValues";
export class WebhookNetworkError extends Error {
  readonly code: "DESTINATION_DENIED" | "NETWORK_ERROR";
  constructor(code: "DESTINATION_DENIED" | "NETWORK_ERROR") {
    super(code);
    this.code = code;
  }
}
export function retryAfter(value: string | undefined, now: number) {
  if (!value) return undefined;
  const target = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(target) && target > now
    ? Math.min(target, now + MAX_RETRY_AFTER_MS)
    : undefined;
}
export async function postWebhook(
  urlValue: string,
  body: string,
  headers: Record<string, string>,
  dependencies: { resolve?: typeof lookup; request?: typeof https.request } = {},
) {
  let url: URL;
  try {
    if (new URL(urlValue).hash) throw new Error();
    url = new URL(normalizeWebhookUrl(urlValue));
    if ((url.port && url.port !== "443") || url.search) throw new Error();
  } catch {
    throw new WebhookNetworkError("DESTINATION_DENIED");
  }
  const deadline = AbortSignal.timeout(15_000);
  try {
    const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
      const abort = () => reject(new Error("timeout"));
      deadline.addEventListener("abort", abort, { once: true });
      void (dependencies.resolve ?? lookup)(url.hostname, { all: true, verbatim: true })
        .then(resolve, reject)
        .finally(() => deadline.removeEventListener("abort", abort));
    });
    if (!addresses.length || addresses.some((a) => !isPublicWebhookAddress(a.address)))
      throw new WebhookNetworkError("DESTINATION_DENIED");
    const address = addresses[0]!;
    return await new Promise<{ status: number; retryAt?: number; response: string }>(
      (resolve, reject) => {
        const request = (dependencies.request ?? https.request)(
          url,
          {
            method: "POST",
            agent: false,
            rejectUnauthorized: true,
            servername: url.hostname,
            family: address.family,
            signal: deadline,
            headers: {
              ...headers,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, [address]);
              else callback(null, address.address, address.family);
            },
          },
          (response) => {
            const status = response.statusCode ?? 502;
            const retryAt = retryAfter(response.headers["retry-after"], Date.now());
            // Arbitrary remote content can contain credentials, XML or PII. Preserve only status.
            response.destroy();
            resolve({
              status,
              ...(retryAt ? { retryAt } : {}),
              response: `HTTP ${status}. Corpo remoto omitido.`,
            });
          },
        );
        request.on("error", reject);
        request.end(body);
      },
    );
  } catch (error) {
    if (error instanceof WebhookNetworkError) throw error;
    throw new WebhookNetworkError("NETWORK_ERROR");
  }
}
