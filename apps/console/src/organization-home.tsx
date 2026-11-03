import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "./convex-query";
import type { FunctionReturnType } from "convex/server";
import { membershipRoleLabels } from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import { formatDate, formatDateTime } from "./format";
import { UNEXPLAINED_STOP, integrationTodo, stopMessage } from "./capture-messages";
import {
  chosenTask,
  parseTask,
  rememberedTask,
  rememberTask,
  roleTasks,
  stepAction,
  summaryTask,
  taskCompany,
  taskDestinations,
  taskLabels,
  type ConsoleTask,
  type Destination,
  type TaskDestination,
} from "./console-task";
import type { Organization } from "./organizations";
import { HomeRecent } from "./home-recent";
import { Button, buttonClass } from "./ui/button";
import { RadioCard } from "./ui/choice";
import { Icon } from "./ui/icons";
import { Disclosure } from "./ui/disclosure";
import { Card, Page, PageHeader, SkeletonBlock, StatusBadge } from "./ui/layout";

type Summary = FunctionReturnType<typeof api.consoleHome.summary>;
type Pending = Summary["pending"][number];

/**
 * The month and the clock come from the browser: the query does not read the time. The hour is
 * rounded so the subscription stays the same while the page is open.
 */
function clock() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return {
    monthStart,
    asOf: Math.max(monthStart, Math.floor(now.getTime() / 3_600_000) * 3_600_000),
  };
}
const monthName = (ms: number) =>
  new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(ms);

const pendingText: Record<
  Pending["kind"],
  (item: Pending) => { title: string; note: string; action: string }
> = {
  "issuance-rejected": (item) => ({
    title: "Emissão rejeitada",
    note: `${item.companyName} · ${formatDateTime(item.at)}. Confira o motivo antes de emitir de novo.`,
    action: "Ver rejeição",
  }),
  "issuance-reconciling": (item) => ({
    title: "Emissão em reconciliação",
    note: `${item.companyName} · a resposta do fisco não chegou. A plataforma consulta antes de reenviar; não emita de novo.`,
    action: "Acompanhar",
  }),
  "issuance-paused": (item) => ({
    title: "Emissão pausada",
    note: `${item.companyName} · as tentativas foram suspensas. Um administrador retoma em Operação e suporte.`,
    action: "Ver emissão",
  }),
  "certificate-expiring": (item) => ({
    title: "Certificado vencendo",
    note: `${item.companyName} · o certificado A1 vence em ${formatDate(item.at)}. Envie o novo antes dessa data.`,
    action: "Abrir empresa",
  }),
  "certificate-expired": (item) => ({
    title: "Certificado vencido",
    note: `${item.companyName} · venceu em ${formatDate(item.at)}. Sem certificado válido, a empresa não emite.`,
    action: "Abrir empresa",
  }),
  "import-failed": (item) => ({
    title: "Importação com falha",
    note: `${item.companyName} · ${formatDateTime(item.at)}. Há XML recusado ou processamento com falha ou pausado; confira o resultado por arquivo.`,
    action: "Ver importação",
  }),
  "capture-attention": (item) => {
    const known = stopMessage(item, true);
    // On an integration's capture the resume is the integration's (#607); the rest of what to
    // do, with the technical details, is in the capture.
    const todo = item.origin
      ? integrationTodo(known ?? UNEXPLAINED_STOP, item.origin, "Confira o que fazer na captura.")
      : null;
    return {
      title: "Captura fiscal (Produção) em atenção",
      // The reason, as the capture panel says it (#432); what to do is there, one click away.
      note: `${item.companyName} · ${known?.reason ?? "a captura parou e não consulta a Receita até alguém agir."} ${todo ?? "Confira o que fazer na captura."}`,
      action: "Abrir captura",
    };
  },
  "capture-quiet": (item) => ({
    title: "Captura fiscal (Produção) sem consulta",
    note: `${item.companyName} · sem consulta respondida desde ${formatDate(item.at)}. A Receita pode suspender a distribuição de NF-e do CNPJ depois de 60 dias sem consulta.`,
    action: "Abrir captura",
  }),
};

