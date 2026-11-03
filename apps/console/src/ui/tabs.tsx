import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type TabItem = { id: string; label: ReactNode; content: ReactNode };

/** Classe do link de uma `TabNav`, para `<Link className={tabLinkClass} aria-current>`. */
export const tabLinkClass = "ui-tabs__tab";
/**
 * Abas que são rotas: uma navegação com links, no mesmo visual das `Tabs`. Cada item é um `<li>`
 * com um link `tabLinkClass`; a aba atual leva `aria-current="page"`. Use quando cada aba tem
 * endereço próprio (voltar e recarregar abrem a mesma aba); `Tabs`, quando é só estado da tela.
 */
export function TabNav({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className="ui-tabnav">
      <ul className="ui-tabs__list">{children}</ul>
    </nav>
  );
}

/**
 * Abas (padrão WAI-ARIA, ativação automática): setas, Home e End trocam e focam a aba; só o
 * painel ativo é montado. Controlada (`value`/`onValueChange`, para guardar a aba na URL) ou não.
 */
export function Tabs({
  label,
  tabs,
  value,
  defaultValue,
  onValueChange,
}: {
  label: string;
  tabs: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (id: string) => void;
}) {
  const base = useId();
  const [own, setOwn] = useState(defaultValue ?? tabs[0]?.id);
  const selected = tabs.some((tab) => tab.id === (value ?? own)) ? (value ?? own) : tabs[0]?.id;
  const refs = useRef(new Map<string, HTMLButtonElement>());
  function select(id: string) {
    if (value === undefined) setOwn(id);
    onValueChange?.(id);
    refs.current.get(id)?.focus();
  }
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === selected);
    const next =
      event.key === "ArrowRight"
        ? index + 1
        : event.key === "ArrowLeft"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length]!.id);
  }
  const active = tabs.find((tab) => tab.id === selected);
  return (
    <div className="ui-tabs">
      <div className="ui-tabs__list" role="tablist" aria-label={label} onKeyDown={onKey}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            ref={(element) => {
              if (element) refs.current.set(tab.id, element);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={tab.id === selected}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={tab.id === selected ? 0 : -1}
            className="ui-tabs__tab"
            onClick={() => select(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {active && (
        <div
          className="ui-tabs__panel"
          role="tabpanel"
          id={`${base}-panel-${active.id}`}
          aria-labelledby={`${base}-tab-${active.id}`}
          tabIndex={0}
        >
          {active.content}
        </div>
      )}
    </div>
  );
}
