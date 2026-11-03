"use node";
import { createHash } from "node:crypto";
import { v, type Infer } from "convex/values";
import { distributionRequest, parseDistribution } from "@freecorps/fiscal-nfe";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { claimFields, outcome } from "./lib/operationValues";
import { RefusedBeforeSend, transportWithCertificate } from "./lib/certificateRuntime";
import { productEnvironmentOf, proofFiscalTarget } from "./lib/fiscalProof";
import { siteCaptureProfile } from "./lib/siteCapture";
import { cutByVariable } from "./lib/captureAttention";

export const execute = internalAction({
  args: { ...claimFields, request: v.string() },
  returns: outcome,
  handler: async (ctx, args): Promise<Infer<typeof outcome>> => {
    const claim = { operationId: args.operationId, generation: args.generation, fence: args.fence };
    const input = await ctx.runMutation(internal.captureProcessing.prepare, claim);
    if (!input) return { kind: "definitive", code: "CAPTURE_INACTIVE" };
    // Nothing is sent before the window: a wait, never a failure (#421).
    if (input.waitUntil > Date.now())
      return { kind: "wait", code: "SOURCE_COOLDOWN", notBefore: input.waitUntil };
    let batchId: Id<"captureBatches">, raw: Uint8Array;
    if (input.batch) {
      const blob = await ctx.storage.get(input.batch.rawId);
      if (!blob) {
        await ctx.runMutation(internal.captureProcessing.failed, {
          ...claim,
          code: "BATCH_UNAVAILABLE",
        });
        return { kind: "definitive", code: "BATCH_UNAVAILABLE" };
      }
      raw = new Uint8Array(await blob.arrayBuffer());
      if (createHash("sha256").update(raw).digest("hex") !== input.batch.rawHash) {
        await ctx.runMutation(internal.captureProcessing.failed, {
          ...claim,
          code: "BATCH_HASH_MISMATCH",
        });
        return { kind: "definitive", code: "BATCH_HASH_MISMATCH" };
      }
      batchId = input.batch._id;
    } else {
      const synthetic: string | null =
        process.env.APP_ENV === "development" && process.env.FISCAL_ENV === "disabled"
          ? await ctx.runMutation(internal.testing.captureProof.next, {
              streamId: input.stream._id,
            })
          : null;
      // Node can replace process.env between invocations; read the current object.
      const proofTransport =
        process.env.FNFE_CAPTURE_TRANSPORT === "sefaz" &&
        process.env.FISCAL_ENV === proofFiscalTarget() &&
        input.stream.environment === productEnvironmentOf(proofFiscalTarget());
      // The hosted site: only production streams, whose operation `prepare` and the vault
      // authorize against the company's release (`lib/siteCapture.ts`).
      const siteTransport = siteCaptureProfile() && input.stream.environment === "production";
      if (synthetic === null && !proofTransport && !siteTransport) {
        // Whether it was the Freecorps cut is read now, with the variables that refused the
        // transport: `failed` runs later and they may be back by then (#601).
        await ctx.runMutation(internal.captureProcessing.failed, {
          ...claim,
          code: "FISCAL_TRANSPORT_DISABLED",
          cut: cutByVariable(input.stream, "FISCAL_TRANSPORT_DISABLED"),
        });
        return { kind: "definitive", code: "FISCAL_TRANSPORT_DISABLED" };
      }
      const request = distributionRequest({
        cnpj: input.stream.identity,
        environment: input.stream.environment,
        nsu: input.nsu,
        mode: input.mode,
      });
      if (synthetic !== null) raw = new TextEncoder().encode(synthetic);
      else
        try {
          const response = await transportWithCertificate(ctx, claim, {
            ...request,
            allowedOrigins: [new URL(request.url).origin],
            maxBytes: 2 * 1024 * 1024,
          });
          if (response.status !== 200)
            return {
              kind: "uncertain",
              code: "SOURCE_HTTP_ERROR",
              notBefore: Date.now() + 3_600_000,
            };
          raw = response.body;
        } catch (error) {
          // The vault refused before the request (`RefusedBeforeSend` is thrown only before the
          // A1 is decrypted and the request made): nothing reached the source, so there is
          // nothing to reconcile. `prepare`'s reservation is undone, then the operation waits
          // or pauses with the refusal's code, without becoming uncertain (#421).
          if (error instanceof RefusedBeforeSend) {
            const waitUntil: number | null = await ctx.runMutation(
              internal.captureProcessing.refusedBeforeSend,
              { ...claim, code: error.code, defer: error.defer ?? null, cut: error.cut },
            );
            return waitUntil === null
              ? { kind: "definitive", code: error.code }
              : { kind: "wait", code: error.code, notBefore: waitUntil };
          }
          // Any other error may come after the request left: the result is unknown.
          return {
            kind: "uncertain",
            code: "SOURCE_RESULT_UNCERTAIN",
            notBefore: Date.now() + 3_600_000,
          };
        }
      const rawId = await ctx.storage.store(
        new Blob([Uint8Array.from(raw)], { type: "application/xml" }),
      );
      // Persistence errors escape: the operation watchdog retains the uncertain external effect.
      const saved = await ctx.runMutation(internal.captureProcessing.raw, {
        ...claim,
        rawId,
        rawHash: createHash("sha256").update(raw).digest("hex"),
        nsu: input.nsu,
        mode: input.mode,
      });
      if (!saved) {
        await ctx.storage.delete(rawId);
        return { kind: "uncertain", code: "CAPTURE_CHANGED" };
      }
      batchId = saved;
    }
    let result: ReturnType<typeof parseDistribution>;
    try {
      result = parseDistribution(raw, input.stream.environment);
    } catch {
      await ctx.runMutation(internal.captureProcessing.failed, {
        ...claim,
        code: "SOURCE_RESPONSE_INVALID",
      });
      return { kind: "definitive", code: "SOURCE_RESPONSE_INVALID" };
    }
    if (
      !(await ctx.runMutation(internal.captureProcessing.describe, {
        ...claim,
        batchId,
        status: result.status,
        lastNsu: result.lastNsu,
        maxNsu: result.maxNsu,
        count: result.envelopes.length,
      }))
    )
      return { kind: "uncertain", code: "CAPTURE_CHANGED" };
    for (const [position, envelope] of result.envelopes.entries()) {
      const storageId = await ctx.storage.store(
        new Blob([Uint8Array.from(envelope.xml)], { type: "application/xml" }),
      );
      const saved = await ctx.runMutation(internal.captureProcessing.envelope, {
        ...claim,
        batchId,
        position,
        nsu: envelope.nsu,
        schema: envelope.schema,
        sha256: envelope.sha256,
        size: envelope.xml.length,
        storageId,
      });
      if (!saved) {
        await ctx.storage.delete(storageId);
        return { kind: "uncertain", code: "CAPTURE_CHANGED" };
      }
    }
    return {
      kind: "success",
      response: JSON.stringify({ status: result.status, count: result.envelopes.length }),
    };
  },
});
