import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { normalizeCnpj, type CompanyAddress } from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { Organization } from "./organizations";
import { useQuery } from "./convex-query";
import { ErrorSummary, controlProps } from "./field";
import { ErrorBoundary } from "./route-errors";
import { UsageGuidance } from "./usage-errors";
import { formatCep, formatDate, formatDateTime } from "./format";
import { companyMessages, errorCode, errorText } from "./company-feedback";
import {
  CREATE_ANCHOR,
  CompanyFields,
  companyErrors,
  companyFieldOrder,
  emptyCompany,
  focusCreate,
  useCompanyForm,
  type CompanyValues,
} from "./company-form";
import {
  Button,
  Callout,
  Card,
  Checkbox,
  DescriptionList,
  FormField,
  Input,
  buttonClass,
} from "./ui";

// Registration starts with the CNPJ (#511): the lookup fills name and address for review, each
// field chosen by the person; the manual fill is always one click away. Consulted data lives only
// in this component's state, never in the address bar or the browser's storage.
//
// Each field shows either the consulted value, while its box is ticked and the reviewed lookup
// still applies, or what the person typed (possibly nothing). There is no third state, so text
// from the source is saved as typed only after the person edits it.

type Preview = FunctionReturnType<typeof api.registry.lookupStatus>;
type State = Preview["state"];
/** `failed`: the query failed for another reason; `gone`: the lookup no longer exists for us. */
type Notice = State | "failed" | "gone";
type Field = "name" | "address";
const fieldsOf: Field[] = ["name", "address"];

const stateCopy: Record<
  Notice,
  { title: string; body?: string; tone: "info" | "warning"; retry?: boolean }
> = {
  pending: {
    tone: "info",
    title: "Consultando o CNPJ na fonte…",
    body: "Os dados aparecem aqui assim que a fonte responder. Se preferir, preencha manualmente.",
  },
  found: { tone: "info", title: "Cadastro encontrado. Revise os dados antes de salvar." },
  not_found: {
    tone: "warning",
    title: "CNPJ não encontrado na base da fonte.",
    body: "Cadastros recentes podem ainda não constar na base publicada. Preencha os dados manualmente.",
  },
  unavailable: {
    tone: "warning",
    title: "Não foi possível obter os dados deste CNPJ agora.",
    body: "Consulte novamente em alguns minutos ou preencha os dados manualmente.",
    retry: true,
  },
  unsupported_format: {
    tone: "info",
    title: "A fonte ainda não consulta este formato de CNPJ.",
    body: "O cadastro aceita o CNPJ alfanumérico: preencha os dados manualmente.",
  },
  quota: {
    tone: "warning",
    title: "A consulta cadastral atingiu o limite do plano.",
    body: "O cadastro não depende da consulta: preencha os dados manualmente.",
  },
  expired: {
    tone: "warning",
    title: "Os dados desta consulta venceram.",
    body: "Consulte novamente para revisar dados atuais ou preencha os dados manualmente.",
    retry: true,
  },
  gone: {
    tone: "warning",
    title: "Esta consulta não está mais disponível.",
    body: "Consulte novamente ou preencha os dados manualmente.",
    retry: true,
  },
  failed: {
    tone: "warning",
    title: "Não foi possível acompanhar esta consulta.",
    body: "Consulte novamente ou preencha os dados manualmente.",
    retry: true,
  },
};
/** States after which the consulted values under review no longer apply. */
const voids: Notice[] = [
  "not_found",
  "unavailable",
  "unsupported_format",
  "quota",
  "expired",
  "gone",
];
const addressLine = (a: CompanyAddress) =>
  `${a.street}, ${a.number}${a.complement ? `, ${a.complement}` : ""} · ${a.district} · ${a.city}/${a.state} · CEP ${formatCep(a.postalCode)}`;
