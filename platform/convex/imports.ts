import {
  insertFiscal,
  ensureCapacityReady,
  reserveCapacity,
  checkCapacity,
  capacityPolicy,
} from "./lib/capacityCore";
import { v, type Infer } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { contentNeed, type ContentPlan } from "./lib/documentContentPlan";
import { internal } from "./_generated/api";
import { scopeFields, companyScopeFields, canonicalRequest } from "./lib/operationValues";
import {
  importTask,
  fileSpec,
  fileResult,
  reservedImport,
  importResult,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_FILES,
  UPLOAD_TTL,
  RESERVATION_TTL,
  PROCESSOR_VERSION,
} from "./lib/importValues";
import {
  importAccess,
  getFile,
  importSummary,
  importStates,
  expireFile,
  pendingNoteKey,
} from "./lib/importCore";
import {
  keyAccess,
  memberAccess,
  originOf,
  projectAccess,
  recordOrigin,
} from "./lib/operationAccess";
import { ensureConsoleProject } from "./lib/projectAccess";
import { storageHash } from "./lib/importValues";
import { requireMembership } from "./lib/organizationAccess";
import { findCompany } from "./lib/companyAccess";
import { deny } from "./lib/organizationAccess";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { requestCleanup } from "./importUpload";
import { requirePlatformEnvironment } from "./environment";
import { requireTermsOfUse } from "./lib/termsOfUse";
import { reserveUsage, commitUsage, rateUsage, pickLane, planFor } from "./lib/usageCore";
import { noteLimit } from "./lib/usageValues";

export const reservationArgs = { ...scopeFields, key: v.string(), files: v.array(fileSpec) };
/**
 * What the console needs beyond the REST summary, so it offers only the actions that make sense:
 * who created the batch (the console changes only its own) and, per file, the processor that
 * produced the visible result (reprocessing with the same processor repeats the same answer).
 */
