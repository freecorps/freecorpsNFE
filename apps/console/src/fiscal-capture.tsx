import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import { api } from "../../../platform/convex/_generated/api";
import { ActionFailure, useNow } from "./product-components";
import { TermsLink, TermsText, archivedTerms, termsDate } from "./capture-terms";
import { formatDateTime } from "./format";
import { releaseFailureText } from "./capture-messages";
import {
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  CopyButton,
  DescriptionList,
  Disclosure,
  FormField,
  Select,
} from "./ui";

export type ReleaseStatus = FunctionReturnType<typeof api.captureRelease.status>;
const errorMessage = (e: unknown) =>
  releaseFailureText(e instanceof ConvexError ? String(e.data?.code) : "");
const intervals = [1, 2, 4, 6, 12, 24];
const hoursLabel = (hours: number) => (hours === 1 ? "1 hora" : `${hours} horas`);
/** What the minimum interval means, in the words of the issue (#432). */
export const intervalMeaning = (hours: number) =>
  `Consulta automática no máximo a cada ${hours} h quando não há documentos pendentes.`;

/**
 * Termos que o Proprietário ou Administrador aceita para ligar a captura fiscal (ADR 0007, emenda
 * de 22/10/2026), na versão que o servidor pede. O texto vem do arquivo da versão
 * (`capture-terms.tsx`); um console sem o texto dessa versão, como uma aba aberta antes de uma
 * versão nova, não deixa aceitar o que não mostra.
 */
export function FiscalCaptureTerms({ version }: { version: string }) {
  const text = archivedTerms[version];
  if (text === undefined)
    return (
      <Callout tone="warning">
        Esta página não tem o texto da versão {version} dos termos. Recarregue a página para ler os
        termos antes de ativar.
      </Callout>
    );
  return (
    <div className="ui-stack">
      <TermsText text={text} />
      <p className="ui-help">Termos da captura fiscal de {termsDate(version)}.</p>
    </div>
  );
}

/**
 * The company's release of the fiscal capture, at the top of the Produção card (#432). Off, the
 * form that turns it on; on, one summary line ("Captura fiscal ativa · intervalo mínimo 1 h"),
 * with the interval editable in place and "Desativar". Turning it on does not start the capture:
 * the panel below asks for that last step (`onEnabled`).
 */
