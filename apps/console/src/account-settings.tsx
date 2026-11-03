import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { membershipRoleLabels } from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import { authClient } from "./auth";
import { forgetOrganization } from "./session-handoff";
import { Button } from "./ui/button";
import { FormField, Input, controlProps } from "./ui/form";
import { Callout, Card, DescriptionList, Page, PageHeader, SkeletonBlock } from "./ui/layout";

const messages: Record<string, string> = {
  INVALID_NAME: "Informe um nome entre 2 e 100 caracteres.",
  INVALID_EMAIL: "Confira o e-mail. Use o formato nome@empresa.com.br.",
  EMAIL_UNCHANGED: "Este já é o e-mail da sua conta.",
  CONFIRMATION_MISMATCH: "Digite o e-mail da conta exatamente como aparece acima.",
  ACCOUNT_HAS_MEMBERSHIPS:
    "Sua conta ainda participa de uma organização. Saia de todas antes de excluir a conta.",
  RATE_LIMITED: "Muitas tentativas. Aguarde um minuto e tente novamente.",
  EMAIL_UNVERIFIED: "Verifique seu e-mail antes de continuar.",
  UNAUTHENTICATED: "Sua sessão terminou. Entre novamente para continuar.",
};
const outcomes = {
  invalid: "Código incorreto. Confira o último código recebido no novo e-mail.",
  expired: "O código expirou. Peça um novo código.",
  exhausted: "Tentativas esgotadas. Peça um novo código.",
  unavailable: "Este e-mail já é usado por outra conta. Escolha outro endereço.",
} as const;
function failure(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code =
    data && typeof data === "object" && "code" in data && typeof data.code === "string"
      ? data.code
      : "";
  return messages[code] ?? "Não foi possível concluir agora. Tente novamente.";
}
function text(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
function Feedback({ error, message = "" }: { error: string; message?: string }) {
  return (
    <>
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
      {message && (
        <Callout tone="success" role="status">
          {message}
        </Callout>
      )}
    </>
  );
}

/**
 * The account's own data (D02): name, login e-mail and deletion. Every change is checked again
 * by `platform/convex/account.ts`; the e-mail change and the deletion end the sessions, so the
 * page signs out and goes to the login.
 */
export function AccountSettings() {
  const session = useQuery(api.access.session, {});
  return (
    <Page>
      <PageHeader
        title="Minha conta"
        description="Seu nome, o e-mail de acesso e a exclusão da conta."
      />
      <div className="gestao-narrow-page">
        {session ? (
          <>
            <NameCard name={session.name} />
            <EmailCard email={session.email} />
            <DeleteCard email={session.email} />
          </>
        ) : (
          <Card>
            <SkeletonBlock label="Carregando sua conta…" />
          </Card>
        )}
      </div>
    </Page>
  );
}

function useLeave() {
  const convex = useConvex(),
    navigate = useNavigate();
  return async (email?: string) => {
    // The server already ended the sessions; this clears what the browser still holds.
    await authClient.signOut().catch(() => undefined);
    forgetOrganization();
    convex.clearAuth();
    await navigate({ to: "/login", search: email ? { email } : {} });
  };
}

function NameCard({ name }: { name: string }) {
  const rename = useMutation(api.account.rename);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await rename({ name: text(form, "name") });
      setMessage("Nome atualizado na conta e nas organizações de que você participa.");
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Nome" description="Aparece para os membros das suas organizações.">
      <form className="ui-form" onSubmit={submit} aria-busy={busy}>
        <FormField id="account-name" label="Nome">
          <Input
            {...controlProps("account-name", undefined, false)}
            key={name}
            name="name"
            defaultValue={name}
            autoComplete="name"
            minLength={2}
            maxLength={100}
            required
            disabled={busy}
          />
        </FormField>
        <Feedback error={error} message={message} />
        <div>
          <Button type="submit" variant="primary" loading={busy} loadingLabel="Salvando…">
            Salvar nome
          </Button>
        </div>
      </form>
    </Card>
  );
}

