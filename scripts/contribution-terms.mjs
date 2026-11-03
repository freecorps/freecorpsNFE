// Check of the contribution terms on a pull request (.github/workflows/contribution-terms.yml).
// A PR by an owner, member or collaborator of the repository, or by a bot, passes. Any other
// author passes only with the acceptance sentence of CONTRIBUICOES.md in the PR body, which is
// the express acceptance that CONTRIBUTING.md requires before an external contribution enters.
// The inputs come by env (never interpolated in a shell); nothing from the PR is executed.
//   node scripts/contribution-terms.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Associations that already hold the repository's rights or write access. */
export const TRUSTED_ASSOCIATIONS = Object.freeze(["OWNER", "MEMBER", "COLLABORATOR"]);

const normalize = (text) =>
  text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * The acceptance sentence, read from the blockquote that follows "Para aceitação" in
 * CONTRIBUICOES.md, so the terms file stays the only source of the text.
 * @param {string} terms the content of CONTRIBUICOES.md
 */
export function acceptanceSentence(terms) {
  const start = terms.indexOf("Para aceitação");
  if (start < 0) throw new Error("CONTRIBUICOES.md sem a seção de aceitação");
  const lines = terms.slice(start).split("\n").slice(1);
  const quote = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) quote.push(line);
    else if (quote.length) break;
  }
  if (!quote.length) throw new Error("CONTRIBUICOES.md sem a frase de aceite");
  return normalize(quote.join("\n"));
}

/**
 * Whether the PR may merge as far as the terms go, and why.
 * @param {{ association?: string; authorType?: string; body?: string; sentence: string }} input
 */
export function termsDecision({ association, authorType, body, sentence }) {
  if (authorType === "Bot") return { ok: true, reason: "bot" };
  if (association && TRUSTED_ASSOCIATIONS.includes(association))
    return { ok: true, reason: `autor ${association.toLowerCase()} do repositório` };
  // The PR template carries the sentence inside an HTML comment, which does not render and is
  // not an acceptance: only the visible text counts.
  const visible = (body ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  if (normalize(visible).includes(sentence)) return { ok: true, reason: "aceite registrado na PR" };
  return { ok: false, reason: "falta o aceite dos Termos de contribuição Freecorps 1.0" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const terms = readFileSync(new URL("../CONTRIBUICOES.md", import.meta.url), "utf8");
  const decision = termsDecision({
    association: process.env.PR_AUTHOR_ASSOCIATION,
    authorType: process.env.PR_AUTHOR_TYPE,
    body: process.env.PR_BODY,
    sentence: acceptanceSentence(terms),
  });
  if (decision.ok) {
    console.log(`Termos de contribuição: ok (${decision.reason}).`);
  } else {
    console.log(
      "::error title=Termos de contribuição::Para integrar esta contribuição, o autor precisa aceitar os Termos de contribuição Freecorps 1.0: copie na descrição da PR a frase de aceite de CONTRIBUICOES.md e identifique os commits ou arquivos que são seus.",
    );
    process.exitCode = 1;
  }
}
