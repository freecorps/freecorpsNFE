import { UsageErrorNotice, UsageGuidance, isUsageCode } from "./usage-errors";
import { useState } from "react";
import { useMutation } from "convex/react";
import { useQuery } from "./convex-query";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { RegistryLookup } from "@freecorps/contracts/registry";
import type { Organization } from "./organizations";
import { useNow } from "./product-components";
import {
  Button,
  Callout,
  Card,
  Checkbox,
  DescriptionList,
  DisabledReason,
  SkeletonBlock,
  StatusBadge,
} from "./ui";

export const registryLabels = {
  "not-consulted": "Ainda não consultada",
  not_consulted: "Ainda não consultada",
  found: "Cadastro encontrado",
  not_found: "Não encontrado na base do provedor",
  unavailable: "Fonte indisponível",
  unsupported_format: "Formato não suportado pela fonte",
};
const date = (value: number | null) =>
  value === null ? "Não informada" : new Date(value).toLocaleString("pt-BR");
type Company = NonNullable<FunctionReturnType<typeof api.companies.get>>;
export function Registry({
  org,
  company,
  contextKey,
}: {
  org: Organization;
  company: Company;
  contextKey: string;
}) {
  const result = useQuery(
    api.registry.get,
    company.kind === "demonstration"
      ? "skip"
      : {
          organizationId: org.id,
          companyId: company.id,
          contextKey,
        },
  );
  if (company.kind === "demonstration")
    return (
      <Callout tone="info">
        A demonstração usa dados sintéticos e não consulta provedores externos.
      </Callout>
    );
  if (result === undefined)
    return (
      <Card label="Consulta cadastral">
        <SkeletonBlock label="Carregando consulta cadastral…" />
      </Card>
    );
  const found = result.status === "found";
  return (
    <>
      <Card
        title="Consultar CNPJ"
        description={
          <>
            Dados de{" "}
            <a className="ui-link" href={result.sourceUrl} target="_blank" rel="noreferrer">
              OpenCNPJ / Receita Federal
            </a>
            . A base é periódica. Situação cadastral não comprova regularidade nem concede acesso
            fiscal.
          </>
        }
      >
        <div className="ui-stack">
          <div role="status">
            <StatusBadge
              tone={found ? (result.freshness === "stale" ? "warning" : "success") : "neutral"}
            >
              {registryLabels[result.status]}
              {result.freshness === "stale"
                ? " · Cache vencido"
                : result.freshness === "fresh"
                  ? " · Cache dentro do prazo"
                  : ""}
            </StatusBadge>
          </div>
          <DescriptionList
            items={[
              { term: "Data da fonte para este cadastro", value: date(result.sourceUpdatedAt) },
              { term: "Consulta dos dados", value: date(result.consultedAt) },
              { term: "Última tentativa", value: date(result.lastAttemptAt) },
              { term: "Próxima atualização externa permitida", value: date(result.refreshAfter) },
            ]}
          />
          <p className="ui-help">
            Consultar o cache não chama o provedor. Atualizações externas são gratuitas, limitadas e
            reutilizam o cache por 24 horas. Cadastros ausentes podem ainda não constar na base
            publicada.
          </p>
          {org.capabilities.operateDocuments ? (
            <Refresh org={org} company={company} refreshAfter={result.refreshAfter} />
          ) : (
            <p className="ui-help">
              Seu papel permite consultar o resultado salvo. Atualizar a consulta exige papel de
              Operador, Administrador ou Proprietário.
            </p>
          )}
        </div>
      </Card>
      {result.data ? (
        <Card
          title="Dados da fonte"
          description={
            found
              ? "O que a fonte devolveu na última consulta. O cadastro da empresa só muda quando você confirmar."
              : undefined
          }
        >
          <div className="ui-stack">
            {!found ? (
              <Callout tone="warning">
                Dados anteriores preservados. A última tentativa não os confirmou.
              </Callout>
            ) : null}
            <DescriptionList
              items={[
                { term: "Razão social", value: result.data.name },
                { term: "Situação na fonte", value: result.data.status },
                {
                  term: "Endereço",
                  value: (
                    <>
                      {result.data.address.street}, {result.data.address.number}
                      {result.data.address.complement ? ` · ${result.data.address.complement}` : ""}
                    </>
                  ),
                },
                {
                  term: "Bairro e município",
                  value: `${result.data.address.district} · ${result.data.address.city}/${result.data.address.state}`,
                },
                {
                  term: "CEP",
                  value: <span className="ui-mono">{result.data.address.postalCode}</span>,
                },
              ]}
            />
          </div>
        </Card>
      ) : null}
      {company.capabilities.manage &&
      result.data &&
      result.status === "found" &&
      result.freshness === "fresh" ? (
        <Apply
          key={`${company.version}:${result.version}`}
          org={org}
          company={company}
          result={result}
        />
      ) : null}
    </>
  );
}
/** Failure other than a quota or plan refusal, which `UsageErrorNotice` explains by role. */
function errorText(error: unknown) {
  const data = error instanceof ConvexError ? error.data : null;
  const code = data && typeof data === "object" && "code" in data ? data.code : null;
  if (code === "RATE_LIMITED") return "Limite atingido. Aguarde um minuto e tente novamente.";
  if (code === "COMPANY_CHANGED" || code === "REGISTRY_CHANGED")
    return "Os dados mudaram. Confira a nova versão antes de confirmar.";
  return "Não foi possível concluir. Confira o acesso, os campos e sua conexão.";
}
/** The console refreshes for the company itself; the request belongs to the console project. */
function Refresh({
  org,
  company,
  refreshAfter,
}: {
  org: Organization;
  company: Company;
  /** Next external consultation the cache allows; until then the button waits and says why. */
  refreshAfter: number | null;
}) {
  const refresh = useMutation(api.registry.refresh);
  const [operationId, setOperationId] = useState<Id<"operations"> | null>(null);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const operation = useQuery(api.operations.get, operationId ? { operationId } : "skip");
  const now = useNow(refreshAfter);
  const waiting = refreshAfter !== null && refreshAfter > now;
  const pending =
    operationId !== null &&
    (!operation || !["succeeded", "failed", "paused"].includes(operation.state));
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = await refresh({
        organizationId: org.id,
        companyId: company.id,
        environment: "sandbox",
        cnpj: company.cnpj,
        key: requestKey,
      });
      setOperationId(response.operationId);
      setRequestKey(crypto.randomUUID());
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  const reason = waiting && !pending;
  return (
    <div className="ui-stack">
      <div className="ui-actions">
        <Button
          icon="search"
          disabled={busy || pending || waiting}
          loading={busy || pending}
          loadingLabel="Atualizando consulta…"
          aria-describedby={reason ? "registry-refresh-reason" : undefined}
          onClick={() => void run()}
        >
          Atualizar consulta
        </Button>
      </div>
      {reason ? (
        <DisabledReason id="registry-refresh-reason">
          A próxima consulta à fonte é permitida a partir de {date(refreshAfter)}; o botão é
          liberado nesse horário. Até lá, atualizar devolveria o mesmo resultado salvo acima.
        </DisabledReason>
      ) : null}
      {operation ? (
        <p className="ui-help" role="status">
          {operation.state === "succeeded"
            ? "Consulta concluída. Confira o resultado e a data acima."
            : operation.state === "failed" || operation.state === "paused"
              ? "A consulta não foi concluída. Uma nova tentativa exige atualização explícita."
              : "Consulta em andamento."}
        </p>
      ) : null}
      {operation &&
      (operation.state === "failed" || operation.state === "paused") &&
      isUsageCode(operation.code) ? (
        <Callout tone="warning">
          <UsageGuidance code={operation.code} org={org} />
        </Callout>
      ) : null}
      {error ? <UsageErrorNotice error={error} org={org} fallback={errorText(error)} /> : null}
    </div>
  );
}
function Apply({
  org,
  company,
  result,
}: {
  org: Organization;
  company: Company;
  result: RegistryLookup;
}) {
  const apply = useMutation(api.registry.apply);
  const [name, setName] = useState(false),
    [address, setAddress] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await apply({
        organizationId: org.id,
        companyId: company.id,
        expectedCompanyVersion: company.version,
        expectedCacheVersion: result.version,
        fields: [...(name ? ["name" as const] : []), ...(address ? ["address" as const] : [])],
      });
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="Revisar sugestão cadastral"
      description="Selecione o que deseja substituir pelos dados da fonte. O histórico preserva os valores anteriores e a origem."
    >
      <fieldset className="company-plain-fieldset">
        <legend className="ui-visually-hidden">Campos a substituir</legend>
        <div className="ui-stack">
          <Checkbox
            checked={name}
            onChange={(e) => setName(e.target.checked)}
            label={`Substituir razão social atual: ${company.name}`}
          />
          <Checkbox
            checked={address}
            onChange={(e) => setAddress(e.target.checked)}
            label={`Substituir endereço atual: ${company.address.street}, ${company.address.number}, ${company.address.city}/${company.address.state}`}
          />
          <div className="ui-actions">
            <Button
              variant="primary"
              disabled={!name && !address}
              loading={busy}
              loadingLabel="Confirmando…"
              aria-describedby={!name && !address ? "registry-apply-reason" : undefined}
              onClick={() => void confirm()}
            >
              Confirmar campos selecionados
            </Button>
          </div>
          {!name && !address ? (
            <DisabledReason id="registry-apply-reason">
              Escolha ao menos um campo para substituir.
            </DisabledReason>
          ) : null}
          {error ? <UsageErrorNotice error={error} org={org} fallback={errorText(error)} /> : null}
        </div>
      </fieldset>
    </Card>
  );
}
