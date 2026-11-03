import type { Config } from "@react-router/dev/config";
import { pagePaths } from "./app/lib/paths.ts";

// Static export: every page, the search index and the Markdown for agents are
// rendered to files at build time (scripts/build.mjs then prepares them for
// /docs in the console).
// Nothing runs on a server.
export default {
  ssr: false,
  prerender: () => [
    "/docs/search.json",
    "/docs/llms.txt",
    "/docs/llms-full.txt",
    "/docs/markdown.json",
    // What the Worker answers, with status 404, for a missing address under /docs.
    "/docs/404",
    ...pagePaths(),
  ],
} satisfies Config;
