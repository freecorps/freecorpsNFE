import { checkPublication } from "./validation-deploy.mjs";
import { smokeCredentials } from "./validation-smoke.mjs";

export const browserTarget = Object.freeze({
  consoleUrl: "https://freecorpsnfe-validation.freecorps.workers.dev",
  siteUrl: "https://modest-seal-118.convex.site",
  url: "https://modest-seal-118.convex.cloud",
});

export function browserPlan(env, checkedSha, accounts, publication) {
  const sha = env.VALIDATION_E2E_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Expected published SHA is required");
  if (env.GITHUB_ACTIONS === "true") {
    if (env.VALIDATION_E2E_CANDIDATE_CSS)
      throw new Error("CI must test published assets without overrides");
    checkPublication(env, checkedSha);
    if (sha !== checkedSha || publication?.sha !== sha)
      throw new Error("Browser and publication revisions differ");
    if (publication.state === "obsolete") return { sha, mode: "obsolete", accounts: [] };
    if (publication.state !== "validated") throw new Error("Publication has not passed smoke");
    if (accounts) throw new Error("CI accepts only the pre-provisioned viewer");
    return { sha, mode: "smoke", accounts: [{ role: "viewer", ...smokeCredentials(env) }] };
  }
  if (
    accounts?.url !== browserTarget.consoleUrl ||
    !Array.isArray(accounts.accounts) ||
    accounts.accounts.length !== 3 ||
    new Set(accounts.accounts.map((a) => a.role)).size !== 3
  )
    throw new Error("Review requires the three synthetic test roles");
  return {
    sha,
    mode: "review",
    accounts: accounts.accounts.map((account) => {
      if (!["viewer", "operator", "none"].includes(account.role) || account.created !== true)
        throw new Error("Test account is not provisioned");
      return {
        role: account.role,
        ...smokeCredentials({
          VALIDATION_SMOKE_EMAIL: account.email,
          VALIDATION_SMOKE_PASSWORD: account.password,
        }),
      };
    }),
  };
}

// No selectors, HTML, request bodies, tokens, exception messages or user names.
export function accessibilityCounts(results) {
  return {
    violations: results.violations.map((rule) => ({
      id: /^[a-z0-9-]+$/.test(rule.id) ? rule.id : "unknown",
      impact: ["minor", "moderate", "serious", "critical"].includes(rule.impact)
        ? rule.impact
        : "unknown",
      nodes: rule.nodes.length,
    })),
    needsManualReview: results.incomplete.length,
  };
}

export function accessibilityBlocked(counts) {
  return counts.violations.some((rule) => ["serious", "critical"].includes(rule.impact));
}

// Fixed labels for known Playwright failures; the message itself never leaves this function.
// Each pattern is anchored at the start of the reason, right after "<method>: ", so a filled value
// echoed later in the message cannot select a label.
const failureCauses = [
  [/^(?:Error: )?strict mode violation:/, "strict-mode-violation"],
  [/^Target page, context or browser has been closed/, "target-closed"],
  [/^Execution context was destroyed/, "context-destroyed"],
  [/^Timeout \d{1,7}ms exceeded/, "timeout"],
  [/^(?:Navigation failed because page was closed|Frame was detached)/, "navigation-interrupted"],
];

function failureCause(method, message) {
  const firstLine = message.split("\n", 1)[0];
  const prefix = `${method}: `;
  if (!firstLine.startsWith(prefix)) return "unknown";
  const reason = firstLine.slice(prefix.length);
  // Only navigation errors carry a Chromium code, and goto never receives a filled value.
  if (method === "page.goto") {
    const network = /^net::(ERR_[A-Z0-9_]{1,60}) at /.exec(reason);
    if (network) return network[1];
  }
  return failureCauses.find(([pattern]) => pattern.test(reason))?.[1] ?? "unknown";
}

// Playwright messages may echo filled values: keep only the error class, a fixed cause and the failed call.
export async function browserStep(report, checkpoint, method, action) {
  report.checkpoint = checkpoint;
  try {
    return await action();
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    report.failure = {
      checkpoint,
      method,
      error: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "unknown",
      cause: failureCause(method, error instanceof Error ? error.message : ""),
    };
    throw error;
  }
}