const actionClass = buttonClass({ size: "sm" });
function PendingLink({ org, item }: { org: Organization; item: Pending }) {
  const params = { organizationSlug: org.slug };
  const text = pendingText[item.kind](item);
  if (item.kind.startsWith("issuance"))
    return (
      <Link
        className={actionClass}
        to="/app/$organizationSlug/issuances"
        params={params}
        search={{ company: item.companyId, issuance: item.recordId ?? undefined }}
      >
        {text.action} <span aria-hidden="true">→</span>
      </Link>
    );
  if (item.kind === "import-failed")
    return (
      <Link
        className={actionClass}
        to="/app/$organizationSlug/imports"
        params={params}
        search={{ company: item.companyId, batch: item.recordId ?? undefined }}
      >
        {text.action} <span aria-hidden="true">→</span>
      </Link>
    );
  return (
    <Link
      className={actionClass}
      to="/app/$organizationSlug/companies/$companyId"
      params={{ ...params, companyId: item.companyId }}
      search={{ aba: item.kind.startsWith("capture") ? "captura" : "certificado" }}
    >
      {text.action} <span aria-hidden="true">→</span>
    </Link>
  );
}

type Tasks = Summary["tasks"];
type Task = NonNullable<Tasks[keyof Tasks]>;
type Step = Task["steps"][number];
type StepCopy = { title: string; done: string; todo: string; role?: string };
type LinkTo = Destination & { label: string };

const managers = "Proprietário ou Administrador";
const writers = "Operador, Administrador ou Proprietário";
const integrators = "Proprietário, Administrador ou Desenvolvedor cria a integração.";
/** What each step is, in the words of its task. */
function stepCopy(task: ConsoleTask, key: Step["key"]): StepCopy {
  const issue = task === "emitir";
  switch (key) {
    case "company":
      return task === "importar"
        ? {
            title: "Escolher a empresa",
            done: "Empresa disponível para você.",
            todo: "Comece pela empresa de demonstração, com dados sintéticos e sem certificado, ou cadastre a sua.",
          }
        : {
            title: "Cadastrar a empresa com CNPJ próprio",
            done: "Empresa declarada disponível para você.",
            todo: issue
              ? "A emissão usa uma empresa declarada; a demonstração não emite."
              : "A captura consulta a Receita pelo CNPJ de uma empresa declarada; a demonstração não captura.",
          };
    case "permission":
      return {
        title: issue ? "Permissão para emitir" : "Permissão para importar",
        done: "",
        todo: "",
        role: `${issue ? "Emitir" : "Importar XML"} exige papel de ${writers}.`,
      };
    case "document":
      return {
        title: "Importar o primeiro XML",
        done: "A empresa já tem um documento importado.",
        todo: "Envie um XML de NF-e modelo 55.",
        role: `${writers} importa o primeiro XML.`,
      };
    case "certificate":
      return {
        title: "Enviar o certificado A1",
        done: "Certificado A1 ativo e dentro da validade.",
        todo: issue
          ? "O transporte desta empresa assina a emissão com o certificado A1 dela."
          : "A captura consulta a Receita com o certificado A1 da empresa.",
        role: `${managers} envia o certificado.`,
      };
    case "profile":
      return {
        title: "Configurar o perfil NFS-e",
        done: "Perfil de emissão salvo.",
        todo: "Município, regime e atividades que a emissão usa.",
        role: `${managers} configura o perfil.`,
      };
    case "authorize":
      return {
        title: "Autorizar a captura",
        done: "Captura autorizada para a empresa.",
        todo: "Quem administra aceita os termos e libera a consulta à Receita para o CNPJ.",
        role: `${managers} autoriza a captura.`,
      };
    case "start":
      return {
        title: "Iniciar a captura",
        done: "A captura consulta a Receita.",
        todo: "Autorizada, a captura só consulta a Receita depois de iniciada.",
        role: `${writers} inicia a captura.`,
      };
    case "project":
      return {
        title: "Criar o projeto de integração",
        done: "Projeto de integração ativo.",
        todo: "O projeto representa o seu sistema; as chaves de API pertencem a ele.",
        role: integrators,
      };
    case "key":
      return {
        title: "Criar uma chave de API",
        done: "A integração tem uma chave válida.",
        todo: "Seu sistema chama a API com uma chave do projeto.",
        role: integrators,
      };
  }
}

