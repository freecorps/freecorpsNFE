import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../platform/convex/_generated/api";
import { Feedback } from "./project-sections";
import { useAsyncAction } from "./async-action";
import { apiOrigin } from "./api-origin";
import { CopyButton } from "./integration-controls";
import { formatDateTime } from "./format";
import { Button } from "./ui/button";
import { Disclosure } from "./ui/disclosure";
import { FormField, Input, controlProps } from "./ui/form";
import { Callout, Card, StatusBadge } from "./ui/layout";
import {
  connectionStatus,
  marketLabels,
  stripeError,
  type Config,
  type Connection,
} from "./stripe-shared";

// Setup guide: the steps in the Stripe dashboard, the signing secret and the data the charge
// must carry.

/** The events the endpoint must send; any other type is acknowledged and dropped. */
export const stripeEventTypes = [
  "invoice.paid",
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "charge.refunded",
  "charge.dispute.closed",
] as const;

export function stripeWebhookUrl(connectionId: string, origin = apiOrigin()) {
  return `${origin}/v1/stripe/connections/${connectionId}/events`;
}

function Code({ label, value }: { label: string; value: string }) {
  return (
    <div className="gestao-code">
      <pre tabIndex={0} role="region" aria-label={label}>
        <code>{value}</code>
      </pre>
      <CopyButton value={value} label={`Copiar ${label.toLowerCase()}`} />
    </div>
  );
}

