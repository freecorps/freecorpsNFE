import { pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import { z } from "zod";

// The JSX and HTML elements the guides use, by name. Each page also carries
// its Markdown for agents (markdown.server.ts), where these elements become
// placeholders rendered from their props instead of raw JSX. An element left
// out of this list reaches the Markdown as JSX, and markdown.server.ts fails
// the build on one listed here without a renderer.
export const markdownElements = [
  "a",
  "Callout",
  "Card",
  "Cards",
  "ContractVersion",
  "details",
  "Environments",
  "ErrorCodes",
  "kbd",
  "li",
  "Op",
  "Operations",
  "PageRange",
  "Step",
  "Steps",
  "summary",
  "Tolerance",
  "Ui",
  "ul",
  "WebhookEvents",
];

// MDX under content/docs, loaded by both the prerender and the browser. The
// page tree and search index, which also hold the API reference, are built in
// source.server.ts. `contract: true` marks a page whose components read the
// versioned OpenAPI; the route loader sends that data only to those pages.
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    async: true,
    schema: pageSchema.extend({ contract: z.boolean().default(false) }),
    postprocess: {
      includeProcessedMarkdown: { mdxAsPlaceholder: markdownElements, headingIds: false },
    },
  },
});
