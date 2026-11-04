import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { useQuery } from "./convex-query";
import { Link, useParams } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import type { RouteResult } from "../../../packages/fiscal-nfse/src/route";
import { api } from "../../../platform/convex/_generated/api";
import { formatCompetenceLong, formatIsoDate, todayInBrasilia } from "./format";
import { Button, buttonClass } from "./ui/button";
import { RadioCard } from "./ui/choice";
import { Checkbox, Input as TextInput, Select, Textarea } from "./ui/form";
import { Icon } from "./ui/icons";
import { MunicipalityName, MunicipalitySearch, type IssuanceScope } from "./municipality";
import {
  clean,
  draftFromRequest,
  emptyDraft,
  fieldTargets,
  foreignCurrencies,
  inputOf,
  issuanceError,
  rateAllowed,
  routeOf,
  serverMessages,
  takerDocumentType,
  takerDraft,
  targetLabels,
  transportLabels,
  transportNotes,
  validateDraft,
  issPreview,
  valuePreview,
  type Currency,
  type Draft,
  type FieldErrors,
  type Taker,
  type Transport,
} from "./issuance-draft";
import { Callout, Card, DescriptionList, SkeletonBlock } from "./ui/layout";
import { ConfirmDialog } from "./ui/dialog";
import { ProductionSummary, productionClosedNote, productionSummary } from "./issuance-production";
import { UsageGuidance, isUsageCode, usageErrorCode, type UsageOrg } from "./usage-errors";

type Profile = NonNullable<FunctionReturnType<typeof api.nfseProfiles.get>>;

/**
 * Test markers of the sandbox simulator. Render it only for the simulated transport: a real
 * transport ignores the markers and the text would go to the fisco as written.
 */
export function SimulatorTip({ children }: { children: ReactNode }) {
  return (
    <small className="fiscal-simulator-tip">
      <strong>Dica do simulador:</strong> {children}
    </small>
  );
}

