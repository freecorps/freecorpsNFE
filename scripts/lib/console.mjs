import { validationTarget } from "./validation.mjs";
import { subprocessEnvironment } from "./subprocess-environment.mjs";

/** @returns {Record<string, string>} */
export function consoleEnvironment(env, sha, target = validationTarget) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Console build requires a full commit SHA");
  if (
    target.consoleUrl !== "https://freecorpsnfe-validation.freecorps.workers.dev" ||
    target.url !== "https://modest-seal-118.convex.cloud" ||
    target.siteUrl !== "https://modest-seal-118.convex.site"
  )
    throw new Error("Unexpected console target");
  const fixed = {
    VITE_CONVEX_URL: target.url,
    VITE_CONVEX_SITE_URL: target.siteUrl,
    VITE_API_URL: target.siteUrl,
    VITE_APP_SHA: sha,
  };
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("VITE_") && (!Object.hasOwn(fixed, name) || fixed[name] !== value))
      throw new Error(`Unexpected ${name} for validation console`);
  }
  return { ...subprocessEnvironment(env), WRANGLER_SEND_METRICS: "false", ...fixed };
}

export function consolePublicationEnvironment(env) {
  if (!env.CLOUDFLARE_API_TOKEN?.trim())
    throw new Error("Missing dedicated Cloudflare publication token");
  if (env.CLOUDFLARE_ACCOUNT_ID !== "ceccd1846b474bb179054a3c2c4a6185")
    throw new Error("Unexpected Cloudflare account");
  return {
    ...subprocessEnvironment(env),
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
  };
}

export function checkPreparedConsole(receipt, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha) || receipt?.sha !== sha || receipt?.environment !== "validation")
    throw new Error("Prepared console differs from the publication revision");
}

export function checkConsoleWorker(config) {
  const allowed = [
    "$schema",
    "name",
    "account_id",
    "compatibility_date",
    "workers_dev",
    "preview_urls",
    "assets",
    "main",
  ];
  if (
    Object.keys(config).some((name) => !allowed.includes(name)) ||
    config.name !== "freecorpsnfe-validation" ||
    config.account_id !== "ceccd1846b474bb179054a3c2c4a6185" ||
    config.workers_dev !== true ||
    config.preview_urls !== false ||
    config.main !== "worker.ts" ||
    config.assets?.directory !== "./dist" ||
    config.assets?.not_found_handling !== "none" ||
    config.assets?.binding !== "ASSETS" ||
    JSON.stringify(config.assets?.run_worker_first) !==
      JSON.stringify(["/api/auth/*", "/docs/404"]) ||
    Object.keys(config.assets).length !== 4
  )
    throw new Error("Unexpected validation Worker configuration");
}