const addressKeys = Object.keys(emptyCompany().address) as Array<keyof CompanyAddress>;
/** The CNPJ's letters and digits, without punctuation: formatting alone does not change it. */
const cnpjKey = (value: string) => value.replace(/[^0-9a-z]/gi, "").toUpperCase();
const existingText =
  "Empresa já cadastrada nesta organização. Os dados existentes foram preservados.";
const incompleteText = "A fonte devolveu um endereço incompleto. Preencha o endereço manualmente.";
/** The consulted address passes the same checks as a typed one. */
const completeAddress = (data: CompanyValues) =>
  !Object.keys(companyErrors(data)).some((key) => key !== "company-name" && key !== "company-cnpj");

/** One state of the lookup, reported to the form, which announces it and reacts to it. */
function StateNotice({
  state,
  org,
  report,
  actions,
}: {
  state: Notice;
  org: Organization;
  report: (state: Notice) => void;
  actions: (retry: boolean) => ReactNode;
}) {
  const copy = stateCopy[state];
  useEffect(() => report(state), [report, state]);
  if (state === "found") return null;
  return (
    <Callout tone={copy.tone} title={copy.title} actions={actions(copy.retry ?? false)}>
      {state === "quota" ? (
        <>
          <UsageGuidance code="QUOTA_EXCEEDED" org={org} />{" "}
        </>
      ) : null}
      {copy.body}
    </Callout>
  );
}
/**
 * The lookup's query failed. The server deletes a lookup 24 hours after it was made, and its id
 * then reads as denied, as would a lost permission: both say the lookup is no longer available.
 * Any other failure only offers a new lookup.
 */
function LookupLost({ error, ...notice }: { error: unknown } & NoticeProps) {
  const gone = ["ACCESS_DENIED", "NOT_FOUND"].includes(errorCode(error));
  return <StateNotice state={gone ? "gone" : "failed"} {...notice} />;
}
type NoticeProps = {
  org: Organization;
  report: (state: Notice) => void;
  actions: (retry: boolean) => ReactNode;
};
/** Live state of the lookup. */
function LookupState({
  lookupId,
  onFound,
  ...notice
}: NoticeProps & {
  lookupId: Id<"registryLookups">;
  onFound: (preview: Preview) => void;
}) {
  const preview = useQuery(api.registry.lookupStatus, {
    organizationId: notice.org.id,
    lookupId,
  });
  useEffect(() => {
    if (preview?.state === "found") onFound(preview);
  }, [preview, onFound]);
  return <StateNotice state={preview?.state ?? "pending"} {...notice} />;
}

