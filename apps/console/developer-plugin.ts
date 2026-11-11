import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer } from "vite";

// The files served under /developer/ (#158): the OpenAPI, the SDK guide and the code examples
// the public docs and the console link to. Each one is rendered from its source at build time,
// so a contract or example change reaches /developer/ with the build that carries it; nothing
// under apps/console/public/developer/ is versioned.
export const developerSources = {
  "openapi.json": "docs/v1.0/openapi.json",
  "SDK.md": "docs/v1.0/SDK.md",
  "quickstart.ts": "examples/quickstart.ts",
  "quickstart-curl.mjs": "examples/quickstart-curl.mjs",
  "sdk-webhook-receiver.mjs": "examples/sdk-webhook-receiver.mjs",
  "nfse-issuance.ts": "examples/nfse-issuance.ts",
} as const;

export type DeveloperFile = keyof typeof developerSources;

const repository = new URL("../../", import.meta.url);

// The copy lives outside docs/: links to the repository's internal documents
// would not resolve there, so they become text and keep the label.
const withoutRepositoryLinks = (markdown: string) =>
  markdown.replace(/\[([^\]]+)\]\(\.\.\/[^)]*\)/g, "$1");

/** The bytes of one /developer/ file, read from `root` (the repository). */
export function developerFile(name: DeveloperFile, root: URL = repository) {
  const text = readFileSync(new URL(developerSources[name], root), "utf8");
  return name === "SDK.md" ? withoutRepositoryLinks(text) : text;
}

const isDeveloperFile = (name: string): name is DeveloperFile =>
  Object.hasOwn(developerSources, name);

const contentTypes: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
};

type Emitter = {
  emitFile(file: { type: "asset"; fileName: string; source: string }): unknown;
};

export function developerPlugin(
  root: URL = repository,
  publicDeveloper = fileURLToPath(new URL("./public/developer/", import.meta.url)),
) {
  return {
    name: "freecorps-developer-files",
    // A file left in public/developer/ would reach the output beside, or instead of, the
    // rendering; the build stops instead of shipping a stale copy.
    buildStart() {
      if (existsSync(publicDeveloper))
        throw new Error(
          `${publicDeveloper} não é mais versionado: o build gera /developer/ das fontes. Apague a pasta.`,
        );
    },
    generateBundle(this: Emitter) {
      for (const name of Object.keys(developerSources) as DeveloperFile[])
        this.emitFile({
          type: "asset",
          fileName: `developer/${name}`,
          source: developerFile(name, root),
        });
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const name = path.startsWith("/developer/") ? path.slice("/developer/".length) : "";
        if (!isDeveloperFile(name) || (req.method !== "GET" && req.method !== "HEAD"))
          return next();
        res.setHeader("Content-Type", contentTypes[extname(name)]!);
        res.setHeader("Cache-Control", "no-store");
        res.end(req.method === "HEAD" ? undefined : developerFile(name, root));
      });
    },
  } satisfies Plugin;
}
