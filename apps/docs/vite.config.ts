import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins/rehype-code";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig, type Plugin } from "vite-plus";
import { thirdPartyNotices } from "../../scripts/lib/bundle-notices.mjs";
import { codeClasses, codeTheme } from "./app/lib/code-theme.ts";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Geist and Geist Mono live in the console's public folder and are served at
// /fonts by the same Worker. The authoring server serves them from there too.
const fonts = local("../console/public/fonts/");
const consoleFonts: Plugin = {
  name: "freecorps-console-fonts",
  configureServer(server) {
    server.middlewares.use("/fonts", (req, res, next) => {
      const file = join(fonts, basename(req.url ?? ""));
      if (!existsSync(file)) return next();
      res.setHeader("Content-Type", file.endsWith(".woff2") ? "font/woff2" : "text/plain");
      res.end(readFileSync(file));
    });
  },
};

// The isometric figure on the docs home is the landing's own (intake.ts). Its
// stylesheet is the landing's figure vocabulary, read from landing.css between
// two section comments, plus the figure's file: one source, no copy. A moved
// comment fails the build instead of shipping an unstyled figure.
const landing = local("../console/src/site/landing/");
const figureStyles: Plugin = {
  name: "freecorps-landing-figure-styles",
  resolveId(id) {
    return id === "virtual:landing-figure.css" ? "\0virtual:landing-figure.css" : undefined;
  },
  load(id) {
    if (id !== "\0virtual:landing-figure.css") return undefined;
    const css = readFileSync(join(landing, "landing.css"), "utf8");
    const start = css.indexOf("/* Figures (iso-glow vocabulary).");
    const end = css.indexOf("/* Hero */", start);
    if (start < 0 || end < 0)
      throw new Error("Vocabulário das figuras não encontrado em landing.css");
    this.addWatchFile(join(landing, "landing.css"));
    this.addWatchFile(join(landing, "figures/intake.css"));
    return `${css.slice(start, end)}\n${readFileSync(join(landing, "figures/intake.css"), "utf8")}`;
  },
};

// The docs are served under /docs by the console Worker, beside the landing
// and the panel. Routes carry the /docs prefix themselves (no basename), so
// Fumadocs URLs and router paths are the same strings; assets go to
// /docs/assets.
export default defineConfig({
  server: { port: Number(process.env.PORT) || 5180 },
  // The prerender talks to a preview server on 127.0.0.1. Left on "localhost",
  // Linux (the publication runner, containers) binds it to ::1 only and every
  // prerender request is refused.
  preview: { host: "127.0.0.1" },
  plugins: [
    consoleFonts,
    figureStyles,
    fumadocsMdx({
      globalOptions: {
        mdxOptions: {
          rehypeCodeOptions: {
            ...rehypeCodeDefaultOptions,
            themes: { dark: codeTheme },
            defaultColor: "dark",
            transformers: [...(rehypeCodeDefaultOptions.transformers ?? []), codeClasses],
          },
        },
      },
    }),
    tailwindcss(),
    reactRouter(),
    thirdPartyNotices("docs/third-party-notices.txt"),
  ],
  resolve: {
    alias: [
      // Only the grammars the API pages use (app/lib/shiki-slim.ts).
      { find: /^shiki(\/wasm)?$/, replacement: local("./app/lib/shiki-slim.ts") },
      // No runtime <style> injection under the CSP (app/lib/style-singleton.ts).
      { find: /^react-style-singleton$/, replacement: local("./app/lib/style-singleton.ts") },
    ],
  },
  build: { sourcemap: false, assetsDir: "docs/assets" },
});
