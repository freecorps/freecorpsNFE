import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "./convex-query";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import { todayInBrasilia } from "./format";
import { controlProps } from "./field";
import { ErrorBoundary } from "./route-errors";
import { Button, FormField, Input } from "./ui";

// Municipality of the NFS-e profile: the IBGE code typed by hand, with the name read back from
// the references table and a search by name restricted to the company's UF.

type Company = NonNullable<FunctionReturnType<typeof api.companies.get>>;

export function MunicipalityName({
  org,
  company,
  contextKey,
  code,
}: {
  org: Organization;
  company: Company;
  contextKey: string;
  code: string;
}) {
  const result = useQuery(api.references.search, {
    organizationId: org.id,
    companyId: company.id,
    contextKey,
    dataset: "municipalities",
    date: todayInBrasilia(),
    code,
  });
  if (result === undefined) return <>Conferindo o código na tabela de municípios…</>;
  const lookup = "entry" in result ? result : null;
  return lookup?.entry ? (
    <>
      Município: {lookup.entry.description}/{lookup.entry.state}
      {lookup.status === "out_of_validity" ? " (fora de vigência na tabela)" : ""}.
    </>
  ) : (
    <>Código não encontrado na tabela de municípios.</>
  );
}
function MunicipalityOptions({
  org,
  company,
  contextKey,
  text,
  onPick,
}: {
  org: Organization;
  company: Company;
  contextKey: string;
  text: string;
  onPick: (code: string, name: string) => void;
}) {
  const result = useQuery(api.references.search, {
    organizationId: org.id,
    companyId: company.id,
    contextKey,
    dataset: "municipalities",
    date: todayInBrasilia(),
    q: text,
    limit: 20,
  });
  if (result === undefined) return <p className="ui-help">Buscando municípios…</p>;
  const state = company.address.state;
  const rows = ("page" in result ? result.page : []).filter((row) => row.state === state);
  if (!rows.length)
    return (
      <p className="ui-help">
        Nenhum município de {state} começa com “{text}”. Confira o nome ou informe o código.
      </p>
    );
  return (
    <ul className="company-choices" aria-label={`Municípios de ${state} encontrados`}>
      {rows.map((row) => (
        <li key={row.code}>
          <Button size="sm" onClick={() => onPick(row.code, `${row.description}/${row.state}`)}>
            {row.description}/{row.state} · {row.code}
          </Button>
        </li>
      ))}
    </ul>
  );
}
/** The municipality table is optional here: without it, the code is typed by hand. */
export function TableBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={
        <>Tabela de municípios indisponível agora; confira o código IBGE na fonte oficial.</>
      }
    >
      {children}
    </ErrorBoundary>
  );
}
export function MunicipalityField({
  org,
  company,
  contextKey,
  value,
  error,
  disabled,
  onChange,
}: {
  org: Organization;
  company: Company;
  contextKey: string;
  value: string;
  error?: string;
  disabled: boolean;
  onChange: (code: string) => void;
}) {
  const [search, setSearch] = useState(""),
    [text, setText] = useState(""),
    [picked, setPicked] = useState("");
  // Waits for a pause in typing before subscribing to the table.
  useEffect(() => {
    const timer = setTimeout(() => setText(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const code = value.trim();
  const help = (
    <>
      Sete dígitos, do município do prestador em {company.address.state}.{" "}
      <span aria-live="polite">
        {/^\d{7}$/.test(code) ? (
          <TableBoundary key={code}>
            <MunicipalityName org={org} company={company} contextKey={contextKey} code={code} />
          </TableBoundary>
        ) : null}
      </span>
    </>
  );
  return (
    <>
      <div data-span={2}>
        <FormField
          id="nfse-municipality"
          label="Código IBGE do município"
          error={error}
          help={help}
        >
          <Input
            {...controlProps("nfse-municipality", error, help)}
            className="ui-mono"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            maxLength={7}
            inputMode="numeric"
            autoComplete="off"
          />
        </FormField>
      </div>
      <div data-span={4}>
        <FormField
          id="nfse-municipality-search"
          label="Buscar município pelo nome"
          help="Digite o começo do nome e escolha o município para preencher o código."
        >
          <Input
            {...controlProps("nfse-municipality-search", undefined, true)}
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPicked("");
            }}
            disabled={disabled}
            maxLength={100}
            autoComplete="off"
          />
        </FormField>
      </div>
      <div aria-live="polite">
        {picked ? (
          <p className="ui-help">Código de {picked} preenchido.</p>
        ) : text.length >= 3 && text === search.trim() ? (
          <TableBoundary key={text}>
            <MunicipalityOptions
              org={org}
              company={company}
              contextKey={contextKey}
              text={text}
              onPick={(picked, name) => {
                onChange(picked);
                setPicked(name);
                document.getElementById("nfse-municipality")?.focus();
              }}
            />
          </TableBoundary>
        ) : null}
      </div>
    </>
  );
}
