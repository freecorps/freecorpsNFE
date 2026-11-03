// Public HTML is useful without JavaScript. Load auth and the SPA only for app routes.
const publicRoot = window.location.pathname === "/" || window.location.pathname === "/index.html";
// The landing adds motion, shaders and its demos on top of the static page.
if (publicRoot && document.querySelector("[data-landing]"))
  void import("./site/landing/client.ts").catch((error: unknown) =>
    console.error("landing client", error),
  );
if (window.location.pathname !== "/" && window.location.pathname !== "/index.html") {
  document.getElementById("public-site")?.remove();
  document.getElementById("site-styles")?.remove();
  document.body.classList.remove("public-site");
  document.title = "Freecorps Fiscal · Painel";
  document.querySelector('link[rel="canonical"]')?.remove();
  document
    .querySelector('meta[name="robots"]')
    ?.setAttribute("content", "noindex, nofollow, noarchive");
  const root = document.getElementById("root");
  if (root) root.textContent = "Carregando o painel…";
  // The session's Convex token travels while the (much larger) console code downloads; `main`
  // waits for it before the first render (session-boot.ts). Its failure is the usual flow.
  void import("./session-boot").catch(() => undefined);
  // Every page under /app renders inside the organizations chunk (the list or the organization's
  // layout): ask for it together with main, not after main started the router.
  if (/^\/app(\/|$)/.test(window.location.pathname))
    void import("./organizations").catch(() => undefined);
  void import("./main").catch(() => {
    if (root)
      root.textContent =
        "Não foi possível carregar o painel. Recarregue a página para tentar novamente.";
  });
}