export function SetupGuide({ connection, manager }: { connection: Connection; manager: boolean }) {
  const status = connectionStatus(connection);
  const url = stripeWebhookUrl(connection.id);
  const config = connection.config;
  const steps = (
    <ol className="gestao-steps">
      <li>
        <div>
          <h3>Escolha para quem o software vende</h3>
          <p>
            Em Configuração, diga se as vendas são nacionais, ao exterior ou os dois, e escolha a
            atividade do perfil NFS-e de cada mercado. Hoje:{" "}
            <strong>{marketLabels[config.market]}</strong>
            {config.domesticActivityCode ? ` · nacional: ${config.domesticActivityCode}` : ""}
            {config.exportActivityCode ? ` · exterior: ${config.exportActivityCode}` : ""}.
          </p>
        </div>
      </li>
      <li>
        <div>
          <h3>Cadastre o endpoint no Stripe</h3>
          <p>
            No painel do Stripe, abra <strong>Developers → Webhooks → Add endpoint</strong> (nas
            contas novas, <strong>Workbench → Webhooks → Create an event destination</strong>, com
            eventos da sua conta) e cole esta URL:
          </p>
          <Code label="URL do endpoint" value={url} />
        </div>
      </li>
      <li>
        <div>
          <h3>Selecione exatamente estes eventos</h3>
          <p>
            Outros tipos são aceitos e descartados, sem registro. Sem <code>charge.refunded</code> e{" "}
            <code>charge.dispute.closed</code>, reembolsos e disputas não chegam à nota.
          </p>
          <Code label="Lista de eventos" value={stripeEventTypes.join("\n")} />
        </div>
      </li>
      <li>
        <div>
          <h3>Cole o Signing secret</h3>
          <p>
            Na página do endpoint criado, clique em <strong>Reveal</strong> no{" "}
            <strong>Signing secret</strong> (começa com <code>whsec_</code>) e cole aqui. Ele fica
            cifrado e não volta a aparecer.
          </p>
          <SecretForm connection={connection} manager={manager} />
        </div>
      </li>
      <li>
        <div>
          <h3>Envie um evento de teste</h3>
          <p>
            No endpoint, use <strong>Send test event</strong> (ou dispare uma cobrança de teste) com
            um dos eventos da lista e veja a situação abaixo mudar. O modo de teste e o modo real do
            Stripe têm endpoints e segredos separados: o segredo colado vale só para o endpoint do
            modo em que você o copiou.
          </p>
          <p>
            {connection.environment === "sandbox"
              ? "Esta conexão é Sandbox: aceita eventos de teste e reais, e as notas saem pelo simulador, sem validade fiscal."
              : "Esta conexão é de Produção: aceita só eventos reais (live mode). Eventos de teste ficam como ignorados, sem nota."}
          </p>
        </div>
      </li>
    </ol>
  );
  return (
    <Card
      title="Passo a passo no Stripe"
      description="Cinco passos para que cada cobrança paga vire uma NFS-e."
      actions={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
    >
      <div className="ui-stack">
        <Callout
          tone={status.tone === "neutral" ? "info" : status.tone}
          role="status"
          title={status.label}
        >
          {status.detail}
        </Callout>
        {connection.lastEventAt ? (
          <Disclosure summary="Rever o passo a passo">{steps}</Disclosure>
        ) : (
          steps
        )}
      </div>
    </Card>
  );
}

function SecretForm({ connection, manager }: { connection: Connection; manager: boolean }) {
  const setSecret = useMutation(api.stripe.setSigningSecret);
  const [value, setValue] = useState(""),
    [notice, setNotice] = useState("");
  const { busy, error, run } = useAsyncAction(stripeError);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    await run(() => setSecret({ connectionId: connection.id, secret: value }), {
      done: () => {
        setValue("");
        setNotice("Segredo salvo. Envie um evento de teste para conferir.");
      },
    });
  }
  const state = connection.secretSetAt
    ? `Configurado em ${formatDateTime(connection.secretSetAt)}.`
    : "Ainda não configurado.";
  if (!manager)
    return (
      <p className="gestao-help">{state} Só proprietários e administradores trocam o segredo.</p>
    );
  return (
    <form className="ui-form" onSubmit={submit} aria-busy={busy}>
      <FormField id={`stripe-secret-${connection.id}`} label="Signing secret" help={state}>
        <div className="gestao-secret">
          <Input
            {...controlProps(`stripe-secret-${connection.id}`, undefined, true)}
            name="secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="whsec_…"
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
          <Button type="submit" variant="primary" loading={busy} loadingLabel="Salvando…">
            {connection.secretSet ? "Trocar segredo" : "Salvar segredo"}
          </Button>
        </div>
      </FormField>
      <Feedback error={error} />
      {notice ? (
        <Callout tone="success" role="status">
          {notice}
        </Callout>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// What the charge must carry

const checkoutExample = `const session = await stripe.checkout.sessions.create({
  mode: "payment", // assinatura: "subscription" (a nota sai do invoice.paid)
  customer: customerId, // opcional; sem ele, o Checkout cria o cliente
  billing_address_collection: "required",
  tax_id_collection: { enabled: true },
  customer_update: { address: "auto", name: "auto" }, // grava no Customer (exige customer)
  line_items: [{ price: "price_…", quantity: 1 }],
  success_url: "https://seu-app.com.br/obrigado",
});`;
const customerExample = `// Antes da fatura ser finalizada: o invoice.paid leva a foto do cliente nesse momento.
await stripe.customers.update(customerId, {
  name: "Cliente Exemplo Ltda",
  address: {
    line1: "Rua das Flores, 120", // rua, número
    line2: "Centro", // bairro
    city: "Campinas",
    state: "SP",
    postal_code: "13010-000",
    country: "BR",
  },
});
await stripe.customers.createTaxId(customerId, { type: "br_cnpj", value: "11444777000161" });`;

export function DataGuide({ market }: { market: Config["market"] }) {
  const domestic = (
    <div>
      <h3 className="gestao-heading">Cliente nacional</h3>
      <ul>
        <li>Nome.</li>
        <li>
          CPF ou CNPJ como tax ID do cliente, do tipo <code>br_cpf</code> ou <code>br_cnpj</code>.
        </li>
        <li>Endereço com linha 1 (rua, número), CEP, cidade e UF; o bairro vai na linha 2.</li>
        <li>Moeda BRL.</li>
      </ul>
    </div>
  );
  const exported = (
    <div>
      <h3 className="gestao-heading">Cliente no exterior</h3>
      <ul>
        <li>Nome.</li>
        <li>Endereço completo: linha 1, cidade, postal code e país; estado (state) recomendado.</li>
        <li>
          Tax ID do cliente (NIF), opcional conforme a configuração “Cliente do exterior sem NIF”.
        </li>
        <li>Moeda USD, CAD, EUR ou GBP, convertida pela PTAX.</li>
      </ul>
    </div>
  );
  return (
    <Card
      title="Informações que precisam vir do Stripe"
      description="A nota usa o que o Stripe mandou no evento. Peça esses dados no momento da cobrança."
    >
      <div className="ui-stack">
        <div className="gestao-grid gestao-grid--even">
          {market !== "export" ? domestic : null}
          {market !== "domestic" ? exported : null}
        </div>
        <Callout tone="info" title="Faltou algum dado?">
          O evento fica como <strong>Pendente de dados</strong>, sem gastar número de DPS. Uma
          pessoa completa os campos em Eventos recebidos e libera a emissão.
          {market === "both"
            ? " Com os dois mercados, o país do endereço decide: BR é nacional."
            : ""}
        </Callout>
        <Disclosure summary="Como pedir esses dados no Stripe">
          <div className="ui-stack">
            <p>
              <strong>Checkout:</strong> exija o endereço de cobrança e ligue a coleta de tax ID.
              Com um Customer existente, <code>customer_update</code> grava nome e endereço nele.
            </p>
            <Code label="Exemplo de Checkout" value={checkoutExample} />
            <p>
              <strong>Assinaturas e faturas:</strong> os dados precisam estar no Customer (endereço
              e tax IDs) antes de a fatura ser finalizada, porque o <code>invoice.paid</code> leva a
              foto em <code>customer_address</code> e <code>customer_tax_ids</code>.
            </p>
            <Code label="Exemplo de Customer" value={customerExample} />
          </div>
        </Disclosure>
      </div>
    </Card>
  );
}
