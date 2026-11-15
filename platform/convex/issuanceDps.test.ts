import { describe, expect, it, vi } from "vite-plus/test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  platformTest,
  softwareLicense,
  usePlatformEnvironment,
  type ProfileFields,
} from "../../tests/helpers/platform";
import type { IssuanceInput } from "./lib/issuanceValues";
// Same source module the platform resolves under test (vite.config.ts aliases the
// workspace packages to src), so the XSD catalog is registered once.
import { validateDpsXml } from "../../packages/fiscal-nfse/src/index";
import {
  PRODREST,
  fixture,
  type Fixture,
  domestic,
  exported,
  code,
  request,
  view,
  drive,
  xmlOf,
  campinasProfile,
  campinasTaker,
} from "../../tests/helpers/issuance";

/**
 * What the DPS carries: the IBSCBS group, a taker abroad, the provider's e-mail and first number.
 * Every company, CNPJ, CPF and taker is synthetic; nothing here reaches a tax authority, so
 * nothing here proves an authorization.
 */
const NOW = Date.UTC(2026, 9, 8, 15); // Thursday, 08/10/2026 12:00 in Brasília

usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-issuance",
  now: NOW,
});

/**
 * Group IBSCBS by regime, subitem and taxable event (Ato Conjunto RFB/CGIBS 4/2026, #338), on
 * any target. The classification codes are synthetic, the ones of the legacy homolog test.
 */