/** After a complete task, what the member does next with it. */
function nextLink(org: Organization, task: ConsoleTask, summary: Summary): LinkTo | null {
  const params = { organizationSlug: org.slug };
  const company = taskCompany(summary, task) ?? undefined;
  if (task === "importar")
    return {
      to: "/app/$organizationSlug/documents",
      params,
      search: { company },
      label: "Ver os documentos",
    };
  if (task === "emitir")
    return {
      to: "/app/$organizationSlug/issuances",
      params,
      search: { company },
      label: "Ver as emissões",
    };
  if (task === "capturar")
    return company
      ? {
          to: "/app/$organizationSlug/companies/$companyId",
          params: { ...params, companyId: company },
          search: { aba: "captura" },
          label: "Acompanhar a captura",
        }
      : null;
  return taskDestinations(org, summary).integrar;
}

function DestinationLink({ to: { label, ...link }, className }: { to: LinkTo; className: string }) {
  return (
    <Link className={className} {...link}>
      {label} <span aria-hidden="true">→</span>
    </Link>
  );
}

function TaskAction({ to: { label, icon, ...link } }: { to: TaskDestination }) {
  return (
    <Link className={buttonClass({ variant: "primary" })} {...link}>
      <Icon name={icon} />
      {label}
    </Link>
  );
}

const unavailableNote: Partial<Record<ConsoleTask, string>> = {
  emitir: "A emissão simulada existe só no sandbox. Este ambiente não a oferece.",
  capturar: "A captura de NF-e não está disponível neste ambiente.",
};
/** How far a task is, for its option in the chooser and its heading. */
function taskStatus(task: Task) {
  if (task.steps.every((step) => step.state === "unavailable"))
    return "Indisponível neste ambiente";
  if (task.complete) return "Concluída";
  const open = task.steps.filter((step) => step.state !== "done");
  // Nothing of it is this member's to do: the count would be a to-do list for someone else.
  if (open.every((step) => step.state === "blocked" && step.reason === "role"))
    return "Depende de outro papel";
  const remaining = open.filter((step) => step.key !== "permission").length;
  return remaining === 1 ? "Falta 1 etapa" : `Faltam ${remaining} etapas`;
}

function stepNote(task: ConsoleTask, step: Step, org: Organization, demo: string | null) {
  const copy = stepCopy(task, step.key);
  if (step.state === "done") return copy.done;
  if (step.state === "todo")
    return step.key === "document" && step.companyId && step.companyId === demo
      ? "A empresa de demonstração tem um XML sintético: importe-o direto, sem baixar o arquivo."
      : copy.todo;
  if (step.reason === "role")
    return `Seu papel é ${membershipRoleLabels[org.role]}. ${copy.role ?? ""}`;
  if (step.reason === "no-company")
    return `Nenhuma empresa${task === "importar" ? "" : " declarada"} liberada para você. ${managers} cadastra a empresa e libera o acesso a ela em Empresas.`;
  if (step.reason === "freecorps")
    return "A Freecorps bloqueou a captura desta empresa. Fale com o suporte para saber o motivo.";
  return "Disponível depois da etapa anterior.";
}

/**
 * The Início by task (#510): the member chooses what it wants to do and sees the steps the
 * server computed for that task. The first step it can take now is the next action; a step it
 * cannot take says why and who can; a step waiting for another one follows it, dimmed.
 */
