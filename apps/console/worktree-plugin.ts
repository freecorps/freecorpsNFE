import type { Plugin } from "vite-plus";
import {
  localBrowserIdentity,
  localBrowserIdentityPath,
} from "../../scripts/lib/local-browser-identity.mjs";

/** Sonda somente do dev. Não entra no bundle nem no Worker publicado. */
export function worktreePlugin(): Plugin {
  return {
    name: "freecorps-worktree-identity",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== localBrowserIdentityPath) return next();
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(
          JSON.stringify({
            schemaVersion: 1,
            application: "freecorps-console",
            rootId: localBrowserIdentity(server.config.root),
            convexUrl: server.config.env.VITE_CONVEX_URL ?? null,
            authUrl: server.config.env.VITE_CONVEX_SITE_URL ?? null,
            apiUrl: server.config.env.VITE_API_URL ?? null,
          }),
        );
      });
    },
  };
}
