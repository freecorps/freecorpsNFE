import { useEffect, useState } from "react";
import { useQuery } from "./convex-query";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import { todayInBrasilia } from "./format";
import { ErrorBoundary } from "./route-errors";
import { Button } from "./ui/button";
import { Input as TextInput, Select } from "./ui/form";

/** The console issues for the company; the request belongs to the console project. */
export type IssuanceScope = {
  organizationId: Id<"organizations">;
  companyId: Id<"companies">;
  environment: "sandbox" | "production";
};
const referenceScope = (scope: IssuanceScope) => ({
  organizationId: scope.organizationId,
  companyId: scope.companyId,
  contextKey: `issuance-references:${scope.companyId}`,
  dataset: "municipalities" as const,
  date: todayInBrasilia(),
});

/** Name and UF of the typed IBGE code, so a wrong code shows before the request. */
export function MunicipalityName({ scope, code }: { scope: IssuanceScope; code: string }) {
  if (!/^\d{7}$/.test(code.trim()))
    return <>Use a busca pelo nome ou digite o código com 7 dígitos.</>;
  return (
    <ErrorBoundary key={code} fallback="Não foi possível conferir o código na tabela do IBGE.">
      <MunicipalityLookup scope={scope} code={code.trim()} />
    </ErrorBoundary>
  );
}
function MunicipalityLookup({ scope, code }: { scope: IssuanceScope; code: string }) {
  const result = useQuery(api.references.search, { ...referenceScope(scope), code });
  if (result === undefined) return <>Conferindo o código na tabela do IBGE…</>;
  const entry = "entry" in result ? result.entry : null;
  return (
    <>
      {entry
        ? `Município: ${entry.description}${entry.state ? `/${entry.state}` : ""}`
        : "Código não encontrado na tabela de municípios do IBGE."}
    </>
  );
}

const ufs = [
  "AC",
  "AL",
  "AM",
  "AP",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MG",
  "MS",
  "MT",
  "PA",
  "PB",
  "PE",
  "PI",
  "PR",
  "RJ",
  "RN",
  "RO",
  "RR",
  "RS",
  "SC",
  "SE",
  "SP",
  "TO",
];
/**
 * Search by the start of the name, optionally narrowed by UF, over the municipalities table;
 * choosing a result fills the IBGE code. There is no postal code base to search by CEP.
 */
export function MunicipalitySearch({
  scope,
  code,
  onPick,
}: {
  scope: IssuanceScope;
  code: string;
  onPick: (code: string) => void;
}) {
  const [text, setText] = useState("");
  const [uf, setUf] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <div className="ui-field fiscal-municipality-search">
      <label className="ui-label" htmlFor="taker-municipality-search">
        Buscar município pelo nome (opcional)
      </label>
      <div className="fiscal-search-row">
        <TextInput
          id="taker-municipality-search"
          type="search"
          value={text}
          maxLength={100}
          autoComplete="off"
          placeholder="Ex.: Campinas"
          aria-describedby="taker-municipality-search-help"
          onChange={(e) => setText(e.target.value)}
        />
        <Select aria-label="UF do município" value={uf} onChange={(e) => setUf(e.target.value)}>
          <option value="">Todas as UF</option>
          {ufs.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </div>
      <p id="taker-municipality-search-help" className="ui-help">
        Digite ao menos 3 letras do início do nome. Não há busca por CEP.
      </p>
      {query.length >= 3 ? (
        <ErrorBoundary
          key={query}
          fallback={
            <p className="ui-help" role="status">
              A tabela de municípios está indisponível agora. Digite o código IBGE.
            </p>
          }
        >
          <MunicipalityResults
            scope={scope}
            query={query}
            uf={uf}
            code={code}
            onPick={(value) => {
              onPick(value);
              setText("");
              setQuery("");
            }}
          />
        </ErrorBoundary>
      ) : null}
    </div>
  );
}
function MunicipalityResults({
  scope,
  query,
  uf,
  code,
  onPick,
}: {
  scope: IssuanceScope;
  query: string;
  uf: string;
  code: string;
  onPick: (code: string) => void;
}) {
  const result = useQuery(api.references.search, { ...referenceScope(scope), q: query, limit: 50 });
  if (result === undefined)
    return (
      <p className="ui-help" role="status">
        Buscando municípios…
      </p>
    );
  const rows = ("page" in result ? result.page : [])
    .filter((row) => !uf || row.state === uf)
    .slice(0, 8);
  if (!rows.length)
    return (
      <p className="ui-help" role="status">
        Nenhum município começa com “{query}”{uf ? ` em ${uf}` : ""}.
      </p>
    );
  return (
    // Results as buttons; `aria-pressed` marks the code already in the field.
    <ul className="fiscal-options" aria-label="Municípios encontrados">
      {rows.map((row) => (
        <li key={row.code}>
          <Button size="sm" aria-pressed={row.code === code} onClick={() => onPick(row.code)}>
            {row.description}
            {row.state ? `/${row.state}` : ""} · IBGE {row.code}
          </Button>
        </li>
      ))}
    </ul>
  );
}
