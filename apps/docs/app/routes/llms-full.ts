import { llmsFull } from "../lib/markdown.server.ts";

// Prerendered into /docs/llms-full.txt (markdown.server.ts).
export async function loader() {
  return new Response(await llmsFull(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
