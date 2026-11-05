import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { usePaginatedQuery, useQuery } from "./convex-query";
import { environmentNames, type ProductEnvironment } from "./deployment";
import { useProductEnvironment } from "./product-environment";
import { Link, useParams } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { Organization } from "./organizations";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
import { Disclosure } from "./ui/disclosure";
import {
  Callout,
  Card,
  DescriptionList,
  EmptyState,
  Page,
  PageHeader,
  SkeletonBlock,
  StatusBadge,
  type Tone,
} from "./ui/layout";

const date = (value: number) => new Date(value).toLocaleString("pt-BR");
const states = {
  queued: "Na fila",
  running: "Processando",
  succeeded: "Pronta para baixar",
  failed: "Falhou",
  revoked: "Revogada",
  expired: "Expirada",
};
const stateTones: Record<keyof typeof states, Tone> = {
  queued: "neutral",
  running: "info",
  succeeded: "success",
  failed: "danger",
  revoked: "neutral",
  expired: "warning",
};
type ListedJob = FunctionReturnType<typeof api.exports.list>["page"][number];
export function ExportDocument({
  scope,
  documentId,
}: {
  /** The company's document; the export belongs to the organization's console project. */
  scope: {
    organizationId: Id<"organizations">;
    companyId: Id<"companies">;
    environment: ProductEnvironment;
  };
  documentId: string;
}) {
  const create = useMutation(api.exports.create);
  const { organizationSlug = "" } = useParams({ strict: false });
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [confirming, setConfirming] = useState(false),
    [requested, setRequested] = useState<Id<"documentExports"> | null>(null);
  async function request() {
    try {
      const job = await create({
        organizationId: scope.organizationId,
        environment: scope.environment,
        key,
        selection: {
          kind: "document",
          documentId: documentId as Id<"fiscalDocuments">,
          companyId: scope.companyId,
        },
      });
      setRequested(job.id);
      setKey(crypto.randomUUID());
      return "";
    } catch {
      // The key is kept: a retry after a lost answer returns the request already accepted.
      return "Não foi possível solicitar a exportação. Confira o acesso ou aguarde um minuto e tente de novo.";
    }
  }
  return (
    <div className="fiscal-action">
      <Button icon="download" onClick={() => setConfirming(true)}>
        {requested ? "Solicitar nova exportação" : "Exportar documento e histórico"}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="primary"
        title="Exportar este documento e o histórico?"
        description={
          <>
            O pacote reúne este documento, suas versões, itens, eventos e o XML original, em
            arquivos <code className="ui-mono">.jsonl.gz</code>. O preparo roda em segundo plano; o
            pacote aparece em Exportações e fica disponível por 24 horas.
          </>
        }
        confirmLabel="Confirmar exportação"
        busyLabel="Enviando…"
        onConfirm={request}
      />
      {requested ? (
        <DocumentExportFeedback
          exportId={requested}
          organizationId={scope.organizationId}
          organizationSlug={organizationSlug}
        />
      ) : null}
    </div>
  );
}
/** What happened to the request just made, from the live list: queued, ready or failed. */
function DocumentExportFeedback({
  exportId,
  organizationId,
  organizationSlug,
}: {
  exportId: Id<"documentExports">;
  organizationId: Id<"organizations">;
  organizationSlug: string;
}) {
  const { results } = usePaginatedQuery(
    api.exports.list,
    { organizationId },
    { initialNumItems: 10 },
  );
  const job = results.find((row) => row.id === exportId);
  const state = job ? stateOf(job, Date.now()) : "queued";
  const link = (
    <Link className="ui-link" to="/app/$organizationSlug/exports" params={{ organizationSlug }}>
      {state === "succeeded" ? "Baixar em Exportações" : "Acompanhar em Exportações"}
    </Link>
  );
  if (state === "failed" || state === "revoked" || state === "expired")
    return (
      <Callout tone="danger" role="alert">
        <p>
          A exportação {state === "failed" ? "falhou" : states[state].toLowerCase()}. Nenhuma parte
          incompleta ficou disponível; solicite outra. {link}
        </p>
      </Callout>
    );
  return (
    <p role="status" className="ui-help">
      {state === "succeeded"
        ? "Exportação pronta para baixar. "
        : `Exportação solicitada: ${states[state].toLowerCase()}. `}
      {link}
    </p>
  );
}
/** Estado legível: `running` sem parte publicada ainda aguarda o preparo na fila. */
function stateOf(job: ListedJob, clock: number) {
  const state = job.expiresAt <= clock ? "expired" : job.state;
  return state === "running" && job.parts === 0 ? "queued" : state;
}
const partCount = (n: number) => `${n} ${n === 1 ? "parte" : "partes"}`;
/** O que foi exportado, em termos do usuário; o id interno fica na referência de suporte. */
export function describeExport(job: ListedJob, organizationName: string) {
  if (job.selection.kind === "organization")
    return {
      title: "Todos os documentos da organização",
      detail: `${organizationName}: documentos publicados até ${date(job.createdAt)}.`,
    };
  const d = job.description;
  return d
    ? {
        title: `${d.model === "55" ? "NF-e" : "NFS-e"} e histórico`,
        detail: `${d.companyName}, chave ${d.fiscalKey}.`,
      }
    : { title: "Documento e histórico", detail: "Um documento fiscal com versões e originais." };
}
export function Exports({ org }: { org: Organization }) {
  const create = useMutation(api.exports.create);
  const manager = org.capabilities.manageOrganization;
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [confirming, setConfirming] = useState(false);
  const [requestedId, setRequestedId] = useState<Id<"documentExports"> | null>(null),
    [openId, setOpenId] = useState<Id<"documentExports"> | null>(null);
  const { results, status, loadMore } = usePaginatedQuery(
    api.exports.list,
    { organizationId: org.id },
    { initialNumItems: 10 },
  );
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const deadlines = results.map((job) => job.expiresAt).filter((at) => at > clock);
    if (!deadlines.length) return;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.max(0, Math.min(...deadlines) - Date.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [results, clock]);
  const requested = requestedId ? results.find((job) => job.id === requestedId) : undefined;
  // Produção appears for a manager once a company released the fiscal capture (ADR 0007).
  const environments = useQuery(
    api.exports.environments,
    manager ? { organizationId: org.id } : "skip",
  );
  // The package is of the environment chosen in the shell (ADR 0007, §1). The list keeps every
  // request of the person, each with its environment.
  // Sent as chosen: the server refuses an environment the organization does not serve.
  const environment = useProductEnvironment().environment;
  async function exportOrganization() {
    try {
      const job = await create({
        organizationId: org.id,
        key,
        selection: { kind: "organization" },
        environment,
      });
      setRequestedId(job.id);
      setKey(crypto.randomUUID());
      return "";
    } catch {
      // A chave é preservada: a retentativa devolve o mesmo pedido se o servidor já o aceitou.
      return "Não foi possível solicitar. Confira o acesso ou aguarde um minuto e tente novamente.";
    }
  }
  return (
    <Page>
      <PageHeader
        eyebrow="Seus documentos"
        title="Exportações"
        description="Originais, dados e histórico em partes verificáveis. Disponíveis por 24 horas após a solicitação."
        actions={
          manager ? (
            <Button variant="primary" icon="download" onClick={() => setConfirming(true)}>
              Exportar organização
            </Button>
          ) : null
        }
      />
      {manager ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          tone="primary"
          title="Exportar todos os documentos da organização?"
          description={`O pacote reúne os documentos fiscais de ${org.name} publicados até agora, com versões, itens, eventos e XML originais. O preparo roda em segundo plano e os arquivos ficam disponíveis por 24 horas. Certificados, senhas e chaves ficam fora.`}
          confirmLabel="Confirmar exportação"
          busyLabel="Enviando…"
          onConfirm={exportOrganization}
        >
          {environments && environments.length > 1 ? (
            <p className="ui-help">
              Ambiente: {environmentNames[environment]}.{" "}
              {environment === "production"
                ? "Documentos reais das empresas com captura fiscal, inclusive as já desativadas."
                : "Documentos importados no Sandbox e NFS-e do simulador."}
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}
      <div className="fiscal-stack">
        <p className="ui-help">
          O pacote contém os documentos fiscais da organização. Certificados, senhas e chaves ficam
          fora da exportação. Para exportar uma nota, abra o detalhe em Documentos.
        </p>
        <Disclosure summary="Como abrir os arquivos .jsonl.gz">
          <p>
            Cada parte é um arquivo de texto JSON Lines (um registro JSON por linha) comprimido com
            gzip. Descompacte com qualquer ferramenta gzip e leia linha a linha; o campo{" "}
            <code className="ui-mono">type</code> indica o registro (documento, versão, item,
            original). Os XML originais vêm em base64, com SHA-256 para conferência. Baixe todas as
            partes: uma parte isolada não representa o pacote inteiro.
          </p>
        </Disclosure>
        {requestedId ? (
          <RequestFeedback job={requested} clock={clock} onOpen={() => setOpenId(requestedId)} />
        ) : null}
      </div>
      {status === "LoadingFirstPage" ? (
        <SkeletonBlock label="Carregando exportações…" lines={4} />
      ) : results.length === 0 ? (
        <EmptyState
          icon="download"
          title={manager ? "Nenhuma exportação ainda" : "Você ainda não tem exportações"}
          description={
            manager
              ? "Use “Exportar organização” para gerar um pacote com todos os documentos, ou exporte uma nota pelo detalhe em Documentos."
              : "Exportar a organização inteira é restrito a proprietários e administradores. Você pode exportar uma nota que consegue consultar: abra o detalhe em Documentos e use “Exportar documento e histórico”. Suas exportações aparecem aqui."
          }
        />
      ) : (
        <div className="fiscal-stack">
          {!manager ? (
            <p className="ui-help">
              Exportar a organização inteira é restrito a proprietários e administradores. Esta
              lista mostra apenas as exportações que você solicitou.
            </p>
          ) : null}
          <ul className="fiscal-list" aria-label="Exportações solicitadas">
            {results.map((job) => (
              <ExportRow
                key={job.id}
                job={job}
                org={org}
                clock={clock}
                opened={openId === job.id}
                onToggle={() => setOpenId(openId === job.id ? null : job.id)}
              />
            ))}
          </ul>
          {status === "CanLoadMore" || status === "LoadingMore" ? (
            <div>
              <Button loading={status === "LoadingMore"} onClick={() => loadMore(10)}>
                Carregar mais
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Page>
  );
}
/** Retorno do pedido recém-feito, acompanhando o estado vivo da assinatura. */
function RequestFeedback({
  job,
  clock,
  onOpen,
}: {
  job: ListedJob | undefined;
  clock: number;
  onOpen: () => void;
}) {
  const state = job ? stateOf(job, clock) : "queued";
  if (state === "failed")
    return (
      <Callout tone="danger" role="alert">
        <p>
          A exportação solicitada falhou. Nenhuma parte incompleta ficou disponível; solicite outra.
        </p>
      </Callout>
    );
  return (
    <Callout
      tone={
        state === "succeeded"
          ? "success"
          : state === "queued" || state === "running"
            ? "info"
            : "warning"
      }
      role="status"
      actions={
        state === "succeeded" ? (
          <Button size="sm" onClick={onOpen}>
            Ver arquivos para download
          </Button>
        ) : undefined
      }
    >
      <p>
        {state === "queued"
          ? "Exportação solicitada e na fila. O preparo começa em instantes; você pode sair desta tela."
          : state === "running"
            ? `Processando: ${partCount(job!.parts)} pronta(s) até agora.`
            : state === "succeeded"
              ? `Exportação pronta: ${partCount(job!.parts)} para baixar.`
              : state === "revoked"
                ? "Exportação revogada. Os arquivos não podem mais ser baixados."
                : "O prazo de download desta exportação terminou."}
      </p>
    </Callout>
  );
}
function ExportRow({
  job,
  org,
  clock,
  opened,
  onToggle,
}: {
  job: ListedJob;
  org: Organization;
  clock: number;
  opened: boolean;
  onToggle: () => void;
}) {
  const revoke = useMutation(api.exports.revoke);
  const [confirming, setConfirming] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const state = stateOf(job, clock);
  const available = state === "succeeded";
  const { title, detail } = describeExport(job, org.name);
  return (
    // The row takes the focus back when the revoked export loses its buttons.
    <li ref={row} tabIndex={-1} className="fiscal-export">
      <Card
        title={title}
        actions={
          <span role="status">
            <StatusBadge tone={stateTones[state]}>{states[state]}</StatusBadge>
          </span>
        }
      >
        <div className="fiscal-stack">
          <p>{detail}</p>
          <DescriptionList
            className="fiscal-figures"
            items={[
              { key: "environment", term: "Ambiente", value: environmentNames[job.environment] },
              { key: "created", term: "Solicitada em", value: date(job.createdAt) },
              { key: "expires", term: "Disponível até", value: date(job.expiresAt) },
              {
                key: "parts",
                term: "Partes preparadas",
                value: <span className="fiscal-num">{job.parts}</span>,
              },
              {
                key: "bytes",
                term: "Tamanho",
                value: (
                  <span className="fiscal-num">
                    {new Intl.NumberFormat("pt-BR").format(job.bytes)} bytes
                  </span>
                ),
              },
            ]}
          />
          <Disclosure summary="Referência para suporte">
            <p className="ui-help">
              Exportação <code className="ui-mono">{job.id}</code>
              {job.selection.kind === "document" ? (
                <>
                  {" "}
                  · Documento <code className="ui-mono">{job.selection.documentId}</code>
                </>
              ) : null}
              {job.code ? (
                <>
                  {" "}
                  · Código <code className="ui-mono">{job.code}</code>
                </>
              ) : null}
            </p>
          </Disclosure>
          {state === "failed" ? (
            <Callout tone="danger" role="alert">
              <p>
                A exportação não foi concluída. Nenhuma parte incompleta está disponível. Solicite
                outra exportação após conferir o acesso e os originais.
              </p>
            </Callout>
          ) : null}
          {available || state === "queued" || state === "running" ? (
            <div className="ui-actions">
              {available ? (
                <Button icon="download" onClick={onToggle} aria-expanded={opened}>
                  {opened ? "Ocultar arquivos" : "Ver arquivos para download"}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => setConfirming(true)}>
                Revogar exportação
              </Button>
            </div>
          ) : null}
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title="Revogar esta exportação?"
            description={`${
              available
                ? "Os arquivos deixam de poder ser baixados imediatamente, inclusive downloads em andamento."
                : "O preparo é interrompido e nenhum arquivo será publicado."
            } Não é possível desfazer; para obter os dados de novo, solicite outra exportação.`}
            confirmLabel="Confirmar revogação"
            busyLabel="Revogando…"
            returnFocusTo={() => row.current}
            onConfirm={async () => {
              try {
                await revoke({ exportId: job.id });
                return "";
              } catch {
                return "Não foi possível revogar. Confira seu acesso e tente novamente.";
              }
            }}
          />
          {opened && available ? <Parts exportId={job.id} /> : null}
        </div>
      </Card>
    </li>
  );
}
function Parts({ exportId }: { exportId: Id<"documentExports"> }) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.exports.parts,
    { exportId },
    { initialNumItems: 20 },
  );
  const ticket = useMutation(api.exportDownloads.ticket);
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("");
  const active = useRef(true),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  async function download(part: (typeof results)[number]) {
    setBusy(part.id);
    setError("");
    controller.current = new AbortController();
    try {
      const grant = await ticket({ partId: part.id });
      if (!active.current) return;
      const response = await fetch(`${import.meta.env.VITE_API_URL}/v1/export-download`, {
        headers: { "X-Download-Token": grant.token },
        signal: controller.current.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      if (hash !== part.sha256 || bytes.byteLength !== part.size) throw new Error();
      if (!active.current) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/gzip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `export-${exportId}-${part.sequence}.jsonl.gz`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (active.current)
        setError(
          "Download indisponível. O prazo ou seu acesso pode ter mudado. Tente novamente para obter um novo ticket.",
        );
    } finally {
      if (active.current) setBusy(null);
    }
  }
  return (
    <Card flat title="Arquivos para download" headingLevel={3}>
      <div className="fiscal-stack">
        <p className="ui-help">
          Baixe todas as partes. Cada arquivo <code className="ui-mono">.jsonl.gz</code> é JSON
          Lines comprimido com gzip; os originais estão em base64. O download confere o SHA-256
          antes de salvar.
        </p>
        {status === "LoadingFirstPage" ? (
          <SkeletonBlock label="Carregando arquivos…" lines={2} />
        ) : null}
        {error ? (
          <Callout tone="danger" role="alert">
            <p>{error}</p>
          </Callout>
        ) : null}
        <ul className="fiscal-list">
          {results.map((part) => (
            <li key={part.id} className="fiscal-key">
              <Button
                size="sm"
                icon="download"
                loading={busy === part.id}
                loadingLabel="Conferindo…"
                disabled={busy !== null}
                onClick={() => void download(part)}
              >
                {`Baixar parte ${part.sequence + 1}`}
              </Button>
              <code title="SHA-256">{part.sha256}</code>
            </li>
          ))}
        </ul>
        {status === "CanLoadMore" || status === "LoadingMore" ? (
          <div>
            <Button size="sm" loading={status === "LoadingMore"} onClick={() => loadMore(20)}>
              Mais arquivos
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
