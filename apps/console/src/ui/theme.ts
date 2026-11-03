import { useSyncExternalStore } from "react";

/**
 * Tema do console por pessoa, neste navegador: Claro, Escuro ou Sistema. Só a preferência vai ao
 * localStorage. `public/theme.js` aplica a mesma regra antes da pintura; aqui ela é reaplicada
 * quando a pessoa troca a opção ou, em "Sistema", quando o sistema muda.
 */
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export const THEME_STORAGE_KEY = "fnfe:console-theme";
export const themeLabels: Record<ThemePreference, string> = {
  light: "Claro",
  dark: "Escuro",
  system: "Sistema",
};
/** Cor da barra do navegador em cada tema: o fundo do console. */
const themeColor: Record<ResolvedTheme, string> = { light: "#f7f8f4", dark: "#09100d" };

const listeners = new Set<() => void>();
const darkQuery = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  return darkQuery()?.matches ? "dark" : "light";
}
export function applyTheme(preference = readThemePreference()) {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  // Mesmos valores que `public/theme.js` põe antes do CSS carregar.
  root.style.colorScheme = resolved;
  root.style.backgroundColor = themeColor[resolved];
  // Com escolha explícita, a barra do navegador acompanha o tema e não o sistema.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    meta.content =
      preference === "system"
        ? themeColor[meta.media.includes("dark") ? "dark" : "light"]
        : themeColor[resolved];
}
export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Sem armazenamento, a escolha vale até recarregar.
  }
  applyTheme(preference);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const query = darkQuery();
  const onSystem = () => {
    if (readThemePreference() === "system") applyTheme("system");
    listener();
  };
  // Outra aba trocou o tema: acompanha.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    applyTheme();
    listener();
  };
  query?.addEventListener?.("change", onSystem);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    query?.removeEventListener?.("change", onSystem);
    window.removeEventListener("storage", onStorage);
  };
}
/** Preferência atual e o tema resolvido, atualizados quando qualquer um muda. */
export function useTheme() {
  const preference = useSyncExternalStore(subscribe, readThemePreference, () => "system" as const);
  const resolved = useSyncExternalStore(
    subscribe,
    () => resolveTheme(readThemePreference()),
    () => "light" as const,
  );
  return { preference, resolved, setPreference: setThemePreference };
}
