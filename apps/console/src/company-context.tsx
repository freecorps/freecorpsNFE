import { useEffect, useState, type ReactNode } from "react";
import { usePaginatedQuery, useQuery } from "./convex-query";
import { ConvexError } from "convex/values";
import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { membershipRoleLabels } from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { Organization } from "./organizations";
import { useDeployment, type ProductEnvironment } from "./deployment";
import { Button, buttonClass } from "./ui/button";
import { FormField, Select } from "./ui/form";
import { Callout, EmptyState, SkeletonBlock } from "./ui/layout";
import {
  COMPANIES_PAGE_SIZE,
  companiesListArgs,
  companyContextArgs,
  companyScope,
  rememberedCompany,
  soleCompanyArgs,
  storageKey,
} from "./page-queries";

/**
 * Console sem projeto: the fiscal screens work on a company. Access comes from the membership,
 * the member's access to the company and the role; the server checks it again on every call.
 */
export type ConsoleCompany = NonNullable<FunctionReturnType<typeof api.consoleCompany.context>>;
export type CompanyScope = {
  organizationId: Id<"organizations">;
  companyId: Id<"companies">;
  environment: ProductEnvironment;
};

export { rememberedCompany };
function remember(organizationId: string, companyId: string | null) {
  try {
    if (companyId) globalThis.localStorage?.setItem(storageKey(organizationId), companyId);
    else globalThis.localStorage?.removeItem(storageKey(organizationId));
  } catch {
    // Private mode or a full storage: the URL still carries the choice.
  }
}

/**
 * The console reads every record of the company but changes only what was created in it; a
 * record of an integration is managed by that integration (`INTEGRATION_RECORD`).
 */
export function integrationRecordMessage(error: unknown) {
  const data = error instanceof ConvexError ? (error.data as unknown) : null;
  if (!data || typeof data !== "object" || !("code" in data) || data.code !== "INTEGRATION_RECORD")
    return undefined;
  const name =
    "integration" in data && typeof data.integration === "string" ? data.integration : null;
  return `${name ? `Criado pela integração ${name}` : "Criado por uma integração"}; gerencie pela integração. O console altera só o que foi criado nele.`;
}

const readerRoles = "Leitura, Operador, Administrador ou Proprietário";
const writerRoles = "Operador, Administrador ou Proprietário";

/** What the role can do here, said plainly; `null` when nothing is missing. */
export function RoleNotice({
  org,
  company,
  action,
}: {
  org: Organization;
  company: ConsoleCompany;
  /** What the screen would do, e.g. "enviar XML". */
  action: string;
}) {
  if (company.canWrite) return null;
  return (
    <Callout tone="info" role="status">
      <p>
        Seu papel nesta organização é {membershipRoleLabels[org.role]}: você pode consultar, mas{" "}
        {action} exige papel de {writerRoles}.
      </p>
    </Callout>
  );
}

/**
 * Company picker shared by the console's fiscal screens. The choice lives in the URL when the
 * screen has one (`selected`/`onSelect`) and is remembered per organization in `localStorage`,
 * so the next screen opens on the same company; with a single company it is selected. Explains
 * what is missing: no company, no access to the chosen one, or a role that cannot read.
 */
/**
 * The company the screen works on: the one in the URL or in the screen's state, else the one
 * remembered for the organization, else the only one available, as the server confirms it.
 * `company` is `undefined` while that answer is pending and `null` when there is none.
 * A screen that shows the company elsewhere (the steps above the picker) resolves it once and
 * hands the same choice to `CompanyContext`.
 *
 * With nothing chosen and the list not yet loaded, `consoleCompany.sole` asks the server for the
 * only company in the same round trip as the list, instead of waiting for the whole list first;
 * `context` follows for the company found, with the same arguments the remembered choice will use
 * on the next render, so the subscription carries on.
 */
export function useCompanyChoice(org: Organization, contextKey: string, selected: string) {
  const scope = { org, contextKey };
  const companies = usePaginatedQuery(api.companies.list, companiesListArgs(scope), {
    initialNumItems: COMPANIES_PAGE_SIZE,
  });
  const remembered = rememberedCompany(org.id);
  // Only when this screen opened with nothing remembered and the list still on its way (a list
  // already in the organization's cache answers at once). A company remembered later, by this
  // same hook, or forgotten (inaccessible) goes on through `context` and the list, as before.
  const [askSole] = useState(() => !remembered && companies.status === "LoadingFirstPage");
  // Once the list answered it says whether there is a single company: `sole` is released then.
  const sole = useQuery(
    api.consoleCompany.sole,
    askSole && !selected && companies.status === "LoadingFirstPage"
      ? soleCompanyArgs(scope)
      : "skip",
  );
  const only =
    companies.status === "Exhausted" && companies.results.length === 1
      ? companies.results[0]!.id
      : "";
  const candidate = selected || remembered || sole?.id || only;
  const confirmed = useQuery(
    api.consoleCompany.context,
    candidate ? companyContextArgs(scope, candidate) : "skip",
  );
  // The only company is already confirmed by `sole`, with the same answer as `context`.
  const company =
    confirmed === undefined && !selected && sole && sole.id === candidate ? sole : confirmed;
  const fromUrl = !!selected && candidate === selected;
  useEffect(() => {
    if (company) remember(org.id, company.id);
    // A remembered company that is gone or no longer accessible is forgotten silently.
    else if (company === null && !fromUrl && candidate === remembered) remember(org.id, null);
  }, [company, fromUrl, candidate, remembered, org.id]);
  // `sole` never holds the screen: once the list answered, it already says whether there is one.
  const loading = companies.status === "LoadingFirstPage" || (!!candidate && company === undefined);
  return { companies, candidate, company: candidate ? company : null, fromUrl, loading };
}
export type CompanyChoice = ReturnType<typeof useCompanyChoice>;

