import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";
import { holdModalLayer, restoreFocus, trapTab } from "./focus";

/**
 * Confirmação modal de uma ação com efeito. Abre com o foco em "Cancelar" (a opção segura),
 * prende o Tab, fecha com Esc ou no fundo e devolve o foco a quem abriu. O resto do console
 * fica `inert` enquanto está aberta. `onConfirm` resolve com a mensagem de erro, ou vazio no
 * sucesso; o diálogo espera o servidor e não fecha numa recusa.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  busyLabel = "Aguarde…",
  cancelLabel = "Cancelar",
  tone = "danger",
  onConfirm,
  returnFocusTo,
  settleMs = 0,
  initialFocus,
  confirmDisabled = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  onConfirm: () => Promise<string>;
  /** Para onde vai o foco se quem abriu sumiu (por exemplo, a linha removida). */
  returnFocusTo?: () => HTMLElement | null;
  /**
   * Tempo, depois de abrir, em que cliques no fundo e nos botões não contam, nem cliques
   * repetidos (`detail > 1`): o segundo clique ou toque de quem abriu com clique duplo não fecha
   * nem confirma. Zero mantém o comportamento de sempre.
   */
  settleMs?: number;
  /** Campo que recebe o foco ao abrir, quando a decisão pede um dado; senão, o Cancelar. */
  initialFocus?: () => HTMLElement | null;
  /** Confirmar fica desabilitado enquanto falta o dado que a decisão pede. */
  confirmDisabled?: boolean;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const openedAt = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    mounted.current = true;
    opener.current = document.activeElement;
    openedAt.current = Date.now();
    const release = holdModalLayer();
    (initialFocus?.() ?? cancel.current)?.focus();
    return () => {
      release();
      restoreFocus(opener.current, returnFocusTo?.());
    };
    // returnFocusTo and initialFocus are read when opening or closing, not a reason to reopen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open || typeof document === "undefined") return null;
  /** A click that belongs to the gesture that opened the dialog, not a decision. */
  function settling(event: { detail: number }) {
    return settleMs > 0 && (event.detail > 1 || Date.now() - openedAt.current < settleMs);
  }
  function close() {
    if (busy) return;
    setError("");
    onOpenChange(false);
  }
  async function confirm() {
    // The buttons are disabled while waiting: keep the focus inside the dialog.
    panel.current?.focus();
    setBusy(true);
    setError("");
    let failure: string;
    try {
      failure = await onConfirm();
    } catch {
      failure = "Não foi possível concluir. Confira sua conexão e tente novamente.";
    }
    if (!mounted.current) return;
    setBusy(false);
    if (failure) setError(failure);
    else onOpenChange(false);
  }
  return createPortal(
    <div
      className="ui-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !settling(event)) close();
      }}
    >
      <div
        ref={panel}
        className="ui-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-description` : undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
            return;
          }
          trapTab(event, panel.current);
        }}
      >
        <h2 id={`${id}-title`} className="ui-dialog__title">
          {title}
        </h2>
        {description && (
          <p id={`${id}-description`} className="ui-dialog__description">
            {description}
          </p>
        )}
        {children && <div className="ui-dialog__body">{children}</div>}
        {error && (
          <p className="ui-error-text" role="alert">
            {error}
          </p>
        )}
        <div className="ui-dialog__actions">
          <Button
            ref={cancel}
            variant="secondary"
            onClick={(event) => {
              if (!settling(event)) close();
            }}
            disabled={busy}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone}
            loading={busy}
            loadingLabel={busyLabel}
            disabled={confirmDisabled}
            onClick={(event) => {
              if (!settling(event)) void confirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
        {busy && (
          <p className="ui-visually-hidden" role="status">
            Aguardando a confirmação do servidor.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
