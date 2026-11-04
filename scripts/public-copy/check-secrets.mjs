// Scans every versioned text file for credential values, using the formats
// shared with the package check (scripts/lib/credentials.mjs). Findings print
// path, line and rule, never the value. Binary files (images included) are
// skipped: a secret inside a screenshot is not visible to this check
// (docs/desenvolvimento/ci.md, Segredos no repositório).
//   node scripts/public-copy/check-secrets.mjs
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryCredentialRules } from "../lib/credentials.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

/**
 * Known non-secret matches, one entry per file and rule, each with the exact
 * number of occurrences it covers and its reason. One more occurrence of the
 * same rule in that file blocks every occurrence of the group, so a real
 * credential cannot hide behind an exception; one fewer fails as a stale
 * entry, so the list only shrinks with the code it describes.
 */
export const allowlist = [
  {
    path: "scripts/backup/offsite-backup.test.ts",
    rule: "service-token",
    count: 1,
    reason: "AWS's documented example access key id, used to prove the backup redacts it",
  },
  ...[
    "packages/fiscal-nfse/signer.test.ts",
    "scripts/distribution/distribution.test.ts",
    "scripts/fiscal/fiscal-proof-plan.test.ts",
  ].map((path) => ({
    path,
    rule: "private-key",
    count: 1,
    reason: "PEM header without a key body, proving that a check refuses or redacts it",
  })),
  {
    path: "tests/fixtures/nfe/4.00/synthetic-signing-key.pem",
    rule: "private-key",
    count: 1,
    reason: "Synthetic signing key of the NF-e corpus, generated for tests only",
  },
];

const binary = (bytes) => bytes.subarray(0, 8000).includes(0);

/**
 * Findings in one file's bytes, one per occurrence: `{ path, line, rule }`,
 * without the matched value.
 */
export function scanFile(path, bytes, rules = repositoryCredentialRules) {
  if (binary(bytes)) return [];
  const findings = [];
  bytes
    .toString("utf8")
    .split("\n")
    .forEach((text, index) => {
      for (const [rule, pattern] of Object.entries(rules)) {
        const occurrences = text.match(new RegExp(pattern.source, "g"))?.length ?? 0;
        for (let i = 0; i < occurrences; i++) findings.push({ path, line: index + 1, rule });
      }
    });
  return findings;
}

/**
 * Scans the given files, read through `read(path)` (null when absent). A group
 * of findings with the same file and rule passes only when an exception
 * declares exactly that many; more blocks the whole group, fewer marks the
 * exception stale.
 */
export function scan(paths, read, { allow = allowlist, rules } = {}) {
  const groups = new Map();
  let scanned = 0;
  for (const path of paths) {
    const bytes = read(path);
    if (!bytes || binary(bytes)) continue;
    scanned++;
    for (const finding of scanFile(path, bytes, rules)) {
      const key = `${finding.path}\0${finding.rule}`;
      groups.set(key, [...(groups.get(key) ?? []), finding]);
    }
  }
  const entry = (key) => allow.find((a) => `${a.path}\0${a.rule}` === key);
  return {
    scanned,
    blocked: [...groups].flatMap(([key, found]) =>
      found.length > (entry(key)?.count ?? 0) ? found : [],
    ),
    stale: allow.filter((a) => (groups.get(`${a.path}\0${a.rule}`)?.length ?? 0) < a.count),
  };
}

export function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, windowsHide: true })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

/**
 * Reader for `scan`: bytes of a regular file under `root`, null for anything
 * else. Symlinks are not followed (a versioned symlink may point to a
 * directory; its target is versioned and scanned on its own), and a
 * deleted or replaced path is skipped instead of failing the run.
 */
export function regularFileReader(root) {
  return (path) => {
    const file = join(root, path);
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      return null;
    }
    return stat.isFile() ? readFileSync(file) : null;
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = repoRoot;
  const files = trackedFiles(root);
  const { scanned, blocked, stale } = scan(files, regularFileReader(root));
  for (const { path, line, rule } of blocked)
    console.error(`${path}:${line}  ${rule}  (valor omitido)`);
  for (const { path, rule, count } of stale)
    console.error(
      `${path}  ${rule}  menos de ${count} ocorrência(s); ajuste a exceção em scripts/public-copy/check-secrets.mjs`,
    );
  if (blocked.length || stale.length) {
    console.error(
      `secrets: ${blocked.length} possível(is) credencial(is) e ${stale.length} exceção(ões) obsoleta(s) em ${scanned} arquivos de texto`,
    );
    process.exit(1);
  }
  console.log(`secrets: ok, ${scanned} arquivos de texto de ${files.length} versionados`);
}
