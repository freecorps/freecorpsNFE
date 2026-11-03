import { ConvexError } from "convex/values";
import { publicErrorStatus } from "@freecorps/contracts/external";

/**
 * The public error vocabulary of the REST API. The code and status are the contract; the message
 * is guidance. Domain errors arrive as `ConvexError({ code, field?, missing?, nextAllowedAt? })`;
 * anything else, and any code outside the contract, becomes `UNAVAILABLE` without copying text
 * from the error.
 */
export type PublicError = {
  status: number;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    field?: string;
    missing?: string[];
    nextAllowedAt?: number;
  };
};

const fallback = "Não foi possível concluir a solicitação.";

const messages: Record<string, string> = {
  INVALID_API_KEY: "Chave ausente, inválida ou expirada.",
  ENVIRONMENT_DENIED: "A chave não permite este ambiente.",
  SCOPE_DENIED: "A chave não tem permissão para esta operação.",
  INVALID_QUERY: "Parâmetros de consulta inválidos.",
  INVALID_PAGINATION: "Paginação inválida.",
  INVALID_CURSOR: "O cursor não pertence a esta consulta.",
  IDEMPOTENCY_CONFLICT: "A chave de idempotência já foi usada com outro pedido.",
  DANFE_UNAVAILABLE:
    "Não há DANFE para este documento: ele existe só para a NF-e modelo 55 com o XML completo preservado, aceito pelo gerador.",
  RATE_LIMITED: "Limite de requisições atingido. Tente novamente após o prazo indicado.",
  SOURCE_COOLDOWN:
    "A Receita só aceita a próxima consulta depois de um intervalo. Retome a partir de nextAllowedAt.",
  // ADR 0009, §3: its own code since 8.0.0, no longer SCOPE_DENIED.
  ORGANIZATION_ARCHIVED:
    "Organização em arquivo econômico: dados fiscais e novas operações ficam indisponíveis até a reativação. Um proprietário ou administrador pede a reativação ou a exportação assistida à Freecorps.",
  // NFS-e issuance (docs/plataforma/ISSUANCE.md).
  ISSUANCE_PRODUCTION_DISABLED: "A emissão em produção não está liberada para esta empresa.",
  ISSUANCE_DEMONSTRATION_DENIED: "Empresa de demonstração não emite NFS-e.",
  NFSE_PROFILE_REQUIRED: "Cadastre o perfil NFS-e da empresa antes de emitir.",
  NFSE_ACTIVITY_NOT_FOUND: "A atividade informada não está no perfil NFS-e vigente.",
  NFSE_ROUTE_UNSUPPORTED:
    "Não há canal de emissão suportado para o município, regime e data, ou o canal não tem emissão em produção.",
  NFSE_ROUTE_PROFILE_INCOMPLETE:
    "A emissão exige dados que o perfil NFS-e ainda não tem, pelo canal do município ou pela obrigatoriedade do IBS/CBS.",
  ISSUANCE_FIELD_INVALID: "Campo do pedido inválido.",
  ISSUANCE_TAKER_DOCUMENT_INVALID: "CPF ou CNPJ do tomador inválido.",
  ISSUANCE_TAKER_NIF_INVALID: "Informe o NIF do tomador estrangeiro ou o motivo da ausência.",
  ISSUANCE_TAKER_INVALID: "Mercado interno exige tomador nacional.",
  ISSUANCE_EXPORT_TAKER_REQUIRED: "Exportação exige tomador estrangeiro.",
  ISSUANCE_EXPORT_CURRENCY_REQUIRED: "Exportação exige moeda estrangeira.",
  ISSUANCE_CURRENCY_INVALID: "Mercado interno exige valor em BRL.",
  ISSUANCE_CURRENCY_UNSUPPORTED: "Moeda não suportada.",
  ISSUANCE_AMOUNT_INVALID: "Valor do serviço inválido.",
  ISSUANCE_ISS_RATE_INVALID: "Alíquota de ISS inválida.",
  ISSUANCE_ISS_RATE_REQUIRED: "Informe a alíquota de ISS.",
  ISSUANCE_ISS_RATE_NOT_ALLOWED: "Optante do Simples sem retenção não informa alíquota de ISS.",
  ISSUANCE_ISS_NOT_LEVIED: "Exportação de serviço não tem ISS.",
  ISSUANCE_WITHHOLDING_INVALID: "Retenção de ISS não permitida para este pedido.",
  ISSUANCE_COMPETENCE_INVALID: "Competência inválida; use AAAA-MM.",
  ISSUANCE_COMPETENCE_FUTURE: "A competência não pode ser posterior ao mês da emissão.",
  ISSUANCE_DATE_INVALID: "Data de emissão inválida; use AAAA-MM-DD.",
  ISSUANCE_DATE_FUTURE: "A data de emissão não pode ser futura.",
  ISSUANCE_ISSUER_EMAIL_REQUIRED:
    "Informe o e-mail do prestador ou cadastre-o no perfil NFS-e da empresa.",
  DPS_NUMBER_EXHAUSTED: "A numeração da série DPS se esgotou.",
  CANCEL_REASON_INVALID:
    "Motivo do cancelamento inválido: use de 15 a 255 caracteres e, em produção, nenhum marcador do simulador ([simular:...]).",
  ISSUANCE_NOT_CANCELLABLE: "Só uma NFS-e autorizada pode ser cancelada.",
  ISSUANCE_TRANSPORT_CHANGED:
    "O cancelamento precisa sair pelo mesmo transporte que autorizou a nota.",
};

