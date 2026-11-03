/**
 * Texto técnico preformatado (JSON, XML): fonte mono, rolagem própria e foco por teclado para
 * rolar. O conteúdo é texto do React, nunca HTML; `label` dá o nome quando não há título perto.
 */
export function CodeBlock({
  children,
  label,
  className,
}: {
  children: string;
  label?: string;
  className?: string;
}) {
  return (
    <pre className={className ? `ui-code ${className}` : "ui-code"} tabIndex={0} aria-label={label}>
      {children}
    </pre>
  );
}

/** Barra de progresso com nome acessível; o valor vai de 0 a `max`. */
export function Progress({
  value,
  max = 100,
  label,
}: {
  value: number;
  max?: number;
  label: string;
}) {
  return <progress className="ui-progress" value={value} max={max} aria-label={label} />;
}
