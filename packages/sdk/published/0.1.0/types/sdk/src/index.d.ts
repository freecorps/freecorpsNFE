import { type RouteName, type RequestOf, type ResponseOf } from "../../contracts/src/external.js";
export * from "./webhooks.js";
export type { RouteName, RequestOf, ResponseOf } from "../../contracts/src/external.js";
export declare class FreecorpsError extends Error {
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
    constructor(status: number, code: string, requestId: string | null, retryable?: boolean, field?: string | null, missing?: readonly string[], nextAllowedAt?: number | null);
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
/** No ambient configuration: the caller owns credentials, environment and network. */
export declare class FreecorpsClient {
    private readonly origin;
    private readonly settings;
    private readonly send;
    constructor(options: ClientOptions);
    call<K extends RouteName>(name: K, input: RequestOf<K>, options?: CallOptions): Promise<ResponseOf<K>>;
    private transfer;
    /** Upload tickets are one-use. On a lost response, inspect the import before obtaining another. */
    upload(ticket: {
        url: string;
        token: string;
    }, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
    /** Binary reads do not retry automatically. The API rechecks access before returning bytes. */
    downloadOriginal(input: {
        artifactId: string;
        companyId: string;
    }, signal?: AbortSignal): Promise<Uint8Array>;
    /**
     * DANFE PDF of an NF-e 55 document, generated from its preserved XML and cancellation events.
     * The first call may render the file and take a few seconds. Same rules as `downloadOriginal`:
     * no automatic retry, access checked again before the bytes leave.
     */
    downloadDanfe(input: {
        documentId: string;
        companyId: string;
    }, signal?: AbortSignal): Promise<Uint8Array>;
    /**
     * Preserved artifact of an issuance (DPS, NFS-e, cancellation XML or the DANFSe PDF), by the artifact id
     * listed in `issuance.artifacts`. Same rules as `downloadOriginal`: no automatic retry, access
     * checked again before the bytes leave.
     */
    downloadIssuanceArtifact(input: {
        issuanceId: string;
        artifactId: string;
        companyId: string;
    }, signal?: AbortSignal): Promise<Uint8Array>;
    private binary;
}
