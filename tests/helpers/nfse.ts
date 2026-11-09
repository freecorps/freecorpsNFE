import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internal } from "../../platform/convex/_generated/api";
import type { Doc, Id } from "../../platform/convex/_generated/dataModel";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
} from "../../platform/convex/_generated/server";
import { claimFields } from "../../platform/convex/lib/operationValues";
import { insertFiscal } from "../../platform/convex/lib/capacityCore";
import { insertOriginal } from "../../platform/convex/lib/originalStore";

export const NFSE_NAMESPACE = "http:/www.abrasf.org.br/nfse.xsd";
export const LEGACY_NFSE_PARSER = "nfse-abrasf-export/1";

/** A synthetic batch in the ABRASF export layout the import read until 2026-11-02. */
export function nfseXml(numbers = [1, 2, 3, 4, 5, 6, 7], issuer = "11222333000181") {
  return `<ListaNotaFiscal xmlns="${NFSE_NAMESPACE}">${numbers
    .map(
      (number) => `<Nfse><InfNfse>
    <Numero>${number}</Numero><CodigoVerificacao>ABC${number}</CodigoVerificacao>
    <DataEmissao>2026-09-30T12:00:00</DataEmissao><Competencia>2026-09-01T00:00:00</Competencia>
    <Servico><Valores><ValorServicos>1234.56</ValorServicos><ValorIss>24.69</ValorIss><Aliquota>0.02</Aliquota></Valores>
    <ItemListaServico>1.07</ItemListaServico><Discriminacao>Serviço sintético</Discriminacao><CodigoMunicipio>3509502</CodigoMunicipio></Servico>
    <PrestadorServico><IdentificacaoPrestador><Cnpj>${issuer}</Cnpj><InscricaoMunicipal>12345</InscricaoMunicipal></IdentificacaoPrestador><RazaoSocial>Prestador sintético</RazaoSocial></PrestadorServico>
    <TomadorServico><IdentificacaoTomador><CpfCnpj><Cnpj>99888777000166</Cnpj></CpfCnpj></IdentificacaoTomador><RazaoSocial>Tomador sintético</RazaoSocial></TomadorServico>
    <OrgaoGerador><CodigoMunicipio>3509502</CodigoMunicipio><Uf>SP</Uf></OrgaoGerador>
    </InfNfse></Nfse>`,
    )
    .join("")}</ListaNotaFiscal>`;
}

/** The payload the retired reader gave each invoice of an `nfseXml` batch. */
function legacyInvoices(xml: string) {
  const issuer = /<IdentificacaoPrestador><Cnpj>(\d{14})<\/Cnpj>/.exec(xml)![1]!;
  return [...xml.matchAll(/<Nfse>[\s\S]*?<\/Nfse>/g)].map(([entry]) => {
    const number = /<Numero>(\d+)<\/Numero>/.exec(entry)![1]!;
    return {
      sha256: createHash("sha256").update(entry).digest("hex"),
      document: {
        kind: "service-invoice" as const,
        key: `nfse:3509502:${issuer}:12345:${number}`,
        number,
        municipality: "3509502",
        municipalRegistration: "12345",
        verificationCode: `ABC${number}`,
        issuedAt: "2026-09-30T12:00:00",
        competence: "2026-09-01T00:00:00",
        issuer: {
          kind: "CNPJ" as const,
          document: issuer,
          name: "Prestador sintético",
          stateRegistration: null,
        },
        recipient: {
          kind: "CNPJ" as const,
          document: "99888777000166",
          name: "Tomador sintético",
          stateRegistration: null,
        },
        total: "1234.56",
        serviceCode: "1.07",
        description: "Serviço sintético",
        values: [
          { name: "ValorServicos", value: "1234.56" },
          { name: "ValorIss", value: "24.69" },
          { name: "Aliquota", value: "0.02" },
        ],
      },
    };
  });
}

type LegacyEntry = ReturnType<typeof legacyInvoices>[number] & { result: string };

const stageEntries = makeFunctionReference<"mutation">("importWorker:stageLegacyNfseEntries");

/**
 * The ABRASF import was retired on 2026-11-02, and the NFS-e it published stay read-only. This
 * override of `importWorker.ts` brings back only what left (reading an `nfseXml` batch and
 * staging one version per invoice), so a test builds that legacy data through the real
 * admission, checkpoint, publication and content work. Any other file goes to the real worker.
 * `prefix` is the path from the caller's module map to the repository root.
 */
