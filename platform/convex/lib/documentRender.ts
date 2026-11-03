import { ConvexError } from "convex/values";
import {
  documentContractVersion,
  projectNfeItem,
  type PublicDocument,
  type PublicDocumentSummary,
  type PublicDocumentVersion,
} from "@freecorps/contracts";
import { payloadOf } from "./documentCore";
import { inlineParts, part, type ContentPlan, type PlannedParts } from "./documentContentPlan";

/**
 * Renderers of the phase B readers (`lib/documentContentPlan.ts`): pure functions of the plan a
 * query selected and the content parts. They run in the Node action after the blobs are read, or
 * in the query itself when every need was answered inline.
 */
export type DetailData = {
  model: PublicDocument["model"];
  summary: PublicDocumentSummary;
  version: PublicDocumentVersion;
  fiscalSituation: PublicDocument["fiscalSituation"];
  previousFiscalSituation: PublicDocument["previousFiscalSituation"];
};
export type ItemsData = { binding: string; versionId: string; from: number; itemCount: number };
export type VersionsData = { page: PublicDocumentVersion[]; nextCursor: string | null };
export type HistoryRow = {
  id: string;
  processorVersion: string;
  completedAt: number;
  code: string;
};
/** Rows with `result: true` take it from the need `f<index>`; the others carry it already. */
export type ImportSummaryData = {
  summary: { files: Array<Record<string, unknown> & { result: string | null | true }> } & Record<
    string,
    unknown
  >;
};

export const itemsCursor = (binding: string, position: number) =>
  btoa(JSON.stringify({ binding, cursor: String(position) }));

const renderers = {
  detail: (data: DetailData, parts: PlannedParts): PublicDocument => ({
    contractVersion: documentContractVersion,
    model: data.model,
    summary: data.summary,
    payload: payloadOf(part(parts, "v", "result")),
    version: data.version,
    fiscalSituation: data.fiscalSituation,
    previousFiscalSituation: data.previousFiscalSituation,
  }),
  items: (data: ItemsData, parts: PlannedParts) => {
    const items = part(parts, "v", "items");
    const next = data.from + items.length;
    return {
      page: items.map((item) => projectNfeItem(JSON.parse(item))),
      versionId: data.versionId,
      nextCursor: next < data.itemCount ? itemsCursor(data.binding, next) : null,
    };
  },
  versions: (data: VersionsData, parts: PlannedParts) => ({
    page: data.page.map((version, index) => ({
      version,
      payload: payloadOf(part(parts, `v${index}`, "result")),
    })),
    nextCursor: data.nextCursor,
  }),
  history: (data: HistoryRow[], parts: PlannedParts) =>
    data.map((row, index) => ({ ...row, result: part(parts, `v${index}`, "result") })),
  importDetail: (data: { versionId: string }, parts: PlannedParts) => ({
    versionId: data.versionId,
    result: part(parts, "v", "result"),
  }),
  importSummary: (data: ImportSummaryData, parts: PlannedParts) => ({
    ...data.summary,
    files: data.summary.files.map((file, index) => ({
      ...file,
      result: file.result === true ? part(parts, `f${index}`, "result") : file.result,
    })),
  }),
} as const;
export type RendererName = keyof typeof renderers;

/** The response of a plan, given the parts of every need. */
export function renderPlan(plan: ContentPlan, parts: PlannedParts): unknown {
  const render = renderers[plan.renderer as RendererName] as
    | ((data: unknown, parts: PlannedParts) => unknown)
    | undefined;
  if (!render) throw new ConvexError({ code: "INVALID_REQUEST", reason: "renderer" });
  return render(plan.data, parts);
}

/**
 * For a plan the query can answer itself: every need was answered inline (or there is none).
 * A version with a blob is read only through an action.
 */
export function renderInline<T>(plan: ContentPlan): T {
  const parts = inlineParts(plan);
  if (!parts) throw new ConvexError({ code: "DOCUMENT_CONTENT_REQUIRES_ACTION" });
  return renderPlan(plan, parts) as T;
}
