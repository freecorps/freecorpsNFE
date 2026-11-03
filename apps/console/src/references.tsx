import { useState, type ReactNode, type FormEvent } from "react";
import { useQuery } from "./convex-query";
import { ConvexError } from "convex/values";
import { ErrorBoundary } from "./route-errors";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { ReferenceDataset } from "@freecorps/contracts/references";
import type { Organization } from "./organizations";
import { CompanyContext, rememberedCompany } from "./company-context";
import {
  Button,
  Callout,
  Card,
  DescriptionList,
  EmptyState,
  FormField,
  Input,
  Page,
  PageHeader,
  Select,
  SkeletonBlock,
  StatusBadge,
  controlProps,
} from "./ui";

const labels = {
  valid: "Vigente na data consultada",
  out_of_validity: "Fora de vigência",
  validity_unknown: "Vigência não informada para esta data",
  not_found: "Código inexistente nesta versão",
};
/**
 * A failed consultation, until the next one: another query, page or retry (`resetKey`) forgets
 * it, without remounting the result while nothing failed.
 */
function ReferenceError({
  children,
  retry,
  resetKey,
}: {
  children: ReactNode;
  retry: () => void;
  resetKey: string;
}) {
  return (
    <ErrorBoundary
      resetKey={resetKey}
      fallback={(error) => {
        const data = error instanceof ConvexError ? error.data : null;
        const code = data && typeof data === "object" && "code" in data ? data.code : null;
        const unavailable = code === "REFERENCE_UNAVAILABLE";
        return (
          <Callout
            tone={unavailable ? "warning" : "danger"}
            role="alert"
            headingLevel={2}
            title={
              unavailable ? "Tabela ainda indisponível" : "Não foi possível consultar a tabela"
            }
            actions={
              <Button icon="arrowRight" onClick={retry}>
                Tentar novamente
              </Button>
            }
          >
            <p>
              {unavailable
                ? "Nenhuma versão completa foi publicada. Tente novamente após a atualização."
                : "Confira sua conexão e o acesso à empresa. Os dados anteriores não confirmam esta consulta."}
            </p>
          </Callout>
        );
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
export function References({ org, contextKey }: { org: Organization; contextKey: string }) {
  // No company in this route's URL: the choice stays in the screen and in the remembered context.
  // The choice belongs to one organization: another organization starts from its own memory,
  // even if this screen is not remounted.
  const [choice, setChoice] = useState(() => ({
    organizationId: org.id,
    companyId: rememberedCompany(org.id),
  }));
  const companyId = choice.organizationId === org.id ? choice.companyId : rememberedCompany(org.id);
  const setCompanyId = (id: string) => setChoice({ organizationId: org.id, companyId: id });
  return (
    <Page>
      <PageHeader
        eyebrow="Tabelas auxiliares"
        title="Municípios e NCM"
        description="Pesquise códigos e descrições com a fonte e a versão utilizadas. A presença de um código não determina imposto devido nem regularidade fiscal."
      />
      <CompanyContext
        org={org}
        contextKey={contextKey}
        selected={companyId}
        onSelect={setCompanyId}
        id="reference-company"
        label="Empresa da consulta"
        need="company"
      >
        {(company) => (
          <Search
            key={`${contextKey}:${company.id}`}
            organizationId={org.id}
            companyId={company.id}
            contextKey={contextKey}
          />
        )}
      </CompanyContext>
    </Page>
  );
}
type Scope = {
  organizationId: Id<"organizations">;
  companyId: Id<"companies">;
  contextKey: string;
};
function Search(scope: Scope) {
  const [dataset, setDataset] = useState<ReferenceDataset>("municipalities");
  const [search, setSearch] = useState({
    date: new Date().toISOString().slice(0, 10),
    text: "",
    exact: false,
  });
  const [cursor, setCursor] = useState<string | undefined>();
  const [retry, setRetry] = useState(0);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const date = form.get("date"),
      text = form.get("q");
    setSearch({
      date: typeof date === "string" ? date : "",
      text: typeof text === "string" ? text.trim() : "",
      exact: form.get("mode") === "exact",
    });
    setCursor(undefined);
  }
  const queryHelp = `Busca por início da descrição, sem distinguir maiúsculas ou acentos. Código exato usa ${dataset === "ncm" ? "8" : "7"} dígitos, sem pontuação.`;
  return (
    <>
      <Card title="Consulta">
        <form className="fiscal-filters" onSubmit={submit} key={dataset}>
          <FormField id="reference-dataset" label="Tabela">
            <Select
              id="reference-dataset"
              value={dataset}
              onChange={(e) => {
                setDataset(e.target.value as ReferenceDataset);
                setSearch({ ...search, text: "", exact: false });
                setCursor(undefined);
              }}
            >
              <option value="municipalities">Municípios</option>
              <option value="ncm">NCM</option>
            </Select>
          </FormField>
          <FormField id="reference-mode" label="Tipo de pesquisa">
            <Select id="reference-mode" name="mode">
              <option value="prefix">Início do código ou da descrição</option>
              <option value="exact">Código exato</option>
            </Select>
          </FormField>
          <div className="fiscal-filters__wide">
            <FormField id="reference-query" label="Código ou descrição" help={queryHelp}>
              <Input
                {...controlProps("reference-query", undefined, queryHelp)}
                name="q"
                maxLength={100}
              />
            </FormField>
          </div>
          <FormField id="reference-date" label="Data de referência">
            <Input
              id="reference-date"
              name="date"
              type="date"
              defaultValue={search.date}
              required
            />
          </FormField>
          <div className="fiscal-filters__actions">
            <Button variant="primary" type="submit" icon="search">
              Pesquisar
            </Button>
          </div>
        </form>
      </Card>
      <ReferenceError
        resetKey={`${dataset}:${JSON.stringify(search)}:${cursor ?? ""}:${retry}`}
        retry={() => setRetry(retry + 1)}
      >
        <Results {...scope} dataset={dataset} search={search} cursor={cursor} next={setCursor} />
      </ReferenceError>
    </>
  );
}
function Results({
  dataset,
  search,
  cursor,
  next,
  ...scope
}: Scope & {
  dataset: ReferenceDataset;
  search: { date: string; text: string; exact: boolean };
  cursor?: string;
  next: (cursor: string | undefined) => void;
}) {
  const result = useQuery(api.references.search, {
    ...scope,
    dataset,
    date: search.date,
    ...(search.exact ? { code: search.text } : { q: search.text, cursor, limit: 20 }),
  });
  if (result === undefined)
    return (
      <Card>
        <SkeletonBlock label="Consultando a tabela…" lines={4} />
      </Card>
    );
  const rows =
    "page" in result
      ? result.page
      : result.entry
        ? [{ ...result.entry, status: result.status }]
        : [];
  const { manifest } = result;
  const more = "nextCursor" in result && result.nextCursor ? result.nextCursor : null;
  return (
    <div aria-live="polite">
      <Card label="Resultado da consulta">
        <div className="fiscal-stack">
          <div className="fiscal-reference-head">
            <h2 className="ui-card__title">
              {dataset === "ncm" ? "Nomenclatura Comum do Mercosul" : "Municípios brasileiros"}
            </h2>
            <DescriptionList
              items={[
                {
                  term: "Fonte",
                  value: (
                    <a
                      className="ui-link"
                      href={manifest.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {manifest.source}
                    </a>
                  ),
                },
                { term: "Versão", value: <span className="ui-mono">{manifest.version}</span> },
                {
                  term: "Data consultada",
                  value: <span className="fiscal-num">{result.date}</span>,
                },
                {
                  term: "Versão na fonte",
                  value: <span className="ui-mono">{manifest.sourceVersion}</span>,
                },
                {
                  term: "Coleta",
                  value: <span className="fiscal-num">{manifest.retrievedAt}</span>,
                },
              ]}
            />
          </div>
          {manifest.coverage === "snapshot" ? (
            <Callout tone="info">
              Esta fonte retrata {manifest.asOf}. Ela não comprova a vigência em outras datas nem
              contém todo o histórico de códigos.
            </Callout>
          ) : null}
          {!rows.length ? (
            <EmptyState
              icon="search"
              headingLevel={3}
              title={
                "status" in result
                  ? labels[result.status]
                  : "Nenhum resultado para esta pesquisa nesta versão."
              }
              description="Confira o código, a tabela e a data de referência."
            />
          ) : (
            <ul className="fiscal-list">
              {rows.map((row) => (
                <li key={row.code} className="fiscal-item">
                  <div className="fiscal-item__head">
                    <span className="ui-mono fiscal-reference-item__code">{row.code}</span>
                    <StatusBadge tone={row.status === "out_of_validity" ? "warning" : "neutral"}>
                      {labels[row.status]}
                    </StatusBadge>
                  </div>
                  <h3 className="fiscal-item__title">{row.description}</h3>
                  <p className="fiscal-meta">
                    {row.state ? <span>UF: {row.state}</span> : null}
                    <span>
                      Início: <span className="fiscal-num">{row.validFrom ?? "não informado"}</span>
                    </span>
                    <span>
                      Fim: <span className="fiscal-num">{row.validTo ?? "não informado"}</span>
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          )}
          {cursor || more ? (
            <nav aria-label="Páginas do resultado" className="ui-pagination">
              {cursor ? (
                <Button size="sm" icon="arrowLeft" onClick={() => next(undefined)}>
                  Voltar ao início
                </Button>
              ) : null}
              {more ? (
                <Button size="sm" onClick={() => next(more)}>
                  Próxima página
                </Button>
              ) : null}
            </nav>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
