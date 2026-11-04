// Runner of the NFS-e fiscal production workflows (#198): `plan`, `enable`, `emergency_disable`,
// `probe` and `verify-issued`. The checks are in `scripts/lib/issuance-gate.mjs`. Order, each
// step closed before the next: the versioned plan (no named deployment, no call), the dispatch
// inputs, the run and its approval read from the GitHub API, the deploy key of the planned
// deployment, its `/health` as fiscal production, and only then the internal Convex function.
// The log and the public receipt show codes, ids and outcomes; the full answer goes only into
// the receipt sealed for the custodians (`scripts/lib/sealed-receipt.mjs`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GATE_WORKFLOWS,
  GateRefusal,
  convexCall,
  deployKeyFor,
  dispatchInputs,
  gateConfig,
  githubRun,
  productionHealth,
  productionTarget,
  summary,
  verifiedRun,
} from "../lib/issuance-gate.mjs";
import { writeSealedReceipt } from "../lib/sealed-receipt.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

const root = repoRoot;
const action = process.argv[2];
const output = join(root, ".ci-results/issuance-gate");
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

async function convex(target, key, call) {
  const kind = call.path === "issuance:setProductionGate" ? "mutation" : "action";
  const response = await fetch(`${target.cloud}/api/${kind}`, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Convex ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path: call.path, args: call.args, format: "json" }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new GateRefusal("CONVEX_HTTP", `Convex respondeu ${response.status}.`);
  const result = await response.json();
  if (result.status !== "success") {
    const code =
      typeof result.errorData?.code === "string" ? result.errorData.code : "CONVEX_ERROR";
    throw new GateRefusal(code, "O Convex recusou a chamada.");
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
  if (!Object.hasOwn(GATE_WORKFLOWS, action))
    throw new GateRefusal(
      "ACTION_INVALID",
      "Use: issuance-gate.mjs plan|enable|emergency_disable|probe|verify-issued",
    );
  // First and without any secret: while the plan names no deployment, nothing else runs.
  const target = productionTarget(read("deploy/issuance-production.json"));
  const config = gateConfig(read("deploy/issuance-gate.json"));
  if (action === "plan") {
    console.log(`Plano nomeia ${target.deployment}; os workflows de produção fiscal podem rodar.`);
    record({ action, result: "passed", deployment: target.deployment, started });
  } else {
    const inputs = dispatchInputs(process.env, action);
    const { run, approvals } = await githubRun(process.env, action === "enable");
    const verified = verifiedRun({ action, env: process.env, run, approvals, config });
    const key = deployKeyFor(process.env.CONVEX_DEPLOY_KEY, target.deployment);
    // A non-200 or non-JSON answer is a deployment problem, refused as such.
    const health = await fetch(`${target.site}/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    productionHealth(health);
    const call = convexCall(action, inputs, verified);
    const value = await convex(target, key, call);
    const shown = summary(action, value);
    console.log(JSON.stringify({ action, deployment: target.deployment, ...shown }));
    record(
      {
        action,
        result: "passed",
        deployment: target.deployment,
        operator: verified.operator,
        ...(verified.actor ? { actor: verified.actor } : {}),
        ...(verified.approver ? { approver: verified.approver } : {}),
        runId: verified.runId,
        runAttempt: verified.runAttempt,
        organizationId: inputs.organizationId,
        companyId: inputs.companyId,
        ...(inputs.issuanceId ? { issuanceId: inputs.issuanceId } : {}),
        sha: health.sha ?? null,
        summary: shown,
        started,
      },
      { value },
    );
  }
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
