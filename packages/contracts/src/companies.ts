import type { MembershipRole } from "./organizations.js";

export { normalizeCnpj } from "@freecorps/fiscal-core";
export function formatCnpj(value: string) {
  return value.replace(
    /^([A-Z0-9]{2})([A-Z0-9]{3})([A-Z0-9]{3})([A-Z0-9]{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
}
export interface CompanyAddress {
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
  postalCode: string;
}
export interface DeclaredCompany {
  name: string;
  address: CompanyAddress;
}
/** B08 may offer a suggestion; the caller must select fields and confirm before updating. */
export interface CompanySuggestion {
  cnpj: string;
  source: { name: string; url: string; consultedAt: number; sourceUpdatedAt: number | null };
  fields: Partial<DeclaredCompany>;
}
export function companyCapabilities(role: MembershipRole) {
  return {
    read: true,
    manage: role === "owner" || role === "admin",
    operateDocuments: role === "owner" || role === "admin" || role === "operator",
  };
}
/** Synthetic demo identity, based on the RFB's published DV example, never a fiscal authorization. */
export const demonstrationCompany = {
  cnpj: "12ABC34501DE35",
  name: "Empresa de demonstração",
  address: {
    street: "Rua de demonstração",
    number: "1",
    complement: "",
    district: "Centro",
    city: "Cidade de demonstração",
    state: "SP",
    postalCode: "00000000",
  },
} satisfies DeclaredCompany & { cnpj: string };
