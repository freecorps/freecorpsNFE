import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../platform/convex/_generated/api";
import type { CompanyScope } from "./company-context";
import { DownloadFeedback, useTicketDownload } from "./product-components";
import { Button } from "./ui/button";
import { CodeBlock } from "./ui/code-block";

export const kindLabels: Record<string, string> = {
  invoice: "NF-e completa",
  "service-invoice": "NFS-e importada",
  summary: "Resumo",
  event: "Evento",
  "event-summary": "Resumo de evento",
};
/**
 * The preserved original of a document version or of a file without a document: download it, or
 * read it as text on the page. Documents and the import page share it.
 */
export function Original({
  scope,
  artifactId,
  available,
  kind,
}: {
  scope: CompanyScope;
  artifactId: string;
  available: boolean;
  kind: string;
}) {
  const ticket = useMutation(api.documentDownloads.ticket);
  const download = useTicketDownload();
  const [xml, setXml] = useState<string | null>(null);
  const [last, setLast] = useState<"save" | "show">("save");
  async function read(save: boolean) {
    setLast(save ? "save" : "show");
    if (!save) setXml(null);
    const blob = await download.start(() => ticket({ ...scope, artifactId }), {
      name: "original.xml",
      label: "original",
      save,
    });
    if (blob && !save) setXml(await blob.text());
  }
  return (
    <>
      {kind === "unknown" ? (
        <p className="ui-help">
          XML sem documento reconhecido. O original foi preservado sem presumir situação fiscal.
        </p>
      ) : kind === "service-invoice" ? (
        <p className="ui-help">
          O download preserva o XML original completo, incluindo todas as NFS-e do lote.
        </p>
      ) : kind !== "invoice" ? (
        <p className="ui-help">
          O original é um {kindLabels[kind]?.toLowerCase()}. Não contém o XML completo da nota.
        </p>
      ) : null}
      {available ? (
        <div className="ui-actions">
          <Button
            size="sm"
            icon="download"
            disabled={download.busy}
            onClick={() => void read(true)}
          >
            Baixar original
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="code"
            disabled={download.busy}
            onClick={() => void read(false)}
          >
            Exibir XML como texto
          </Button>
        </div>
      ) : (
        <p className="ui-help">Arquivo original indisponível.</p>
      )}
      <DownloadFeedback state={download.state} onRetry={() => void read(last === "save")} />
      {xml !== null ? <CodeBlock label="XML original">{xml}</CodeBlock> : null}
    </>
  );
}
