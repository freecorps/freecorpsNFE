import { useEffect, useRef, useState } from "react";
import { buttonClass, type ButtonSize } from "./button";
import { Icon } from "./icons";

/**
 * O único controle de cópia do console (chave de acesso, referência, segredo, exemplo): copia e
 * diz que copiou; sem acesso à área de transferência, pede a cópia manual em vez de fingir.
 * `iconOnly` segue o `IconButton`: fantasma, só o ícone, com `label` como nome acessível e dica,
 * para referências secundárias em que o rótulo pesaria mais que o próprio valor.
 */
export function CopyButton({
  value,
  label = "Copiar",
  size = "sm",
  iconOnly = false,
}: {
  value: string;
  label?: string;
  size?: ButtonSize;
  iconOnly?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    window.clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("clipboard");
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 4000);
  }
  return (
    <span className="ui-copy">
      <button
        type="button"
        className={buttonClass({ variant: iconOnly ? "ghost" : "secondary", size, iconOnly })}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
        onClick={() => void copy()}
      >
        <Icon name={state === "copied" ? "check" : "copy"} />
        {!iconOnly && label}
      </button>
      <span role="status" className="ui-copy__feedback" data-state={state}>
        {state === "copied"
          ? "Copiado."
          : state === "failed"
            ? "Não foi possível copiar. Selecione o texto e copie manualmente."
            : ""}
      </span>
    </span>
  );
}
