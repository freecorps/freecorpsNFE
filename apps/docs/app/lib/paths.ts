import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGetUrl, getSlugs } from "fumadocs-core/source";
import { apiOperations, apiSlug, type Spec } from "./openapi.ts";

// Every page URL (guides and API reference), for the prerender list in
// react-router.config.ts. Runs in Node before Vite, so it reads the content
// folder and the OpenAPI instead of the collections.
const content = fileURLToPath(new URL("../../content/docs", import.meta.url));
const url = createGetUrl("/docs");
const spec: Spec = JSON.parse(
  readFileSync(new URL("../../../../docs/v1.0/openapi.json", import.meta.url), "utf8"),
);

export function pagePaths() {
  const guides = readdirSync(content, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".mdx"))
    .map((entry) => url(getSlugs(entry)));
  const reference = apiOperations(spec).map((op) => url(["api", apiSlug(op.operationId)]));
  return [...guides, ...reference].sort((a, b) => a.localeCompare(b));
}