describe("grupo IBSCBS pelo Ato Conjunto 4/2026", () => {
  const IBS_CBS = { cIndOp: "100501", cst: "000", cClassTrib: "000001" };
  /** Subitem 17.01: alínea "d", from 01/10/2026 for the non-opting provider. */
  const consulting = {
    code: "consultoria",
    label: "Consultoria empresarial",
    cnae: "7020400",
    lc116Item: "17.01",
    cTribNac: "170101",
    nbs: "115011000",
  };
  const classified = (overrides: ProfileFields = {}): ProfileFields => ({
    activities: [
      { ...softwareLicense, ibsCbs: IBS_CBS },
      { ...consulting, ibsCbs: IBS_CBS },
    ],
    ...overrides,
  });
  const GROUP =
    /<IBSCBS><finNFSe>0<\/finNFSe><cIndOp>100501<\/cIndOp><indDest>0<\/indDest><valores><trib><gIBSCBS><CST>000<\/CST><cClassTrib>000001<\/cClassTrib><\/gIBSCBS><\/trib><\/valores><\/IBSCBS><\/infDPS>/;
  /** The Sefin (tpAmb 2) gets the NT 009 shape: finNFSe left for infDPS, CST and cClassTrib in trib. */
  const SEFIN_GROUP =
    /<IBSCBS><cIndOp>100501<\/cIndOp><indDest>0<\/indDest><valores><trib><CST>000<\/CST><cClassTrib>000001<\/cClassTrib><\/trib><\/valores><\/IBSCBS><\/infDPS>/;
  type Frozen = { ibsCbsGroup?: { required: boolean; ruleId: string }; dCompet: string };
  const frozenOf = (f: Fixture, id: string) =>
    f.t.run(async (ctx) => {
      const row = await ctx.db.get("issuances", id as Id<"issuances">);
      return JSON.parse(row!.snapshot) as Frozen;
    });
  /** Accepts, runs on the simulator and returns the DPS (checked against the XSD) and decision. */
  async function issued(f: Fixture, key: string, input: IssuanceInput) {
    const accepted = await request(f, key, input);
    await drive(f.t, accepted.issuance.operationId);
    const done = await view(f, accepted.issuance.id);
    expect(done.state).toBe("authorized");
    const [dps] = await xmlOf(f.t, done.id, "dps");
    expect(validateDpsXml(dps!, done.target === "campinas-adn" ? undefined : PRODREST)).toEqual({
      valid: true,
    });
    return {
      target: done.target,
      dps: dps!,
      group: (await frozenOf(f, done.id)).ibsCbsGroup,
    };
  }
  const sequences = (f: Fixture) => f.t.run((ctx) => ctx.db.query("dpsSequences").collect());

  it('não optante na Sefin, alínea "d": o grupo segue o fato gerador (dCompet) desde 01/10/2026', async () => {
    const f = await fixture(platformTest(), { profile: classified() });
    // Issued on 01/10 for September: the taxable event is before the obligation.
    const september = await issued(
      f,
      "setembro",
      domestic({ activityCode: "consultoria", competence: "2026-09", issueDate: "2026-10-01" }),
    );
    expect(september.target).toBe("sefin-nacional");
    expect(september.dps).toContain("<dCompet>2026-09-30</dCompet>");
    expect(september.dps).not.toContain("<IBSCBS>");
    expect(september.group).toEqual({ required: false, ruleId: "ato4-iii-d" });
    const october = await issued(
      f,
      "outubro",
      domestic({ activityCode: "consultoria", competence: "2026-10", issueDate: "2026-10-01" }),
    );
    expect(october.dps).toContain("<dCompet>2026-10-01</dCompet>");
    expect(october.dps).toMatch(SEFIN_GROUP);
    expect(october.group).toEqual({ required: true, ruleId: "ato4-iii-d" });
    // Only the group: what is of the Campinas channel stays out of the Sefin.
    for (const piece of ["<cTribMun>", "<IM>", "<dest>"]) expect(october.dps).not.toContain(piece);
  });

  it('não optante na Sefin, alínea "b": o 1.05 leva o grupo só desde 01/12/2026', async () => {
    vi.setSystemTime(Date.UTC(2026, 11, 1, 15)); // 01/12/2026 12:00 in Brasília
    const f = await fixture(platformTest(), { profile: classified() });
    const before = await issued(f, "outubro", domestic({ issueDate: "2026-10-08" }));
    expect(before.dps).toContain("<dCompet>2026-10-08</dCompet>");
    expect(before.dps).not.toContain("<IBSCBS>");
    expect(before.group).toEqual({ required: false, ruleId: "ato4-iii-b" });
    const november = await issued(
      f,
      "novembro",
      domestic({ competence: "2026-11", issueDate: "2026-12-01" }),
    );
    expect(november.dps).toContain("<dCompet>2026-11-30</dCompet>");
    expect(november.dps).not.toContain("<IBSCBS>");
    const december = await issued(f, "dezembro", domestic({ competence: "2026-12" }));
    expect(december.dps).toContain("<dCompet>2026-12-01</dCompet>");
    expect(december.dps).toMatch(SEFIN_GROUP);
    expect(december.group).toEqual({ required: true, ruleId: "ato4-iii-b" });
  });

  it("recusa sem a classificação IBS/CBS só quando o grupo é obrigatório, antes de reservar número", async () => {
    const f = await fixture(platformTest(), {
      profile: { activities: [softwareLicense, consulting] },
    });
    await expect(
      request(f, "a", domestic({ activityCode: "consultoria", issueDate: "2026-10-01" })),
    ).rejects.toMatchObject({
      data: {
        code: "NFSE_ROUTE_PROFILE_INCOMPLETE",
        missing: ["ibsCbs"],
        message: expect.stringMatching(
          /fato gerador desde 01\/10\/2026.*classificação IBS\/CBS da atividade/,
        ),
      },
    });
    expect(await sequences(f)).toEqual([]);
    // Before the obligation, the same profile still issues, without the group.
    const september = domestic({
      activityCode: "consultoria",
      competence: "2026-09",
      issueDate: "2026-10-01",
    });
    expect((await request(f, "b", september)).issuance.target).toBe("sefin-nacional");
    expect((await request(f, "c", domestic())).issuance.target).toBe("sefin-nacional");
  });

  it("exportação com o grupo obrigatório é recusada com código próprio, sem reservar número", async () => {
    const refused = { data: { code: "ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED" } };
    const sefin = await fixture(platformTest(), { profile: classified() });
    await expect(
      request(sefin, "a", exported({ activityCode: "consultoria" })),
    ).rejects.toMatchObject(refused);
    // The Campinas channel of the non-opting provider too: its domestic classification would go.
    const campinas = await fixture(platformTest(), {
      profile: campinasProfile({
        activities: [{ ...consulting, cTribMun: "001", ibsCbs: IBS_CBS }],
      }),
    });
    await expect(
      request(campinas, "a", exported({ activityCode: "consultoria" })),
    ).rejects.toMatchObject(refused);
    // Without the classification the answer is the same: no profile change would make it issue.
    const bare = await fixture(platformTest(), {
      profile: { activities: [softwareLicense, consulting] },
    });
    await expect(
      request(bare, "a", exported({ activityCode: "consultoria" })),
    ).rejects.toMatchObject(refused);
    for (const f of [sefin, campinas, bare]) expect(await sequences(f)).toEqual([]);
    // Subitem 1.05 before 01/12: the export still goes, without the group.
    const licence = await issued(sefin, "b", exported());
    expect(licence.dps).not.toContain("<IBSCBS>");
    vi.setSystemTime(Date.UTC(2026, 11, 2, 15));
    const december = await fixture(platformTest(), { profile: classified() });
    await expect(
      request(december, "a", exported({ issueDate: "2026-12-01", competence: "2026-12" })),
    ).rejects.toMatchObject(refused);
  });

  it("Simples de Campinas exporta pela Sefin em 28/11/2026, sem o grupo; o Ato o alcança em 2027", async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 28, 15)); // Saturday 28/11/2026 12:00 in Brasília
    const f = await fixture(platformTest(), {
      profile: campinasProfile({ opSimpNac: 3, regApTribSN: 1 }),
    });
    const exportation = await issued(
      f,
      "exportacao",
      exported({ issueDate: "2026-11-28", competence: "2026-11" }),
    );
    expect(exportation.target).toBe("sefin-nacional");
    expect(exportation.dps).toContain("<tribISSQN>3</tribISSQN>");
    for (const piece of ["<IBSCBS>", "<cTribMun>", "<IM>"])
      expect(exportation.dps).not.toContain(piece);
    expect(exportation.group).toEqual({ required: false, ruleId: "ato4-simples" });
    // MEI is Simples too: the same answer for the last day of 2026.
    vi.setSystemTime(Date.UTC(2026, 11, 31, 15));
    const mei = await fixture(platformTest(), { profile: { opSimpNac: 2 } });
    const last = await issued(
      mei,
      "mei",
      exported({ issueDate: "2026-12-31", competence: "2026-12" }),
    );
    expect(last.group).toEqual({ required: false, ruleId: "ato4-simples" });
    // From 01/01/2027 the Simples has the group required (§ 1º): no export, and the profile
    // needs the classification for a domestic invoice.
    vi.setSystemTime(Date.UTC(2027, 0, 4, 15));
    const mei2027 = await fixture(platformTest(), { profile: { opSimpNac: 2 } });
    await expect(
      request(mei2027, "a", exported({ issueDate: "2027-01-04", competence: "2027-01" })),
    ).rejects.toMatchObject({ data: { code: "ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED" } });
    await expect(
      request(mei2027, "b", domestic({ competence: "2027-01", issRate: undefined })),
    ).rejects.toMatchObject({
      data: { code: "NFSE_ROUTE_PROFILE_INCOMPLETE", missing: ["ibsCbs"] },
    });
    const simples2027 = await fixture(platformTest(), {
      profile: campinasProfile({ opSimpNac: 3, regApTribSN: 1 }),
    });
    const domestic2027 = await issued(
      simples2027,
      "nacional-2027",
      domestic({ competence: "2027-01", issRate: undefined }),
    );
    expect(domestic2027.dps).toMatch(SEFIN_GROUP);
    expect(domestic2027.group).toEqual({ required: true, ruleId: "ato4-simples" });
  });

  it("no canal de Campinas o grupo vai antes do Ato, pelo validador da IMA, e a decisão é congelada", async () => {
    const f = await fixture(platformTest(), {
      profile: campinasProfile({
        activities: [
          { ...softwareLicense, cTribMun: "001", ibsCbs: IBS_CBS },
          { ...consulting, cTribMun: "001", ibsCbs: IBS_CBS },
        ],
      }),
    });
    const licence = await issued(f, "a", domestic({ taker: campinasTaker, issRate: "2" }));
    expect(licence.target).toBe("campinas-adn");
    expect(licence.dps).toMatch(GROUP);
    expect(licence.group).toEqual({ required: true, ruleId: "campinas-ima" });
    const consultancy = await issued(
      f,
      "b",
      domestic({ activityCode: "consultoria", taker: campinasTaker, issRate: "2" }),
    );
    expect(consultancy.group).toEqual({ required: true, ruleId: "ato4-iii-d" });
    // The Simples in October (C5) exports through the IMA as before: the group goes with the
    // activity's classification, the case of the E0187 of 09/10 (ISSUANCE.md, #336).
    const simples = await fixture(platformTest(), {
      profile: campinasProfile({ opSimpNac: 3, regApTribSN: 1 }),
    });
    const exportation = await issued(simples, "c", exported());
    expect(exportation.target).toBe("campinas-adn");
    expect(exportation.dps).toMatch(GROUP);
    expect(exportation.group).toEqual({ required: true, ruleId: "campinas-ima" });
  });

  it("snapshot congelado sem a decisão (antes da #338) monta a DPS como na época", async () => {
    const forget = (f: Fixture, id: string) =>
      f.t.run(async (ctx) => {
        const row = (await ctx.db.get("issuances", id as Id<"issuances">))!;
        const { ibsCbsGroup: _decision, ...old } = JSON.parse(row.snapshot) as Frozen;
        await ctx.db.patch("issuances", row._id, { snapshot: JSON.stringify(old) });
      });
    // Sefin: the old rule had no group, even where the Ato now requires it.
    const sefin = await fixture(platformTest(), { profile: classified() });
    const october = await request(sefin, "a", domestic({ activityCode: "consultoria" }));
    expect((await frozenOf(sefin, october.issuance.id)).ibsCbsGroup?.required).toBe(true);
    await forget(sefin, october.issuance.id);
    await drive(sefin.t, october.issuance.operationId);
    const [old] = await xmlOf(sefin.t, october.issuance.id as Id<"issuances">, "dps");
    expect(old).not.toContain("<IBSCBS>");
    expect(validateDpsXml(old!, PRODREST)).toEqual({ valid: true });
    // Campinas: the old rule already sent it.
    const campinas = await fixture(platformTest(), { profile: campinasProfile() });
    const ima = await request(campinas, "a", domestic({ taker: campinasTaker, issRate: "2" }));
    await forget(campinas, ima.issuance.id);
    await drive(campinas.t, ima.issuance.operationId);
    const [kept] = await xmlOf(campinas.t, ima.issuance.id as Id<"issuances">, "dps");
    expect(kept).toMatch(GROUP);
  });
});

