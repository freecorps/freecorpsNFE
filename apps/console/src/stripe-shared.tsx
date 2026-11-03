import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { api } from "../../../platform/convex/_generated/api";
import { scopeLabels } from "./integration-controls";
import { formatDateTime } from "./format";
import type { Tone } from "./ui/layout";

// What the parts of the Stripe connection share: the types read from the server, the error
// messages and the live state of the endpoint.

export type Connection = FunctionReturnType<typeof api.stripe.listConnections>[number];
export type Config = Connection["config"];
export type StripeEvent = FunctionReturnType<typeof api.stripe.listEvents>["page"][number];
export type EventState = StripeEvent["state"];

// Quota and plan never come from these mutations: the event fails with the code, and the event
// row explains it by role (`UsageGuidance`).
export const errorMessages: Record<string, string> = {
  STRIPE_DOMESTIC_ACTIVITY_INVALID:
    "Escolha uma atividade do perfil NFS-e para as vendas nacionais.",
  STRIPE_EXPORT_ACTIVITY_INVALID:
    "Escolha uma atividade do perfil NFS-e para as vendas ao exterior.",
  STRIPE_ISS_RATE_INVALID:
    "A alíquota do ISS vai de 0 a 5%, com até 4 casas decimais, e só vale para vendas nacionais.",
  STRIPE_DESCRIPTION_INVALID:
    "Informe a descrição do serviço com até 2.000 caracteres, sem caracteres de controle.",
  STRIPE_TRIGGER_REQUIRED: "Marque pelo menos um gatilho: faturas pagas ou checkout avulso pago.",
  STRIPE_CANCEL_SCOPE_REQUIRED: `Para cancelar a nota sozinha, a concessão da empresa neste projeto precisa de ${scopeLabels["documents:cancel"]} (documents:cancel) no ambiente da conexão.`,
  STRIPE_ISSUER_EMAIL_REQUIRED:
    "Cadastre o e-mail do prestador no perfil NFS-e da empresa: a conexão usa sempre o e-mail do perfil.",
  STRIPE_SECRET_INVALID:
    "Cole o Signing secret do endpoint no Stripe: ele começa com whsec_ e não tem espaços.",
  STRIPE_CONNECTION_LIMIT:
    "Esta empresa já tem 5 conexões Stripe neste projeto e ambiente. Reaproveite uma delas.",
  STRIPE_CONNECTION_CHANGED:
    "A conexão mudou enquanto você editava. Confira os dados e salve de novo.",
  NFSE_PROFILE_REQUIRED:
    "Configure o perfil de emissão NFS-e da empresa antes de conectar o Stripe.",
  STRIPE_EVENT_NOT_RELEASABLE:
    "Este evento não pode mais ser liberado: ele já mudou de situação. Confira a lista.",
  SCOPE_DENIED:
    "Seu papel ou a concessão do projeto não permite esta ação. Conexões Stripe são criadas e configuradas por proprietários e administradores; completar e reenviar eventos exige papel de Operador, Administrador ou Proprietário.",
  ISSUANCE_DEMONSTRATION_DENIED: "A empresa de demonstração não emite NFS-e.",
  GRANT_DENIED: `A concessão da empresa neste projeto precisa de ${scopeLabels["documents:issue"]} (documents:issue) no ambiente da conexão.`,
  ENVIRONMENT_DENIED: "Este ambiente não está concedido à empresa neste projeto.",
  PROJECT_DISABLED: "Reative o projeto antes de configurar a conexão.",
  INVALID_REQUEST: "Informe um nome de até 100 caracteres e confira os campos.",
  RATE_LIMITED: "Muitas tentativas. Aguarde um minuto e tente novamente.",
  NOT_FOUND: "Conexão ou evento indisponível para o seu acesso.",
};
export function stripeError(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code = data && typeof data === "object" && "code" in data ? data.code : "";
  return typeof code === "string" && errorMessages[code]
    ? errorMessages[code]
    : "Não foi possível concluir. Confira seu acesso e tente novamente.";
}

/** What the last signature failure means for the person configuring the endpoint. */
const signatureHints: Record<string, string> = {
  SIGNATURE_MISSING:
    "a chamada chegou sem o cabeçalho Stripe-Signature. Só o Stripe deve chamar esta URL.",
  SIGNATURE_INVALID:
    "o segredo colado não é o deste endpoint. Copie de novo o Signing secret do endpoint que usa esta URL, no mesmo modo (teste ou real), e cole no passo 4.",
  SIGNATURE_EXPIRED:
    "a assinatura tinha mais de 5 minutos. Reenvie o evento pelo painel do Stripe.",
  SECRET_MISSING:
    "o Stripe já está chamando esta URL, mas o segredo ainda não foi colado. Cole o Signing secret no passo 4 e reenvie o evento.",
  EVENT_INVALID:
    "o corpo do evento não pôde ser lido. Reenvie o evento pelo painel do Stripe; se repetir, fale com o suporte.",
};

/** Live state of the endpoint, from the connection's last event and last signature failure. */
export function connectionStatus(
  c: Pick<Connection, "active" | "secretSet" | "lastEventAt" | "lastFailureAt" | "lastFailureCode">,
): {
  tone: Tone;
  label: string;
  detail: string;
} {
  if (!c.active)
    return {
      tone: "neutral",
      label: "Conexão desativada",
      detail: "Eventos novos ficam registrados como ignorados, sem emitir nota.",
    };
  if (!c.secretSet)
    return {
      tone: "warning",
      label: "Falta o segredo de assinatura",
      detail: "Sem o Signing secret, a plataforma recusa as chamadas do Stripe (404).",
    };
  if (c.lastFailureCode && (c.lastFailureAt ?? 0) > (c.lastEventAt ?? 0))
    return {
      tone: "danger",
      label: `Última chamada recusada (${c.lastFailureCode})`,
      detail: `Em ${formatDateTime(c.lastFailureAt ?? 0)}: ${signatureHints[c.lastFailureCode] ?? "confira o segredo e reenvie o evento."}`,
    };
  if (c.lastEventAt)
    return {
      tone: "success",
      label: "Recebendo eventos",
      detail: `Último em ${formatDateTime(c.lastEventAt)}.`,
    };
  return {
    tone: "info",
    label: "Aguardando o primeiro evento",
    detail: "Envie um evento de teste pelo Stripe e acompanhe aqui.",
  };
}

export const marketLabels: Record<Config["market"], string> = {
  domestic: "Nacional",
  export: "Exterior",
  both: "Os dois",
};
export const environmentLabels = { sandbox: "Sandbox", production: "Produção" } as const;