export function CreateCompany({
  org,
  headingRef,
  onCancel,
}: {
  org: Organization;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onCancel: () => void;
}) {
  const create = useMutation(api.companies.create),
    lookup = useMutation(api.registry.lookup),
    navigate = useNavigate();
  const form = useCompanyForm();
  const [cnpj, setCnpj] = useState("");
  const [manual, setManual] = useState(false);
  const [consulting, setConsulting] = useState(false);
  const [lookupId, setLookupId] = useState<Id<"registryLookups"> | null>(null);
  const [liveState, setLiveState] = useState<Notice | null>(null);
  const [lookupError, setLookupError] = useState<{ text: string; retry: boolean } | null>(null);
  const [existingCompanyId, setExistingCompanyId] = useState<Id<"companies"> | null>(null);
  /** What the person typed; a field without a ticked, current consulted value shows this. */
  const [typed, setTyped] = useState(emptyCompany);
  const [use, setUse] = useState<Record<Field, boolean>>({ name: false, address: false });
  /** The found answer under review: its values fill the ticked fields and go with its version. */
  const [reviewed, setReviewed] = useState<Preview | null>(null);
  /** Why the consulted values left the fields, shown until the next lookup. */
  const [reverted, setReverted] = useState("");
  const [notice, setNotice] = useState("");
  /** Key of the attempt without a definitive answer: retrying it returns the same lookup. */
  const attempt = useRef<{ cnpj: string; key: string } | null>(null);
  /** The CNPJ in the field now: an answer for another CNPJ is ignored. */
  const currentCnpj = useRef("");
  const existingRef = useRef<HTMLDivElement>(null);
  /** Lookups whose answer stopped applying: their live answer is not reviewed again. */
  const voided = useRef(new Set<string>());
  /** The lookup on screen and the CNPJ it was made for. */
  const lookupRef = useRef<{ id: string | null; cnpj: string }>({ id: null, cnpj: "" });
  lookupRef.current.id = lookupId;
  /**
   * Address subfields copied from the consulted address when the person edited one of them,
   * with what was typed before: they leave with the lookup, the edited ones stay.
   */
  const copied = useRef<{ before: CompanyAddress; keys: Set<keyof CompanyAddress> } | null>(null);
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);
  // The form only exists once asked for, by the button or by the first steps' link.
  useEffect(() => focusCreate(headingRef.current), [headingRef]);

  const data = reviewed?.data ?? null;
  const active = (field: Field) => use[field] && data !== null;
  const values: CompanyValues = {
    name: active("name") ? data!.name : typed.name,
    address: active("address") ? data!.address : typed.address,
  };

  /**
   * The consulted values stop applying: every ticked field goes back to what was typed, said
   * visibly with `reason`.
   */
  function revert(reason = "") {
    const ticked = fieldsOf.some(active);
    const from = copied.current;
    copied.current = null;
    if (from)
      setTyped((t) => {
        const address = { ...t.address };
        for (const key of from.keys) address[key] = from.before[key];
        return { ...t, address };
      });
    if (reviewed) voided.current.add(reviewed.lookupId);
    // The review block leaves: a focus on its boxes goes to the CNPJ field.
    if (fieldsetRef.current?.contains(document.activeElement))
      document.getElementById("company-cnpj")?.focus();
    setReviewed(null);
    setUse((u) => (u.name || u.address ? { name: false, address: false } : u));
    if ((ticked || from) && reason) {
      setReverted(reason);
      setNotice(`${reason} Os campos voltaram ao que você digitou.`);
    }
  }
  const report = useCallback((state: Notice) => {
    setLiveState(state);
    // A voided lookup that reads found again is not offered for review: nothing to announce.
    const id = lookupRef.current.id;
    if (state === "found" && id && voided.current.has(id)) return;
    setNotice(stateCopy[state].title);
  }, []);
  // A state that voids the answer under review (expired, deleted, or a newer lookup that found
  // nothing) puts the typed values back.
  useEffect(() => {
    if (liveState && voids.includes(liveState) && reviewed)
      revert("Os dados consultados deixaram de valer.");
  });

  function showManual() {
    setManual(true);
    requestAnimationFrame(() => document.getElementById("company-name")?.focus());
  }
  async function consult() {
    if (consulting) return;
    const normalized = normalizeCnpj(cnpj);
    if (!normalized)
      return form.refuse({
        "company-cnpj": cnpj.trim() ? companyMessages.INVALID_CNPJ! : "Informe o CNPJ da empresa.",
      });
    form.clear();
    if (attempt.current?.cnpj !== normalized)
      attempt.current = { cnpj: normalized, key: crypto.randomUUID() };
    setConsulting(true);
    setLookupError(null);
    setExistingCompanyId(null);
    setReverted("");
    setLookupId(null);
    setLiveState(null);
    setNotice("");
    lookupRef.current.cnpj = cnpjKey(normalized);
    const stale = () => cnpjKey(currentCnpj.current) !== cnpjKey(normalized);
    try {
      const result = await lookup({ organizationId: org.id, cnpj, key: attempt.current.key });
      attempt.current = null;
      if (stale()) return;
      if (result.kind === "existing") {
        revert();
        setExistingCompanyId(result.companyId);
        setNotice(existingText);
      } else setLookupId(result.lookupId);
    } catch (error) {
      // A server refusal ends the attempt; a lost answer keeps its key for the retry.
      const lost = !(error instanceof ConvexError);
      if (!lost) attempt.current = null;
      if (stale()) return;
      revert("A nova consulta não foi concluída.");
      const code = errorCode(error);
      if (code === "INVALID_CNPJ") form.refuse({ "company-cnpj": companyMessages.INVALID_CNPJ! });
      else
        setLookupError({
          retry: lost,
          text:
            code === "RATE_LIMITED"
              ? "Muitas consultas em pouco tempo. Aguarde um minuto para consultar de novo ou preencha os dados manualmente."
              : lost
                ? "Não foi possível confirmar a consulta. Consultar de novo retoma a mesma solicitação, sem nova cobrança."
                : errorText(error),
        });
    } finally {
      setConsulting(false);
    }
  }
  /**
   * The consulting buttons are disabled while consulting, and retry buttons leave with their
   * notice: the focus goes to the CNPJ field first.
   */
  function consultAgain() {
    document.getElementById("company-cnpj")?.focus();
    void consult();
  }
  /**
   * Ticks the fields with nothing typed (or already showing consulted values); a typed value stays
   * until the person ticks its box. An incomplete consulted address is never ticked by itself.
   * Once per lookup: a later version of the cache is not applied silently.
   */
  function review(found: Preview) {
    if (!found.data || reviewed?.lookupId === found.lookupId || voided.current.has(found.lookupId))
      return;
    const take = {
      name: active("name") || !typed.name.trim(),
      address:
        completeAddress(found.data) &&
        (active("address") || Object.values(typed.address).every((text) => !text.trim())),
    };
    setUse(take);
    setReviewed(found);
    setManual(true);
    if (!completeAddress(found.data)) setNotice(`${stateCopy.found.title} ${incompleteText}`);
  }
  function choose(field: Field, checked: boolean) {
    setUse((u) => ({ ...u, [field]: checked }));
  }
  function edit(key: "name" | keyof CompanyAddress, value: string) {
    const field: Field = key === "name" ? "name" : "address";
    // The edited text, over what the field showed, becomes the person's own value. Editing one
    // subfield of the consulted address copies the others, remembered as copied.
    const consulted = key !== "name" && active("address") ? data!.address : null;
    if (key !== "name") {
      if (consulted) {
        // A second copy (re-ticked, edited again) keeps what the person had typed before the
        // first one: subfields still marked as copied hold source text, not their own.
        const earlier = copied.current;
        const before = { ...typed.address };
        for (const other of earlier?.keys ?? []) before[other] = earlier!.before[other];
        copied.current = {
          before,
          keys: new Set(addressKeys.filter((other) => other !== key)),
        };
      } else copied.current?.keys.delete(key);
    }
    setTyped((t) =>
      key === "name"
        ? { ...t, name: value }
        : { ...t, address: { ...(consulted ?? t.address), [key]: value } },
    );
    if (active(field)) {
      setUse((u) => ({ ...u, [field]: false }));
      setNotice(
        `${field === "name" ? "Nome alterado" : "Endereço alterado"}: será salvo como valor digitado, sem a origem da consulta.`,
      );
    }
  }
  function changeCnpj(value: string) {
    setCnpj(value);
    currentCnpj.current = value;
    // Punctuation alone keeps the CNPJ, its lookup and what was consulted.
    if (cnpjKey(value) === lookupRef.current.cnpj && (lookupId || reviewed || existingCompanyId))
      return;
    revert("O CNPJ mudou e os dados consultados deixaram de valer.");
    setLookupId(null);
    setLiveState(null);
    setExistingCompanyId(null);
    setLookupError(null);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (form.busy || consulting || awaiting) return;
    if (!manual) return void consult();
    setExistingCompanyId(null);
    setReverted("");
    const input = { cnpj, ...values };
    const found = companyErrors(input);
    if (Object.keys(found).length) return form.refuse(found);
    const fields = fieldsOf.filter(active);
    const registry =
      reviewed && reviewed.cacheVersion !== null && fields.length
        ? { lookupId: reviewed.lookupId, expectedCacheVersion: reviewed.cacheVersion, fields }
        : undefined;
    form.clear();
    form.setBusy(true);
    try {
      const result = await create({
        organizationId: org.id,
        ...input,
        ...(registry && { registry }),
      });
      if (result.reused) {
        setExistingCompanyId(result.companyId);
        setNotice(existingText);
        // The save button leaves; the focus goes to the company that already exists.
        requestAnimationFrame(() => existingRef.current?.querySelector("a")?.focus());
        return;
      }
      await navigate({
        to: "/app/$organizationSlug/companies/$companyId",
        params: { organizationSlug: org.slug, companyId: result.companyId },
      });
    } catch (error) {
      const code = errorCode(error);
      // A lookup deleted after 24 hours reads as denied: the same way out as a changed cache.
      if (registry && (code === "REGISTRY_CHANGED" || code === "ACCESS_DENIED"))
        revert("Os dados consultados mudaram ou venceram. Nada foi salvo.");
      else if (
        registry?.fields.includes("address") &&
        ["INVALID_ADDRESS", "INVALID_COMPANY"].includes(code)
      )
        form.refuse(
          {},
          "O endereço consultado está incompleto ou fora do padrão. Desmarque “Usar endereço” e complete os campos manualmente.",
        );
      else form.reject(error);
    } finally {
      form.setBusy(false);
    }
  }
  const retryButton = (
    <Button
      size="sm"
      icon="search"
      loading={consulting}
      loadingLabel="Consultando…"
      onClick={consultAgain}
    >
      Consultar novamente
    </Button>
  );
  const stateActions = (retry: boolean) => (
    <>
      {retry ? retryButton : null}
      {manual ? null : (
        <Button size="sm" onClick={showManual}>
          Preencher manualmente
        </Button>
      )}
    </>
  );
  // One "Preencher manualmente" at a time: the notice's, when there is one.
  const noticeShown = Boolean(lookupError) || (lookupId !== null && liveState !== "found");
  // A lookup still running would make a save send the previous one's version for nothing.
  const awaiting = lookupId !== null && (liveState === null || liveState === "pending");
  const noticeProps = { org, report, actions: stateActions };
  return (
    <Card
      id={CREATE_ANCHOR}
      title="Cadastrar uma empresa."
      titleRef={headingRef}
      description="Comece pelo CNPJ: a consulta preenche nome e endereço para você revisar. Um CNPJ já cadastrado abre a mesma empresa, preservando os dados existentes."
    >
      <form className="ui-form" onSubmit={submit} aria-busy={form.busy} noValidate>
        <ErrorSummary
          id="create-company-errors"
          title="A empresa não foi salva."
          errors={form.errors}
          fields={companyFieldOrder}
          general={form.general}
          focusKey={form.attempt}
        />
        <p className="ui-visually-hidden" role="status">
          {notice}
        </p>
        <div className="company-form-grid">
          <div data-span={2}>
            <FormField
              id="company-cnpj"
              label="CNPJ"
              error={form.errors["company-cnpj"]}
              help="Numérico ou alfanumérico, com ou sem pontuação."
            >
              <Input
                {...controlProps("company-cnpj", form.errors["company-cnpj"], true)}
                className="ui-mono"
                name="cnpj"
                value={cnpj}
                onChange={(event) => changeCnpj(event.target.value)}
                // Enter in the CNPJ always consults; saving is the button's.
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  void consult();
                }}
                readOnly={consulting}
                maxLength={18}
                disabled={form.busy}
                autoCapitalize="characters"
                autoComplete="off"
              />
            </FormField>
          </div>
          <div className="ui-actions">
            <Button
              icon="search"
              variant={manual ? "secondary" : "primary"}
              disabled={form.busy}
              loading={consulting}
              loadingLabel="Consultando…"
              onClick={consultAgain}
            >
              Consultar CNPJ
            </Button>
            {manual || noticeShown || existingCompanyId ? null : (
              <Button onClick={showManual}>Preencher manualmente</Button>
            )}
          </div>
        </div>
        {lookupError ? (
          <Callout tone="warning" role="alert" actions={stateActions(lookupError.retry)}>
            {lookupError.text}
          </Callout>
        ) : null}
        {lookupId ? (
          <ErrorBoundary
            resetKey={lookupId}
            fallback={(error) => <LookupLost error={error} {...noticeProps} />}
          >
            <LookupState lookupId={lookupId} onFound={review} {...noticeProps} />
          </ErrorBoundary>
        ) : null}
        {reverted ? (
          <Callout
            tone="warning"
            role="alert"
            title={reverted}
            actions={noticeShown ? null : retryButton}
          >
            Os campos voltaram ao que você digitou. Consulte o CNPJ novamente para usar os dados da
            fonte.
          </Callout>
        ) : null}
        {existingCompanyId && (
          <div ref={existingRef}>
            <Callout
              tone="info"
              actions={
                <Link
                  className={buttonClass({ size: "sm" })}
                  to="/app/$organizationSlug/companies/$companyId"
                  params={{ organizationSlug: org.slug, companyId: existingCompanyId }}
                >
                  Ver empresa cadastrada
                </Link>
              }
            >
              {existingText}
            </Callout>
          </div>
        )}
        {reviewed && data ? (
          <fieldset ref={fieldsetRef} className="company-plain-fieldset company-lookup">
            <legend className="ui-label">Dados consultados</legend>
            <DescriptionList
              items={[
                { term: "Razão social", value: data.name },
                { term: "Situação cadastral", value: data.status },
                { term: "Endereço", value: addressLine(data.address) },
              ]}
            />
            <p className="ui-help">
              Fonte:{" "}
              <a className="ui-link" href={reviewed.sourceUrl} target="_blank" rel="noreferrer">
                OpenCNPJ
              </a>
              {reviewed.consultedAt
                ? `, consultado em ${formatDateTime(reviewed.consultedAt)}`
                : ""}
              {reviewed.sourceUpdatedAt
                ? `; base da Receita Federal de ${formatDate(reviewed.sourceUpdatedAt)}`
                : ""}
              . Situação cadastral não comprova regularidade nem concede acesso fiscal.
            </p>
            {completeAddress(data) ? null : <Callout tone="warning">{incompleteText}</Callout>}
            <Checkbox
              checked={use.name}
              disabled={form.busy}
              onChange={(event) => choose("name", event.target.checked)}
              label="Usar nome"
              help="Preenche o nome da empresa com a razão social consultada. Desmarcar volta ao que você digitou."
            />
            <Checkbox
              checked={use.address}
              disabled={form.busy || !completeAddress(data)}
              onChange={(event) => choose("address", event.target.checked)}
              label="Usar endereço"
              help={
                completeAddress(data)
                  ? "Preenche o endereço com o consultado. Alterar um campo depois salva o endereço como digitado."
                  : "Indisponível: a fonte devolveu um endereço incompleto. Preencha o endereço manualmente."
              }
            />
          </fieldset>
        ) : null}
        {manual ? (
          <div className="company-form-grid">
            <CompanyFields
              values={values}
              onEdit={edit}
              disabled={form.busy}
              errors={form.errors}
            />
          </div>
        ) : null}
        <div className="company-form-footer">
          <p className="ui-help">
            Você pode começar sem certificado. O cadastro não concede acesso fiscal.
          </p>
          <div className="ui-actions">
            <Button disabled={form.busy} onClick={onCancel}>
              Cancelar
            </Button>
            {manual && !existingCompanyId ? (
              <Button
                type="submit"
                variant="primary"
                disabled={consulting || awaiting}
                loading={form.busy}
                loadingLabel="Salvando…"
              >
                Salvar empresa
              </Button>
            ) : null}
          </div>
        </div>
      </form>
    </Card>
  );
}
