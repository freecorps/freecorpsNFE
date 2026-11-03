import {
  renderPlaceholder,
  type PlaceholderData,
} from "fumadocs-core/mdx-plugins/remark-llms.runtime";
import type { Node } from "fumadocs-core/page-tree";
import {
  contractVersion,
  environments,
  errors,
  events,
  largestPage,
  operations,
  smallestPage,
  toleranceMinutes,
} from "./contract.server.ts";
import { source } from "./source.server.ts";
import { markdownElements } from "./source.ts";

// The guides as Markdown for agents: /docs/llms.txt (index), /docs/llms-full.txt
// (every guide) and /docs/<page>.md (one guide). fumadocs-mdx keeps each
// page's Markdown with the elements of `markdownElements` as placeholders;
// the renderers below write them from their props, and the contract
// components from the same OpenAPI the HTML pages read. Build time only.

const list = (values: readonly string[]) => {
  const codes = values.map((value) => `\`${value}\``);
  return codes.length > 1 ? `${codes.slice(0, -1).join(", ")} e ${codes.at(-1)}` : (codes[0] ?? "");
};
const block = (text: string) => `\n\n${text.trim()}\n\n`;
const table = (head: string[], rows: string[][]) =>
  block(
    [head, head.map(() => "---"), ...rows]
      .map((cells) => `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`)
      .join("\n"),
  );
const text = (value: unknown) => (typeof value === "string" ? value : "");

const renderers: Record<string, (data: PlaceholderData) => string> = {
  a: ({ attributes, children }) => `[${children.trim()}](${text(attributes.href)})`,
  Callout: ({ attributes, children }) =>
    block(
      [`**${text(attributes.title) || "Nota"}**`, "", ...children.trim().split("\n")]
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n"),
    ),
  Card: ({ attributes, children }) =>
    `- [${text(attributes.title)}](${text(attributes.href)}): ${children.trim()}\n`,
  Cards: ({ children }) => block(children.trim().replace(/\n\s*\n/g, "\n")),
  ContractVersion: () => `\`${contractVersion}\``,
  details: ({ children }) => block(children),
  Environments: () => list(environments),
  ErrorCodes: () =>
    table(
      ["Código", "HTTP", "Significado"],
      errors.map((error) => [`\`${error.code}\``, String(error.status), error.meaning]),
    ),
  kbd: ({ children }) => children.trim(),
  li: ({ children }) => `- ${children.trim()}\n`,
  Op: ({ attributes }) => {
    const found = operations.find((op) => op.operationId === attributes.id);
    if (!found) throw new Error(`Operação ausente no contrato: ${text(attributes.id)}`);
    return `\`${found.method} ${found.path}\``;
  },
  Operations: () =>
    table(
      ["Rota", "Operação SDK", "Escopo", "Retry automático", "Página máxima"],
      operations.map((op) => [
        `\`${op.method} ${op.path}\``,
        op.operationId,
        op.scope,
        op.retry,
        op.pageLimit ? String(op.pageLimit) : "-",
      ]),
    ),
  PageRange: () => `de ${smallestPage} a ${largestPage}`,
  Step: ({ children }) => block(children),
  Steps: ({ children }) => block(children),
  summary: ({ children }) => block(`**${children.trim()}**`),
  Tolerance: () => String(toleranceMinutes),
  Ui: ({ children }) => `**${children.trim()}**`,
  ul: ({ children }) => block(children.trim().replace(/\n\s*\n/g, "\n")),
  WebhookEvents: () => list(events),
};
for (const name of markdownElements)
  if (!renderers[name]) throw new Error(`Elemento sem renderização em Markdown: ${name}`);

type Guide = Extract<ReturnType<typeof source.getPages>[number], { type: "docs" }>;
const guides = () => source.getPages().filter((page): page is Guide => page.type === "docs");
const file = (page: Guide) => `${page.slugs.join("/") || "index"}.md`;

// Links between guides point to their Markdown, the copy an agent reads. The
// API reference stays HTML; its Markdown is the OpenAPI.
const toMarkdownLinks = (markdown: string) =>
  markdown.replace(/\]\(\/docs\/?([a-z0-9-]*)(#[a-z0-9-]+)?\)/g, (link, slug: string, hash = "") =>
    slug === "api" ? link : `](/docs/${slug || "index"}.md${hash})`,
  );

/** One guide in Markdown, with its title and description on top. */
export async function guideMarkdown(page: Guide) {
  const body = await renderPlaceholder(await page.data.getText("processed"), renderers);
  const text = toMarkdownLinks(body.replace(/\n{3,}/g, "\n\n").trim());
  return `# ${page.data.title}\n\n${page.data.description ?? ""}\n\n${text}\n`;
}

/** Every guide, keyed by its file under /docs. */
export async function guideFiles() {
  return Object.fromEntries(
    await Promise.all(guides().map(async (page) => [file(page), await guideMarkdown(page)])),
  );
}

/** /docs/llms-full.txt: every guide in navigation order. */
export async function llmsFull() {
  const order = new Map(guides().map((page) => [page.url, page]));
  const pages = walk(source.getPageTree().children).flatMap((node) =>
    node.type === "page" && order.has(node.url) ? [order.get(node.url)!] : [],
  );
  return (await Promise.all(pages.map(guideMarkdown))).join("\n---\n\n");
}

const walk = (nodes: Node[]): Node[] =>
  nodes.flatMap((node) => (node.type === "folder" ? [node, ...walk(node.children)] : [node]));

/** /docs/llms.txt: the guides by section, each linked to its Markdown. */
export function llmsIndex() {
  const home = source.getPage([]);
  const out = [
    "# Freecorps Fiscal",
    "",
    `> ${home?.data.description ?? ""}`,
    "",
    "Todas as páginas num arquivo só: [/docs/llms-full.txt](/docs/llms-full.txt).",
  ];
  for (const node of source.getPageTree().children) {
    if (node.type === "separator")
      out.push("", `## ${typeof node.name === "string" ? node.name : ""}`, "");
    else if (node.type === "folder")
      out.push(
        `- [Referência da API](/developer/openapi.json): o OpenAPI completo, com ${operations.length} operações, schemas, escopos e erros. Versão ${contractVersion}.`,
      );
    else {
      const page = source.getNodePage(node);
      if (page?.type === "docs")
        out.push(`- [${page.data.title}](/docs/${file(page)}): ${page.data.description ?? ""}`);
    }
  }
  out.push(
    "",
    "## Opcional",
    "",
    "- [Guia completo do SDK](/developer/SDK.md): rotação de segredos, diagnóstico e limites do pacote.",
  );
  return `${out.join("\n")}\n`;
}
