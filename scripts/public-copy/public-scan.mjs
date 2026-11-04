// CI entry of the public scan (.github/workflows/public-scan.yml, #267 phase 1d). It picks how
// scripts/public-copy/public-tree.mjs runs and what its exit means:
// - with the custody list in the checkout (the private archive), it assembles and scans the
//   public copy of HEAD, edits included;
// - without it (the public repository), it scans every versioned file of HEAD (--checkout), with
//   the restricted names from FNFE_PUBLIC_DENYLIST when the run has the secret.
// A blocked scan fails only with PUBLIC_SCAN_ENFORCE=true; otherwise it warns. A usage error
// (exit 2) always fails.
//   node scripts/public-copy/public-scan.mjs <empty output folder outside the repository>
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DENYLIST } from "./public-tree.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

/**
 * The public-tree arguments and how to read its exit.
 * @param {{ out: string; custody: boolean; denylistFile?: string | null; enforce: boolean }} input
 */
export function scanPlan({ out, custody, denylistFile = null, enforce }) {
  const args = custody
    ? ["--sha", "HEAD", "--out", out]
    : [
        "--checkout",
        "--sha",
        "HEAD",
        "--out",
        out,
        ...(denylistFile ? ["--denylist", denylistFile] : []),
      ];
  return { mode: custody ? "cópia" : "checkout", args, enforce };
}

/** The exit code of the CI step for the exit of public-tree. */
export function stepExit(status, enforce) {
  if (status === 0) return 0;
  if (status === 1) return enforce ? 1 : 0;
  return status || 2;
}

// The same guard as scripts/public-copy/public-tree.mjs: argv[1] resolved, so a relative or
// differently spelled invocation still runs the scan instead of exiting 0 in silence.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = repoRoot;
  const [out] = process.argv.slice(2);
  if (!out) {
    console.error("uso: node scripts/public-copy/public-scan.mjs <pasta de saída vazia fora do repositório>");
    process.exit(2);
  }
  const custody = existsSync(join(root, DEFAULT_DENYLIST));
  const secret = (process.env.FNFE_PUBLIC_DENYLIST ?? "").trim();
  let scratch = null;
  let denylistFile = null;
  if (!custody && secret) {
    // Outside the checkout, removed at the end: the hashes never enter the scanned tree.
    scratch = mkdtempSync(join(tmpdir(), "fnfe-public-scan-"));
    denylistFile = join(scratch, "denylist.json");
    writeFileSync(denylistFile, secret, { mode: 0o600 });
  }
  const enforce = process.env.PUBLIC_SCAN_ENFORCE === "true";
  const plan = scanPlan({ out, custody, denylistFile, enforce });
  console.log(`public-scan: modo ${plan.mode}${enforce ? ", bloqueante" : ", só aviso"}`);
  const run = spawnSync(process.execPath, [join(root, "scripts/public-copy/public-tree.mjs"), ...plan.args], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  const code = stepExit(run.status, enforce);
  if (run.status === 1 && code === 0)
    console.log(
      "::warning title=Varredura pública bloqueada::Há achados ou edições pendentes; veja o artefato public-scan. Com PUBLIC_SCAN_ENFORCE=false, o passo só avisa.",
    );
  process.exit(code);
}
