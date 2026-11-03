import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { usePaginatedQuery, useQuery } from "./convex-query";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import { registryLabels } from "./registry";
import { ErrorBoundary } from "./route-errors";
import { Card, DescriptionList, StatusBadge, buttonClass, type Tone } from "./ui";
import { tabSearch, type CompanyTab } from "./company-tabs";

// Summary of the company: registry, certificate, NFS-e profile and fiscal production, each with
// the shortcut to the tab where it changes.

type Company = NonNullable<FunctionReturnType<typeof api.companies.get>>;
type ScopeProps = { org: Organization; contextKey: string };

export type CertificatePage = ReturnType<typeof useCertificatePage>;
export function useCertificatePage(org: Organization, company: Company, contextKey: string) {
  return usePaginatedQuery(
    api.certificates.list,
    company.kind === "demonstration"
      ? "skip"
      : { organizationId: org.id, companyId: company.id, contextKey },
    { initialNumItems: 10 },
  );
}
type CertificateSummary = Pick<
  CertificatePage["results"][number],
  "version" | "state" | "metadata"
>;
/** Summarize the persisted certificates: the active version wins, then the latest upload. */
export function certificateStatus(
  results: CertificateSummary[],
  status: CertificatePage["status"],
): { text: string; tone: Tone } {
  if (status === "LoadingFirstPage") return { text: "Carregando…", tone: "neutral" };
  const active = results.find((cert) => cert.state === "active");
  const latest = results[0];
  const pending = latest !== undefined && ["uploading", "validating"].includes(latest.state);
  if (active)
    return {
      text: `Versão ${active.version} ativa${
        active.metadata
          ? `, válida até ${new Date(active.metadata.notAfter).toLocaleDateString("pt-BR")}`
          : ""
      }${pending ? ` · versão ${latest.version} em validação` : ""}`,
      tone: "success",
    };
  if (!latest) return { text: "Nenhum certificado enviado", tone: "neutral" };
  if (pending) return { text: `Versão ${latest.version} em validação`, tone: "warning" };
  if (status !== "Exhausted")
    return { text: "Nenhum ativo entre os envios recentes", tone: "warning" };
  const last: Partial<Record<CertificateSummary["state"], string>> = {
    rejected: "último envio rejeitado",
    revoked: "última versão desativada",
    expired: "última versão expirada",
    replaced: "última versão substituída",
  };
  const detail = last[latest.state];
  return {
    text: `Nenhum certificado ativo${detail ? ` (${detail})` : ""}`,
    tone: "danger",
  };
}
/** Same arguments as the profile section, so both share one subscription. */
function useNfseProfile(org: Organization, company: Company, contextKey: string) {
  return useQuery(api.nfseProfiles.get, {
    organizationId: org.id,
    companyId: company.id,
    contextKey,
  });
}
function NfseProfileLine({
  org,
  company,
  contextKey,
  tabs,
}: ScopeProps & { company: Company; tabs: Array<{ id: CompanyTab }> }) {
  const profile = useNfseProfile(org, company, contextKey);
  return (
    <StatusLine
      shortcut={
        profile === undefined ? null : (
          <Shortcut org={org} company={company} tabs={tabs} tab="fiscal" todo={!profile}>
            {profile ? "Ver perfil fiscal" : "Configurar perfil fiscal"}
          </Shortcut>
        )
      }
    >
      {profile === undefined ? (
        <StatusBadge>Carregando…</StatusBadge>
      ) : profile ? (
        <StatusBadge tone="success">Configurado, versão {profile.version}</StatusBadge>
      ) : (
        <StatusBadge tone="warning">Não configurado</StatusBadge>
      )}
    </StatusLine>
  );
}
/**
 * How far the company is, in one line above the items: what it already does and what is left.
 * Importing never waits for anything; issuing waits for the NFS-e profile (and, outside the
 * simulator, for the certificate).
 */
