import { v } from "convex/values";
import { companyScopeFields } from "./lib/operationValues";

/** Arguments of the console's content readers (ADR 0010, B6), shared by `contentRead.ts` and
 * the Node actions of `documentContentNode.ts`. */
export const readerArgs = {
  documentDetail: {
    ...companyScopeFields,
    documentId: v.string(),
    versionId: v.optional(v.string()),
  },
  documentItems: {
    ...companyScopeFields,
    documentId: v.string(),
    versionId: v.string(),
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
  },
  documentVersions: {
    ...companyScopeFields,
    documentId: v.string(),
    kind: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
  },
  importDetail: {
    fileId: v.id("importFiles"),
    versionId: v.id("documentVersions"),
    expectedScope: v.object(companyScopeFields),
  },
  importHistory: { fileId: v.id("importFiles") },
};
