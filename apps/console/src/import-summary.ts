import { importBatchOutcome } from "../../../platform/convex/lib/importOutcome";

type Tone = "success" | "warning" | "danger" | "pending";
const plural = (count: number, one: string, many: string) => (count > 1 ? many : one);
/**
 * Counts and result of a batch. A refused, failed or paused file is what the Início lists as a
 * pending import; here the batch says "Falhou", "Pausada", "Parcial" next to imported files or,
 * while other files still run, "Requer atenção": the person acts now, not when the rest ends.
 */
export function batchSummary(files: Array<{ state: string; code: string | null }>) {
  const { counts: c, attention, state } = importBatchOutcome(files);
  const imported = c.imported + c.duplicate,
    failed = c.refused + c.failed;
  // Refused and failed apart, so each count matches its file badge ("XML recusado", "Falha").
  const parts = [
    imported ? `${imported} ${plural(imported, "importado", "importados")}` : "",
    c.caveat ? `${c.caveat} com ressalva` : "",
    c.refused ? `${c.refused} ${plural(c.refused, "recusado", "recusados")}` : "",
    c.failed ? `${c.failed} com falha` : "",
    c.paused ? `${c.paused} ${plural(c.paused, "pausado", "pausados")}` : "",
    c["not-sent"] ? `${c["not-sent"]} ${plural(c["not-sent"], "não enviado", "não enviados")}` : "",
    c.running ? `${c.running} em andamento` : "",
  ].filter(Boolean);
  const [tone, label]: [Tone, string] =
    state === "attention" && c.running
      ? ["warning", "Requer atenção"]
      : state === "running"
        ? ["pending", "Em andamento"]
        : attention && (imported || c.caveat)
          ? ["warning", "Parcial"]
          : failed
            ? ["danger", "Falhou"]
            : c.paused
              ? ["warning", "Pausada"]
              : c.caveat || c["not-sent"]
                ? [
                    "warning",
                    imported || c.caveat ? "Concluída com ressalva" : "Envio não concluído",
                  ]
                : ["success", "Concluída"];
  return { tone, label, detail: parts.join(" · ") || "Sem arquivos" };
}
