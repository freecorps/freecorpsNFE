import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { useQuery } from "./convex-query";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import { controlProps } from "./field";
import { profileMessages } from "./nfse-profile-draft";
import { Button, Callout, FormField, Input, Select, SkeletonBlock, StatusBadge } from "./ui";

type Company = NonNullable<FunctionReturnType<typeof api.companies.get>>;

const environmentLabels = { sandbox: "Sandbox", production: "Produção" } as const;
const startMessages: Record<string, string> = {
  DPS_START_LOCKED:
    "A plataforma já reservou um número nesta série e ambiente; o número inicial não muda mais.",
  INVALID_DPS_START: "Informe um número inteiro entre 1 e 999999999999999.",
  INVALID_DPS_SERIES: "Escolha uma série do perfil salvo.",
  NFSE_PROFILE_REQUIRED: "Salve o perfil antes de definir a numeração.",
  DEMONSTRATION_READ_ONLY: profileMessages.DEMONSTRATION_READ_ONLY!,
  ACCESS_DENIED: profileMessages.ACCESS_DENIED!,
  UNAUTHENTICATED: profileMessages.UNAUTHENTICATED!,
};

/**
 * DPS numbering per series and environment. The first number can change only until the
 * platform reserves one; the server enforces it, the form explains it.
 */
export function DpsNumbering({
  org,
  company,
  contextKey,
  manage,
}: {
  org: Organization;
  company: Company;
  contextKey: string;
  manage: boolean;
}) {
  const rows = useQuery(api.nfseProfiles.sequences, {
    organizationId: org.id,
    companyId: company.id,
    contextKey,
  });
  const setStart = useMutation(api.nfseProfiles.setDpsStart);
  const [selected, setSelected] = useState(""),
    [start, setStartValue] = useState(""),
    [busy, setBusy] = useState(false),
    [fieldError, setFieldError] = useState(""),
    [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  if (rows === undefined) return <SkeletonBlock label="Carregando numeração da DPS…" lines={2} />;
  const open = rows.filter((row) => !row.locked);
  const key = (row: (typeof rows)[number]) => `${row.environment}:${row.series}`;
  const target = open.find((row) => key(row) === selected) ?? open[0];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || busy) return;
    setFeedback(null);
    const value = start.trim();
    if (!/^[1-9]\d{0,14}$/.test(value)) {
      setFieldError(
        value ? startMessages.INVALID_DPS_START! : "Informe o número inicial da série.",
      );
      document.getElementById("nfse-start-number")?.focus();
      return;
    }
    setFieldError("");
    setBusy(true);
    try {
      const result = await setStart({
        organizationId: org.id,
        companyId: company.id,
        environment: target.environment,
        series: target.series,
        start: Number(value),
      });
      setFeedback({
        error: false,
        text: result.changed
          ? `A série ${result.series} começa no número ${result.start}.`
          : "O número inicial já era esse.",
      });
    } catch (error) {
      const data: unknown = error instanceof ConvexError ? error.data : null;
      const code = data && typeof data === "object" && "code" in data ? String(data.code) : "";
      const text =
        startMessages[code] ?? "Não foi possível salvar. Confira sua conexão e tente novamente.";
      if (code === "INVALID_DPS_START") setFieldError(text);
      else setFeedback({ error: true, text });
    } finally {
      setBusy(false);
    }
  }
  // Locked series leave the select; say so instead of letting them vanish silently.
  const seriesHelp =
    open.length < rows.length
      ? "Séries com numeração em uso não aparecem aqui: o número inicial delas já travou."
      : undefined;
  const startHelp =
    "Se a empresa já emitiu DPS com esta série fora da plataforma, informe o próximo número livre. Ele trava na primeira emissão da série neste ambiente.";
  return (
    <div className="ui-stack">
      {rows.length === 0 ? (
        <p className="ui-help">Salve o perfil para ver a numeração das séries.</p>
      ) : (
        <ul className="company-rows company-rows--inset">
          {rows.map((row) => (
            <li key={key(row)}>
              <p className="company-row__title">
                Série {row.series} · {environmentLabels[row.environment]}
                <StatusBadge tone={row.locked ? "warning" : "success"}>
                  {row.locked ? "Numeração em uso" : "Número inicial livre"}
                </StatusBadge>
              </p>
              <p className="company-row__meta">
                Começa em {row.start} · próximo número {row.next}
              </p>
              <p className="ui-help">
                {row.locked
                  ? "Travado: a plataforma já reservou um número nesta série e ambiente."
                  : "Pode mudar até a primeira emissão nesta série e ambiente."}
              </p>
            </li>
          ))}
        </ul>
      )}
      {!manage ? (
        <p className="ui-help">Somente proprietários e administradores definem o número inicial.</p>
      ) : rows.length > 0 && open.length === 0 ? (
        <p className="ui-help">
          Todas as séries já têm número reservado nos dois ambientes, então o número inicial não
          muda mais.
        </p>
      ) : target ? (
        <form
          onSubmit={submit}
          aria-busy={busy}
          className="ui-form company-form-section"
          noValidate
        >
          <h3 className="company-form-section__title">Definir o número inicial</h3>
          <div className="company-form-grid">
            <div data-span={2}>
              <FormField id="nfse-start-series" label="Série e ambiente" help={seriesHelp}>
                <Select
                  {...controlProps("nfse-start-series", undefined, seriesHelp)}
                  value={key(target)}
                  disabled={busy}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {open.map((row) => (
                    <option key={key(row)} value={key(row)}>
                      Série {row.series} · {environmentLabels[row.environment]}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            <div data-span={4}>
              <FormField
                id="nfse-start-number"
                label="Número inicial"
                error={fieldError}
                help={startHelp}
              >
                <Input
                  {...controlProps("nfse-start-number", fieldError, startHelp)}
                  className="ui-mono"
                  value={start}
                  onChange={(e) => setStartValue(e.target.value)}
                  disabled={busy}
                  maxLength={15}
                  inputMode="numeric"
                  autoComplete="off"
                />
              </FormField>
            </div>
          </div>
          {feedback && (
            <Callout
              tone={feedback.error ? "danger" : "success"}
              role={feedback.error ? "alert" : "status"}
            >
              {feedback.text}
            </Callout>
          )}
          <div className="ui-actions">
            <Button type="submit" loading={busy} loadingLabel="Salvando…">
              Definir número inicial
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
