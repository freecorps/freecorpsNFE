/// <reference types="@cloudflare/workers-types" />
import { serveAsset } from "./asset-fallback";
import { proxyAuthentication } from "./auth-proxy";

export default {
  async fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith("/api/auth/"))
      return serveAsset(request, env.ASSETS);
    return proxyAuthentication(request, env.AUTH_PROXY_SECRET);
  },
} satisfies ExportedHandler<ValidationWorkerEnv>;
