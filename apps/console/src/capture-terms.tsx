import type { MouseEvent, ReactNode } from "react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  CAPTURE_TERMS_ARCHIVE,
  CAPTURE_TERMS_REACCEPT_DAYS,
  CAPTURE_TERMS_VERSION,
} from "../../../platform/convex/lib/fiscalCaptureRelease";
import { formatIsoDate } from "./format";
import { Notice } from "./route-errors";
import { safeRedirect } from "./session-handoff";
import { buttonClass } from "./ui/button";
import { CopyButton } from "./ui/copy-button";
import { Card, DescriptionList, Page, PageHeader } from "./ui/layout";

/**
 * The capture terms as archived (#428): `docs/termos/arquivo/<version>.md` is the only copy of each
 * text, and the console shows those bytes. The server keeps the SHA-256 of each version
 * (`CAPTURE_TERMS_ARCHIVE`) and records it with the release; `capture-terms.test.tsx` fails if a
 * file and its hash part ways.
 */
const files = import.meta.glob<string>("../../../docs/termos/arquivo/captura-fiscal-*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
export const archivedTerms: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1, -3), text]),
);
export const termsPath = (version: string) => `docs/termos/arquivo/${version}.md`;

/** "22/10/2026": the day the version started being asked for, how people name the terms. */
export const termsDate = (version: string) => {
  const since = CAPTURE_TERMS_ARCHIVE[version]?.since;
  return since ? formatIsoDate(since) : null;
};
/**
 * Where the version stands: the one asked for new releases, or replaced on the day the next one
 * started, holding for the releases made before it until the deadline to accept the next one
 * (#428). `null` for a version the archive does not know.
 */
export function termsStanding(
  version: string,
  archive: typeof CAPTURE_TERMS_ARCHIVE = CAPTURE_TERMS_ARCHIVE,
  current: string = CAPTURE_TERMS_VERSION,
) {
  if (!archive[version]) return null;
  if (version === current) return "Em vigor para novas ativações";
  const versions = Object.entries(archive).sort(([, a], [, b]) => a.since.localeCompare(b.since));
  const next = versions[versions.findIndex(([name]) => name === version) + 1];
  if (!next) return "Substituída; vale para as ativações feitas antes, até o novo aceite";
  // The last day of the period to accept the next version (#428), counted from its `since`.
  const lastDay = new Date(
    Date.parse(`${next[1].since}T12:00:00Z`) + (CAPTURE_TERMS_REACCEPT_DAYS - 1) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return `Substituída em ${formatIsoDate(next[1].since)}; vale para as ativações feitas antes até ${formatIsoDate(lastDay)}, prazo para aceitar a nova`;
}

type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };
/**
 * The archived texts use paragraphs, one per line, lists of "- " items and, in the longer ones
 * (terms of use, privacy policy), section titles: a block of one line "## Title". Anything else
 * (another title level, emphasis, a link, an indented line) would show here as raw marks, so it
 * throws: the tests read every archived file through this function.
 */
