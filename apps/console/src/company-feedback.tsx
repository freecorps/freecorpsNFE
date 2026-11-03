import { ConvexError } from "convex/values";
import { Button, Icon, SkeletonBlock } from "./ui";

// Messages and feedback shared by the company pages: registration, access, status and the first
// steps.

export const companyMessages: Record<string, string> = {
  INVALID_CNPJ:
    "Confira o CNPJ e seus dígitos verificadores. Letras e zeros devem ser preservados.",
  INVALID_COMPANY: "Confira o nome e os campos obrigatórios do endereço.",
  INVALID_ADDRESS: "Informe uma UF brasileira e um CEP com oito dígitos.",
  COMPANY_CHANGED: "O cadastro mudou. Confira os dados atualizados antes de salvar novamente.",
  GRANT_CHANGED: "O acesso mudou. Confira a lista atualizada antes de tentar novamente.",
  MEMBERSHIP_CHANGED: "A participação deste membro mudou. Confira as permissões atuais.",
  ONBOARDING_CHANGED: "Os primeiros passos mudaram em outra sessão. Confira o progresso atual.",
  COMPANY_KIND_CONFLICT:
    "Este CNPJ já está cadastrado com outra finalidade. Consulte a lista de empresas.",
  DEMONSTRATION_READ_ONLY:
    "Os dados de demonstração não podem ser alterados. Cadastre outra empresa para usar seus dados.",
  COMPANY_HAS_HISTORY:
    "Esta empresa já tem histórico na plataforma e não pode ser excluída. Atualize a página para ver a situação atual.",
  CONFIRMATION_MISMATCH: "O CNPJ digitado não confere com o desta empresa.",
  RATE_LIMITED: "Muitas tentativas. Aguarde um minuto antes de tentar novamente.",
  ACCESS_DENIED: "Seu acesso mudou ou esta ação não está disponível para seu papel.",
  UNAUTHENTICATED: "Sua sessão terminou. Entre novamente para continuar.",
};
export const errorCode = (error: unknown) => {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  return data && typeof data === "object" && "code" in data && typeof data.code === "string"
    ? data.code
    : "";
};
export function errorText(error: unknown) {
  return (
    companyMessages[errorCode(error)] ??
    "Não foi possível concluir. Confira sua conexão e tente novamente."
  );
}
/** Result of an action next to its button: the error first, then the confirmation. */
export function Feedback({ error, message }: { error: string; message?: string }) {
  return (
    <>
      {error && (
        <p className="ui-error-text" role="alert">
          <Icon name="danger" />
          <span>{error}</span>
        </p>
      )}
      {message && (
        <p className="ui-help company-feedback" role="status">
          <Icon name="success" />
          <span>{message}</span>
        </p>
      )}
    </>
  );
}
export function More({
  status,
  loadMore,
  label = "Carregar mais",
}: {
  status: string;
  loadMore: (n: number) => void;
  label?: string;
}) {
  return status === "CanLoadMore" || status === "LoadingMore" ? (
    <div className="ui-actions">
      <Button
        size="sm"
        loading={status === "LoadingMore"}
        loadingLabel="Carregando…"
        onClick={() => loadMore(20)}
      >
        {label}
      </Button>
    </div>
  ) : null;
}
export function Loading({ label = "Confirmando o acesso à empresa…" }: { label?: string }) {
  return <SkeletonBlock label={label} />;
}
