// Runner of the Freecorps workflows over the fiscal capture of the hosted site (ADR 0007,
// amendment of 22/10/2026, and #424): `emergency_withdraw` and `unblock` for one company, `halt`
// and `resume` for the whole deployment, `list`, the internal view of every company (#422), and
// `alert_test`, one test of the alert e-mail (#463). The checks are in `scripts/lib/capture-release.mjs`
// and, for the run, `scripts/lib/issuance-gate.mjs`. Order, each step closed before the next: the
// versioned plan of the site, the dispatch inputs, the run read from the GitHub API, the deploy
// key of the site, its `/health` as the hosted site, and only then the internal Convex function.
// A `/health` that does not confirm the site stops `unblock` and `resume`; the stops go on with a
// warning (`healthGate`). The log and the public receipt show codes, ids and outcomes; the full
// answer goes only into the receipt sealed for the custodians (`scripts/lib/sealed-receipt.mjs`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GateRefusal, deployKeyFor, gateConfig, verifiedRun } from "./lib/issuance-gate.mjs";
import {
  CAPTURE_WORKFLOWS,
  CONVEX_REFUSALS,
  captureCall,
  captureInputs,
  captureOutcome,
  captureSummary,
  healthGate,
  listLines,
  siteTarget,
} from "./lib/capture-release.mjs";
import { writeSealedReceipt } from "./lib/sealed-receipt.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const action = process.argv[2];
const output = join(root, ".ci-results/capture-release");
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

async function github(path) {
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new GateRefusal("GITHUB_API_FAILED", `GitHub respondeu ${response.status}.`);
  return response.json();
}

async function convex(target, key, call) {
  const response = await fetch(`${target.cloud}/api/${call.type}`, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Convex ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path: call.path, args: call.args, format: "json" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new GateRefusal("CONVEX_HTTP", `Convex respondeu ${response.status}.`);
  const result = await response.json();
  if (result.status !== "success") {
    const code =
      typeof result.errorData?.code === "string" ? result.errorData.code : "CONVEX_ERROR";
    throw new GateRefusal(
      code,
      Object.hasOwn(CONVEX_REFUSALS, code) ? CONVEX_REFUSALS[code] : "O Convex recusou a chamada.",
    );
  }
  return result.value;
}

function record(receipt, sensitive) {
  writeSealedReceipt({
    directory: output,
    receipt,
    sensitive,
    plan: () => read("deploy/offsite-backup.json"),
  });
}

const started = new Date().toISOString();
try {
  if (!Object.hasOwn(CAPTURE_WORKFLOWS, action))
    throw new GateRefusal(
      "ACTION_INVALID",
      "Use: capture-release.mjs emergency_withdraw|unblock|halt|resume|list|alert_test",
    );
  const target = siteTarget(read("deploy/platform-release.json"));
  // The same people who operate the NFS-e gate (deploy/issuance-gate.json).
  const config = gateConfig(read("deploy/issuance-gate.json"));
  const inputs = captureInputs(process.env, action);
  const runId = process.env.GITHUB_RUN_ID,
    attempt = process.env.GITHUB_RUN_ATTEMPT;
  const run = await github(
    `/actions/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(attempt)}`,
  );
  const verified = verifiedRun({
    action,
    env: process.env,
    run,
    approvals: null,
    config,
    workflows: CAPTURE_WORKFLOWS,
  });
  const key = deployKeyFor(process.env.CONVEX_DEPLOY_KEY, target.deployment);
  const health = await fetch(`${target.site}/health`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const checked = healthGate(action, health);
  // A workflow annotation, so the warning shows on the run's summary.
  if (!checked.verified) console.log(`::warning title=Health não confirmado::${checked.warning}`);
  const value = await convex(target, key, captureCall(action, inputs, verified));
  const summary = captureSummary(action, value);
  const lines = action === "list" ? listLines(value) : undefined;
  console.log(JSON.stringify({ action, deployment: target.deployment, ...summary }));
  if (lines) for (const line of lines) console.log(JSON.stringify(line));
  const result = captureOutcome(action, value);
  if (result !== "passed") {
    console.log(
      "::error title=E-mail de teste não confirmado::O destino não está configurado ou o provedor " +
        "não confirmou o envio; veja alertDestination e delivery no log. Não dispare de novo " +
        "um envio incerto antes de conferir a caixa.",
    );
    process.exitCode = 1;
  }
  record(
    {
      action,
      result,
      deployment: target.deployment,
      operator: verified.operator,
      ...(verified.actor ? { actor: verified.actor } : {}),
      runId: verified.runId,
      runAttempt: verified.runAttempt,
      health: checked.verified ? "verified" : "unverified",
      sha: health?.sha ?? null,
      summary,
      ...(lines ? { companies: lines } : {}),
      started,
    },
    { value },
  );
} catch (error) {
  const code = error instanceof GateRefusal ? error.code : "UNEXPECTED";
  const message =
    error instanceof GateRefusal
      ? error.message
      : "Falha inesperada; nada foi registrado como sucesso.";
  console.error(message);
  record({ action, result: "refused", code, started });
  process.exitCode = 1;
}
