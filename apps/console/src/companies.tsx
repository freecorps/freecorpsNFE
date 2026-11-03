import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { usePaginatedQuery, useQuery } from "./convex-query";
import type { FunctionReturnType } from "convex/server";
import { formatCnpj } from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import { Registry } from "./registry";
import { CreateCompany } from "./company-create";
import { Certificates } from "./certificates";
import { Captures } from "./captures";
import { NfseProfile } from "./nfse-profile";
import { ErrorSummary, focusField } from "./field";
import {
  Button,
  Callout,
  Card,
  DataTable,
  DescriptionList,
  EmptyState,
  FormField,
  Icon,
  Input,
  Page,
  PageHeader,
  Select,
  StatusBadge,
  buttonClass,
} from "./ui";
import { COMPANIES_PAGE_SIZE, companiesListArgs, companyArgs } from "./page-queries";
import { captureSituation } from "./capture-messages";
import { Feedback, Loading, More, errorText } from "./company-feedback";
import {
  CREATE_ANCHOR,
  CompanyFields,
  companyErrors,
  companyFieldOrder,
  fields,
  focusCreate,
  formValue,
  useCompanyForm,
} from "./company-form";
import { Grants } from "./company-grants";
import { CompanyStatus, useCertificatePage } from "./company-status";
import { formatCep } from "./format";
import { Disclosure } from "./ui/disclosure";
import { companyTabs, resolveTab, tabSearch, type CompanyTab } from "./company-tabs";

type Company = NonNullable<FunctionReturnType<typeof api.companies.get>>;
type ScopeProps = { org: Organization; contextKey: string };
const kindLabel = (kind: Company["kind"]) =>
  kind === "demonstration" ? "Demonstração" : "Cadastro declarado";
/**
 * The fiscal capture (Produção) of the company in one badge (#433), with the panel's words and
 * tone (`captureSituation`); nothing when it was never released or was turned off.
 */
