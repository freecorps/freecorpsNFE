import type { DpsInput, DpsToma } from "@freecorps/fiscal-nfse";
import { BACEN_CURRENCY, COM_EXT_DEFAULTS } from "@freecorps/fiscal-nfse/pure";
import type { IssuanceSnapshot } from "./issuanceCore";
import { VER_APLIC } from "./issuanceValues";

/** Snapshots frozen before #338 have no `ibsCbsGroup`; the DPS of those keeps the old rule. */
export type FrozenSnapshot = Omit<IssuanceSnapshot, "ibsCbsGroup"> &
  Partial<Pick<IssuanceSnapshot, "ibsCbsGroup">> & {
    series: string;
    number: number;
    dpsId: string;
  };

/**
 * Maps the frozen snapshot (plus the frozen PTAX, for foreign currency) to the DPS input of the
 * core package. Pure: the same snapshot gives the same DPS, byte for byte.
 */
export function dpsInputOf(snapshot: FrozenSnapshot, brlAmount: string | null): DpsInput {
  const t = snapshot.taker;
  const toma: DpsToma =
    t.kind === "national"
      ? {
          tipo: t.documentType,
          cpfCnpj: t.document,
          xNome: t.name,
          cMun: t.address.municipalityCode,
          cep: t.address.postalCode,
          xLgr: t.address.street,
          nro: t.address.number,
          xBairro: t.address.district,
          ...(t.email ? { email: t.email } : {}),
        }
      : {
          tipo: t.nif ? "NIF" : "semNIF",
          ...(t.nif ? { nif: t.nif } : { cNaoNIF: t.nifAbsence }),
          xNome: t.name,
          cPais: t.address.country,
          // Required since the XSD proof; a snapshot frozen before that may lack them, and
          // the core package then refuses the DPS locally (DPS_FIELD_INVALID), unsent.
          cEndPost: t.address.postalCode,
          xCidade: t.address.city,
          xEstProvReg: t.address.state,
          xLgr: t.address.street,
          nro: t.address.number,
          xBairro: t.address.district,
          ...(t.email ? { email: t.email } : {}),
        };
  const exported = snapshot.market === "export";
  const vServ = snapshot.serviceBrl ?? brlAmount;
  if (!vServ) throw new Error("ISSUANCE_EXCHANGE_MISSING");
  const tpMoeda = BACEN_CURRENCY[snapshot.amount.currency];
  if (exported && !tpMoeda) throw new Error("ISSUANCE_CURRENCY_UNSUPPORTED");
  const municipality = snapshot.profile.municipalityCode;
  // Campinas (IMA) validates the national XSD 1.01: `cTribMun` follows `cTribNac`. The Sefin
  // Nacional never gets `cTribMun`. The legacy engine also sent `dest` after the taker and
  // `cLocIncid`, which its old homologation tolerated; neither fits the XSD.
  const campinas = snapshot.target === "campinas-adn";
  // `IBSCBS` closes `infDPS` when the decision frozen at acceptance says so (`ibsCbsGroup`: the
  // Ato Conjunto RFB/CGIBS 4/2026 on any target, or the Campinas validator), with `indDest` 0
  // (the taker is the recipient), so no `dest` group (E0910). A snapshot frozen without the
  // decision keeps the rule of its time, the group only on the Campinas channel: a DPS not yet
  // built after a retry comes out as it would have then.
  const group = snapshot.ibsCbsGroup ? snapshot.ibsCbsGroup.required : campinas;
  const ibsCbs = group ? snapshot.activity.ibsCbs : undefined;
  if (campinas && (!snapshot.activity.cTribMun || !ibsCbs))
    throw new Error("ISSUANCE_CAMPINAS_PROFILE_MISSING");
  // Acceptance refuses a required group without the activity's classification; never send less.
  if (group && !ibsCbs) throw new Error("ISSUANCE_IBSCBS_PROFILE_MISSING");
  // E0120 forbids `<IM>` when the issuer has no complementary record in the issuing
  // municipality's CNC, and E0116 requires it when there is one. Sefin Nacional never gets it:
  // that assumes no CNC record, an unverified premise (E0116 at the Sefin would refute it,
  // and E0084 may as well, since it matches cLocEmi + CNPJ + IM). The IMA is Campinas' own
  // business registry, where the issuer has an IM; the L0006 rejection of 09/10/2026 suggests it
  // needs the IM to find the municipal tax rule (a hypothesis until a homologation proves it).
  // Snapshots frozen without the field keep omitting it.
  const im = campinas ? snapshot.profile.municipalRegistration : undefined;
  // The Sefin's produção restrita runs the NT 009 layout since 2026-10-20 and refused the
  // production one with E1235 on 2026-11-02 (#197). Production and the IMA keep the
  // v1.01-20260209 layout until the Portal NFS-e publishes otherwise for them.
  const layout =
    !campinas && snapshot.tpAmb === 2 ? ("nfse-1.01-prodrest-20261020" as const) : undefined;
  return {
    ...(layout ? { layout } : {}),
    tpAmb: snapshot.tpAmb,
    dhEmi: snapshot.dhEmi,
    verAplic: VER_APLIC,
    serie: Number(snapshot.series),
    nDPS: snapshot.number,
    dCompet: snapshot.dCompet,
    cLocEmi: municipality,
    prest: {
      cnpj: snapshot.issuer.cnpj,
      ...(im ? { im } : {}),
      email: snapshot.issuer.email,
      opSimpNac: snapshot.profile.opSimpNac,
      ...(snapshot.profile.regApTribSN !== undefined
        ? { regApTribSN: snapshot.profile.regApTribSN }
        : {}),
      regEspTrib: snapshot.profile.regEspTrib,
    },
    toma,
    serv: {
      cLocPrestacao: municipality,
      cTribNac: snapshot.activity.cTribNac,
      ...(campinas ? { cTribMun: snapshot.activity.cTribMun } : {}),
      xDescServ: snapshot.description,
      ...(snapshot.activity.nbs ? { cNBS: snapshot.activity.nbs } : {}),
      ...(exported
        ? {
            comExt: {
              ...COM_EXT_DEFAULTS,
              tpMoeda: tpMoeda!,
              vServMoeda: snapshot.amount.value,
            },
          }
        : {}),
    },
    valores: {
      vServ,
      tribISSQN: exported ? 3 : 1,
      ...(exported && t.kind === "foreign" ? { cPaisResult: t.address.country } : {}),
      tpRetISSQN: snapshot.iss.withheld ? 2 : 1,
      ...(snapshot.iss.rate !== undefined ? { pAliq: snapshot.iss.rate } : {}),
      vTotTribFed: "0.00",
      vTotTribEst: "0.00",
      vTotTribMun: snapshot.iss.amount ?? "0.00",
    },
    ...(ibsCbs
      ? {
          ibsCbs: {
            finNFSe: 0,
            cIndOp: ibsCbs.cIndOp,
            indDest: 0 as const,
            cst: ibsCbs.cst,
            cClassTrib: ibsCbs.cClassTrib,
          },
        }
      : {}),
  };
}
