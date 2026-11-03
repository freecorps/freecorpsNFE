import { taskEntryHref } from "../../console-task.ts";
import type { Figure } from "./figures/index.ts";

// Header, footer and shared pieces of the next landing. Static markup only:
// the page must read without JavaScript, and the CSP forbids inline styles.

export const repository = "https://github.com/freecorps/freecorpsNFE";
/** Where the sandbox calls lead: the signup, then the Início on "Importar XML" (#510). */
export const sandboxEntry = taskEntryHref("importar");

export function Iso({
  figure,
  label,
  className,
}: {
  figure: Figure;
  label: string;
  className?: string;
}) {
  return (
    <svg
      className={`iso fig-${figure.name}${className ? ` ${className}` : ""}`}
      data-figure={figure.name}
      viewBox={figure.viewBox}
      role="img"
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: figure.svg }}
    />
  );
}

// Glow filters shared by every figure. The region is the element's own box plus
// a margin: a page-sized userSpaceOnUse region made the GPU raster a huge
// offscreen surface for every lit element, every frame it animated.
export function GlowDefs() {
  const region = { x: "-60%", y: "-60%", width: "220%", height: "220%" } as const;
  return (
    <svg className="glow-defs" aria-hidden="true" focusable="false">
      <filter id="iso-glow" {...region}>
        <feGaussianBlur stdDeviation="3.2" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter id="iso-soft" {...region}>
        <feGaussianBlur stdDeviation="1.8" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter id="iso-bloom" {...region}>
        <feGaussianBlur stdDeviation="7" />
      </filter>
    </svg>
  );
}

// GitHub's mark, as published at github.com/logos.
export function GitHubMark() {
  return (
    <svg className="gh-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function Arrow() {
  return (
    <svg className="arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 8h10m0 0L9 4m4 4-4 4" />
    </svg>
  );
}

function Mark() {
  return (
    <a className="brand" href="/" aria-label="Freecorps Fiscal, início">
      <span className="brand-mark" aria-hidden="true">
        f.
      </span>
      <span>
        freecorps <span className="brand-light">fiscal</span>
      </span>
    </a>
  );
}

export function Header() {
  return (
    <>
      <a className="skip" href="#conteudo">
        Pular para o conteúdo
      </a>
      <header className="top">
        <div className="top-inner">
          <Mark />
          <nav aria-label="Navegação pública">
            <a href="#produto">Produto</a>
            <a href="#documentos">Documentos</a>
            <a href="#desenvolvedores">Desenvolvedores</a>
            <a href="/docs/">Docs</a>
          </nav>
          <div className="top-actions">
            <a className="nav-login" href="/login">
              Entrar
            </a>
            <a className="btn btn-primary btn-sm" href={sandboxEntry}>
              Criar conta
            </a>
          </div>
        </div>
      </header>
    </>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="foot-inner">
        <div className="foot-brand">
          <Mark />
          <p>Infraestrutura fiscal para software brasileiro.</p>
          <p className="foot-account">
            Já tem conta? <a href="/login">Entrar</a>
          </p>
        </div>
        <nav aria-label="Produto">
          <h2>Produto</h2>
          <a href="#produto">Como funciona</a>
          <a href="#documentos">Documentos</a>
          <a href="#cobertura">Cobertura</a>
          <a href="#stripe">Stripe</a>
          <a href="#planos">Planos</a>
        </nav>
        <nav aria-label="Desenvolvedores">
          <h2>Desenvolvedores</h2>
          <a href="/docs/primeira-chamada">Primeira chamada</a>
          <a href="/docs/contrato">Contrato REST</a>
          <a href="/docs/agentes">Agentes de IA</a>
          <a href="/docs/instalacao">Instalação</a>
          <a href={repository}>GitHub (privado)</a>
        </nav>
        <nav aria-label="Condições">
          <h2>Condições</h2>
          <a href="/termos">Termos de uso</a>
          <a href="/privacidade">Política de privacidade</a>
          <a href="/docs/ajuda">Ajuda e condições de acesso</a>
          <a href="/docs/licencas">Licenças e distribuição</a>
          <a href="/docs/privacidade-cnpj">Privacidade da consulta CNPJ</a>
        </nav>
      </div>
      <div className="foot-base">
        <small>Freecorps Tecnologia da Informação Ltda.</small>
        <small>
          Ilustrações feitas com <a href="https://iso-glow.vercel.app">iso-glow</a>.
        </small>
      </div>
    </footer>
  );
}