/** Internal codes that reach the public vocabulary under another code and their own message. */
const aliases: Record<string, { code: string; status: number; message: string }> = {
  // #402: past the limits of one rendering (100 event versions, 20 distinct cancellations).
  DANFE_EVIDENCE_LIMIT: {
    code: "DANFE_UNAVAILABLE",
    status: 409,
    message:
      "O documento tem eventos demais para gerar o DANFE (mais de 100 versões de evento ou de 20 cancelamentos distintos). Baixe o XML original e os eventos.",
  },
  CAPACITY_INVENTORY_REQUIRED: {
    code: "SCOPE_DENIED",
    status: 403,
    message:
      "O inventário de capacidade desta organização precisa ser concluído. Solicite a conferência à Freecorps.",
  },
  QUOTA_EXCEEDED: {
    code: "RATE_LIMITED",
    status: 429,
    message:
      "Cota do plano atingida. Consulte Uso e limites. Documentos e exportações autorizadas continuam disponíveis.",
  },
  PLAN_INACTIVE: {
    code: "SCOPE_DENIED",
    status: 403,
    message:
      "Plano fora da vigência. Solicite revisão do plano. Documentos e exportações autorizadas continuam disponíveis.",
  },
  // #586: past the effect of new terms of use, an organization that has not accepted them creates
  // no new command. Same public answer as a plan out of its term.
  TERMS_OF_USE_REQUIRED: {
    code: "SCOPE_DENIED",
    status: 403,
    message:
      "A organização precisa aceitar os termos de uso em vigor para criar operações novas. Um proprietário aceita no console. Documentos e exportações autorizadas continuam disponíveis.",
  },
  // #429: a production capture needs a plan with finite quotas. Same public answer as
  // a plan out of its term; documents already received stay available.
  PLAN_REQUIRED: {
    code: "SCOPE_DENIED",
    status: 403,
    message:
      "Esta operação exige um plano atribuído com cotas explícitas. A captura em Produção exige cotas de consultas e bytes. Solicite o plano à Freecorps.",
  },
  // Added after the contract's 6.0.0: the public enum stays as it was, and the REST answer is the
  // route refusal it already documents, with a message of its own (ISSUANCE.md, Grupo IBSCBS).
  ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED: {
    code: "NFSE_ROUTE_UNSUPPORTED",
    status: 409,
    message:
      "Esta exportação já exige o grupo IBS/CBS, e a plataforma ainda não emite a classificação de exportação.",
  },
  REFERENCE_VERSION_UNAVAILABLE: {
    code: "NOT_FOUND",
    status: 404,
    message: "Versão de referência não encontrada.",
  },
};

const statuses: Record<string, number> = publicErrorStatus;

/**
 * Maps an error to its public DTO. `notFound` is the domain's wording for `NOT_FOUND`
 * ("Operação não encontrada."), so each route names what it did not find.
 */
export function publicError(error: unknown, notFound = "Recurso não encontrado."): PublicError {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const raw =
    data && typeof data === "object" && "code" in data && typeof data.code === "string"
      ? data.code
      : null;
  const alias = raw !== null && Object.hasOwn(aliases, raw) ? aliases[raw] : undefined;
  if (alias)
    return {
      status: alias.status,
      error: { code: alias.code, message: alias.message, retryable: false },
    };
  const code = raw !== null && Object.hasOwn(statuses, raw) ? raw : "UNAVAILABLE";
  // Only a server-chosen dotted path, never free text from the domain error.
  const field =
    code !== "UNAVAILABLE" &&
    data &&
    typeof data === "object" &&
    "field" in data &&
    typeof data.field === "string" &&
    /^[A-Za-z][A-Za-z.]{0,79}$/.test(data.field)
      ? data.field
      : undefined;
  const missing =
    code === "NFSE_ROUTE_PROFILE_INCOMPLETE" &&
    data &&
    typeof data === "object" &&
    "missing" in data &&
    Array.isArray(data.missing) &&
    data.missing.length <= 10 &&
    data.missing.every((item) => typeof item === "string" && /^[A-Za-z]{1,40}$/.test(item))
      ? (data.missing as string[])
      : undefined;
  const nextAllowedAt =
    code === "SOURCE_COOLDOWN" &&
    data &&
    typeof data === "object" &&
    "nextAllowedAt" in data &&
    Number.isSafeInteger(data.nextAllowedAt) &&
    (data.nextAllowedAt as number) >= 0
      ? (data.nextAllowedAt as number)
      : undefined;
  return {
    status: statuses[code]!,
    error: {
      code,
      message: code === "NOT_FOUND" ? notFound : (messages[code] ?? fallback),
      retryable: code === "UNAVAILABLE" || code === "RATE_LIMITED" || code === "SOURCE_COOLDOWN",
      ...(field ? { field } : {}),
      ...(missing ? { missing } : {}),
      ...(nextAllowedAt !== undefined ? { nextAllowedAt } : {}),
    },
  };
}

/** The JSON error body every REST transport answers with, `X-Request-Id` included. */
export function errorJson(
  requestId: string,
  { status, error }: PublicError,
  headers: Record<string, string> = {},
) {
  return Response.json(
    { error, requestId },
    {
      status,
      headers: { ...headers, "X-Request-Id": requestId, "Cache-Control": "no-store" },
    },
  );
}

/** A transport refusal decided before the domain runs: same vocabulary, no domain context. */
export const refusal = (code: string) => publicError(new ConvexError({ code }));
