import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import { formatIsoDate, todayInBrasilia } from "./format";
import { Button, buttonClass } from "./ui/button";
import { Callout } from "./ui/layout";

type Standing = NonNullable<FunctionReturnType<typeof api.archiveNotice.status>>;

/** The day the organization may be frozen, in Brasília, whatever the browser's time zone. */
export const archiveDate = (eligibleAt: number) => formatIsoDate(todayInBrasilia(eligibleAt));

function failure(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code =
    data && typeof data === "object" && "code" in data && typeof data.code === "string"
      ? data.code
      : null;
  if (code === "RATE_LIMITED") return "Muitas tentativas. Aguarde um minuto e tente novamente.";
  if (code === "ACCESS_DENIED")
    return "Só um proprietário ou administrador mantém a organização ativa.";
  if (code === "ARCHIVE_NOTICE_NOT_FOUND")
    return "Este aviso já terminou. Recarregue a página para ver a situação atual.";
  if (code === "PLAN_RENEWAL_REQUIRED")
    return "Este aviso é de plano pago. Renove o plano em Uso e limites, na seção Cobrança.";
  if (code === "ORGANIZATION_ARCHIVING" || code === "ORGANIZATION_ARCHIVED")
    return "O arquivamento já começou. Fale com o suporte para reativar a organização.";
  return "Não foi possível concluir. Confira sua conexão e tente novamente.";
}

/**
 * The archive notice of an open organization (ADR 0009, §1), for every member while it is
 * pending: the day it may be archived, what archiving does and the one action that avoids it.
 * Owners and admins keep a Free organization active here or renew a paid plan in Uso e limites;
 * the server decides who can.
 */
export function ArchiveNotice({
  organizationId,
  slug,
}: {
  organizationId: Id<"organizations">;
  slug: string;
}) {
  const standing = useQuery(api.archiveNotice.status, { organizationId });
  if (!standing) return null;
  if (standing.state !== "notice") return <ArchivedCallout standing={standing} />;
  return <ArchiveNoticeCallout organizationId={organizationId} slug={slug} standing={standing} />;
}

/**
 * The organization in cold custody (ADR 0009, §3), from the freeze to the end of the
 * rehydration: since when, why, what stops and the way back, without suggesting it resumes now.
 * Reactivation and the assisted export go through support until the console offers them.
 */
export function ArchivedCallout({ standing }: { standing: Standing }) {
  const archived = standing.state === "archived";
  const restoring = standing.state === "restoring";
  const title = restoring
    ? "Reativação da organização em curso."
    : archived && standing.archivedAt !== null
      ? `Organização arquivada desde ${archiveDate(standing.archivedAt)}.`
      : "Arquivamento da organização em curso.";
  return (
    <div className="gestao-closure">
      <Callout tone="warning" role="status" title={title}>
        <p>
          {standing.reason === "free_inactive"
            ? "A organização ficou 90 dias sem atividade no plano Gratuito."
            : "O período pago do plano terminou sem renovação."}{" "}
          Os dados fiscais vão para uma guarda fria cifrada, pelo mesmo prazo de guarda. Até a
          reativação, ficam parados a consulta de documentos, as importações, as capturas e a
          emissão.
        </p>
        <p>
          Continuam disponíveis os membros e convites, as chaves de API, os certificados, as
          conexões e os webhooks, para revogar ou desligar
          {archived ? ", e o plano em Uso e limites" : ""}.
        </p>
        <p>
          {restoring
            ? "Os dados estão voltando da guarda fria. A organização volta a operar quando a reativação terminar; ela não é imediata."
            : `Para ${archived ? "reativar a organização ou " : ""}receber uma cópia dos dados pela exportação assistida, um proprietário ou administrador fala com o suporte. A reativação não é imediata.`}
        </p>
      </Callout>
    </div>
  );
}

