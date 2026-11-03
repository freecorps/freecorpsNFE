// SPDX-License-Identifier: MIT
// Copyright (c) 2026 FREECORPS TECNOLOGIA DA INFORMACAO LTDA
import {
  routes,
  errorResponse,
  uploadResponse,
  type RouteName,
  type RequestOf,
  type ResponseOf,
} from "../../contracts/src/external.js";
export * from "./webhooks.js";
export type { RouteName, RequestOf, ResponseOf } from "../../contracts/src/external.js";

export class FreecorpsError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryable: boolean;
  /** Request field the API rejected (`taker.document`), when it said which. */
  readonly field: string | null;
  /** Profile fields the issuance still needs (`NFSE_ROUTE_PROFILE_INCOMPLETE`). */
  readonly missing: readonly string[];
  /** Epoch ms from which the capture may be resumed (`SOURCE_COOLDOWN`), when the API said. */
  readonly nextAllowedAt: number | null;
  constructor(
    status: number,
    code: string,
    requestId: string | null,
    retryable = false,
    field: string | null = null,
    missing: readonly string[] = [],
    nextAllowedAt: number | null = null,
  ) {
    super(`Freecorps: ${code}`);
    this.name = "FreecorpsError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryable = retryable;
    this.field = field;
    this.missing = missing;
    this.nextAllowedAt = nextAllowedAt;
  }
}
export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  environment: "sandbox" | "production";
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}
export interface CallOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(
        new FreecorpsError(
          0,
          signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
            ? "TIMEOUT"
            : "ABORTED",
          null,
        ),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
/** No ambient configuration: the caller owns credentials, environment and network. */
export class FreecorpsClient {
  private readonly origin: string;
  private readonly settings: ClientOptions;
  private readonly send: typeof fetch;
  constructor(options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/"].includes(url.pathname) ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new Error("baseUrl deve ser uma origem HTTPS ou localhost HTTP.");
    if (
      !Number.isSafeInteger(options.timeoutMs ?? 30_000) ||
      (options.timeoutMs ?? 30_000) < 1 ||
      (options.timeoutMs ?? 30_000) > 2_147_483_647 ||
      !Number.isSafeInteger(options.maxRetries ?? 2) ||
      (options.maxRetries ?? 2) < 0 ||
      (options.maxRetries ?? 2) > 5
    )
      throw new Error("Timeout ou limite de retentativas inválido.");
    this.origin = url.origin;
    this.settings = { ...options };
    this.send = options.fetch ?? globalThis.fetch;
  }
  async call<K extends RouteName>(
    name: K,
    input: RequestOf<K>,
    options: CallOptions = {},
  ): Promise<ResponseOf<K>> {
    const route = routes[name];
    const parsed = route.input.safeParse(input);
    if (!parsed.success) throw new FreecorpsError(0, "INVALID_REQUEST", null);
    if (
      route.retry === "idempotent" &&
      !new RegExp(route.idempotencyPattern).test(options.idempotencyKey ?? "")
    )
      throw new FreecorpsError(0, "IDEMPOTENCY_KEY_REQUIRED", null);
    const url = new URL(
      route.path.replace(/\{(\w+)\}/g, (_, key: string) =>
        encodeURIComponent(String((parsed.data.path as Record<string, unknown>)[key])),
      ),
      this.origin,
    );
    for (const [key, value] of Object.entries(parsed.data.query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const deadline = AbortSignal.timeout(this.settings.timeoutMs ?? 30_000);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.settings.apiKey}`,
      "X-Environment": this.settings.environment,
      "Content-Type": "application/json",
    };
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    const body = route.method === "GET" ? undefined : JSON.stringify(parsed.data.body);
    const retries = route.retry === "never" ? 0 : (this.settings.maxRetries ?? 2);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.send(url, {
          method: route.method,
          headers,
          body,
          signal,
          redirect: "error",
        });
      } catch {
        if (signal.aborted)
          throw new FreecorpsError(0, options.signal?.aborted ? "ABORTED" : "TIMEOUT", null);
        if (attempt >= retries)
          throw new FreecorpsError(0, "NETWORK_ERROR", null, route.retry !== "never");
        await sleep(200 * 2 ** attempt, signal);
        continue;
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        if (signal.aborted)
          throw new FreecorpsError(
            response.status,
            options.signal?.aborted ? "ABORTED" : "TIMEOUT",
            response.headers.get("X-Request-Id"),
          );
        // Gateways may return HTML, plain text or an empty body during an outage.
        // The status still governs safe retries; malformed successes remain errors.
      }
      if (response.ok) {
        const checked = route.output.safeParse(data);
        if (response.status !== route.status || !checked.success)
          throw new FreecorpsError(
            response.status,
            "INVALID_RESPONSE",
            response.headers.get("X-Request-Id"),
          );
        return checked.data as ResponseOf<K>;
      }
      const failure = errorResponse.safeParse(data);
      const retryable =
        route.retry !== "never" &&
        [429, 502, 503, 504].includes(response.status) &&
        (!failure.success || failure.data.error.retryable);
      if (attempt >= retries || !retryable)
        throw new FreecorpsError(
          response.status,
          failure.success ? failure.data.error.code : "INVALID_RESPONSE",
          failure.success ? failure.data.requestId : response.headers.get("X-Request-Id"),
          retryable,
          failure.success ? (failure.data.error.field ?? null) : null,
          failure.success ? (failure.data.error.missing ?? []) : [],
          failure.success ? (failure.data.error.nextAllowedAt ?? null) : null,
        );
      const retryAfter = response.headers.get("Retry-After");
      const delay =
        retryAfter === null
          ? 200 * 2 ** attempt
          : /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Math.max(0, Date.parse(retryAfter) - Date.now());
      await sleep(
        Number.isFinite(delay) ? Math.min(delay, 2_147_483_647) : 200 * 2 ** attempt,
        signal,
      );
    }
  }
  private async transfer<T>(
    url: URL,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.settings.timeoutMs ?? 30_000);
    const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
    let response: Response | undefined;
    try {
      response = await this.send(url, { ...init, signal, redirect: "error" });
      return await consume(response);
    } catch (error) {
      if (error instanceof FreecorpsError) throw error;
      throw new FreecorpsError(
        response?.status ?? 0,
        signal.aborted
          ? callerSignal?.aborted
            ? "ABORTED"
            : "TIMEOUT"
          : response
            ? "INVALID_RESPONSE"
            : "NETWORK_ERROR",
        response?.headers.get("X-Request-Id") ?? null,
        !response && !signal.aborted && (init.method ?? "GET") === "GET",
      );
    }
  }
  /** Upload tickets are one-use. On a lost response, inspect the import before obtaining another. */
  async upload(
    ticket: { url: string; token: string },
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = new URL(ticket.url);
    if (
      url.origin !== this.origin ||
      url.pathname !== "/v1/import-upload" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new FreecorpsError(0, "UPLOAD_ORIGIN_INVALID", null);
    return this.transfer(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/xml", "X-Upload-Token": ticket.token },
        body: new Uint8Array(bytes),
      },
      async (response) => {
        const result: unknown = await response.json();
        if (!response.ok) {
          const failure = errorResponse.safeParse(result);
          if (failure.success)
            throw new FreecorpsError(
              response.status,
              failure.data.error.code,
              failure.data.requestId,
              false,
            );
        }
        if (response.status !== 200 || !uploadResponse.safeParse(result).success)
          throw new FreecorpsError(
            response.status,
            "INVALID_RESPONSE",
            response.headers.get("X-Request-Id"),
          );
      },
      signal,
    );
  }
  /** Binary reads do not retry automatically. The API rechecks access before returning bytes. */
  async downloadOriginal(
    input: { artifactId: string; companyId: string },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!input.artifactId || !input.companyId) throw new FreecorpsError(0, "INVALID_REQUEST", null);
    const url = new URL(
      `/v1/document-artifacts/${encodeURIComponent(input.artifactId)}/original`,
      this.origin,
    );
    url.searchParams.set("companyId", input.companyId);
    return this.binary(url, signal);
  }
  /**
   * DANFE PDF of an NF-e 55 document, generated from its preserved XML and cancellation events.
   * The first call may render the file and take a few seconds. Same rules as `downloadOriginal`:
   * no automatic retry, access checked again before the bytes leave.
   */
  async downloadDanfe(
    input: { documentId: string; companyId: string },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!input.documentId || !input.companyId) throw new FreecorpsError(0, "INVALID_REQUEST", null);
    const url = new URL(`/v1/documents/${encodeURIComponent(input.documentId)}/danfe`, this.origin);
    url.searchParams.set("companyId", input.companyId);
    return this.binary(url, signal);
  }
  /**
   * Preserved artifact of an issuance (DPS, NFS-e, cancellation XML or the DANFSe PDF), by the artifact id
   * listed in `issuance.artifacts`. Same rules as `downloadOriginal`: no automatic retry, access
   * checked again before the bytes leave.
   */
  async downloadIssuanceArtifact(
    input: { issuanceId: string; artifactId: string; companyId: string },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!input.issuanceId || !input.artifactId || !input.companyId)
      throw new FreecorpsError(0, "INVALID_REQUEST", null);
    const url = new URL(
      `/v1/issuances/${encodeURIComponent(input.issuanceId)}/artifacts/${encodeURIComponent(input.artifactId)}`,
      this.origin,
    );
    url.searchParams.set("companyId", input.companyId);
    return this.binary(url, signal);
  }
  private async binary(url: URL, signal?: AbortSignal): Promise<Uint8Array> {
    return this.transfer(
      url,
      {
        headers: {
          Authorization: `Bearer ${this.settings.apiKey}`,
          "X-Environment": this.settings.environment,
        },
      },
      async (response) => {
        if (!response.ok) {
          const parsed = errorResponse.safeParse(await response.json());
          throw new FreecorpsError(
            response.status,
            parsed.success ? parsed.data.error.code : "INVALID_RESPONSE",
            parsed.success ? parsed.data.requestId : response.headers.get("X-Request-Id"),
            parsed.success ? parsed.data.error.retryable : false,
          );
        }
        if (response.status !== 200)
          throw new FreecorpsError(
            response.status,
            "INVALID_RESPONSE",
            response.headers.get("X-Request-Id"),
          );
        return new Uint8Array(await response.arrayBuffer());
      },
      signal,
    );
  }
}
