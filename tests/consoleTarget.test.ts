import { expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import {
  checkConsoleWorker,
  consoleEnvironment,
  checkPreparedConsole,
} from "../scripts/lib/console.mjs";
const sha = "a".repeat(40);
it("refuses publication of absent, stale or foreign prepared assets", () => {
  expect(() => checkPreparedConsole({ sha, environment: "validation" }, sha)).not.toThrow();
  for (const receipt of [
    null,
    {},
    { sha: "b".repeat(40), environment: "validation" },
    { sha, environment: "installation" },
  ])
    expect(() => checkPreparedConsole(receipt, sha)).toThrow();
});
const config = JSON.parse(
  readFileSync(new URL("../apps/console/wrangler.json", import.meta.url), "utf8"),
);
it("builds against the registered validation hosts and rejects inherited frontend variables", () => {
  expect(consoleEnvironment({}, sha).VITE_CONVEX_URL).toBe("https://modest-seal-118.convex.cloud");
  expect(() =>
    consoleEnvironment({ VITE_CONVEX_URL: "https://elated-possum-295.convex.cloud" }, sha),
  ).toThrow();
  expect(() => consoleEnvironment({ VITE_CLERK_PUBLISHABLE_KEY: "synthetic" }, sha)).toThrow();
  expect(() => consoleEnvironment({}, "unknown")).toThrow();
});
it("refuses routes, backend bindings and legacy Worker names before publishing", () => {
  expect(() => checkConsoleWorker(config)).not.toThrow();
  for (const override of [
    { name: "freecorpsnfe-backoffice" },
    { routes: ["nfe.freecorps.com.br"] },
    { env: { production: {} } },
    { main: "other-worker.ts" },
    { account_id: "other" },
  ])
    expect(() => checkConsoleWorker({ ...config, ...override })).toThrow();
});
it("does not expose publication or runner credentials to the console build", () => {
  const env = consoleEnvironment(
    {
      PATH: "bin",
      CLOUDFLARE_API_TOKEN: "synthetic-secret",
      CONVEX_DEPLOY_KEY: "synthetic-secret",
      ACTIONS_RUNTIME_TOKEN: "synthetic-secret",
      CUSTOM_RUNNER_CREDENTIAL: "synthetic-secret",
    },
    sha,
  );
  expect(env.PATH).toBe("bin");
  expect(Object.values(env)).not.toContain("synthetic-secret");
});
it("keeps console REST calls on VITE_API_URL, which hosted builds point at the Worker", () => {
  expect(consoleEnvironment({}, sha).VITE_API_URL).toBe("https://modest-seal-118.convex.site");
  // Direct REST calls to convex.site are refused in an installation; only auth
  // in development may use VITE_CONVEX_SITE_URL.
  // Ticket downloads of documents and issuances go through `useTicketDownload`.
  const read = (file: string) =>
    readFileSync(new URL(`../apps/console/src/${file}`, import.meta.url), "utf8");
  for (const file of ["product-components.tsx", "exports.tsx", "api-origin.ts"]) {
    expect(read(file)).toContain("VITE_API_URL");
    expect(read(file)).not.toContain("VITE_CONVEX_SITE_URL");
  }
  for (const file of ["documents.tsx", "issuances.tsx"]) {
    expect(read(file)).toContain("useTicketDownload");
    expect(read(file)).not.toContain("VITE_CONVEX_SITE_URL");
  }
});
