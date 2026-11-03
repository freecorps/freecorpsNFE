#!/usr/bin/env node
// Lock rules of the cold tier's bucket (ADR 0010, decision 6; docs/operacao/camada-fria.md).
//
//   CLOUDFLARE_API_TOKEN=<token R2 admin> node scripts/cold-tier-locks.mjs --through 2033
//
// Adds or extends one Date rule per guard year, from the current year to `--through`, in the
// bucket of `coldTier.bucket` (deploy/offsite-backup.json). Never shortens nor removes a rule.
// Prints the year to set in `FNFE_COLD_LOCKED_THROUGH` once the rules are read back in force.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { backupPlan } from "./lib/offsite-backup.mjs";
import { releaseTarget } from "./lib/platform-release.mjs";
import { cloudflareLocks, yearRules } from "./lib/cold-tier-locks.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const args = process.argv.slice(2);
const through = Number(args[args.indexOf("--through") + 1]);
if (!args.includes("--through") || !Number.isSafeInteger(through)) {
  console.error("Use: node scripts/cold-tier-locks.mjs --through <ano>");
  process.exit(2);
}
const plan = backupPlan(
  readJson("deploy/offsite-backup.json"),
  releaseTarget(readJson("deploy/platform-release.json")),
);
if (!plan.coldTier?.bucket) {
  console.error("Configure coldTier.bucket em deploy/offsite-backup.json");
  process.exit(2);
}
const locks = cloudflareLocks({
  accountId: plan.accountId,
  bucket: plan.coldTier.bucket,
  token: process.env.CLOUDFLARE_API_TOKEN,
});
const result = await locks.ensure(yearRules(new Date().getUTCFullYear(), through));
console.log(
  JSON.stringify({ bucket: plan.coldTier.bucket, ...result, FNFE_COLD_LOCKED_THROUGH: through }),
);
