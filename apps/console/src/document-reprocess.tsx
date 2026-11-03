import { useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { useQuery } from "./convex-query";
import type { FunctionArgs } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import { Button } from "./ui/button";
import { Callout } from "./ui/layout";
import { usageFailure, type UsageOrg } from "./usage-errors";

export function Reprocess({
  org,
  scope,
  documentId,
}: {
  /** Who reads a quota or plan refusal: managers get the link to Uso e limites. */
  org: UsageOrg;
  scope: Omit<FunctionArgs<typeof api.documents.reprocess>, "documentId" | "key">;
  documentId: string;
}) {
  const run = useMutation(api.documents.reprocess);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [operationId, setOperationId] = useState<Id<"operations"> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<ReactNode>("");
  const operation = useQuery(api.operations.get, operationId ? { operationId } : "skip");
  const terminal = operation?.state === "succeeded" || operation?.state === "failed";
  const labels: Record<string, string> = {
    queued: "na fila",
    running: "em andamento",
    succeeded: "concluído",
    failed: "falhou",
    paused: "pausado",
    retry_wait: "aguardando nova tentativa",
    reconciling: "em reconciliação",
  };
  return (
    <div className="fiscal-action">
      <Button
        loading={busy}
        disabled={Boolean(operationId) && !terminal}
        onClick={() => {
          const requestKey = terminal ? crypto.randomUUID() : key;
          if (terminal) {
            setKey(requestKey);
            setOperationId(null);
          }
          setBusy(true);
          setError("");
          void run({ ...scope, documentId, key: requestKey })
            .then((result) => setOperationId(result.operationId))
            .catch((failure: unknown) =>
              setError(
                usageFailure(
                  failure,
                  org,
                  "Não foi possível iniciar. Tente novamente para recuperar a mesma solicitação.",
                ),
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        Reprocessar XML atual
      </Button>
      {operation ? (
        <p role="status" className="ui-help">
          Reprocessamento: {labels[operation.state] ?? operation.state}.
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
