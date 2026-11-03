import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ErrorBoundary } from "./route-errors";
import { useMutation } from "convex/react";
import { usePaginatedQuery, useQuery } from "./convex-query";
import { ConvexError } from "convex/values";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { Organization } from "./organizations";
import {
  CopyButton,
  DownloadFeedback,
  OriginLabel,
  ScopeSteps,
  useListPosition,
  useTicketDownload,
} from "./product-components";
import { CompanyContext, useCompanyChoice } from "./company-context";
import { IssuanceForm, SimulatorTip } from "./issuance-form";
import {
  ProductionNote,
  ProductionSummary,
  productionClosedNote,
  takerLabel,
  type ProductionSummaryItems,
} from "./issuance-production";
import { ConfirmDialog } from "./ui/dialog";
import { useFiscalRead } from "./fiscal-read";
import { environmentNames, useDeployment } from "./deployment";
import { targetLabels, transportLabels, type Transport } from "./issuance-draft";
import type { IssuanceScope } from "./municipality";
import {
  formatBRL,
  formatCnpj,
  formatCompetence,
  formatCompetenceLong,
  formatCep,
  formatCpf,
  formatDateTime,
  formatDateTimeSeconds,
  formatDecimal,
  formatIsoDate,
  formatMoney,
  groupKey,
} from "./format";
import { Button, buttonClass } from "./ui/button";
import { Icon } from "./ui/icons";
import { DataTable, type Column } from "./ui/data-table";
import { Disclosure } from "./ui/disclosure";
import { FormField, Input, Select, Textarea } from "./ui/form";
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

export type IssuanceSearch = {
  company?: string;
  issuance?: string;
  view?: string;
};
type Detail = FunctionReturnType<typeof api.issuanceConsole.detail>;
type View = Detail["issuance"];
type Row = FunctionReturnType<typeof api.issuanceConsole.list>["page"][number];

// ---------------------------------------------------------------------------------------------
// State shown to the person. "Autorizada" only after the answer of the tax authority (or of the
// sandbox simulator) was persisted; while the operation runs, the label says what is pending.

/** Tone of the `StatusBadge`; the label always says the state, the color only reinforces it. */
type StatusTone = "success" | "warning" | "danger" | "neutral";
export function issuanceStatus(view: Pick<View, "state" | "operationState" | "cancellation">): {
  label: string;
  tone: StatusTone;
  note: string;
} {
  if (view.state === "authorized") {
    const cancellation = view.cancellation;
    if (cancellation?.state === "processing")
      return {
        label: "Cancelamento em andamento",
        tone: "warning",
        note: "A nota segue autorizada até o evento de cancelamento ser registrado.",
      };
    if (cancellation?.state === "rejected")
      return {
        label: "Autorizada",
        tone: "success",
        note: "O último pedido de cancelamento foi rejeitado; a nota segue autorizada.",
      };
    return { label: "Autorizada", tone: "success", note: "" };
  }
  if (view.state === "cancelled")
    return {
      label: "Cancelada",
      tone: "danger",
      note: "Evento de cancelamento registrado.",
    };
  if (view.state === "rejected")
    return {
      label: "Rejeitada",
      tone: "danger",
      note: "O número da DPS fica consumido. A correção sai em um novo pedido, com outro número.",
    };
  switch (view.operationState) {
    case "queued":
      return {
        label: "Aceita, na fila",
        tone: "neutral",
        note: "Pedido aceito e número da DPS reservado. A transmissão começa em seguida.",
      };
    case "running":
      return {
        label: "Transmitindo",
        tone: "neutral",
        note: "A DPS está sendo montada ou enviada. Aguardando a resposta do fisco.",
      };
    case "retry_wait":
      return {
        label: "Aguardando nova tentativa",
        tone: "warning",
        note: "O envio não foi concluído e será repetido automaticamente.",
      };
    case "reconciling":
      return {
        label: "Em reconciliação",
        tone: "warning",
        note: "A resposta do fisco não chegou. A plataforma consulta a DPS antes de qualquer reenvio; não emita de novo.",
      };
    case "paused":
      return {
        label: "Pausada",
        tone: "danger",
        note: "As tentativas foram suspensas. Um administrador pode retomar em Operação e suporte; a retomada consulta antes de reenviar.",
      };
    case "failed":
      return {
        label: "Sem desfecho",
        tone: "danger",
        note: "A operação terminou sem resposta registrada do fisco. Procure o suporte antes de emitir de novo.",
      };
    default:
      return {
        label: "Em processamento",
        tone: "neutral",
        note: "Pedido aceito. Aguardando a resposta do fisco.",
      };
  }
}
function StatusLabel({ view }: { view: Parameters<typeof issuanceStatus>[0] }) {
  const status = issuanceStatus(view);
  return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
}

const codeLabels: Record<string, string> = {
  ADN_REJECTED: "Rejeitada pelo fisco",
  ADN_UNAVAILABLE: "Fisco indisponível",
  ADN_RATE_LIMITED: "Fisco limitou a frequência de envios",
  ADN_ACCESS_DENIED: "Fisco recusou o acesso do certificado",
  TRANSPORT_UNCERTAIN: "Resposta do fisco perdida",
  RESPONSE_UNREADABLE: "Resposta do fisco ilegível",
  HTTP_UNEXPECTED: "Resposta inesperada do fisco",
  DPS_ALREADY_EXISTS: "DPS já existente no fisco",
  CONSULT_INCONCLUSIVE: "Consulta ao fisco inconclusiva",
  TRANSPORT_FAILED: "Falha de comunicação",
  NFSE_DOWNLOAD_PENDING: "Download da NFS-e pendente",
  PTAX_UNAVAILABLE: "Cotação PTAX indisponível",
  ISSUANCE_TRANSPORT_DISABLED: "Transporte fiscal desligado",
  ISSUANCE_CHANGED: "Emissão alterada durante o envio",
  CERTIFICATE_UNAVAILABLE: "Certificado indisponível",
  DPS_FIELD_INVALID: "Campo da DPS inválido",
  DPS_SCHEMA_INVALID: "DPS fora do XSD oficial, não enviada",
  EVENT_FIELD_INVALID: "Campo do pedido de cancelamento inválido",
  EVENT_SCHEMA_INVALID: "Pedido de cancelamento fora do XSD oficial, não enviado",
  DPS_ID_MISMATCH: "Identificador da DPS divergente",
  ENVIRONMENT_MISMATCH: "Ambiente divergente",
};
const codeLabel = (code: string) => codeLabels[code] ?? code;
/** "2.5000" → "2,5": the rate is exact text; only trailing zeros go away. */
const formatRate = (rate: string) =>
  formatDecimal(rate.includes(".") ? rate.replace(/\.?0+$/, "") : rate);
