import { createOpenAPI } from "fumadocs-openapi/server";
import openapi from "../../../../docs/v1.0/openapi.json";
import { apiGroup, apiGroupOrder, apiOperations, apiSlug, type Spec } from "./openapi.ts";
import { operationTitles } from "./operation-titles.ts";

// API reference generated from docs/v1.0/openapi.json at build time. Each
// operation becomes its own small OpenAPI document, holding only the schemas
// it references: the page props carry the document, and the whole contract
// (500 KB) on every page would be wasteful.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Document = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string }[];
  security?: Json;
  paths: Record<string, Record<string, Record<string, Json>>>;
  components: { securitySchemes?: Record<string, Json>; schemas: Record<string, Json> };
};

const spec = openapi as unknown as Document;

function references(value: Json, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) references(item, found);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string") {
        const name = item.replace("#/components/schemas/", "");
        if (!found.has(name) && spec.components.schemas[name]) {
          found.add(name);
          references(spec.components.schemas[name], found);
        }
      } else references(item, found);
    }
  return found;
}

function operationDocument(path: string, method: string): Document {
  const operation = spec.paths[path]![method]!;
  const schemas = [...references(operation as Json)].sort();
  const scope = typeof operation["x-scope"] === "string" ? operation["x-scope"] : null;
  return {
    openapi: spec.openapi,
    info: { title: spec.info.title, version: spec.info.version },
    // The hosted API, as in the quickstart; a self-hosted installation has its own.
    servers: [{ url: "https://api.nfe.freecorps.com.br" }],
    security: spec.security,
    paths: {
      [path]: {
        [method]: {
          ...operation,
          // Page and sidebar title; the operationId shows under it on the page.
          summary: operationTitle(operation.operationId as string),
          description: scope ? `Escopo da chave: ${scope}.` : "",
        },
      },
    },
    components: {
      securitySchemes: spec.components.securitySchemes,
      schemas: Object.fromEntries(schemas.map((name) => [name, spec.components.schemas[name]!])),
    },
  };
}

const operations = apiOperations(spec as unknown as Spec);

// Every operation of the contract has a Portuguese title, and every title an
// operation (operation-titles.ts). Either gap stops the build.
const titles: Record<string, string> = operationTitles;
export function operationTitle(operationId: string) {
  const title = titles[operationId];
  if (!title) throw new Error(`Operação sem título em operation-titles.ts: ${operationId}`);
  return title;
}
for (const op of operations) operationTitle(op.operationId);
for (const id of Object.keys(titles))
  if (!operations.some((op) => op.operationId === id))
    throw new Error(`Título de operação fora do contrato: ${id}`);

export const openapiServer = createOpenAPI({
  input: Object.fromEntries(
    operations.map((op) => [op.operationId, () => operationDocument(op.path, op.method)]),
  ) as never,
});

// Sidebar order of the reference: one separator per resource, in the order of
// apiGroupOrder, operations in contract order.
export function apiMeta() {
  const byGroup = new Map<string, string[]>();
  for (const op of operations) {
    const group = apiGroup(op.path);
    byGroup.set(group, [...(byGroup.get(group) ?? []), apiSlug(op.operationId)]);
  }
  const order = [...byGroup.keys()].sort(
    (a, b) =>
      (apiGroupOrder.indexOf(a) + 1 || 99) - (apiGroupOrder.indexOf(b) + 1 || 99) ||
      a.localeCompare(b),
  );
  return {
    title: "Referência da API",
    pages: order.flatMap((group) => [`---${group}---`, ...byGroup.get(group)!]),
  };
}
