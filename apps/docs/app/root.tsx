import { RootProvider } from "fumadocs-ui/provider/react-router";
import type { ComponentProps, ReactNode } from "react";
import {
  isRouteErrorResponse,
  Link as RouterLink,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import "./app.css";
import { SearchDialog } from "./components/search.tsx";
import { translations } from "./lib/translations.ts";
import NotFound from "./routes/not-found.tsx";

// Fumadocs links inside /docs navigate with React Router; anything else (the
// landing, the panel, downloads) is a different application and gets a
// plain document navigation.
function Link({ href = "#", prefetch, ...props }: ComponentProps<"a"> & { prefetch?: boolean }) {
  if (href === "/docs" || href.startsWith("/docs/"))
    return <RouterLink to={href} prefetch={prefetch ? "intent" : "none"} {...props} />;
  return <a href={href} {...props} />;
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow, noarchive" />
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content="#09100d" />
        <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
        <link rel="icon" href="/favicon.png" type="image/png" sizes="48x48" />
        <Meta />
        <Links />
      </head>
      <body>
        <a className="skip" href="#conteudo">
          Pular para o conteúdo
        </a>
        <RootProvider
          components={{ Link }}
          theme={{ enabled: false }}
          search={{ SearchDialog }}
          i18n={{ locale: "pt-BR", translations }}
        >
          {children}
        </RootProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// While prerendering, any error other than 404 answers 500 and React Router
// stops the build; this page is only what a browser would show.
export function ErrorBoundary({ error }: { error: unknown }) {
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  return (
    <main id="conteudo" className="error-page">
      <h1>Não foi possível abrir esta página</h1>
      <p>
        Recarregue a página ou volte ao <a href="/docs/">início da documentação</a>.
      </p>
    </main>
  );
}