const eventLabels: Record<Detail["events"][number]["kind"], string> = {
  accepted: "Pedido aceito e número da DPS reservado",
  exchange_frozen: "Cotação PTAX congelada",
  dps_saved: "DPS montada e preservada",
  submitted: "DPS enviada",
  authorized: "NFS-e autorizada",
  rejected: "Emissão rejeitada",
  cancel_requested: "Cancelamento pedido",
  cancel_submitted: "Pedido de cancelamento enviado",
  cancelled: "Cancelamento registrado",
  cancel_rejected: "Cancelamento rejeitado",
  danfse_saved: "DANFSe gerado",
  danfse_failed: "DANFSe não gerado",
};
const artifactLabels: Record<View["artifacts"][number]["kind"], string> = {
  dps: "DPS",
  nfse: "NFS-e autorizada",
  "cancel-request": "Pedido de cancelamento",
  "cancel-event": "Evento de cancelamento",
  danfse: "DANFSe (PDF)",
};
export const cancelReasons = { "1": "Erro na emissão", "2": "Serviço não prestado", "9": "Outros" };
const targetShort: Record<string, string> = {
  "sefin-nacional": "Sefin Nacional",
  "campinas-adn": "Campinas (IMA)",
};
const transportShort: Record<Transport, string> = {
  simulated: "Simulada",
  "producao-restrita": "Produção restrita",
  producao: "Produção",
};

/** What the person can do with the issuance now, or why nothing. */
export function issuanceAction(
  view: Pick<View, "state" | "operationState" | "cancellation">,
  canCancel: boolean,
): { label: string; cancel: boolean } {
  if (view.state === "authorized") {
    if (view.cancellation?.state === "processing")
      return { label: "Nenhuma: aguarde o registro do evento de cancelamento.", cancel: false };
    return canCancel
      ? { label: "Cancelar a NFS-e, na seção Cancelamento.", cancel: true }
      : {
          label:
            "Nenhuma para você: cancelar exige papel de Operador, Administrador ou Proprietário, com acesso à empresa.",
          cancel: false,
        };
  }
  if (view.state === "cancelled")
    return { label: "Nenhuma: o cancelamento é definitivo.", cancel: false };
  if (view.state === "rejected")
    return {
      label:
        "Nenhuma nesta nota. Para emitir, corrija os dados e peça de novo; o novo pedido recebe outro número de DPS.",
      cancel: false,
    };
  if (view.operationState === "paused")
    return {
      label:
        "Um administrador retoma em Operação e suporte. Não peça outra emissão com os mesmos dados.",
      cancel: false,
    };
  if (view.operationState === "failed")
    return { label: "Procure o suporte antes de emitir de novo.", cancel: false };
  return {
    label:
      "Nenhuma por enquanto: aguarde a resposta do fisco. Não peça outra emissão com os mesmos dados.",
    cancel: false,
  };
}

function More({ status, loadMore }: { status: string; loadMore: (n: number) => void }) {
  return status === "CanLoadMore" || status === "LoadingMore" ? (
    <div className="ui-actions">
      <Button
        loading={status === "LoadingMore"}
        loadingLabel="Carregando…"
        onClick={() => loadMore(20)}
      >
        Carregar mais
      </Button>
    </div>
  ) : null;
}

/**
 * A query rejected by the server (access revoked, issuance of another scope) ends here. Another
 * address (`resetKey`) forgets the failure, without remounting what it wraps while nothing failed.
 */
function ScopeBoundary({
  children,
  onBack,
  resetKey,
}: {
  children: ReactNode;
  onBack: () => void;
  resetKey: string;
}) {
  return (
    <ErrorBoundary
      resetKey={resetKey}
      fallback={(error) => {
        const data: unknown = error instanceof ConvexError ? error.data : null;
        const missing =
          !!data && typeof data === "object" && "code" in data && data.code === "NOT_FOUND";
        return (
          <Callout
            tone="danger"
            role="alert"
            headingLevel={2}
            title={missing ? "Emissão indisponível" : "Não foi possível carregar as emissões"}
            actions={<Button onClick={onBack}>Voltar à lista</Button>}
          >
            <p>
              {missing
                ? "Ela não existe nesta empresa, ou seu acesso à empresa mudou."
                : "Confira sua conexão e o seu acesso à empresa."}
            </p>
          </Callout>
        );
      }}
    >
      {children}
    </ErrorBoundary>
  );
}

export function Issuances({ org, contextKey }: { org: Organization; contextKey: string }) {
  const search = useSearch({ strict: false }) as IssuanceSearch,
    navigate = useNavigate();
  // The list's "Nova emissão" depends on the company's profile, known only inside the company
  // context; it is rendered there, into the page header's action area.
  const [actions, setActions] = useState<HTMLSpanElement | null>(null);
  function change(value: IssuanceSearch, options: { resetScroll?: boolean } = {}) {
    void navigate({
      to: "/app/$organizationSlug/issuances",
      params: { organizationSlug: org.slug },
      search: value,
      ...options,
    });
  }
  // An issuance opens on its own page: the list's title, steps and picker give way to it.
  const detail = !!search.issuance;
  const choice = useCompanyChoice(org, contextKey, search.company ?? "");
  const { environment } = useDeployment();
  return (
    <Page>
      {detail ? null : (
        <>
          <PageHeader
            eyebrow={`Emissões / ${environmentNames[environment]}`}
            title="Emissão de NFS-e"
            description="Peça a emissão de notas de serviço, acompanhe a resposta do fisco e cancele quando necessário."
            actions={<span className="fiscal-header-actions" ref={setActions} />}
          />
          {/* The steps guide the choice of a company; once it is made they would only repeat
              the picker. */}
          {choice.candidate && choice.company !== null ? null : (
            <ScopeSteps company={!!choice.company} finalLabel="Emitir e acompanhar" />
          )}
        </>
      )}
      <CompanyContext
        org={org}
        contextKey={contextKey}
        selected={search.company ?? ""}
        onSelect={(company) => change({ company })}
        id="issuances-company"
        label="Empresa prestadora"
        picker={!detail}
        choice={choice}
      >
        {(company, scope) => (
          <IssuanceWork
            key={`${contextKey}:${company.id}`}
            org={org}
            scope={scope}
            search={search}
            change={change}
            actions={actions}
          />
        )}
      </CompanyContext>
    </Page>
  );
}

