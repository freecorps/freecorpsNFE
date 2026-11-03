import type { ReactNode } from "react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import {
  PRIVACY_POLICY_ARCHIVE,
  PRIVACY_POLICY_VERSION,
} from "../../../platform/convex/lib/privacyPolicyArchive";
import {
  TERMS_OF_USE_ARCHIVE,
  TERMS_OF_USE_VERSION,
} from "../../../platform/convex/lib/termsOfUseArchive";
import { AuthLayout } from "./auth-layout";
import { BackLink, TermsText } from "./capture-terms";
import { formatIsoDate } from "./format";
import { archivedTermsOfUse } from "./terms-of-use";
import { CopyButton } from "./ui/copy-button";
import { Card, DescriptionList } from "./ui/layout";

/**
 * The privacy policy as archived (#428): `docs/termos/arquivo/<version>.md` is the only copy of
 * each text, and this page shows those bytes. `privacy-policy.test.tsx` fails if a file and its
 * hash (`PRIVACY_POLICY_ARCHIVE`) part ways.
 */
const files = import.meta.glob<string>(
  "../../../docs/termos/arquivo/politica-de-privacidade-*.md",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);
export const archivedPrivacyPolicy: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1, -3), text]),
);

type Archive = Readonly<Record<string, { sha256: string; since: string }>>;

/** The versions of an archive, newest first. */
const newestFirst = (archive: Archive) =>
  Object.entries(archive).sort(([, a], [, b]) => b.since.localeCompare(a.since));

/**
 * A public legal text (terms of use, privacy policy): outside the login, so that anyone reads it
 * before signing up, with the version, the SHA-256 of the archived file and the other versions.
 */
function PublicText({
  title,
  description,
  text,
  version,
  current,
  archive,
  href,
  voltar,
  other,
}: {
  title: string;
  description: string;
  text: string;
  version: string;
  current: string | null;
  archive: Archive;
  href: (version: string) => string;
  voltar: string | undefined;
  other: ReactNode;
}) {
  const archived = archive[version]!;
  const versions = newestFirst(archive);
  return (
    <AuthLayout>
      <article className="public-text ui-stack" aria-labelledby="public-text-title">
        <header className="public-text__header">
          <h1 id="public-text-title" className="auth-card__title">
            {title}
          </h1>
          <p className="ui-help">{description}</p>
          <nav className="ui-actions" aria-label="Textos legais">
            {voltar && <BackLink href={voltar} />}
            {other}
          </nav>
        </header>
        <Card>
          <TermsText text={text} />
        </Card>
        <Card title="Identificação do texto" headingLevel={2}>
          <div className="ui-stack">
            <DescriptionList
              items={[
                {
                  term: "Situação",
                  value:
                    version === current ? "Versão atual" : "Substituída por uma versão mais nova",
                },
                { term: "Publicada em", value: formatIsoDate(archived.since) },
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
              O hash é calculado sobre o arquivo docs/termos/arquivo/{version}.md, em UTF-8 com
              quebras de linha LF. Cada versão tem um texto só: um texto novo recebe outra versão.
            </p>
          </div>
        </Card>
        <Card title="Versões" headingLevel={2}>
          <ul className="public-text__versions">
            {versions.map(([name, entry]) => (
              <li key={name}>
                {name === version ? (
                  <span aria-current="page">{formatIsoDate(entry.since)}</span>
                ) : (
                  <a className="ui-link" href={href(name)}>
                    {formatIsoDate(entry.since)}
                  </a>
                )}{" "}
                <code>{name}</code>
                {name === current ? " (atual)" : ""}
              </li>
            ))}
          </ul>
        </Card>
      </article>
    </AuthLayout>
  );
}

function Missing({ what, current }: { what: string; current: ReactNode }) {
  return (
    <AuthLayout>
      <section className="auth-card" aria-labelledby="public-text-title">
        <h1 id="public-text-title" className="auth-card__title">
          Versão {what} não encontrada.
        </h1>
        <div className="auth-status">
          <p className="auth-card__description">Confira o endereço.</p>
          {current}
        </div>
      </section>
    </AuthLayout>
  );
}

const termsHref = (version: string) => `/termos/uso/${encodeURIComponent(version)}`;
const policyHref = (version: string) =>
  version === PRIVACY_POLICY_VERSION
    ? "/privacidade"
    : `/privacidade/${encodeURIComponent(version)}`;

/** One version of the terms of use, operator clause included, public. */
export function TermsOfUseVersion({ version, voltar }: { version: string; voltar?: string }) {
  const text = archivedTermsOfUse[version];
  if (text === undefined || TERMS_OF_USE_ARCHIVE[version] === undefined)
    return (
      <Missing
        what="dos termos de uso"
        current={
          TERMS_OF_USE_VERSION && (
            <Link className="ui-link" to="/termos">
              Ler os termos em vigor
            </Link>
          )
        }
      />
    );
  return (
    <PublicText
      title="Termos de uso"
      description={`Termos de uso de ${formatIsoDate(TERMS_OF_USE_ARCHIVE[version].since)}, com a cláusula de operadora, que um proprietário aceita no console para a organização.`}
      text={text}
      version={version}
      current={TERMS_OF_USE_VERSION}
      archive={TERMS_OF_USE_ARCHIVE}
      href={termsHref}
      voltar={voltar}
      other={
        <a className="ui-link" href="/privacidade">
          Política de privacidade
        </a>
      }
    />
  );
}

/** One version of the privacy policy, public. */
export function PrivacyPolicyVersion({ version }: { version: string }) {
  const text = archivedPrivacyPolicy[version];
  if (text === undefined || PRIVACY_POLICY_ARCHIVE[version] === undefined)
    return (
      <Missing
        what="da política de privacidade"
        current={
          <a className="ui-link" href="/privacidade">
            Ler a política em vigor
          </a>
        }
      />
    );
  return (
    <PublicText
      title="Política de privacidade"
      description={`Política de privacidade e retenção de dados de ${formatIsoDate(PRIVACY_POLICY_ARCHIVE[version].since)}.`}
      text={text}
      version={version}
      current={PRIVACY_POLICY_VERSION}
      archive={PRIVACY_POLICY_ARCHIVE}
      href={policyHref}
      voltar={undefined}
      other={
        TERMS_OF_USE_VERSION && (
          <a className="ui-link" href="/termos">
            Termos de uso
          </a>
        )
      }
    />
  );
}

/** `/termos`: the terms of use in effect. */
export function CurrentTermsOfUsePage() {
  if (!TERMS_OF_USE_VERSION) return <Missing what="dos termos de uso" current={null} />;
  return <TermsOfUseVersion version={TERMS_OF_USE_VERSION} />;
}

/**
 * `/termos/uso/<version>`: a version of the terms of use. Links from the console carry where they
 * were opened (`voltar`, checked like a login return), and "Voltar" brings the person back there.
 */
export function TermsOfUsePage() {
  const { version } = useParams({ from: "/termos/uso/$version" });
  const { voltar } = useSearch({ from: "/termos/uso/$version" });
  return <TermsOfUseVersion version={version} voltar={voltar} />;
}

/** `/privacidade`: the privacy policy in effect. */
export function CurrentPrivacyPolicyPage() {
  return <PrivacyPolicyVersion version={PRIVACY_POLICY_VERSION} />;
}

/** `/privacidade/<version>`: an earlier version of the privacy policy. */
export function PrivacyPolicyPage() {
  const { version } = useParams({ from: "/privacidade/$version" });
  return <PrivacyPolicyVersion version={version} />;
}
