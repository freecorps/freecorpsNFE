import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Callout, type Tone } from "./ui/layout";
import {
  isUsageCode,
  notesQuotaReason,
  usageAudience,
  usageErrorCode,
  usageMessagesFor,
  type UsageOrg,
} from "./usage-messages";

// The texts and codes live in `usage-messages.ts`, without React; this module adds the notice
// with the link to Uso e limites.
export {
  isUsageCode,
  notesQuotaReason,
  usageAudience,
  usageErrorCode,
  usageErrorMessage,
  usageMessages,
  usageMessagesFor,
  type UsageAudience,
  type UsageOrg,
} from "./usage-messages";
/**
 * A orientação de cota sem moldura, para caber no aviso de cada tela: o texto pelo papel e,
 * para o gestor, o link para Uso e limites. Sem `org`, o texto neutro e nenhum link. Não
 * renderiza nada para outros códigos. `reason` vem antes, quando a recusa diz qual limite foi
 * (a cota de notas, `notesQuotaReason`).
 */
export function UsageGuidance({
  code,
  org,
  reason,
}: {
  code: string | null | undefined;
  org?: UsageOrg;
  reason?: string | undefined;
}) {
  if (!isUsageCode(code)) return null;
  const audience = org ? usageAudience(org) : undefined;
  return (
    <>
      {reason ? `${reason} ` : null}
      {usageMessagesFor(audience)[code]}
      {org && audience === "manager" && code !== "TERMS_OF_USE_REQUIRED" ? (
        <>
          {" "}
          <Link
            className="ui-link"
            to="/app/$organizationSlug/usage"
            params={{ organizationSlug: org.slug }}
          >
            Abrir Uso e limites
          </Link>
        </>
      ) : null}
    </>
  );
}
/**
 * Para telas que guardam a falha como conteúdo do próprio aviso: a orientação pelo papel quando o
 * erro é de cota ou vigência; senão, `fallback`.
 */
export function usageFailure(error: unknown, org: UsageOrg | undefined, fallback: ReactNode) {
  const code = usageErrorCode(error);
  return isUsageCode(code) ? (
    <UsageGuidance code={code} org={org} reason={notesQuotaReason(error)} />
  ) : (
    fallback
  );
}
/**
 * Aviso de falha pronto para as telas. Erro (ou `code` persistido) de cota ou vigência: a
 * orientação pelo papel. Outros erros: `fallback`, no mesmo aviso; sem ele, nada.
 */
export function UsageErrorNotice({
  error,
  code = usageErrorCode(error),
  org,
  fallback,
  tone = "danger",
  announce = true,
}: {
  error?: unknown;
  code?: string | null;
  org?: UsageOrg;
  fallback?: ReactNode;
  tone?: Exclude<Tone, "neutral">;
  /** `false` quando o aviso recebe o foco (`ActionFailure`): o foco já o lê, sem um alerta a mais. */
  announce?: boolean;
}) {
  const usage = isUsageCode(code);
  if (!usage && !fallback) return null;
  return (
    <Callout tone={tone} role={announce && tone === "danger" ? "alert" : undefined}>
      {usage ? <UsageGuidance code={code} org={org} reason={notesQuotaReason(error)} /> : fallback}
    </Callout>
  );
}
