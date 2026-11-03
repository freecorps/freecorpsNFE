import { v, type Infer } from "convex/values";
import { environment } from "./projectValues";

/**
 * NFS-e issuance (ADR 0004, phase 2). Money and rates are exact decimal text; the snapshot is
 * frozen when the request is accepted and never rebuilt.
 *
 * Issuing needs `documents:issue` and cancelling `documents:cancel`: on the API key, in the
 * project's active grant for the company and environment, and for members in the project grant.
 * The task scope is checked again by `operations` on every attempt.
 */
export const ISSUE_SCOPE = "documents:issue" as const;
export const CANCEL_SCOPE = "documents:cancel" as const;
export const issueTask = {
  name: "documents.issue",
  workload: "issuance",
  scope: ISSUE_SCOPE,
  executor: "issuanceWorker:issue",
  reconciler: "issuanceWorker:reconcileIssue",
  checkpoint: "issuanceProcessing:checkpointIssue",
} as const;
export const cancelTask = {
  name: "documents.cancel",
  workload: "issuance",
  scope: CANCEL_SCOPE,
  executor: "issuanceWorker:cancel",
  reconciler: "issuanceWorker:reconcileCancel",
  checkpoint: "issuanceProcessing:checkpointCancel",
} as const;

/**
 * Application version written in `verAplic` of the DPS and of the events. The XSD (TSVerAplic)
 * caps it at 20 characters: the 25-character value used before was refused with L9999.
 */
export const VER_APLIC = "freecorpsNFE/1";
export const SNAPSHOT_VERSION = "issuance-snapshot/1";
/** Currencies with a BACEN code known to the core package (comExt.tpMoeda). */
export const FOREIGN_CURRENCIES = ["USD", "CAD", "EUR", "GBP"] as const;

/**
 * Where the DPS goes. `simulated`: deterministic synthetic tax authority, no network, no
 * certificate. `producao-restrita`: the real restricted production of the target, chosen by
 * the deployment variable `FNFE_NFSE_SANDBOX_TRANSPORT` for the companies listed in
 * `FNFE_NFSE_RESTRICTED_COMPANIES` (`restrictedTransportAllowed`). `producao`: real production,
 * only for the `production` environment with the company gate open; the certificate vault still
 * refuses it, because no fiscal production deployment exists (phase 4).
 */
export const transportMode = v.union(
  v.literal("simulated"),
  v.literal("producao-restrita"),
  v.literal("producao"),
);
export type TransportMode = Infer<typeof transportMode>;

const nationalTaker = v.object({
  kind: v.literal("national"),
  /** CPF (11) or CNPJ (14) digits; punctuation is accepted and removed. */
  document: v.string(),
  name: v.string(),
  email: v.optional(v.string()),
  address: v.object({
    /** IBGE code of the taker's municipality, 7 digits. */
    municipalityCode: v.string(),
    postalCode: v.string(),
    street: v.string(),
    number: v.string(),
    district: v.string(),
  }),
});
const foreignTaker = v.object({
  kind: v.literal("foreign"),
  /** Foreign tax id. Without it, `nifAbsence` explains why (1 waived, 2 not required). */
  nif: v.optional(v.string()),
  nifAbsence: v.optional(v.union(v.literal(1), v.literal(2))),
  name: v.string(),
  email: v.optional(v.string()),
  /**
   * The DPS XSD requires the whole foreign address (TCEnderExt and TCEndereco); the request is
   * refused without postal code, state, street, number or district. The validator keeps them
   * optional so that snapshots frozen before this rule still load.
   */
  address: v.object({
    /** ISO 3166-1 alpha-2. */
    country: v.string(),
    city: v.string(),
    postalCode: v.optional(v.string()),
    state: v.optional(v.string()),
    street: v.optional(v.string()),
    number: v.optional(v.string()),
    district: v.optional(v.string()),
  }),
});
export const issuanceTaker = v.union(nationalTaker, foreignTaker);
export const issuanceInput = v.object({
  /** `code` of an activity of the company's NFS-e profile. */
  activityCode: v.string(),
  /** Competence month, `AAAA-MM`. */
  competence: v.string(),
  /** Civil date of the issue in Brasília, `AAAA-MM-DD`; today when absent. Also the PTAX reference. */
  issueDate: v.optional(v.string()),
  /**
   * E-mail of the provider written in the DPS (`prest/email`). Optional when the NFS-e profile
   * holds one, which is then used; the request's e-mail wins when both exist.
   */
  issuerEmail: v.optional(v.string()),
  market: v.union(v.literal("domestic"), v.literal("export")),
  taker: issuanceTaker,
  description: v.string(),
  /** Service value in `currency`, decimal text with at most 2 places. Foreign: converted by PTAX. */
  amount: v.object({ currency: v.string(), value: v.string() }),
  /** ISS rate of the competence, percent as decimal text (`"2"`, `"2.0100"`). */
  issRate: v.optional(v.string()),
  /** ISS withheld by the taker (tpRetISSQN 2). */
  issWithheld: v.boolean(),
});
export type IssuanceInput = Infer<typeof issuanceInput>;

