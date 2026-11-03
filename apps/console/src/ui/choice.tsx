import type { ComponentPropsWithRef, ReactNode } from "react";

/**
 * Opção de um grupo de rádios em cartão: rótulo forte e ajuda curta, o rádio nativo continua
 * recebendo o foco e as setas. Coloque as opções num elemento `role="radiogroup"` com nome
 * (`aria-label` ou `aria-labelledby`) e classe `ui-choice-group`.
 */
export function RadioCard({
  label,
  help,
  className,
  ...props
}: Omit<ComponentPropsWithRef<"input">, "type"> & { label: ReactNode; help?: ReactNode }) {
  return (
    <label className={className ? `ui-choice ${className}` : "ui-choice"}>
      <input {...props} type="radio" />
      <span className="ui-choice__text">
        <span className="ui-choice__label">{label}</span>
        {help && <span className="ui-choice__help">{help}</span>}
      </span>
    </label>
  );
}
