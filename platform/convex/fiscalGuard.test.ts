import { expect, it } from "vite-plus/test";
import schema from "./schema";
import { PRODUCTION_TABLES } from "./fiscalGuard";

/**
 * #120: `sandboxOnly`, which lets the closure remove a Sandbox-only organization early, reads
 * Production from fixed tables. A table that marks an environment and is in no list below would
 * be skipped by that decision without anything noticing, so each one is either read there or
 * excluded with a reason.
 */

/** Tables with `environment` that `neverProduction` does not read, and why. */
const OUTSIDE_PRODUCTION_TABLES: Record<string, string> = {
  documentArtifacts: "an original of an import or a capture stream of the same environment",
  documentListings: "a listing row of a fiscal document of the same environment",
  documentDanfes: "a DANFE rendered from a fiscal document of the same environment",
  documentDownloads: "a download ticket for an original or issuance of the same environment",
  documentExports: "a copy of fiscal documents of the same environment",
  issuanceCancellations: "a cancellation of an issuance of the same environment",
  issuanceProbeEvents: "its environment is the fisco's (`producao`), read from the probe history",
  stripeConnections: "a Production connection issues only through the gate, read from its history",
  stripeEvents: "an event of a Stripe connection, which issues only through the gate",
  operationalFailures: "a failure of an operation of the same environment",
  operationalAudit: "an action log; what an action produced is in its own table",
  operationalMonitors: "a monitor's settings, with no fiscal document",
  outboxEvents: "a notification of a resource of the same environment, or a synthetic test",
  webhookEndpoints: "an endpoint's settings, with no fiscal document",
  apiKeys: "a key's settings; its use is in `apiUsageEvents`",
  registryLookups: "a public CNPJ lookup, in the deployment's environment, not the company's",
};

/** Tables with `tpAmb` (#108), and where the decision reads them. */
const TP_AMB_TABLES: Record<string, string> = {
  fiscalDocuments: "`realDocument` reads every received note",
  documentArtifacts: "`realOriginal` reads every imported original without a document",
};

/** Tables whose rows have `field`, in any member of a union. */
function tablesWith(field: string) {
  const has = (validator: { kind: string; fields?: object; members?: unknown[] }): boolean =>
    validator.kind === "union"
      ? (validator.members as (typeof validator)[]).some(has)
      : validator.kind === "object" && field in validator.fields!;
  return Object.entries(schema.tables)
    .filter(([, definition]) => has(definition.validator))
    .map(([table]) => table)
    .sort();
}

it("lê ou exclui com motivo cada tabela do schema com ambiente", () => {
  const read: readonly string[] = PRODUCTION_TABLES;
  const outside = Object.keys(OUTSIDE_PRODUCTION_TABLES);
  expect(
    read.filter((table) => outside.includes(table)),
    "in both lists",
  ).toEqual([]);
  expect
    .soft(tablesWith("environment"), "add to PRODUCTION_TABLES or OUTSIDE_PRODUCTION_TABLES")
    .toEqual([...read, ...outside].sort());
  expect
    .soft(tablesWith("tpAmb"), "read it in `neverProduction` and add to TP_AMB_TABLES")
    .toEqual(Object.keys(TP_AMB_TABLES).sort());
});
