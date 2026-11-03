import { Link } from "@tanstack/react-router";
import type { Organization } from "./organizations";
import { Icon, type IconName } from "./ui/icons";

/** A tela aberta: a vista da organização ou `settings:<seção>`. */
export type CurrentView = string;
export type Destination = {
  key: string;
  label: string;
  icon: IconName;
  group: "Trabalho fiscal" | "Cadastro" | "Organização" | null;
  to: string;
  params: Record<string, string>;
  /** Termos extras para a busca da paleta. */
  keywords?: string;
  current: (view: CurrentView) => boolean;
};

/**
 * Destinos da organização, por papel. Só aparece o que o papel usa; o servidor continua negando
 * o resto (esconder o item é orientação, não proteção). O developer trabalha pelas integrações e
 * não lê documentos, importações, emissões ou exportações no console (ADR 0005); importar exige
 * um papel que opera documentos. Exportações ficam para quem lê documentos: quem lê uma nota
 * pode exportá-la. A organização já foi autorizada pelo contexto que protege o conteúdo.
 * A lateral e a paleta de comandos usam esta mesma lista.
 */
export function organizationDestinations(org: Organization): Destination[] {
  const params = { organizationSlug: org.slug };
  const is =
    (...views: string[]) =>
    (view: CurrentView) =>
      views.includes(view);
  const list: Destination[] = [
    {
      key: "overview",
      label: "Início",
      icon: "home",
      group: null,
      to: "/app/$organizationSlug",
      params,
      keywords: "resumo pendências prontidão",
      // Os primeiros passos moram dentro do Início.
      current: is("overview", "onboarding"),
    },
  ];
  if (org.capabilities.readDocuments) {
    list.push(
      {
        key: "documents",
        label: "Documentos",
        icon: "document",
        group: "Trabalho fiscal",
        to: "/app/$organizationSlug/documents",
        params,
        keywords: "notas nfe nf-e xml",
        // The DANFE lookup belongs to Importar XML; without it, to Documentos.
        current: org.capabilities.operateDocuments ? is("documents") : is("documents", "danfe"),
      },
      {
        key: "issuances",
        label: "Emissão NFS-e",
        icon: "receipt",
        group: "Trabalho fiscal",
        to: "/app/$organizationSlug/issuances",
        params,
        keywords: "nfse emitir notas serviço",
        current: is("issuances"),
      },
    );
    if (org.capabilities.operateDocuments)
      list.push({
        key: "imports",
        label: "Importar XML",
        icon: "upload",
        group: "Trabalho fiscal",
        to: "/app/$organizationSlug/imports",
        params,
        keywords: "enviar arquivos lote",
        current: is("imports", "danfe"),
      });
    list.push({
      key: "exports",
      label: "Exportações",
      icon: "download",
      group: "Trabalho fiscal",
      to: "/app/$organizationSlug/exports",
      params,
      keywords: "baixar pacote",
      current: is("exports"),
    });
  }
  list.push(
    {
      key: "companies",
      label: "Empresas",
      icon: "building",
      group: "Cadastro",
      to: "/app/$organizationSlug/companies",
      params,
      keywords: "cnpj certificado perfil",
      current: is("companies"),
    },
    {
      key: "references",
      label: "Municípios e NCM",
      icon: "book",
      group: "Cadastro",
      to: "/app/$organizationSlug/references",
      params,
      keywords: "ibge tabelas referências",
      current: is("references"),
    },
  );
  if (org.capabilities.manageIntegrations)
    list.push({
      key: "developer",
      label: "Projetos e chaves",
      icon: "code",
      group: "Organização",
      to: "/app/$organizationSlug/developer/$developerSection",
      params: { ...params, developerSection: "projects" },
      keywords: "api chaves webhooks integrações desenvolvedor",
      current: is("developer"),
    });
  if (org.capabilities.manageMembers)
    list.push({
      key: "members",
      label: "Membros",
      icon: "users",
      group: "Organização",
      to: "/app/$organizationSlug/settings/$section",
      params: { ...params, section: "members" },
      keywords: "convites pessoas papéis equipe",
      current: is("settings:members"),
    });
  if (org.capabilities.manageOrganization)
    list.push(
      {
        key: "usage",
        label: "Uso e limites",
        icon: "gauge",
        group: "Organização",
        to: "/app/$organizationSlug/usage",
        params,
        keywords: "consumo cota plano",
        current: is("usage"),
      },
      {
        key: "operations",
        label: "Operação e suporte",
        icon: "lifebuoy",
        group: "Organização",
        to: "/app/$organizationSlug/operations",
        params,
        keywords: "auditoria referência monitor",
        current: is("operations"),
      },
      {
        key: "settings",
        label: "Configurações",
        icon: "settings",
        group: "Organização",
        to: "/app/$organizationSlug/settings/$section",
        params: { ...params, section: "organization" },
        keywords: "nome encerrar",
        current: is("settings:organization"),
      },
    );
  return list;
}

/** Lateral da organização: Início e os grupos Trabalho fiscal, Cadastro e Organização. */
export function OrganizationNavigation({
  org,
  current,
  onNavigate,
}: {
  org: Organization;
  current: CurrentView;
  onNavigate?: () => void;
}) {
  const destinations = organizationDestinations(org);
  const groups = new Map<Destination["group"], Destination[]>();
  for (const destination of destinations)
    groups.set(destination.group, [...(groups.get(destination.group) ?? []), destination]);
  return (
    <nav className="app-nav" aria-label="Navegação da organização">
      {[...groups.entries()].map(([group, items]) => (
        <div className="app-nav__group" key={group ?? "start"}>
          {group && <p className="app-nav__label">{group}</p>}
          {items.map((item) => (
            <Link
              key={item.key}
              // Destinos montados acima a partir das rotas declaradas em routes.tsx.
              to={item.to as "/app/$organizationSlug"}
              params={item.params as { organizationSlug: string }}
              className="app-nav__item"
              // O router marcaria "Início" em toda subpágina; quem decide é `current`.
              activeOptions={{ exact: true, includeSearch: false }}
              aria-current={item.current(current) ? "page" : undefined}
              onClick={onNavigate}
            >
              <Icon name={item.icon} />
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
