import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import { TERMS_OF_USE_ARCHIVE } from "../../../platform/convex/lib/termsOfUseArchive";
import { TermsText } from "./capture-terms";
import { formatIsoDate } from "./format";
import { safeRedirect } from "./session-handoff";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
import { Checkbox } from "./ui/form";
import { Callout } from "./ui/layout";

/**
 * The terms of use as archived (#586), operator clause included: `docs/termos/arquivo/<version>.md`
 * is the only copy of each text, and the console shows those bytes, like the capture terms. The
 * server keeps the SHA-256 of each version (`TERMS_OF_USE_ARCHIVE`) and records it with the
 * acceptance; `terms-of-use.test.tsx` fails if a file and its hash part ways. Until D06 no version
 * exists, and nothing here is shown.
 */
const files = import.meta.glob<string>("../../../docs/termos/arquivo/termos-de-uso-*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
export const archivedTermsOfUse: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1, -3), text]),
);

/** "22/10/2026": the day the version entered the console, how people name the terms. */
export const termsOfUseDate = (version: string) => {
  const since = TERMS_OF_USE_ARCHIVE[version]?.since;
  return since ? formatIsoDate(since) : null;
};
/** The day a version takes effect, from the server's `effectiveAt` (midnight in Brasília). */
export const effectiveDate = (effectiveAt: number) =>
  formatIsoDate(new Date(effectiveAt).toISOString());

/** The archived text of a version, or a warning when this page does not have it. */
export function TermsOfUseText({ version }: { version: string }) {
  const text = archivedTermsOfUse[version];
  if (text === undefined)
    return (
      <Callout tone="warning">
        Esta página não tem o texto da versão {version} dos termos de uso. Recarregue a página para
        ler os termos antes de aceitar.
      </Callout>
    );
  return (
    <div className="ui-stack">
      {/* The text scrolls inside the dialog: focusable, so the keyboard scrolls it too. */}
      <div
        className="terms-of-use__text"
        tabIndex={0}
        role="region"
        aria-label={`Texto dos termos de uso de ${termsOfUseDate(version)}`}
      >
        <TermsText text={text} />
      </div>
      <p className="ui-help">Termos de uso de {termsOfUseDate(version)}.</p>
    </div>
  );
}

/** Link to the archived text of a version, on its own page, returning to where it was opened. */
export function TermsOfUseLink({ version, children }: { version: string; children: ReactNode }) {
  const here = safeRedirect(window.location.pathname + window.location.search);
  return (
    <Link
      className="ui-link"
      to="/termos/uso/$version"
      params={{ version }}
      search={here ? { voltar: here } : {}}
    >
      {children}
    </Link>
  );
}

/**
 * The creation form's acceptance: while a version is current, the text, the link to its page and
 * the box an owner checks. Without the text of the version the server asks for, nothing can be
 * checked.
 */
export function TermsOfUseAcceptance({
  version,
  accepted,
  onChange,
  disabled,
}: {
  version: string;
  accepted: boolean;
  onChange: (accepted: boolean) => void;
  disabled?: boolean;
}) {
  const shown = archivedTermsOfUse[version] !== undefined;
  return (
    <div className="ui-stack">
      <TermsOfUseText version={version} />
      <Checkbox
        checked={accepted && shown}
        disabled={disabled || !shown}
        required
        onChange={(event) => onChange(event.target.checked)}
        label="Li e aceito os termos de uso, com a cláusula de operadora, e declaro que posso representar a organização"
      />
    </div>
  );
}

function failure(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code =
    data && typeof data === "object" && "code" in data && typeof data.code === "string"
      ? data.code
      : null;
  if (code === "TERMS_OF_USE_OUTDATED")
    return "Os termos mudaram enquanto a página estava aberta. Recarregue a página e leia a versão atual.";
  if (code === "RATE_LIMITED") return "Muitas tentativas. Aguarde um minuto e tente novamente.";
  if (code === "ACCESS_DENIED") return "Só um proprietário da organização aceita os termos de uso.";
  return "Não foi possível concluir. Confira sua conexão e tente novamente.";
}

/**
 * Notice of a version the organization has not accepted (terms of use, section 11): before it
 * takes effect, the date; after, that new commands stop until an owner accepts. Owners read and
 * accept here; the other roles read the text and are told who accepts.
 */
export function TermsOfUseNotice({
  organizationId,
  role,
  pending,
  now = Date.now(),
}: {
  organizationId: Id<"organizations">;
  role: string;
  pending: { version: string; effectiveAt: number };
  now?: number;
}) {
  const accept = useMutation(api.termsOfUse.accept);
  const [open, setOpen] = useState(false),
    // The version whose box was checked, so a newer pending version starts unchecked.
    [acceptedVersion, setAcceptedVersion] = useState<string | null>(null);
  const accepted = acceptedVersion === pending.version;
  const owner = role === "owner";
  const expired = now >= pending.effectiveAt;
  const date = effectiveDate(pending.effectiveAt);
  const shown = archivedTermsOfUse[pending.version] !== undefined;
  return (
    <div className="gestao-closure">
      <Callout
        tone={expired ? "danger" : "warning"}
        role={expired ? "alert" : "status"}
        title={expired ? "Termos de uso pendentes." : "Novos termos de uso."}
        actions={
          owner ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              Ler e aceitar
            </Button>
          ) : (
            <TermsOfUseLink version={pending.version}>Ler os termos</TermsOfUseLink>
          )
        }
      >
        <p>
          {expired
            ? `Os termos de uso de ${termsOfUseDate(pending.version)} valem desde ${date}. Até que um proprietário os aceite, a organização não cria operações novas; a leitura, a exportação e os pedidos de titulares continuam.`
            : `Os termos de uso de ${termsOfUseDate(pending.version)} passam a valer em ${date}. Sem o aceite de um proprietário até lá, a organização deixa de criar operações novas.`}
          {owner ? "" : " Só um proprietário da organização aceita os termos."}
        </p>
      </Callout>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setAcceptedVersion(null);
        }}
        title="Termos de uso"
        tone="primary"
        confirmLabel="Aceitar os termos"
        busyLabel="Registrando…"
        confirmDisabled={!accepted || !shown}
        onConfirm={async () => {
          try {
            await accept({ organizationId, terms: pending.version });
            return "";
          } catch (error) {
            return failure(error);
          }
        }}
      >
        <TermsOfUseAcceptance
          version={pending.version}
          accepted={accepted}
          onChange={(checked) => setAcceptedVersion(checked ? pending.version : null)}
        />
      </ConfirmDialog>
    </div>
  );
}
