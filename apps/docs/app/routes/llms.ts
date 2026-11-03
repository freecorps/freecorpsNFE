import { llmsIndex } from "../lib/markdown.server.ts";

// Prerendered into /docs/llms.txt (markdown.server.ts).
export function loader() {
  return new Response(llmsIndex(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
