import { useId } from "react";
import { scopesWithoutRestRoute, type IntegrationScope } from "@freecorps/contracts";
import { Button } from "./ui/button";
import { CopyButton } from "./ui/copy-button";
import { Checkbox } from "./ui/form";
import { Icon } from "./ui/icons";
import { Callout } from "./ui/layout";

/** Scope names shown to people; the technical code stays as secondary detail. */
export const scopeLabels: Record<IntegrationScope, string> = {
  "companies:read": "Listar empresas concedidas",
  "companies:write": "Cadastrar empresas",
  "documents:read": "Consultar documentos",
  "documents:import": "Importar XML",
  "documents:issue": "Emitir NFS-e",
  "documents:cancel": "Cancelar NFS-e",
  "connections:read": "Acompanhar a captura",
  "connections:write": "Controlar a captura",
  "certificates:read": "Consultar certificados",
  "certificates:write": "Gerenciar certificados",
  "webhooks:manage": "Gerenciar destinos de webhook",
  "references:read": "Consultar municípios e NCM",
  "registry:read": "Consultar CNPJ",
};

export type ScopeGroup = {
  id: string;
  title: string;
  description: string;
  scopes: readonly IntegrationScope[];
};
/** Grouped by what the integration needs to do. Every catalog scope belongs to one group. */
export const scopeGroups: readonly ScopeGroup[] = [
  {
    id: "documents",
    title: "Importar e consultar documentos",
    description: "Enviar XML de NF-e e NFS-e e consultar documentos, itens, eventos e originais.",
    scopes: ["documents:import", "documents:read"],
  },
  {
    id: "issuance",
    title: "Emitir e cancelar NFS-e",
    description: "Pedir emissões e cancelamentos de NFS-e e acompanhar o resultado.",
    scopes: ["documents:issue", "documents:cancel"],
  },
  {
    id: "webhooks",
    title: "Webhooks",
    description: "Cadastrar destinos HTTPS, testar e reenviar entregas.",
    scopes: ["webhooks:manage"],
  },
  {
    id: "registry",
    title: "Cadastro e consulta CNPJ",
    description: "Listar as empresas concedidas, consultar CNPJ, municípios e NCM.",
    scopes: ["companies:read", "registry:read", "references:read", "companies:write"],
  },
  {
    id: "capture",
    title: "Captura de NF-e",
    description: "Acompanhar e controlar a captura de notas destinadas à empresa.",
    scopes: ["connections:read", "connections:write", "certificates:read", "certificates:write"],
  },
];
/** Groups as one-line, human labels, e.g. for a grant summary. */
export function scopeSummary(scopes: readonly IntegrationScope[]) {
  return scopeGroups
    .filter((g) => g.scopes.some((s) => scopes.includes(s)))
    .map((g) => {
      const routable = g.scopes.filter((s) => !scopesWithoutRestRoute.includes(s));
      return routable.every((s) => scopes.includes(s))
        ? g.title
        : `${g.title} (${g.scopes
            .filter((s) => scopes.includes(s))
            .map((s) => scopeLabels[s].toLowerCase())
            .join(", ")})`;
    })
    .join(" · ");
}
export function scopeNames(scopes: readonly IntegrationScope[]) {
  return scopes.map((s) => scopeLabels[s]).join(", ");
}

/**
 * Intent-level checkboxes. A group selects the routable scopes the person may grant; the
 * individual technical scopes stay available as a secondary detail for finer restriction.
 */
export function ScopePicker({
  legend,
  allowed,
  selected,
  onChange,
  disabled,
}: {
  legend: string;
  allowed: readonly IntegrationScope[];
  selected: readonly IntegrationScope[];
  onChange: (scopes: IntegrationScope[]) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const groups = scopeGroups
    .map((g) => ({ ...g, offered: g.scopes.filter((s) => allowed.includes(s)) }))
    .filter((g) => g.offered.length);
  function set(scopes: readonly IntegrationScope[], on: boolean) {
    const next = on
      ? [...selected, ...scopes.filter((s) => !selected.includes(s))]
      : selected.filter((s) => !scopes.includes(s));
    // Keep catalog order so payloads and summaries stay stable.
    onChange(allowed.filter((s) => next.includes(s)));
  }
  return (
    <fieldset className="gestao-fieldset" disabled={disabled}>
      <legend>{legend}</legend>
      {groups.length ? null : <p className="gestao-help">Nenhum escopo disponível.</p>}
      <div className="gestao-choices">
        {groups.map((g) => {
          const routable = g.offered.filter((s) => !scopesWithoutRestRoute.includes(s));
          const whole = routable.length ? routable : g.offered;
          const checked = whole.every((s) => selected.includes(s));
          const some = g.offered.filter((s) => selected.includes(s));
          return (
            <div className="gestao-choice" key={g.id}>
              {/* The name is only the title: the description is linked, not part of the name. */}
              <Checkbox
                label={g.title}
                checked={checked}
                ref={(input) => {
                  if (input) input.indeterminate = !checked && some.length > 0;
                }}
                aria-describedby={`${id}-${g.id}`}
                onChange={(e) => set(whole, e.target.checked)}
              />
              <p id={`${id}-${g.id}`} className="ui-help">
                {g.description}
                {!checked && some.length
                  ? ` Marcado em parte: ${some.map((s) => scopeLabels[s]).join(", ")}.`
                  : ""}
              </p>
            </div>
          );
        })}
      </div>
      {groups.length ? (
        <details className="gestao-details">
          <summary>
            Ajustar escopos técnicos
            <Icon name="chevronDown" />
          </summary>
          <div>
            {groups.map((g) => (
              <div className="gestao-scope-group" key={g.id}>
                <p>{g.title}</p>
                <div className="gestao-choices">
                  {g.offered.map((scope) => (
                    <Checkbox
                      key={scope}
                      checked={selected.includes(scope)}
                      onChange={(e) => set([scope], e.target.checked)}
                      label={
                        <>
                          {scopeLabels[scope]} <code>{scope}</code>
                          {scopesWithoutRestRoute.includes(scope)
                            ? " · previsto, sem rota REST"
                            : ""}
                        </>
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </fieldset>
  );
}

/** The console's single copy control lives in `ui/`. */
export { CopyButton };

/** A secret shown once: visible warning, copy action and explicit discard. */
export function OneTimeSecret({
  id,
  label,
  value,
  created,
  onDone,
}: {
  id: string;
  label: string;
  value: string;
  created: string;
  onDone: () => void;
}) {
  return (
    <div className="ui-stack">
      <Callout tone="success" role="status">
        {created}
      </Callout>
      <Callout tone="warning">
        <p id={`${id}-warning`}>
          Uso único: este segredo aparece só agora. Copie e guarde no cofre ou nas variáveis de
          ambiente do aplicativo. Depois de fechar, ele não pode ser recuperado.
        </p>
      </Callout>
      <div className="ui-field">
        <label className="ui-label" htmlFor={id}>
          {label}
        </label>
        <div className="gestao-secret">
          <input
            id={id}
            className="ui-input"
            readOnly
            value={value}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-warning`}
            onFocus={(e) => e.target.select()}
          />
          <CopyButton value={value} label="Copiar segredo" size="md" />
        </div>
      </div>
      <div>
        <Button variant="primary" onClick={onDone}>
          Já guardei o segredo
        </Button>
      </div>
    </div>
  );
}
