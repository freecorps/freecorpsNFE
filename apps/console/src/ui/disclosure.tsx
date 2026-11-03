import type { ReactNode } from "react";
import { Icon } from "./icons";

/**
 * Trecho recolhível (`details`/`summary` nativos: teclado e leitor de tela do navegador). Para
 * detalhes secundários — evidências, JSON, histórico — que não precisam disputar a atenção.
 * Controlado quando recebe `open`/`onOpenChange` (por exemplo, para só consultar ao abrir).
 */
export function Disclosure({
  summary,
  children,
  open,
  defaultOpen,
  onOpenChange,
  className,
}: {
  summary: ReactNode;
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  return (
    <details
      className={className ? `ui-disclosure ${className}` : "ui-disclosure"}
      open={open ?? defaultOpen}
      onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
    >
      <summary className="ui-disclosure__summary">
        <Icon name="chevronDown" />
        <span>{summary}</span>
      </summary>
      <div className="ui-disclosure__body">{children}</div>
    </details>
  );
}