function Field({
  id,
  label,
  error,
  help,
  preview,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  help?: ReactNode;
  /** Live reading of what was typed, as it goes on the DPS. */
  preview?: ReactNode;
  children: ReactNode;
}) {
  // The composition of `FormField` (ui/form), plus the live preview and an error that is
  // announced (`role="alert"`) when the request is refused.
  return (
    <div className="ui-field">
      <label className="ui-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {preview !== undefined && (
        <p id={`${id}-preview`} className="ui-help fiscal-preview" aria-live="polite">
          {preview}
        </p>
      )}
      {help && (
        <p id={`${id}-help`} className="ui-help">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="ui-error-text" role="alert">
          <Icon name="danger" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
const describedBy = (id: string, error?: string, help?: unknown, preview?: unknown) =>
  [
    preview !== undefined ? `${id}-preview` : "",
    help ? `${id}-help` : "",
    error ? `${id}-error` : "",
  ]
    .filter(Boolean)
    .join(" ") || undefined;

export function IssuanceForm({
  scope,
  transport,
  onCreated,
  onCancel,
  correction = null,
  org,
  productionClosed = false,
}: {
  scope: IssuanceScope;
  transport: Transport;
  onCreated: (issuanceId: string) => void;
  /** Leaves the form without asking anything ("Descartar"). */
  onCancel: () => void;
  /** A rejected issuance whose request fills the form, to be corrected and asked again. */
  correction?: { issuanceId: string; label: string } | null;
  /** Who reads a quota or plan refusal: managers get the link to Uso e limites. */
  org?: UsageOrg;
  /** Owners and admins in fiscal production with the company's gate off. */
  productionClosed?: boolean;
}) {
  const { organizationSlug = "" } = useParams({ strict: false });
  const profile = useQuery(api.nfseProfiles.get, {
    organizationId: scope.organizationId,
    companyId: scope.companyId,
    contextKey: `issuance:${scope.companyId}`,
  });
  const previous = useQuery(
    api.issuanceConsole.resubmission,
    correction ? { ...scope, issuanceId: correction.issuanceId } : "skip",
  );
  if (profile === undefined) return <SkeletonBlock label="Carregando o perfil de emissão…" />;
  if (profile === null)
    return (
      <Callout
        tone="warning"
        role="alert"
        headingLevel={2}
        title="Perfil de emissão ausente"
        actions={
          <>
            <Link
              className={buttonClass({ variant: "primary" })}
              to="/app/$organizationSlug/companies/$companyId"
              params={{ organizationSlug, companyId: scope.companyId }}
              search={{ aba: "fiscal" }}
            >
              Abrir a aba Fiscal da empresa
            </Link>
            <Button onClick={onCancel}>Voltar às emissões</Button>
          </>
        }
      >
        <p>
          A empresa ainda não tem perfil NFS-e. Um proprietário ou administrador configura o perfil
          na aba Fiscal da empresa antes da primeira emissão.
        </p>
      </Callout>
    );
  if (correction && previous === undefined)
    return <SkeletonBlock label="Carregando os dados da emissão rejeitada…" />;
  return (
    <DraftForm
      scope={scope}
      profile={profile}
      transport={transport}
      onCreated={onCreated}
      onCancel={onCancel}
      initial={previous ? draftFromRequest(previous, profile) : null}
      correction={correction}
      org={org}
      productionClosed={productionClosed}
    />
  );
}

/** Where the invoice goes, before asking: transport of the deployment and the expected channel. */
function Destination({
  transport,
  route,
  issueDate,
}: {
  transport: Transport;
  route: RouteResult | null;
  issueDate: string;
}) {
  return (
    <Card title="Para onde a nota vai" headingLevel={3} flat className="fiscal-destination">
      <div className="ui-stack">
        <DescriptionList
          items={[
            { key: "transport", term: "Transporte", value: transportLabels[transport] },
            {
              key: "channel",
              term: "Canal previsto",
              value: (
                <span aria-live="polite">
                  {route === null
                    ? "Escolha a atividade e a data da emissão para prever o canal."
                    : route.kind === "nacional"
                      ? `${targetLabels[route.target] ?? route.target}, pela regra vigente em ${formatIsoDate(issueDate)}`
                      : route.message}
                </span>
              ),
            },
          ]}
        />
        <p className="ui-help" role="note">
          {transportNotes[transport]} O servidor confirma transporte e canal ao aceitar o pedido,
          pela regra vigente na data da emissão, e os registra na emissão.
        </p>
      </div>
    </Card>
  );
}

function DraftForm({
  scope,
  profile,
  transport,
  onCreated,
  onCancel,
  initial,
  correction,
  org,
  productionClosed,
}: {
  scope: IssuanceScope;
  profile: Profile;
  transport: Transport;
  onCreated: (issuanceId: string) => void;
  onCancel: () => void;
  initial: Draft | null;
  correction: { issuanceId: string; label: string } | null;
  org?: UsageOrg;
  productionClosed: boolean;
}) {
  const request = useMutation(api.issuanceConsole.request);
  const simulated = transport === "simulated";
  const production = transport === "producao";
  // In fiscal production the request waits for an explicit confirmation of its summary.
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState<Draft>(
    () =>
      initial ?? {
        ...emptyDraft(),
        activityCode: profile.activities.length === 1 ? profile.activities[0]!.code : "",
        description:
          profile.activities.length === 1 ? (profile.activities[0]!.description ?? "") : "",
      },
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ReactNode>("");
  // The fields the last check refused, for the summary at the top: each one a way to the field.
  const [refused, setRefused] = useState<Array<[field: string, id: string, label: string]>>([]);
  const [busy, setBusy] = useState(false);
  // Field to focus once the form is enabled again; a counter so the same field refocuses.
  const [focus, setFocus] = useState<{ field: string; n: number } | null>(null);
  const reasonRef = useRef<HTMLParagraphElement>(null);
  // One idempotency key per attempt: a double click or a resend of the same data after a lost
  // answer reuses it, so the server returns the same issuance instead of issuing twice.
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setTaker = <M extends "national" | "foreign">(
    market: M,
    key: keyof Draft[M],
    value: string,
  ) => setDraft((current) => ({ ...current, [market]: { ...current[market], [key]: value } }));
  const today = todayInBrasilia();
  const simples = profile.opSimpNac !== 1;
  const showRate = draft.market === "domestic" && rateAllowed(draft, profile);
  const withholdingPossible =
    draft.market === "domestic" && takerDocumentType(draft.national.document) === "CNPJ";
  const route = routeOf(draft, profile);
  const targets = fieldTargets(draft);
  const activity = profile.activities.find((a) => a.code === draft.activityCode);

  useEffect(() => {
    if (!focus || busy) return;
    const id = targets.find(([field]) => field === focus.field)?.[1];
    const element = id ? document.getElementById(id) : null;
    const target = element && !(element as HTMLInputElement).disabled ? element : reasonRef.current;
    // Centered, so the label above the field stays in view.
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `targets` follows the draft; only a new focus request moves the focus.
  }, [focus, busy]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setFailure("");
    const found = validateDraft(draft, profile);
    setErrors(found);
    const invalid = targets.filter(([field]) => found[field]);
    setRefused(invalid);
    if (Object.keys(found).length) {
      const names = invalid.map(([, , label]) => label);
      setFailure(
        names.length
          ? `O pedido não foi enviado. Confira ${names.length === 1 ? "o campo" : `os ${names.length} campos`}: ${names.join(", ")}.`
          : "O pedido não foi enviado. Confira os campos indicados.",
      );
      setFocus({ field: invalid[0]?.[0] ?? "", n: (focus?.n ?? 0) + 1 });
      return;
    }
    if (production) {
      setConfirming(true);
      return;
    }
    await send();
  }

  async function send() {
    const input = inputOf(draft, profile);
    const payload = JSON.stringify({ scope, input });
    if (attempt.current?.payload !== payload)
      attempt.current = { key: `console-${crypto.randomUUID()}`, payload };
    setBusy(true);
    try {
      const result = await request({ ...scope, idempotencyKey: attempt.current.key, input });
      onCreated(result.issuanceId);
    } catch (error) {
      const usage = usageErrorCode(error);
      if (isUsageCode(usage)) {
        setFailure(
          <>
            O servidor recusou o pedido. <UsageGuidance code={usage} org={org} />
          </>,
        );
        setFocus({ field: "", n: (focus?.n ?? 0) + 1 });
        return;
      }
      const { message, field } = issuanceError(error);
      const label = targets.find(([name]) => name === field)?.[2];
      const generic = message.startsWith(serverMessages.ISSUANCE_FIELD_INVALID!);
      setFailure(
        label && generic
          ? `O servidor recusou o campo ${label}. ${message.slice(serverMessages.ISSUANCE_FIELD_INVALID!.length).trim() || "Confira o valor."}`
          : `O servidor recusou o pedido. ${message}`,
      );
      if (field) setErrors({ [field]: generic ? "O servidor recusou este valor." : message });
      setFocus({ field: field ?? "", n: (focus?.n ?? 0) + 1 });
    } finally {
      setBusy(false);
    }
  }

  const n = draft.national,
    f = draft.foreign;
  const input = (
    id: string,
    field: string,
    value: string,
    onChange: (value: string) => void,
    options: {
      label: string;
      help?: ReactNode;
      preview?: ReactNode;
      max?: number;
      required?: boolean;
      type?: string;
      inputMode?: "numeric" | "decimal" | "email" | "text";
      autoComplete?: string;
      placeholder?: string;
    },
  ) => (
    <Field
      id={id}
      label={options.label}
      error={errors[field]}
      help={options.help}
      preview={options.preview}
    >
      <TextInput
        id={id}
        value={value}
        type={options.type ?? "text"}
        onChange={(e) => onChange(e.target.value)}
        maxLength={options.max}
        required={options.required ?? false}
        inputMode={options.inputMode}
        autoComplete={options.autoComplete ?? "off"}
        placeholder={options.placeholder}
        aria-invalid={errors[field] ? true : undefined}
        aria-describedby={describedBy(id, errors[field], options.help, options.preview)}
      />
    </Field>
  );
  const descriptionHelp = (
    <>
      {[
        `Obrigatória: vai na DPS como descrição do serviço prestado. ${clean(draft.description).length}/2000 caracteres.`,
        activity?.description && draft.description === activity.description
          ? "Veio da descrição da atividade no perfil; revise antes de pedir."
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
      {simulated && (
        <SimulatorTip>
          <code>[simular:rejeicao]</code> ou <code>[simular:timeout]</code> na descrição ensaiam
          outros desfechos.
        </SimulatorTip>
      )}
    </>
  );
  const nifChoice = (choice: "nif" | "absent") =>
    setDraft((current) => ({
      ...current,
      foreign: { ...current.foreign, nifChoice: choice, nif: "", nifAbsence: "" },
    }));
  const pickTaker = (taker: Taker) =>
    setDraft((current) => {
      const domestic = taker.kind === "national";
      return {
        ...current,
        market: domestic ? "domestic" : "export",
        currency: domestic ? "BRL" : current.market === "export" ? current.currency : "USD",
        issRate: domestic ? current.issRate : "",
        issWithheld: domestic ? current.issWithheld : false,
        ...takerDraft(taker),
      };
    });
  return (
    <form className="ui-form fiscal-issuance-form" onSubmit={submit} aria-busy={busy} noValidate>
      <div className="fiscal-form-head">
        <h2 className="fiscal-form-title">
          {correction ? "Corrigir e emitir de novo" : "Nova emissão"}
        </h2>
        <p className="ui-help">
          Todos os campos são obrigatórios, exceto os indicados como opcionais.
        </p>
      </div>
      {refused.length && !busy ? (
        <Callout
          tone="danger"
          title={
            refused.length === 1
              ? "Confira 1 campo antes de pedir"
              : `Confira ${refused.length} campos antes de pedir`
          }
        >
          <ul className="fiscal-error-summary">
            {refused.map(([field, id, label]) => (
              <li key={field}>
                <a
                  className="ui-link"
                  href={`#${id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    setFocus({ field, n: (focus?.n ?? 0) + 1 });
                  }}
                >
                  {label}
                </a>
                {errors[field] ? (
                  <span className="fiscal-error-summary__why"> — {errors[field]}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {correction ? (
        <Callout tone="info">
          <p>
            Os campos vieram da emissão rejeitada {correction.label}. Corrija o que o fisco apontou
            e peça de novo: o pedido recebe outro número de DPS, e a emissão rejeitada continua
            registrada como está.
          </p>
        </Callout>
      ) : null}
      <Destination transport={transport} route={route} issueDate={draft.issueDate} />
      <Card>
        <fieldset className="fiscal-fieldset" disabled={busy}>
          <legend className="fiscal-legend">Serviço</legend>
          <div className="fiscal-form-grid">
            <Field id="issuance-activity" label="Atividade do perfil" error={errors.activityCode}>
              <Select
                id="issuance-activity"
                value={draft.activityCode}
                onChange={(e) => {
                  const activity = profile.activities.find((a) => a.code === e.target.value);
                  setDraft((current) => ({
                    ...current,
                    activityCode: e.target.value,
                    description:
                      current.description.trim() || !activity?.description
                        ? current.description
                        : activity.description,
                  }));
                }}
                aria-invalid={errors.activityCode ? true : undefined}
                aria-describedby={describedBy("issuance-activity", errors.activityCode)}
              >
                {/* The placeholder is offered only while no activity of the profile is chosen;
                    a code outside the list keeps it, so the field never shows a choice it lacks. */}
                {!profile.activities.some((a) => a.code === draft.activityCode) && (
                  <option value="">Selecione</option>
                )}
                {profile.activities.map((activity) => (
                  <option key={activity.code} value={activity.code}>
                    {activity.label} · {activity.code}
                  </option>
                ))}
              </Select>
            </Field>
            {input("issuance-date", "issueDate", draft.issueDate, (v) => set("issueDate", v), {
              label: "Data da emissão",
              type: "date",
              required: true,
              help: `Data civil de Brasília, até ${formatIsoDate(today)}.`,
            })}
            {input(
              "issuance-competence",
              "competence",
              draft.competence,
              (v) => set("competence", v),
              {
                label: "Competência",
                type: "month",
                required: true,
                preview: /^\d{4}-\d{2}$/.test(draft.competence)
                  ? `Competência: ${formatCompetenceLong(draft.competence)}`
                  : "Escolha o mês da prestação.",
                help: "Mês da prestação; não pode ser posterior ao mês da emissão.",
              },
            )}
            {input(
              "issuance-issuer-email",
              "issuerEmail",
              draft.issuerEmail,
              (v) => set("issuerEmail", v),
              {
                label: "E-mail do prestador",
                type: "email",
                inputMode: "email",
                max: 80,
                required: !profile.issuerEmail,
                placeholder: profile.issuerEmail ?? undefined,
                help: profile.issuerEmail
                  ? `Opcional. Vai na DPS; em branco, usa o do perfil (${profile.issuerEmail}).`
                  : "Vai na DPS. Cadastre um no perfil de emissão para não repetir aqui.",
              },
            )}
          </div>
          <Field
            id="issuance-description"
            label="Descrição do serviço"
            error={errors.description}
            help={descriptionHelp}
          >
            <Textarea
              id="issuance-description"
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              maxLength={2000}
              rows={4}
              required
              aria-invalid={errors.description ? true : undefined}
              aria-describedby={describedBy("issuance-description", errors.description, "help")}
            />
          </Field>
        </fieldset>
      </Card>
      <Card>
        <fieldset className="fiscal-fieldset" disabled={busy}>
          <legend className="fiscal-legend">Mercado e tomador</legend>
          <FrequentTakers scope={scope} onPick={pickTaker} />
          <div className="ui-choice-group" role="radiogroup" aria-label="Mercado">
            {(
              [
                ["domestic", "Mercado interno", "Tomador no Brasil, valor em reais."],
                [
                  "export",
                  "Exportação de serviço",
                  "Tomador no exterior, moeda estrangeira, sem ISS.",
                ],
              ] as const
            ).map(([value, label, help]) => (
              <RadioCard
                key={value}
                id={`issuance-market-${value}`}
                name="issuance-market"
                value={value}
                label={label}
                help={help}
                checked={draft.market === value}
                onChange={() =>
                  setDraft((current) => ({
                    ...current,
                    market: value,
                    currency: value === "domestic" ? "BRL" : "USD",
                    issRate: value === "domestic" ? current.issRate : "",
                    issWithheld: false,
                  }))
                }
              />
            ))}
          </div>
          {draft.market === "domestic" ? (
            <div className="fiscal-form-grid">
              {input(
                "taker-document",
                "taker.document",
                n.document,
                (v) => setTaker("national", "document", v),
                {
                  label: "CPF ou CNPJ do tomador",
                  max: 18,
                  required: true,
                  help: "CNPJ alfanumérico aceita letras.",
                },
              )}
              {input("taker-name", "taker.name", n.name, (v) => setTaker("national", "name", v), {
                label: "Nome ou razão social",
                max: 300,
                required: true,
              })}
              {input(
                "taker-email",
                "taker.email",
                n.email,
                (v) => setTaker("national", "email", v),
                {
                  label: "E-mail do tomador (opcional)",
                  type: "email",
                  inputMode: "email",
                  max: 80,
                },
              )}
            </div>
          ) : null}
          {draft.market === "domestic" ? (
            <fieldset className="fiscal-subfieldset">
              <legend className="fiscal-sublegend">Endereço do tomador</legend>
              <div className="fiscal-form-grid">
                <MunicipalitySearch
                  scope={scope}
                  code={n.municipalityCode}
                  onPick={(code) => setTaker("national", "municipalityCode", code)}
                />
                {input(
                  "taker-municipality",
                  "taker.address.municipalityCode",
                  n.municipalityCode,
                  (v) => setTaker("national", "municipalityCode", v),
                  {
                    label: "Código IBGE do município",
                    max: 7,
                    inputMode: "numeric",
                    required: true,
                    preview: <MunicipalityName scope={scope} code={n.municipalityCode} />,
                    help: "Preenchido pela busca ao lado, ou digite os 7 dígitos.",
                  },
                )}
                {input(
                  "taker-postal",
                  "taker.address.postalCode",
                  n.postalCode,
                  (v) => setTaker("national", "postalCode", v),
                  { label: "CEP", max: 9, inputMode: "numeric", required: true },
                )}
                {input(
                  "taker-street",
                  "taker.address.street",
                  n.street,
                  (v) => setTaker("national", "street", v),
                  {
                    label: "Logradouro",
                    max: 255,
                    required: true,
                  },
                )}
                {input(
                  "taker-number",
                  "taker.address.number",
                  n.number,
                  (v) => setTaker("national", "number", v),
                  {
                    label: "Número",
                    max: 60,
                    required: true,
                  },
                )}
                {input(
                  "taker-district",
                  "taker.address.district",
                  n.district,
                  (v) => setTaker("national", "district", v),
                  { label: "Bairro", max: 60, required: true },
                )}
              </div>
            </fieldset>
          ) : (
            <>
              <div
                className="fiscal-question"
                role="radiogroup"
                aria-labelledby="taker-nif-question"
                aria-describedby={
                  f.nifChoice === "" && errors["taker.nif"] ? "taker-nif-choice-error" : undefined
                }
              >
                <p id="taker-nif-question" className="ui-label">
                  O tomador tem NIF?
                </p>
                <p className="ui-help">
                  NIF é o número de identificação fiscal no país do tomador, como o EIN nos Estados
                  Unidos.
                </p>
                <div className="ui-choice-group fiscal-choice-pair">
                  {(
                    [
                      ["nif", "taker-nif-yes", "Tem NIF"],
                      ["absent", "taker-nif-no", "Não tem NIF"],
                    ] as const
                  ).map(([choice, id, label]) => (
                    <RadioCard
                      key={choice}
                      id={id}
                      name="taker-nif-choice"
                      label={label}
                      checked={f.nifChoice === choice}
                      onChange={() => nifChoice(choice)}
                    />
                  ))}
                </div>
                {f.nifChoice === "" && errors["taker.nif"] && (
                  <p id="taker-nif-choice-error" className="ui-error-text" role="alert">
                    <Icon name="danger" />
                    <span>{errors["taker.nif"]}</span>
                  </p>
                )}
              </div>
              <div className="fiscal-form-grid">
                {f.nifChoice === "nif" &&
                  input("taker-nif", "taker.nif", f.nif, (v) => setTaker("foreign", "nif", v), {
                    label: "NIF do tomador",
                    max: 40,
                    required: true,
                    help: "O número, como aparece no cadastro fiscal do tomador.",
                  })}
                {f.nifChoice === "absent" && (
                  <Field
                    id="taker-nif-absence"
                    label="Motivo da ausência do NIF"
                    error={errors["taker.nifAbsence"] ?? errors["taker.nif"]}
                  >
                    <Select
                      id="taker-nif-absence"
                      value={f.nifAbsence}
                      onChange={(e) => setTaker("foreign", "nifAbsence", e.target.value)}
                      required
                      aria-invalid={
                        errors["taker.nifAbsence"] || errors["taker.nif"] ? true : undefined
                      }
                      aria-describedby={describedBy(
                        "taker-nif-absence",
                        errors["taker.nifAbsence"] ?? errors["taker.nif"],
                      )}
                    >
                      <option value="">Selecione</option>
                      <option value="1">Dispensado do NIF</option>
                      <option value="2">Não exigência do NIF</option>
                    </Select>
                  </Field>
                )}
                {input("taker-name", "taker.name", f.name, (v) => setTaker("foreign", "name", v), {
                  label: "Nome ou razão social",
                  max: 300,
                  required: true,
                })}
                {input(
                  "taker-email",
                  "taker.email",
                  f.email,
                  (v) => setTaker("foreign", "email", v),
                  {
                    label: "E-mail do tomador (opcional)",
                    type: "email",
                    inputMode: "email",
                    max: 80,
                  },
                )}
              </div>
              <fieldset className="fiscal-subfieldset">
                <legend className="fiscal-sublegend">Endereço do tomador</legend>
                <div className="fiscal-form-grid">
                  {input(
                    "taker-country",
                    "taker.address.country",
                    f.country,
                    (v) => setTaker("foreign", "country", v),
                    {
                      label: "País (código ISO)",
                      max: 2,
                      required: true,
                      help: "Duas letras, como US.",
                    },
                  )}
                  {input(
                    "taker-city",
                    "taker.address.city",
                    f.city,
                    (v) => setTaker("foreign", "city", v),
                    {
                      label: "Cidade",
                      max: 60,
                      required: true,
                    },
                  )}
                  {input(
                    "taker-postal",
                    "taker.address.postalCode",
                    f.postalCode,
                    (v) => setTaker("foreign", "postalCode", v),
                    { label: "Código postal", max: 11, required: true },
                  )}
                  {input(
                    "taker-state",
                    "taker.address.state",
                    f.state,
                    (v) => setTaker("foreign", "state", v),
                    {
                      label: "Estado, província ou região",
                      max: 60,
                      required: true,
                    },
                  )}
                  {input(
                    "taker-street",
                    "taker.address.street",
                    f.street,
                    (v) => setTaker("foreign", "street", v),
                    {
                      label: "Logradouro",
                      max: 255,
                      required: true,
                    },
                  )}
                  {input(
                    "taker-number",
                    "taker.address.number",
                    f.number,
                    (v) => setTaker("foreign", "number", v),
                    {
                      label: "Número",
                      max: 60,
                      required: true,
                    },
                  )}
                  {input(
                    "taker-district",
                    "taker.address.district",
                    f.district,
                    (v) => setTaker("foreign", "district", v),
                    {
                      label: "Bairro",
                      max: 60,
                      required: true,
                      help: "Sem bairro no endereço do exterior, informe a região ou o distrito, ou N/A.",
                    },
                  )}
                </div>
              </fieldset>
            </>
          )}
        </fieldset>
      </Card>
      <Card>
        <fieldset className="fiscal-fieldset" disabled={busy}>
          <legend className="fiscal-legend">Valores e ISS</legend>
          <div className="fiscal-form-grid">
            <Field id="issuance-currency" label="Moeda" error={errors["amount.currency"]}>
              <Select
                id="issuance-currency"
                value={draft.currency}
                disabled={draft.market === "domestic"}
                onChange={(e) => set("currency", e.target.value as Currency)}
                aria-invalid={errors["amount.currency"] ? true : undefined}
                aria-describedby={describedBy("issuance-currency", errors["amount.currency"])}
              >
                {draft.market === "domestic" ? (
                  <option value="BRL">Real (BRL)</option>
                ) : (
                  foreignCurrencies.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))
                )}
              </Select>
            </Field>
            {input("issuance-value", "amount.value", draft.value, (v) => set("value", v), {
              label: "Valor do serviço",
              inputMode: "decimal",
              max: 20,
              required: true,
              preview: valuePreview(draft),
              help:
                draft.market === "export"
                  ? `Na moeda escolhida, com vírgula para os centavos. Em reais, a nota usa a PTAX de venda do dia útil anterior a ${formatIsoDate(draft.issueDate)}, congelada na primeira tentativa de envio.`
                  : "Use vírgula para os centavos, como 1500,00.",
            })}
            {showRate &&
              input("issuance-rate", "issRate", draft.issRate, (v) => set("issRate", v), {
                label: "Alíquota do ISS (%)",
                inputMode: "decimal",
                max: 6,
                required: true,
                help: "Da competência, de 0,01 a 5, com até duas casas.",
                preview: issPreview(draft),
              })}
          </div>
          {draft.market === "domestic" ? (
            <div className="ui-field">
              <Checkbox
                id="issuance-withheld"
                label="ISS retido pelo tomador"
                checked={draft.issWithheld}
                disabled={!withholdingPossible && !draft.issWithheld}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    issWithheld: e.target.checked,
                    issRate: e.target.checked || !simples ? current.issRate : "",
                  }))
                }
                aria-invalid={errors.issWithheld ? true : undefined}
                aria-describedby={
                  errors.issWithheld
                    ? "issuance-withheld-help issuance-withheld-error"
                    : "issuance-withheld-help"
                }
              />
              <p id="issuance-withheld-help" className="ui-help">
                {withholdingPossible
                  ? "A retenção exige a alíquota do ISS."
                  : "Disponível para tomador com CNPJ."}{" "}
                {simples && !draft.issWithheld && !showRate
                  ? "Optante do Simples Nacional sem retenção não informa alíquota na DPS."
                  : ""}
              </p>
              {errors.issWithheld && (
                <p id="issuance-withheld-error" className="ui-error-text" role="alert">
                  <Icon name="danger" />
                  <span>{errors.issWithheld}</span>
                </p>
              )}
            </div>
          ) : (
            <p className="ui-help">
              Exportação de serviço: não incide ISS (LC 116/2003, art. 2º, I), sem alíquota nem
              retenção.
            </p>
          )}
        </fieldset>
      </Card>
      <div className="fiscal-submit">
        <div className="ui-actions">
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            loadingLabel="Enviando pedido…"
            disabled={busy}
            aria-describedby={
              [
                busy || failure ? "issuance-submit-reason" : "",
                productionClosed ? "issuance-production-closed" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
          >
            {/* In fiscal production the form only reviews; the dialog's "Pedir emissão" sends. */}
            {production ? "Revisar pedido" : "Pedir emissão"}
          </Button>
          {/* "Descartar", not "Cancelar": cancelling is the fiscal event of an authorized NFS-e. */}
          <Button disabled={busy} onClick={onCancel}>
            Descartar
          </Button>
        </div>
        {productionClosed ? (
          <p id="issuance-production-closed" className="ui-help">
            {productionClosedNote}
          </p>
        ) : null}
        {busy ? (
          <p id="issuance-submit-reason" className="ui-help" role="status">
            Aguardando o servidor aceitar o pedido. Enviar de novo repete a mesma tentativa, sem
            emitir duas vezes.
          </p>
        ) : failure ? (
          <p
            id="issuance-submit-reason"
            ref={reasonRef}
            tabIndex={-1}
            className="ui-error-text fiscal-submit-reason"
            role="alert"
          >
            <Icon name="danger" />
            <span>{failure}</span>
          </p>
        ) : null}
      </div>
      {production && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Emitir NFS-e em produção?"
          description="A nota vai ao fisco e, autorizada, tem validade fiscal. Depois disso, só um cancelamento a desfaz."
          confirmLabel="Pedir emissão"
          cancelLabel="Revisar"
          tone="primary"
          // The second click of a double click, or the second tap, never decides for the person.
          settleMs={350}
          onConfirm={async () => {
            // Closes first: the form shows the wait and any refusal next to its fields.
            setConfirming(false);
            void send();
            return "";
          }}
        >
          <ProductionSummary {...productionSummary(draft, route)} />
        </ConfirmDialog>
      )}
      {production ? (
        <p className="ui-help">
          Em produção fiscal, nada é enviado antes da confirmação: "Revisar pedido" mostra o resumo,
          e só "Pedir emissão" no resumo envia. Aceito pelo servidor, o pedido é transmitido em
          seguida, e a nota só aparece como autorizada quando a resposta do fisco for registrada.
        </p>
      ) : (
        <p className="ui-help">
          O pedido é aceito pelo servidor e transmitido em seguida. A nota só aparece como
          autorizada quando a resposta {simulated ? "do simulador" : "do fisco"} for registrada.
        </p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Takers of the company's previous issuances; the municipality search lives in `municipality.tsx`.
// Both only fill fields; the server checks the request again.

const formatTakerDocument = (document: string) =>
  document.length === 11
    ? document.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4")
    : document.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, "$1.$2.$3/$4-$5");
/** Takers of the company's previous issuances; choosing one fills the taker fields. */
export function FrequentTakers({
  scope,
  onPick,
}: {
  scope: IssuanceScope;
  onPick: (taker: Taker) => void;
}) {
  const takers = useQuery(api.issuanceConsole.recentTakers, scope);
  const [chosen, setChosen] = useState("");
  if (!takers?.length) return null;
  return (
    <div className="ui-field">
      <label className="ui-label" htmlFor="issuance-frequent-taker">
        Tomador de emissões anteriores (opcional)
      </label>
      <Select
        id="issuance-frequent-taker"
        value={chosen}
        aria-describedby="issuance-frequent-taker-help"
        onChange={(e) => {
          setChosen(e.target.value);
          const taker = takers[Number(e.target.value)]?.taker;
          if (e.target.value && taker) onPick(taker);
        }}
      >
        <option value="">Preencher à mão</option>
        {takers.map(({ taker }, index) => (
          <option key={index} value={index}>
            {taker.name} ·{" "}
            {taker.kind === "national"
              ? formatTakerDocument(taker.document)
              : `${taker.nif ? `NIF ${taker.nif}` : "sem NIF"}, ${taker.address.country}`}
          </option>
        ))}
      </Select>
      <p id="issuance-frequent-taker-help" className="ui-help">
        Preenche o tomador com os dados da última emissão para ele nesta empresa. Confira antes de
        pedir.
      </p>
    </div>
  );
}
