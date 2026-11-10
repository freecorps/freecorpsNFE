import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vite-plus/test";

/**
 * O status de uma ADR mora só no cabeçalho dela, em `docs/adr/` (#117). Cada
 * ADR traz, antes da primeira seção `##`, uma linha
 * `Data: DD/MM/AAAA · Status: **Valor**`, com `Data` opcional quando a data da
 * decisão não está registrada. Os outros documentos linkam a ADR sem repetir o
 * status: uma cópia diverge assim que a ADR muda de estado, e nada a corrige.
 * A busca cobre Markdown e MDX; comentários de código ficam com a revisão.
 */
export const adrStatuses = ["Proposta", "Aceita", "Substituída", "Recusada"] as const;

const statusLine = new RegExp(
  `^(?:Data: \\d{2}/\\d{2}/\\d{4} · )?Status: \\*\\*(?:${adrStatuses.join("|")})\\*\\*(?:[ .,:;]|$)`,
);

/** Problemas do cabeçalho de uma ADR; vazio quando o status segue o padrão. */
export function adrHeaderProblems(text: string) {
  const header = text.split(/^## /m, 1)[0]!.split("\n");
  // Só linhas que começam pelo campo: a prosa do cabeçalho pode citar "status".
  const mentions = header.filter((line) => /^(?:Data:.*)?Status\b/i.test(line));
  if (mentions.length === 0) return ["sem a linha Status"];
  if (mentions.length > 1) return ["mais de uma linha com Status no cabeçalho"];
  if (!statusLine.test(mentions[0]!))
    return [`status fora do padrão (${adrStatuses.join(", ")}): ${mentions[0]}`];
  return [];
}

// Uma referência a ADR: "ADR 0004", "ADRs 0004 e 0005", "[ADR 0012](adr/0012-...)"
// ou um link para docs/adr/ com outro texto. Depois dela, ligada por vírgula,
// dois-pontos, travessão, parêntese ou verbo de ligação, uma palavra de status.
// "(ADR 0009), implementada" não conta: a citação entre parênteses fecha antes,
// e o adjetivo é do assunto da frase, não da ADR. Um fato datado antes da
// referência ("o aceite da ADR 0007", em 26/10) também não: é histórico.
const reference = String.raw`(?:\bADRs?[ -]?\d{4}(?:(?:, | e )\d{4})*(?:\]\([^)\s]*\))?|\[[^\]]*\]\([^)\s]*adr/\d{4}[^)\s]*\))`;
const link = String.raw`\s*[,:;(—–]?\s*(?:(?:a ADR|o ADR|que|e|foi|foram|está|estão|é|são|segue|continua|ficou|ainda|já|não|em)\s+)*`;
const status = String.raw`(?:propost[oa]s?|aceit[oa]s?|aprovad[oa]s?|implementad[oa]s?|recusad[oa]s?|substituíd[oa]s?|provisóri[oa]s?|decidid[oa]s?|pendentes?|aguarda\p{L}*|vigentes?|vigor|status)(?!\p{L})`;
const statusPhrase = new RegExp(`${reference}${link}${status}`, "giu");

/** Frases que atribuem um status a uma ADR, num documento fora de `docs/adr/`. */
export function statusPhrases(text: string) {
  return [...text.matchAll(statusPhrase)].map(([phrase]) => phrase.replace(/\s+/g, " "));
}

/** Tudo que reprova em `root`: ADRs sem o cabeçalho e status repetidos fora delas. */
export function adrStatusProblems(root: string) {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "*.md", "*.mdx"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const problems: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // apagado no working tree e ainda no índice
    }
    if (/^docs\/adr\/\d{4}-[^/]+\.md$/.test(file))
      for (const problem of adrHeaderProblems(text)) problems.push(`${file}: ${problem}`);
    else if (!file.startsWith("docs/adr/"))
      for (const phrase of statusPhrases(text))
        problems.push(`${file}: status de ADR repetido ("${phrase}"); linke a ADR`);
  }
  return problems;
}