function TaskReadiness({
  org,
  summary,
  task,
  onChoose,
}: {
  org: Organization;
  summary: Summary;
  task: ConsoleTask;
  onChoose: (task: ConsoleTask) => void;
}) {
  const choices = roleTasks(org.role).filter((item) => summary.tasks[summaryTask[item]]);
  const value = summary.tasks[summaryTask[task]];
  // A finished task folds to one line, for whoever already works here; "Trocar de tarefa"
  // brings the choice back, it stays open while the person looks at the others, and "Fechar"
  // folds it again on a finished task. Focus follows: to the chosen task, back to the button.
  const [choosing, setChoosing] = useState(false);
  const chooser = useRef<HTMLDivElement>(null),
    reopen = useRef<HTMLButtonElement>(null),
    toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    if (choosing) chooser.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
    else reopen.current?.focus();
  }, [choosing]);
  const toggle = (open: boolean) => {
    toggled.current = true;
    setChoosing(open);
  };
  if (!value) return null;
  const demo = summary.tasks.import?.demonstrationCompanyId ?? null;
  // A done `permission` says nothing: the member can.
  const steps = value.steps.filter((step) => !(step.key === "permission" && step.state === "done"));
  const done = value.complete ? nextLink(org, task, summary) : null;
  const compact = value.complete && !choosing;
  const list = <StepList org={org} task={task} steps={steps} demo={demo} />;
  return (
    <Card
      title="Sua tarefa"
      description={
        compact
          ? undefined
          : choices.length > 1
            ? "O que você quer fazer? Cada tarefa mostra as etapas que faltam e quem pode fazer cada uma."
            : "Seu papel trabalha pelas integrações: projetos, chaves de API e webhooks. Os documentos e as emissões ficam com os demais papéis."
      }
    >
      <div className={compact ? "home-task home-task--compact" : "home-task"}>
        {choices.length > 1 && !compact ? (
          <div
            ref={chooser}
            className="ui-choice-group home-task__choices"
            role="radiogroup"
            aria-label="Tarefa"
          >
            {choices.map((item) => (
              <RadioCard
                key={item}
                name="console-task"
                value={item}
                checked={item === task}
                onChange={() => onChoose(item)}
                label={taskLabels[item]}
                help={taskStatus(summary.tasks[summaryTask[item]]!)}
              />
            ))}
          </div>
        ) : null}
        <div className="home-task__head">
          <div>
            {/* The badge sits next to the heading, outside it: its name is the task's alone. */}
            <div className="home-item__title">
              <h3>{taskLabels[task]}</h3>
              <StatusBadge tone={value.complete ? "success" : "neutral"}>
                {taskStatus(value)}
              </StatusBadge>
            </div>
            {task === "emitir" && (
              <p className="home-item__note">
                Sandbox simulado: a emissão não vai ao fisco e não tem validade fiscal.
              </p>
            )}
            {value.complete && (
              <p className="home-item__note">
                Tarefa concluída. {done && <DestinationLink className="ui-link" to={done} />}
              </p>
            )}
            {summary.companies.truncated && !value.complete && (
              <p className="home-item__note">
                Etapas calculadas sobre as 10 primeiras empresas que você acessa; uma empresa fora
                delas pode já ter cumprido uma etapa.
              </p>
            )}
          </div>
          {compact && choices.length > 1 ? (
            <Button ref={reopen} size="sm" onClick={() => toggle(true)}>
              Trocar de tarefa
            </Button>
          ) : choosing && value.complete ? (
            <Button size="sm" variant="ghost" icon="close" onClick={() => toggle(false)}>
              Fechar
            </Button>
          ) : null}
        </div>
        {value.steps.every((step) => step.state === "unavailable") ? (
          <p className="home-item__note">{unavailableNote[task]}</p>
        ) : value.complete ? (
          <Disclosure summary="Ver as etapas" className="home-quiet">
            {list}
          </Disclosure>
        ) : (
          list
        )}
      </div>
    </Card>
  );
}

/** The steps of a task, as the server computed them. */
function StepList({
  org,
  task,
  steps,
  demo,
}: {
  org: Organization;
  task: ConsoleTask;
  steps: Step[];
  demo: string | null;
}) {
  const next = steps.find((step) => step.state === "todo");
  return (
    <ol className="home-steps">
      {steps.map((step, index) => {
        const action = step.state === "todo" ? stepAction(org, task, step, demo) : null;
        const [tone, badge] =
          step.state === "done"
            ? (["success", "Concluída"] as const)
            : step === next
              ? (["warning", "Próxima etapa"] as const)
              : step.state === "todo"
                ? (["warning", "Pendente"] as const)
                : step.reason === "previous"
                  ? (["neutral", "Aguardando"] as const)
                  : (["neutral", "Bloqueada"] as const);
        return (
          <li
            key={step.key}
            className={
              step.state === "done"
                ? "is-done"
                : step.reason === "previous"
                  ? "is-later"
                  : undefined
            }
            aria-current={step === next ? "step" : undefined}
          >
            <span className="home-step-index" aria-hidden="true">
              {step.state === "done" ? <Icon name="check" /> : index + 1}
            </span>
            <div>
              <div className="home-item__title">
                <p>{stepCopy(task, step.key).title}</p>
                <StatusBadge tone={tone}>{badge}</StatusBadge>
              </div>
              <p className="home-item__note">{stepNote(task, step, org, demo)}</p>
            </div>
            {action && <DestinationLink className={buttonClass()} to={action} />}
          </li>
        );
      })}
    </ol>
  );
}