export function termsBlocks(text: string): Block[] {
  return text
    .trimEnd()
    .split(/\n{2,}/)
    .map((block) => {
      const heading = /^## ([^\s#*_`<>[\]][^\n#*_`<>[\]]*)$/.exec(block);
      if (heading) return { kind: "heading", text: heading[1]! };
      const lines = block.split("\n");
      const unsupported = lines.find((line) => /^\s|^#|^\d+[.)]\s|[*_`<>[\]]/.test(line));
      if (unsupported !== undefined)
        throw new Error(`Termos com marcação não suportada: ${unsupported}`);
      const items = lines.filter((line) => line.startsWith("- "));
      if (items.length === lines.length)
        return { kind: "list", items: items.map((line) => line.slice(2)) };
      if (items.length) throw new Error(`Lista misturada com parágrafo: ${block}`);
      return { kind: "paragraph", text: lines.join(" ") };
    });
}

/** The text of the terms; a paragraph that opens a list stays with it, as one lead. */
export function TermsText({ text }: { text: string }) {
  const blocks = termsBlocks(text);
  const shown: ReactNode[] = [];
  const render = (block: Block, key: number) =>
    block.kind === "heading" ? (
      <h2 key={key} className="capture-terms__heading">
        {block.text}
      </h2>
    ) : block.kind === "paragraph" ? (
      <p key={key}>{block.text}</p>
    ) : (
      <ul key={key}>
        {block.items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    );
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!,
      next = blocks[i + 1];
    if (block.kind === "paragraph" && next?.kind === "list") {
      shown.push(
        <div className="capture-terms__lead" key={i}>
          {render(block, 0)}
          {render(next, 1)}
        </div>,
      );
      i++;
    } else shown.push(render(block, i));
  }
  return <div className="capture-terms">{shown}</div>;
}

/**
 * Link to the archived text of a version, on its own page. The page is outside the organization,
 * so the link carries where it was opened (`voltar`), and "Voltar" brings the person back there.
 */
export function TermsLink({ version, children }: { version: string; children: ReactNode }) {
  const here = safeRedirect(window.location.pathname + window.location.search);
  return (
    <Link
      className="ui-link"
      to="/termos/captura-fiscal/$version"
      params={{ version }}
      search={here ? { voltar: here } : {}}
    >
      {children}
    </Link>
  );
}

/** Back to where the terms were opened from, in the app; a deep link goes to the organizations. */
export function BackLink({ href }: { href: string | undefined }) {
  const navigate = useNavigate();
  const target = href ?? "/app";
  return (
    <a
      className={buttonClass({ variant: "ghost" })}
      href={target}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        void navigate({ href: target });
      }}
    >
      {href ? "Voltar" : "Ir para as organizações"}
    </a>
  );
}

/**
 * `/termos/captura-fiscal/<version>`: the archived text of a version of the capture terms, with
 * its SHA-256, for whoever wants to read again what the company accepted. Behind the login, like
 * the rest of the console; not a public page.
 */
export function CaptureTermsPage() {
  const { version } = useParams({ from: "/authenticated/termos/captura-fiscal/$version" });
  const { voltar } = useSearch({ from: "/authenticated/termos/captura-fiscal/$version" });
  const text = archivedTerms[version],
    archived = CAPTURE_TERMS_ARCHIVE[version];
  if (text === undefined || archived === undefined)
    return (
      <Notice
        title="Versão dos termos não encontrada."
        action={<TermsLink version={CAPTURE_TERMS_VERSION}>Ler os termos em vigor</TermsLink>}
      >
        Confira o endereço. Os termos em vigor são os de {termsDate(CAPTURE_TERMS_VERSION)}.
      </Notice>
    );
  return (
    <Page>
      <PageHeader
        title="Termos da captura fiscal"
        description={`Termos de ${termsDate(version)}, como o console os mostra a quem ativa a captura fiscal de uma empresa.`}
        actions={<BackLink href={voltar} />}
      />
      <div className="gestao-narrow-page ui-stack">
        <Card>
          <TermsText text={text} />
        </Card>
        <Card title="Identificação do texto" headingLevel={2}>
          <div className="ui-stack">
            <DescriptionList
              items={[
                { term: "Situação", value: termsStanding(version) },
                { term: "Versão", value: <code>{version}</code> },
                {
                  term: "SHA-256 do texto",
                  value: (
                    <span className="gestao-reference capture-terms__hash">
                      <code>{archived.sha256}</code>
                      <CopyButton
                        value={archived.sha256}
                        label="Copiar SHA-256 do texto"
                        iconOnly
                      />
                    </span>
                  ),
                },
              ]}
            />
            <p className="ui-help">
              O hash é calculado sobre o arquivo {termsPath(version)}, em UTF-8 com quebras de linha
              LF. Cada versão tem um texto só: um texto novo recebe outra versão.
            </p>
          </div>
        </Card>
      </div>
    </Page>
  );
}
