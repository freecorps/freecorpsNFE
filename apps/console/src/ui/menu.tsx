import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons";

type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";
const MenuContext = createContext<{ close: (returnFocus?: boolean) => void } | null>(null);

const items = (menu: HTMLElement | null) =>
  menu
    ? [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')]
    : [];

/**
 * Menu de ações (padrão WAI-ARIA "menu button"). Enter, Espaço e as setas abrem; as setas,
 * Home e End percorrem os itens; Esc fecha e devolve o foco ao botão; Tab ou um clique fora
 * fecham. O painel é `fixed`, posicionado pelo botão, para não ser cortado por áreas com rolagem.
 */
export function Menu({
  trigger,
  triggerClassName,
  triggerLabel,
  placement = "bottom-start",
  matchWidth = false,
  header,
  children,
}: {
  /** Conteúdo visível do botão. */
  trigger: ReactNode;
  triggerClassName?: string;
  /** Nome acessível, quando o conteúdo visível não basta. */
  triggerLabel?: string;
  placement?: Placement;
  /** O painel tem pelo menos a largura do botão (seletores). */
  matchWidth?: boolean;
  /** Texto fixo acima dos itens (quem está conectado), fora do papel `menu`. */
  header?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState<"first" | "last">("first");
  const [position, setPosition] = useState<CSSProperties>({});

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }, []);
  function show(target: "first" | "last") {
    setFocusOnOpen(target);
    setOpen(true);
  }
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const gap = 6;
    const [vertical, horizontal] = placement.split("-") as ["top" | "bottom", "start" | "end"];
    setPosition({
      ...(vertical === "bottom"
        ? { top: rect.bottom + gap }
        : { bottom: window.innerHeight - rect.top + gap }),
      ...(horizontal === "start"
        ? { left: Math.max(8, rect.left) }
        : { right: Math.max(8, window.innerWidth - rect.right) }),
      ...(matchWidth ? { minWidth: rect.width } : {}),
      ["--menu-origin" as string]: `${vertical === "bottom" ? "top" : "bottom"} ${horizontal === "start" ? "left" : "right"}`,
    });
  }, [open, placement, matchWidth]);
  useEffect(() => {
    if (!open) return;
    const list = items(menu.current);
    (focusOnOpen === "first" ? list[0] : list.at(-1))?.focus();
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) close(false);
    }
    // Rolar ou redimensionar desloca o botão: fecha em vez de deixar o painel solto.
    function moved(event: Event) {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      close(false);
    }
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
    };
  }, [open, focusOnOpen, close]);

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const list = items(menu.current);
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") close(false);
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      // Primeira letra: vai ao próximo item que começa com ela.
      const letter = event.key.toLocaleLowerCase("pt-BR");
      const after = [...list.slice(index + 1), ...list.slice(0, index + 1)];
      after
        .find((item) => item.textContent?.trim().toLocaleLowerCase("pt-BR").startsWith(letter))
        ?.focus();
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        id={`${id}-button`}
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-label={triggerLabel}
        onClick={() => (open ? close(false) : show("first"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            show("first");
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            show("last");
          }
        }}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <MenuContext.Provider value={{ close }}>
            <div ref={menu} className="ui-menu" style={position} onKeyDown={onMenuKey}>
              {header}
              <div id={`${id}-menu`} role="menu" aria-labelledby={`${id}-button`}>
                {children}
              </div>
            </div>
          </MenuContext.Provider>,
          document.body,
        )}
    </>
  );
}

function useMenu() {
  const context = useContext(MenuContext);
  if (!context) throw new Error("Item de menu fora de <Menu>");
  return context;
}

/** Item que executa uma ação e fecha o menu. `keepOpen` para "Carregar mais". */
export function MenuItem({
  icon,
  meta,
  onSelect,
  keepOpen = false,
  disabled = false,
  children,
}: {
  icon?: IconName;
  meta?: ReactNode;
  onSelect: () => void;
  keepOpen?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { close } = useMenu();
  return (
    <button
      type="button"
      role="menuitem"
      className="ui-menu__item"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) return;
        if (!keepOpen) close();
        onSelect();
      }}
    >
      {icon && <Icon name={icon} />}
      <span className="ui-menu__item-text">{children}</span>
      {meta && <span className="ui-menu__item-meta">{meta}</span>}
    </button>
  );
}

/** Opção exclusiva de um grupo (tema, organização atual). */
export function MenuRadioItem({
  icon,
  checked,
  meta,
  value,
  onSelect,
  children,
}: {
  icon?: IconName;
  checked: boolean;
  /** Identificador da opção (`data-value`), para quem automatiza a tela. */
  value?: string;
  meta?: ReactNode;
  onSelect: () => void;
  children: ReactNode;
}) {
  const { close } = useMenu();
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-value={value}
      className="ui-menu__item"
      tabIndex={-1}
      onClick={() => {
        close();
        onSelect();
      }}
    >
      {icon && <Icon name={icon} />}
      <span className="ui-menu__item-text">{children}</span>
      {meta && <span className="ui-menu__item-meta">{meta}</span>}
      {checked && <Icon name="check" className="ui-menu__item-check" />}
    </button>
  );
}

export function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <p id={id} className="ui-menu__label">
        {label}
      </p>
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="ui-menu__separator" />;
}

/** Texto informativo no topo do menu (quem está conectado). Não recebe foco. */
export function MenuHeader({ children }: { children: ReactNode }) {
  return <div className="ui-menu__header">{children}</div>;
}