/** Filters of the list: persisted state and the period in which the request was made. */
export type IssuanceFilters = { state: "" | View["state"]; from: string; to: string };
const noFilters: IssuanceFilters = { state: "", from: "", to: "" };
const stateFilterLabels: Record<View["state"], string> = {
  processing: "Em processamento",
  authorized: "Autorizada",
  rejected: "Rejeitada",
  cancelled: "Cancelada",
};
/** Calendar days of Brasília (UTC−3, no daylight saving) → the server's inclusive milliseconds. */
export function filterArgs(filters: IssuanceFilters) {
  const from = filters.from ? Date.parse(`${filters.from}T00:00:00-03:00`) : undefined,
    to = filters.to ? Date.parse(`${filters.to}T23:59:59.999-03:00`) : undefined;
  const invalid =
    (from !== undefined && !Number.isFinite(from)) ||
    (to !== undefined && !Number.isFinite(to)) ||
    (from !== undefined && to !== undefined && to < from);
  return {
    invalid,
    args: {
      ...(filters.state ? { state: filters.state } : {}),
      ...(from !== undefined && Number.isFinite(from) ? { from } : {}),
      ...(to !== undefined && Number.isFinite(to) ? { to } : {}),
    },
  };
}
/** `true` while the viewport is narrow: the filters fold there, so the first issuance shows sooner. */
function useNarrow(query = "(max-width: 640px)") {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return narrow;
}