type CompanyContextProps = {
  org: Organization;
  contextKey: string;
  /** Company in the URL or in the screen's state; empty when none was chosen. */
  selected: string;
  onSelect: (companyId: Id<"companies">) => void;
  id: string;
  label: string;
  /** `company`: any member with access to the company; `read`: a reading role. */
  need?: "company" | "read";
  /**
   * `false` on a record's own page (a document, an issuance): the company comes from the URL,
   * the same checks and messages apply, but the picker gives the screen to the record.
   */
  picker?: boolean;
  children: (company: ConsoleCompany, scope: CompanyScope) => ReactNode;
};
export function CompanyContext({
  choice,
  ...props
}: CompanyContextProps & {
  /** The choice already resolved by the screen (`useCompanyChoice`), when it shows it too. */
  choice?: CompanyChoice;
}) {
  return choice ? <CompanyPicker {...props} choice={choice} /> : <OwnCompanyContext {...props} />;
}
function OwnCompanyContext(props: CompanyContextProps) {
  const choice = useCompanyChoice(props.org, props.contextKey, props.selected);
  return <CompanyPicker {...props} choice={choice} />;
}
function CompanyPicker({
  org,
  onSelect,
  id,
  label,
  need = "read",
  picker = true,
  children,
  choice,
}: CompanyContextProps & { choice: CompanyChoice }) {
  const { companies, company, fromUrl, loading } = choice;
  const current = company ?? null;
  const deployment = useDeployment();
  const manager = org.capabilities.manageOrganization;
  return (
    <>
      {picker ? (
        <div className="fiscal-context">
          <FormField id={id} label={label}>
            <Select
              id={id}
              disabled={loading}
              value={current?.id ?? ""}
              onChange={(event) => {
                if (event.target.value) onSelect(event.target.value as Id<"companies">);
              }}
            >
              <option value="">Selecione uma empresa</option>
              {current && !companies.results.some((row) => row.id === current.id) ? (
                <option value={current.id}>
                  {current.name} · {current.cnpj}
                </option>
              ) : null}
              {companies.results.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} · {row.cnpj}
                </option>
              ))}
            </Select>
          </FormField>
          {companies.status === "CanLoadMore" || (current && manager) ? (
            <div className="fiscal-context__aside">
              {companies.status === "CanLoadMore" ? (
                <Button size="sm" onClick={() => companies.loadMore(20)}>
                  Carregar mais empresas
                </Button>
              ) : null}
              {current && manager ? (
                <Link
                  className="ui-link"
                  to="/app/$organizationSlug/companies/$companyId"
                  params={{ organizationSlug: org.slug, companyId: current.id }}
                >
                  Gerenciar quem acessa esta empresa
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {/* The scope's environment is the deployment's: no screen queries with the build's hint. */}
      {loading || (current && !deployment.confirmed) ? (
        <SkeletonBlock label="Carregando empresas disponíveis…" lines={2} />
      ) : company === null && fromUrl ? (
        <Callout tone="danger" role="alert" headingLevel={2} title="Empresa indisponível">
          <p>
            Você não tem acesso a esta empresa ou ela não existe nesta organização.{" "}
            {picker ? "Escolha outra empresa acima." : "Volte à lista e escolha outra empresa."}
          </p>
          {manager ? (
            <p>
              <Link
                className="ui-link"
                to="/app/$organizationSlug/companies"
                params={{ organizationSlug: org.slug }}
              >
                Ver as empresas da organização
              </Link>
            </p>
          ) : (
            <p>
              Peça a um proprietário ou administrador para liberar seu acesso a ela em Empresas.
            </p>
          )}
        </Callout>
      ) : !current && companies.status === "Exhausted" && !companies.results.length ? (
        <EmptyState
          icon="building"
          title={manager ? "Comece por uma empresa" : "Nenhuma empresa liberada para você"}
          description={
            manager
              ? "O trabalho fiscal do console acontece em uma empresa da organização."
              : "O acesso às empresas é dado por pessoa. Peça a um proprietário ou administrador para liberar uma empresa para você em Empresas."
          }
          actions={
            manager ? (
              <Link
                className={buttonClass({ variant: "primary" })}
                to="/app/$organizationSlug/onboarding"
                params={{ organizationSlug: org.slug }}
              >
                Ver primeiros passos
              </Link>
            ) : undefined
          }
        />
      ) : !current ? (
        <p className="ui-help">
          {picker ? "Escolha a empresa acima." : "Volte à lista e escolha a empresa."}
        </p>
      ) : null}
      {current && need === "read" && !current.canRead ? (
        <Callout tone="warning" role="alert">
          <p>
            Seu papel nesta organização é {membershipRoleLabels[org.role]}. Esta área exige papel de{" "}
            {readerRoles}; desenvolvedores acessam os dados fiscais pelas integrações (API e
            webhooks).
          </p>
        </Callout>
      ) : current && deployment.confirmed ? (
        children(current, companyScope(org.id, current.id, deployment.environment))
      ) : null}
    </>
  );
}
