import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isLocalWorktreeSiteUrl } from "../worktree-local.ts";
import { localUrls } from "./deployment.mjs";
import { fail } from "./exec.mjs";

export const PLATFORM_BACKEND_ENV = new Set([
  "FNFE_PLATFORM_CERT_KEYS",
  "APP_ENV",
  "PRODUCT_ENV",
  "FISCAL_ENV",
  "FNFE_CRONS",
  "EMAIL_MODE",
  "WEBHOOK_MODE",
  "FNFE_WEBHOOK_MASTER_KEY",
  "SITE_URL",
  "BETTER_AUTH_SECRET",
]);
export function parseEnv(source) {
  const values = new Map();
  const entry =
    /(?:^|\n)[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:'([^']*)'|"((?:\\.|[^"\\])*)"|([^\r\n#]*))/g;
  for (const match of source.matchAll(entry)) {
    values.set(
      match[1],
      match[2] ?? match[3]?.replace(/\\n/g, "\n").replace(/\\r/g, "\r") ?? match[4].trim(),
    );
  }
  return values;
}
export function readEnvFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : new Map();
}
export function formatEnvFile(values, heading) {
  return [
    `# ${heading}`,
    ...Object.entries(values).map(([key, value]) => {
      const text = String(value);
      if (/^[A-Za-z0-9_:/.,@+=-]*$/.test(text)) return `${key}=${text}`;
      if (!text.includes("'")) return `${key}='${text}'`;
      if (!text.includes('"')) return `${key}="${text}"`;
      fail(`Valor de ${key} contém ambas as aspas; use um valor sem essa combinação.`);
    }),
    "",
  ].join("\n");
}
export function currentLocalSiteUrl(paths) {
  const value = readEnvFile(paths.runtimeEnv).get("VITE_SITE_URL");
  return isLocalWorktreeSiteUrl(value) ? value : null;
}
export function writeRuntimeEnv(paths, config, siteUrl) {
  const urls = localUrls(config);
  writeFileSync(
    paths.runtimeEnv,
    formatEnvFile(
      {
        CONVEX_DEPLOYMENT: `${config.deploymentName.startsWith("anonymous-") ? "anonymous" : "local"}:${config.deploymentName}`,
        VITE_CONVEX_URL: urls.cloud,
        VITE_CONVEX_SITE_URL: urls.site,
        VITE_API_URL: urls.site,
        VITE_SITE_URL: siteUrl,
        VITE_APP_SHA: "local",
        VITE_APP_ENV: "development",
      },
      "Gerado para este worktree local.",
    ),
    { mode: 0o600 },
  );
}
export function writeBlockedRuntimeEnv(paths, siteUrl) {
  writeFileSync(
    paths.runtimeEnv,
    formatEnvFile(
      {
        CONVEX_DEPLOYMENT: "local:setup-incomplete",
        VITE_CONVEX_URL: "http://127.0.0.1:1",
        VITE_CONVEX_SITE_URL: "http://127.0.0.1:1",
        VITE_API_URL: "http://127.0.0.1:1",
        VITE_SITE_URL: siteUrl,
      },
      "Setup incompleto. Rode bun run worktree:setup.",
    ),
    { mode: 0o600 },
  );
}
export function ensureBackendEnvFile(paths, siteUrl = currentLocalSiteUrl(paths)) {
  const previous = readEnvFile(paths.backendEnv);
  if (!isLocalWorktreeSiteUrl(siteUrl)) fail("Platform requires a reserved loopback origin");
  writeFileSync(
    paths.backendEnv,
    formatEnvFile(
      {
        APP_ENV: "development",
        PRODUCT_ENV: "sandbox",
        FISCAL_ENV: "disabled",
        FNFE_CRONS: "off",
        EMAIL_MODE: "local",
        WEBHOOK_MODE: "disabled",
        FNFE_WEBHOOK_MASTER_KEY:
          previous.get("FNFE_WEBHOOK_MASTER_KEY") || randomBytes(32).toString("hex"),
        FNFE_PLATFORM_CERT_KEYS:
          previous.get("FNFE_PLATFORM_CERT_KEYS") ||
          JSON.stringify({
            active: "local-v1",
            keys: { "local-v1": randomBytes(32).toString("hex") },
          }),
        SITE_URL: siteUrl,
        BETTER_AUTH_SECRET:
          previous.get("BETTER_AUTH_SECRET") || randomBytes(48).toString("base64url"),
      },
      "Local platform only; no external credentials.",
    ),
    { mode: 0o600 },
  );
}
