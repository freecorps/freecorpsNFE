import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkConsoleWorker,
  consoleEnvironment,
  consolePublicationEnvironment,
  checkPreparedConsole,
} from "../lib/console.mjs";
import { requireIntegrationWriter } from "../lib/validation.mjs";
import { repoRoot, repoUrl } from "../lib/repo-root.mjs";

const root = repoRoot;
const cwd = fileURLToPath(new URL("apps/console", repoUrl));
// Caminhos relativos à raiz do repositório.
function run(relative, args, env) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(relative, repoUrl)), ...args], {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) throw new Error("Console command failed");
}

try {
  const [command, ...flags] = process.argv.slice(2);
  if (
    !["build", "deploy", "package", "publish"].includes(command) ||
    flags.some((flag) => flag !== "--bootstrap") ||
    flags.length > 1 ||
    (!["deploy", "publish"].includes(command) && flags.length)
  )
    throw new Error("Usage: console.mjs build|package|deploy|publish [--bootstrap]");
  checkConsoleWorker(JSON.parse(readFileSync(`${cwd}/wrangler.json`, "utf8")));
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const env = consoleEnvironment(process.env, sha);
  const publishes = command === "deploy" || command === "publish";
  const publishEnv = publishes ? consolePublicationEnvironment(process.env) : null;
  if (publishes) {
    requireIntegrationWriter(process.env, flags.includes("--bootstrap"));
    if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim())
      throw new Error("Commit all console and backend changes before publishing");
  }
  console.log(`target: validation console (freecorpsnfe-validation), commit ${sha}`);
  if (command !== "publish") {
    // Build and package without publication credentials, including direct deploy.
    run("scripts/build/typecheck.mjs", ["--project", "tsconfig.json"], env);
    run("scripts/build/typecheck.mjs", ["--project", "tsconfig.worker.json"], env);
    run("scripts/build/typecheck.mjs", ["--project", "../../docs/tsconfig.json"], env);
    run("../../node_modules/vite-plus/bin/vp", ["build"], env);
    writeFileSync(
      `${cwd}/dist/build.json`,
      `${JSON.stringify({ environment: "validation", sha })}\n`,
    );
  }
  checkPreparedConsole(JSON.parse(readFileSync(`${cwd}/dist/build.json`, "utf8")), sha);
  run("scripts/console/prove-public-site.mjs", [`${cwd}/dist`], env);
  if (command !== "build")
    run(
      "node_modules/wrangler/bin/wrangler.js",
      ["deploy", "--config", "wrangler.json", ...(command === "package" ? ["--dry-run"] : [])],
      publishEnv ?? env,
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Console command failed");
  process.exitCode = 1;
}