const consoleImportResult = v.object({
  ...importResult.fields,
  files: v.array(
    v.object({ ...fileResult.fields, processorVersion: v.union(v.string(), v.null()) }),
  ),
  origin: recordOrigin,
  currentProcessor: v.string(),
});
/** A batch of the company selected in the console, whichever project or person created it. */
export const selected = query({
  args: { ...companyScopeFields, batch: v.string(), includeResults: v.optional(v.boolean()) },
  returns: v.union(consoleImportResult, v.null()),
  handler: async (ctx, args) => {
    await memberAccess(ctx, { ...args, task: importTask }, false);
    const id = ctx.db.normalizeId("imports", args.batch);
    const batch = id ? await ctx.db.get("imports", id) : null;
    if (
      !batch ||
      batch.organizationId !== args.organizationId ||
      batch.companyId !== args.companyId ||
      batch.environment !== args.environment
    )
      return null;
    // `result` is a version's content, which a query cannot read once B8 moves it: the console
    // reads it through `contentRead.importDetail`. `includeResults` stays accepted, ignored.
    const summary = await importSummary(ctx, batch, false);
    const files = await Promise.all(
      summary.files.map(async (file) => ({
        ...file,
        processorVersion: file.versionId
          ? ((await ctx.db.get("documentVersions", file.versionId))?.processorVersion ?? null)
          : null,
      })),
    );
    return {
      ...summary,
      files,
      origin: await originOf(ctx, batch),
      currentProcessor: PROCESSOR_VERSION,
    };
  },
});
export async function reserveImport(
  ctx: MutationCtx,
  args: { [K in keyof typeof reservationArgs]: Infer<(typeof reservationArgs)[K]> },
  keyHash?: string,
) {
  const scope = { ...args, task: importTask };
  const sourceKey = keyHash ? await keyAccess(ctx, keyHash, scope) : null;
  if (!keyHash) await memberAccess(ctx, scope, true);
  if (
    !/^[\x21-\x7e]{1,128}$/.test(args.key) ||
    args.files.length < 1 ||
    args.files.length > MAX_IMPORT_FILES
  )
    deny("INVALID_REQUEST");
  for (const file of args.files) {
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > MAX_IMPORT_BYTES ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !/^[^/\\]{1,180}\.xml$/i.test(file.name) ||
      file.name.split("").some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      deny("INVALID_FILE");
  }
  const requestHash = await hashApiKey(
    canonicalRequest(
      JSON.stringify({
        companyId: args.companyId,
        environment: args.environment,
        files: args.files,
      }),
    ),
  );
  const existing = await ctx.db
    .query("imports")
    .withIndex("by_organizationId_and_projectId_and_key", (q) =>
      q
        .eq("organizationId", args.organizationId)
        .eq("projectId", args.projectId)
        .eq("key", args.key),
    )
    .unique();
  if (existing) {
    await importAccess(ctx, existing, keyHash);
    if (existing.requestHash !== requestHash) deny("IDEMPOTENCY_CONFLICT");
    const files = await ctx.db
      .query("importFiles")
      .withIndex("by_importId", (q) => q.eq("importId", existing._id))
      .take(MAX_IMPORT_FILES);
    return { importId: existing._id, fileIds: files.map((f) => f._id), reused: true };
  }
  await requireTermsOfUse(ctx, args.organizationId);
  await ensureCapacityReady(ctx, args.organizationId);
  await checkCapacity(ctx, args.organizationId, "databaseBytes", 1);
  // With the capacity policy on, the stock gates the batch here, exactly. With it off nothing is
  // gated, and the upload ticket (`importUpload.tokenFile`) reserves the same key before any byte
  // arrives; reserving here too would make every admission of the organization rewrite its stock
  // total (#559).
  const gateStock = await capacityPolicy(ctx);
  const importId = await ctx.db.insert("imports", {
    organizationId: args.organizationId,
    projectId: args.projectId,
    companyId: args.companyId,
    environment: args.environment,
    key: args.key,
    requestHash,
    createdAt: Date.now(),
  });
  const fileIds = [];
  // One lane for every usage total and rate budget this admission charges (#559).
  const lane = pickLane();
  // Under a plan with `notes`, in Production, each file holds a provisional note until its
  // processing ends or it expires (ADR 0010, decision 10): the admission counts published notes,
  // pending files and this batch's files, so reserving batch after batch before any upload cannot
  // pass the limit. The `imports` reservation of the next file refuses once they reach it.
  const pendingNotes =
    noteLimit(await planFor(ctx, args.organizationId), "imports", args.environment) !== null;
  for (const [position, file] of args.files.entries()) {
    fileIds.push(
      await ctx.db.insert("importFiles", {
        ...file,
        importId,
        position,
        state: "reserved",
        expiresAt: Date.now() + RESERVATION_TTL,
      }),
    );
    const fileId = fileIds[fileIds.length - 1]!;
    if (gateStock)
      await reserveCapacity(ctx, args.organizationId, "filesBytes", `import:${fileId}`, file.size);
    // Distinct metrics have disjoint balances. Files still reserve sequentially.
    await Promise.all([
      reserveUsage(
        ctx,
        args.organizationId,
        args.environment,
        "imports",
        String(fileId),
        1,
        false,
        lane,
      ),
      reserveUsage(
        ctx,
        args.organizationId,
        args.environment,
        "bytes",
        String(fileId),
        file.size,
        false,
        lane,
      ),
    ]);
    if (pendingNotes)
      await reserveUsage(
        ctx,
        args.organizationId,
        args.environment,
        "documents",
        pendingNoteKey(fileId),
        1,
        true,
        lane,
      );
  }
  await Promise.all([
    ctx.scheduler.runAfter(RESERVATION_TTL, internal.imports.expire, { importId }),
    requestCleanup(ctx, Date.now() + RESERVATION_TTL + UPLOAD_TTL),
  ]);
  // Read the contended budgets last. Refusal rolls back this entire mutation,
  // including reservations, imported file records and scheduled work.
  await rateUsage(
    ctx,
    args.organizationId,
    sourceKey?._id,
    { name: "organization-imports", rate: 20 },
    lane,
  );
  return { importId, fileIds, reused: false };
}
/** Console reservation: the batch and its idempotency key belong to the console project. */
export const reserve = mutation({
  args: { ...companyScopeFields, key: v.string(), files: v.array(fileSpec) },
  returns: reservedImport,
  handler: async (ctx, args) => {
    const { membership } = await memberAccess(ctx, { ...args, task: importTask }, true);
    const projectId = await ensureConsoleProject(ctx, membership);
    return reserveImport(ctx, { ...args, projectId });
  },
});
export const get = query({
  args: {
    importId: v.id("imports"),
    expectedScope: v.optional(v.object(companyScopeFields)),
    includeResults: v.optional(v.boolean()),
  },
  returns: importResult,
  handler: async (ctx, args) => {
    const batch = await ctx.db.get("imports", args.importId);
    if (!batch) return deny("NOT_FOUND");
    await importAccess(ctx, batch, undefined, false);
    if (
      args.expectedScope &&
      (batch.organizationId !== args.expectedScope.organizationId ||
        batch.companyId !== args.expectedScope.companyId ||
        batch.environment !== args.expectedScope.environment)
    )
      return deny("NOT_FOUND");
    return importSummary(ctx, batch, false);
  },
});
/** Only the current, completed version of this file can be expanded by the console. */
/**
 * The result of one version of a file, for the console (B6, `contentRead.importDetail`): `null`
 * while the operation has not succeeded or the version is not the file's.
 */
