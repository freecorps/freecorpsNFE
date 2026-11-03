// Headings the M0 journey (m0.mjs) waits for on the published console. The console's own tests
// render the pages with these names (src/diagnostics.test.tsx, src/navigation.test.tsx), so a page that changes its heading
// fails there, before a deploy validation spends its run waiting for a heading that is gone.

/** `/console/diagnostico`: the data for platform operators, a restricted notice for anyone else. */
export function diagnosticsHeading(role) {
  return role === "operator" ? "Estado do ambiente." : "Diagnóstico restrito.";
}

/**
 * Where `/console` settles for each validation account, and the heading it shows there: the M0
 * page for a validation role; for an account without one, the organization list. The `none`
 * account must belong to no organization or to several: with exactly one, `/console` opens it
 * (`/app/<slug>`) and the journey stops waiting for the list.
 */
export function homeDestination(role) {
  return role === "none"
    ? { path: "/app", heading: "Organizações" }
    : { path: "/console", heading: "Acesso confirmado pelo servidor" };
}
