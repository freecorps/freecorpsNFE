import type { ComponentPropsWithRef, ReactNode } from "react";
import { Icon } from "./icons";

export { controlProps, describedBy, ErrorSummary, focusField, type FieldErrors } from "../field";

/**
 * Campo com rótulo, ajuda e erro próprios. O controle de dentro recebe `controlProps(id, error,
 * help)` de `field.tsx`, que liga `aria-invalid` e `aria-describedby` a estes textos.
 */
export function FormField({
  id,
  label,
  help,
  error,
  optional = false,
  children,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="ui-field">
      <label className="ui-label" htmlFor={id}>
        {label}
        {optional && <span className="ui-label__optional"> (opcional)</span>}
      </label>
      {children}
      {help && (
        <p id={`${id}-help`} className="ui-help">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="ui-error-text">
          <Icon name="danger" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export function Input({ className, ...props }: ComponentPropsWithRef<"input">) {
  return <input {...props} className={className ? `ui-input ${className}` : "ui-input"} />;
}

export function Textarea({ className, ...props }: ComponentPropsWithRef<"textarea">) {
  return <textarea {...props} className={className ? `ui-textarea ${className}` : "ui-textarea"} />;
}

/** Select nativo (teclado e leitor de tela do sistema), com a seta desenhada pelo tema. */
export function Select({ className, children, ...props }: ComponentPropsWithRef<"select">) {
  return (
    <span className="ui-select-wrap">
      <select {...props} className={className ? `ui-select ${className}` : "ui-select"}>
        {children}
      </select>
      <Icon name="chevronDown" />
    </span>
  );
}

export function Checkbox({
  label,
  help,
  ...props
}: Omit<ComponentPropsWithRef<"input">, "type"> & { label: ReactNode; help?: ReactNode }) {
  return (
    <label className="ui-checkbox">
      <input {...props} type="checkbox" />
      <span>
        {label}
        {help && <span className="ui-checkbox__help">{help}</span>}
      </span>
    </label>
  );
}