function IssuanceWork({
  org,
  scope,
  search,
  change,
  actions,
}: {
  org: Organization;
  scope: IssuanceScope;
  search: IssuanceSearch;
  change: (search: IssuanceSearch, options?: { resetScroll?: boolean }) => void;
  /** Action area of the list's page header. */
  actions: HTMLElement | null;
}) {
  const selection = useQuery(api.issuanceConsole.context, {
    organizationId: org.id,
    company: scope.companyId,
  });
  // Filters and the issuance being corrected live here, so opening a detail and coming back
  // keeps them (the route has no search parameters for them).
  const [filters, setFilters] = useState<IssuanceFilters>(noFilters);
  const [correction, setCorrection] = useState<{ issuanceId: string; label: string } | null>(null);
  const canIssue = selection?.canIssue ?? false;
  const deployment = useDeployment();
  // Owners and admins see the gate; with it off, "Nova emissão" and "Pedir emissão" say so.
  const productionClosed = selection?.productionGate?.open === false;
  const list = useListPosition(!search.issuance);
  // The profile is asked together with the selection when the role can issue (same rule as the
  // server's `canIssue`), instead of after it; any member with access to the company may read
  // it, and the screen only uses it once the server confirmed `canIssue`.
  const mayIssue = selection ? selection.canIssue : org.capabilities.operateDocuments;
  const profile = useQuery(
    api.nfseProfiles.get,
    mayIssue
      ? {
          organizationId: scope.organizationId,
          companyId: scope.companyId,
          contextKey: `issuance:${scope.companyId}`,
        }
      : "skip",
  );
  if (selection === undefined) return <SkeletonBlock label="Carregando a empresa…" lines={2} />;
  const { transport } = selection;
  // Leaving an issuance returns to the list where it was; leaving the form, to its top.
  const back = () => change({ company: scope.companyId }, { resetScroll: !search.issuance });
  const open = (issuance: string) => {
    setCorrection(null);
    list.leave();
    change({ company: scope.companyId, issuance });
  };
  const notes = (
    <>
      {transport === "simulated" && (
        <p className="fiscal-env-note" role="note">
          <Icon name="info" />
          <span>
            <strong>Ambiente simulado.</strong> Neste sandbox, um simulador responde no lugar do
            fisco. As notas não têm validade fiscal e nada é enviado à Receita ou à prefeitura.
          </span>
        </p>
      )}
      {transport === "producao-restrita" && (
        <div role="note">
          <Callout tone="warning">
            <p>
              <strong>Produção restrita.</strong> As DPS desta empresa vão ao fisco de verdade, no
              ambiente de homologação, assinadas com o certificado A1 da empresa. As notas não têm
              validade fiscal, mas números e respostas ficam registrados no fisco.
            </p>
          </Callout>
        </div>
      )}
      {transport === "producao" && deployment.fiscalProduction && (
        <ProductionNote gate={selection.productionGate} />
      )}
      {selection.company?.demonstration ? (
        <div role="note">
          <Callout tone="warning">
            <p>A empresa de demonstração não emite NFS-e. Escolha uma empresa declarada.</p>
          </Callout>
        </div>
      ) : null}
    </>
  );
  // The boundaries forget a failure when the address changes, without remounting their content.
  const resetKey = JSON.stringify(search);
  return (
    <>
      {search.issuance ? (
        <>
          <nav className="fiscal-back" aria-label="Voltar">
            <Button variant="link" icon="arrowLeft" onClick={back}>
              Voltar à lista de emissões
            </Button>
          </nav>
          <ScopeBoundary resetKey={resetKey} onBack={back}>
            <IssuanceDetail
              // Another issuance is another record: its readings and actions start over.
              key={search.issuance}
              scope={scope}
              issuanceId={search.issuance}
              onBack={back}
              companyName={selection.company?.name}
              canIssue={canIssue && !!profile}
              onCorrect={(issuanceId, label) => {
                setCorrection({ issuanceId, label });
                change({ company: scope.companyId, view: "new" });
              }}
            />
          </ScopeBoundary>
        </>
      ) : null}
      {/* The list stays mounted under an open issuance, so its loaded pages, filters and scroll
          are there when the person comes back. */}
      {list.mounted ? (
        <div hidden={!!search.issuance}>
          <div className="fiscal-stack fiscal-stack--loose">
            {notes}
            <ScopeBoundary resetKey={resetKey} onBack={back}>
              {search.view === "new" && canIssue ? (
                <IssuanceForm
                  scope={scope}
                  transport={transport}
                  correction={correction}
                  org={org}
                  productionClosed={productionClosed}
                  onCancel={() => {
                    setCorrection(null);
                    back();
                  }}
                  onCreated={open}
                />
              ) : (
                <>
                  {search.view === "new" && (
                    <Callout tone="warning" role="alert">
                      {deployment.environment === "production" && !deployment.fiscalProduction ? (
                        <p>Este deployment de produção não emite NFS-e.</p>
                      ) : (
                        <p>
                          Seu papel não permite emitir NFS-e. Emitir exige papel de Operador,
                          Administrador ou Proprietário, com acesso à empresa.
                        </p>
                      )}
                    </Callout>
                  )}
                  <IssuanceList
                    org={org}
                    scope={scope}
                    canIssue={canIssue}
                    readOnlyRole={!canIssue && !selection.company?.demonstration}
                    productionClosed={productionClosed}
                    profileMissing={canIssue && profile === null}
                    profileLoading={canIssue && profile === undefined}
                    filters={filters}
                    setFilters={setFilters}
                    open={open}
                    create={() => {
                      setCorrection(null);
                      change({ company: scope.companyId, view: "new" });
                    }}
                    actions={actions}
                  />
                </>
              )}
            </ScopeBoundary>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** On a narrow screen the filters fold, so the first issuance shows sooner; open when in use. */
function FilterFrame({
  narrow,
  filtered,
  children,
}: {
  narrow: boolean;
  filtered: boolean;
  children: ReactNode;
}) {
  if (!narrow) return <>{children}</>;
  return (
    <Disclosure
      summary={filtered ? "Filtros aplicados" : "Filtrar por situação ou período"}
      defaultOpen={filtered || undefined}
    >
      {children}
    </Disclosure>
  );
}

/** Before "Nova emissão": without an NFS-e profile there is nothing to issue with. */
function ProfileMissing({ org, companyId }: { org: Organization; companyId: string }) {
  return (
    <Callout
      tone="warning"
      headingLevel={2}
      title="Configure o perfil NFS-e antes de emitir"
      actions={
        <Link
          className="ui-link"
          to="/app/$organizationSlug/companies/$companyId"
          params={{ organizationSlug: org.slug, companyId }}
          search={{ aba: "fiscal" }}
        >
          Abrir a aba Fiscal da empresa
        </Link>
      }
    >
      <p>
        A empresa ainda não tem perfil de emissão NFS-e (município, regime, série da DPS e
        atividades).{" "}
        {org.capabilities.manageOrganization
          ? "Configure-o na aba Fiscal da empresa."
          : "Um proprietário ou administrador o configura na aba Fiscal da empresa."}
      </p>
    </Callout>
  );
}

const integrationNote = (origin: Row["origin"]) =>
  origin.kind === "integration"
    ? `Integração${origin.integration ? ` ${origin.integration}` : ""}`
    : null;
function rejectionCode(row: Row) {
  if (row.state !== "rejected") return null;
  return row.rejections[0]?.code ?? (row.code ? codeLabel(row.code) : null);
}

function IssuanceList({
  org,
  scope,
  canIssue,
  readOnlyRole,
  productionClosed,
  profileMissing,
  profileLoading,
  filters,
  setFilters,
  open,
  create,
  actions,
}: {
  org: Organization;
  scope: IssuanceScope;
  canIssue: boolean;
  /** The role, not the company, keeps the person from issuing: the list says who can. */
  readOnlyRole: boolean;
  /** Owners and admins in fiscal production with the company's gate off. */
  productionClosed: boolean;
  profileMissing: boolean;
  /** The NFS-e profile is still loading: "Nova emissão" waits instead of guessing. */
  profileLoading: boolean;
  filters: IssuanceFilters;
  setFilters: (filters: IssuanceFilters) => void;
  open: (id: string) => void;
  create: () => void;
  actions: HTMLElement | null;
}) {
  const { invalid, args } = filterArgs(filters);
  const list = usePaginatedQuery(
    api.issuanceConsole.list,
    invalid ? "skip" : { ...scope, ...args },
    {
      initialNumItems: 20,
    },
  );
  useFiscalRead(scope.organizationId, list.status !== "LoadingFirstPage" && !invalid);
  const narrow = useNarrow();
  const filtered = !!(filters.state || filters.from || filters.to);
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === "string" ? value : "";
    };
    setFilters({
      state: text("state") as IssuanceFilters["state"],
      from: text("from"),
      to: text("to"),
    });
  }
  const unavailable = profileMissing || profileLoading;
  const newIssuance = canIssue ? (
    <div className="fiscal-header-action">
      <Button
        variant="primary"
        icon="plus"
        onClick={create}
        disabled={unavailable}
        aria-describedby={
          unavailable
            ? "issuance-new-reason"
            : productionClosed
              ? "issuance-new-production"
              : undefined
        }
      >
        Nova emissão
      </Button>
      {productionClosed && !unavailable ? (
        <DisabledReason id="issuance-new-production">{productionClosedNote}</DisabledReason>
      ) : null}
      {unavailable ? (
        <DisabledReason id="issuance-new-reason">
          {profileMissing
            ? "Indisponível até a empresa ter perfil NFS-e."
            : "Conferindo o perfil NFS-e da empresa…"}
        </DisabledReason>
      ) : null}
    </div>
  ) : null;
  const columns: Array<Column<Row>> = [
    {
      key: "dps",
      header: "DPS",
      primary: true,
      cell: (row) => (
        <>
          <Button variant="link" className="fiscal-row-link" onClick={() => open(row.id)}>
            {row.nfseNumber
              ? `NFS-e ${row.nfseNumber}`
              : `DPS série ${row.series} nº ${row.number}`}
          </Button>
          <span className="fiscal-note">
            {row.nfseNumber ? `DPS série ${row.series} nº ${row.number} · ` : ""}
            {row.market === "export" ? "Exportação" : "Mercado interno"} ·{" "}
            {targetShort[row.target] ?? row.target}
          </span>
          {integrationNote(row.origin) ? (
            <span className="fiscal-note">{integrationNote(row.origin)}</span>
          ) : null}
        </>
      ),
    },
    {
      key: "taker",
      header: "Tomador",
      cell: (row) => <span className="fiscal-wrap">{row.takerName}</span>,
    },
    {
      key: "issued",
      header: "Emissão",
      cell: (row) => <span className="ui-mono fiscal-num">{formatIsoDate(row.issueDate)}</span>,
    },
    {
      key: "competence",
      header: "Competência",
      cell: (row) => <span className="ui-mono fiscal-num">{formatCompetence(row.competence)}</span>,
    },
    {
      key: "state",
      header: "Situação",
      cell: (row) => (
        <>
          <StatusLabel view={row} />
          {rejectionCode(row) ? (
            <span className="fiscal-note ui-mono">{rejectionCode(row)}</span>
          ) : null}
          <span className="fiscal-note">{transportShort[row.transport]}</span>
        </>
      ),
    },
    {
      key: "amount",
      header: "Valor",
      align: "end",
      cell: (row) => (
        <span className="fiscal-num">{formatMoney(row.amount.value, row.amount.currency)}</span>
      ),
    },
  ];
  return (
    <>
      {actions && newIssuance ? createPortal(newIssuance, actions) : null}
      {profileMissing ? <ProfileMissing org={org} companyId={scope.companyId} /> : null}
      {!readOnlyRole ? null : (
        <p className="ui-help">
          Somente leitura: proprietários, administradores e operadores pedem emissões e
          cancelamentos.
        </p>
      )}
      <Card label="Filtros de emissões">
        <FilterFrame narrow={narrow} filtered={filtered}>
          <form
            className="fiscal-filters fiscal-filters--issuances"
            onSubmit={apply}
            key={JSON.stringify(filters)}
            aria-label="Filtrar emissões"
          >
            <FormField id="issuance-filter-state" label="Situação">
              <Select id="issuance-filter-state" name="state" defaultValue={filters.state}>
                <option value="">Todas</option>
                {Object.entries(stateFilterLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField id="issuance-filter-from" label="Pedida desde">
              <Input
                id="issuance-filter-from"
                type="date"
                name="from"
                defaultValue={filters.from}
              />
            </FormField>
            <FormField id="issuance-filter-to" label="Pedida até">
              <Input id="issuance-filter-to" type="date" name="to" defaultValue={filters.to} />
            </FormField>
            <div className="fiscal-filters__actions">
              <Button type="submit">Filtrar</Button>
              {filtered ? (
                <Button variant="ghost" onClick={() => setFilters(noFilters)}>
                  Limpar filtros
                </Button>
              ) : null}
            </div>
          </form>
        </FilterFrame>
      </Card>
      {invalid ? (
        <Callout tone="danger" role="alert">
          <p>Confira o período: a data final não pode ser anterior à inicial.</p>
        </Callout>
      ) : list.status === "LoadingFirstPage" ? (
        <SkeletonBlock label="Carregando emissões…" />
      ) : !list.results.length ? (
        <Card>
          <EmptyState
            icon={filtered ? "search" : "receipt"}
            title={filtered ? "Nenhuma emissão com esses filtros" : "Nenhuma emissão desta empresa"}
            description={
              filtered
                ? "Tente outra situação ou outro período, ou limpe os filtros para ver todas as emissões."
                : "Cada pedido aparece aqui assim que o servidor o aceita, com o número da DPS reservado e a situação atualizada automaticamente."
            }
          />
        </Card>
      ) : (
        <div className="fiscal-doc-table">
          <DataTable
            label="Emissões"
            columns={columns}
            rows={list.results}
            rowKey={(row) => row.id}
          />
        </div>
      )}
      {invalid ? null : <More {...list} />}
    </>
  );
}

const nfsePending = (state: View["state"]) =>
  state === "rejected" ? "Não emitida: a DPS foi rejeitada" : "Aguardando autorização";
function Rejections({ items }: { items: View["rejections"] }) {
  return items.length ? (
    <ul className="fiscal-rejections">
      {items.map((item, index) => (
        <li key={index}>
          {item.code && <code className="ui-mono">{item.code}</code>} {item.message}
        </li>
      ))}
    </ul>
  ) : null;
}

/** A section of the issuance page: a card with its anchor, the target of the section index. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div id={id} className="fiscal-anchor">
      <Card title={title}>{children}</Card>
    </div>
  );
}
type Item = { term: string; value: ReactNode; key?: string };
const items = (rows: Array<[string, ReactNode]>): Item[] =>
  rows.map(([term, value]) => ({ term, value, key: term }));

export function IssuanceDetail({
  scope,
  issuanceId,
  companyName,
  canIssue = false,
  onCorrect,
}: {
  scope: IssuanceScope;
  issuanceId: string;
  /** Kept for the callers; the page's own "Voltar à lista" sits above the detail. */
  onBack?: () => void;
  companyName?: string;
  /** The person may ask a new issuance: a rejected one offers "Corrigir e emitir de novo". */
  canIssue?: boolean;
  onCorrect?: (issuanceId: string, label: string) => void;
}) {
  const detail = useQuery(api.issuanceConsole.detail, { ...scope, issuanceId });
  useFiscalRead(scope.organizationId, detail !== undefined);
  const { organizationSlug = "" } = useParams({ strict: false });
  if (detail === undefined) return <SkeletonBlock label="Carregando a emissão…" lines={4} />;
  const { issuance: view, snapshot } = detail;
  const status = issuanceStatus(view);
  const taker = snapshot.taker;
  const simulated = view.transport === "simulated";
  const action = issuanceAction(view, detail.canCancel);
  const correctable = view.state === "rejected" && canIssue && !!onCorrect;
  const sections: Array<[string, string]> = [
    ["issuance-identity-section", "Identificação"],
    ["issuance-service-section", "Prestador e serviço"],
    ["issuance-taker-section", "Tomador"],
    ["issuance-values-section", "Valores"],
    ...(view.cancellation || detail.canCancel
      ? [["issuance-cancellation-section", "Cancelamento"] as [string, string]]
      : []),
    ["issuance-artifacts-section", "Arquivos"],
    ["issuance-history-section", "Histórico"],
  ];
  const dpsLabel = `DPS série ${view.series} nº ${view.number}`;
  // The DANFSe is what most people came for: its download also sits beside the facts.
  const danfse = view.artifacts.find((artifact) => artifact.kind === "danfse");
  const situation: Item[] = [
    {
      // The card is already titled "Situação"; this row is the issuance state inside it.
      term: "Estado",
      value: (
        <span className="fiscal-situation" aria-live="polite">
          <StatusLabel view={view} />
          {status.note && <span className="fiscal-note">{status.note}</span>}
        </span>
      ),
    },
    ...(view.state === "rejected"
      ? [
          {
            term: "Motivo da rejeição",
            value: (
              <>
                {view.code && <span className="fiscal-note">{codeLabel(view.code)}</span>}
                <Rejections items={view.rejections} />
              </>
            ),
          },
        ]
      : []),
    {
      term: "Ação disponível",
      // The buttons sit beside the facts, above; here, what each one does.
      value: correctable ? (
        "Corrija os dados e peça de novo em Corrigir e emitir de novo, acima: o novo pedido recebe outro número de DPS, e esta emissão continua rejeitada."
      ) : action.cancel ? (
        <a className="ui-link" href="#issuance-cancellation-section">
          {action.label}
        </a>
      ) : (
        action.label
      ),
    },
    { term: "Destino", value: targetLabels[view.target] ?? view.target },
    { term: "Transporte", value: transportLabels[view.transport] },
    {
      term: "Referência da operação",
      value: (
        <span className="fiscal-key">
          <code>{view.operationId}</code>
          <CopyButton value={view.operationId} label="Copiar referência" />
          {organizationSlug ? (
            <Link
              className="ui-link"
              to="/app/$organizationSlug/operations"
              params={{ organizationSlug }}
              search={{ ref: view.operationId }}
            >
              Abrir em Operação e suporte
            </Link>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <article className="fiscal-stack fiscal-stack--loose">
      <div className="fiscal-stack">
        <PageHeader
          eyebrow={`Emissões · ${dpsLabel}${companyName ? ` · ${companyName}` : ""}`}
          title={view.nfseNumber ? `NFS-e ${view.nfseNumber}` : `DPS ${view.number}`}
          description={
            <span className="fiscal-meta">
              <span data-issuance-status>
                <StatusLabel view={view} />
              </span>
              <span>
                {view.market === "export" ? "Exportação" : "Mercado interno"} · pedida em{" "}
                {formatDateTime(view.createdAt)}
              </span>
              {detail.origin ? <OriginLabel origin={detail.origin} /> : null}
            </span>
          }
        />
        {/* What a person checks first, before any section: who, when, how much. */}
        <dl className="fiscal-facts">
          <div className="fiscal-facts__item fiscal-facts__item--wide">
            <dt>Tomador</dt>
            <dd>{taker.name}</dd>
          </div>
          <div className="fiscal-facts__item">
            <dt>Emissão</dt>
            <dd className="fiscal-num">{formatIsoDate(view.issueDate)}</dd>
          </div>
          <div className="fiscal-facts__item">
            <dt>Competência</dt>
            <dd className="fiscal-num">{formatCompetence(view.competence)}</dd>
          </div>
          <div className="fiscal-facts__item fiscal-facts__item--total">
            <dt>Valor</dt>
            <dd className="fiscal-num">{formatMoney(view.amount.value, view.amount.currency)}</dd>
          </div>
          {view.accessKey ? (
            <div className="fiscal-facts__item fiscal-facts__item--key">
              <dt>Chave de acesso</dt>
              <dd className="fiscal-key">
                <code>{groupKey(view.accessKey)}</code>
                <CopyButton value={view.accessKey} label="Copiar chave de acesso" />
              </dd>
            </div>
          ) : null}
        </dl>
        {danfse || correctable || action.cancel ? (
          <div className="fiscal-record-actions">
            {correctable ? (
              <Button variant="primary" onClick={() => onCorrect!(view.id, dpsLabel)}>
                Corrigir e emitir de novo
              </Button>
            ) : null}
            {danfse ? (
              <ArtifactDownload
                scope={scope}
                issuanceId={view.id}
                artifactId={danfse.id}
                kind={danfse.kind}
                name={`${danfse.kind}-${view.series}-${view.number}`}
                label="Baixar DANFSe"
              />
            ) : null}
            {action.cancel ? (
              <a
                className={buttonClass({ variant: "ghost" })}
                href="#issuance-cancellation-section"
              >
                Cancelar NFS-e
              </a>
            ) : null}
          </div>
        ) : null}
        {simulated && (
          <p className="fiscal-env-note" role="note">
            <Icon name="info" />
            <span>
              Emissão simulada no sandbox: chave e número sintéticos, sem validade fiscal.
            </span>
          </p>
        )}
      </div>
      <Card title="Situação">
        <DescriptionList items={situation} />
      </Card>
      <nav className="fiscal-index" aria-label="Seções da emissão">
        <ul>
          {sections.map(([id, label]) => (
            <li key={id}>
              <a className="ui-link" href={`#${id}`}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <Section id="issuance-identity-section" title="Identificação">
        <DescriptionList
          items={items([
            ["Número da NFS-e", view.nfseNumber ?? nfsePending(view.state)],
            ["DPS", `Série ${view.series}, número ${view.number}`],
            ["Identificador da DPS", <code className="ui-mono">{view.dpsId}</code>],
            ["Data da emissão", formatIsoDate(view.issueDate)],
            ["Competência", formatCompetenceLong(view.competence)],
          ])}
        />
      </Section>
      <Section id="issuance-service-section" title="Prestador e serviço">
        <DescriptionList
          items={items([
            ["Prestador", `${snapshot.issuer.name} · ${formatCnpj(snapshot.issuer.cnpj)}`],
            ["E-mail do prestador", snapshot.issuer.email],
            [
              "Atividade",
              `${snapshot.activity.label} (${snapshot.activity.code}) · tributação nacional ${snapshot.activity.cTribNac}`,
            ],
            [
              "Perfil de emissão",
              `Versão ${snapshot.profileVersion}, município ${snapshot.municipalityCode}`,
            ],
            ["Descrição", snapshot.description],
          ])}
        />
      </Section>
      <Section id="issuance-taker-section" title="Tomador">
        {taker.kind === "national" ? (
          <DescriptionList
            items={items([
              ["Nome", taker.name],
              [
                taker.documentType,
                <span className="ui-mono">
                  {taker.documentType === "CNPJ"
                    ? formatCnpj(taker.document)
                    : formatCpf(taker.document)}
                </span>,
              ],
              ["E-mail", taker.email ?? "Não informado"],
              [
                "Endereço",
                `${taker.address.street}, ${taker.address.number} · ${taker.address.district} · CEP ${formatCep(taker.address.postalCode)} · IBGE ${taker.address.municipalityCode}`,
              ],
            ])}
          />
        ) : (
          <DescriptionList
            items={items([
              ["Nome", taker.name],
              [
                "NIF",
                taker.nif ??
                  (taker.nifAbsence === 1 ? "Dispensado do NIF" : "Não exigência do NIF"),
              ],
              ["E-mail", taker.email ?? "Não informado"],
              [
                "Endereço",
                [
                  taker.address.street,
                  taker.address.number,
                  taker.address.district,
                  taker.address.city,
                  taker.address.state,
                  taker.address.postalCode,
                  taker.address.country,
                ]
                  .filter(Boolean)
                  .join(" · "),
              ],
            ])}
          />
        )}
      </Section>
      <Section id="issuance-values-section" title="Valores">
        <DescriptionList
          items={items([
            [
              "Valor do serviço",
              <span className="fiscal-num">
                {formatMoney(view.amount.value, view.amount.currency)}
              </span>,
            ],
            [
              "Valor em reais",
              view.serviceBrl ? (
                <span className="fiscal-num">{formatBRL(view.serviceBrl)}</span>
              ) : (
                "Definido pela PTAX na primeira tentativa de envio"
              ),
            ],
            [
              "ISS",
              view.market === "export"
                ? "Não incide na exportação de serviços"
                : snapshot.iss.rate
                  ? `${formatRate(snapshot.iss.rate)}%${snapshot.iss.amount ? ` · ${formatBRL(snapshot.iss.amount)}` : ""}${snapshot.iss.withheld ? " · retido pelo tomador" : ""}`
                  : "Sem alíquota na DPS (Simples Nacional sem retenção)",
            ],
            ...(view.exchange
              ? ([
                  [
                    "PTAX usada",
                    `${formatDecimal(view.exchange.rate)} BRL por ${view.exchange.currency}${view.exchange.source === "simulated" ? " (cotação simulada do sandbox)" : " (Banco Central, venda)"}`,
                  ],
                  ["Data do boletim", formatIsoDate(view.exchange.quoteDate)],
                  [
                    "Conversão",
                    `${formatMoney(view.exchange.amount, view.exchange.currency)} → ${formatBRL(view.exchange.brlAmount)}`,
                  ],
                ] as Array<[string, ReactNode]>)
              : []),
          ])}
        />
      </Section>
      <Cancellation scope={scope} detail={detail} />
      <Section id="issuance-artifacts-section" title="Arquivos">
        {view.artifacts.length ? (
          <ul className="fiscal-list">
            {view.artifacts.map((artifact) => (
              <li className="fiscal-item fiscal-artifact" key={artifact.id}>
                <div className="fiscal-artifact__text">
                  <p className="fiscal-item__title">{artifactLabels[artifact.kind]}</p>
                  <p className="fiscal-note">
                    {artifact.signed ? "Assinado" : "Sem assinatura"} ·{" "}
                    <span className="fiscal-num">{artifact.size} bytes</span> ·{" "}
                    {formatDateTime(artifact.createdAt)}
                  </p>
                  <p className="fiscal-note ui-mono" title={artifact.sha256}>
                    SHA-256 {artifact.sha256.slice(0, 16)}…
                  </p>
                </div>
                <ArtifactDownload
                  scope={scope}
                  issuanceId={view.id}
                  artifactId={artifact.id}
                  kind={artifact.kind}
                  name={`${artifact.kind}-${view.series}-${view.number}`}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="ui-help">
            Nenhum XML preservado ainda. A DPS aparece antes do primeiro envio.
          </p>
        )}
      </Section>
      <Section id="issuance-history-section" title="Histórico">
        <div className="ui-stack">
          <ol className="fiscal-timeline">
            {detail.events.map((event, index) => (
              <li key={index}>
                <span className="ui-mono fiscal-num">{formatDateTimeSeconds(event.at)}</span>
                {eventLabels[event.kind]}
                {event.code ? ` · ${codeLabel(event.code)}` : ""}
              </li>
            ))}
          </ol>
          <p className="ui-help">Horários no fuso deste navegador.</p>
        </div>
      </Section>
    </article>
  );
}

/** What the production cancellation confirms: the note, its taker, value and destination. */
function cancellationSummary(detail: Detail): Omit<ProductionSummaryItems, "reason"> {
  const { issuance, snapshot } = detail;
  const taker = snapshot.taker;
  return {
    document: `${issuance.nfseNumber ? `NFS-e nº ${issuance.nfseNumber} · ` : ""}DPS série ${issuance.series} nº ${issuance.number}`,
    taker: takerLabel(
      taker.kind === "national"
        ? { kind: "national", name: taker.name, document: taker.document }
        : { kind: "foreign", name: taker.name, nif: taker.nif, country: taker.address.country },
    ),
    value: formatMoney(issuance.amount.value, issuance.amount.currency),
    target: targetLabels[issuance.target] ?? issuance.target,
  };
}

function Cancellation({ scope, detail }: { scope: IssuanceScope; detail: Detail }) {
  const cancellation = detail.issuance.cancellation;
  const [open, setOpen] = useState(false);
  if (!cancellation && !detail.canCancel) return null;
  return (
    <Section id="issuance-cancellation-section" title="Cancelamento">
      <div className="fiscal-stack">
        {cancellation && (
          <>
            <DescriptionList
              items={items([
                [
                  "Situação",
                  cancellation.state === "processing"
                    ? "Em andamento, aguardando o registro do evento"
                    : cancellation.state === "registered"
                      ? cancellation.alreadyRegistered
                        ? "Registrado (o fisco já tinha o evento)"
                        : "Registrado"
                      : "Rejeitado",
                ],
                [
                  "Pedido",
                  `nº ${cancellation.sequence} · ${formatDateTime(cancellation.createdAt)}`,
                ],
                ["Motivo", `${cancelReasons[cancellation.reasonCode]}: ${cancellation.reason}`],
              ])}
            />
            {cancellation.state === "rejected" && (
              <Callout tone="danger" title="Cancelamento rejeitado">
                {cancellation.code && <p>{codeLabel(cancellation.code)}</p>}
                <Rejections items={cancellation.rejections} />
              </Callout>
            )}
          </>
        )}
        {detail.canCancel &&
          (open ? (
            <CancelForm
              scope={scope}
              issuanceId={detail.issuance.id}
              simulated={detail.issuance.transport === "simulated"}
              production={
                detail.issuance.transport === "producao" ? cancellationSummary(detail) : null
              }
              onClose={() => setOpen(false)}
            />
          ) : (
            <div className="ui-actions">
              <Button onClick={() => setOpen(true)}>
                {cancellation?.state === "rejected" ? "Pedir novo cancelamento" : "Cancelar NFS-e"}
              </Button>
            </div>
          ))}
      </div>
    </Section>
  );
}

const cancelMessages: Record<string, string> = {
  CANCEL_REASON_INVALID: "Descreva o motivo com 15 a 255 caracteres.",
  ISSUANCE_NOT_CANCELLABLE: "Só uma NFS-e autorizada pode ser cancelada.",
  ISSUANCE_TRANSPORT_CHANGED:
    "O transporte deste ambiente mudou desde a autorização. O cancelamento precisa sair pelo mesmo canal.",
  SCOPE_DENIED:
    "Seu papel não permite cancelar. Peça a um proprietário, administrador ou operador.",
  NOT_FOUND: "Emissão indisponível ou acesso revogado.",
  IDEMPOTENCY_CONFLICT: "Esta tentativa já foi usada para outro pedido. Revise e envie novamente.",
  CERTIFICATE_UNAVAILABLE: "A empresa não tem certificado A1 ativo e válido para este envio.",
  RATE_LIMITED: "Muitas tentativas. Aguarde um minuto e tente novamente.",
};
export function cancelError(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code = data && typeof data === "object" && "code" in data ? String(data.code) : "";
  return code
    ? (cancelMessages[code] ?? `O servidor recusou o cancelamento (${code}).`)
    : "Não foi possível confirmar o pedido. Envie de novo: a mesma tentativa não cancela duas vezes.";
}

function CancelForm({
  scope,
  issuanceId,
  simulated,
  production,
  onClose,
}: {
  scope: IssuanceScope;
  issuanceId: Id<"issuances">;
  simulated: boolean;
  /** Summary confirmed before a production cancellation; `null` elsewhere, with no extra step. */
  production: Omit<ProductionSummaryItems, "reason"> | null;
  onClose: () => void;
}) {
  const cancel = useMutation(api.issuanceConsole.cancel);
  const [reasonCode, setReasonCode] = useState<"1" | "2" | "9">("1");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const length = reason.trim().replace(/\s+/g, " ").length;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (length < 15 || length > 255) {
      setError("Descreva o motivo com 15 a 255 caracteres.");
      return;
    }
    if (production) {
      setError("");
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError("");
    const failure = await send();
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  }
  /** Sends the cancellation; resolves with the refusal message, or empty when accepted. */
  async function send() {
    const payload = JSON.stringify({ issuanceId, reasonCode, reason: reason.trim() });
    if (attempt.current?.payload !== payload)
      attempt.current = { key: `console-cancel-${crypto.randomUUID()}`, payload };
    try {
      await cancel({
        ...scope,
        issuanceId,
        reasonCode,
        reason: reason.trim(),
        idempotencyKey: attempt.current.key,
      });
      return "";
    } catch (failure) {
      return cancelError(failure);
    }
  }
  return (
    <form onSubmit={submit} aria-busy={busy} className="ui-form fiscal-cancel-form" noValidate>
      <fieldset className="fiscal-fieldset" disabled={busy}>
        <legend className="fiscal-legend">Pedir cancelamento</legend>
        <FormField id="cancel-reason-code" label="Motivo">
          <Select
            id="cancel-reason-code"
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value as "1" | "2" | "9")}
          >
            {Object.entries(cancelReasons).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          id="cancel-reason"
          label="Justificativa"
          help={
            <>
              <span className="fiscal-num">{length}/255</span> caracteres, mínimo 15. O cancelamento
              é um evento fiscal e não pode ser desfeito.
              {simulated && (
                <SimulatorTip>
                  <code>[simular:rejeicao]</code> na justificativa ensaia uma recusa.
                </SimulatorTip>
              )}
            </>
          }
        >
          <Textarea
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={255}
            rows={3}
            aria-describedby="cancel-reason-help"
          />
        </FormField>
      </fieldset>
      {error && (
        <Callout tone="danger" role="alert">
          <p>{error}</p>
        </Callout>
      )}
      <div className="ui-actions">
        <Button
          type="submit"
          variant="danger"
          loading={busy}
          loadingLabel="Enviando…"
          disabled={busy}
        >
          {production ? "Revisar cancelamento" : "Confirmar cancelamento"}
        </Button>
        <Button disabled={busy} onClick={onClose}>
          Voltar
        </Button>
      </div>
      {production && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Cancelar esta NFS-e em produção?"
          description="O evento de cancelamento vai ao fisco e não pode ser desfeito. A nota perde a validade fiscal quando o fisco registrar o evento."
          confirmLabel="Confirmar cancelamento"
          busyLabel="Enviando…"
          cancelLabel="Revisar"
          settleMs={350}
          onConfirm={async () => {
            const failure = await send();
            if (!failure) onClose();
            return failure;
          }}
        >
          <ProductionSummary
            {...production}
            reason={`${cancelReasons[reasonCode]}: ${reason.trim().replace(/\s+/g, " ")}`}
          />
        </ConfirmDialog>
      )}
    </form>
  );
}

function ArtifactDownload({
  scope,
  issuanceId,
  artifactId,
  kind,
  name,
  label,
}: {
  scope: IssuanceScope;
  issuanceId: Id<"issuances">;
  artifactId: Id<"issuanceArtifacts">;
  kind: View["artifacts"][number]["kind"];
  name: string;
  /** The button's words when not "Baixar PDF"/"Baixar XML", as beside the facts. */
  label?: string;
}) {
  // O DANFSe é o único artefato em PDF; os demais são XML.
  const format = kind === "danfse" ? "PDF" : "XML";
  const ticket = useMutation(api.issuanceConsole.artifactTicket);
  const download = useTicketDownload();
  const start = () =>
    void download.start(() => ticket({ ...scope, issuanceId, artifactId }), {
      name: `${name}.${format.toLowerCase()}`,
      label: format,
    });
  return (
    <div className="fiscal-download">
      <Button icon="download" disabled={download.busy} onClick={start}>
        {download.state.phase === "preparing"
          ? "Preparando…"
          : download.state.phase === "downloading"
            ? "Baixando…"
            : (label ?? `Baixar ${format}`)}
      </Button>
      <DownloadFeedback state={download.state} onRetry={start} />
    </div>
  );
}