export const cancelReason = v.union(v.literal("1"), v.literal("2"), v.literal("9"));
export const issuanceState = v.union(
  v.literal("processing"),
  v.literal("authorized"),
  v.literal("rejected"),
  v.literal("cancelled"),
);
export const cancellationState = v.union(
  v.literal("processing"),
  v.literal("registered"),
  v.literal("rejected"),
);
export const rejectionItem = v.object({ code: v.union(v.string(), v.null()), message: v.string() });
export const exchangeFields = v.object({
  currency: v.string(),
  /** Amount in the original currency, as frozen in the snapshot. */
  amount: v.string(),
  /** PTAX sale rate, 6 places. */
  rate: v.string(),
  /** Date of the bulletin used, `AAAA-MM-DD`. */
  quoteDate: v.string(),
  brlAmount: v.string(),
  source: v.union(v.literal("ptax-bcb"), v.literal("simulated")),
  frozenAt: v.number(),
});
export const artifactKind = v.union(
  v.literal("dps"),
  v.literal("nfse"),
  v.literal("cancel-request"),
  v.literal("cancel-event"),
  /** DANFSe in PDF rendered by the platform from the authorized XML (`nfse`). */
  v.literal("danfse"),
);
export const issuanceEventKind = v.union(
  v.literal("accepted"),
  v.literal("exchange_frozen"),
  v.literal("dps_saved"),
  v.literal("submitted"),
  v.literal("authorized"),
  v.literal("danfse_saved"),
  v.literal("danfse_failed"),
  v.literal("rejected"),
  v.literal("cancel_requested"),
  v.literal("cancel_submitted"),
  v.literal("cancelled"),
  v.literal("cancel_rejected"),
);

/** The first ID of a rehydrated issuance or artifact (ADR 0009, §6); absent otherwise. */
const originalIdField = { originalId: v.optional(v.string()) };
export const artifactView = v.object({
  id: v.id("issuanceArtifacts"),
  ...originalIdField,
  kind: artifactKind,
  sha256: v.string(),
  size: v.number(),
  signed: v.boolean(),
  createdAt: v.number(),
});
export const cancellationView = v.object({
  id: v.id("issuanceCancellations"),
  operationId: v.id("operations"),
  state: cancellationState,
  sequence: v.number(),
  reasonCode: cancelReason,
  reason: v.string(),
  code: v.union(v.string(), v.null()),
  rejections: v.array(rejectionItem),
  alreadyRegistered: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
});
export const issuanceView = v.object({
  id: v.id("issuances"),
  ...originalIdField,
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  companyId: v.id("companies"),
  environment,
  operationId: v.id("operations"),
  operationState: v.string(),
  state: issuanceState,
  transport: transportMode,
  target: v.string(),
  series: v.string(),
  number: v.number(),
  dpsId: v.string(),
  issueDate: v.string(),
  competence: v.string(),
  market: v.union(v.literal("domestic"), v.literal("export")),
  amount: v.object({ currency: v.string(), value: v.string() }),
  serviceBrl: v.union(v.string(), v.null()),
  exchange: v.union(exchangeFields, v.null()),
  accessKey: v.union(v.string(), v.null()),
  nfseNumber: v.union(v.string(), v.null()),
  documentId: v.union(v.id("fiscalDocuments"), v.null()),
  code: v.union(v.string(), v.null()),
  rejections: v.array(rejectionItem),
  artifacts: v.array(artifactView),
  cancellation: v.union(cancellationView, v.null()),
  version: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});
export type IssuanceView = Infer<typeof issuanceView>;
