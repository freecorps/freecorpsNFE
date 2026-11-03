import type { MembershipRole } from "./organizations.js";

export const integrationScopes = [
  "companies:read",
  "companies:write",
  "documents:read",
  "documents:import",
  "documents:issue",
  "documents:cancel",
  "connections:read",
  "connections:write",
  "certificates:read",
  "certificates:write",
  "webhooks:manage",
  "references:read",
  "registry:read",
] as const;
export type IntegrationScope = (typeof integrationScopes)[number];
/** Scopes still without a public REST route; a test keeps this in sync with `routes`. */
export const scopesWithoutRestRoute: readonly IntegrationScope[] = [
  "companies:write",
  "certificates:read",
  "certificates:write",
];
/**
 * Integration scopes a sandbox deployment serves in production for a company whose fiscal
 * capture is released (ADR 0007, §3): the capture and the documents and webhooks around it,
 * never import, issuance, registry, references or certificates. The server's environment check
 * and the console's choices both read this list.
 */
export const releasedProductionScopes = [
  "companies:read",
  "documents:read",
  "connections:read",
  "connections:write",
  "webhooks:manage",
] as const satisfies readonly IntegrationScope[];
export const integrationEnvironments = ["sandbox", "production"] as const;
export type IntegrationEnvironment = (typeof integrationEnvironments)[number];
export const maxRotationOverlapMs = 24 * 60 * 60_000;
export const maxKeyCompanies = 50;

/** A developer can delegate reads/integration management, never additional fiscal operations. */
export function grantableScopes(role: MembershipRole): IntegrationScope[] {
  if (role === "owner" || role === "admin") return [...integrationScopes];
  if (role === "developer")
    return integrationScopes.filter((s) => s.endsWith(":read") || s === "webhooks:manage");
  return [];
}

export interface RestError {
  requestId: string;
  error: { code: string; message: string; retryable: boolean };
}
export interface RestCompany {
  id: string;
  name: string;
  cnpj: string;
  kind: "declared" | "demonstration";
  registryStatus: "not-consulted";
  fiscalAccess: "not-configured";
}
