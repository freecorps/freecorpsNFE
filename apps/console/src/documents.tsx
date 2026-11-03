import { useEffect, useRef, useState, type FormEvent } from "react";
import { ExportDocument } from "./exports";
import { useMutation } from "convex/react";
import { useQuery } from "./convex-query";
import { usePrewarm } from "./prewarm";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import {
  fiscalStatuses,
  nfePaymentMeansLabelsSource,
  type FiscalStatus,
} from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import { useContent } from "./content";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { Organization } from "./organizations";
import { environmentNames, useDeployment, type ProductEnvironment } from "./deployment";
import { useProductEnvironment } from "./product-environment";
import { companyScope } from "./page-queries";
import { Reprocess } from "./document-reprocess";
import { useFiscalRead } from "./fiscal-read";
import { kindLabels, Original } from "./document-original";
import { documentName, FiscalStatusLabel, statusLabels } from "./document-labels";
import { RefusedFiles, RefusedNotice } from "./refused-files";
import {
  CopyButton,
  CursorPager,
  DownloadFeedback,
  firstPage,
  type PageCursor,
  saveBlob,
  ScopeSteps,
  useListPosition,
  useTicketDownload,
} from "./product-components";
import { CompanyContext, useCompanyChoice, type CompanyScope } from "./company-context";
import {
  formatBRL,
  formatCnpj,
  formatDateTime,
  formatDecimal,
  formatIsoDate,
  groupKey,
  shortKey,
} from "./format";
import { Button, buttonClass } from "./ui/button";
import { CodeBlock } from "./ui/code-block";
import { DataTable } from "./ui/data-table";
import { Disclosure } from "./ui/disclosure";
import { FormField, Input, Select } from "./ui/form";
import {
  Callout,
  Card,
  DescriptionList,
  DisabledReason,
  EmptyState,
  Page,
  PageHeader,
  SkeletonBlock,
  StatusBadge,
} from "./ui/layout";
import { Tabs } from "./ui/tabs";

type Scope = CompanyScope;
type Search = {
  company?: string;
  document?: string;
  version?: string;
  status?: string;
  key?: string;
  from?: string;
  to?: string;
  source?: string;
  /**
   * The environment the links inside were written in (ADR 0007); one other than the shell's
   * says so and offers the switch.
   */
  env?: "sandbox" | "production";
  /** Only the NF-e that arrived as the summary, without items (#433). */
  completeness?: "summary";
  /** Rows per page of the list: 20 when absent; the server reads at most 50. */
  perPage?: "50";
};
type Detail = FunctionReturnType<typeof api.documentContentNode.documentDetailRead>;
type Listed = FunctionReturnType<typeof api.documents.list>["page"][number];
const sourceLabels = { "imported-xml": "Importação", "distribution-xml": "Distribuição" } as const;
/** Long form of the origin, shared by the filter and the document data. */
const sourceDescriptions = {
  "imported-xml": "XML importado",
  "distribution-xml": "Distribuição NF-e",
} as const;
/**
 * An NF-e that arrived only as the distribution summary (`resNFe`): no items, taxes per item,
 * transport or payment. The source releases the full XML once the recipient registers its
 * acknowledgement; the capture does not manifest.
 */
function SummaryOnly() {
  return (
    <Callout tone="info" title="Só o resumo da nota" headingLevel={3}>
      <p>
        A distribuição entregou o resumo: emitente, data, valor e situação, sem os itens, os
        impostos por item, o transporte e o pagamento. A Receita pode liberar o XML completo depois
        que a empresa destinatária registra a Ciência da Operação, em geral pelo ERP ou pelo
        contador. Com a captura ativa, o XML completo pode chegar numa das consultas seguintes e
        substituir este resumo.
      </p>
    </Callout>
  );
}
export function Documents({ org, contextKey }: { org: Organization; contextKey: string }) {
  const search = useSearch({ strict: false }) as Search,
    navigate = useNavigate();
  function change(value: Search, options: { resetScroll?: boolean } = {}) {
    void navigate({
      to: "/app/$organizationSlug/documents",
      params: { organizationSlug: org.slug },
      search: value,
      ...options,
    });
  }
  // A document opens on its own page: the list's title, steps and picker give way to it.
  const detail = !!search.document;
  const choice = useCompanyChoice(org, contextKey, search.company ?? "");
  const deployment = useDeployment();
  const chosen = useProductEnvironment().environment;
  // The environment of the open company's list or document, for the title (#433).
  const [shownEnvironment, setShownEnvironment] = useState<ProductEnvironment | null>(null);
  // The list waits for the server to confirm the company; its first page is asked meanwhile,
  // so both answers arrive together. A company the member cannot open answers only the
  // confirmation, which says so; the list is never shown for it.
  usePrewarm(
    api.documents.list,
    deployment.confirmed && choice.candidate && !detail && choice.company === undefined
      ? documentListArgs(
          companyScope(
            org.id,
            choice.candidate as Id<"companies">,
            deployment.environment === "production" ? "production" : chosen,
          ),
          search,
          firstPage.current,
        )
      : "skip",
  );
  return (
    <Page>
      {detail ? (
        <nav className="fiscal-back" aria-label="Voltar">
          <Button
            variant="link"
            icon="arrowLeft"
            // Filters stay in the URL; only the document and its version leave it. The list
            // comes back where it was.
            onClick={() =>
              change(
                {
                  ...search,
                  // The list of the document's environment, whatever the tab rule would pick.
                  env: shownEnvironment ?? search.env,
                  document: undefined,
                  version: undefined,
                },
                { resetScroll: false },
              )
            }
          >
            Voltar à lista de documentos
          </Button>
        </nav>
      ) : (
        <div className="fiscal-stack">
          <PageHeader
            eyebrow={`Documentos / ${environmentNames[shownEnvironment ?? chosen]}`}
            title="Documentos fiscais"
            description="Consulte os XMLs importados, seus itens e as evidências fiscais preservadas."
            actions={
              <Link
                to="/app/$organizationSlug/imports/danfe"
                params={{ organizationSlug: org.slug }}
                className={buttonClass()}
              >
                Consultar pelo DANFE
              </Link>
            }
          />
          {/* The steps guide the choice of a company; once it is made they would only repeat
              the picker below. */}
          {choice.candidate && choice.company !== null ? null : (
            <ScopeSteps company={false} finalLabel="Consultar documentos" />
          )}
        </div>
      )}
      <CompanyContext
        org={org}
        contextKey={contextKey}
        selected={search.company ?? ""}
        onSelect={(company) => change({ company })}
        id="documents-company"
        label="Empresa dos documentos"
        picker={!detail}
        choice={choice}
      >
        {(company, scope) => (
          // Another company is another context: its list, document and readings start over.
          // Filters, pages and the open document are the same context and only re-render.
          <DocumentEnvironments
            key={`${contextKey}:${company.id}`}
            org={org}
            companyName={company.name}
            scope={scope}
            search={search}
            change={change}
            onEnvironment={setShownEnvironment}
          />
        )}
      </CompanyContext>
    </Page>
  );
}
/**
 * The documents of the environment chosen in the shell (ADR 0007, §1): Produção holds what the
 * fiscal capture received, for a company whose capture was released. A company without Produção
 * says so there and lists nothing. A link that names the other environment (`env=`, written by
 * every link inside, a bookmark or a shared address) does not move the console by itself: it
 * says which environment it is from and offers the switch.
 */
