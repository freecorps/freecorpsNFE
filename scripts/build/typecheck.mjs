// tsc --noEmit for the TypeScript project in the current directory (or the one
// given with -p/--project), with TypeScript 7, the native compiler installed as
// `typescript-7`: about four times faster than 6.0 on the three projects it
// checks (root, console and the console Worker). `typescript` stays on 6.0 for
// the editor, the emitting builds (fiscal packages, SDK declarations) and the
// SDK consumer proof, which use its JavaScript API; 7 does not ship one.
// Two checkers fit the 4-vCPU CI runner beside the three test workers.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repoUrl } from "../lib/repo-root.mjs";

const tsc = fileURLToPath(new URL("node_modules/typescript-7/bin/tsc", repoUrl));
const result = spawnSync(
  process.execPath,
  [tsc, "--noEmit", "--checkers", "2", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
