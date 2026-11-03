import { useState, type FormEvent } from "react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "./convex-query";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { Organization } from "./organizations";
import { Feedback } from "./project-sections";
import { useAsyncAction } from "./async-action";
import { scopeLabels } from "./integration-controls";
import { Button } from "./ui/button";
import { RadioCard } from "./ui/choice";
import { Checkbox, FormField, Input, Select, Textarea, controlProps } from "./ui/form";
import { Callout, DisabledReason, SkeletonBlock } from "./ui/layout";
import { errorMessages, stripeError, type Config, type Connection } from "./stripe-shared";

// Configuration of a connection: the draft edited by the form and the config the server receives.

type Profile = NonNullable<FunctionReturnType<typeof api.nfseProfiles.get>>;

export type ConfigDraft = {
  name: string;
  market: Config["market"];
  domesticActivityCode: string;
  exportActivityCode: string;
  description: string;
  issRate: string;
  invoices: boolean;
  checkouts: boolean;
  foreignWithoutNif: Config["foreignWithoutNif"];
  refundPolicy: Config["refundPolicy"];
  active: boolean;
};
export const DEFAULT_DESCRIPTION = "{itens} — cobrança {cobranca}, competência {periodo}";
export function draftOf(connection?: Pick<Connection, "name" | "config" | "active">): ConfigDraft {
  const c = connection?.config;
  return {
    name: connection?.name ?? "Stripe",
    market: c?.market ?? "domestic",
    domesticActivityCode: c?.domesticActivityCode ?? "",
    exportActivityCode: c?.exportActivityCode ?? "",
    description: c?.description ?? DEFAULT_DESCRIPTION,
    issRate: c?.issRate?.replace(".", ",") ?? "",
    invoices: c?.invoices ?? true,
    checkouts: c?.checkouts ?? true,
    foreignWithoutNif: c?.foreignWithoutNif ?? "hold",
    refundPolicy: c?.refundPolicy ?? "notify",
    active: connection?.active ?? true,
  };
}
/** The config the server receives; fields of a market the connection does not sell to are left out. */
export function configOf(d: ConfigDraft): Config {
  const domestic = d.market !== "export";
  const exported = d.market !== "domestic";
  const rate = d.issRate.trim().replace(",", ".");
  return {
    market: d.market,
    ...(domestic ? { domesticActivityCode: d.domesticActivityCode } : {}),
    ...(exported ? { exportActivityCode: d.exportActivityCode } : {}),
    description: d.description.trim(),
    ...(domestic && rate ? { issRate: rate } : {}),
    invoices: d.invoices,
    checkouts: d.checkouts,
    foreignWithoutNif: d.foreignWithoutNif,
    refundPolicy: d.refundPolicy,
  };
}
/** Same substitution the server does, over a sample charge. */
export function descriptionPreview(template: string, now = Date.now()) {
  const month = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    month: "2-digit",
    year: "numeric",
  }).format(now);
  const text = template
    .replaceAll("{itens}", "Plano Pro (mensal)")
    .replaceAll("{cobranca}", "A1B2C3-0001")
    .replaceAll("{periodo}", month)
    .replace(/\s+/g, " ")
    .trim();
  return text || "Serviço";
}

