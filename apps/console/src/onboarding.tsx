import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { usePaginatedQuery, useQuery } from "./convex-query";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { Organization } from "./organizations";
import { controlProps } from "./field";
import {
  Button,
  Callout,
  Card,
  FormField,
  Icon,
  Page,
  PageHeader,
  Select,
  StatusBadge,
  buttonClass,
} from "./ui";
import { Loading, More, errorText } from "./company-feedback";
import { CREATE_ANCHOR } from "./company-form";

// First steps of the organization: how to start, the company followed and the first import.

type ScopeProps = { org: Organization; contextKey: string };

export function Onboarding({ org, contextKey }: ScopeProps) {
  const state = useQuery(api.onboarding.get, { organizationId: org.id, contextKey });
  if (state === undefined)
    return (
      <Page>
        <Card label="Primeiros passos">
          <Loading label="Carregando os primeiros passos…" />
        </Card>
      </Page>
    );
  return <OnboardingSteps key={state.version} org={org} contextKey={contextKey} state={state} />;
}
type OnboardingState = FunctionReturnType<typeof api.onboarding.get>;
/** Text of each step, without ambiguous "pending or no access". */
export function onboardingStatus(state: OnboardingState) {
  return {
    mode: state.mode
      ? state.mode === "manual"
        ? "Cadastro manual escolhido"
        : "Demonstração escolhida"
      : state.canManage
        ? "Ainda não escolhido"
        : "A cargo da equipe responsável",
    company: state.company
      ? "Empresa preparada"
      : !state.canManage
        ? "Nenhuma empresa liberada para você"
        : state.mode === "manual"
          ? "Cadastre ou escolha uma empresa"
          : state.mode === "demonstration"
            ? "Escolha uma empresa"
            : "Escolha como começar primeiro",
    document:
      state.firstDocument === "imported"
        ? "Documento importado"
        : state.company
          ? "Aguardando importação"
          : "Prepare uma empresa primeiro",
  };
}
function OnboardingSteps({ org, contextKey, state }: ScopeProps & { state: OnboardingState }) {
  const start = useMutation(api.onboarding.start),
    selectCompany = useMutation(api.onboarding.selectCompany),
    dismiss = useMutation(api.onboarding.dismissGuidance),
    navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { results, status, loadMore } = usePaginatedQuery(
    api.companies.list,
    { organizationId: org.id, contextKey },
    { initialNumItems: 20 },
  );
  const text = onboardingStatus(state);
  const createLink = {
    to: "/app/$organizationSlug/companies" as const,
    params: { organizationSlug: org.slug },
    hash: CREATE_ANCHOR,
  };
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (error) {
      setError(errorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function chooseManual() {
    const saved =
      state.mode === "manual" ||
      (await run(() =>
        start({ organizationId: org.id, mode: "manual", expectedVersion: state.version }),
      ));
    if (saved) await navigate(createLink);
  }
  const describedBy = busy ? "onboarding-busy" : undefined;
  const actionClass = buttonClass({ size: "sm" });
  const steps: Array<{
    key: string;
    title: string;
    done: boolean;
    status: string;
    note?: ReactNode;
    action?: ReactNode;
  }> = [
    {
      key: "mode",
      title: "Escolher como começar",
      done: Boolean(state.mode),
      status: text.mode,
    },
    {
      key: "company",
      title: "Preparar uma empresa",
      done: Boolean(state.company),
      status: text.company,
      note:
        !state.company && !state.canManage
          ? "Um proprietário ou administrador precisa liberar o acesso a uma empresa para você."
          : undefined,
      action: state.company ? (
        <Link
          className={actionClass}
          to="/app/$organizationSlug/companies/$companyId"
          params={{ organizationSlug: org.slug, companyId: state.company.id }}
        >
          Abrir {state.company.name}
        </Link>
      ) : state.canManage && state.mode === "manual" ? (
        <Link className={actionClass} {...createLink}>
          Cadastrar a empresa
        </Link>
      ) : null,
    },
    {
      key: "document",
      title: "Importar o primeiro documento",
      done: state.firstDocument === "imported",
      status: text.document,
      note:
        state.firstDocument === "imported"
          ? "Um documento já foi registrado para esta empresa."
          : state.company
            ? "Sua empresa está pronta para importar XMLs. Acompanhe o resultado por arquivo na página de importação."
            : "A importação fica disponível depois que uma empresa estiver preparada.",
      action: state.company ? (
        <Link
          className={actionClass}
          to="/app/$organizationSlug/imports"
          params={{ organizationSlug: org.slug }}
          search={{ company: state.company.id }}
        >
          {/* A link only leads there: the import itself is the explicit action on that page. */}
          {state.company.kind === "demonstration" && org.capabilities.operateDocuments
            ? "Ir para a importação do exemplo"
            : "Importar XML e acompanhar resultados"}
        </Link>
      ) : null,
    },
  ];
  return (
    <Page>
      <PageHeader
        eyebrow="Primeiros passos"
        title="Comece pela sua empresa."
        description="Seu progresso fica salvo nesta organização. Explore a demonstração ou informe os dados da sua empresa, sem precisar de um certificado."
      />
      <Card title="Etapas" description="O progresso mostra o que já está salvo no servidor.">
        <ol className="home-steps">
          {steps.map((step, index) => (
            <li key={step.key} className={step.done ? "is-done" : undefined}>
              <span className="home-step-index" aria-hidden="true">
                {step.done ? <Icon name="check" /> : index + 1}
              </span>
              <div>
                <p className="home-item__title">
                  {step.title}
                  <StatusBadge tone={step.done ? "success" : "neutral"}>{step.status}</StatusBadge>
                </p>
                {step.note ? <p className="home-item__note">{step.note}</p> : null}
              </div>
              {step.action ?? <span />}
            </li>
          ))}
        </ol>
      </Card>
      {state.canManage ? (
        <Card
          title="Escolha seu começo."
          description="A demonstração usa dados sintéticos. O cadastro manual conserva os dados declarados pela equipe. Trocar o caminho mantém as empresas já cadastradas."
        >
          <div className="ui-stack">
            <div className="ui-actions">
              {state.mode === "demonstration" ? (
                <StatusBadge tone="success">Demonstração escolhida.</StatusBadge>
              ) : (
                <Button
                  variant="primary"
                  disabled={busy}
                  aria-describedby={describedBy}
                  onClick={() =>
                    void run(() =>
                      start({
                        organizationId: org.id,
                        mode: "demonstration",
                        expectedVersion: state.version,
                      }),
                    )
                  }
                >
                  Explorar demonstração
                </Button>
              )}
              {state.mode === "demonstration" && state.company ? (
                <Link
                  className="ui-link"
                  to="/app/$organizationSlug/companies/$companyId"
                  params={{ organizationSlug: org.slug, companyId: state.company.id }}
                >
                  Abrir a empresa de demonstração
                </Link>
              ) : null}
              <Button
                disabled={busy}
                aria-describedby={describedBy}
                onClick={() => void chooseManual()}
              >
                {state.mode === "manual" ? "Abrir cadastro de empresa" : "Cadastrar minha empresa"}
              </Button>
            </div>
            {busy ? (
              <p id="onboarding-busy" className="ui-help" role="status">
                Salvando sua escolha…
              </p>
            ) : null}
            {error ? (
              <Callout tone="danger" role="alert">
                {error}
              </Callout>
            ) : null}
            {results.length > 0 && (
              <div className="company-onboarding-pick">
                <FormField
                  id="onboarding-company"
                  label="Empresa dos primeiros passos"
                  help="A empresa que as etapas acima acompanham."
                >
                  <Select
                    {...controlProps("onboarding-company", undefined, true)}
                    value={state.company?.id ?? ""}
                    disabled={busy}
                    aria-describedby={["onboarding-company-help", describedBy]
                      .filter(Boolean)
                      .join(" ")}
                    onChange={(event) => {
                      const companyId = event.target.value;
                      if (companyId)
                        void run(() =>
                          selectCompany({
                            organizationId: org.id,
                            companyId: companyId as Id<"companies">,
                            expectedVersion: state.version,
                          }),
                        );
                    }}
                  >
                    <option value="">Escolher empresa cadastrada</option>
                    {state.company && !results.some((c) => c.id === state.company?.id) && (
                      <option value={state.company.id}>{state.company.name}</option>
                    )}
                    {results.map((company) => (
                      <option key={company.id} value={company.id}>
                        {company.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <More status={status} loadMore={loadMore} label="Mais empresas" />
              </div>
            )}
            {state.mode ? (
              state.guidanceDismissed ? (
                <p className="ui-help">
                  Orientação dispensada. As etapas continuam mostrando o progresso real.
                </p>
              ) : (
                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-describedby={describedBy}
                    onClick={() =>
                      void run(() =>
                        dismiss({ organizationId: org.id, expectedVersion: state.version }),
                      )
                    }
                  >
                    Dispensar orientação
                  </Button>
                </div>
              )
            ) : null}
          </div>
        </Card>
      ) : (
        <Callout tone="info">
          A equipe responsável configura os primeiros passos. Solicite acesso às empresas com as
          quais você vai trabalhar.
        </Callout>
      )}
    </Page>
  );
}
