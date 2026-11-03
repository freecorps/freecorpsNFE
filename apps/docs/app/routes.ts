import { route, type RouteConfig } from "@react-router/dev/routes";

// No basename: the app owns /docs and its links are absolute (/docs/...), so
// Fumadocs URLs and React Router paths are the same strings.
export default [
  route("docs/search.json", "routes/search.ts"),
  route("docs/llms.txt", "routes/llms.ts"),
  route("docs/llms-full.txt", "routes/llms-full.ts"),
  route("docs/markdown.json", "routes/markdown.ts"),
  // Prerendered as docs/404.html, served by the Worker for missing /docs addresses.
  route("docs/404", "routes/not-found.tsx", { id: "docs-not-found" }),
  route("docs", "routes/docs.tsx", { id: "docs-index" }),
  route("docs/*", "routes/docs.tsx"),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