export function legacyNfseImport(prefix = "../../") {
  return {
    [`${prefix}platform/convex/importWorker.ts`]: async () => {
      const real = await import("../../platform/convex/importWorker");
      const execute = internalAction({
        args: { ...claimFields, request: v.string() },
        returns: v.any(),
        handler: async (ctx, args) => {
          const claim = {
            operationId: args.operationId,
            generation: args.generation,
            fence: args.fence,
          };
          const input = await ctx.runMutation(internal.importProcessing.load, claim);
          // A cold original (ADR 0010, decision 8) is never a batch: the real worker reads it.
          const storageId = input?.artifact.storageId;
          const blob = storageId ? await ctx.storage.get(storageId) : null;
          const xml = blob ? await blob.text() : "";
          if (!input || !xml.includes(`xmlns="${NFSE_NAMESPACE}"`))
            return (real.execute as unknown as { _handler: Function })._handler(ctx, args);
          const invoices = legacyInvoices(xml);
          const accepted = invoices.every(({ document }) =>
            [document.issuer.document, document.recipient.document].includes(input.company.cnpj),
          );
          const code = accepted ? "NFSE_BATCH_IMPORTED" : "COMPANY_MISMATCH";
          const metadata = {
            model: "nfse",
            source: "imported-xml",
            originalSha256: input.artifact.sha256,
            versions: { parser: LEGACY_NFSE_PARSER, normalizer: LEGACY_NFSE_PARSER, schema: null },
          };
          const checks = {
            parsing: { status: "passed", code: "XML_PARSED" },
            xsd: { status: "not_checked", code: "NOT_CHECKED" },
            signature: { status: "not_checked", code: "NOT_CHECKED" },
            fiscalEvidence: { status: "not_checked", code: "NOT_CHECKED" },
            originTrust: { status: "not_checked", code: "FISCAL_ORIGIN_NOT_AUTHENTICATED" },
          };
          const result = JSON.stringify({
            metadata: accepted ? metadata : null,
            document: null,
            checks: accepted ? checks : { parsing: { status: "failed", code } },
            documentCount: accepted ? invoices.length : 0,
            fiscalSituation: null,
          });
          const entries = accepted
            ? invoices.map(({ document, sha256 }) => ({
                document,
                sha256,
                result: JSON.stringify({ metadata, document, checks, fiscalSituation: null }),
              }))
            : [];
          const staged = await ctx.runMutation(internal.importProcessing.stage, {
            ...claim,
            artifactId: input.artifact._id,
            fiscalKey: null,
            code,
            kind: accepted ? "service-invoice-batch" : "unknown",
            completeness: -1,
            schema: null,
            parserVersion: LEGACY_NFSE_PARSER,
            normalizerVersion: accepted ? LEGACY_NFSE_PARSER : null,
            processorVersion: input.processorVersion,
            result,
            itemCount: 0,
            outputHash: createHash("sha256")
              .update(JSON.stringify({ result, entries }))
              .digest("hex"),
          });
          if (!staged) return { kind: "definitive", code: "ACCESS_REVOKED" };
          if ("code" in staged) return { kind: "definitive", code: staged.code };
          if (entries.length)
            await ctx.runMutation(stageEntries, {
              operationId: args.operationId,
              versionId: staged.versionId,
              entries,
            });
          return {
            kind: "success",
            response: JSON.stringify({ versionId: staged.versionId, code, itemCount: 0 }),
          };
        },
      });
      const stageLegacyNfseEntries = internalMutation({
        args: {
          operationId: v.id("operations"),
          versionId: v.id("documentVersions"),
          entries: v.any(),
        },
        returns: v.null(),
        handler: async (ctx, args) => {
          const op = (await ctx.db.get("operations", args.operationId))!;
          const parent = (await ctx.db.get("documentVersions", args.versionId))!;
          const original = (await ctx.db.get("documentArtifacts", parent.artifactId))!;
          const entries = args.entries as LegacyEntry[];
          for (const [entryIndex, entry] of entries.entries())
            await stageLegacyEntry(ctx, op, original, args.versionId, entryIndex, entry);
          return null;
        },
      });
      return { ...real, execute, stageLegacyNfseEntries };
    },
  };
}

/** One invoice of a legacy batch, as the retired `stageNfseEntries` wrote it. */
async function stageLegacyEntry(
  ctx: MutationCtx,
  op: Doc<"operations">,
  original: Doc<"documentArtifacts">,
  parentVersionId: Id<"documentVersions">,
  entryIndex: number,
  entry: LegacyEntry,
) {
  const existing = await ctx.db
    .query("fiscalDocuments")
    .withIndex("by_organizationId_companyId_environment_model_fiscalKey", (q) =>
      q
        .eq("organizationId", op.organizationId)
        .eq("companyId", op.companyId)
        .eq("environment", op.environment)
        .eq("model", "nfse")
        .eq("fiscalKey", entry.document.key),
    )
    .unique();
  const documentId =
    existing?._id ??
    (await insertFiscal(ctx, "fiscalDocuments", {
      organizationId: op.organizationId,
      companyId: op.companyId,
      environment: op.environment,
      model: "nfse",
      fiscalKey: entry.document.key,
      completeness: -1,
      createdAt: Date.now(),
    }));
  const prior = await ctx.db
    .query("documentArtifacts")
    .withIndex("by_parentArtifactId_entryIndex", (q) =>
      q.eq("parentArtifactId", original._id).eq("entryIndex", entryIndex),
    )
    .unique();
  const artifactId =
    prior?._id ??
    (await insertOriginal(ctx, {
      organizationId: original.organizationId,
      projectId: original.projectId,
      companyId: original.companyId,
      environment: original.environment,
      documentId,
      parentArtifactId: original._id,
      entryIndex,
      entrySha256: entry.sha256,
      storageId: original.storageId!,
      sha256: original.sha256,
      size: original.size,
      source: original.source,
      importedAt: original.importedAt,
    }));
  await insertFiscal(ctx, "documentVersions", {
    parentVersionId,
    entryIndex,
    artifactId,
    documentId,
    operationId: op._id,
    state: "staging",
    code: "IMPORTED",
    kind: "service-invoice",
    completeness: 2,
    schema: null,
    parserVersion: LEGACY_NFSE_PARSER,
    normalizerVersion: LEGACY_NFSE_PARSER,
    processorVersion: "xml-import/3",
    result: entry.result,
    outputHash: entry.sha256,
    itemCount: 0,
    writtenItems: 0,
    createdAt: Date.now(),
  });
}