describe("endereço do tomador no exterior", () => {
  const foreignTaker = () =>
    exported().taker as Extract<IssuanceInput["taker"], { kind: "foreign" }>;
  it("exige código postal, estado, logradouro, número e bairro, com o campo do erro", async () => {
    const f = await fixture();
    for (const field of ["postalCode", "state", "street", "number", "district"] as const) {
      for (const value of [undefined, "", "   "]) {
        const taker = foreignTaker();
        const address = { ...taker.address, [field]: value };
        await expect(
          request(f, crypto.randomUUID(), exported({ taker: { ...taker, address } })),
        ).rejects.toMatchObject({
          data: { code: "ISSUANCE_FIELD_INVALID", field: `taker.address.${field}` },
        });
      }
    }
    expect(await f.t.run((ctx) => ctx.db.query("issuances").collect())).toEqual([]);
  });

  it("aplica os tamanhos do XSD e aceita N/A no bairro", async () => {
    const f = await fixture();
    const limits = { postalCode: 11, city: 60, state: 60, street: 255, number: 60, district: 60 };
    for (const [field, max] of Object.entries(limits)) {
      const taker = foreignTaker();
      const long = { ...taker, address: { ...taker.address, [field]: "a".repeat(max + 1) } };
      await expect(
        request(f, crypto.randomUUID(), exported({ taker: long })),
      ).rejects.toMatchObject({
        data: { code: "ISSUANCE_FIELD_INVALID", field: `taker.address.${field}` },
      });
    }
    const taker = foreignTaker();
    const na = { ...taker, address: { ...taker.address, district: "N/A" } };
    const accepted = await request(f, "na", exported({ taker: na }));
    await drive(f.t, accepted.issuance.operationId);
    expect((await view(f, accepted.issuance.id)).state).toBe("authorized");
  });
});