/** The task of this Início: `?tarefa=`, then this browser's last choice, then the role's. */
function useTask(org: Organization) {
  const search: { tarefa?: unknown } = useSearch({ strict: false });
  const navigate = useNavigate();
  const fromUrl = parseTask(search.tarefa);
  const [stored, setStored] = useState(() => rememberedTask(org.slug));
  const task = chosenTask(org.role, fromUrl, stored);
  // A task that arrived by the URL (a guide, the landing) is also the choice to return to.
  useEffect(() => {
    if (!fromUrl || fromUrl !== task) return;
    rememberTask(org.slug, fromUrl);
    // Back to the Início without `?tarefa=`, in the same page, the task stays.
    setStored(fromUrl);
  }, [org.slug, fromUrl, task]);
  function choose(next: ConsoleTask) {
    rememberTask(org.slug, next);
    setStored(next);
    if (fromUrl)
      void navigate({
        to: "/app/$organizationSlug",
        params: { organizationSlug: org.slug },
        search: { tarefa: next },
        replace: true,
      });
  }
  return [task, choose] as const;
}

function Count({
  label,
  value,
  partial,
  tone,
}: {
  label: string;
  value: number;
  partial: boolean;
  /** A count that asks for attention when above zero. */
  tone?: "danger";
}) {
  return (
    <div className={value === 0 ? "is-zero" : tone ? `is-${tone}` : undefined}>
      <dt>{label}</dt>
      <dd>
        {value}
        {partial && value > 0 ? <span className="ui-visually-hidden"> ou mais</span> : null}
        {partial && value > 0 ? <span aria-hidden="true">+</span> : null}
      </dd>
    </div>
  );
}

