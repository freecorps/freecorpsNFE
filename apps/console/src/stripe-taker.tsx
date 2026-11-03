import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import { splitStreet } from "../../../platform/convex/lib/stripeAddress";
import type { Organization } from "./organizations";
import { Feedback } from "./project-sections";
import { takerDocumentOf } from "./issuance-draft";
import { useAsyncAction } from "./async-action";
import { MunicipalityName, MunicipalitySearch, type IssuanceScope } from "./municipality";
import { Button } from "./ui/button";
import { Checkbox, FormField, Input, Select, controlProps } from "./ui/form";
import { Card } from "./ui/layout";
import { stripeError, type Config, type Connection, type StripeEvent } from "./stripe-shared";

// Completing the taker of an event held for missing data; it replaces what Stripe sent for this
// charge only.

export type Taker = FunctionArgs<typeof api.stripe.completeEvent>["taker"];

export type TakerDraft = {
  kind: "national" | "foreign";
  document: string;
  nif: string;
  nifAbsence: "" | "1" | "2";
  name: string;
  email: string;
  municipalityCode: string;
  country: string;
  city: string;
  state: string;
  postalCode: string;
  street: string;
  number: string;
  district: string;
};
/** Prefill from what a person already completed, or from what Stripe sent. */
export function takerDraftOf(
  event: Pick<StripeEvent, "charge" | "taker">,
  market: Config["market"],
): TakerDraft {
  const t = event.taker;
  if (t)
    return t.kind === "national"
      ? {
          kind: "national",
          document: t.document,
          nif: "",
          nifAbsence: "",
          name: t.name,
          email: t.email ?? "",
          municipalityCode: t.address.municipalityCode,
          country: "BR",
          city: "",
          state: "",
          postalCode: t.address.postalCode,
          street: t.address.street,
          number: t.address.number,
          district: t.address.district,
        }
      : {
          kind: "foreign",
          document: "",
          nif: t.nif ?? "",
          nifAbsence: t.nifAbsence ? (String(t.nifAbsence) as "1" | "2") : "",
          name: t.name,
          email: t.email ?? "",
          municipalityCode: "",
          country: t.address.country,
          city: t.address.city,
          state: t.address.state ?? "",
          postalCode: t.address.postalCode ?? "",
          street: t.address.street ?? "",
          number: t.address.number ?? "",
          district: t.address.district ?? "",
        };
  const c = event.charge?.customer;
  const country = c?.country ?? "";
  const kind =
    market === "domestic" ||
    (market === "both" && (country === "BR" || !country)) ||
    country === "BR"
      ? "national"
      : "foreign";
  // Without a number in the line, the person completes it; the automatic request writes "S/N".
  const { street, number } = splitStreet(c?.line1 ?? "", "");
  return {
    kind,
    document: c?.taxIds.find((x) => x.type === "br_cpf" || x.type === "br_cnpj")?.value ?? "",
    nif: c?.taxIds.find((x) => !x.type.startsWith("br_"))?.value ?? "",
    nifAbsence: "",
    name: c?.name ?? "",
    email: c?.email ?? "",
    municipalityCode: "",
    country: kind === "national" ? "BR" : country,
    city: c?.city ?? "",
    state: c?.state ?? "",
    postalCode: c?.postalCode ?? "",
    street,
    number,
    district: c?.line2 ?? "",
  };
}
const clean = (value: string) => value.replace(/\s+/g, " ").trim();
export function takerOf(d: TakerDraft): Taker {
  const email = d.email.trim() ? { email: d.email.trim() } : {};
  if (d.kind === "national")
    return {
      kind: "national",
      document: takerDocumentOf(d.document),
      name: clean(d.name),
      ...email,
      address: {
        municipalityCode: d.municipalityCode.trim(),
        postalCode: d.postalCode.replace(/\D/g, ""),
        street: clean(d.street),
        number: clean(d.number),
        district: clean(d.district),
      },
    };
  return {
    kind: "foreign",
    ...(d.nif.trim()
      ? { nif: clean(d.nif) }
      : { nifAbsence: Number(d.nifAbsence || "2") as 1 | 2 }),
    name: clean(d.name),
    ...email,
    address: {
      country: d.country.trim().toUpperCase(),
      city: clean(d.city),
      postalCode: clean(d.postalCode),
      state: clean(d.state),
      street: clean(d.street),
      number: clean(d.number),
      district: clean(d.district),
    },
  };
}

