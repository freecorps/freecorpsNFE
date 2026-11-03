import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

// The guides show the repository link as visible text marked private, like the landing, until
// the repository is published (#518). It opens in the same tab, as the landing's does.
export const repository = "https://github.com/freecorps/freecorpsNFE";

// Same wordmark as the landing header (apps/console/src/site/landing/shell.tsx).
function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true">
        f.
      </span>
      <span>
        freecorps <span className="brand-light">fiscal</span>
      </span>
      <span className="brand-tag">docs</span>
    </span>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: <Brand />, url: "/" },
    themeSwitch: { enabled: false },
    links: [
      { text: "Início", url: "/", active: "none" },
      { text: "Painel", url: "/console", active: "none" },
      // The pill lives in the top bar, which hides its links below 1024px; on
      // phones the same login is a plain item in the side menu (#452).
      { type: "button", text: "Entrar", url: "/login", active: "none", on: "nav" },
      { text: "Entrar", url: "/login", active: "none", on: "menu" },
      { text: "GitHub (privado)", url: repository, external: false, active: "none" },
    ],
  };
}
