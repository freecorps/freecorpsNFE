import { loader } from "fumadocs-core/source";
import { apiSlug } from "./openapi.ts";
import { apiMeta, openapiServer } from "./openapi.server.ts";
import { docs } from "./source.ts";

// Guides (MDX) and the API reference (generated from the OpenAPI) in one
// tree. Build time only: route loaders and the search index read it.
// One document per operation (see openapi.server.ts): the document id is the
// operationId, and the page lives at /docs/api/<operationId in lower case>.
const reference = await openapiServer.staticSource({
  baseDir: "api",
  name: (entry: { schemaId: string }) => apiSlug(entry.schemaId),
});

export const source = loader(
  {
    docs: docs.toFumadocsSource(),
    api: {
      files: [...reference.files, { type: "meta", path: "api/meta.json", data: apiMeta() }],
    },
  },
  { baseUrl: "/docs", plugins: [openapiServer.loaderPlugin()] },
);