function DocumentEnvironments(props: {
  org: Organization;
  companyName: string;
  scope: Scope;
  search: Search;
  change: (search: Search, options?: { resetScroll?: boolean }) => void;
  onEnvironment: (environment: ProductEnvironment | null) => void;
}) {
  const { scope, search, onEnvironment } = props;
  const { environment: chosen, offered, choose } = useProductEnvironment();
  const release = useQuery(api.captureRelease.status, {
    organizationId: scope.organizationId,
    companyId: scope.companyId,
  });
  // A production deployment (#50) already reads production only.
  const environment = scope.environment === "production" ? "production" : chosen;
  const served = environment === scope.environment || (!!release && release.state !== "none");
  useEffect(() => {
    onEnvironment(environment);
    return () => onEnvironment(null);
  }, [environment, onEnvironment]);
  if (search.env && search.env !== environment && scope.environment !== "production")
    return (
      <Callout tone="info" title={`Endereço de ${environmentNames[search.env]}`} headingLevel={3}>
        <p>
          Este endereço abre documentos de {environmentNames[search.env]}, e o console está em{" "}
          {environmentNames[environment]}.
        </p>
        {offered?.includes(search.env) ? (
          <Button onClick={() => choose(search.env!)}>
            Trocar para {environmentNames[search.env]}
          </Button>
        ) : null}
      </Callout>
    );
  // Neither environment is prepared before the release answers, so none is read by mistake.
  if (environment !== scope.environment && !release)
    return <SkeletonBlock label="Carregando documentos…" lines={4} />;
  if (!served)
    return (
      <Callout tone="info">
        <p>
          {props.companyName} não tem documentos em Produção: a captura fiscal nunca foi ativada
          para ela. Ative em Empresas › Captura, ou troque para o Sandbox na lateral.
        </p>
      </Callout>
    );
  return (
    <DocumentScope
      {...props}
      scope={{ ...scope, environment }}
      search={{ ...search, env: environment }}
    />
  );
}
function DocumentScope({
  org,
  companyName,
  scope,
  search,
  change,
}: {
  org: Organization;
  companyName: string;
  scope: Scope;
  search: Search;
  change: (search: Search, options?: { resetScroll?: boolean }) => void;
}) {
  const initialize = useMutation(api.documentProjection.initialize),
    [error, setError] = useState("");
  const { organizationId, companyId, environment } = scope;
  const detail = !!search.document;
  const list = useListPosition(!detail);
  useEffect(() => {
    let active = true;
    void initialize({ organizationId, companyId, environment }).catch(() => {
      if (active) setError("Não foi possível preparar a consulta. Confira seu acesso.");
    });
    return () => {
      active = false;
    };
  }, [initialize, organizationId, companyId, environment]);
  if (error)
    return (
      <Callout tone="danger" role="alert">
        <p>{error}</p>
      </Callout>
    );
  return (
    <>
      {/* The list stays mounted under an open document, so its page, filters and scroll are
          there when the person comes back. */}
      {list.mounted ? (
        <div hidden={detail}>
          <DocumentList
            org={org}
            scope={scope}
            search={search}
            change={change}
            open={(document) => {
              list.leave();
              change({ ...search, document, version: undefined });
            }}
          />
        </div>
      ) : null}
      {detail ? (
        <DocumentDetail
          // Another document or version is another record: its tabs, pages and readings start over.
          key={`${search.document}:${search.version ?? ""}`}
          org={org}
          scope={scope}
          companyName={companyName}
          search={search}
          change={change}
        />
      ) : null}
    </>
  );
}
const listSources = ["imported-xml", "distribution-xml"] as const;
const pageSizes = [20, 50] as const;
/** The list's filters as the URL carries them; `invalid` when the list cannot be asked. */
function listFilters(search: Search) {
  const status = fiscalStatuses.includes(search.status as FiscalStatus)
    ? (search.status as FiscalStatus)
    : undefined;
  const from = search.from ? Date.parse(`${search.from}T00:00:00Z`) : undefined,
    to = search.to ? Date.parse(`${search.to}T23:59:59.999Z`) : undefined;
  const invalid =
    (from !== undefined && !Number.isFinite(from)) ||
    (to !== undefined && (!Number.isFinite(to) || to < (from ?? 0))) ||
    (!!search.key &&
      !(
        /^[0-9A-Z]{44}$/.test(search.key) ||
        /^nfse:[0-9]{7}:[0-9]{14}:[A-Za-z0-9.%_-]*:[0-9]{1,15}$/.test(search.key)
      ));
  return { status, from, to, invalid };
}
/**
 * `documents.list` for the company, filters and page. Shared by the list and by the page, which
 * asks for the first page ahead while the server confirms the company (`usePrewarm`).
 */
