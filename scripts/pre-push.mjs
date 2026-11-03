// Hook pre-push (.vite-hooks/pre-push): varre cada commit enviado com as regras
// do Public scan (scripts/public-tree.mjs --checkout) antes que ele fique
// público. O workflow Public scan roda depois do push, quando a branch já está
// exposta; este hook é a barreira de antes.
//
// Git passa no stdin uma linha por ref: `<ref local> <sha local> <ref remota>
// <sha remoto>`. Cada sha local, exceto o de uma remoção, é varrido uma vez. Sem
// o Gitleaks fixado (GITLEAKS_BIN ou gitleaks no PATH), a varredura segue sem
// ele e avisa; os nomes restritos não são conferidos, porque a lista fica em
// custódia. O CI repete as duas conferências.
//
// Sai com 1 se um commit tem achado bloqueante ou se a varredura não termina.
// Mostra caminho, linha e tipo de cada achado, nunca o valor.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findingKinds, GITLEAKS_VERSION } from "./public-tree.mjs";

const ZERO = /^0+$/;

/** Os commits enviados, sem repetição e sem as remoções de ref. */
export function pushedCommits(input) {
  const shas = [];
  for (const line of input.split(/\r?\n/)) {
    const [, local] = line.trim().split(/\s+/);
    if (local && !ZERO.test(local) && !shas.includes(local)) shas.push(local);
  }
  return shas;
}

/** Argumentos do public-tree para um commit. */
export function scanArgs(sha, out, withGitleaks) {
  return ["--checkout", "--sha", sha, "--out", out, ...(withGitleaks ? [] : ["--sem-gitleaks"])];
}

/** Os achados que bloqueiam, como linhas sem o valor encontrado. */
export function blockingLines(report) {
  const lines = [];
  for (const f of report.findings?.items ?? [])
    if (["bloqueia", "decisão"].includes(findingKinds[f.kind]))
      lines.push(`  ${f.path}:${f.line} ${f.kind}${f.rule ? ` (${f.rule})` : ""}`);
  for (const p of report.findings?.staleAllowlist ?? [])
    lines.push(`  exceção obsoleta: ${p.path} ${p.kind}${p.rule ? ` ${p.rule}` : ""}`);
  for (const p of report.unclassified ?? []) lines.push(`  sem classificação: ${p}`);
  return lines;
}

function gitleaksPinned() {
  const bin = process.env.GITLEAKS_BIN ?? "gitleaks";
  const run = spawnSync(bin, ["version"], { encoding: "utf8", windowsHide: true });
  return run.status === 0 && run.stdout.trim().replace(/^v/, "") === GITLEAKS_VERSION;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const shas = pushedCommits(readFileSync(0, "utf8"));
  const withGitleaks = gitleaksPinned();
  let failed = false;
  for (const sha of shas) {
    const out = join(mkdtempSync(join(tmpdir(), "fnfe-pre-push-")), "saida");
    const run = spawnSync(
      process.execPath,
      [join(root, "scripts/public-tree.mjs"), ...scanArgs(sha, out, withGitleaks)],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );
    const short = sha.slice(0, 7);
    if (run.status === 0) {
      rmSync(resolve(out, ".."), { recursive: true, force: true });
      console.log(`pre-push: ${short} sem achados que bloqueiam`);
      continue;
    }
    failed = true;
    if (run.status === 1) {
      const report = JSON.parse(readFileSync(join(out, "varredura.json"), "utf8"));
      console.error(`pre-push: ${short} bloqueado pela varredura pública`);
      for (const line of blockingLines(report)) console.error(line);
      // A cópia montada traz o próprio dado; fica só o relatório, que não o traz.
      rmSync(join(out, "arvore"), { recursive: true, force: true });
      rmSync(join(out, "manifest.json"), { force: true });
      console.error(`pre-push: relatório em ${join(out, "varredura.json")}`);
    } else {
      process.stderr.write(run.stdout ?? "");
      process.stderr.write(run.stderr ?? "");
      console.error(`pre-push: a varredura de ${short} não terminou (saída ${run.status})`);
    }
  }
  if (shas.length && !withGitleaks)
    console.log(
      `pre-push: sem o Gitleaks ${GITLEAKS_VERSION} (GITLEAKS_BIN ou PATH); o Public scan do CI o roda`,
    );
  if (failed) {
    console.error(
      "pre-push: push recusado. Tire o dado dos commits ainda não enviados e envie de novo; veja AGENTS.md, Credenciais e dados reais.",
    );
    process.exit(1);
  }
}
