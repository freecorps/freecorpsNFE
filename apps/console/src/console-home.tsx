import { useState } from "react";
import { useQuery } from "convex/react";
import { Link, Navigate, useSearch } from "@tanstack/react-router";
import { api } from "../../../platform/convex/_generated/api";
import { taskSearch } from "./console-task";
import { rememberedOrganization } from "./session-handoff";
import { Notice } from "./route-errors";
import { validationProfile, version } from "./environment";
import { Pending } from "./session-layout";
import { buttonClass } from "./ui/button";
import { Card, DescriptionList, Page, PageHeader, StatusBadge } from "./ui/layout";

/**
 * `/console` (and the brand) open the work: the organization remembered in this browser or the
 * only one; the list only with none or several and none remembered. Platform validators of the
 * hosted validation deployment keep their own page (M0), which does not depend on organizations.
 */
export function Overview() {
  const current = useQuery(api.access.session);
  if (current === undefined) return <Pending />;
  return validationProfile && current?.role ? <ValidationOverview /> : <HomeRedirect />;
}
/**
 * The task chosen before the account (`?tarefa=`, from `taskEntryHref`) goes on to the Início, or
 * to the list that creates the first organization; an unknown value is dropped here.
 */
function HomeRedirect() {
  const [remembered] = useState(rememberedOrganization);
  const search = taskSearch((useSearch({ strict: false }) as { tarefa?: unknown }).tarefa);
  const target = useQuery(api.organizations.landing, { remembered });
  if (target === undefined) return <Pending />;
  return target ? (
    <Navigate
      to="/app/$organizationSlug"
      params={{ organizationSlug: target.slug }}
      search={search}
      replace
    />
  ) : (
    <Navigate to="/app" search={search} replace />
  );
}
function ValidationOverview() {
  const data = useQuery(api.access.overview);
  // The task that came with the address goes on to the organizations, as the home redirect does.
  const search = taskSearch((useSearch({ strict: false }) as { tarefa?: unknown }).tarefa);
  if (!data) return <Pending />;
  return (
    <Page>
      <PageHeader
        eyebrow="Validação · Visão geral"
        title="O primeiro passo está funcionando."
        description="Sua conta está conectada ao ambiente de teste da plataforma."
      />
      <Card
        title="Acesso confirmado pelo servidor"
        description={`Sessão válida · Perfil ${data.role === "operator" ? "operador" : "leitura"}`}
        actions={<StatusBadge tone="success">Conectado</StatusBadge>}
      />
      <Card title="Um ambiente para validar juntos." description="Entrega atual">
        <DescriptionList
          items={[
            {
              term: "Disponível agora",
              value: (
                <>
                  Organizações, importação de XML, consulta de documentos, emissão de NFS-e em
                  sandbox (simulada, sem validade fiscal) e{" "}
                  <Link className="ui-link" to="/app" search={search}>
                    área de cada organização
                  </Link>
                  .
                </>
              ),
            },
            {
              term: "Fora da 1.0",
              value:
                "Emissão com validade fiscal, emissão de NF-e e NFC-e e cálculo tributário. A produção fiscal da NFS-e continua desligada.",
            },
            {
              term: "Integrações fiscais",
              value: "Desativadas neste ambiente. Não envie documentos ou certificados reais.",
            },
          ]}
        />
      </Card>
      <p className="gestao-help">
        Este painel acompanha a construção da versão 1.0. As funcionalidades são liberadas conforme
        cada etapa é validada.
      </p>
    </Page>
  );
}

export function Diagnostics() {
  const current = useQuery(api.access.session);
  const operator = current?.role === "operator";
  // Only platform operators read diagnostics; asking anyway makes the server deny it and the
  // error boundary would send a signed-in person to the login.
  const data = useQuery(api.access.diagnostics, operator ? {} : "skip");
  if (current === undefined) return <Pending />;
  if (!operator)
    return (
      <Notice
        eyebrow="Permissão necessária"
        title="Diagnóstico restrito."
        action={
          <Link className={buttonClass()} to="/console">
            Voltar ao início
          </Link>
        }
      >
        Esta página é reservada aos operadores da plataforma. Sua sessão continua ativa; volte ao
        início para continuar.
      </Notice>
    );
  if (!data) return <Pending />;
  // Both checks belong to the validation console. The persistence record is a validation probe:
  // besides validation, only the hosted service creates it, once at bootstrap, as a release gate,
  // and other builds never have it, so elsewhere it says nothing about this deployment. The server
  // does not report fiscal integrations: the validation console states they are disabled because
  // nothing fiscal runs there, and elsewhere capture is released per company.
  const checks = validationProfile
    ? [
        {
          term: "Registro de persistência",
          value: (
            <StatusBadge tone={data.persistentRecordPresent ? "success" : "warning"}>
              {data.persistentRecordPresent ? "Preservado" : "Ausente"}
            </StatusBadge>
          ),
        },
        {
          term: "Integrações fiscais",
          value: <StatusBadge tone="neutral">Desativadas</StatusBadge>,
        },
      ]
    : [];
  return (
    <Page>
      <PageHeader
        eyebrow={validationProfile ? "Validação · Diagnóstico" : "Plataforma · Diagnóstico"}
        title="Estado do ambiente."
        description={
          validationProfile
            ? "Informações verificadas pelo servidor. Disponíveis para operadores."
            : "Versão deste painel. Disponível para operadores."
        }
      />
      <Card title={validationProfile ? "Verificações do servidor" : "Painel"}>
        <DescriptionList
          items={[
            ...checks,
            { term: "Versão do painel", value: <span className="ui-mono">{version}</span> },
          ]}
        />
      </Card>
    </Page>
  );
}
