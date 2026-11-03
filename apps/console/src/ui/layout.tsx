import { useId, type ReactNode, type Ref } from "react";
import { IconButton } from "./button";
import { Icon, type IconName } from "./icons";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";
type Heading = 2 | 3 | 4;
function H({
  level,
  ...props
}: {
  level: Heading;
  id?: string;
  className: string;
  ref?: Ref<HTMLHeadingElement>;
  tabIndex?: number;
  children: ReactNode;
}) {
  const Tag = `h${level}` as const;
  return <Tag {...props} />;
}

/** Cabeçalho da página: um h1 por tela, com a descrição e as ações principais. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="ui-page-header">
      <div className="ui-page-header__text">
        {eyebrow && <p className="ui-page-header__eyebrow">{eyebrow}</p>}
        <h1 className="ui-page-header__title">{title}</h1>
        {description && <p className="ui-page-header__description">{description}</p>}
      </div>
      {actions && <div className="ui-page-header__actions">{actions}</div>}
    </header>
  );
}

/** Página no shell novo: largura limitada e espaço entre seções. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="ui-page">{children}</div>;
}

/**
 * Cartão: a superfície que flutua um pouco sobre o fundo. Com `title`, vira uma seção nomeada
 * pelo título (`aria-labelledby`).
 */
export function Card({
  title,
  description,
  actions,
  headingLevel = 2,
  flush = false,
  flat = false,
  className,
  label,
  id: sectionId,
  titleRef,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingLevel?: Heading;
  /** Sem padding interno: tabelas e listas que vão até a borda. */
  flush?: boolean;
  /** Sem sombra, só o anel: cartões dentro de áreas já elevadas. */
  flat?: boolean;
  className?: string;
  /** Nome da região quando não há título visível. */
  label?: string;
  /** Âncora da seção (`#id` na URL). */
  id?: string;
  /** Título focável (`tabIndex=-1`): para levar o foco à seção ao chegar por um atalho. */
  titleRef?: Ref<HTMLHeadingElement>;
  children?: ReactNode;
}) {
  const id = useId();
  const classes = ["ui-card", flush && "ui-card--flush", flat && "ui-card--flat", className]
    .filter(Boolean)
    .join(" ");
  if (!title)
    return label ? (
      <section className={classes} id={sectionId} aria-label={label}>
        {children}
      </section>
    ) : (
      <div className={classes} id={sectionId}>
        {children}
      </div>
    );
  return (
    <section className={classes} id={sectionId} aria-labelledby={`${id}-title`}>
      <div className="ui-card__header">
        <div>
          <H
            level={headingLevel}
            id={`${id}-title`}
            className="ui-card__title"
            ref={titleRef}
            tabIndex={titleRef ? -1 : undefined}
          >
            {title}
          </H>
          {description && <p className="ui-card__description">{description}</p>}
        </div>
        {actions && <div className="ui-actions">{actions}</div>}
      </div>
      {flush ? children : <div className="ui-card__body">{children}</div>}
    </section>
  );
}

/** Rótulo e valor, como uma tabela leve. */
export function DescriptionList({
  items,
  className,
}: {
  items: Array<{ term: ReactNode; value: ReactNode; key?: string }>;
  className?: string;
}) {
  return (
    <dl className={className ? `ui-dl ${className}` : "ui-dl"}>
      {items.map((item, index) => (
        <div className="ui-dl__row" key={item.key ?? index}>
          <dt>{item.term}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Situação com texto: a cor nunca é a única informação. */
export function StatusBadge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`ui-badge ui-badge--${tone}`}>{children}</span>;
}

const calloutIcon: Record<Exclude<Tone, "neutral">, IconName> = {
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
};
/**
 * Aviso no fluxo da página. `role` só quando o aviso aparece em resposta a uma ação
 * (`alert` para falha, `status` para confirmação); avisos fixos não interrompem o leitor.
 */
export function Callout({
  tone = "info",
  title,
  children,
  actions,
  role,
  headingLevel,
  onDismiss,
  dismissLabel = "Fechar aviso",
}: {
  tone?: Exclude<Tone, "neutral">;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  role?: "alert" | "status";
  /** O título vira um título da página (h2–h4) quando o aviso ocupa o lugar de uma seção. */
  headingLevel?: Heading;
  /** Aviso que a pessoa pode fechar: um "x" no canto; quem chama decide quando ele volta. */
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  return (
    <div
      className={`ui-callout ui-callout--${tone}${onDismiss ? " ui-callout--dismissible" : ""}`}
      role={role}
    >
      <Icon name={calloutIcon[tone]} />
      <div className="ui-callout__body">
        {title &&
          (headingLevel ? (
            <H level={headingLevel} className="ui-callout__title">
              {title}
            </H>
          ) : (
            <p className="ui-callout__title">{title}</p>
          ))}
        {children && <div className={title ? "ui-callout__content" : undefined}>{children}</div>}
        {actions && <div className="ui-callout__actions">{actions}</div>}
      </div>
      {onDismiss ? (
        <IconButton
          icon="close"
          size="sm"
          label={dismissLabel}
          className="ui-callout__dismiss"
          onClick={onDismiss}
        />
      ) : null}
    </div>
  );
}

/** Lista vazia ou primeiro uso: o que vai aparecer aqui e a ação que começa. */
export function EmptyState({
  icon = "inbox",
  title,
  description,
  actions,
  headingLevel = 2,
}: {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingLevel?: Heading;
}) {
  return (
    <div className="ui-empty">
      <span className="ui-empty__icon">
        <Icon name={icon} />
      </span>
      <H level={headingLevel} className="ui-empty__title">
        {title}
      </H>
      {description && <p className="ui-empty__description">{description}</p>}
      {actions && <div className="ui-empty__actions">{actions}</div>}
    </div>
  );
}

/**
 * Por que a ação está indisponível, ao lado do botão. Ligue o botão a este texto com
 * `aria-describedby={id}`: um botão desabilitado não recebe foco, o texto continua visível.
 * Uma cópia visível do mesmo motivo, perto de outro controle, vai com `aria-hidden` e sem `id`:
 * o controle aponta para o original, e a leitura não repete a frase.
 */
export function DisabledReason({
  id,
  children,
  "aria-hidden": hidden,
}: {
  id?: string;
  children: ReactNode;
  "aria-hidden"?: true;
}) {
  return (
    <p id={id} className="ui-disabled-reason" aria-hidden={hidden}>
      <Icon name="info" />
      <span>{children}</span>
    </p>
  );
}

/** Espaço reservado enquanto carrega. O texto para o leitor de tela fica em `label`. */
export function Skeleton({
  width = "100%",
  height = 12,
  className,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
}) {
  return (
    <span
      className={className ? `ui-skeleton ${className}` : "ui-skeleton"}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
export function SkeletonBlock({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div className="ui-stack" role="status" aria-live="polite">
      <span className="ui-visually-hidden">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} width={index === lines - 1 ? "60%" : "100%"} />
      ))}
    </div>
  );
}
