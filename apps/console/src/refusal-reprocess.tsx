import { useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "./convex-query";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import { Button } from "./ui/button";
import { Callout } from "./ui/layout";
import { usageFailure, type UsageOrg } from "./usage-errors";
import { codeLabel } from "./operation-labels";

/** The children `status` counts: `STATUS_LIMIT` in `platform/convex/refusalReprocess.ts`. */
const STATUS_LIMIT = 200;

type Status = NonNullable<FunctionReturnType<typeof api.refusalReprocess.status>>;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const outcomes = (status: Status) =>
  `${count(status.reprocessed, "entrou", "entraram")} no histórico da nota, ` +
  `${count(status.stillRefused, "continua recusado", "continuam recusados")}` +
  (status.failed ? `, ${count(status.failed, "não concluiu", "não concluíram")}` : "");

const stateLabels: Partial<Record<Status["state"], string>> = {
  paused: "pausada",
  failed: "falhou",
};
/** The reason in Portuguese: the code's label, or the state's when there is no code. */
const reason = (status: Status) =>
  status.code ? codeLabel(status.code) : (stateLabels[status.state] ?? "sem motivo registrado");
/** A new request opens another run, which only picks what is left. */
const again = " Um novo pedido abre outra execução, que pega só o que sobrou.";

/**
 * What the request became, from the persisted state only: the search for the originals, then
 * each reprocessing. "Concluído" needs the run finished, every child read and none pending.
 */
export function refusalProgress(status: Status): {
  tone: "info" | "danger";
  text: string;
  /** Where the link goes: this run, or the operations still handling skipped originals. */
  link?: "run" | "operations";
} {
  const held = status.busy
    ? ` ${count(status.busy, "original segue", "originais seguem")} com uma operação anterior, que ainda trabalha nele${status.busy === 1 ? "" : "s"}.`
    : "";
  if (status.state === "paused" && status.live)
    return {
      tone: "danger",
      text: `A busca está pausada. Motivo: ${reason(status)}. Ela pode ser retomada em Operação e suporte.`,
      link: "run",
    };
  if (!status.done && !status.live)
    return {
      tone: "danger",
      text: `A busca parou e não pode ser retomada. Motivo: ${reason(status)}.${again}`,
      link: "run",
    };
  if (!status.done)
    return {
      tone: "info",
      text: `Pedido registrado. Procurando originais recusados por uma versão anterior do leitor: ${count(status.requested, "enviado", "enviados")} para reprocessamento até agora.${held}`,
    };
  if (status.requested === 0 && status.busy)
    return {
      tone: "info",
      text: `Nada novo para reprocessar agora.${held} Acompanhe em Operação e suporte e peça de novo quando ela terminar.`,
      link: "operations",
    };
  if (status.requested === 0)
    return { tone: "info", text: "Nada restou para reprocessar nesta empresa e ambiente." };
  if (status.partial)
    return {
      tone: status.failed ? "danger" : "info",
      text: `${status.requested} originais enviados para reprocessamento. Contagem parcial, dos ${STATUS_LIMIT} primeiros: ${outcomes(status)}, ${status.pending} em andamento.`,
      ...(status.failed ? { link: "run" as const } : {}),
    };
  if (status.pending > 0)
    return {
      tone: "info",
      text: `Reprocessando: ${status.reprocessed + status.stillRefused + status.failed} de ${count(status.requested, "original concluído", "originais concluídos")}.${held}`,
    };
  return {
    tone: status.failed ? "danger" : "info",
    text: `Concluído: ${outcomes(status)}.${held}${status.failed ? again : ""}`,
    ...(status.failed ? { link: "run" as const } : {}),
  };
}

/**
 * Reprocessing of the technical refusals (#499) of the company and environment. Whoever reads the
 * documents sees the progress; the button is only for who may ask (`canRequest`), and only when
 * no run is live: while one is, asking again would return it.
 */
export function RefusalReprocess({
  org,
  scope,
  canRequest,
}: {
  org: UsageOrg;
  scope: FunctionArgs<typeof api.refusalReprocess.request>;
  canRequest: boolean;
}) {
  const request = useMutation(api.refusalReprocess.request);
  const status = useQuery(api.refusalReprocess.status, scope);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<ReactNode>("");
  const progress = status ? refusalProgress(status) : null;
  const operationLink =
    status && progress?.link ? (
      <Link
        className="ui-link"
        to="/app/$organizationSlug/operations"
        params={{ organizationSlug: org.slug }}
        search={progress.link === "run" ? { ref: status.operationId } : {}}
      >
        Abrir em Operação e suporte
      </Link>
    ) : null;
  return (
    <div className="fiscal-action">
      <p className="ui-help">
        Eventos de tipo ainda não aceito e leiautes fora do catálogo ficam recusados com o original
        preservado. Depois de uma atualização do leitor de NF-e, reprocesse essas recusas: a nova
        leitura entra no histórico da nota e a recusa anterior continua registrada.
      </p>
      {canRequest && (status === null || status?.live === false) ? (
        <Button
          loading={busy}
          onClick={() => {
            setBusy(true);
            setError("");
            void request(scope)
              .catch((failure: unknown) =>
                setError(
                  usageFailure(
                    failure,
                    org,
                    "Não foi possível pedir o reprocessamento. Tente novamente; o pedido não se repete.",
                  ),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          Reprocessar recusas técnicas
        </Button>
      ) : null}
      {/* One live region for every state, so a change of tone is still announced. */}
      <div role="status">
        {progress ? (
          progress.tone === "danger" ? (
            <Callout tone="danger">
              <p>{progress.text}</p>
              {operationLink ? <p>{operationLink}</p> : null}
            </Callout>
          ) : (
            <>
              <p className="ui-help">{progress.text}</p>
              {operationLink ? <p className="ui-help">{operationLink}</p> : null}
            </>
          )
        ) : null}
      </div>
      {canRequest && status?.live ? (
        <p className="ui-help">
          Enquanto esta execução não termina, pedir de novo devolve a mesma execução.
        </p>
      ) : null}
      {error ? (
        <Callout tone="danger" role="alert">
          <p>{error}</p>
        </Callout>
      ) : null}
    </div>
  );
}