function documentListArgs(scope: Scope, search: Search, cursor: string | null) {
  const { status, from, to, invalid } = listFilters(search);
  if (invalid) return "skip" as const;
  const source = listSources.find((value) => value === search.source);
  return {
    ...scope,
    cursor,
    limit: search.perPage === "50" ? 50 : 20,
    ...(status ? { status } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(search.key ? { key: search.key } : {}),
    ...(source ? { source } : {}),
    ...(search.completeness === "summary" ? { completeness: "summary" as const } : {}),
  };
}
function DocumentList({
  org,
  scope,
  search,
  change,
  open,
}: {
  org: Organization;
  scope: Scope;
  search: Search;
  change: (search: Search) => void;
  open: (document: string) => void;
}) {
  // The page belongs to the filters it was opened with: other filters start at the first page.
  const filters = JSON.stringify([
    search.status,
    search.key,
    search.from,
    search.to,
    search.source,
    search.completeness,
    search.perPage,
  ]);
  const [paging, setPaging] = useState({ filters, cursor: firstPage });
  const cursor = paging.filters === filters ? paging.cursor : firstPage;
  const setCursor = (next: PageCursor) => setPaging({ filters, cursor: next });
  const { status, invalid } = listFilters(search);
  const hasFilters = !!(
    search.status ||
    search.key ||
    search.from ||
    search.to ||
    search.source ||
    search.completeness
  );
  const moreFilters = [search.source, search.completeness, search.from, search.to].filter(
    Boolean,
  ).length;
  // Filters stay in the environment being read, named in the URL so the tab rule never moves
  // them (#433).
  const env = scope.environment;
  function clearFilters() {
    change({ company: scope.companyId, env, perPage: search.perPage });
  }
  const perPage = search.perPage === "50" ? 50 : 20;
  const importable = scope.environment === useDeployment().environment;
  // Produção's refusals, outside the import page's environment, come from the capture (ADR 0007):
  // the Captura tab lists them, for every role that sees that tab. Any other case (a developer,
  // who does not see it; an environment the Captura tab does not list) reads them here.
  const refusedPlace = importable
    ? "imports"
    : scope.environment === "production" && org.role !== "developer"
      ? "capture"
      : null;
  const tableTop = useRef<HTMLDivElement>(null);
  const result = useQuery(api.documents.list, documentListArgs(scope, search, cursor.current));
  useFiscalRead(scope.organizationId, result !== undefined);
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = data.get(name);
      return typeof value === "string" ? value.trim() || undefined : undefined;
    };
    change({
      company: scope.companyId,
      env,
      status: field("status"),
      key: field("key"),
      from: field("from"),
      to: field("to"),
      source: field("source"),
      completeness: field("completeness") === "summary" ? "summary" : undefined,
      perPage: search.perPage,
    });
  }
  return (
    // Filters, the refused notice and the table are separate blocks: the system's space between.
    <div className="fiscal-stack fiscal-stack--loose">
      <Card label="Filtros de documentos">
        {/* The fields start from the URL: a filter applied or cleared elsewhere shows here.
            The key and the situation answer most searches; the rest folds away and opens by
            itself when one of its filters is applied. */}
        <form className="fiscal-filters fiscal-filters--bar" onSubmit={filter} key={filters}>
          <div className="fiscal-filters__wide">
            <FormField id="documents-filter-key" label="Identidade do documento">
              <Input
                id="documents-filter-key"
                name="key"
                maxLength={128}
                defaultValue={search.key}
                placeholder="Chave NF-e ou identidade nfse:..."
                className="ui-mono"
              />
            </FormField>
          </div>
          <FormField id="documents-filter-status" label="Situação fiscal">
            <Select id="documents-filter-status" name="status" defaultValue={status ?? ""}>
              <option value="">Todas</option>
              {fiscalStatuses.map((value) => (
                <option value={value} key={value}>
                  {statusLabels[value]}
                </option>
              ))}
            </Select>
          </FormField>
          <div className="fiscal-filters__actions">
            <Button type="submit" variant="primary">
              Aplicar filtros
            </Button>
            {hasFilters && <Button onClick={clearFilters}>Limpar filtros</Button>}
          </div>
          <Disclosure
            className="fiscal-filters__more"
            defaultOpen={moreFilters > 0}
            summary={
              moreFilters
                ? `Mais filtros · ${moreFilters} ativo${moreFilters > 1 ? "s" : ""}`
                : "Mais filtros"
            }
          >
            <div className="fiscal-filters">
              <FormField id="documents-filter-source" label="Origem">
                <Select
                  id="documents-filter-source"
                  name="source"
                  defaultValue={search.source ?? ""}
                >
                  <option value="">Todas</option>
                  <option value="imported-xml">{sourceDescriptions["imported-xml"]}</option>
                  <option value="distribution-xml">{sourceDescriptions["distribution-xml"]}</option>
                </Select>
              </FormField>
              <FormField id="documents-filter-completeness" label="Conteúdo">
                <Select
                  id="documents-filter-completeness"
                  name="completeness"
                  defaultValue={search.completeness ?? ""}
                >
                  <option value="">Todos</option>
                  <option value="summary">Só resumo, sem itens</option>
                </Select>
              </FormField>
              {/* The server filters (and sorts) by the day the document entered the platform,
                  by import or by capture; the emission date stays in the table. */}
              <FormField id="documents-filter-from" label="Recebido desde">
                <Input
                  id="documents-filter-from"
                  type="date"
                  name="from"
                  defaultValue={search.from}
                />
              </FormField>
              <FormField id="documents-filter-to" label="Recebido até">
                <Input id="documents-filter-to" type="date" name="to" defaultValue={search.to} />
              </FormField>
            </div>
          </Disclosure>
        </form>
      </Card>
      {/* The refused files are listed where they came from; only a developer, without the
          Captura tab, reads another environment's here, below the documents. */}
      {refusedPlace ? <RefusedNotice org={org} scope={scope} place={refusedPlace} /> : null}
      {invalid ? (
        <Callout tone="danger" role="alert">
          <p>
            Confira o intervalo de datas e a identidade do documento. Use a chave de 44 caracteres
            da NF-e ou a identidade da NFS-e iniciada por nfse:.
          </p>
        </Callout>
      ) : !result ? (
        <SkeletonBlock label="Carregando documentos…" lines={4} />
      ) : (
        <div className="fiscal-stack">
          {result.indexing ? (
            <Callout tone="info" role="status">
              <p>
                Preparando os documentos importados anteriormente. A lista será atualizada
                automaticamente.
              </p>
            </Callout>
          ) : null}
          {!result.page.length && !result.indexing ? (
            <EmptyState
              icon={hasFilters ? "search" : "document"}
              title={
                hasFilters
                  ? "Nenhum documento encontrado"
                  : "Ainda não há documentos para consultar"
              }
              description={
                hasFilters
                  ? "Tente outro período, situação fiscal ou identidade. Você também pode limpar os filtros para ver todos os documentos."
                  : !importable
                    ? "Os documentos de Produção chegam pela captura fiscal da empresa. Acompanhe em Empresas › Captura."
                    : "Importe um XML para consultar seus itens e acompanhar a situação fiscal. Arquivos não reconhecidos ficam disponíveis no resultado da importação."
              }
              actions={
                hasFilters || (importable && org.role !== "developer") ? (
                  <>
                    {hasFilters && <Button onClick={clearFilters}>Limpar filtros</Button>}
                    {importable && org.role !== "developer" && (
                      <Link
                        className={buttonClass({ variant: hasFilters ? "ghost" : "primary" })}
                        to="/app/$organizationSlug/imports"
                        params={{ organizationSlug: org.slug }}
                        search={{ company: scope.companyId }}
                      >
                        Abrir importações
                      </Link>
                    )}
                  </>
                ) : undefined
              }
            />
          ) : null}
          {result.page.length ? (
            // The whole row opens the document: the name's button stretches over it.
            <div className="fiscal-doc-table" ref={tableTop}>
              <DataTable<Listed>
                label="Documentos fiscais"
                rows={result.page}
                rowKey={(doc) => doc.id}
                columns={[
                  {
                    key: "document",
                    header: "Documento",
                    primary: true,
                    cell: (doc) => (
                      <>
                        <Button
                          variant="link"
                          className="fiscal-row-link"
                          onClick={() => open(doc.id)}
                        >
                          {documentName(doc)}
                        </Button>
                        {doc.kind === "summary" ? (
                          // Below the name, like the kind of the other rows.
                          <span className="fiscal-note">
                            <StatusBadge tone="info">Só resumo, sem itens</StatusBadge>
                          </span>
                        ) : (
                          <span className="fiscal-note">
                            {kindLabels[doc.kind] ?? doc.kind} · {sourceLabels[doc.source]}
                          </span>
                        )}
                        {doc.storageTier === "cold" ? (
                          <span className="fiscal-note">Na camada fria</span>
                        ) : null}
                      </>
                    ),
                  },
                  {
                    key: "issuer",
                    header: "Emitente",
                    cell: (doc) => (
                      <span className="fiscal-wrap">{doc.issuer ?? "Emitente não informado"}</span>
                    ),
                  },
                  {
                    key: "issued",
                    header: "Emissão",
                    cell: (doc) => (
                      <>
                        <span className="fiscal-num">{formatIsoDate(doc.issuedAt)}</span>
                        <span className="fiscal-note">
                          Recebido em {formatDateTime(doc.importedAt)}
                        </span>
                      </>
                    ),
                  },
                  {
                    key: "status",
                    header: "Situação",
                    cell: (doc) => (
                      <>
                        <FiscalStatusLabel status={doc.fiscalStatus} />
                        {doc.projectionState !== "ready" ? (
                          <span className="fiscal-note" role="status">
                            Conferência{" "}
                            {doc.projectionState === "pending" ? "em andamento" : "incompleta"}
                          </span>
                        ) : null}
                      </>
                    ),
                  },
                  {
                    key: "key",
                    header: "Chave",
                    cell: (doc) => (
                      <span className="ui-mono fiscal-key-tail" title={doc.key}>
                        {shortKey(doc.key)}
                      </span>
                    ),
                  },
                  {
                    key: "total",
                    header: "Total",
                    align: "end",
                    cell: (doc) => (
                      <span className="fiscal-num fiscal-total">{formatBRL(doc.total)}</span>
                    ),
                  },
                ]}
              />
            </div>
          ) : null}
          <CursorPager
            label="Páginas de documentos"
            cursor={cursor}
            nextCursor={result.nextCursor}
            onChange={(next) => {
              setCursor(next);
              // The new page starts at its first row, not where the last one was scrolled.
              tableTop.current?.scrollIntoView?.({ block: "start" });
            }}
            sticky
          >
            <label htmlFor="documents-per-page">Por página</label>
            <Select
              id="documents-per-page"
              value={String(perPage)}
              onChange={(event) =>
                change({
                  ...search,
                  perPage: event.currentTarget.value === "50" ? "50" : undefined,
                })
              }
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </Select>
          </CursorPager>
        </div>
      )}
      {refusedPlace ? null : <RefusedFiles org={org} scope={scope} />}
    </div>
  );
}
const tabIds = ["dados", "itens", "eventos", "arquivos", "json"] as const;
type TabId = (typeof tabIds)[number];
function DocumentDetail({
  org,
  scope,
  companyName,
  search,
  change,
}: {
  org: Organization;
  scope: Scope;
  companyName: string;
  search: Search;
  change: (search: Search) => void;
}) {
  const detail = useContent(
    api.contentRead.documentDetailToken,
    api.documentContentNode.documentDetailRead,
    {
      ...scope,
      documentId: search.document!,
      ...(search.version ? { versionId: search.version } : {}),
    },
  );
  const [tab, setTab] = useState<TabId>("dados");
  useFiscalRead(scope.organizationId, detail !== undefined);
  const canProcess = useQuery(api.documents.canProcess, scope);
  const rebuild = useMutation(api.documents.rebuild),
    [rebuildError, setRebuildError] = useState("");
  if (!detail) return <SkeletonBlock label="Carregando o documento…" lines={5} />;
  const select = (version: string) => change({ ...search, version });
  const rebuildPending = detail.summary.projectionState === "pending";
  return (
    <>
      <div className="fiscal-stack">
        <PageHeader
          eyebrow={`Documentos / ${environmentNames[scope.environment]} · ${kindLabels[detail.payload.kind]} · ${companyName}`}
          title={documentName(detail.summary)}
          description={
            <span className="fiscal-meta">
              <FiscalStatusLabel status={detail.summary.fiscalStatus} />
              <span>
                {kindLabels[detail.payload.kind]} · {sourceDescriptions[detail.summary.source]}
              </span>
            </span>
          }
        />
        {/* The four facts a person checks first, before any tab: who, when, how much. */}
        <dl className="fiscal-facts">
          <div className="fiscal-facts__item fiscal-facts__item--wide">
            <dt>Emitente</dt>
            <dd>{detail.summary.issuer ?? "Emitente não informado"}</dd>
          </div>
          <div className="fiscal-facts__item">
            <dt>Emissão</dt>
            <dd className="fiscal-num">{formatIsoDate(detail.summary.issuedAt)}</dd>
          </div>
          <div className="fiscal-facts__item">
            <dt>Recebido</dt>
            <dd className="fiscal-num">{formatDateTime(detail.summary.importedAt)}</dd>
          </div>
          <div className="fiscal-facts__item fiscal-facts__item--total">
            <dt>Total</dt>
            <dd className="fiscal-num">{formatBRL(detail.summary.total)}</dd>
          </div>
          <div className="fiscal-facts__item fiscal-facts__item--key">
            <dt>Chave de acesso</dt>
            <dd className="fiscal-key">
              <code>{groupKey(detail.summary.key)}</code>
              <CopyButton value={detail.summary.key} label="Copiar chave" />
            </dd>
          </div>
        </dl>
        <div className="fiscal-record-actions">
          {detail.model === "55" &&
          detail.payload.kind === "invoice" &&
          detail.version.originalAvailable &&
          !search.version ? (
            <Danfe
              key={detail.summary.id}
              scope={scope}
              documentId={detail.summary.id}
              fiscalKey={detail.summary.key}
            />
          ) : null}
          <ExportDocument key={detail.summary.id} scope={scope} documentId={detail.summary.id} />
          {canProcess ? (
            <span className="fiscal-record-actions__divider" aria-hidden="true" />
          ) : null}
          {canProcess && detail.model !== "nfse" ? (
            <div className="fiscal-action">
              <Button
                disabled={rebuildPending}
                aria-describedby={rebuildPending ? "document-rebuild-reason" : undefined}
                onClick={() => {
                  setRebuildError("");
                  void rebuild({ ...scope, documentId: detail.summary.id }).catch(() =>
                    setRebuildError(
                      "Não foi possível iniciar a conferência. Tente novamente em um minuto.",
                    ),
                  );
                }}
              >
                Reconstruir a situação pelos originais
              </Button>
              {rebuildPending ? (
                <DisabledReason id="document-rebuild-reason">
                  A conferência em andamento precisa terminar primeiro.
                </DisabledReason>
              ) : null}
            </div>
          ) : null}
          {canProcess ? <Reprocess org={org} scope={scope} documentId={detail.summary.id} /> : null}
        </div>
        {rebuildError ? (
          <Callout tone="danger" role="alert">
            <p>{rebuildError}</p>
          </Callout>
        ) : null}
        <p className="ui-help">
          {detail.model === "nfse"
            ? "A situação fiscal desta NFS-e não foi consultada. Reprocessar relê o lote original completo."
            : "Essa situação vem das evidências preservadas. Reprocessar o XML não realiza uma nova consulta à SEFAZ."}
        </p>
        {detail.summary.projectionState !== "ready" ? (
          <Callout tone="info" role="status">
            <p>
              Reconstrução fiscal {rebuildPending ? "em andamento" : "incompleta"}. O estado
              anterior permanece identificado.
            </p>
          </Callout>
        ) : null}
        {detail.previousFiscalSituation ? (
          <Callout tone="info">
            <p>
              Última situação concluída (histórica):{" "}
              {statusLabels[detail.previousFiscalSituation.reportedStatus]}.
            </p>
          </Callout>
        ) : null}
        {search.version ? (
          <Callout
            tone="warning"
            actions={
              <Button size="sm" onClick={() => change({ ...search, version: undefined })}>
                Abrir versão atual
              </Button>
            }
          >
            <p>Você está consultando uma versão histórica.</p>
          </Callout>
        ) : null}
      </div>
      <Tabs
        label="Detalhes do documento"
        value={tab}
        onValueChange={(id) => setTab(id as TabId)}
        tabs={[
          { id: "dados", label: "Dados", content: <DocumentData detail={detail} /> },
          { id: "itens", label: "Itens", content: <Items scope={scope} detail={detail} /> },
          {
            id: "eventos",
            label: "Eventos",
            content: <Versions scope={scope} detail={detail} events select={select} />,
          },
          {
            id: "arquivos",
            label: "Arquivos e histórico",
            content: <Versions scope={scope} detail={detail} select={select} />,
          },
          { id: "json", label: "JSON", content: <PublicJson detail={detail} /> },
        ]}
      />
    </>
  );
}
/**
 * The JSON tab shows the public DTO, the same body as `GET /v1/documents/{id}/json` (and the
 * `version` of a historical version), never the stored document: it is what an integration reads.
 */
