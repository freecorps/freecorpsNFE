import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { RouterProvider } from "@tanstack/react-router";
import { authClient } from "./auth";
import { convex } from "./convex-client";
import { settledEarlyToken } from "./session-boot";
import { captureInvitationLink } from "./session-handoff";
import { router } from "./routes";
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-500.css";
// Tokens primeiro (declaram a camada `ui`), depois a base e os componentes.
import "./ui/tokens.css";
import "./ui/ui.css";
// Telas de gestão (organizações, membros, integrações, uso, operação), na camada `ui`.
import "./gestao.css";
// Telas fiscais (documentos, importação, emissão, exportações, referências), na camada `ui`.
import "./fiscal.css";
// Telas de cadastro (empresas, abas da empresa, primeiros passos), na camada `ui`. Fica aqui, e
// não nas páginas, porque o chunk compartilhado carregaria o CSS antes deste arquivo, antes da
// base e dos componentes, que passariam a vencer os arranjos da tela.
import "./companies.css";
import "./privacy-inbox.css";
import { applyTheme } from "./ui/theme";

// public/theme.js já aplicou o tema; aqui só a meta theme-color e o color-scheme definitivos.
applyTheme();

// The invitation link carries its code in the fragment: keep it in memory, out of the address.
if (typeof window !== "undefined") captureInvitationLink(window.location, window.history);

// With a session in this browser, its Convex token was asked while this code downloaded
// (session-boot.ts): the provider starts authenticated by it and confirms the session meanwhile.
// Any failure of that head start renders without the token, never leaves the page blank.
void settledEarlyToken()
  .catch(() => null)
  .then((initialToken) =>
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <ConvexBetterAuthProvider
          client={convex}
          authClient={authClient}
          initialToken={initialToken}
        >
          <RouterProvider router={router} />
        </ConvexBetterAuthProvider>
      </StrictMode>,
    ),
  );
