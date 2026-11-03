import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import { useQuery } from "./convex-query";
import { useCompanyChoice } from "./company-context";
import type { ProductEnvironment } from "./deployment";
import { documentName, FiscalStatusLabel } from "./document-labels";
import { formatBRL, formatShortDateTime } from "./format";
import { batchSummary } from "./import-summary";
import type { Organization } from "./organizations";
import { FormField, Select } from "./ui/form";
import { Card, SkeletonBlock, StatusBadge, type Tone } from "./ui/layout";

/** How many rows of each list the Início shows; the full list is one click away. */
const SHOWN = 5;
const badgeTone = (tone: ReturnType<typeof batchSummary>["tone"]): Tone =>
  tone === "pending" ? "neutral" : tone;
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/**
 * What arrived last in one company: the newest documents and imports, each a link to its own
 * page. The company is the one the fiscal screens remember for the organization (or the only
 * one); with several, the person switches here and the next screen opens on the same one.
 */
export function HomeRecent({
  org,
  contextKey,
  environment,
}: {
  org: Organization;
  contextKey: string;
  environment: ProductEnvironment;
}) {
  const [selected, setSelected] = useState("");
  const choice = useCompanyChoice(org, contextKey, selected);
  const company = choice.company;
  const companies = choice.companies.results;
  const readable =
    !!company?.canRead && !(company.kind === "demonstration" && environment === "production");
  const scope = readable ? { organizationId: org.id, companyId: company.id, environment } : null;
  const documents = useQuery(
    api.documents.list,
    scope && org.capabilities.readDocuments ? { ...scope, cursor: null, limit: SHOWN } : "skip",
  );
  const imports = useQuery(
    api.imports.recent,
    scope && org.capabilities.operateDocuments ? scope : "skip",
  );
  if (!org.capabilities.readDocuments) return null;
  // Nothing chosen and nothing to choose from: the task above already says what is missing.
  if (company === null && !choice.loading && companies.length === 0) return null;
  const params = { organizationSlug: org.slug };
  return (
    <section className="ui-section home-recent" aria-labelledby="home-recent-title">
      <div className="ui-section__header home-recent__header">
        <div>
          <h2 id="home-recent-title" className="ui-section__title">
            Recentes
          </h2>
          <p className="ui-section__description">
            {company ? `O que chegou por último em ${company.name}.` : "O que chegou por último."}
          </p>
        </div>
        {companies.length > 1 ? (
          <div className="home-recent__company">
            <FormField id="home-recent-company" label="Empresa">
              <Select
                id="home-recent-company"
                value={company?.id ?? ""}
                onChange={(event) => setSelected(event.target.value)}
              >
                {company ? null : <option value="">Escolha uma empresa</option>}
                {companies.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
        ) : null}
      </div>
      {company === null && !choice.loading ? (
        <Card>
          <p className="home-item__note">
            Escolha uma empresa para ver os documentos e as importações mais recentes dela.
          </p>
        </Card>
      ) : company && !readable ? (
        <Card>
          <p className="home-item__note">
            {company.canRead
              ? "A empresa de demonstração não tem documentos em Produção."
              : "Seu papel não lê os documentos desta empresa."}
          </p>
        </Card>
      ) : (
        <div className="home-recent__grid">
          <Card
            flush
            title="Últimos documentos"
            actions={
              company ? (
                <Link
                  className="ui-link"
                  to="/app/$organizationSlug/documents"
                  params={params}
                  search={{ company: company.id }}
                >
                  Ver todos <span aria-hidden="true">→</span>
                </Link>
              ) : undefined
            }
          >
            {!documents || !company ? (
              <div className="home-recent__body">
                <SkeletonBlock label="Carregando os documentos…" lines={3} />
              </div>
            ) : documents.page.length === 0 ? (
              <p className="home-recent__empty">Nenhum documento recebido nesta empresa ainda.</p>
            ) : (
              <ul className="home-recent__list">
                {documents.page.map((doc) => (
                  <li key={doc.id}>
                    <div>
                      <Link
                        className="home-recent__link"
                        to="/app/$organizationSlug/documents"
                        params={params}
                        search={{ company: company.id, env: environment, document: doc.id }}
                      >
                        {documentName(doc)}
                      </Link>
                      <p className="home-item__note">
                        {[doc.issuer, doc.total ? formatBRL(doc.total) : null]
                          .filter(Boolean)
                          .join(" · ") || "Emitente não informado"}
                      </p>
                    </div>
                    <div className="home-recent__meta">
                      <FiscalStatusLabel status={doc.fiscalStatus} />
                      <span className="home-item__note">{formatShortDateTime(doc.importedAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {org.capabilities.operateDocuments ? (
            <Card
              flush
              title="Últimas importações"
              actions={
                company ? (
                  <Link
                    className="ui-link"
                    to="/app/$organizationSlug/imports"
                    params={params}
                    search={{ company: company.id }}
                  >
                    Importar XML <span aria-hidden="true">→</span>
                  </Link>
                ) : undefined
              }
            >
              {!imports || !company ? (
                <div className="home-recent__body">
                  <SkeletonBlock label="Carregando as importações…" lines={3} />
                </div>
              ) : imports.length === 0 ? (
                <p className="home-recent__empty">Nenhuma importação nesta empresa ainda.</p>
              ) : (
                <ul className="home-recent__list">
                  {imports.slice(0, SHOWN).map((batch) => {
                    const summary = batchSummary(batch.files);
                    return (
                      <li key={batch.id}>
                        <div>
                          <Link
                            className="home-recent__link"
                            to="/app/$organizationSlug/imports"
                            params={params}
                            search={{ company: company.id, batch: batch.id as Id<"imports"> }}
                          >
                            {batch.files.length} {plural(batch.files.length, "arquivo", "arquivos")}{" "}
                            em {formatShortDateTime(batch.createdAt)}
                          </Link>
                          <p className="home-item__note">{summary.detail}</p>
                        </div>
                        <div className="home-recent__meta">
                          <StatusBadge tone={badgeTone(summary.tone)}>{summary.label}</StatusBadge>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          ) : null}
        </div>
      )}
    </section>
  );
}
