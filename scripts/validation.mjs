import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { validateBackupDirectory } from "./lib/validation-backup.mjs";
import { buildPlatformPackages } from "./lib/platform-build.mjs";
import {
  backendRequest,
  requireIntegrationWriter,
  validateTarget,
  validationChildEnv,
  verifyRemoteEnvironment,
} from "./lib/validation.mjs";
import { repoRoot, repoUrl } from "./lib/repo-root.mjs";

function runConvex(context, args) {
  const temporary = mkdtempSync(join(tmpdir(), "fnfe-validation-"));
  const envFile = join(temporary, "deployment.env");
  try {
    writeFileSync(envFile, `CONVEX_DEPLOY_KEY=${context.key}\n`, { mode: 0o600 });
    const cli = fileURLToPath(new URL("node_modules/convex/bin/main.js", repoUrl));
    const cwd = fileURLToPath(new URL("platform", repoUrl));
    const result = spawnSync(process.execPath, [cli, ...args, "--env-file", envFile], {
      cwd,
      env: validationChildEnv(process.env, context.key),
      stdio: "inherit",
    });
    if (result.error || result.status !== 0) throw new Error("Validation command failed");
  } finally {
    rmSync(envFile, { force: true });
    rmdirSync(temporary);
  }
}

async function probe(context, creating) {
  const result = await backendRequest(context, creating ? "/api/mutation" : "/api/query", {
    path: creating ? "validation:createProbe" : "validation:readProbe",
    args: creating ? { nonce: randomUUID() } : {},
    format: "json",
  });
  return result.value;
}

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  if (
    !["check", "deploy", "probe-create", "probe-read", "verify-persistence", "backup"].includes(
      command,
    ) ||
    flags.some((flag) => flag !== "--bootstrap") ||
    flags.length > 1
  ) {
    throw new Error(
      "Usage: validation.mjs check|deploy|probe-create|probe-read|verify-persistence|backup [--bootstrap]",
    );
  }
  const context = validateTarget(process.env);
  const backupDirectory =
    command === "backup"
      ? validateBackupDirectory(process.env.VALIDATION_BACKUP_DIR, repoRoot)
      : undefined;
  const writes = ["deploy", "probe-create", "verify-persistence"].includes(command);
  if (writes) requireIntegrationWriter(process.env, flags.includes("--bootstrap"));
  console.log(`target: dev (${context.target.deploymentName}, persistent validation)`);
  // Authenticates against the fixed host and checks settings before the first write.
  await verifyRemoteEnvironment(context);
  if (command === "check") {
    console.log("Validation target and remote environment verified");
    return;
  }
  if (command === "backup") {
    const directory = backupDirectory;
    mkdirSync(directory, { recursive: true });
    const output = join(directory, `modest-seal-118-${Date.now()}-${randomUUID()}.zip`);
    runConvex(context, ["export", "--include-file-storage", "--path", output]);
    console.log(`Validation snapshot: ${output}`);
    return;
  }
  if (command === "deploy" || command === "verify-persistence") {
    buildPlatformPackages();
    let before;
    if (command === "verify-persistence") {
      await probe(context, true);
      before = await probe(context, false);
      if (!before) throw new Error("Persistence probe was not created");
    }
    runConvex(context, ["deploy", "--yes"]);
    const jobs = await backendRequest(context, "/api/query", {
      path: "_system/frontend/listCronJobs",
      args: {},
      format: "json",
    });
    if (!Array.isArray(jobs.value) || jobs.value.length !== 0)
      throw new Error("Unexpected registered cron jobs");
    console.log("Validation deployed; zero registered crons; no seed or reset executed");
    if (before) {
      const after = await probe(context, false);
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new Error("Probe changed across deployment");
      console.log(JSON.stringify({ persisted: true, probe: after }));
    }
    return;
  }
  console.log(JSON.stringify(await probe(context, command === "probe-create")));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
