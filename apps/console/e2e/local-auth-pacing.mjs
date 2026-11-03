import { setTimeout as delay } from "node:timers/promises";

/** Reserve quiet intervals across synthetic contexts; login/OTP still reset on inactivity. */
export function localAuthPacer(report) {
  const idleMs = 65_000;
  console.log(
    "Navegador: reservando 65 segundos de inatividade inicial para autenticação. Mantenha outras abas deste console fechadas.",
  );
  let nextRequestAt = Date.now() + idleMs;
  const counts = new Map();
  report.authTraffic = [];
  report.authPacing = {
    scope: "all browser auth routes",
    minIntervalMs: 100,
    idleMs,
    defaultBudget: 16,
    sensitiveBudget: 2,
    scheduledRequests: 0,
    idleWindows: 1,
    maxDelayMs: 0,
  };
  return async (context) => {
    context.on("request", (request) => {
      if (request.url().includes("/api/auth/"))
        report.authTraffic.push({
          event: "request",
          method: request.method(),
          path: new URL(request.url()).pathname,
          redirected: Boolean(request.redirectedFrom()),
          at: Date.now(),
        });
    });
    context.on("response", (response) => {
      if (response.url().includes("/api/auth/"))
        report.authTraffic.push({
          event: "response",
          path: new URL(response.url()).pathname,
          status: response.status(),
          ...(response.status() === 429
            ? {
                phase: "authentication",
                retryAfterSeconds: /^\d+$/.test(response.headers()["retry-after"] ?? "")
                  ? Number(response.headers()["retry-after"])
                  : null,
              }
            : {}),
          at: Date.now(),
        });
    });
    // A deliberate 65-second quiet period can occur during a page's authentication.
    context.setDefaultTimeout(90_000);
    await context.route(/\/api\/auth\//, async (route) => {
      const now = Date.now();
      if (now - nextRequestAt > idleMs) counts.clear();
      const path = new URL(route.request().url()).pathname;
      const ordinary = /\/(?:convex\/(?:token|jwks)|get-session|sign-out|list-sessions)$/.test(
        path,
      );
      const budget = ordinary ? report.authPacing.defaultBudget : report.authPacing.sensitiveBudget;
      if ((counts.get(path) ?? 0) >= budget) {
        nextRequestAt = Math.max(now, nextRequestAt) + idleMs;
        counts.clear();
        report.authPacing.idleWindows++;
        console.log(
          "Navegador: aguardando outra janela de autenticação; nenhuma operação será repetida.",
        );
      }
      const scheduledAt = Math.max(now, nextRequestAt);
      nextRequestAt = scheduledAt + report.authPacing.minIntervalMs;
      counts.set(path, (counts.get(path) ?? 0) + 1);
      const wait = scheduledAt - now;
      report.authPacing.scheduledRequests++;
      report.authPacing.maxDelayMs = Math.max(report.authPacing.maxDelayMs, wait);
      if (wait) await delay(wait);
      if (!context.pages().length) return;
      try {
        await route.continue();
      } catch (error) {
        // Teardown may close a context while its already-reserved request waits.
        if (context.pages().length) throw error;
      }
    });
  };
}
