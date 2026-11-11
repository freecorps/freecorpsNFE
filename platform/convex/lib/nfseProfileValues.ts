import { v, type Infer } from "convex/values";
import { environment } from "./projectValues";

/**
 * Codes of the national NFS-e layout (DPS 1.01, group `regTrib` of the provider).
 * opSimpNac: 1 not opting, 2 MEI, 3 ME/EPP. regApTribSN exists only for ME/EPP:
 * 1 federal and municipal taxes by the Simples, 2 federal by the Simples and ISSQN outside,
 * 3 federal and municipal outside. regEspTrib: 0 none, 1 cooperative act, 2 estimate,
 * 3 municipal microenterprise, 4 notary or registrar, 5 self-employed professional,
 * 6 professional partnership.
 */
export const opSimpNac = v.union(v.literal(1), v.literal(2), v.literal(3));
export const regApTribSN = v.union(v.literal(1), v.literal(2), v.literal(3));
export const regEspTrib = v.union(
  v.literal(0),
  v.literal(1),
  v.literal(2),
  v.literal(3),
  v.literal(4),
  v.literal(5),
  v.literal(6),
);
/**
 * Minimum of the group `IBSCBS` of the DPS 1.01 (NT 005/2025): the operation indicator
 * (`cIndOp`, 6 digits, annex VII), the CST (3 digits) and the tax classification
 * (`cClassTrib`, 6 digits, annex VI). `finNFSe` is always 0 (regular) and `indDest` 0 (the
 * recipient is the taker); no IBS/CBS amount is declared here.
 */
export const ibsCbsClassification = v.object({
  cIndOp: v.string(),
  cst: v.string(),
  cClassTrib: v.string(),
});
export const nfseActivity = v.object({
  /** Internal code the integrator uses to pick the activity; unique in the profile. */
  code: v.string(),
  label: v.string(),
  /** CNAE subclass, 7 digits. */
  cnae: v.string(),
  /** Item of the LC 116/2003 list, `01.05`. */
  lc116Item: v.string(),
  /** National taxation code, 6 digits: LC 116 item, subitem and national breakdown. */
  cTribNac: v.string(),
  /** NBS, 9 digits. Some municipalities require it (Campinas: E0316). */
  nbs: v.optional(v.string()),
  /**
   * Municipal taxation code of the national layout (`cTribMun`, 3 digits): the suffix the
   * municipality appends to `cTribNac` (`010501` + `001`). The Campinas validator requires it.
   */
  cTribMun: v.optional(v.string()),
  /**
   * IBS/CBS classification of the activity (group `IBSCBS`). Issuing requires it when the Ato
   * Conjunto RFB/CGIBS 4/2026 makes the group mandatory, and the Campinas validator always does.
   */
  ibsCbs: v.optional(ibsCbsClassification),
  description: v.optional(v.string()),
});
/**
 * The ISS rate is not part of the profile: it comes with each request, by competence.
 * The environment gate belongs to the emission, too; the profile is the company's.
 */
export const nfseProfileFields = {
  municipalRegistration: v.optional(v.string()),
  /** Provider e-mail of the DPS (`prest/email`); a request without `issuerEmail` uses it. */
  issuerEmail: v.optional(v.string()),
  /** IBGE code of the provider's municipality, 7 digits. */
  municipalityCode: v.string(),
  opSimpNac,
  regApTribSN: v.optional(regApTribSN),
  regEspTrib,
  /** DPS series, 1 to 5 digits, stored without leading zeros. Used by the Sefin Nacional. */
  dpsSeries: v.string(),
  /**
   * DPS series of the Campinas municipal webservice (`campinas-adn`), 10001 to 49999 (L0022:
   * 1 to 10000 belong to the municipal web issuer). Without it, that route uses `dpsSeries`
   * when it is in the range.
   */
  campinasDpsSeries: v.optional(v.string()),
  activities: v.array(nfseActivity),
};
export const nfseProfileInput = v.object(nfseProfileFields);
export type NfseProfileInput = Infer<typeof nfseProfileInput>;
export type NfseActivity = Infer<typeof nfseActivity>;

/** DPS numbering of a series and environment of the company. */
export const dpsSequenceView = v.object({
  environment,
  series: v.string(),
  /** First number the platform uses in the series; 1 unless configured. */
  start: v.number(),
  /** Number the next accepted request receives. */
  next: v.number(),
  /** A number was already reserved: the start can no longer change. */
  locked: v.boolean(),
  startSetAt: v.union(v.number(), v.null()),
});
export const nfseProfileView = v.object({
  ...nfseProfileFields,
  version: v.number(),
  updatedAt: v.number(),
});