export function ConfigForm({
  org,
  contextKey,
  companyId,
  connection,
  grantScopes,
  editable,
  submitLabel,
  onSubmit,
}: {
  org: Organization;
  contextKey: string;
  companyId: Id<"companies">;
  connection?: Connection;
  grantScopes: readonly string[];
  editable: boolean;
  submitLabel: string;
  onSubmit: (draft: ConfigDraft) => Promise<void>;
}) {
  const profile = useQuery(api.nfseProfiles.get, { organizationId: org.id, companyId, contextKey });
  const [draft, setDraft] = useState(() => draftOf(connection)),
    [notice, setNotice] = useState("");
  const { busy, error, run } = useAsyncAction(stripeError);
  const id = connection ? `stripe-edit-${connection.id}` : "stripe-create";
  function set<K extends keyof ConfigDraft>(key: K, value: ConfigDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    await run(() => onSubmit(draft), { done: () => setNotice("Configuração salva.") });
  }
  if (profile === undefined) return <SkeletonBlock label="Carregando perfil NFS-e…" />;
  const domestic = draft.market !== "export";
  const exported = draft.market !== "domestic";
  const triggerReason = draft.invoices || draft.checkouts ? "" : "Marque pelo menos um gatilho.";
  return (
    <form className="ui-form" onSubmit={submit} aria-busy={busy}>
      {editable ? null : (
        <Callout tone="info">
          Só proprietários e administradores alteram a conexão, porque ela emite nota sozinha. Você
          vê a configuração em modo leitura.
        </Callout>
      )}
      {profile ? null : <Callout tone="warning">{errorMessages.NFSE_PROFILE_REQUIRED}</Callout>}
      {profile && !profile.issuerEmail ? (
        <Callout tone="warning">{errorMessages.STRIPE_ISSUER_EMAIL_REQUIRED}</Callout>
      ) : null}
      <fieldset className="gestao-fieldset" disabled={busy || !editable}>
        <legend className="ui-visually-hidden">Configuração da conexão</legend>
        <div className="ui-stack">
          <FormField id={`${id}-name`} label="Nome da conexão">
            <Input
              id={`${id}-name`}
              required
              maxLength={100}
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </FormField>
          <div className="ui-field">
            <p className="ui-label" id={`${id}-market`}>
              Para quem o software vende
            </p>
            <div className="ui-choice-group" role="radiogroup" aria-labelledby={`${id}-market`}>
              <RadioCard
                name={`${id}-market`}
                label="Nacional"
                help="Clientes no Brasil, em reais."
                checked={draft.market === "domestic"}
                onChange={() => set("market", "domestic")}
              />
              <RadioCard
                name={`${id}-market`}
                label="Exterior"
                help="Exportação de serviço, em moeda estrangeira."
                checked={draft.market === "export"}
                onChange={() => set("market", "export")}
              />
              <RadioCard
                name={`${id}-market`}
                label="Os dois"
                help="O país do endereço do cliente decide: BR é nacional, os demais são exportação."
                checked={draft.market === "both"}
                onChange={() => set("market", "both")}
              />
            </div>
          </div>
          <div className="gestao-grid gestao-grid--even">
            {domestic ? (
              <ActivitySelect
                id={`${id}-domestic`}
                label="Atividade das vendas nacionais"
                profile={profile}
                value={draft.domesticActivityCode}
                onChange={(v) => set("domesticActivityCode", v)}
              />
            ) : null}
            {exported ? (
              <ActivitySelect
                id={`${id}-export`}
                label="Atividade das vendas ao exterior"
                profile={profile}
                value={draft.exportActivityCode}
                onChange={(v) => set("exportActivityCode", v)}
              />
            ) : null}
            {domestic ? (
              <FormField
                id={`${id}-iss`}
                label="Alíquota do ISS (%)"
                optional
                help="Deixe em branco no Simples Nacional sem retenção. A conexão emite sempre sem ISS retido."
              >
                <Input
                  {...controlProps(`${id}-iss`, undefined, true)}
                  inputMode="decimal"
                  placeholder="Ex.: 2,5"
                  maxLength={7}
                  value={draft.issRate}
                  onChange={(e) => set("issRate", e.target.value)}
                />
              </FormField>
            ) : null}
          </div>
          <FormField
            id={`${id}-description`}
            label="Descrição do serviço na nota"
            help={
              <>
                Use <code>{"{itens}"}</code> (linhas da fatura), <code>{"{cobranca}"}</code> (número
                da fatura ou id do Stripe) e <code>{"{periodo}"}</code> (competência, MM/AAAA).
              </>
            }
          >
            <Textarea
              {...controlProps(`${id}-description`, undefined, true)}
              required
              rows={2}
              maxLength={2000}
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </FormField>
          <p className="ui-help fiscal-preview" aria-live="polite">
            Prévia: {descriptionPreview(draft.description)}
          </p>
          <fieldset className="gestao-fieldset">
            <legend>Quando emitir</legend>
            <div className="gestao-choices">
              <Checkbox
                label="Faturas pagas (assinaturas)"
                help="invoice.paid: primeira cobrança e renovações."
                checked={draft.invoices}
                onChange={(e) => set("invoices", e.target.checked)}
              />
              <Checkbox
                label="Checkout avulso pago"
                help="Checkout Session em modo payment, quando o pagamento é confirmado."
                checked={draft.checkouts}
                onChange={(e) => set("checkouts", e.target.checked)}
              />
            </div>
          </fieldset>
          {exported ? (
            <div className="ui-field">
              <p className="ui-label" id={`${id}-nif`}>
                Cliente do exterior sem NIF (tax ID)
              </p>
              <div className="ui-choice-group" role="radiogroup" aria-labelledby={`${id}-nif`}>
                <RadioCard
                  name={`${id}-nif`}
                  label="Segurar o evento"
                  help="Fica pendente de dados até alguém informar o NIF ou o motivo."
                  checked={draft.foreignWithoutNif === "hold"}
                  onChange={() => set("foreignWithoutNif", "hold")}
                />
                <RadioCard
                  name={`${id}-nif`}
                  label="Emitir como “NIF não exigido”"
                  help="Para países que não exigem identificação fiscal do tomador."
                  checked={draft.foreignWithoutNif === "not_required"}
                  onChange={() => set("foreignWithoutNif", "not_required")}
                />
              </div>
            </div>
          ) : null}
          <div className="ui-field">
            <p className="ui-label" id={`${id}-refund`}>
              Reembolso total ou disputa perdida
            </p>
            <div className="ui-choice-group" role="radiogroup" aria-labelledby={`${id}-refund`}>
              <RadioCard
                name={`${id}-refund`}
                label="Só avisar"
                help="Marca a nota como “Cancelamento sugerido”; uma pessoa decide."
                checked={draft.refundPolicy === "notify"}
                onChange={() => set("refundPolicy", "notify")}
              />
              <RadioCard
                name={`${id}-refund`}
                label="Cancelar a nota automaticamente"
                help={`Exige ${scopeLabels["documents:cancel"]} (documents:cancel) na concessão da empresa.`}
                checked={draft.refundPolicy === "cancel"}
                onChange={() => set("refundPolicy", "cancel")}
              />
            </div>
            {draft.refundPolicy === "cancel" && !grantScopes.includes("documents:cancel") ? (
              <p className="ui-help">
                A concessão desta empresa ainda não tem documents:cancel: o servidor vai recusar.
              </p>
            ) : null}
            <p className="ui-help">Reembolso parcial nunca cancela; só fica registrado.</p>
          </div>
          {connection ? (
            <Checkbox
              label="Conexão ativa"
              help="Desativada, os eventos ficam registrados como ignorados e nenhuma nota sai."
              checked={draft.active}
              onChange={(e) => set("active", e.target.checked)}
            />
          ) : null}
        </div>
      </fieldset>
      <Feedback error={error} />
      {notice ? (
        <Callout tone="success" role="status">
          {notice}
        </Callout>
      ) : null}
      {editable ? (
        <div className="gestao-submit">
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            loadingLabel="Salvando…"
            disabled={Boolean(triggerReason)}
            aria-describedby={triggerReason ? `${id}-trigger` : undefined}
          >
            {submitLabel}
          </Button>
          {triggerReason ? (
            <DisabledReason id={`${id}-trigger`}>{triggerReason}</DisabledReason>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function ActivitySelect({
  id,
  label,
  profile,
  value,
  onChange,
}: {
  id: string;
  label: string;
  profile: Profile | null;
  value: string;
  onChange: (value: string) => void;
}) {
  const activities = profile?.activities ?? [];
  const known = activities.some((a) => a.code === value);
  return (
    <FormField id={id} label={label} help="Atividades do perfil NFS-e da empresa.">
      <Select
        {...controlProps(id, undefined, true)}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Escolha uma atividade</option>
        {value && !known ? <option value={value}>{value} (fora do perfil atual)</option> : null}
        {activities.map((a) => (
          <option key={a.code} value={a.code}>
            {a.label} ({a.code})
          </option>
        ))}
      </Select>
    </FormField>
  );
}