function Readiness({
  org,
  company,
  contextKey,
  certificateReady,
}: ScopeProps & { company: Company; certificateReady: boolean }) {
  const profile = useNfseProfile(org, company, contextKey);
  if (profile === undefined) return null;
  const done = [company.registryStatus === "found", certificateReady, !!profile];
  const count = done.filter(Boolean).length;
  return (
    <p className="company-readiness">
      <span className="company-readiness__count">
        {count} de {done.length} itens prontos
      </span>
      <span className="company-readiness__bar" aria-hidden="true">
        {done.map((ready, index) => (
          <span key={index} className={ready ? "is-ready" : undefined} />
        ))}
      </span>
      <span className="ui-help">
        {profile
          ? "Importa XML e emite NFS-e no sandbox."
          : "Já importa XML; a emissão NFS-e espera o perfil fiscal."}
      </span>
    </p>
  );
}
function Shortcut({
  org,
  company,
  tab,
  tabs,
  todo = false,
  children,
}: {
  org: Organization;
  company: Company;
  tab: CompanyTab;
  tabs: Array<{ id: CompanyTab }>;
  /** Something is left to do there: the shortcut reads as an action, not as a link. */
  todo?: boolean;
  children: ReactNode;
}) {
  if (!tabs.some((t) => t.id === tab)) return null;
  return (
    <Link
      className={todo ? buttonClass({ size: "sm" }) : "ui-link"}
      to="/app/$organizationSlug/companies/$companyId"
      params={{ organizationSlug: org.slug, companyId: company.id }}
      search={tabSearch(tab)}
    >
      {children}
    </Link>
  );
}
/** State and the shortcut to the tab where it changes, side by side. */
function StatusLine({ children, shortcut }: { children: ReactNode; shortcut?: ReactNode }) {
  return (
    <span className="company-status-line">
      <span className="company-status-line__value">{children}</span>
      {shortcut}
    </span>
  );
}
export function CompanyStatus({
  org,
  company,
  contextKey,
  certificates,
  tabs,
}: ScopeProps & {
  company: Company;
  certificates: CertificatePage;
  tabs: Array<{ id: CompanyTab }>;
}) {
  const demonstration = company.kind === "demonstration";
  const shortcut = { org, company, tabs };
  const certificate = certificateStatus(certificates.results, certificates.status);
  const certificateReady = certificate.tone === "success";
  const registryReady = company.registryStatus === "found";
  const production = {
    term: "Produção fiscal",
    value:
      company.fiscalAccess === "not-configured" ? (
        <StatusLine>
          <StatusBadge>Desligada</StatusBadge>
          <span className="ui-help">Emissão e consultas usam somente o sandbox.</span>
        </StatusLine>
      ) : (
        <StatusBadge tone="success">Liberada</StatusBadge>
      ),
  };
  // The demonstration has none of the three: one line says so, instead of three alike.
  if (demonstration)
    return (
      <Card title="Situação">
        <DescriptionList
          items={[
            {
              term: "Consulta, certificado e perfil",
              value: (
                <span className="ui-help">
                  Não se aplicam à demonstração: ela usa dados sintéticos, sem certificado nem
                  perfil de emissão.
                </span>
              ),
            },
            production,
          ]}
        />
      </Card>
    );
  return (
    <Card
      title="Situação"
      description="Importar XML não exige certificado. Certificado e perfil de emissão não ligam a produção, que depende de liberação para a empresa."
    >
      <ErrorBoundary fallback={null}>
        <Readiness
          org={org}
          company={company}
          contextKey={contextKey}
          certificateReady={certificateReady}
        />
      </ErrorBoundary>
      <DescriptionList
        items={[
          {
            term: "Consulta cadastral",
            value: (
              <StatusLine
                shortcut={
                  <Shortcut {...shortcut} tab="consulta" todo={!registryReady}>
                    {registryReady ? "Ver consulta CNPJ" : "Consultar CNPJ"}
                  </Shortcut>
                }
              >
                <StatusBadge tone={company.registryStatus === "found" ? "success" : "neutral"}>
                  {registryLabels[company.registryStatus]}
                </StatusBadge>
              </StatusLine>
            ),
          },
          {
            term: "Certificado digital",
            value: (
              <StatusLine
                shortcut={
                  certificates.status === "LoadingFirstPage" ? null : (
                    <Shortcut {...shortcut} tab="certificado" todo={!certificateReady}>
                      {certificateReady ? "Ver certificado" : "Enviar certificado"}
                    </Shortcut>
                  )
                }
              >
                <StatusBadge tone={certificate.tone}>{certificate.text}</StatusBadge>
              </StatusLine>
            ),
          },
          {
            term: "Perfil de emissão NFS-e",
            value: (
              // A failing profile read must not take the whole company page down; its section explains.
              <ErrorBoundary fallback={<span className="ui-help">Confira a aba Fiscal</span>}>
                <NfseProfileLine org={org} company={company} contextKey={contextKey} tabs={tabs} />
              </ErrorBoundary>
            ),
          },
          production,
        ]}
      />
    </Card>
  );
}
