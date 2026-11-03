import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { useQuery } from "./convex-query";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import { ErrorSummary, controlProps, focusField, type FieldErrors } from "./field";
import { ErrorBoundary } from "./route-errors";
import {
  MAX_ACTIVITIES,
  activityFields,
  activityId,
  apuracaoLabels,
  argsOf,
  draftOf,
  emptyActivity,
  fieldOrder,
  ibsCbsNote,
  profileError,
  profileErrorField,
  regimeLabels,
  simplesLabels,
  validateProfile,
  type Activity,
  type Draft,
} from "./nfse-profile-draft";
import { MunicipalityField, MunicipalityName, TableBoundary } from "./nfse-municipality-field";
import { DpsNumbering } from "./dps-numbering";
import { todayInBrasilia } from "./format";
import {
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DescriptionList,
  FormField,
  Input,
  Select,
  SkeletonBlock,
  StatusBadge,
  Textarea,
} from "./ui";

type Company = NonNullable<FunctionReturnType<typeof api.companies.get>>;
type Profile = NonNullable<FunctionReturnType<typeof api.nfseProfiles.get>>;

/** Width of each activity field in the six-column grid of the form. */
const activitySpan: Record<(typeof activityFields)[number]["key"], number> = {
  code: 2,
  label: 4,
  cnae: 2,
  lc116Item: 2,
  cTribNac: 2,
  nbs: 3,
  cTribMun: 3,
  ibsCIndOp: 2,
  ibsCst: 2,
  ibsCClassTrib: 2,
};
/** Removing an activity drops what was typed in it, so it asks first. */
function RemoveActivity({ index, onRemove }: { index: number; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ui-actions">
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Remover atividade {index + 1}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Remover a atividade ${index + 1} do formulário?`}
        description="Os dados digitados nesta atividade se perdem. O perfil salvo só muda quando você salvar."
        confirmLabel="Confirmar remoção"
        busyLabel="Removendo…"
        onConfirm={async () => {
          onRemove();
          return "";
        }}
        returnFocusTo={() =>
          document.getElementById(`nfse-activity-${Math.max(0, index - 1)}-legend`)
        }
      />
    </div>
  );
}

function ProfileForm({
  org,
  company,
  contextKey,
  profile,
  onSaved,
  onCancel,
}: {
  org: Organization;
  company: Company;
  contextKey: string;
  profile: Profile | null;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const save = useMutation(api.nfseProfiles.save);
  const [draft, setDraft] = useState(() => draftOf(profile));
  const [busy, setBusy] = useState(false),
    [errors, setErrors] = useState<FieldErrors>({}),
    [general, setGeneral] = useState(""),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    focusField("nfse-municipality");
  }, []);
  const ibsCbs = ibsCbsNote(draft.opSimpNac, todayInBrasilia());
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setActivity = (index: number, key: keyof Activity, value: string) =>
    setDraft((current) => ({
      ...current,
      activities: current.activities.map((a, i) => (i === index ? { ...a, [key]: value } : a)),
    }));
  function refuse(found: FieldErrors, message = "") {
    setErrors(found);
    setGeneral(message);
    setAttempt((n) => n + 1);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const found = validateProfile(draft, company.address.state);
    if (Object.keys(found).length) return refuse(found);
    setErrors({});
    setGeneral("");
    setBusy(true);
    try {
      const result = await save({
        organizationId: org.id,
        companyId: company.id,
        expectedVersion: profile?.version ?? 0,
        ...argsOf(draft),
      });
      onSaved(
        result.changed
          ? `Perfil salvo na versão ${result.version}. Próximo passo: confira a numeração da DPS.`
          : "Nenhuma alteração para salvar.",
      );
    } catch (error) {
      const field = profileErrorField(error, draft);
      const message = profileError(error);
      if (field) refuse({ [field]: message.replace(/^Atividade \d+: /, "") });
      else refuse({}, message);
    } finally {
      setBusy(false);
    }
  }
  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: {
      help?: string;
      max: number;
      numeric?: boolean;
      type?: string;
      optional?: boolean;
      span: number;
    },
  ) => (
    <div data-span={options.span}>
      <FormField
        id={id}
        label={label}
        optional={options.optional}
        error={errors[id]}
        help={options.help}
      >
        <Input
          {...controlProps(id, errors[id], options.help)}
          className={options.numeric ? "ui-mono" : undefined}
          type={options.type ?? "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={busy}
          maxLength={options.max}
          inputMode={options.numeric ? "numeric" : "text"}
          autoComplete="off"
        />
      </FormField>
    </div>
  );
  const select = <K extends "opSimpNac" | "regApTribSN" | "regEspTrib">(
    id: string,
    label: string,
    key: K,
    labels: Record<number, string>,
    span: number,
  ) => (
    <div data-span={span}>
      <FormField id={id} label={label} error={errors[id]}>
        <Select
          {...controlProps(id, errors[id])}
          value={draft[key]}
          disabled={busy}
          onChange={(e) => set(key, Number(e.target.value) as Draft[K])}
        >
          {Object.entries(labels).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </Select>
      </FormField>
    </div>
  );
  return (
    <form onSubmit={submit} aria-busy={busy} className="ui-form" noValidate>
      <ErrorSummary
        id="nfse-profile-errors"
        title={profile ? "O perfil não foi salvo." : "O perfil não foi criado."}
        errors={errors}
        fields={fieldOrder(draft)}
        general={general}
        focusKey={attempt}
      />
      <div className="company-form-grid">
        <MunicipalityField
          org={org}
          company={company}
          contextKey={contextKey}
          value={draft.municipalityCode}
          error={errors["nfse-municipality"]}
          disabled={busy}
          onChange={(code) => set("municipalityCode", code)}
        />
      </div>
      <div className="company-form-section">
        <h3 className="company-form-section__title">Regime tributário</h3>
        <div className="company-form-grid">
          {field(
            "nfse-registration",
            "Inscrição municipal",
            draft.municipalRegistration,
            (v) => set("municipalRegistration", v),
            {
              help: "Deixe em branco se o município não exigir a inscrição na DPS.",
              max: 20,
              optional: true,
              span: 2,
            },
          )}
          {select("nfse-simples", "Situação no Simples Nacional", "opSimpNac", simplesLabels, 2)}
          {select("nfse-regime", "Regime especial de tributação", "regEspTrib", regimeLabels, 2)}
          {draft.opSimpNac === 3 &&
            select(
              "nfse-apuracao",
              "Regime de apuração no Simples Nacional",
              "regApTribSN",
              apuracaoLabels,
              6,
            )}
        </div>
      </div>
      <div className="company-form-section">
        <h3 className="company-form-section__title">Série e contato</h3>
        <div className="company-form-grid">
          {field("nfse-series", "Série da DPS", draft.dpsSeries, (v) => set("dpsSeries", v), {
            help: "Usada nas emissões pela Sefin Nacional, o canal padrão. De um a cinco dígitos. Zeros à esquerda são ignorados. Se a empresa já emitiu DPS nesta série fora da plataforma, defina o número inicial no passo 2, depois de salvar.",
            max: 5,
            numeric: true,
            span: 2,
          })}
          {field(
            "nfse-campinas-series",
            "Série da DPS em Campinas",
            draft.campinasDpsSeries,
            (v) => set("campinasDpsSeries", v),
            {
              help: "Usada só quando a emissão vai ao canal de Campinas (IMA), que depende do município, do regime, da atividade e da data. Entre 10001 e 49999. Sem ela, esse canal usa a série acima se estiver nessa faixa.",
              max: 5,
              numeric: true,
              optional: true,
              span: 2,
            },
          )}
          {field(
            "nfse-email",
            "E-mail do prestador",
            draft.issuerEmail,
            (v) => set("issuerEmail", v),
            {
              help: "Vai na DPS quando o pedido de emissão não trouxer outro e-mail.",
              max: 80,
              type: "email",
              optional: true,
              span: 2,
            },
          )}
        </div>
      </div>
      <div className="company-form-section">
        <h3 className="company-form-section__title">Atividades</h3>
        <p className="ui-help">
          A alíquota de ISS não fica no perfil: ela será informada por competência em cada pedido de
          emissão.
        </p>
        <p className="ui-help">{ibsCbs.requirement}</p>
        {ibsCbs.export && <p className="ui-help">{ibsCbs.export}</p>}
        {draft.activities.map((activity, index) => (
          <fieldset key={index} className="company-fieldset" disabled={busy}>
            <legend id={`nfse-activity-${index}-legend`} tabIndex={-1}>
              Atividade {index + 1}
            </legend>
            <div className="company-form-grid">
              {activityFields.map((item) => {
                const id = activityId(index, item.key);
                return (
                  <div
                    key={item.key}
                    data-span={activitySpan[item.key]}
                    // Short codes pair up on the phone.
                    data-compact={item.max <= 5 || undefined}
                  >
                    <FormField
                      id={id}
                      label={item.label.replace(" (opcional)", "")}
                      optional={item.optional}
                      error={errors[id]}
                      help={item.help}
                    >
                      <Input
                        {...controlProps(id, errors[id], item.help)}
                        className={item.numeric ? "ui-mono" : undefined}
                        value={activity[item.key]}
                        onChange={(e) => setActivity(index, item.key, e.target.value)}
                        maxLength={item.max}
                        inputMode={item.numeric ? "numeric" : "text"}
                        autoComplete="off"
                      />
                    </FormField>
                  </div>
                );
              })}
              <div>
                <FormField
                  id={activityId(index, "description")}
                  label="Descrição padrão do serviço"
                  optional
                  error={errors[activityId(index, "description")]}
                >
                  <Textarea
                    {...controlProps(
                      activityId(index, "description"),
                      errors[activityId(index, "description")],
                    )}
                    value={activity.description}
                    onChange={(e) => setActivity(index, "description", e.target.value)}
                    maxLength={1000}
                    rows={3}
                  />
                </FormField>
              </div>
            </div>
            {draft.activities.length > 1 && (
              <RemoveActivity
                index={index}
                onRemove={() => {
                  setDraft((current) => ({
                    ...current,
                    activities: current.activities.filter((_, i) => i !== index),
                  }));
                  setErrors({});
                }}
              />
            )}
          </fieldset>
        ))}
        {draft.activities.length < MAX_ACTIVITIES ? (
          <div className="ui-actions">
            <Button
              icon="plus"
              disabled={busy}
              onClick={() => {
                const index = draft.activities.length;
                set("activities", [...draft.activities, { ...emptyActivity }]);
                requestAnimationFrame(() => focusField(activityId(index, "code")));
              }}
            >
              Adicionar atividade
            </Button>
          </div>
        ) : (
          <p className="ui-help">O perfil aceita até {MAX_ACTIVITIES} atividades.</p>
        )}
      </div>
      <div className="company-form-footer">
        <div className="ui-actions">
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            loadingLabel="Salvando…"
            aria-describedby={busy ? "nfse-busy" : undefined}
          >
            {profile ? "Salvar perfil" : "Criar perfil"}
          </Button>
          <Button disabled={busy} onClick={onCancel}>
            Cancelar
          </Button>
        </div>
        {busy && (
          <p id="nfse-busy" className="ui-help" role="status">
            Aguardando o servidor conferir e salvar o perfil.
          </p>
        )}
      </div>
    </form>
  );
}

function ProfileSummary({ profile, municipality }: { profile: Profile; municipality?: ReactNode }) {
  return (
    <div className="ui-stack">
      <DescriptionList
        items={[
          {
            term: "Código IBGE do município",
            value: (
              <>
                <span className="ui-mono">{profile.municipalityCode}</span>
                {municipality}
              </>
            ),
          },
          {
            term: "Inscrição municipal",
            value: profile.municipalRegistration ? (
              <span className="ui-mono">{profile.municipalRegistration}</span>
            ) : (
              <span className="ui-help">Não informada</span>
            ),
          },
          {
            term: "Simples Nacional",
            value: (
              <>
                {simplesLabels[profile.opSimpNac]}
                {profile.regApTribSN !== undefined && ` · ${apuracaoLabels[profile.regApTribSN]}`}
              </>
            ),
          },
          { term: "Regime especial de tributação", value: regimeLabels[profile.regEspTrib] },
          {
            term: "Série da DPS",
            value: (
              <>
                <span className="ui-mono">{profile.dpsSeries}</span>
                <span className="ui-help company-block">Sefin Nacional, o canal padrão.</span>
              </>
            ),
          },
          {
            term: "Série da DPS em Campinas",
            value: (
              <>
                {profile.campinasDpsSeries ? (
                  <span className="ui-mono">{profile.campinasDpsSeries}</span>
                ) : (
                  <span className="ui-help">Não informada</span>
                )}
                <span className="ui-help company-block">
                  Só no canal de Campinas (IMA). Sem ela, esse canal usa a série da DPS se estiver
                  entre 10001 e 49999.
                </span>
              </>
            ),
          },
          {
            term: "E-mail do prestador",
            value: profile.issuerEmail ?? <span className="ui-help">Não informado</span>,
          },
        ]}
      />
      <div className="company-form-section">
        <h3 className="company-form-section__title">Atividades</h3>
        <ul className="company-rows company-rows--inset">
          {profile.activities.map((activity) => (
            <li key={activity.code}>
              <p className="company-row__title">
                {activity.label}
                <StatusBadge>
                  <span className="ui-mono">{activity.code}</span>
                </StatusBadge>
              </p>
              <p className="company-row__meta">
                CNAE {activity.cnae} · LC 116 {activity.lc116Item} · Tributação nacional{" "}
                {activity.cTribNac}
                {activity.nbs && ` · NBS ${activity.nbs}`}
                {activity.cTribMun && ` · Tributação municipal ${activity.cTribMun}`}
              </p>
              {activity.ibsCbs && (
                <p className="company-row__meta">
                  IBS/CBS: operação {activity.ibsCbs.cIndOp} · CST {activity.ibsCbs.cst} ·
                  classificação {activity.ibsCbs.cClassTrib}
                </p>
              )}
              {activity.description && <p className="ui-help">{activity.description}</p>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ProfileContent({
  org,
  company,
  contextKey,
}: {
  org: Organization;
  company: Company;
  contextKey: string;
}) {
  const profile = useQuery(api.nfseProfiles.get, {
    organizationId: org.id,
    companyId: company.id,
    contextKey,
  });
  const [message, setMessage] = useState(""),
    [editing, setEditing] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  if (profile === undefined)
    return (
      <Card label="Perfil de emissão">
        <SkeletonBlock label="Carregando perfil de emissão…" />
      </Card>
    );
  const manage = company.capabilities.manage;
  const close = (text: string) => {
    setEditing(false);
    setMessage(text);
    requestAnimationFrame(() => openerRef.current?.focus());
  };
  const open = (
    <Button
      ref={openerRef}
      size="sm"
      variant={profile ? "secondary" : "primary"}
      onClick={() => {
        setMessage("");
        setEditing(true);
      }}
    >
      {profile ? "Editar perfil" : "Criar perfil de emissão"}
    </Button>
  );
  return (
    <>
      <Card
        title="1. Perfil de emissão"
        description={
          editing
            ? "Os campos só mudam no servidor quando você salvar. O servidor confere as mesmas regras de novo."
            : profile
              ? `Versão ${profile.version}, atualizada em ${new Date(profile.updatedAt).toLocaleString("pt-BR")}.`
              : manage
                ? "Nenhum perfil configurado. Crie o perfil para liberar a emissão desta empresa."
                : "Nenhum perfil configurado. Um proprietário ou administrador pode criá-lo."
        }
        actions={!editing && manage ? open : null}
      >
        <div className="ui-stack">
          {message && (
            <Callout tone="success" role="status">
              {message}
            </Callout>
          )}
          {editing ? (
            // Keys are prefixed: siblings of this fragment must not share the version as key.
            <ProfileForm
              key={`form:${profile?.version ?? 0}`}
              org={org}
              company={company}
              contextKey={contextKey}
              profile={profile}
              onSaved={close}
              onCancel={() => close("")}
            />
          ) : profile ? (
            <ProfileSummary
              profile={profile}
              municipality={
                <span className="ui-help company-block">
                  <TableBoundary key={profile.municipalityCode}>
                    <MunicipalityName
                      org={org}
                      company={company}
                      contextKey={contextKey}
                      code={profile.municipalityCode}
                    />
                  </TableBoundary>
                </span>
              }
            />
          ) : (
            <p className="ui-help">
              O perfil reúne município, regime tributário, série da DPS e as atividades que a
              emissão usa.
            </p>
          )}
          {!manage && (
            <p className="ui-help">
              Somente leitura: apenas proprietários e administradores alteram o perfil de emissão.
            </p>
          )}
        </div>
      </Card>
      <Card
        title="2. Numeração da DPS"
        description={
          profile
            ? "Cada série tem numeração própria em cada ambiente. Ela começa no número 1 ou no que você definir antes da primeira emissão da série naquele ambiente; depois disso, o número inicial trava."
            : undefined
        }
      >
        {profile ? (
          <DpsNumbering
            key={`numbering:${profile.version}`}
            org={org}
            company={company}
            contextKey={contextKey}
            manage={manage}
          />
        ) : (
          <p className="ui-help">
            Disponível depois de salvar o perfil. Nele, quem administra a empresa define o primeiro
            número de cada série, caso a empresa já tenha emitido DPS fora da plataforma. Esse
            número trava na primeira emissão da série em cada ambiente.
          </p>
        )}
      </Card>
    </>
  );
}

/** Issuing profile of a declared company. The demonstration company has none. */
export function NfseProfile(props: { org: Organization; company: Company; contextKey: string }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <>
      <div role="note">
        <Callout tone="info" title="Salvar o perfil não emite nada">
          Este perfil guarda os dados fiscais que a emissão usa; salvar não emite nem envia nada ao
          fisco. A emissão em sandbox, com o simulador no lugar do fisco e sem validade fiscal, fica
          na tela Emissão NFS-e do menu. Produção fica desligada até ser liberada para a empresa.
        </Callout>
      </div>
      <ErrorBoundary
        key={attempt}
        fallback={
          <Callout
            tone="danger"
            role="alert"
            title="Não foi possível carregar o perfil de emissão"
            actions={<Button onClick={() => setAttempt((n) => n + 1)}>Tentar novamente</Button>}
          >
            Confira sua conexão e o acesso à empresa antes de tentar novamente.
          </Callout>
        }
      >
        <ProfileContent {...props} />
      </ErrorBoundary>
    </>
  );
}
