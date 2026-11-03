import type * as External from "@freecorps/contracts/external";
import { webhookEvents, webhookToleranceMs } from "@freecorps/contracts/webhooks";
import openapi from "../../../../docs/v1.0/openapi.json";

// The guides name real operations. Reading them from the versioned OpenAPI
// keeps the copy honest: a renamed operation fails the build instead of
// quietly shipping a stale example. `.server` keeps this module, and the
// 500 KB OpenAPI it imports, out of the browser bundle: only route loaders,
// which run at build time, read it.
type Parameter = { in: string; name: string; schema?: { maximum?: number; enum?: string[] } };
type Operation = {
  operationId: string;
  parameters?: Parameter[];
  "x-scope"?: string;
  "x-retry-policy"?: string;
};
type OpenApi = {
  info: { version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: { Error: ErrorSchema } };
};
type ErrorSchema = { properties: { error: { properties: { code: { enum: string[] } } } } };

const api = openapi as unknown as OpenApi;

export const contractVersion = api.info.version;

export const operations = Object.entries(api.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => ({
    method: method.toUpperCase(),
    path,
    operationId: op.operationId,
    scope: op["x-scope"] ?? "-",
    retry: op["x-retry-policy"] ?? "-",
    pageLimit: op.parameters?.find((p) => p.in === "query" && p.name === "limit")?.schema?.maximum,
  })),
);

export const environments = Array.from(
  new Set(
    Object.values(api.paths).flatMap((methods) =>
      Object.values(methods).flatMap(
        (op) => op.parameters?.find((p) => p.name === "X-Environment")?.schema?.enum ?? [],
      ),
    ),
  ),
);

const pageLimits = operations.flatMap((op) => (op.pageLimit ? [op.pageLimit] : []));
export const largestPage = Math.max(...pageLimits);
export const smallestPage = Math.min(...pageLimits);