export function FiscalCapture({
  organizationId,
  companyId,
  status,
  onEnabled,
  title,
  hasStream = false,
  onEditingChange,
}: {
  organizationId: Id<"organizations">;
  companyId: Id<"companies">;
  status: ReleaseStatus;
  /** A production capture to read below: turning it on again is then a collapsed block. */
  hasStream?: boolean;
  /** The release went through: the panel below takes the focus to "Iniciar captura fiscal". */
  onEnabled: () => void;
  /** The card's title, where the focus goes once "Desativar" left with the release. */
  title: RefObject<HTMLHeadingElement | null>;
  /** The interval editor opened or closed: while open, "Salvar intervalo" is the main button. */
  onEditingChange?: (editing: boolean) => void;
}) {
  const enable = useMutation(api.captureRelease.enable),
    disable = useMutation(api.captureRelease.disable);
  const [accepted, setAccepted] = useState(false),
    [interval, setInterval] = useState(1),
    [busy, setBusy] = useState(false),
    // A new object per refusal: the same message twice still takes the focus again.
    [failure, setFailure] = useState<{ message: string } | null>(null),
    [disabling, setDisabling] = useState(false);
  const released = status.state === "released";
  const ready = status.requirements.declared && status.requirements.certificate;
  const termsShown = archivedTerms[status.terms] !== undefined;
  async function activate() {
    setBusy(true);
    setFailure(null);
    try {
      await enable({ organizationId, companyId, minIntervalHours: interval, terms: status.terms });
      setAccepted(false);
      onEnabled();
    } catch (e) {
      setFailure({ message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  /** The dialog waits for the server and keeps a refusal inside it. */
  async function deactivate() {
    try {
      await disable({ organizationId, companyId });
      return "";
    } catch (e) {
      return errorMessage(e);
    }
  }
  // One notice, in one tone: what happened, what stays and what to do (#424). The capture below
  // does not repeat it.
  if (status.blocked)
    return (
      <Callout tone="warning" title="Captura fiscal suspensa pela Freecorps">
        Nenhuma consulta nova é feita à Receita. {KEPT} Para reativar, fale com o suporte.
      </Callout>
    );
  if (!status.available)
    return <ReleaseLine label="Captura fiscal indisponível neste ambiente" note={KEPT} />;
  if (released)
    return (
      <ReleasedLine
        organizationId={organizationId}
        companyId={companyId}
        hours={status.minIntervalHours}
        acceptedTerms={status.acceptedTerms}
        canManage={status.canManage}
        onDisable={() => setDisabling(true)}
        onEditingChange={onEditingChange}
      >
        {status.termsUpdate ? (
          <TermsUpdate
            organizationId={organizationId}
            companyId={companyId}
            update={status.termsUpdate}
            canManage={status.canManage}
          />
        ) : null}
        <ConfirmDialog
          open={disabling}
          onOpenChange={setDisabling}
          title="Desativar a captura fiscal?"
          description={`As consultas à Receita param. ${KEPT}`}
          confirmLabel="Desativar captura fiscal"
          busyLabel="Desativando…"
          settleMs={350}
          onConfirm={deactivate}
          // The button leaves with the release; the card's title keeps the place.
          returnFocusTo={() => title.current}
        />
      </ReleasedLine>
    );
  const off =
    status.state === "withdrawn" ? (
      <ReleaseLine label="Captura fiscal desativada" note={KEPT} />
    ) : null;
  if (!status.canManage)
    return (
      <div className="ui-stack">
        {off}
        <p className="ui-help">
          Somente Proprietário ou Administrador ativa ou desativa a captura fiscal.
        </p>
      </div>
    );
  if (!ready)
    return (
      <div className="ui-stack">
        {off}
        <Callout tone="info">
          {status.requirements.declared
            ? "Envie e ative o certificado A1 da própria empresa, com o mesmo CNPJ, para ativar a captura fiscal."
            : "Empresas de demonstração não usam a captura fiscal."}
        </Callout>
      </div>
    );
  const form = (
    <form
      className="ui-form"
      onSubmit={(e) => {
        e.preventDefault();
        void activate();
      }}
    >
      <FiscalCaptureTerms version={status.terms} />
      <FormField
        id="fiscal-capture-interval"
        label="Intervalo mínimo entre consultas"
        help={`${intervalMeaning(interval)} Aumente se outros sistemas consultam o mesmo CNPJ. Dá para mudar depois, sem desativar.`}
      >
        <Select
          id="fiscal-capture-interval"
          value={interval}
          onChange={(e) => setInterval(Number(e.target.value))}
          aria-describedby="fiscal-capture-interval-help"
        >
          {intervals.map((hours) => (
            <option key={hours} value={hours}>
              {hoursLabel(hours)}
            </option>
          ))}
        </Select>
      </FormField>
      <Checkbox
        checked={accepted && termsShown}
        disabled={!termsShown}
        onChange={(e) => setAccepted(e.target.checked)}
        label="Li e aceito os termos da captura fiscal"
      />
      <Callout tone="warning">
        Ao ativar, chaves de API de produção desta empresa criadas antes são revogadas; emita chaves
        novas depois.
      </Callout>
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={!accepted || !termsShown}
          loading={busy}
          loadingLabel="Ativando…"
        >
          Ativar captura fiscal
        </Button>
      </div>
      <ActionFailure failure={failure}>
        <Callout tone="danger">{failure?.message}</Callout>
      </ActionFailure>
    </form>
  );
  // Turned off with a capture to read below: turning it on again is the rarer path, collapsed.
  return off ? (
    <div className="ui-stack">
      {off}
      {hasStream ? <Disclosure summary="Ativar de novo a captura fiscal">{form}</Disclosure> : form}
    </div>
  ) : (
    form
  );
}

/**
 * "Termos de 22/10/2026 aceitos por Ana em 22/10/2026 14:03 · Ler os termos". The version's slug
 * stays on the terms page; the name comes only to the roles that see the members.
 */
function AcceptedTerms({
  version,
  acceptedAt,
  acceptedBy,
}: NonNullable<ReleaseStatus["acceptedTerms"]>) {
  const date = termsDate(version);
  return (
    <p className="ui-help">
      {date ? `Termos de ${date}` : "Termos"} aceitos
      {acceptedBy ? ` por ${acceptedBy}` : ""} em {formatDateTime(acceptedAt)}.{" "}
      <TermsLink version={version}>Ler os termos</TermsLink>
    </p>
  );
}

const brasiliaDay = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeZone: "America/Sao_Paulo",
});
/**
 * New terms for a release that holds (#428): until the deadline the capture goes on; past it, the
 * queries wait for the acceptance. Owners and admins read the new text and accept it here; the
 * release, its interval and its keys stay.
 */
function TermsUpdate({
  organizationId,
  companyId,
  update,
  canManage,
}: {
  organizationId: Id<"organizations">;
  companyId: Id<"companies">;
  update: NonNullable<ReleaseStatus["termsUpdate"]>;
  canManage: boolean;
}) {
  const accept = useMutation(api.captureRelease.acceptTerms);
  const [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<{ message: string } | null>(null);
  const termsShown = archivedTerms[update.version] !== undefined;
  // The deadline is the midnight in Brasília that ends its last day, whatever the reader's zone.
  const deadline = brasiliaDay.format(update.deadline - 1);
  // The server returns the deadline, not whether it passed: its query never reads the clock.
  const expired = useNow(update.deadline) >= update.deadline;
  async function submit() {
    setBusy(true);
    setFailure(null);
    try {
      await accept({ organizationId, companyId, terms: update.version });
    } catch (e) {
      setFailure({ message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  const notice = expired ? (
    <Callout tone="warning" title="Consultas à Receita pausadas até o aceite dos novos termos">
      O prazo para aceitar os termos da captura fiscal de {termsDate(update.version)} terminou em{" "}
      {deadline}. A captura continua ativa e volta a consultar em até uma hora depois do aceite.{" "}
      {KEPT}
    </Callout>
  ) : (
    <Callout tone="info" title="Novos termos da captura fiscal">
      Os termos da captura fiscal mudaram. Aceite a versão de {termsDate(update.version)} até{" "}
      {deadline}; depois disso, as consultas à Receita ficam pausadas até o aceite.
    </Callout>
  );
  if (!canManage)
    return (
      <div className="ui-stack">
        {notice}
        <p className="ui-help">Somente Proprietário ou Administrador aceita os novos termos.</p>
      </div>
    );
  return (
    <div className="ui-stack">
      {notice}
      <Disclosure summary="Ler e aceitar os novos termos">
        <form
          className="ui-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FiscalCaptureTerms version={update.version} />
          <Checkbox
            checked={accepted && termsShown}
            disabled={!termsShown}
            onChange={(e) => setAccepted(e.target.checked)}
            label="Li e aceito os novos termos da captura fiscal"
          />
          <div>
            <Button
              type="submit"
              variant="primary"
              disabled={!accepted || !termsShown}
              loading={busy}
              loadingLabel="Aceitando…"
            >
              Aceitar os novos termos
            </Button>
          </div>
          <ActionFailure failure={failure}>
            <Callout tone="danger">{failure?.message}</Callout>
          </ActionFailure>
        </form>
      </Disclosure>
    </div>
  );
}

/** The release in one line, when there is nothing to change here. */
/**
 * What stays once the fiscal capture is off, said only here: the capture below shows its badge
 * and data, without its own notice (#424). The screen's word is "recebidos".
 */
const KEPT = "Os documentos já recebidos continuam em Documentos › Produção.";

function ReleaseLine({ label, note }: { label: string; note?: string }) {
  return (
    <div className="capture-release">
      <p className="capture-release__line">
        <strong>{label}</strong>
      </p>
      {note ? <p className="ui-help">{note}</p> : null}
    </div>
  );
}

/**
 * "Captura fiscal ativa · intervalo mínimo 1 h · Alterar intervalo · Desativar" (#432). The
 * interval changes in place, without turning the capture off: the select takes the line's place
 * and the focus; saving or cancelling brings the line back, saving with the focus on the line,
 * which then reads the new interval, and cancelling on "Alterar intervalo".
 */
function ReleasedLine({
  organizationId,
  companyId,
  hours,
  acceptedTerms,
  canManage,
  onDisable,
  onEditingChange,
  children,
}: {
  organizationId: Id<"organizations">;
  companyId: Id<"companies">;
  hours: number;
  /** The acceptance of the release that holds: terms version, when and, for managers, who. */
  acceptedTerms: ReleaseStatus["acceptedTerms"];
  canManage: boolean;
  onDisable: () => void;
  onEditingChange?: (editing: boolean) => void;
  /** The confirmation of "Desativar". */
  children: ReactNode;
}) {
  const id = useId();
  const update = useMutation(api.captureRelease.updateInterval);
  const [editing, setEditing] = useState(false),
    [value, setValue] = useState(hours),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<{ message: string } | null>(null);
  const line = useRef<HTMLParagraphElement>(null),
    opener = useRef<HTMLButtonElement>(null),
    select = useRef<HTMLSelectElement>(null),
    /** Where the focus goes once the editor gives way to the line. */
    back = useRef<"line" | "opener" | null>(null);
  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);
  // The line can leave with the editor open (the release turned off elsewhere).
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);
  useEffect(() => {
    if (editing) select.current?.focus();
    else if (back.current) {
      (back.current === "line" ? line.current : opener.current)?.focus();
      back.current = null;
    }
  }, [editing]);
  function close(to: "line" | "opener") {
    back.current = to;
    setFailure(null);
    setEditing(false);
  }
  async function save() {
    if (value === hours) return close("opener");
    setBusy(true);
    setFailure(null);
    try {
      await update({ organizationId, companyId, minIntervalHours: value });
      close("line");
    } catch (e) {
      setFailure({ message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="capture-release">
      <div className="capture-release__row">
        <p ref={line} tabIndex={-1} className="capture-release__line">
          <strong>Captura fiscal ativa</strong>
          <span aria-hidden="true">·</span>
          <span>intervalo mínimo {hours} h</span>
        </p>
        {canManage && !editing ? (
          <div className="ui-actions">
            <Button
              ref={opener}
              size="sm"
              variant="ghost"
              onClick={() => {
                setValue(hours);
                setEditing(true);
              }}
            >
              Alterar intervalo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Desativar captura fiscal"
              onClick={onDisable}
            >
              Desativar
            </Button>
          </div>
        ) : null}
      </div>
      {editing ? (
        <form
          className="capture-release__editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) {
              e.preventDefault();
              close("opener");
            }
          }}
        >
          <FormField
            id={`${id}-interval`}
            label="Intervalo mínimo entre consultas"
            help="Diminuir vale a partir da próxima consulta: a que já está marcada não é antecipada. Aumentar também adia a próxima consulta automática quando a empresa já recebeu tudo."
          >
            <Select
              ref={select}
              id={`${id}-interval`}
              value={value}
              onChange={(e) => setValue(Number(e.target.value))}
              aria-describedby={`${id}-interval-help`}
            >
              {intervals.map((option) => (
                <option key={option} value={option}>
                  {hoursLabel(option)}
                </option>
              ))}
            </Select>
          </FormField>
          <div className="ui-actions">
            {/* The editor is a focused task: saving is its main action; the panel's quiets. */}
            <Button type="submit" variant="primary" loading={busy} loadingLabel="Salvando…">
              Salvar intervalo
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => close("opener")}>
              Cancelar
            </Button>
          </div>
          <ActionFailure failure={failure}>
            <Callout tone="danger">{failure?.message}</Callout>
          </ActionFailure>
        </form>
      ) : (
        <p className="ui-help">{intervalMeaning(hours)}</p>
      )}
      {acceptedTerms ? <AcceptedTerms {...acceptedTerms} /> : null}
      {!canManage ? (
        <p className="ui-help">
          Somente Proprietário ou Administrador muda o intervalo ou desativa a captura fiscal.
        </p>
      ) : null}
      {children}
    </div>
  );
}

/**
 * As referências que a Freecorps usa para suspender ou reativar a captura fiscal de uma empresa
 * (`capture-release-*.yml`, #424). O CNPJ basta; a organização só desfaz um CNPJ presente em mais
 * de uma organização. Usadas raramente, ficam recolhidas, como os outros detalhes técnicos.
 */
export function SupportReferences({
  organizationId,
  companyId,
}: {
  organizationId: Id<"organizations">;
  companyId: Id<"companies">;
}) {
  const reference = (value: string, label: string) => (
    <span className="gestao-reference">
      <code>{value}</code>
      <CopyButton value={value} label={label} iconOnly />
    </span>
  );
  return (
    <Disclosure summary="Referências para o suporte">
      <p className="ui-help">
        Ao falar com o suporte da Freecorps sobre a captura fiscal, informe o CNPJ da empresa. Se o
        suporte pedir, informe também estas referências.
      </p>
      <DescriptionList
        items={[
          {
            term: "Referência da organização",
            value: reference(organizationId, "Copiar referência da organização"),
          },
          {
            term: "Referência da empresa",
            value: reference(companyId, "Copiar referência da empresa"),
          },
        ]}
      />
    </Disclosure>
  );
}
