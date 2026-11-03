import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { api } from "../../../platform/convex/_generated/api";
import { useQuery } from "./convex-query";
import type { CompanyScope } from "./company-context";
import { Original } from "./document-original";
import { formatDateTime } from "./format";
import { importCodeMessages } from "./import-messages";
import type { UsageOrg } from "./usage-messages";
import { RefusalReprocess } from "./refusal-reprocess";
import { buttonClass } from "./ui/button";
import { Disclosure } from "./ui/disclosure";
import { Callout, Card, SkeletonBlock } from "./ui/layout";
import { CursorPager, firstPage } from "./ui/pagination";

/** The anchor of the section in the import page, for the notice of the documents list. */
export const refusedFilesAnchor = "arquivos-recusados";

/** "3 arquivos", "20+ arquivos": the count of `documents.unclassifiedCount`, bounded. */
function filesLabel({ count, more }: { count: number; more: boolean }) {
  return `${count}${more ? "+" : ""} ${count === 1 && !more ? "arquivo" : "arquivos"}`;
}

/**
 * Files kept without a recognized document (unknown schema, invalid identity, another company's
 * XML, a capture envelope), with the reason in the person's words, the original and the code for
 * support. Shown only when there is one: an empty section would only take room. Owners and admins
 * also get the reprocessing of technical refusals of an earlier reader.
 */
export function RefusedFiles({ org, scope }: { org: UsageOrg; scope: CompanyScope }) {
  const [cursor, setCursor] = useState(firstPage);
  const count = useQuery(api.documents.unclassifiedCount, scope);
  const shown = !!count?.count;
  const result = useQuery(
    api.documents.unclassified,
    shown ? { ...scope, cursor: cursor.current, limit: 5 } : "skip",
  );
  // The same check as the request, also in Production of the site; the server repeats it.
  const canRequest = useQuery(api.refusalReprocess.canRequest, shown ? scope : "skip");
  // Whoever reads the company's documents in the console follows the progress too.
  const canRead = useQuery(api.refusalReprocess.canRead, shown ? scope : "skip");
  // The notice of the documents list links here: the section shows only after the count
  // answers, so the browser's own jump to the anchor came too early. Once, on arrival.
  const section = useRef<HTMLElement>(null),
    arrived = useRef(false);
  const loaded = !!result;
  useEffect(() => {
    if (!loaded || arrived.current || window.location.hash !== `#${refusedFilesAnchor}`) return;
    arrived.current = true;
    section.current?.scrollIntoView?.({ block: "start" });
  }, [loaded]);
  if (!count || !shown) return null;
  return (
    <section id={refusedFilesAnchor} ref={section} className="fiscal-refused">
      <Card
        title="Arquivos recusados"
        description={`${filesLabel(count)} recebidos sem documento reconhecido, de importações ou da captura. O original e o diagnóstico ficam guardados; nenhuma situação fiscal é presumida.`}
      >
        <div className="fiscal-stack">
          {canRead ? (
            <RefusalReprocess org={org} scope={scope} canRequest={canRequest === true} />
          ) : null}
          {!result ? (
            <SkeletonBlock label="Carregando arquivos recusados…" lines={2} />
          ) : (
            <>
              <ul className="fiscal-import-results">
                {result.page.map((file) => (
                  <li key={file.id} className="fiscal-import-file">
                    <div className="fiscal-import-file__head">
                      <h3 className="fiscal-item__title fiscal-import-file__name">{file.name}</h3>
                      <span className="fiscal-note">
                        Recebido em {formatDateTime(file.importedAt)}
                      </span>
                    </div>
                    <p className="fiscal-refused__reason">
                      {importCodeMessages[file.code] ?? "O arquivo não virou documento"}
                    </p>
                    <p className="fiscal-note">
                      Código para suporte: <span className="ui-mono">{file.code}</span>
                    </p>
                    <div className="fiscal-import-file__details">
                      <Disclosure summary="Original e SHA-256">
                        <p className="fiscal-note">
                          SHA-256 <code className="ui-mono">{file.sha256}</code>
                        </p>
                        <Original
                          scope={scope}
                          artifactId={file.id}
                          kind="unknown"
                          available={file.originalAvailable}
                        />
                      </Disclosure>
                    </div>
                  </li>
                ))}
              </ul>
              {!result.page.length ? <p className="ui-help">Nenhum arquivo nesta página.</p> : null}
              <CursorPager
                label="Páginas de arquivos recusados"
                cursor={cursor}
                nextCursor={result.nextCursor}
                onChange={setCursor}
              />
            </>
          )}
        </div>
      </Card>
    </section>
  );
}

/** Only opaque ids in the key and a time as the value, like the remembered environment tab. */
const dismissKey = (scope: CompanyScope) =>
  `fnfe:console-refused-notice:${scope.organizationId}:${scope.companyId}:${scope.environment}`;

/** When the newest refused file was when the person closed the notice, in this browser. */
function dismissedAt(scope: CompanyScope): number | null {
  try {
    const value = Number(localStorage.getItem(dismissKey(scope)));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function dismiss(scope: CompanyScope, latestAt: number) {
  try {
    localStorage.setItem(dismissKey(scope), String(latestAt));
  } catch {
    // Without storage the notice stays closed until the page reloads.
  }
}

/**
 * In the documents list, in place of the files themselves: a notice that shows up only when there
 * are refused files, and leads to where they are listed: the import page, or, for a capture's
 * refusals in an environment that page does not read, the company's Captura tab. Closing it is
 * per company and environment, in this browser: it comes back when a newer file is refused,
 * never for the ones the person already saw.
 */
export function RefusedNotice({
  org,
  scope,
  place,
}: {
  org: UsageOrg;
  scope: CompanyScope;
  place: "imports" | "capture";
}) {
  const count = useQuery(api.documents.unclassifiedCount, scope);
  const [closedAt, setClosedAt] = useState(() => dismissedAt(scope));
  if (!count?.count || count.latestAt === null) return null;
  if (closedAt !== null && count.latestAt <= closedAt) return null;
  const latestAt = count.latestAt;
  return (
    <Callout
      tone="info"
      dismissLabel="Fechar aviso de arquivos recusados"
      onDismiss={() => {
        dismiss(scope, latestAt);
        setClosedAt(latestAt);
      }}
      actions={
        place === "imports" ? (
          <Link
            to="/app/$organizationSlug/imports"
            params={{ organizationSlug: org.slug }}
            search={{ company: scope.companyId }}
            hash={refusedFilesAnchor}
            className={buttonClass({ size: "sm" })}
          >
            Ver arquivos recusados
          </Link>
        ) : (
          <Link
            to="/app/$organizationSlug/companies/$companyId"
            params={{ organizationSlug: org.slug, companyId: scope.companyId }}
            search={{ aba: "captura" }}
            hash={refusedFilesAnchor}
            className={buttonClass({ size: "sm" })}
          >
            Ver arquivos recusados
          </Link>
        )
      }
    >
      <p>
        {filesLabel(count)}{" "}
        {count.count === 1 && !count.more ? "recebido não virou" : "recebidos não viraram"}{" "}
        documento.{" "}
        {place === "imports"
          ? "O original e o motivo ficam na página de importação."
          : "O original e o motivo ficam na captura da empresa."}
      </p>
    </Callout>
  );
}