// Each public error code needs its HTTP status and a sentence for integrators.
// The mapped type fails type checking when the contract gains a code or
// changes a status. The import is type-only: the build loads this module in
// Node, outside the bundler, and must not execute the zod contract.
type Code = keyof typeof External.publicErrorStatus;
const errorMeaning: { [K in Code]: [(typeof External.publicErrorStatus)[K], string] } = {
  INVALID_API_KEY: [401, "Chave ausente, inválida, revogada, expirada ou de projeto desativado."],
  SCOPE_DENIED: [403, "A chave ou a concessão da empresa não inclui o escopo da operação."],
  ENVIRONMENT_DENIED: [403, "O ambiente do header não é o ambiente da chave."],
  NOT_FOUND: [404, "Recurso inexistente ou fora do alcance desta chave. Não revela qual dos dois."],
  INVALID_REQUEST: [400, "Corpo, headers ou parâmetros fora do schema da operação."],
  INVALID_QUERY: [400, "Query com campo desconhecido, repetido ou valor inválido."],
  INVALID_CURSOR: [400, "Cursor alterado, expirado ou de outra consulta. Recomece a paginação."],
  INVALID_PAGINATION: [400, "Limite de página fora do intervalo aceito pela rota."],
  IDEMPOTENCY_CONFLICT: [409, "A mesma Idempotency-Key já foi usada com outro conteúdo."],
  RATE_LIMITED: [429, "Limite de chamadas atingido. Respeite Retry-After antes de repetir."],
  UNAVAILABLE: [
    503,
    "Indisponibilidade temporária. Repita com backoff; o pedido pode ter sido aceito.",
  ],
  INVALID_FILE: [400, "Arquivo malformado ou diferente do declarado na reserva."],
  FILE_TOO_LARGE: [413, "Arquivo acima do limite por arquivo da importação."],
  UPLOAD_EXPIRED: [409, "Ticket ou reserva vencidos antes do envio ou da confirmação."],
  ALREADY_ACCEPTED: [409, "O arquivo já foi aceito. Consulte a importação; nada foi desfeito."],
  ORIGINAL_UNAVAILABLE: [404, "Não há original disponível para download neste artefato."],
  DANFE_UNAVAILABLE: [
    409,
    "O documento não tem DANFE: só a NF-e modelo 55 com o XML completo, aceito pelo gerador, tem. Baixe o XML original.",
  ],
  OPERATION_CONFLICT: [409, "O estado atual da operação não permite essa ação."],
  RECONCILIATION_REQUIRED: [
    409,
    "O resultado de uma tentativa anterior é incerto. A operação aguarda reconciliação.",
  ],
  ATTEMPTS_EXHAUSTED: [409, "A operação esgotou as tentativas automáticas e ficou pausada."],
  RECOVERY_BUDGET_EXHAUSTED: [
    409,
    "A recuperação automática esgotou seu orçamento e ficou pausada.",
  ],
  ACCESS_REVOKED: [409, "A concessão mudou depois do pedido. A ação não foi executada."],
  ENDPOINT_LIMIT: [409, "A empresa já tem o máximo de destinos de webhook neste ambiente."],
  ENDPOINT_CHANGED: [409, "O destino mudou desde a versão informada. Releia e tente de novo."],
  ROTATION_IN_PROGRESS: [409, "Já existe uma rotação de segredo em coexistência."],
  ORGANIZATION_ARCHIVED: [
    409,
    "Organização em arquivo econômico: dados fiscais e novas operações esperam a reativação. Não é falta de permissão.",
  ],
  STREAM_CONFLICT: [409, "A captura desta empresa e ambiente já tem outro responsável."],
  CAPTURE_PAUSED: [409, "A captura está pausada."],
  SOURCE_COOLDOWN: [
    409,
    "A Receita só aceita a próxima consulta depois de um intervalo. Retome a partir de error.nextAllowedAt, sem repetir em laço.",
  ],
  CERTIFICATE_UNAVAILABLE: [409, "Não há certificado ativo e válido para a captura ou a emissão."],
  CAPTURE_DEMONSTRATION_DENIED: [400, "Empresas de demonstração não usam captura autorizada."],
  ISSUANCE_PRODUCTION_DISABLED: [403, "A emissão em produção não foi liberada para a empresa."],
  ISSUANCE_DEMONSTRATION_DENIED: [400, "Empresas de demonstração não emitem NFS-e."],
  NFSE_PROFILE_REQUIRED: [409, "A empresa ainda não tem perfil NFS-e."],
  NFSE_ACTIVITY_NOT_FOUND: [400, "A atividade não está no perfil NFS-e vigente."],
  NFSE_ROUTE_UNSUPPORTED: [
    409,
    "Sem canal de emissão suportado para município, regime e data, ou exportação que já exige o grupo IBS/CBS.",
  ],
  NFSE_ROUTE_PROFILE_INCOMPLETE: [
    409,
    "O canal do município ou o IBS/CBS exige dados ausentes do perfil.",
  ],
  ISSUANCE_FIELD_INVALID: [400, "Campo do pedido inválido; `field` indica qual."],
  ISSUANCE_TAKER_DOCUMENT_INVALID: [400, "CPF ou CNPJ do tomador com dígito inválido."],
  ISSUANCE_TAKER_NIF_INVALID: [400, "Tomador estrangeiro precisa de NIF ou do motivo da ausência."],
  ISSUANCE_TAKER_INVALID: [400, "Mercado interno exige tomador nacional."],
  ISSUANCE_EXPORT_TAKER_REQUIRED: [400, "Exportação exige tomador estrangeiro."],
  ISSUANCE_EXPORT_CURRENCY_REQUIRED: [400, "Exportação exige moeda estrangeira."],
  ISSUANCE_CURRENCY_INVALID: [400, "Mercado interno exige valor em BRL."],
  ISSUANCE_CURRENCY_UNSUPPORTED: [400, "Moeda fora de BRL, USD, CAD, EUR e GBP."],
  ISSUANCE_AMOUNT_INVALID: [400, "Valor não positivo ou com mais de duas casas."],
  ISSUANCE_ISS_RATE_INVALID: [400, "Alíquota de ISS fora de (0, 5] ou com mais de quatro casas."],
  ISSUANCE_ISS_RATE_REQUIRED: [400, "Não optante ou retenção exigem alíquota de ISS."],
  ISSUANCE_ISS_RATE_NOT_ALLOWED: [400, "Optante do Simples sem retenção não informa alíquota."],
  ISSUANCE_ISS_NOT_LEVIED: [400, "Exportação de serviço não tem ISS."],
  ISSUANCE_WITHHOLDING_INVALID: [400, "Retenção na exportação ou com tomador CPF."],
  ISSUANCE_COMPETENCE_INVALID: [400, "Competência fora de AAAA-MM."],
  ISSUANCE_COMPETENCE_FUTURE: [400, "Competência posterior ao mês da emissão."],
  ISSUANCE_DATE_INVALID: [400, "Data de emissão fora de AAAA-MM-DD."],
  ISSUANCE_DATE_FUTURE: [400, "Data de emissão futura."],
  ISSUANCE_ISSUER_EMAIL_REQUIRED: [400, "Sem e-mail do prestador no pedido nem no perfil NFS-e."],
  DPS_NUMBER_EXHAUSTED: [409, "A série DPS chegou ao último número."],
  CANCEL_REASON_INVALID: [400, "Motivo do cancelamento com menos de 15 ou mais de 255 caracteres."],
  ISSUANCE_NOT_CANCELLABLE: [409, "Só uma NFS-e autorizada pode ser cancelada."],
  ISSUANCE_TRANSPORT_CHANGED: [409, "O cancelamento precisa do transporte que autorizou a nota."],
};

const declaredCodes = api.components.schemas.Error.properties.error.properties.code.enum;
export const errors = declaredCodes.map((code) => {
  if (!(code in errorMeaning)) throw new Error(`Código de erro sem descrição: ${code}`);
  const [status, meaning] = errorMeaning[code as Code];
  return { code, status, meaning };
});

export const events = webhookEvents;
export const toleranceMinutes = webhookToleranceMs / 60_000;

// What a page marked `contract: true` receives from its loader. The MDX
// components render from this object (see components/contract.tsx).
export const contractData = () => ({
  version: contractVersion,
  operations,
  environments,
  smallestPage,
  largestPage,
  errors,
  events: [...events],
  toleranceMinutes,
});
export type ContractData = ReturnType<typeof contractData>;