describe("e-mail do prestador e número inicial", () => {
  it("usa o e-mail do perfil quando o pedido não traz um, e o do pedido quando traz", async () => {
    const f = await fixture(platformTest(), {
      profile: { issuerEmail: "perfil@prestador.example" },
    });
    const { issuerEmail: _email, ...withoutEmail } = domestic();
    const fromProfile = await request(f, "sem-email", withoutEmail);
    const fromRequest = await request(f, "com-email", domestic());
    await drive(f.t, fromProfile.issuance.operationId);
    await drive(f.t, fromRequest.issuance.operationId);
    const [a] = await xmlOf(f.t, fromProfile.issuance.id as Id<"issuances">, "dps");
    const [b] = await xmlOf(f.t, fromRequest.issuance.id as Id<"issuances">, "dps");
    expect(a).toContain("<email>perfil@prestador.example</email>");
    expect(b).toContain("<email>fiscal@prestador.example</email>");
    const none = await fixture();
    expect(await code(request(none, "x", withoutEmail))).toBe("ISSUANCE_ISSUER_EMAIL_REQUIRED");
  });

  it("a primeira emissão usa o número inicial configurado e trava a configuração", async () => {
    const f = await fixture();
    const owner = f.owner;
    const target = { organizationId: f.where.organizationId, companyId: f.where.companyId };
    await owner.mutation(api.nfseProfiles.setDpsStart, {
      ...target,
      environment: "sandbox",
      series: "1",
      start: 1201,
    });
    const first = await request(f, "inicio-1", domestic());
    const second = await request(f, "inicio-2", domestic());
    expect([first.issuance.number, second.issuance.number]).toEqual([1201, 1202]);
    expect(first.issuance.dpsId.endsWith("1201".padStart(15, "0"))).toBe(true);
    expect(
      await code(
        owner.mutation(api.nfseProfiles.setDpsStart, {
          ...target,
          environment: "sandbox",
          series: "1",
          start: 1,
        }),
      ),
    ).toBe("DPS_START_LOCKED");
  });
});