function PublicJson({ detail }: { detail: Detail }) {
  const text = JSON.stringify(detail, null, 2);
  return (
    <Card
      title="JSON da API"
      description={
        <>
          O mesmo conteúdo que uma integração recebe em{" "}
          <code className="ui-mono">GET /v1/documents/{"{id}"}/json</code>: o contrato público{" "}
          <code className="ui-mono">{detail.contractVersion}</code>, com valores decimais como texto
          exato. Não inclui dados internos de processamento nem o XML; o original fica em “Arquivos
          e histórico”.
        </>
      }
      actions={
        <>
          <CopyButton value={text} label="Copiar JSON" />
          <Button
            size="sm"
            icon="download"
            onClick={() =>
              saveBlob(
                new Blob([text + "\n"], { type: "application/json" }),
                `documento-${detail.summary.number ?? detail.summary.id}.json`,
              )
            }
          >
            Baixar JSON
          </Button>
        </>
      }
    >
      <CodeBlock label="JSON público do documento">{text}</CodeBlock>
    </Card>
  );
}
type Invoice = Extract<Detail["payload"], { kind: "invoice" }>;
/**
 * A field read from the XML: the official description in pt-BR, and the tag under it as quiet
 * mono text, always in the same place, so a wrapped label never moves the tag or the value.
 */