function FiscalCaptureBadge({ value }: { value: Company["fiscalCapture"] }) {
  if (!value) return null;
  const badge = captureSituation(value);
  return <StatusBadge tone={badge.tone}>{badge.fiscal}</StatusBadge>;
}
function CompanyList({ org, contextKey }: ScopeProps) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.companies.list,
    companiesListArgs({ org, contextKey }),
    { initialNumItems: COMPANIES_PAGE_SIZE },
  );
  const openRef = useRef<HTMLButtonElement>(null),
    createRef = useRef<HTMLHeadingElement>(null);
  const manager = org.capabilities.manageOrganization;
  // The fiscal capture's column appears once a listed company has one to show.
  const fiscal = results.some((company) => company.fiscalCapture);
  // Arriving from the first steps ("Cadastrar minha empresa") opens the form.
  const [creating, setCreating] = useState(() => window.location.hash === `#${CREATE_ANCHOR}`);
  return (
    <Page>
      <PageHeader
        title="Empresas"
        description="Você vê apenas as empresas disponíveis para seu acesso atual."
        actions={
          manager ? (
            <Button
              ref={openRef}
              variant="primary"
              icon="plus"
              aria-expanded={creating}
              aria-controls={creating ? CREATE_ANCHOR : undefined}
              onClick={() => (creating ? focusCreate(createRef.current) : setCreating(true))}
            >
              Cadastrar empresa
            </Button>
          ) : null
        }
      />
      {manager && creating && (
        <CreateCompany
          org={org}
          headingRef={createRef}
          onCancel={() => {
            setCreating(false);
            requestAnimationFrame(() => openRef.current?.focus());
          }}
        />
      )}
      {status === "LoadingFirstPage" ? (
        <Card label="Empresas">
          <Loading label="Carregando empresas…" />
        </Card>
      ) : (
        <div className="ui-stack fiscal-doc-table">
          <DataTable
            label="Empresas"
            rowKey={(company) => company.id}
            rows={results}
            empty={
              <EmptyState
                icon="building"
                title="Nenhuma empresa disponível."
                description={
                  manager
                    ? "Cadastre sua primeira empresa pelo botão acima ou comece pela demonstração."
                    : "Solicite a um administrador acesso à empresa com a qual você precisa trabalhar."
                }
                actions={
                  manager ? (
                    <Link
                      className={buttonClass()}
                      to="/app/$organizationSlug/onboarding"
                      params={{ organizationSlug: org.slug }}
                    >
                      Ver primeiros passos
                    </Link>
                  ) : null
                }
              />
            }
            columns={[
              {
                key: "name",
                header: "Empresa",
                primary: true,
                cell: (company) => (
                  <span className="company-list-name">
                    <Link
                      className="ui-link fiscal-row-link"
                      to="/app/$organizationSlug/companies/$companyId"
                      params={{ organizationSlug: org.slug, companyId: company.id }}
                    >
                      {company.name}
                    </Link>
                    {/* Only the demonstration is marked: every other row is a declared company. */}
                    {company.kind === "demonstration" ? (
                      <StatusBadge tone="info">{kindLabel(company.kind)}</StatusBadge>
                    ) : null}
                  </span>
                ),
              },
              {
                key: "cnpj",
                header: "CNPJ",
                cell: (company) => <span className="ui-mono">{formatCnpj(company.cnpj)}</span>,
              },
              ...(fiscal
                ? [
                    {
                      key: "fiscal-capture",
                      header: "Captura fiscal",
                      cell: (company: (typeof results)[number]) =>
                        company.fiscalCapture ? (
                          <FiscalCaptureBadge value={company.fiscalCapture} />
                        ) : (
                          <span className="fiscal-note">Não ativada</span>
                        ),
                    },
                  ]
                : []),
            ]}
          />
          <More status={status} loadMore={loadMore} label="Mais empresas" />
        </div>
      )}
    </Page>
  );
}
export function Companies({ org, contextKey, companyId }: ScopeProps & { companyId?: string }) {
  return companyId ? (
    <CompanyContext key={companyId} org={org} contextKey={contextKey} companyId={companyId} />
  ) : (
    <CompanyList org={org} contextKey={contextKey} />
  );
}
function CompanyContext({ org, contextKey, companyId }: ScopeProps & { companyId: string }) {
  const company = useQuery(api.companies.get, companyArgs({ org, contextKey }, companyId));
  if (company === undefined)
    return (
      <Page>
        <Card label="Empresa">
          <Loading />
        </Card>
      </Page>
    );
  if (!company)
    return (
      <Page>
        <div role="alert">
          <PageHeader
            title="Empresa indisponível."
            description="Confira o endereço ou solicite acesso à equipe responsável."
            actions={
              <Link
                className={buttonClass()}
                to="/app/$organizationSlug/companies"
                params={{ organizationSlug: org.slug }}
              >
                Voltar às empresas
              </Link>
            }
          />
        </div>
      </Page>
    );
  // A new access version remounts the page; a new cadastro version only refreshes the form.
  return (
    <CompanyDetail
      key={company.accessVersion}
      org={org}
      company={company}
      contextKey={contextKey}
    />
  );
}
function CompanySelector({
  org,
  company,
  contextKey,
  tab,
}: ScopeProps & { company: Company; tab: CompanyTab }) {
  const navigate = useNavigate();
  const { results, status, loadMore } = usePaginatedQuery(
    api.companies.list,
    { organizationId: org.id, contextKey },
    { initialNumItems: 20 },
  );
  return (
    <div className="company-switcher">
      <FormField id="company-context" label="Empresa atual">
        <Select
          id="company-context"
          value={company.id}
          onChange={(event) => {
            // The same tab, when the other company has it; otherwise the page opens on Resumo.
            void navigate({
              to: "/app/$organizationSlug/companies/$companyId",
              params: { organizationSlug: org.slug, companyId: event.target.value },
              search: tabSearch(tab),
            });
          }}
        >
          {!results.some((c) => c.id === company.id) && (
            <option value={company.id}>{company.name}</option>
          )}
          {results.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </FormField>
      <More status={status} loadMore={loadMore} label="Mais empresas" />
    </div>
  );
}
function CompanyRegistration({ org, company }: { org: Organization; company: Company }) {
  const update = useMutation(api.companies.update);
  const form = useCompanyForm();
  const [editing, setEditing] = useState(false),
    [message, setMessage] = useState("");
  const editRef = useRef<HTMLButtonElement>(null);
  const manage = company.capabilities.manage && company.kind === "declared";
  useEffect(() => {
    if (editing) focusField("company-name");
  }, [editing]);
  function close(text: string) {
    form.clear();
    setEditing(false);
    setMessage(text);
    requestAnimationFrame(() => editRef.current?.focus());
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (form.busy) return;
    const input = fields(new FormData(event.currentTarget));
    const found = companyErrors(input);
    if (Object.keys(found).length) return form.refuse(found);
    form.clear();
    form.setBusy(true);
    try {
      await update({
        organizationId: org.id,
        companyId: company.id,
        expectedVersion: company.version,
        ...input,
      });
      close("Cadastro salvo.");
    } catch (error) {
      form.reject(error);
    } finally {
      form.setBusy(false);
    }
  }
  const fromRegistry = {
    name: company.fieldSources.name === "registry",
    address: company.fieldSources.address === "registry",
  };
  const origin =
    fromRegistry.name && fromRegistry.address
      ? "Razão social e endereço vieram da consulta CNPJ (OpenCNPJ) e foram confirmados pela equipe."
      : fromRegistry.name
        ? "Razão social da consulta CNPJ (OpenCNPJ), confirmada pela equipe; endereço preenchido à mão."
        : fromRegistry.address
          ? "Endereço da consulta CNPJ (OpenCNPJ), confirmado pela equipe; razão social preenchida à mão."
          : "Razão social e endereço preenchidos à mão.";
  if (editing)
    return (
      <Card
        title="Editar cadastro"
        description="O CNPJ identifica esta empresa e permanece fixo. Os campos só mudam depois que você salvar."
      >
        <form className="ui-form" onSubmit={submit} aria-busy={form.busy} noValidate>
          <ErrorSummary
            id="edit-company-errors"
            title="O cadastro não foi salvo."
            errors={form.errors}
            fields={companyFieldOrder}
            general={form.general}
            focusKey={form.attempt}
          />
          {/* A new version from another session refreshes the fields. */}
          <div className="company-form-grid" key={company.version}>
            <CompanyFields company={company} disabled={form.busy} errors={form.errors} />
          </div>
          <div className="ui-actions">
            <Button type="submit" variant="primary" loading={form.busy} loadingLabel="Salvando…">
              Salvar alterações
            </Button>
            <Button disabled={form.busy} onClick={() => close("")}>
              Cancelar
            </Button>
          </div>
          {form.busy && (
            <p className="ui-help" role="status">
              Aguardando o servidor salvar o cadastro.
            </p>
          )}
        </form>
      </Card>
    );
  return (
    <Card
      title="Cadastro"
      description={
        company.kind === "demonstration"
          ? "Dados sintéticos para explorar o sandbox. A demonstração não pode ser editada."
          : origin
      }
      actions={
        manage ? (
          <Button
            ref={editRef}
            size="sm"
            onClick={() => {
              setMessage("");
              setEditing(true);
            }}
          >
            Editar cadastro
          </Button>
        ) : null
      }
    >
      <div className="ui-stack">
        {message && (
          <Callout tone="success" role="status">
            {message}
          </Callout>
        )}
        <DescriptionList
          items={[
            // The CNPJ sits under the page title, fixed; here, what can change.
            { term: "Nome", value: company.name },
            {
              term: "Endereço",
              value: (
                <>
                  {company.address.street}, {company.address.number}
                  {company.address.complement && ` · ${company.address.complement}`}
                </>
              ),
            },
            {
              term: "Bairro e município",
              value: `${company.address.district} · ${company.address.city}/${company.address.state}`,
            },
            {
              term: "CEP",
              value: <span className="ui-mono">{formatCep(company.address.postalCode)}</span>,
            },
          ]}
        />
        {!manage && company.kind === "declared" ? (
          <p className="ui-help">Somente proprietários e administradores alteram o cadastro.</p>
        ) : null}
      </div>
    </Card>
  );
}
function Activity({ org, company, contextKey }: ScopeProps & { company: Company }) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.companies.activity,
    { organizationId: org.id, companyId: company.id, contextKey },
    { initialNumItems: 10 },
  );
  const labels = {
    "company.created": "Empresa cadastrada",
    "company.updated": "Cadastro atualizado",
    "company.registry_applied": "Sugestão cadastral confirmada",
    "company.granted": "Acesso concedido",
    "company.revoked": "Acesso revogado",
    "company.nfse_profile_created": "Perfil de emissão NFS-e criado",
    "company.nfse_profile_updated": "Perfil de emissão NFS-e atualizado",
    "company.nfse_dps_start_set": "Número inicial da DPS definido",
  };
  return (
    <section className="ui-section" aria-labelledby="empresa-historico-titulo">
      <div className="ui-section__header">
        <h2 id="empresa-historico-titulo" className="ui-section__title">
          Histórico da empresa
        </h2>
        <p className="ui-section__description">
          Alterações de cadastro, acesso e perfil fiscal, da mais recente para a mais antiga.
        </p>
      </div>
      {status === "LoadingFirstPage" ? (
        <Card label="Histórico">
          <Loading label="Carregando histórico…" />
        </Card>
      ) : (
        <DataTable
          label="Eventos da empresa"
          rowKey={(event) => event.id}
          rows={results}
          empty={
            <EmptyState
              icon="layers"
              title="Nenhum evento registrado."
              description="As alterações desta empresa aparecem aqui."
            />
          }
          columns={[
            {
              key: "event",
              header: "Evento",
              primary: true,
              cell: (event) => labels[event.action],
            },
            {
              key: "at",
              header: "Quando",
              align: "end",
              cell: (event) => new Date(event.createdAt).toLocaleString("pt-BR"),
            },
          ]}
        />
      )}
      <More status={status} loadMore={loadMore} label="Mais eventos" />
    </section>
  );
}

