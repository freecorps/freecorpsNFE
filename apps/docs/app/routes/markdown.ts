import { guideFiles } from "../lib/markdown.server.ts";

// Prerendered into /docs/markdown.json, which scripts/build.mjs splits into
// /docs/<page>.md and removes: React Router has no route for a path that
// ends in ".md" after a dynamic segment.
export async function loader() {
  return Response.json(await guideFiles());
}
