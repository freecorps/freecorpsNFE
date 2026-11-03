/** Foco dentro de diálogos, gavetas e menus: o que recebe Tab e como prendê-lo. */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusableIn(container: HTMLElement | null) {
  if (!container) return [];
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest("[inert]") && !element.hasAttribute("hidden"),
  );
}

/** Mantém Tab e Shift+Tab dentro do contêiner. Devolve true quando tratou a tecla. */
export function trapTab(
  event: { key: string; shiftKey: boolean; preventDefault(): void },
  container: HTMLElement | null,
) {
  if (event.key !== "Tab" || !container) return false;
  const items = focusableIn(container);
  if (!items.length) {
    event.preventDefault();
    container.focus();
    return true;
  }
  const first = items[0]!,
    last = items[items.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/**
 * Enquanto uma camada modal está aberta, o resto do console fica `inert` (fora do Tab e do leitor
 * de tela). Conta as camadas abertas para que fechar uma não libere a outra.
 */
let layers = 0;
export function holdModalLayer() {
  const root = typeof document === "undefined" ? null : document.getElementById("root");
  layers++;
  root?.setAttribute("inert", "");
  return () => {
    layers = Math.max(0, layers - 1);
    if (!layers) root?.removeAttribute("inert");
  };
}

/**
 * Devolve o foco a quem abriu, se ainda estiver na página. O Safari não foca o botão no clique:
 * quem abriu fica sendo o `body`, e o foco vai para `fallback`, como se o botão tivesse saído.
 */
export function restoreFocus(target: Element | null, fallback?: HTMLElement | null) {
  const element =
    target instanceof HTMLElement && target !== document.body && target.isConnected
      ? target
      : fallback;
  element?.focus({ preventScroll: true });
}