function DeleteCompany({ org, company, contextKey }: ScopeProps & { company: Company }) {
  const deletion = useQuery(api.companies.deletion, {
      organizationId: org.id,
      companyId: company.id,
      contextKey,
    }),
    remove = useMutation(api.companies.remove),
    navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await remove({
        organizationId: org.id,
        companyId: company.id,
        expectedVersion: company.version,
        confirmation: formValue(new FormData(event.currentTarget), "confirmation"),
      });
      void navigate({
        to: "/app/$organizationSlug/companies",
        params: { organizationSlug: org.slug },
      });
    } catch (error) {
      setError(errorText(error));
      setBusy(false);
    }
  }
  if (deletion === undefined) return null;
  // Rarely wanted and never undone: folded at the end, opened by whoever means it.
  return (
    <Disclosure summary="Excluir empresa" className="company-danger">
      <Card
        title="Excluir empresa"
        headingLevel={3}
        className="gestao-danger"
        description="Para corrigir um cadastro feito por engano, como um CNPJ errado. Só pode ser excluída a empresa que ainda não tem documentos, importações, emissões, captura, projetos, webhooks nem certificado aceito."
      >
        {deletion.allowed ? (
          <form className="ui-form" onSubmit={submit} aria-busy={busy} noValidate>
            <FormField
              id="company-delete-confirmation"
              label={
                <>
                  Para confirmar, digite o CNPJ:{" "}
                  <span className="ui-mono">{formatCnpj(company.cnpj)}</span>
                </>
              }
            >
              <Input
                id="company-delete-confirmation"
                name="confirmation"
                className="ui-mono"
                autoComplete="off"
                required
                disabled={busy}
              />
            </FormField>
            <Feedback error={error} />
            <div>
              <Button type="submit" variant="danger" loading={busy} loadingLabel="Excluindo…">
                Excluir empresa
              </Button>
            </div>
          </form>
        ) : (
          <p className="ui-help">
            Esta empresa já tem histórico na plataforma e não pode ser excluída.
          </p>
        )}
      </Card>
    </Disclosure>
  );
}

