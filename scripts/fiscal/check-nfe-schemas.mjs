#!/usr/bin/env node
/**
 * Confere se o Portal Nacional da NF-e publicou, trocou ou retirou algum pacote de esquemas
 * desde o levantamento em packages/fiscal-nfe/schemas/portal-survey.json. Só lê o portal;
 * não grava nada. Com --hashes, baixa também os pacotes fixados no manifesto e compara o
 * SHA-256. Com --page <arquivo>, usa um HTML salvo em vez da rede (e ignora --hashes).
 *
 * Saída 0: nada mudou. Saída 1: há diferença; revise e registre a decisão
 * (docs/plataforma/NFE-SCHEMAS.md). Saída 2: a lista não pôde ser lida.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { compareSurvey, describeFinding, parseOfficialList } from "../lib/nfe-portal.mjs";
import { repoUrl } from "../lib/repo-root.mjs";

const root = new URL("packages/fiscal-nfe/schemas/", repoUrl);
const survey = JSON.parse(readFileSync(new URL("portal-survey.json", root), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
const args = process.argv.slice(2);
const page = args.includes("--page") ? args[args.indexOf("--page") + 1] : null;

// O portal redireciona para gravar um cookie de sessão e só então entrega a página ou o
// arquivo, como o CookieJar de scripts/sync-nfe-schemas.py. O fetch do Node não guarda
// cookies, então os redirecionamentos são seguidos aqui, só dentro do mesmo host.
const cookies = new Map();
async function download(url) {
  let target = new URL(url);
  for (let hop = 0; hop < 10; hop++) {
    const response = await fetch(target, {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (freecorpsNFE schema check)",
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      },
      signal: AbortSignal.timeout(60_000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const at = pair.indexOf("=");
      cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    if (response.status >= 300 && response.status < 400) {
      const next = new URL(response.headers.get("location") ?? "", target);
      if (next.host !== target.host) throw new Error(`redirecionamento para ${next.host}`);
      target = next;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} em ${target}`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error(`redirecionamentos demais em ${url}`);
}

let entries;
try {
  const html = page ? readFileSync(page) : await download(survey.source);
  entries = parseOfficialList(html.toString("utf8"));
} catch (error) {
  console.error(`Não foi possível ler a lista do portal: ${error.message}`);
  process.exit(2);
}
const findings = compareSurvey(entries, survey, manifest);
if (args.includes("--hashes") && !page)
  for (const source of manifest.sources) {
    const actual = createHash("sha256")
      .update(await download(source.source))
      .digest("hex");
    if (actual !== source.archiveSha256)
      findings.push({
        kind: "hash-changed",
        package: source.id,
        actual,
        expected: source.archiveSha256,
      });
  }
console.log(
  `Portal: ${entries.length} pacotes oficiais; levantamento de ${survey.surveyedAt}` +
    ` com ${survey.entries.length}; ${manifest.sources.length} pacotes fixados.`,
);
for (const finding of findings) console.log("- " + describeFinding(finding));
console.log(findings.length ? `${findings.length} diferença(s).` : "Nada mudou.");
process.exit(findings.length ? 1 : 0);
