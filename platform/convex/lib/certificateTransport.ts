"use node";
import https from "node:https";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { createSecureContext } from "node:tls";
import { isPublicWebhookAddress } from "./publicAddress";
import { certificateTlsPem } from "./certificateValidation";

export type TransportTarget = {
  body?: string;
  headers?: Record<string, string>;
  url: string;
  allowedOrigins: readonly string[];
  ca?: string;
  timeoutMs?: number;
  maxBytes?: number;
};
/** `contentType` feeds only the diagnostics of unreadable answers, never a decision. */
export type TransportReply = { status: number; body: Buffer; contentType?: string | null };
/** Targets/CA come from server configuration, never from certificate contents or user input. */
export async function certificateRequest(
  target: TransportTarget,
  material: { pfx: Buffer; password: Buffer },
  dependencies: { resolve?: typeof lookup; request?: typeof https.request } = {},
) {
  let url: URL;
  try {
    url = new URL(target.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !target.allowedOrigins.includes(url.origin)
    )
      throw 0;
  } catch {
    throw new Error("CERTIFICATE_HOST_DENIED");
  }
  const timeout = Math.min(target.timeoutMs ?? 15_000, 30_000);
  const maxBytes = Math.min(target.maxBytes ?? 1024 * 1024, 2 * 1024 * 1024);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  let abortLookup: (() => void) | undefined;
  try {
    const addresses = await Promise.race([
      (dependencies.resolve ?? lookup)(url.hostname, { all: true, verbatim: true }),
      new Promise<LookupAddress[]>((_, reject) => {
        abortLookup = () => reject(new Error("CERTIFICATE_TIMEOUT"));
        abort.signal.addEventListener("abort", abortLookup, { once: true });
      }),
    ]);
    if (!addresses.length || addresses.some((a) => !isPublicWebhookAddress(a.address)))
      throw new Error("CERTIFICATE_HOST_DENIED");
    const pem = certificateTlsPem(material.pfx, material.password);
    let secureContext;
    try {
      secureContext = createSecureContext({
        key: pem.key,
        cert: pem.cert,
        minVersion: "TLSv1.2",
        ...(target.ca ? { ca: target.ca } : {}),
      });
    } finally {
      pem.dispose();
    }
    const address = addresses[0]!;
    const tlsOptions = { secureContext };
    return await new Promise<TransportReply>((resolve, reject) => {
      const request = (dependencies.request ?? https.request)(
        url,
        {
          method: target.body === undefined ? "GET" : "POST",
          headers: target.headers,
          agent: false,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          servername: url.hostname,
          ...tlsOptions,
          maxHeaderSize: 16384,
          signal: abort.signal,
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            reject(new Error("CERTIFICATE_REDIRECT_DENIED"));
            response.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let count = 0;
          response.on("data", (chunk: Buffer) => {
            count += chunk.length;
            if (count > maxBytes) {
              reject(new Error("CERTIFICATE_RESPONSE_LIMIT"));
              chunks.forEach((part) => part.fill(0));
              response.destroy();
              request.destroy();
            } else chunks.push(chunk);
          });
          response.on("end", () =>
            resolve({
              status,
              body: Buffer.concat(chunks),
              contentType: response.headers["content-type"] ?? null,
            }),
          );
          response.on("error", reject);
          response.on("aborted", () => reject(new Error("CERTIFICATE_NETWORK_ERROR")));
        },
      );
      request.on("error", reject);
      request.end(target.body);
    });
  } catch (error) {
    if (abort.signal.aborted) throw new Error("CERTIFICATE_TIMEOUT");
    if (error instanceof Error && error.message.startsWith("CERTIFICATE_")) throw error;
    throw new Error("CERTIFICATE_NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
    if (abortLookup) abort.signal.removeEventListener("abort", abortLookup);
  }
}