function CompanyDetail({ org, company, contextKey }: ScopeProps & { company: Company }) {
  const certificates = useCertificatePage(org, company, contextKey);
  const navigate = useNavigate();
  const search: { aba?: unknown } = useSearch({ strict: false });
  const tabs = companyTabs(company, org.role);
  const active = resolveTab(search.aba, tabs);
  const tablistRef = useRef<HTMLDivElement>(null),
    panelRef = useRef<HTMLDivElement>(null),
    previous = useRef(active);
  // A tab opened from outside the tab list (a summary shortcut, back/forward) moves the focus
  // to its panel; arrows in the tab list keep it on the tab. The first render never moves it.
  useEffect(() => {
    if (previous.current === active) return;
    previous.current = active;
    if (!tablistRef.current?.contains(document.activeElement))
      panelRef.current?.focus({ preventScroll: true });
  }, [active]);
  function select(tab: CompanyTab, focus = false) {
    void navigate({
      to: "/app/$organizationSlug/companies/$companyId",
      params: { organizationSlug: org.slug, companyId: company.id },
      search: tabSearch(tab),
      replace: true,
    });
    if (focus) document.getElementById(`empresa-aba-${tab}`)?.focus();
  }
  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === active);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    select(tabs[next]!.id, true);
  }
  const panel = (() => {
    switch (active) {
      case "fiscal":
        return (
          <NfseProfile
            key={`nfse-profile:${company.id}:${contextKey}`}
            org={org}
            company={company}
            contextKey={contextKey}
          />
        );
      case "certificado":
        return (
          <Certificates
            key={`certificates:${company.id}:${contextKey}`}
            org={org}
            company={company}
            certificates={certificates}
          />
        );
      case "consulta":
        return (
          <Registry
            key={`${company.id}:${contextKey}`}
            org={org}
            company={company}
            contextKey={contextKey}
          />
        );
      case "captura":
        return (
          <Captures key={`capture:${company.id}:${contextKey}`} org={org} companyId={company.id} />
        );
      case "acesso":
        return <Grants org={org} company={company} contextKey={contextKey} />;
      case "historico":
        return <Activity org={org} company={company} contextKey={contextKey} />;
      default:
        return (
          <>
            <CompanyStatus
              org={org}
              company={company}
              contextKey={contextKey}
              certificates={certificates}
              tabs={tabs}
            />
            <CompanyRegistration org={org} company={company} />
            {company.kind === "demonstration" && (
              <Registry org={org} company={company} contextKey={contextKey} />
            )}
            {company.capabilities.manage && company.kind === "declared" && (
              <DeleteCompany org={org} company={company} contextKey={contextKey} />
            )}
          </>
        );
    }
  })();
  return (
    <Page>
      <div className="company-head">
        <div className="company-head__bar">
          <Link
            className={buttonClass({ variant: "ghost", size: "sm", className: "company-back" })}
            to="/app/$organizationSlug/companies"
            params={{ organizationSlug: org.slug }}
          >
            <Icon name="arrowLeft" />
            Todas as empresas
          </Link>
          <CompanySelector org={org} company={company} contextKey={contextKey} tab={active} />
        </div>
        <PageHeader
          title={company.name}
          description={
            <span className="company-identity">
              <span className="ui-mono">CNPJ {formatCnpj(company.cnpj)}</span>
              {company.kind === "demonstration" ? (
                <StatusBadge tone="info">Demonstração sandbox</StatusBadge>
              ) : null}
              <FiscalCaptureBadge value={company.fiscalCapture} />
            </span>
          }
        />
      </div>
      <div className="company-body">
        {tabs.length > 1 && (
          <div
            ref={tablistRef}
            className="ui-tabs__list company-tabs"
            role="tablist"
            aria-label="Seções da empresa"
            onKeyDown={keyDown}
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                id={`empresa-aba-${tab.id}`}
                type="button"
                role="tab"
                className="ui-tabs__tab"
                aria-selected={tab.id === active}
                // Only the active panel is mounted; the other tabs point at no element.
                aria-controls={tab.id === active ? `empresa-painel-${active}` : undefined}
                tabIndex={tab.id === active ? 0 : -1}
                onClick={() => select(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
        <div
          ref={panelRef}
          className="company-panel"
          id={`empresa-painel-${active}`}
          role={tabs.length > 1 ? "tabpanel" : undefined}
          aria-labelledby={tabs.length > 1 ? `empresa-aba-${active}` : undefined}
          tabIndex={tabs.length > 1 ? 0 : undefined}
        >
          {panel}
        </div>
      </div>
    </Page>
  );
}
