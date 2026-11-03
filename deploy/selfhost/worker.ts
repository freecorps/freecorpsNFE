/// <reference types="@cloudflare/workers-types" />
import { serveAsset } from "../../apps/console/asset-fallback";
import { proxyAuthentication } from "../../apps/console/auth-proxy";
import { proxyApi } from "../../apps/console/api-proxy";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // The REST address is a separate host; console paths on it are never served.
    if (env.API_ORIGIN && url.origin === env.API_ORIGIN)
      return proxyApi(request, env.AUTH_PROXY_SECRET, env.BACKEND_SITE_URL);
    if (!url.pathname.startsWith("/api/auth/")) return serveAsset(request, env.ASSETS);
    return proxyAuthentication(request, env.AUTH_PROXY_SECRET, {
      site: env.BACKEND_SITE_URL,
      consoleOrigin: env.CONSOLE_ORIGIN,
    });
  },
} satisfies ExportedHandler<InstallationWorkerEnv>;
