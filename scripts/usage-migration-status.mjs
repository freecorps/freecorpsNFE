#!/usr/bin/env node
// Recibo, só lendo, da migração de ambiente do consumo (#429), num deployment
// escolhido por nome. Imprime só contagens e unidades por métrica, ambiente e
// estado. Uso: docs/plataforma/USAGE.md, Migração.
//
//   node scripts/usage-migration-status.mjs --deployment <nome> [--out antes.json]
//   node scripts/usage-migration-status.mjs --deployment <nome> --compare antes.json
import { readFileSync, writeFileSync } from "node:fs";
import {
  collectStatus,
  compareReceipts,
  convexPage,
  localCheckout,
  parseArgs,
  readReceipt,
  receipt,
} from "./lib/usage-migration-status.mjs";
import { repoRoot } from "./lib/repo-root.mjs";

/** O conteúdo do recibo anterior; nem um erro de leitura repete o que o arquivo tem. */
function readCompare(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error("--compare: não foi possível ler o arquivo.");
  }
}

const root = repoRoot;

try {
  const options = parseArgs(process.argv.slice(2));
  const before = options.compare ? readReceipt(readCompare(options.compare)) : null;
  const startedAt = new Date().toISOString();
  const status = await collectStatus(convexPage(root, options.deployment), {
    pageSize: options.pageSize,
  });
  const result = receipt({
    deployment: options.deployment,
    localCheckout: localCheckout(root),
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
  });
  if (before) {
    if (before.deployment !== result.deployment)
      throw new Error("--compare recebeu o recibo de outro deployment.");
    result.comparison = compareReceipts(before, result);
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) writeFileSync(options.out, text, { flag: "wx" });
  process.stdout.write(text);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