export function ArchiveNoticeCallout({
  organizationId,
  slug,
  standing,
}: {
  organizationId: Id<"organizations">;
  slug: string;
  standing: Standing;
}) {
  const keepActive = useMutation(api.archiveNotice.keepActive);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const free = standing.reason === "free_inactive";
  const date = archiveDate(standing.eligibleAt);
  const action = !standing.canAct ? null : free ? (
    <Button
      variant="primary"
      loading={busy}
      loadingLabel="Registrando…"
      onClick={async () => {
        setBusy(true);
        setError("");
        try {
          await keepActive({ organizationId, runId: standing.runId });
        } catch (caught) {
          setError(failure(caught));
        } finally {
          setBusy(false);
        }
      }}
    >
      Manter ativa
    </Button>
  ) : (
    <Link
      className={buttonClass({ variant: "primary" })}
      to="/app/$organizationSlug/usage"
      params={{ organizationSlug: slug }}
    >
      Renovar o plano
    </Link>
  );
  return (
    <div className="gestao-closure">
      <Callout
        tone="warning"
        role="status"
        title={`Organização pode ser arquivada a partir de ${date}.`}
        actions={action}
      >
        <p>
          {free
            ? "A organização está há 90 dias sem atividade no plano Gratuito."
            : "O período pago do plano terminou sem renovação."}{" "}
          No arquivamento, param as importações, as capturas e a emissão, e os dados fiscais vão
          para uma guarda fria cifrada, pelo mesmo prazo de guarda; a consulta passa a ser por
          exportação assistida, e a reativação não é imediata. Com a captura de NF-e parada, alguns
          documentos podem não estar mais disponíveis na Receita quando a organização voltar.
        </p>
        <p>
          {standing.canAct
            ? free
              ? "Manter ativa cancela o aviso, e o prazo de 90 dias recomeça."
              : "Renovar o plano em Uso e limites, na seção Cobrança, cancela o aviso."
            : "Um proprietário ou administrador pode evitar o arquivamento."}
        </p>
        {error && (
          <p className="ui-error-text" role="alert">
            {error}
          </p>
        )}
      </Callout>
    </div>
  );
}

type SandboxStanding = NonNullable<FunctionReturnType<typeof api.sandboxClosure.status>>;

function sandboxFailure(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code =
    data && typeof data === "object" && "code" in data && typeof data.code === "string"
      ? data.code
      : null;
  if (code === "SANDBOX_CLOSURE_NOTICE_NOT_FOUND")
    return "Este aviso já terminou. Recarregue a página para ver a situação atual.";
  if (code === "ORGANIZATION_CLOSED")
    return "A organização já foi encerrada. Recarregue a página para ver a situação atual.";
  return failure(error);
}

/**
 * The notice before Freecorps closes an open organization that only ever had Sandbox and is idle
 * for 90 days (ADR 0009, decision 2 of 29/10/2026), for every member while it is pending. Owners
 * and admins keep it active here; the server decides who can.
 */
export function SandboxClosureNotice({ organizationId }: { organizationId: Id<"organizations"> }) {
  const standing = useQuery(api.sandboxClosure.status, { organizationId });
  if (!standing) return null;
  return <SandboxClosureCallout organizationId={organizationId} standing={standing} />;
}

export function SandboxClosureCallout({
  organizationId,
  standing,
}: {
  organizationId: Id<"organizations">;
  standing: SandboxStanding;
}) {
  const keepActive = useMutation(api.sandboxClosure.keepActive);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const date = archiveDate(standing.closeAt);
  const action = standing.canAct ? (
    <Button
      variant="primary"
      loading={busy}
      loadingLabel="Registrando…"
      onClick={async () => {
        setBusy(true);
        setError("");
        try {
          await keepActive({ organizationId, noticeId: standing.noticeId });
        } catch (caught) {
          setError(sandboxFailure(caught));
        } finally {
          setBusy(false);
        }
      }}
    >
      Manter ativa
    </Button>
  ) : null;
  return (
    <div className="gestao-closure">
      <Callout
        tone="warning"
        role="status"
        title={`Organização será encerrada a partir de ${date}.`}
        actions={action}
      >
        <p>
          Esta organização só tem dados de Sandbox e está sem uso há 90 dias. A partir de {date}, a
          Freecorps vai encerrá-la. Os dados do Sandbox não têm validade fiscal: depois do
          encerramento, a exportação fica disponível por 30 dias e, em seguida, eles são apagados. A
          conta de cada pessoa continua.
        </p>
        <p>
          {standing.canAct
            ? "Manter ativa cancela o encerramento, e o prazo de 90 dias recomeça."
            : "Um proprietário ou administrador pode manter a organização ativa."}
        </p>
        {error && (
          <p className="ui-error-text" role="alert">
            {error}
          </p>
        )}
      </Callout>
    </div>
  );
}
