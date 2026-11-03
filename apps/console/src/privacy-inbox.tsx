import { useEffect, useRef, useState } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import { useAsyncAction } from "./async-action";
import { formatDateTime } from "./format";
import { Button } from "./ui/button";
import { FormField as Field, Select, Textarea } from "./ui/form";
import {
  Card,
  Callout,
  EmptyState,
  Page,
  PageHeader,
  SkeletonBlock,
  StatusBadge,
} from "./ui/layout";

type Status = "open" | "waiting" | "closed";
const labels: Record<Status, string> = {
  open: "Abertos",
  waiting: "Aguardando resposta",
  closed: "Encerrados",
};
const deliveryLabels = {
  queued: "Na fila",
  sending: "Enviando",
  accepted: "Aceita pelo provedor",
  failed: "Envio recusado",
  uncertain: "Envio sem confirmação",
};
type Mailbox = "privacy" | "security" | "support" | "operation";
const boxes = {
  privacy: {
    title: "Privacidade",
    path: "/console/privacidade",
    owners: "pela privacidade",
    item: "pedido",
    Item: "Pedido",
    items: "Pedidos",
    caution: "Confira a identidade antes de atender",
    guidance:
      "O endereço e o conteúdo do e-mail não comprovam quem escreveu. Registre a verificação, os prazos, a decisão e a execução em notas internas.",
  },
  security: {
    title: "Segurança",
    path: "/console/seguranca",
    owners: "pela segurança",
    item: "relato",
    Item: "Relato",
    items: "Relatos",
    caution: "Trate o relato e os anexos como não confiáveis",
    guidance:
      "Reproduza só em ambiente isolado, com dados inventados. Registre a triagem, a primeira resposta, a correção e a divulgação combinada em notas internas.",
  },
  support: {
    title: "Suporte",
    path: "/console/suporte",
    owners: "pelo suporte",
    item: "chamado",
    Item: "Chamado",
    items: "Chamados",
    caution: "Não peça senhas, certificados nem chaves de API",
    guidance:
      "O endereço e o conteúdo do e-mail não comprovam quem escreveu. Confirme a conta e a organização antes de tratar dados de clientes e registre a triagem e o encaminhamento em notas internas.",
  },
  operation: {
    title: "Operação",
    path: "/console/operacao",
    owners: "pela operação",
    item: "alerta",
    Item: "Alerta",
    items: "Alertas",
    caution: "Confira o alerta na lista da captura antes de agir",
    guidance:
      "Os alertas da captura fiscal chegam aqui. O e-mail não comprova o alerta: confira a empresa pelo workflow capture-release-list.yml, siga o runbook da captura e registre o que foi feito em notas internas.",
  },
} as const;
type Box = (typeof boxes)[Mailbox];
export const PrivacyInbox = () => <MailInbox mailbox="privacy" />;
export const SecurityInbox = () => <MailInbox mailbox="security" />;
export const SupportInbox = () => <MailInbox mailbox="support" />;
export const OperationInbox = () => <MailInbox mailbox="operation" />;
function MailInbox({ mailbox }: { mailbox: Mailbox }) {
  const access = useQuery(api.privacyMail.access, { mailbox });
  if (!access)
    return (
      <Page>
        <SkeletonBlock label="Verificando acesso à caixa…" />
      </Page>
    );
  if (!access.allowed)
    return (
      <Page>
        <EmptyState
          title="Acesso restrito"
          description={`Esta caixa é exclusiva dos responsáveis ${boxes[mailbox].owners} da Freecorps.`}
        />
      </Page>
    );
  return <Inbox mailbox={mailbox} address={access.address} simulated={access.simulated} />;
}
function Inbox({
  mailbox,
  address,
  simulated,
}: {
  mailbox: Mailbox;
  address: string;
  simulated: boolean;
}) {
  const box = boxes[mailbox];
  const search = useSearch({ strict: false }) as { thread?: string; status?: Status };
  const status = search.status ?? "open";
  const navigate = useNavigate();
  const {
    results,
    status: loading,
    loadMore,
  } = usePaginatedQuery(api.privacyMail.list, { mailbox, status }, { initialNumItems: 20 });
  return (
    <Page>
      <PageHeader title={box.title} eyebrow="Atendimento restrito" description={address} />
      {simulated && (
        <Callout title="Envio simulado">
          Neste ambiente as respostas ficam registradas, mas nenhum e-mail é enviado.
        </Callout>
      )}
      <Field id="privacy-status" label="Situação">
        <Select
          id="privacy-status"
          value={status}
          onChange={(e) =>
            void navigate({
              to: box.path,
              search: { status: e.target.value as Status },
            })
          }
        >
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="privacy-inbox">
        <Card title={box.items}>
          {loading === "LoadingFirstPage" ? (
            <SkeletonBlock label={`Carregando ${box.items.toLowerCase()}…`} />
          ) : results.length === 0 ? (
            <EmptyState
              title={`Nenhum ${box.item} nesta situação`}
              description="Novas mensagens aparecem aqui assim que chegam."
            />
          ) : (
            <ul className="privacy-inbox__list">
              {results.map((row) => (
                <li key={row._id}>
                  <button
                    type="button"
                    className="privacy-inbox__item"
                    aria-current={row._id === search.thread ? "true" : undefined}
                    onClick={() =>
                      void navigate({
                        to: box.path,
                        search: { status, thread: row._id },
                      })
                    }
                  >
                    <strong>{row.subject}</strong>
                    <span>{row.contact || "Remetente não informado"}</span>
                    <span>
                      {formatDateTime(row.updatedAt)} {row.unread && "· Não lido"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(loading === "CanLoadMore" || loading === "LoadingMore") && (
            <Button disabled={loading === "LoadingMore"} onClick={() => loadMore(20)}>
              Carregar mais {box.items.toLowerCase()}
            </Button>
          )}
        </Card>
        {search.thread ? (
          <Conversation
            key={search.thread}
            box={box}
            threadId={search.thread as Id<"privacyThreads">}
          />
        ) : (
          <Card>
            <EmptyState
              title={`Selecione um ${box.item}`}
              description="Leia a conversa, registre a decisão e responda por e-mail."
            />
          </Card>
        )}
      </div>
    </Page>
  );
}
function Conversation({ box, threadId }: { box: Box; threadId: Id<"privacyThreads"> }) {
  const row = useQuery(api.privacyMail.thread, { threadId });
  const { results, status, loadMore } = usePaginatedQuery(
    api.privacyMail.messages,
    { threadId },
    { initialNumItems: 10 },
  );
  const markRead = useMutation(api.privacyMail.markRead),
    setStatus = useMutation(api.privacyMail.setStatus);
  const queueReply = useMutation(api.privacyMail.queueReply),
    note = useMutation(api.privacyMail.note),
    download = useMutation(api.privacyMail.download);
  const [text, setText] = useState(""),
    [kind, setKind] = useState<"reply" | "note">("reply");
  const request = useRef<{ text: string; id: string } | null>(null);
  const action = useAsyncAction(
    () =>
      "Não foi possível concluir a ação. O texto foi preservado; confira sua conexão e seu acesso.",
  );
  const [readError, setReadError] = useState(false);
  useEffect(() => {
    if (row?.unread) void markRead({ threadId }).catch(() => setReadError(true));
  }, [row?.unread, markRead, threadId]);
  if (row === undefined)
    return (
      <Card>
        <SkeletonBlock label="Carregando conversa…" />
      </Card>
    );
  if (!row)
    return (
      <Card>
        <EmptyState title={`${box.Item} não encontrado`} />
      </Card>
    );
  async function submit() {
    if (action.busy || !text.trim()) return;
    if (!request.current || request.current.text !== text)
      request.current = { text, id: crypto.randomUUID() };
    const requestId = request.current.id;
    await action.run(
      () =>
        kind === "reply" ? queueReply({ threadId, text, requestId }) : note({ threadId, text }),
      {
        done: () => {
          setText("");
          request.current = null;
        },
      },
    );
  }
  return (
    <Card
      title={row.subject}
      description={row.contact || "Sem endereço para resposta"}
      actions={
        <Button
          disabled={action.busy}
          onClick={() =>
            void action.run(() =>
              setStatus({ threadId, status: row.status === "closed" ? "open" : "closed" }),
            )
          }
        >
          {row.status === "closed" ? `Reabrir ${box.item}` : `Encerrar ${box.item}`}
        </Button>
      }
    >
      <Callout title={box.caution}>{box.guidance}</Callout>
      {(action.error || readError) && (
        <Callout tone="danger" role="alert">
          {action.error || `Não foi possível marcar o ${box.item} como lido.`}
        </Callout>
      )}
      <div className="privacy-inbox__messages">
        {status === "LoadingFirstPage" && <SkeletonBlock label="Carregando mensagens…" />}
        {results.map((message) => (
          <article key={message._id} className="privacy-inbox__message">
            <header>
              <strong>
                {message.kind === "note"
                  ? "Nota interna"
                  : message.kind === "reply"
                    ? "Resposta"
                    : "Mensagem recebida"}
              </strong>
              <span>{formatDateTime(message.createdAt)}</span>
            </header>
            <p className="privacy-inbox__sender">{message.from}</p>
            <p className="privacy-inbox__text">{message.text}</p>
            {message.state && (
              <StatusBadge
                tone={
                  message.state === "failed" || message.state === "uncertain"
                    ? "warning"
                    : "neutral"
                }
              >
                {deliveryLabels[message.state]}
              </StatusBadge>
            )}
            {message.state === "uncertain" && (
              <Callout tone="warning">
                Confira o histórico de envio do provedor antes de enviar novamente. A mensagem pode
                ter sido aceita.
              </Callout>
            )}
            {!!message.attachmentNames?.length && (
              <p>Anexos no original: {message.attachmentNames.join(", ")}</p>
            )}
            {message.raw && (
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(() => download({ messageId: message._id }), {
                    done: (url) => {
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = "mensagem.eml";
                      link.rel = "noopener";
                      link.style.display = "none";
                      document.body.appendChild(link);
                      link.click();
                      link.remove();
                    },
                  })
                }
              >
                Baixar mensagem original e anexos
              </Button>
            )}
          </article>
        ))}
        {(status === "CanLoadMore" || status === "LoadingMore") && (
          <Button disabled={status === "LoadingMore"} onClick={() => loadMore(10)}>
            Carregar mensagens anteriores
          </Button>
        )}
      </div>
      <form
        className="privacy-inbox__compose"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field id="privacy-kind" label="Ação">
          <Select
            id="privacy-kind"
            value={kind}
            disabled={action.busy}
            onChange={(e) => setKind(e.target.value as "reply" | "note")}
          >
            <option value="reply">Responder por e-mail</option>
            <option value="note">Registrar nota interna</option>
          </Select>
        </Field>
        <Field
          id="privacy-text"
          label={kind === "reply" ? "Resposta ao remetente" : "Nota restrita aos responsáveis"}
        >
          <Textarea
            id="privacy-text"
            rows={6}
            maxLength={20_000}
            value={text}
            disabled={action.busy}
            onChange={(e) => setText(e.target.value)}
            required
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          disabled={
            action.busy ||
            !text.trim() ||
            (kind === "reply" && (row.status === "closed" || !row.contact))
          }
        >
          {action.busy ? "Salvando…" : kind === "reply" ? "Enviar resposta" : "Salvar nota"}
        </Button>
        {row.status === "closed" && kind === "reply" && <p>Reabra o {box.item} para responder.</p>}
      </form>
    </Card>
  );
}