export async function importDetailPlan(
  ctx: QueryCtx,
  args: {
    fileId: Id<"importFiles">;
    versionId: Id<"documentVersions">;
    expectedScope: {
      organizationId: Id<"organizations">;
      companyId: Id<"companies">;
      environment: "sandbox" | "production";
    };
  },
): Promise<ContentPlan<{ versionId: string }> | null> {
  const { file, batch } = await getFile(ctx, args.fileId, undefined, false);
  if (
    batch.organizationId !== args.expectedScope.organizationId ||
    batch.companyId !== args.expectedScope.companyId ||
    batch.environment !== args.expectedScope.environment
  )
    return deny("NOT_FOUND");
  const operationId = file.processingOperationId ?? file.operationId;
  if (!operationId) return null;
  const operation = await ctx.db.get("operations", operationId);
  if (operation?.state !== "succeeded") return null;
  const version = await ctx.db.get("documentVersions", args.versionId);
  if (
    !version ||
    version.operationId !== operationId ||
    version.entryIndex !== undefined ||
    version.state !== "complete"
  )
    return null;
  return {
    renderer: "importDetail",
    data: { versionId: version._id },
    needs: [await contentNeed(ctx, "v", version, { result: true })],
  };
}
/**
 * The company's latest batches, from the console and from every integration, with what the
 * console lists: date, origin and the state and result code of each file (`importStates`, which
 * reads neither the published documents nor the results).
 */
