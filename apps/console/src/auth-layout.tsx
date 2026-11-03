import type { ReactNode } from "react";
import { deploymentLabel, version } from "./environment";
import { Icon, type IconName } from "./ui/icons";
import { StatusBadge } from "./ui/layout";
import { Menu, MenuRadioItem } from "./ui/menu";
import { themeLabels, useTheme, type ThemePreference } from "./ui/theme";

const themeIcon: Record<ThemePreference, IconName> = {
  light: "sun",
  dark: "moon",
  system: "monitor",
};

/** Tema também antes de entrar: a mesma preferência do menu da conta. */
function ThemeMenu() {
  const theme = useTheme();
  return (
    <Menu
      placement="bottom-end"
      triggerClassName="ui-button ui-button--ghost ui-button--sm"
      trigger={
        <>
          <Icon name={themeIcon[theme.preference]} />
          Tema: {themeLabels[theme.preference]}
        </>
      }
    >
      {(["light", "dark", "system"] as const).map((option) => (
        <MenuRadioItem
          key={option}
          icon={themeIcon[option]}
          checked={theme.preference === option}
          onSelect={() => theme.setPreference(option)}
        >
          {themeLabels[option]}
        </MenuRadioItem>
      ))}
    </Menu>
  );
}

/**
 * Entrada e conta (login, cadastro, verificação, recuperação): a marca, o perfil do build quando
 * há um e um cartão no centro. O rodapé traz a versão publicada. Sem selo fiscal: antes da
 * sessão não há dado na tela, e a disponibilidade fiscal depende da empresa (a captura liberada
 * da ADR 0007), não do deployment; o selo fica no console, onde a página diz o que mostra.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <header className="auth-top">
        {/* A landing (`/`) é servida fora da SPA: link comum, carga completa. */}
        <a href="/" className="app-brand" aria-label="Freecorps Fiscal, início">
          <span className="app-mark" aria-hidden="true">
            f
          </span>
          <span>
            freecorps <span className="app-brand__product">fiscal</span>
          </span>
        </a>
        <div className="ui-actions">
          {deploymentLabel && (
            <p className="app-env" title={`Versão ${version.slice(0, 7)}`}>
              <StatusBadge>{deploymentLabel}</StatusBadge>
            </p>
          )}
          <ThemeMenu />
        </div>
      </header>
      <main className="auth-center" id="main">
        <div>{children}</div>
      </main>
      <footer className="auth-footer">
        <span>Freecorps Fiscal</span>
        <span className="version" title={version}>
          Versão {version.slice(0, 7)}
        </span>
      </footer>
    </div>
  );
}
