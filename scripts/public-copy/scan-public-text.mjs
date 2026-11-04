// Varre, antes de publicar, o texto que vai para o GitHub sem passar por
// arquivo versionado: título e corpo de issue, PR e comentário, e mensagem de
// commit. O hook pre-push e o Public scan só leem arquivos versionados
// (docs/desenvolvimento/ci.md, Hook pre-push), então este é o único filtro
// automático desse texto.
//
//   node scripts/public-copy/scan-public-text.mjs <arquivo>...
//
// Aplica as regras de credenciais de scripts/public-copy/check-secrets.mjs e os
// identificadores de scripts/public-copy/public-tree.mjs: CNPJ, CPF e chave de acesso
// reais, e-mail externo ou pessoal, caminho local e deployment Convex
// desconhecido. Os nomes restritos e o Gitleaks ficam de fora; quem escreve
// ainda relê o texto. Mostra arquivo, linha e tipo de cada achado, nunca o
// valor. Sai com 1 quando há achado que bloqueia ou pede decisão, 2 em erro de
// uso ou leitura.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanFile } from "./check-secrets.mjs";
import { findingKinds, scanText } from "./public-tree.mjs";

const stops = new Set(["bloqueia", "decisão"]);

/** Achados que impedem publicar o texto: `{ path, line, kind, rule? }`, sem o valor. */
export function scanPublicText(path, text) {
  const secrets = scanFile(path, Buffer.from(text, "utf8")).map(({ line, rule }) => ({
    path,
    line,
    kind: "segredo",
    rule,
  }));
  return [...secrets, ...scanText(path, text)].filter((f) => stops.has(findingKinds[f.kind]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("uso: node scripts/public-copy/scan-public-text.mjs <arquivo>...");
    process.exit(2);
  }
  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      console.error(`${file}: não foi possível ler (${error.code ?? error.message})`);
      process.exit(2);
    }
    findings.push(...scanPublicText(file, text));
  }
  for (const { path, line, kind, rule } of findings)
    console.error(`${path}:${line}  ${kind}${rule ? ` (${rule})` : ""}  (valor omitido)`);
  if (findings.length) {
    console.error(`texto público: ${findings.length} achado(s); corrija antes de publicar`);
    process.exit(1);
  }
  console.log(`texto público: ok, ${files.length} arquivo(s)`);
}