export const recent = query({
  args: companyScopeFields,
  returns: v.array(
    v.object({
      id: v.id("imports"),
      createdAt: v.number(),
      origin: recordOrigin,
      files: v.array(v.object({ state: v.string(), code: v.union(v.string(), v.null()) })),
    }),
  ),
  handler: async (ctx, args) => {
    await memberAccess(ctx, { ...args, task: importTask }, false);
    const rows = await ctx.db
      .query("imports")
      .withIndex("by_organizationId_and_companyId_and_environment", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("companyId", args.companyId)
          .eq("environment", args.environment),
      )
      .order("desc")
      .take(10);
    return Promise.all(
      rows.map(async (row) => ({
        id: row._id,
        createdAt: row.createdAt,
        origin: await originOf(ctx, row),
        files: await importStates(ctx, row),
      })),
    );
  },
});
export async function uploadTicket(
  ctx: MutationCtx,
  fileId: import("./_generated/dataModel").Id<"importFiles">,
  keyHash?: string,
) {
  const { file, batch } = await getFile(ctx, fileId, keyHash);
  if (file.state !== "reserved" || file.expiresAt <= Date.now()) return deny("UPLOAD_EXPIRED");
  const token = crypto.randomUUID() + crypto.randomUUID();
  const scope = { ...batch, task: importTask };
  const { project, grant } = await projectAccess(ctx, scope);
  const key = keyHash ? await keyAccess(ctx, keyHash, scope) : null;
  const member = !key ? (await requireMembership(ctx, batch.organizationId)).membership : null;
  const access = member ? await findCompany(ctx, member, batch.companyId) : null;
  await ctx.db.patch("importFiles", file._id, {
    tokenHash: await hashApiKey(token),
    tokenExpiresAt: Math.min(file.expiresAt, Date.now() + UPLOAD_TTL),
    tokenKeyId: key?._id,
    tokenMembershipId: member?._id,
    tokenAccessVersion: access?.accessVersion,
    tokenProjectEpoch: project.accessEpoch,
    tokenGrantEpoch: grant.accessEpoch,
  });
  return {
    url: `${requirePlatformEnvironment().apiUrl}/v1/import-upload`,
    token,
    expiresAt: Math.min(file.expiresAt, Date.now() + UPLOAD_TTL),
  };
}
export const upload = mutation({
  args: { fileId: v.id("importFiles") },
  returns: v.object({ url: v.string(), token: v.string(), expiresAt: v.number() }),
  handler: (ctx, args) => uploadTicket(ctx, args.fileId),
});
export async function confirmFile(
  ctx: MutationCtx,
  fileId: import("./_generated/dataModel").Id<"importFiles">,
  keyHash?: string,
  processorVersion = PROCESSOR_VERSION,
) {
  const { file, batch } = await getFile(ctx, fileId, keyHash);
  if (file.operationId) return { operationId: file.operationId, reused: true };
  if (file.state !== "uploaded" || !file.storageId || file.expiresAt <= Date.now())
    return deny("UPLOAD_EXPIRED");
  const metadata = await ctx.db.system.get("_storage", file.storageId);
  if (!metadata || metadata.size !== file.size || storageHash(metadata.sha256) !== file.sha256)
    return deny("INVALID_FILE");
  await commitUsage(ctx, batch.organizationId, "imports", String(fileId));
  await commitUsage(ctx, batch.organizationId, "bytes", String(fileId));
  const artifactId = await insertFiscal(ctx, "documentArtifacts", {
    organizationId: batch.organizationId,
    projectId: batch.projectId,
    companyId: batch.companyId,
    environment: batch.environment,
    fileId,
    storageId: file.storageId,
    sha256: file.sha256,
    size: file.size,
    source: "imported-xml",
    importedAt: file.uploadedAt!,
  });
  const result: {
    operationId: import("./_generated/dataModel").Id<"operations">;
    reused: boolean;
  } = await ctx.runMutation(internal.operations.reserve, {
    organizationId: batch.organizationId,
    projectId: batch.projectId,
    companyId: batch.companyId,
    environment: batch.environment,
    ...(keyHash ? { keyHash } : {}),
    key: String(fileId),
    task: importTask,
    request: JSON.stringify({ artifactId, processorVersion }),
  });
  await ctx.db.patch("importFiles", fileId, {
    state: "accepted",
    operationId: result.operationId,
    tokenHash: undefined,
    tokenExpiresAt: undefined,
  });
  return result;
}
export const confirm = mutation({
  args: { fileId: v.id("importFiles") },
  returns: v.object({ operationId: v.id("operations"), reused: v.boolean() }),
  handler: (ctx, args) => confirmFile(ctx, args.fileId),
});
export const expire = internalMutation({
  args: { importId: v.id("imports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("importFiles")
      .withIndex("by_importId", (q) => q.eq("importId", args.importId))
      .take(MAX_IMPORT_FILES);
    for (const file of files) if (file.expiresAt <= Date.now()) await expireFile(ctx, file);
    return null;
  },
});
export const cancel = mutation({
  args: { fileId: v.id("importFiles") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { file } = await getFile(ctx, args.fileId);
    if (file.state === "accepted") return deny("ALREADY_ACCEPTED");
    await expireFile(ctx, file);
    return null;
  },
});