/** What needs someone now, first; when nothing does, one line says so. */
function Pendings({ org, pending }: { org: Organization; pending: Pending[] }) {
  if (!pending.length)
    return (
      <Card label="Pendências">
        <div className="home-clear">
          <span className="home-clear__icon" aria-hidden="true">
            <Icon name="check" />
          </span>
          <div>
            <h2 className="home-item__title">Tudo em dia</h2>
            <p className="home-item__note">Nenhuma pendência nas empresas que você acessa.</p>
          </div>
          <Disclosure summary="O que conferimos" className="home-quiet">
            <p className="home-item__note">
              Nenhuma emissão rejeitada ou em reconciliação neste mês, nenhuma importação com falha,
              nenhuma captura fiscal (Produção) parada e nenhum certificado vencendo nos próximos 30
              dias.
            </p>
          </Disclosure>
        </div>
      </Card>
    );
  return (
    <Card
      title="Pendências"
      description={
        pending.length === 1
          ? "1 item precisa de atenção."
          : `${pending.length} itens precisam de atenção.`
      }
    >
      <ul className="home-pending">
        {pending.map((item) => {
          const text = pendingText[item.kind](item);
          return (
            <li key={`${item.kind}:${item.companyId}:${item.recordId ?? ""}`}>
              <div>
                <p className="home-item__title">{text.title}</p>
                <p className="home-item__note">{text.note}</p>
              </div>
              <PendingLink org={org} item={item} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

type Month = NonNullable<Summary["month"]>;
/** The month in three groups (issuances, documents, imports), each with the way to its list. */
function MonthCounts({
  org,
  month,
  monthStart,
  companies,
}: {
  org: Organization;
  month: Month;
  monthStart: number;
  companies: number;
}) {
  const params = { organizationSlug: org.slug };
  const partial = month.partial;
  return (
    <Card
      flush
      title="Neste mês"
      description={`${monthName(monthStart)}, ${
        companies === 1 ? "na empresa que você acessa" : `nas ${companies} empresas que você acessa`
      }.`}
    >
      <div className="home-month">
        <section className="home-month__group" aria-labelledby="home-month-issuances">
          <div className="home-month__head">
            <h3 id="home-month-issuances">Emissões NFS-e</h3>
            <Link className="ui-link" to="/app/$organizationSlug/issuances" params={params}>
              Ver emissões <span aria-hidden="true">→</span>
            </Link>
          </div>
          <dl className="home-stats">
            <Count label="Autorizadas" value={month.issuances.authorized} partial={partial} />
            <Count label="Em processamento" value={month.issuances.processing} partial={partial} />
            <Count
              label="Rejeitadas"
              value={month.issuances.rejected}
              partial={partial}
              tone="danger"
            />
            <Count label="Canceladas" value={month.issuances.cancelled} partial={partial} />
          </dl>
        </section>
        <section className="home-month__group" aria-labelledby="home-month-documents">
          <div className="home-month__head">
            <h3 id="home-month-documents">Documentos</h3>
            <Link className="ui-link" to="/app/$organizationSlug/documents" params={params}>
              Ver documentos <span aria-hidden="true">→</span>
            </Link>
          </div>
          <dl className="home-stats">
            <Count
              label={month.production ? "Documentos recebidos no sandbox" : "Documentos recebidos"}
              value={month.received}
              partial={partial}
            />
            {month.production ? (
              <Count
                label="Documentos recebidos em Produção"
                value={month.production.received}
                partial={partial}
              />
            ) : null}
          </dl>
        </section>
        <section className="home-month__group" aria-labelledby="home-month-imports">
          <div className="home-month__head">
            <h3 id="home-month-imports">Importações</h3>
            {org.capabilities.operateDocuments ? (
              <Link className="ui-link" to="/app/$organizationSlug/imports" params={params}>
                Importar XML <span aria-hidden="true">→</span>
              </Link>
            ) : null}
          </div>
          <dl className="home-stats">
            <Count
              label="Importações com falha"
              value={month.failedImports}
              partial={partial}
              tone="danger"
            />
          </dl>
        </section>
      </div>
      {partial && (
        <p className="home-stats__note">
          Contagem parcial (+): o resumo considera até 10 empresas e os 100 registros mais recentes
          de cada uma. A lista de cada tela tem o total.
        </p>
      )}
    </Card>
  );
}

export function OrganizationStart({ org, contextKey }: { org: Organization; contextKey: string }) {
  const [{ monthStart, asOf }] = useState(clock);
  const summary = useQuery(api.consoleHome.summary, {
    organizationId: org.id,
    monthStart,
    asOf,
    contextKey,
  });
  const params = { organizationSlug: org.slug };
  const [task, choose] = useTask(org);
  // The header's action follows the task; with the summary, it points to the task's company.
  const primary = taskDestinations(org, summary)[task];
  // The fiscal overview needs a company and a role that reads it (the developer's has none).
  const fiscal = !!summary?.month && summary.companies.count > 0;
  return (
    <Page>
      <PageHeader
        title="Início"
        description={`${org.name} · seu papel: ${membershipRoleLabels[org.role].toLowerCase()}.`}
        actions={primary ? <TaskAction to={primary} /> : undefined}
      />
      {summary === undefined ? (
        <Card>
          <SkeletonBlock label="Carregando o resumo…" lines={4} />
        </Card>
      ) : (
        <>
          {/* What needs someone now goes before everything; the task guides the rest. */}
          {fiscal && summary.pending.length ? (
            <Pendings org={org} pending={summary.pending} />
          ) : null}
          <TaskReadiness org={org} summary={summary} task={task} onChoose={choose} />
          {!fiscal || !summary.month ? null : (
            <>
              {summary.pending.length ? null : <Pendings org={org} pending={[]} />}
              <MonthCounts
                org={org}
                month={summary.month}
                monthStart={monthStart}
                companies={summary.companies.count}
              />
              <HomeRecent org={org} contextKey={contextKey} environment={summary.environment} />
            </>
          )}
        </>
      )}
      <div className="home-footer">
        <p>
          {org.memberCount}{" "}
          {org.memberCount === 1 ? "membro nesta organização." : "membros nesta organização."}
        </p>
        {org.capabilities.manageMembers && (
          <Link
            className="ui-link"
            to="/app/$organizationSlug/settings/$section"
            params={{ ...params, section: "members" }}
          >
            Gerenciar membros
          </Link>
        )}
      </div>
    </Page>
  );
}
