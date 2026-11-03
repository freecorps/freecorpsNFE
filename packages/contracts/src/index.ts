/** Shared product roles and F00 examples. Prototype data is always synthetic. */
export type ProductEnvironment = "sandbox" | "production";
import type { MembershipRole } from "./organizations.js";
export * from "./organizations.js";
export * from "./projects.js";
export * from "./documents.js";
export * from "./webhooks.js";
export interface AccountProfile {
  name: string;
  emailVerified: true;
  organization: null;
}
export interface ScreenError {
  code:
    | "FIELD_INVALID"
    | "XML_INVALID"
    | "CERTIFICATE_EXPIRED"
    | "CAPTURE_COOLDOWN"
    | "UNAVAILABLE";
  message: string;
  requestId: string;
  fields?: Record<string, string>;
  retryAt?: string;
}
export interface DocumentSummary {
  id: string;
  key: string;
  number: string;
  issuer: string;
  total: string;
  completeness: "full-xml" | "summary";
  source: "import" | "distribution" | "synthetic";
  fiscalStatus: "unknown" | "authorized" | "cancelled";
}
export interface DocumentDetail extends DocumentSummary {
  items: Array<{
    code: string;
    description: string;
    quantity: string;
    unitPrice: string;
    total: string;
  }>;
}
export interface CompanySummary {
  id: string;
  name: string;
  cnpj: string;
  certificate: "missing" | "valid" | "expired";
}
export interface CaptureSummary {
  companyId: string;
  status: "disabled" | "scheduled" | "cooldown" | "failed";
  lastSuccessAt: string | null;
  retryAt: string | null;
}
export const screenContracts = {
  onboarding: {
    title: "Seu primeiro documento",
    owner: "B02",
    operation: "organizations.create",
    roles: ["owner", "admin", "developer", "operator", "viewer"],
  },
  importacao: {
    title: "Importar XML",
    owner: "B04",
    operation: "documents.import",
    roles: ["owner", "admin", "operator"],
  },
  documento: {
    title: "Documento de demonstração",
    owner: "B04",
    operation: "documents.get",
    roles: ["owner", "admin", "developer", "operator", "viewer"],
  },
  empresa: {
    title: "Empresa de demonstração",
    owner: "B02",
    operation: "companies.create",
    roles: ["owner", "admin"],
  },
  certificado: {
    title: "Preparar certificado",
    owner: "B06",
    operation: "certificates.upload/validate/revoke",
    roles: ["owner", "admin"],
  },
  captura: {
    title: "Captura de documentos",
    owner: "B06",
    operation: "captures.enable/pause/retry",
    roles: ["owner", "admin", "operator"],
  },
} as const satisfies Record<
  string,
  { title: string; owner: string; operation: string; roles: readonly MembershipRole[] }
>;
export type PrototypeScreen = keyof typeof screenContracts;
export function isPrototypeScreen(value: string): value is PrototypeScreen {
  return Object.hasOwn(screenContracts, value);
}
export function canPreview(screen: PrototypeScreen, role: MembershipRole) {
  return (screenContracts[screen].roles as readonly MembershipRole[]).includes(role);
}
export const sampleDocument: DocumentDetail = {
  id: "demo-document",
  key: "35260900000000000000550010000000011000000000",
  number: "000000001",
  issuer: "Empresa Exemplo",
  total: "24.69",
  completeness: "full-xml",
  source: "synthetic",
  fiscalStatus: "unknown",
  items: [
    {
      code: "0001",
      description: "Produto de demonstração",
      quantity: "2.0000",
      unitPrice: "12.3456789012",
      total: "24.69",
    },
  ],
};
export const sampleCompany: CompanySummary = {
  id: "demo-company",
  name: "Empresa Exemplo",
  cnpj: "00000000000000",
  certificate: "missing",
};
export const sampleCapture: CaptureSummary = {
  companyId: sampleCompany.id,
  status: "disabled",
  lastSuccessAt: null,
  retryAt: null,
};
export * from "./companies.js";