function EmailCard({ email }: { email: string }) {
  // Without account e-mail no invitation reaches this address (#538) and the change code never
  // reaches the new one (#628). Only an explicit `false` changes the card; while the answer has not
  // arrived it stays as it was.
  const capabilities = useQuery(api.account.capabilities);
  const invitationEmail = capabilities?.invitationEmail,
    emailChange = capabilities?.emailChange !== false;
  const request = useAction(api.account.requestEmailChange),
    confirm = useMutation(api.account.confirmEmailChange),
    leave = useLeave();
  const [next, setNext] = useState(""),
    [sent, setSent] = useState(false),
    [code, setCode] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request({ email: next });
      setSent(true);
      setCode("");
      setMessage(
        "Se o endereço puder ser usado, ele recebe um código de oito dígitos, válido por dez minutos.",
      );
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const outcome = await confirm({ code });
      if (outcome === "changed") {
        await leave(next.trim().toLowerCase());
        return;
      }
      if (outcome !== "invalid") setSent(false);
      setError(outcomes[outcome]);
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="E-mail de acesso"
      description={`${
        invitationEmail === false
          ? "É o seu login."
          : "É o seu login e o endereço que recebe os convites."
      }${emailChange ? " A troca exige um código enviado ao novo endereço e encerra as sessões abertas." : ""}`}
    >
      <div className="ui-stack">
        <DescriptionList items={[{ term: "E-mail atual", value: email }]} />
        {!emailChange ? (
          <Callout title="Este painel não troca o e-mail de acesso.">
            A troca exige um código enviado ao novo endereço, e este painel não envia e-mails de
            conta. Para usar outro endereço, peça a quem administra o painel que ative o envio de
            e-mails de conta.
          </Callout>
        ) : sent ? (
          <form className="ui-form" onSubmit={verify} aria-busy={busy} noValidate>
            <FormField
              id="account-email-code"
              label={`Código enviado para ${next.trim().toLowerCase()}`}
              help="Depois da troca, entre novamente com o novo e-mail. Convites pendentes para o endereço anterior deixam de valer."
            >
              <Input
                {...controlProps("account-email-code", undefined, true)}
                className="ui-mono"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                disabled={busy}
              />
            </FormField>
            <Feedback error={error} message={message} />
            <div className="ui-actions">
              <Button type="submit" variant="primary" loading={busy} loadingLabel="Confirmando…">
                Confirmar troca
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setSent(false);
                  setError("");
                  setMessage("");
                }}
              >
                Usar outro e-mail
              </Button>
            </div>
          </form>
        ) : (
          <form className="ui-form" onSubmit={ask} aria-busy={busy}>
            <FormField id="account-email" label="Novo e-mail">
              <Input
                {...controlProps("account-email", undefined, false)}
                type="email"
                autoComplete="email"
                maxLength={254}
                value={next}
                onChange={(event) => setNext(event.target.value)}
                required
                disabled={busy}
              />
            </FormField>
            <Feedback error={error} message={message} />
            <div>
              <Button type="submit" variant="primary" loading={busy} loadingLabel="Enviando…">
                Enviar código
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

function DeleteCard({ email }: { email: string }) {
  const deletion = useQuery(api.account.deletion, {}),
    remove = useMutation(api.account.remove),
    leave = useLeave();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await remove({ confirmation: text(form, "confirmation") });
      await leave();
    } catch (error) {
      setError(failure(error));
      setBusy(false);
    }
  }
  return (
    <Card
      title="Excluir conta"
      className="gestao-danger"
      description="A exclusão apaga a conta, as sessões e a senha. Nas organizações de que você participou, seu nome passa a aparecer como Conta excluída, sem e-mail; papel e datas ficam no histórico delas. Os registros de acesso seguem o prazo legal de seis meses."
    >
      {deletion === undefined ? (
        <SkeletonBlock label="Conferindo suas organizações…" lines={2} />
      ) : deletion.blockers.length ? (
        <div className="ui-stack">
          <Callout tone="warning">
            Antes de excluir a conta, saia de todas as organizações. Um proprietário ou
            administrador remove você em Membros. Se você é o único proprietário, transfira a
            propriedade ou encerre a organização.
          </Callout>
          <ul className="gestao-list">
            {deletion.blockers.map((item) => (
              <li key={item.organizationId}>
                <div className="gestao-row">
                  <p className="gestao-row__title">
                    <Link to="/app/$organizationSlug" params={{ organizationSlug: item.slug }}>
                      {item.name}
                    </Link>
                    <span className="gestao-meta">
                      {membershipRoleLabels[item.role]}
                      {item.onlyOwner ? " · único proprietário" : ""}
                    </span>
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {deletion.more && <p className="ui-help">Há mais organizações além destas.</p>}
        </div>
      ) : (
        <form className="ui-form" onSubmit={submit} aria-busy={busy}>
          <FormField
            id="account-delete-confirmation"
            label={
              <>
                Para confirmar, digite o e-mail da conta: <span className="ui-mono">{email}</span>
              </>
            }
          >
            <Input
              id="account-delete-confirmation"
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
              Excluir conta
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
