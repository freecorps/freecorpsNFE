import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import type { IntegrationEnvironment } from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import { SkeletonBlock } from "./ui/layout";

// Types, messages and form helpers shared by the project pages, grants and keys.

export type Props = { org: Organization; contextKey: string };
export type Project = NonNullable<FunctionReturnType<typeof api.projects.get>>;
export type Grant = FunctionReturnType<typeof api.projects.companies>["page"][number];
export function errorText(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code = data && typeof data === "object" && "code" in data ? data.code : "";
  const messages: Record<string, string> = {
    PROJECT_CONFLICT:
      "Esta referência já está em uso. Confira o projeto ou escolha outra referência.",
    PROJECT_CHANGED: "O projeto mudou. Confira os dados antes de tentar novamente.",
    GRANT_CHANGED: "A concessão mudou. Atualize a seleção e tente novamente.",
    SCOPE_DENIED: "Você não pode conceder estes escopos.",
    GRANT_DENIED: "Confira as empresas, os escopos e o ambiente concedidos ao projeto.",
    ENVIRONMENT_DENIED: "Este ambiente não está disponível para a empresa.",
    INVALID_EXPIRATION: "Informe uma data de expiração futura.",
    INVALID_KEY_COMPANIES: "Selecione entre uma e 50 empresas concedidas ao projeto.",
    PROJECT_DISABLED: "Reative o projeto antes de criar novas concessões ou chaves.",
    PROJECT_COMPANY_LIMIT: "O projeto atingiu o limite de 50 empresas ativas.",
    KEY_UNAVAILABLE: "Esta chave expirou, foi revogada ou já foi rotacionada.",
    ROTATION_ESCALATION: "A rotação deve preservar ou reduzir o acesso e a validade originais.",
    INVALID_OVERLAP: "A coexistência deve ficar entre zero e 24 horas.",
    RATE_LIMITED: "Muitas tentativas. Aguarde um minuto antes de tentar novamente.",
  };
  return typeof code === "string" && messages[code]
    ? messages[code]
    : "Não foi possível concluir. Confira seu acesso e tente novamente.";
}
export function Loading({ label = "Confirmando o acesso à integração…" }: { label?: string }) {
  return <SkeletonBlock label={label} />;
}
export function text(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
export const environmentLabel: Record<IntegrationEnvironment, string> = {
  sandbox: "Sandbox",
  production: "Produção",
};