export function TakerForm({
  org,
  connection,
  event,
  close,
}: {
  org: Organization;
  connection: Connection;
  event: StripeEvent;
  close: () => void;
}) {
  const complete = useMutation(api.stripe.completeEvent);
  const [draft, setDraft] = useState(() => takerDraftOf(event, connection.config.market));
  const { busy, error, run } = useAsyncAction(stripeError);
  const id = `stripe-taker-${event.id}`;
  // The municipality search reads only the company's reference tables; the environment is unused.
  const scope = {
    organizationId: org.id,
    companyId: connection.companyId,
    environment: "sandbox",
  } satisfies IssuanceScope;
  function set<K extends keyof TakerDraft>(key: K, value: TakerDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await run(() => complete({ eventId: event.id, taker: takerOf(draft) }), { done: close });
  }
  const field = (
    key: keyof TakerDraft,
    label: string,
    extra: Record<string, unknown> = {},
    help?: ReactNode,
  ) => (
    <FormField id={`${id}-${key}`} label={label} help={help}>
      <Input
        {...controlProps(`${id}-${key}`, undefined, help)}
        value={draft[key]}
        onChange={(e) => set(key, e.target.value as never)}
        {...extra}
      />
    </FormField>
  );
  const national = draft.kind === "national";
  return (
    <Card title="Completar dados do tomador" headingLevel={3} flat>
      <form className="ui-form" onSubmit={submit} aria-busy={busy}>
        <p className="gestao-help">
          Os dados preenchidos aqui valem só para esta cobrança e substituem o que veio do Stripe.
          Para as próximas, corrija o cliente no Stripe.
        </p>
        <fieldset className="gestao-fieldset" disabled={busy}>
          <legend>Tomador</legend>
          <div className="gestao-choices">
            <Checkbox
              label="Tomador no exterior"
              checked={!national}
              onChange={(e) => set("kind", e.target.checked ? "foreign" : "national")}
            />
          </div>
          <div className="gestao-grid gestao-grid--even">
            {national
              ? field("document", "CPF ou CNPJ", {
                  required: true,
                  // The alphanumeric CNPJ has letters: no numeric keyboard.
                  autoCapitalize: "characters",
                  maxLength: 18,
                })
              : field(
                  "nif",
                  "NIF (tax ID)",
                  { maxLength: 40 },
                  "Deixe em branco se o cliente não tem NIF.",
                )}
            {!national && !draft.nif.trim() ? (
              <FormField id={`${id}-nifAbsence`} label="Motivo da ausência do NIF">
                <Select
                  id={`${id}-nifAbsence`}
                  required
                  value={draft.nifAbsence}
                  onChange={(e) => set("nifAbsence", e.target.value as TakerDraft["nifAbsence"])}
                >
                  <option value="">Escolha o motivo</option>
                  <option value="1">Dispensado do NIF</option>
                  <option value="2">Não exigência do NIF</option>
                </Select>
              </FormField>
            ) : null}
            {field("name", "Nome", { required: true, maxLength: 300 })}
            {field("email", "E-mail", { type: "email", maxLength: 80 })}
            {national ? (
              <div>
                {field(
                  "municipalityCode",
                  "Código IBGE do município",
                  { required: true, inputMode: "numeric", pattern: "\\d{7}", maxLength: 7 },
                  <MunicipalityName scope={scope} code={draft.municipalityCode} />,
                )}
                <MunicipalitySearch
                  scope={scope}
                  code={draft.municipalityCode}
                  onPick={(code) => set("municipalityCode", code)}
                />
              </div>
            ) : (
              <>
                {field(
                  "country",
                  "País (ISO, 2 letras)",
                  { required: true, pattern: "[A-Za-z]{2}", maxLength: 2 },
                  "Como US, PT ou DE.",
                )}
                {field("city", "Cidade", { required: true, maxLength: 60 })}
                {field("state", "Estado ou província", { required: true, maxLength: 60 })}
              </>
            )}
            {field("postalCode", national ? "CEP" : "Postal code", {
              required: true,
              maxLength: national ? 9 : 11,
            })}
            {field("street", "Logradouro", { required: true, maxLength: 255 })}
            {field("number", "Número", { required: true, maxLength: 60 })}
            {field("district", "Bairro", { required: true, maxLength: 60 })}
          </div>
        </fieldset>
        <Feedback error={error} />
        <div className="ui-actions">
          <Button type="submit" variant="primary" loading={busy} loadingLabel="Liberando…">
            Liberar a emissão
          </Button>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancelar
          </Button>
        </div>
      </form>
    </Card>
  );
}
