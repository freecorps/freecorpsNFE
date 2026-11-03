import { ConvexError } from "convex/values";

/**
 * Orientação para cota e vigência, sem React: códigos, textos e público. A tela Uso e limites é
 * só de proprietários e administradores (`capabilities.manageOrganization`); quem não a vê
 * recebe a instrução de falar com um gestor, em vez de procurar uma página que não existe para o
 * seu papel. Sem o papel, a mensagem neutra serve aos dois públicos. O aviso com o link fica em
 * `usage-errors.tsx`.
 */
export type UsageAudience = "manager" | "member";
/** O que o aviso precisa da organização: o papel decide a orientação; o slug, o link. */
export type UsageOrg = { slug: string; capabilities: { manageOrganization: boolean } };
const quota = "Esta operação atingiu o limite do plano. Seus documentos continuam disponíveis.";
const inactive =
  "O plano está fora da vigência. A leitura e a exportação autorizadas continuam disponíveis.";
const required =
  "Esta operação exige um plano atribuído à organização, com cotas explícitas, inclusive no plano gratuito. A captura em Produção exige cotas de consultas (ou de notas, no Gratuito) e bytes.";
const inventory =
  "O inventário de capacidade está pendente. Solicite a conferência à Freecorps antes de novas entradas.";
// #586: past the effect of new terms of use, the organization creates no new command until an owner
// accepts them, in the notice at the top of the organization.
const terms =
  "A organização ainda não aceitou os termos de uso em vigor e não cria operações novas. A leitura e a exportação autorizadas continuam disponíveis. Um proprietário aceita os termos no aviso no topo da organização.";
const messages: Record<UsageAudience | "unknown", Record<string, string>> = {
  manager: {
    QUOTA_EXCEEDED: `${quota} Confira o consumo em Gestão e integração › Uso e limites e peça a revisão do plano à Freecorps.`,
    PLAN_INACTIVE: `${inactive} Confira a vigência em Gestão e integração › Uso e limites e peça a revisão do plano à Freecorps.`,
    CAPACITY_INVENTORY_REQUIRED: inventory,
    TERMS_OF_USE_REQUIRED: terms,
    PLAN_REQUIRED: `${required} Confira o plano em Gestão e integração › Uso e limites e solicite-o à Freecorps.`,
  },
  member: {
    QUOTA_EXCEEDED: `${quota} Fale com um gestor da organização (proprietário ou administrador) para revisar o plano.`,
    PLAN_INACTIVE: `${inactive} Fale com um gestor da organização (proprietário ou administrador) para revisar o plano.`,
    CAPACITY_INVENTORY_REQUIRED: inventory,
    TERMS_OF_USE_REQUIRED: terms,
    PLAN_REQUIRED: `${required} Fale com um gestor da organização (proprietário ou administrador) para solicitar o plano.`,
  },
  unknown: {
    QUOTA_EXCEEDED: `${quota} Proprietários e administradores acompanham o consumo em Uso e limites; se você não é gestor, fale com um deles para revisar o plano.`,
    PLAN_INACTIVE: `${inactive} Proprietários e administradores acompanham a vigência em Uso e limites; se você não é gestor, fale com um deles para revisar o plano.`,
    CAPACITY_INVENTORY_REQUIRED: inventory,
    TERMS_OF_USE_REQUIRED: terms,
    PLAN_REQUIRED: `${required} Proprietários e administradores acompanham o plano em Uso e limites; se você não é gestor, fale com um deles para solicitá-lo.`,
  },
};
/** Público da orientação a partir das capacidades do contexto da organização. */
export function usageAudience(org: {
  capabilities: { manageOrganization: boolean };
}): UsageAudience {
  return org.capabilities.manageOrganization ? "manager" : "member";
}
export function usageMessagesFor(audience?: UsageAudience): Record<string, string> {
  return messages[audience ?? "unknown"];
}
/** Mensagens neutras, para textos que não conhecem o papel. */
export const usageMessages = usageMessagesFor();
export function usageErrorCode(error: unknown) {
  const data = error instanceof ConvexError ? error.data : null;
  return data && typeof data === "object" && "code" in data && typeof data.code === "string"
    ? data.code
    : undefined;
}
/**
 * Cota (`QUOTA_EXCEEDED`), vigência (`PLAN_INACTIVE`), ausência do plano que a captura em
 * Produção exige (`PLAN_REQUIRED`, #429) ou termos de uso em vigor sem aceite
 * (`TERMS_OF_USE_REQUIRED`, #586); os demais códigos, não.
 */
export function isUsageCode(code: string | null | undefined): code is string {
  return (
    code === "CAPACITY_INVENTORY_REQUIRED" ||
    code === "QUOTA_EXCEEDED" ||
    code === "PLAN_INACTIVE" ||
    code === "PLAN_REQUIRED" ||
    code === "TERMS_OF_USE_REQUIRED"
  );
}
/**
 * O limite de notas novas em Produção (ADR 0010) quando a recusa é dele: `QUOTA_EXCEEDED` com
 * `metric: "documents"`, com o número do plano quando o servidor o mandou.
 */
export function notesQuotaReason(error: unknown) {
  const data = error instanceof ConvexError ? (error.data as Record<string, unknown>) : null;
  if (!data || data.code !== "QUOTA_EXCEEDED" || data.metric !== "documents") return undefined;
  const limit =
    typeof data.limit === "number" && Number.isSafeInteger(data.limit)
      ? `${new Intl.NumberFormat("pt-BR").format(data.limit)} `
      : "";
  return `A organização chegou ao limite de ${limit}notas novas do mês em Produção.`;
}
export function usageErrorMessage(error: unknown, audience?: UsageAudience) {
  const code = usageErrorCode(error);
  if (!isUsageCode(code)) return undefined;
  const notes = notesQuotaReason(error);
  return notes ? `${notes} ${usageMessagesFor(audience)[code]}` : usageMessagesFor(audience)[code];
}
