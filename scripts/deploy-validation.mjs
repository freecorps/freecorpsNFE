import { execFileSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { validateTarget, verifyRemoteEnvironment, backendRequest } from "./lib/validation.mjs";
import { checkConsoleWorker, consoleEnvironment } from "./lib/console.mjs";
import {
  checkPublication,
  obsoleteMessage,
  publishRevision,
  withRehearsalLock,
  requireRehearsalWindow,
} from "./lib/validation-deploy.mjs";
import { smokeCredentials, smokeValidation } from "./lib/validation-smoke.mjs";
import { smokeDiagnosticText } from "./lib/smoke-diagnostic.mjs";
import { buildPlatformPackages } from "./lib/platform-build.mjs";
import { projectRepository } from "./lib/repository.mjs";
import { publicationEnvironment } from "./lib/subprocess-environment.mjs";
import { startTermsOfUseNotice } from "./lib/terms-notice.mjs";
import { repoRoot } from "./lib/repo-root.mjs";

const root = repoRoot;
const output = join(root, ".validation-results");
const journal = join(output, "deployment.json");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const run = (script, args, env) => {
  const result = spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) throw new Error("Publication subprocess failed");
};

async function main() {
  mkdirSync(output, { recursive: true });
  if (process.argv[2] === "summary") {
    const receipt = existsSync(journal) ? JSON.parse(readFileSync(journal, "utf8")) : null;
    const summary = `# Publicação de validação\n\nSHA: \`${receipt?.sha ?? process.env.GITHUB_SHA ?? "unknown"}\`\n\nEstado: ${receipt?.state ?? "not-started"}. Etapa: ${receipt?.phase ?? "setup"}. Job: ${process.env.VALIDATION_JOB_STATUS ?? "local"}.\n\nPainel: https://freecorpsnfe-validation.freecorps.workers.dev\n\nBackend: https://modest-seal-118.convex.site/health\n\nSonda preservada: ${receipt?.after ? (receipt.before === receipt.after ? "sim" : "não") : "não verificada"}\n\nEm estado parcial, conferir os SHAs e reexecutar todos os jobs do commit elegível para concluir ambos os serviços. Rollback de código não desfaz schema ou dados.\n`;
    const diagnostic = receipt?.diagnostic
      ? `\nDiagnóstico do smoke: ${smokeDiagnosticText(receipt.diagnostic)}\n`
      : "";
    const cleanup = receipt?.cleanupDiagnostic
      ? `\nFalha ao encerrar sessão: ${smokeDiagnosticText(receipt.cleanupDiagnostic)}\n`
      : "";
    const notice = receipt?.termsOfUseNotice
      ? `\nAviso dos termos de uso: ${receipt.termsOfUseNotice.state}${receipt.termsOfUseNotice.version ? ` (${receipt.termsOfUseNotice.version})` : ""}\n`
      : "";
    const report = summary + diagnostic + cleanup + notice;
    writeFileSync(join(output, "summary.md"), report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
    else console.log(report);
    return;
  }
  const flags = process.argv.slice(2);
  rmSync(journal, { force: true });
  if (
    flags.some((f) => !["--rehearsal", "--fail-after-backend"].includes(f)) ||
    new Set(flags).size !== flags.length
  )
    throw new Error("Usage: deploy-validation.mjs [--rehearsal [--fail-after-backend]] | summary");
  const rehearsal = flags.includes("--rehearsal");
  const failAfterBackend = flags.includes("--fail-after-backend");
  if ((rehearsal && process.env.GITHUB_ACTIONS === "true") || (failAfterBackend && !rehearsal))
    throw new Error("Failure rehearsal is local operator only");
  const sha = git("rev-parse", "HEAD");
  if (!rehearsal) checkPublication(process.env, sha);
  if (git("status", "--porcelain"))
    throw new Error("Publication requires a clean committed checkout");
  const context = validateTarget(process.env);
  const credentials = smokeCredentials(process.env);
  if (!process.env.VALIDATION_CLOUDFLARE_API_TOKEN?.trim())
    throw new Error("Missing dedicated VALIDATION_CLOUDFLARE_API_TOKEN");
  // Provider credentials are handed only to the matching subprocess.
  const baseEnv = publicationEnvironment(process.env);
  const backendEnv = { ...baseEnv, VALIDATION_CONVEX_DEPLOY_KEY: context.key };
  const frontendEnv = {
    ...baseEnv,
    CLOUDFLARE_API_TOKEN: process.env.VALIDATION_CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: "ceccd1846b474bb179054a3c2c4a6185",
  };
  const writerFlags = rehearsal ? ["--bootstrap"] : [];
  const buildFile = join(root, "platform/convex/buildInfo.ts");
  let currentMain = null;
  console.log(
    `target: dev (${context.target.deploymentName}, persistent validation), Worker freecorpsnfe-validation, SHA ${sha}`,
  );
  const publish = () =>
    publishRevision(
      sha,
      {
        preflight: async () => {
          checkConsoleWorker(
            JSON.parse(readFileSync(join(root, "apps/console/wrangler.json"), "utf8")),
          );
          consoleEnvironment(baseEnv, sha);
          await verifyRemoteEnvironment(context);
        },
        build: async () => {
          buildPlatformPackages();
          run("node_modules/vite-plus/bin/vp", ["run", "ci:docs"], baseEnv);
          run("scripts/console.mjs", ["package"], baseEnv);
        },
        eligible: async () => {
          if (rehearsal) {
            // Closed while main carries the pipeline writer: a local rehearsal could race a dispatch.
            await requireRehearsalWindow(process.env.GH_TOKEN);
            return true;
          }
          const response = await fetch(
            `https://api.github.com/repos/${projectRepository()}/git/ref/heads/main`,
            {
              headers: {
                Authorization: `Bearer ${process.env.GH_TOKEN}`,
                Accept: "application/vnd.github+json",
              },
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
            },
          );
          if (!response.ok) throw new Error("Cannot determine current integration revision");
          const current = (await response.json()).object?.sha;
          currentMain = typeof current === "string" ? current : null;
          return current === sha;
        },
        probe: async () =>
          (
            await backendRequest(context, "/api/query", {
              path: "validation:readProbe",
              args: {},
              format: "json",
            })
          ).value,
        backend: async () => {
          const original = readFileSync(buildFile);
          try {
            writeFileSync(
              buildFile,
              `export const buildSha: string | null = ${JSON.stringify(sha)};\n`,
            );
            run("scripts/validation.mjs", ["deploy", ...writerFlags], backendEnv);
          } finally {
            writeFileSync(buildFile, original);
          }
          const health = await fetch(`${context.target.siteUrl}/health`, {
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
          });
          if (!health.ok || (await health.json()).sha !== sha)
            throw new Error("Backend revision mismatch");
        },
        frontend: async () => {
          if (failAfterBackend)
            throw new Error("Intentional interruption after backend publication");
          run("scripts/console.mjs", ["publish", ...writerFlags], frontendEnv);
        },
        smoke: async () => {
          await smokeValidation(sha, credentials);
        },
      },
      record,
    );
  const record = (receipt) =>
    writeFileSync(
      journal,
      `${JSON.stringify({ ...receipt, mode: rehearsal ? "operator-rehearsal" : "integration-pipeline" }, null, 2)}\n`,
    );
  let result;
  if (rehearsal) {
    const common = resolve(root, git("rev-parse", "--git-common-dir"));
    result = await withRehearsalLock(join(common, "validation-rehearsal.lock"), publish);
  } else {
    result = await publish();
    // Do not report an obsolete SHA as a successful GitHub environment deployment.
    if (result.state === "obsolete") {
      console.error(obsoleteMessage(sha, currentMain));
      process.exitCode = 1;
    }
  }
  // The e-mail notice of a new version of the terms of use (#594), once the revision serves, through
  // the validation's account e-mail: only addresses in ACCOUNT_EMAIL_RECIPIENTS receive it. A
  // failed call is recorded in the journal, never a failed publication.
  if (result.state !== "obsolete")
    record({
      ...result,
      termsOfUseNotice: await startTermsOfUseNotice(
        async (path) =>
          (await backendRequest(context, "/api/mutation", { path, args: {}, format: "json" }))
            .value,
      ),
    });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Validation deployment failed");
  process.exitCode = 1;
});
