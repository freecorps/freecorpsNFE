import type { ComponentPropsWithRef, ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

/** Classes do botão, também para links com cara de botão (`<Link className={buttonClass()}>`). */
export function buttonClass({
  variant = "secondary",
  size = "md",
  block = false,
  iconOnly = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  iconOnly?: boolean;
  className?: string;
} = {}) {
  return [
    "ui-button",
    `ui-button--${variant}`,
    size !== "md" && `ui-button--${size}`,
    block && "ui-button--block",
    iconOnly && "ui-button--icon",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

type ButtonProps = Omit<ComponentPropsWithRef<"button">, "children"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  /** Ícone antes do texto. */
  icon?: IconName;
  /** Enquanto espera o servidor: fica desabilitado, mostra o indicador e `loadingLabel`. */
  loading?: boolean;
  loadingLabel?: ReactNode;
  children: ReactNode;
};

/**
 * Botão do console. `type="button"` por padrão: só envia formulário quando pedido. Com
 * `loading`, desabilita para não repetir o pedido e diz o que aguarda.
 */
export function Button({
  variant = "secondary",
  size = "md",
  block,
  icon,
  loading = false,
  loadingLabel,
  className,
  type = "button",
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={buttonClass({ variant, size, block, className })}
      disabled={disabled || loading}
      aria-busy={loading || rest["aria-busy"] || undefined}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : icon && <Icon name={icon} />}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}

/** Botão só com ícone: o nome acessível vem de `label`. */
export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "md",
  className,
  type = "button",
  ...rest
}: Omit<ComponentPropsWithRef<"button">, "children"> & {
  icon: IconName;
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      className={buttonClass({ variant, size, iconOnly: true, className })}
    >
      <Icon name={icon} />
    </button>
  );
}