it("accepts the standard header and rejects a missing or free-form status", () => {
  expect(adrHeaderProblems("# T\n\nData: 08/10/2026 · Status: **Aceita** pelos sócios\n")).toEqual(
    [],
  );
  expect(adrHeaderProblems("# T\n\nStatus: **Substituída**: ver Situação.\n\n## A\n")).toEqual([]);
  // "Status" depois do cabeçalho não conta.
  expect(adrHeaderProblems("# T\n\nTexto.\n\n## Status\n\nStatus: **Aceita**\n")).toEqual([
    "sem a linha Status",
  ]);
  expect(adrHeaderProblems("# T\n\nData: 29/08/2026 · Status: **decidido**\n")).toHaveLength(1);
  expect(adrHeaderProblems("# T\n\nData: 31/10/2026. Status: aceita por decisão\n")).toHaveLength(
    1,
  );
  expect(adrHeaderProblems("# T\n\nStatus: **Aceitação**\n")).toHaveLength(1);
  // A prosa do cabeçalho pode falar de status sem virar uma segunda linha.
  expect(
    adrHeaderProblems("# T\n\nStatus: **Aceita**\n\nO status da captura muda.\n\n## A\n"),
  ).toEqual([]);
});

it("finds a status attached to an ADR and leaves plain citations alone", () => {
  expect(statusPhrases("[ADR 0008](../adr/0008-perda.md), proposta):")).toEqual([
    "[ADR 0008](../adr/0008-perda.md), proposta",
  ]);
  expect(statusPhrases("A [ADR 0007](../adr/0007-captura.md) foi aceita em 26/10.")).toHaveLength(
    1,
  );
  expect(statusPhrases("[ADR de criptografia](../adr/0003-cofre.md), aceita")).toHaveLength(1);
  expect(statusPhrases("[ADR 0012](adr/0012-x.md) e está implementada")).toHaveLength(1);
  for (const phrase of [
    "ADR 0006, aprovada em 12/10",
    "ADR 0006, pendente de aceite",
    "ADR 0006 aguarda o aceite",
    "ADR 0006, ainda em proposta",
    "ADR 0006 — proposta",
    "ADRs 0004 e 0005, aceitas",
    "ADR 0007 em vigor",
  ])
    expect(statusPhrases(phrase), phrase).toHaveLength(1);
  for (const citation of [
    "conforme a ADR 0011.",
    "(ADR 0004, §5)",
    "decidida em 28/10 (ADR 0009), implementada",
    "substituída em 31/10 pela ADR 0011",
    "| 04/11/2026 (ADR 0012) | hash | Substituída em 05/11/2026 |",
    "a ADR 0010, fase D2",
    "ADR 0012, seção 1, decidido nas fatias",
    "[ADR 0005](../adr/0005-console.md). A API aceita exportação",
    "o aceite da ADR 0007 e de",
  ])
    expect(statusPhrases(citation), citation).toEqual([]);
});

it("rejects, in a throwaway copy, the drifts listed in #115", () => {
  const root = mkdtempSync(join(tmpdir(), "adr-status-"));
  try {
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    write("docs/adr/0002-motor.md", "# Motor\n\n## Situação em 21/10/2026\n");
    write("docs/adr/0004-nfse.md", "# NFS-e\n\nData: 08/10/2026 · Status: **Aceita**\n");
    write(
      "docs/README.md",
      "| Período | [ADR 0012](adr/0012-periodo-por-aniversario.md), ainda não implementada |\n",
    );
    write(
      "packages/fiscal-nfse/README.md",
      "Campinas (3509502), conforme o ADR 0004 (proposto; provisório até o aceite):\n",
    );
    expect(adrStatusProblems(root)).toEqual([
      'docs/README.md: status de ADR repetido ("[ADR 0012](adr/0012-periodo-por-aniversario.md), ainda não implementada"); linke a ADR',
      "docs/adr/0002-motor.md: sem a linha Status",
      'packages/fiscal-nfse/README.md: status de ADR repetido ("ADR 0004 (proposto"); linke a ADR',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps every ADR status in its header and nowhere else", () => {
  const adrs = execFileSync("git", ["ls-files", "docs/adr"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  expect(adrs.length).toBeGreaterThanOrEqual(12);
  expect(adrStatusProblems(".")).toEqual([]);
});