function FieldTerm({ label, tag }: { label: string; tag: string }) {
  return (
    <>
      <span className="fiscal-term">{label}</span>
      <span className="fiscal-tag">{tag}</span>
    </>
  );
}
/** What each NT 2025.002 combination rule means for the person reading the document. */
const inconsistencyMessages: Record<string, string> = {
  "B25.1-10": "O XML informa tipo de nota de débito, mas a finalidade não é Nota de débito.",
  "B25.1-20": "A finalidade é Nota de débito, mas o XML não informa o tipo de nota de débito.",
  "B25.2-10": "O XML informa tipo de nota de crédito, mas a finalidade não é Nota de crédito.",
  "B25.2-20": "A finalidade é Nota de crédito, mas o XML não informa o tipo de nota de crédito.",
};
function codeValue(
  entry: { code: string; label: string | null },
  unlisted = "Código não previsto no schema",
) {
  return (
    <>
      {entry.label ?? unlisted} · <span className="ui-mono">{entry.code}</span>
    </>
  );
}
/**
 * NT 2026.008 values, under the official field descriptions (NT 2026.008 v1.00, page 6), only when
 * the XML declares them: the older layout has none, and a row
 * saying so on every NF-e would be noise. The JSON keeps the exact value and the absence.
 */
function declaredValues(entries: Array<[string, string, string | null | undefined]>) {
  return entries.flatMap(([term, tag, value]) =>
    value === null || value === undefined
      ? []
      : [
          {
            key: tag,
            term: <FieldTerm label={term} tag={tag} />,
            value: <span className="fiscal-num">{formatBRL(value)}</span>,
          },
        ],
  );
}
/** Purpose apart from the operation nature and the fiscal situation; both totals as declared. */
function invoiceFields(data: Invoice) {
  const purpose = data.purpose;
  const missing = <span className="fiscal-absent">Não informado no XML</span>;
  return [
    {
      key: "operation",
      term: <FieldTerm label="Natureza da operação" tag="natOp" />,
      value: data.operation,
    },
    {
      key: "purpose",
      term: <FieldTerm label="Finalidade" tag="finNFe" />,
      value: !purpose ? (
        <span className="fiscal-absent">
          Não extraída nesta versão. Reprocesse o documento para lê-la do XML original.
        </span>
      ) : purpose.code === null ? (
        missing
      ) : (
        codeValue({ code: purpose.code, label: purpose.label })
      ),
    },
    ...(purpose?.creditNoteType
      ? [
          {
            key: "credit",
            term: <FieldTerm label="Tipo de nota de crédito" tag="tpNFCredito" />,
            value: codeValue(purpose.creditNoteType),
          },
        ]
      : []),
    ...(purpose?.debitNoteType
      ? [
          {
            key: "debit",
            term: <FieldTerm label="Tipo de nota de débito" tag="tpNFDebito" />,
            value: codeValue(purpose.debitNoteType),
          },
        ]
      : []),
    {
      key: "total",
      term: <FieldTerm label="Valor total da NF-e" tag="vNF" />,
      value: <span className="fiscal-num">{formatBRL(data.declaredTotals.vNF)}</span>,
    },
    {
      key: "total-taxes",
      term: <FieldTerm label="Valor total da NF-e com IBS/CBS/IS" tag="vNFTot" />,
      value:
        data.declaredTotals.vNFTot === null ? (
          missing
        ) : (
          <span className="fiscal-num">{formatBRL(data.declaredTotals.vNFTot)}</span>
        ),
    },
    ...declaredValues([
      [
        "Valor total líquido dos produtos ou serviços (sem tributos)",
        "vProdLiqTot",
        data.nt2026008?.vProdLiqTot,
      ],
    ]),
    // A version from before nfe-parser/6 cannot say whether the XML has the group: say so, as
    // for the purpose. An XML without the group shows nothing; one with it gets its own card.
    ...(data.nt2026006 === null
      ? [
          {
            key: "payment-link",
            term: <FieldTerm label="Vinculação com a transação de pagamento" tag="gPgtoVinc" />,
            value: (
              <span className="fiscal-absent">
                Não extraída nesta versão. Reprocesse o documento para lê-la do XML original.
              </span>
            ),
          },
        ]
      : []),
  ];
}
type PaymentLink = NonNullable<NonNullable<Invoice["nt2026006"]>["gPgtoVinc"]>[number];
/** CNPJ base (eight positions, alphanumeric since the 2026 CNPJ) in the CNPJ punctuation. */
const formatCnpjBase = (value: string) =>
  value.replace(/^([A-Z0-9]{2})([A-Z0-9]{3})([A-Z0-9]{3})$/, "$1.$2.$3");
