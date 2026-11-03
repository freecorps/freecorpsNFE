import { createFromSource } from "fumadocs-core/search/server";
import { source } from "../lib/source.server.ts";

// Prerendered once into /docs/search.json; the browser downloads it and
// searches locally. There is no search server.
const server = createFromSource(source);

export async function loader() {
  return server.staticGET();
}
