import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";

// Tabs of the company page and their `?aba=` in the URL.

type Company = NonNullable<FunctionReturnType<typeof api.companies.get>>;

export type CompanyTab =
  | "resumo"
  | "fiscal"
  | "certificado"
  | "consulta"
  | "captura"
  | "acesso"
  | "historico";
/** Tabs the role sees for this company, in display order. Hiding a tab is only UX. */
export function companyTabs(
  company: Pick<Company, "kind" | "capabilities">,
  role: Organization["role"],
): Array<{ id: CompanyTab; label: string }> {
  const declared = company.kind === "declared";
  const all: Array<{ id: CompanyTab; label: string; shown: boolean }> = [
    { id: "resumo", label: "Resumo", shown: true },
    { id: "fiscal", label: "Fiscal", shown: declared },
    { id: "certificado", label: "Certificado", shown: declared },
    { id: "consulta", label: "Consulta CNPJ", shown: declared },
    { id: "captura", label: "Captura", shown: declared && role !== "developer" },
    { id: "acesso", label: "Acesso", shown: company.capabilities.manage },
    { id: "historico", label: "Histórico", shown: company.capabilities.manage },
  ];
  return all.filter((tab) => tab.shown).map(({ id, label }) => ({ id, label }));
}
/** `?aba=` of the URL; an unknown or hidden tab opens the summary. */
export function resolveTab(value: unknown, tabs: Array<{ id: CompanyTab }>): CompanyTab {
  return tabs.find((tab) => tab.id === value)?.id ?? "resumo";
}
export const tabSearch = (tab: CompanyTab) => (tab === "resumo" ? {} : { aba: tab });
