import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ConvexError } from "convex/values";
import { Button } from "./ui/button";
import { Callout, StatusBadge } from "./ui/layout";

/** The console works on a company: choose it, then act. Projects belong to the integrations. */
export function ScopeSteps({ company, finalLabel }: { company: boolean; finalLabel: string }) {
  const current = !company ? 0 : 1;
  return (
    <ol className="fiscal-steps" aria-label="Etapas">
      {["Escolher empresa", finalLabel].map((label, index) => (
        <li key={label} aria-current={index === current ? "step" : undefined}>
          <span className="fiscal-steps__number" aria-hidden="true">
            {index + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

/** O controle de cópia e a paginação por cursor vivem em `ui/`; reexportados para as telas antigas. */
export { CopyButton } from "./ui/copy-button";
export { CursorPager, firstPage, type PageCursor } from "./ui/pagination";

/**
 * A list that gives the page to one of its records and comes back: the list stays mounted (and
 * hidden) under the record while `mounted`, and the scroll returns to where the person left it.
 * `leave` runs before opening the record; closing navigates with `resetScroll: false` and the
 * position comes back when the list shows again.
 */
export function useListPosition(listVisible: boolean) {
  const position = useRef<number | null>(null);
  // A record opened straight from its address has no list behind it yet: the list mounts the
  // first time it shows and stays from then on.
  const [kept, setKept] = useState(listVisible);
  if (listVisible && !kept) setKept(true);
  useLayoutEffect(() => {
    if (!listVisible || position.current === null) return;
    window.scrollTo(0, position.current);
    position.current = null;
  }, [listVisible]);
  const leave = useCallback(() => {
    position.current = window.scrollY;
  }, []);
  return { mounted: kept || listVisible, leave };
}

/**
 * The current time, refreshed when `deadline` passes, so a button waiting for a server date
 * (next allowed consultation) enables itself without polling the server.
 */
export function useNow(deadline: number | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (deadline === null || deadline <= now) return;
    // setTimeout caps at ~24.8 days; a later deadline re-arms on the next render.
    const timer = setTimeout(() => setNow(Date.now()), Math.min(deadline - now + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [deadline, now]);
  return now;
}

/**
 * Why an action failed, next to its buttons. Each new `failure` (a new value per refusal) takes
 * the focus: the button that started the action was disabled while waiting and lost it. Moving
 * the focus is what reads the notice out, so the notice inside has no `role="alert"`: a live
 * region on top of the focus would read the same text twice.
 */
export function ActionFailure({ failure, children }: { failure: unknown; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure) ref.current?.focus();
  }, [failure]);
  if (!failure) return null;
  return (
    <div ref={ref} tabIndex={-1} className="fiscal-submit-reason">
      {children}
    </div>
  );
}

/** Who created a record, from the server (`recordOrigin`). */
export type RecordOrigin = { kind: "console" | "integration"; integration: string | null };
export const originLabel = (origin: RecordOrigin) =>
  origin.kind === "console"
    ? "Console"
    : origin.integration
      ? `Integração ${origin.integration}`
      : "Integração";
/** Why the console offers no change on an integration's record; the server refuses it too. */
export const integrationManaged = (origin: RecordOrigin) =>
  `${origin.integration ? `Criado pela integração ${origin.integration}` : "Criado por uma integração"}; gerencie pela integração. O console altera só o que foi criado nele.`;
export function OriginLabel({ origin }: { origin: RecordOrigin }) {
  return <StatusBadge tone="neutral">Origem: {originLabel(origin)}</StatusBadge>;
}

/** Saves a blob through a temporary link attached to the page; the URL lives long enough. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking right after the click can cancel a download the browser has not started yet.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type Phase =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "downloading" }
  | { phase: "done"; message: string }
  | { phase: "failed"; message: string };
/** Seconds each step waits before saying it did not answer, instead of spinning forever. */
export const DOWNLOAD_TICKET_TIMEOUT = 20_000;
export const DOWNLOAD_FETCH_TIMEOUT = 45_000;
class Timeout extends Error {}
function within<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
function ticketFailure(error: unknown, label: string) {
  if (error instanceof Timeout)
    return `A preparação do ${label} não respondeu. Confira sua conexão e tente de novo.`;
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code = data && typeof data === "object" && "code" in data ? String(data.code) : "";
  if (code === "RATE_LIMITED")
    return `Muitos downloads em sequência. Aguarde um minuto e tente o ${label} de novo.`;
  if (code === "NOT_FOUND" || code === "SCOPE_DENIED")
    return `${label[0]!.toUpperCase()}${label.slice(1)} indisponível ou seu acesso mudou.`;
  return `Não foi possível preparar o ${label}. Tente de novo.`;
}

/**
 * Download through a one-minute ticket (`documentDownloads`): asks the ticket, redeems it at
 * `/v1/document-download` with the token in a header and saves the bytes. Each step has a time
 * limit and its own message; a new attempt asks a new ticket. Leaving the screen aborts it.
 */
export function useTicketDownload() {
  const [state, setState] = useState<Phase>({ phase: "idle" });
  const attempt = useRef(0),
    controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      attempt.current++;
      controller.current?.abort();
    },
    [],
  );
  async function start(
    ticket: () => Promise<{ token: string }>,
    options: { name: string; label: string; save?: boolean; conflict?: string },
  ): Promise<Blob | null> {
    const id = ++attempt.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const live = () => attempt.current === id;
    setState({ phase: "preparing" });
    let token: string;
    try {
      token = (await within(ticket(), DOWNLOAD_TICKET_TIMEOUT)).token;
    } catch (error) {
      if (live()) setState({ phase: "failed", message: ticketFailure(error, options.label) });
      return null;
    }
    if (!live()) return null;
    setState({ phase: "downloading" });
    const timer = setTimeout(() => abort.abort(), DOWNLOAD_FETCH_TIMEOUT);
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/v1/document-download`, {
        headers: { "X-Download-Token": token },
        signal: abort.signal,
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? `${options.label[0]!.toUpperCase()}${options.label.slice(1)} indisponível ou seu acesso mudou.`
            : response.status === 409 && options.conflict
              ? options.conflict
              : `O servidor não entregou o ${options.label} (HTTP ${response.status}). Tente de novo.`,
        );
      const blob = await response.blob();
      if (!live()) return null;
      if (options.save !== false) saveBlob(blob, options.name);
      setState({
        phase: "done",
        message:
          options.save !== false
            ? `Download de ${options.name} iniciado. Confira a pasta de downloads do navegador.`
            : "",
      });
      return blob;
    } catch (error) {
      if (live())
        setState({
          phase: "failed",
          message: abort.signal.aborted
            ? `O ${options.label} não chegou a tempo. Confira sua conexão e tente de novo.`
            : error instanceof Error && error.message
              ? error.message
              : `Falha de conexão ao baixar o ${options.label}. Tente de novo.`,
        });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  const busy = state.phase === "preparing" || state.phase === "downloading";
  return { state, busy, start };
}

/** Feedback of `useTicketDownload`, next to the button: in progress, done or failed. */
export function DownloadFeedback({
  state,
  onRetry,
}: {
  state: ReturnType<typeof useTicketDownload>["state"];
  onRetry: () => void;
}) {
  if (state.phase === "preparing" || state.phase === "downloading")
    return (
      <p role="status" className="ui-help">
        {state.phase === "preparing" ? "Preparando o download…" : "Baixando o arquivo…"}
      </p>
    );
  if (state.phase === "done" && state.message)
    return (
      <p role="status" className="ui-help">
        {state.message}
      </p>
    );
  if (state.phase === "failed")
    return (
      <Callout
        tone="danger"
        role="alert"
        actions={
          <Button size="sm" onClick={onRetry}>
            Tentar de novo
          </Button>
        }
      >
        <p>{state.message}</p>
      </Callout>
    );
  return null;
}
