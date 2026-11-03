import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { compareSurvey, describeFinding, parseOfficialList } from "./lib/nfe-portal.mjs";

const schemas = new URL("../packages/fiscal-nfe/schemas/", import.meta.url);
const survey = JSON.parse(readFileSync(new URL("portal-survey.json", schemas), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("manifest.json", schemas), "utf8"));

// Same markup as the portal page, with made-up entries.
const link = (code: string, title: string) =>
  `<p><a target="_blank" href="exibirArquivo.aspx?conteudo=${code}"><span class="tituloConteudo">${title}</span></a><br /></p>`;
const page = (official: string[]) =>
  `<div class="indentacaoConteudo"><p class="tituloSessao">VERSÕES OFICIAIS (em uso)</p><div class="indentacaoNormal">${official.join("")}</div><p class="tituloSessao">VERSÕES PARA TESTES (Homologação)</p><div>${link("TESTE111111=", "Pacote de teste")}</div></div>`;

describe("portal schema list", () => {
  it("reads only the official section and restores the + the portal prints as a space", () => {
    expect(
      parseOfficialList(page([link("ab cd=", "Pacote A &amp; B"), link("x/y=", " Pacote\n C ")])),
    ).toEqual([
      { code: "ab+cd=", title: "Pacote A & B" },
      { code: "x/y=", title: "Pacote C" },
    ]);
    expect(() => parseOfficialList("<p>manutenção</p>")).toThrow("PORTAL_SECTION_NOT_FOUND");
  });

  it("reports new, renamed and withdrawn packages and pins outside the survey", () => {
    const surveyed = {
      entries: [
        { code: "A=", title: "Pacote A", package: "pkg-a" },
        { code: "B=", title: "Pacote B", package: null },
      ],
    };
    const pins = {
      sources: [
        { id: "pkg-a", source: "https://example.invalid/x.aspx?conteudo=A%3D" },
        { id: "pkg-c", source: "https://example.invalid/x.aspx?conteudo=C%3D" },
      ],
    };
    const unchanged = [
      { code: "A=", title: "Pacote A" },
      { code: "B=", title: "Pacote B" },
    ];
    expect(compareSurvey(unchanged, surveyed, { sources: pins.sources.slice(0, 1) })).toEqual([]);
    const findings = compareSurvey(
      [
        { code: "A=", title: "Pacote A v2" },
        { code: "N=", title: "Pacote novo" },
      ],
      surveyed,
      pins,
    );
    expect(findings).toEqual([
      { kind: "renamed", code: "A=", before: "Pacote A", title: "Pacote A v2" },
      { kind: "new", code: "N=", title: "Pacote novo" },
      { kind: "withdrawn", code: "B=", title: "Pacote B" },
      { kind: "unsurveyed-pin", code: "C=", package: "pkg-c" },
    ]);
    expect(findings.map(describeFinding)).toContain(
      "Pacote novo no portal: Pacote novo (conteudo=N=)",
    );
    expect(compareSurvey([{ code: "B=", title: "Pacote B" }], surveyed, pins)).toContainEqual({
      kind: "pin-withdrawn",
      code: "A=",
      package: "pkg-a",
    });
  });

  it("keeps every pinned package under a recorded decision", () => {
    const entries = survey.entries.map(({ code, title }: { code: string; title: string }) => ({
      code,
      title,
    }));
    expect(compareSurvey(entries, survey, manifest)).toEqual([]);
    for (const entry of survey.entries)
      expect(["fixado", "trazer", "incorporado", "adiar", "excluir"]).toContain(entry.decision);
    const pinned = new Set(manifest.sources.map((source: { id: string }) => source.id));
    for (const entry of survey.entries)
      expect(entry.package === null || pinned.has(entry.package)).toBe(true);
  });
});