/**
 * NT 2026.006 `gPgtoVinc`, only when the XML declares the group. Terms are the PL_010g
 * descriptions, except the payment means: it reads "Meio de pagamento" and shows the IT DFe
 * 2026.001 description with the code. A code outside that table keeps its value, and the card says
 * once that the IT provides for its rejection, a rule the platform does not evaluate; it never
 * states the rejection as a fact, since the NF-e may be authorized or the IT may add the code.
 */
function PaymentLinks({ links }: { links: PaymentLink[] }) {
  const unlisted = `Fora da tabela do ${nfePaymentMeansLabelsSource}`;
  return (
    <Card
      title="Vinculação com a transação de pagamento"
      description={
        <>
          Grupo <span className="ui-mono">gPgtoVinc</span> da NT 2026.006, como declarado no XML.
          {links.some((link) => link.tpMeioPgtoLabel === null)
            ? ` O ${nfePaymentMeansLabelsSource} prevê a rejeição, na autorização, de um meio de pagamento fora da sua tabela; a plataforma não avalia essa regra e mostra o código como declarado.`
            : null}
        </>
      }
    >
      {links.length ? (
        <ul className="fiscal-list">
          {links.map((link, index) => (
            // nPag may repeat: the XSD declares it unique but does not enforce it.
            <li key={index} className="fiscal-item">
              <h3 className="fiscal-item__title">Pagamento {link.nPag}</h3>
              <DescriptionList
                className="fiscal-figures"
                items={[
                  {
                    key: "transaction",
                    term: (
                      <FieldTerm label="Identificador da transação financeira" tag="idTransacao" />
                    ),
                    value: <span className="ui-mono">{link.idTransacao}</span>,
                  },
                  {
                    key: "means",
                    term: <FieldTerm label="Meio de pagamento" tag="tpMeioPgto" />,
                    value: codeValue(
                      { code: link.tpMeioPgto, label: link.tpMeioPgtoLabel },
                      unlisted,
                    ),
                  },
                  {
                    key: "receiver",
                    term: <FieldTerm label="CNPJ do recebedor do pagamento" tag="CNPJReceb" />,
                    value: <span className="ui-mono">{formatCnpj(link.CNPJReceb)}</span>,
                  },
                  {
                    key: "institution",
                    term: (
                      <FieldTerm
                        label="CNPJ base da instituição financeira ou de pagamento"
                        tag="CNPJBasePSP"
                      />
                    ),
                    value: <span className="ui-mono">{formatCnpjBase(link.CNPJBasePSP)}</span>,
                  },
                ]}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="ui-help">O XML declara o grupo sem nenhum pagamento.</p>
      )}
    </Card>
  );
}
function DocumentData({ detail }: { detail: Detail }) {
  const data = detail.payload;
  const common = [
    { key: "source", term: "Origem", value: sourceDescriptions[detail.version.source] },
    {
      key: "processor",
      term: "Versão de processamento",
      value: detail.version.processorVersion,
    },
    {
      key: "parser",
      term: "Parser / normalizador",
      value: `${detail.version.parserVersion} / ${detail.version.normalizerVersion ?? "indisponível"}`,
    },
    {
      key: "sha",
      term: "SHA-256 do original",
      value: <code className="ui-mono">{detail.version.sha256}</code>,
    },
  ];
  const specific =
    data.kind === "invoice" || data.kind === "summary" || data.kind === "service-invoice"
      ? [
          {
            key: "issuer",
            term: "Emitente",
            value: (
              <>
                {data.issuer.name} ·{" "}
                <span className="ui-mono">{formatCnpj(data.issuer.document)}</span>
              </>
            ),
          },
          { key: "issued", term: "Data de emissão", value: formatIsoDate(data.issuedAt) },
          ...(data.kind === "invoice"
            ? invoiceFields(data)
            : [
                {
                  key: "total",
                  term: "Total declarado",
                  value: <span className="fiscal-num">{formatBRL(data.total)}</span>,
                },
              ]),
        ]
      : [
          {
            key: "event",
            term: "Tipo / sequência do evento",
            value: `${data.type} / ${data.sequence}`,
          },
          { key: "occurred", term: "Ocorrência", value: data.occurredAt },
          {
            key: "author",
            term: "Autor",
            value: <span className="ui-mono">{data.author.document}</span>,
          },
        ];
  const paymentLinks = data.kind === "invoice" ? data.nt2026006?.gPgtoVinc : null;
  const card = (
    <Card title="Dados do documento">
      <div className="fiscal-stack">
        {data.kind === "summary" ? <SummaryOnly /> : null}
        <DescriptionList items={[...specific, ...common]} />
        {data.kind === "invoice" && data.purpose?.inconsistencies.length ? (
          <Callout tone="warning" role="status" title="Finalidade inconsistente" headingLevel={3}>
            {data.purpose.inconsistencies.map((rule) => (
              <p key={rule}>{inconsistencyMessages[rule]}</p>
            ))}
            <p className="fiscal-note">
              Os códigos aparecem como foram declarados, e a situação fiscal não muda. Referência:{" "}
              {data.purpose.inconsistencies.length > 1 ? "regras" : "regra"}{" "}
              {data.purpose.inconsistencies.join(", ")} da NT 2025.002.
            </p>
          </Callout>
        ) : null}
        {detail.fiscalSituation?.conflicts.length ? (
          <Callout tone="warning" role="status" title="Conflitos preservados" headingLevel={3}>
            <ul>
              {detail.fiscalSituation.conflicts.map((value) => (
                <li key={value}>{value}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {data.kind === "service-invoice" ? (
          <>
            <p className="ui-help">
              Importado sem consulta ao fisco, validação de XSD ou verificação de assinatura. O
              download preserva o lote original completo.
            </p>
            <DescriptionList
              items={[
                { key: "competence", term: "Competência", value: data.competence },
                { key: "municipality", term: "Município emissor", value: data.municipality },
                {
                  key: "verification",
                  term: "Código de verificação",
                  value: <span className="ui-mono">{data.verificationCode}</span>,
                },
                {
                  key: "recipient",
                  term: "Tomador",
                  value: `${data.recipient?.name ?? ""} ${data.recipient?.document ?? ""}`.trim(),
                },
                {
                  key: "service",
                  term: "Serviço",
                  value: `${data.serviceCode} · ${data.description}`,
                },
              ]}
            />
          </>
        ) : null}
        {/* Null: not consulted, or the projection is not ready; the header already says which. */}
        {detail.fiscalSituation ? (
          <Disclosure summary="Evidências da situação fiscal">
            <CodeBlock label="Evidências da situação fiscal">
              {JSON.stringify(detail.fiscalSituation, null, 2)}
            </CodeBlock>
          </Disclosure>
        ) : null}
      </div>
    </Card>
  );
  return paymentLinks ? (
    <div className="fiscal-stack">
      {card}
      <PaymentLinks links={paymentLinks} />
    </div>
  ) : (
    card
  );
}
function Items({ scope, detail }: { scope: Scope; detail: Detail }) {
  const [cursor, setCursor] = useState(firstPage);
  const items = useContent(
    api.contentRead.documentItemsToken,
    api.documentContentNode.documentItemsRead,
    {
      ...scope,
      documentId: detail.summary.id,
      versionId: detail.version.id,
      cursor: cursor.current,
      limit: 10,
    },
  );
  if (detail.payload.kind !== "invoice")
    return (
      <Card title="Itens">
        {detail.payload.kind === "summary" ? (
          <SummaryOnly />
        ) : (
          <p className="ui-help">Este artefato não contém os itens de uma NF-e completa.</p>
        )}
      </Card>
    );
  return (
    <Card
      title="Itens"
      description="Valores e tributos declarados no XML, sem cálculo tributário pelo sistema."
    >
      {!items ? (
        <SkeletonBlock label="Carregando itens…" lines={4} />
      ) : (
        <div className="fiscal-stack">
          <ul className="fiscal-list">
            {items.page.map((item) => (
              <li key={item.item} className="fiscal-item">
                <h3 className="fiscal-item__title">
                  {item.item}. {item.description}
                </h3>
                <DescriptionList
                  className="fiscal-figures"
                  items={[
                    {
                      key: "codes",
                      term: "Código · NCM · CFOP",
                      value: (
                        <span className="ui-mono">
                          {item.code} · {item.ncm} · {item.cfop}
                        </span>
                      ),
                    },
                    {
                      key: "quantity",
                      term: "Quantidade",
                      value: (
                        <span className="fiscal-num">
                          {formatDecimal(item.quantity)} {item.unit}
                        </span>
                      ),
                    },
                    {
                      key: "unit",
                      term: "Unitário",
                      value: <span className="fiscal-num">{formatBRL(item.unitPrice)}</span>,
                    },
                    {
                      key: "total",
                      term: "Total",
                      value: <span className="fiscal-num">{formatBRL(item.total)}</span>,
                    },
                    ...declaredValues([
                      [
                        "Valor líquido unitário (sem tributos)",
                        "vUnComLiq",
                        item.nt2026008?.vUnComLiq,
                      ],
                      ["Valor líquido (sem tributos)", "vProdLiq", item.nt2026008?.vProdLiq],
                      ["Valor do ICMS previsto", "vICMSPrevisto", item.nt2026008?.vICMSPrevisto],
                    ]),
                  ]}
                />
                <Disclosure summary={`Campos e tributos declarados do item ${item.item}`}>
                  <CodeBlock label={`Campos e tributos declarados do item ${item.item}`}>
                    {JSON.stringify(item, null, 2)}
                  </CodeBlock>
                </Disclosure>
              </li>
            ))}
          </ul>
          <CursorPager
            label="Páginas de itens"
            cursor={cursor}
            nextCursor={items.nextCursor}
            onChange={setCursor}
          />
        </div>
      )}
    </Card>
  );
}
function Versions({
  scope,
  detail,
  events = false,
  select,
}: {
  scope: Scope;
  detail: Detail;
  events?: boolean;
  select: (id: string) => void;
}) {
  const [cursor, setCursor] = useState(firstPage),
    [kind, setKind] = useState("event");
  const versions = useContent(
    api.contentRead.documentVersionsToken,
    api.documentContentNode.documentVersionsRead,
    {
      ...scope,
      documentId: detail.summary.id,
      cursor: cursor.current,
      limit: 10,
      ...(events ? { kind } : {}),
    },
  );
  return (
    <Card title={events ? "Eventos" : "Arquivos e histórico"}>
      <div className="fiscal-stack">
        {events ? (
          <div className="fiscal-narrow-field">
            <FormField id="document-event-kind" label="Representação do evento">
              <Select
                id="document-event-kind"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value);
                  setCursor(firstPage);
                }}
              >
                <option value="event">Evento completo</option>
                <option value="event-summary">Resumo de evento</option>
              </Select>
            </FormField>
          </div>
        ) : null}
        {!versions ? (
          <SkeletonBlock label="Carregando documentos…" lines={3} />
        ) : (
          <>
            {versions.page.length ? (
              <ul className="fiscal-list">
                {versions.page.map(({ version, payload }) => (
                  <li key={version.id} className="fiscal-item">
                    <div className="fiscal-item__head">
                      <h3 className="fiscal-item__title">
                        {kindLabels[payload.kind]} · {version.processorVersion}
                      </h3>
                      <Button size="sm" onClick={() => select(version.id)}>
                        Consultar esta versão
                      </Button>
                    </div>
                    <DescriptionList
                      items={[
                        {
                          key: "published",
                          term: "Publicado em",
                          value: formatDateTime(version.publishedAt),
                        },
                        {
                          key: "code",
                          term: "Resultado",
                          value: <span className="ui-mono">{version.code}</span>,
                        },
                        {
                          key: "sha",
                          term: "SHA-256",
                          value: <code className="ui-mono">{version.sha256}</code>,
                        },
                      ]}
                    />
                    {payload.kind === "event" || payload.kind === "event-summary" ? (
                      <p>
                        Evento {payload.type}, sequência {payload.sequence}, ocorrido em{" "}
                        {payload.occurredAt}.
                      </p>
                    ) : null}
                    {!events ? (
                      <Original
                        scope={scope}
                        artifactId={version.artifactId}
                        available={version.originalAvailable}
                        kind={payload.kind}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ui-help">Nenhum registro nesta página.</p>
            )}
            <CursorPager
              label={events ? "Páginas de eventos" : "Páginas do histórico"}
              cursor={cursor}
              nextCursor={versions.nextCursor}
              onChange={setCursor}
            />
          </>
        )}
      </div>
    </Card>
  );
}
/**
 * DANFE of the current NF-e (#402), through the same one-minute ticket as the original. The
 * first download renders the PDF on the server, which can take a few seconds.
 */
function Danfe({
  scope,
  documentId,
  fiscalKey,
}: {
  scope: Scope;
  documentId: string;
  fiscalKey: string;
}) {
  const ticket = useMutation(api.documentDownloads.danfeTicket);
  const download = useTicketDownload();
  const start = () =>
    void download.start(() => ticket({ ...scope, documentId }), {
      name: `danfe-${fiscalKey}.pdf`,
      label: "DANFE",
      conflict:
        "Não há DANFE para esta nota: o gerador não aceitou o XML, ou ela tem mais eventos do que o DANFE comporta. O XML original continua disponível em “Arquivos e histórico”.",
    });
  return (
    <div className="fiscal-action">
      <Button icon="download" disabled={download.busy} onClick={start}>
        Baixar DANFE (PDF)
      </Button>
      <p className="ui-help">
        Gerado do XML preservado; a nota é o XML. A primeira geração leva alguns segundos.
      </p>
      <DownloadFeedback state={download.state} onRetry={start} />
    </div>
  );
}
