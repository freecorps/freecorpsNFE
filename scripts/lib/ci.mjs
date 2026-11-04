import { relative } from "node:path";
import { isProjectRepository } from "./repository.mjs";
import { subprocessEnvironment } from "./subprocess-environment.mjs";
import { projectsFor, reportSuites, suiteFor, testProjects } from "./test-projects.mjs";

const SHA = /^[a-f0-9]{40}$/;
const VALIDATION_WORKFLOW = ".github/workflows/deploy-validation.yml@refs/heads/main";
export function revision(env, event, checkedSha) {
  if (!SHA.test(checkedSha) || (env.GITHUB_SHA && checkedSha !== env.GITHUB_SHA))
    throw new Error("Checkout differs from the workflow SHA");
  const headSha = event.pull_request?.head?.sha ?? checkedSha;
  const baseSha = event.pull_request?.base?.sha ?? null;
  if (!SHA.test(headSha) || (baseSha !== null && !SHA.test(baseSha)))
    throw new Error("Invalid revision metadata");
  return {
    checkedSha,
    headSha,
    baseSha,
    kind: env.GITHUB_EVENT_NAME === "pull_request" ? "pr-merge" : "commit",
    draft: event.pull_request?.draft === true,
  };
}

export function testEnvironment(env) {
  return subprocessEnvironment(env);
}

export function sanitizeReport(raw, root, metadata, exitCode) {
  const suites = Object.fromEntries(
    reportSuites.map((name) => [name, { files: 0, passed: 0, failed: 0, pending: 0 }]),
  );
  for (const result of raw.testResults ?? []) {
    const file = relative(root, result.name).replaceAll("\\", "/");
    if (!/^[a-zA-Z0-9_./-]+$/.test(file) || file.startsWith("../"))
      throw new Error("Report contains an unexpected test path");
    const suite = suites[suiteFor(file)];
    suite.files++;
    for (const test of result.assertionResults ?? []) {
      if (test.status === "passed") suite.passed++;
      else if (test.status === "failed") suite.failed++;
      else suite.pending++;
    }
  }
  return {
    schemaVersion: 1,
    revision: metadata,
    result: exitCode === 0 && raw.success === true ? "passed" : "failed",
    suites,
  };
}

const counts = () => ({ files: 0, passed: 0, failed: 0, pending: 0 });
const tally = (target, assertions = []) => {
  target.files++;
  for (const test of assertions) {
    if (test.status === "passed") target.passed++;
    else if (test.status === "failed") target.failed++;
    else target.pending++;
  }
};

/**
 * Recibo de uma área de testes (`ci.mjs test-area`): só contagens e o resultado,
 * sem a revisão. A tarefa `ci:test:<área>` o guarda no cache do Vite Task, que só
 * o repete quando nada do que a execução leu mudou; por isso o recibo não pode
 * ler `revision.json`, que muda a cada commit. `ranOn` diz em que run do GitHub
 * os testes rodaram de fato (nulo fora do Actions), para o resumo distinguir uma
 * execução de uma repetição.
 */
export function areaReceipt(raw, root, area, exitCode, env = {}) {
  const totals = counts();
  for (const result of raw.testResults ?? []) {
    const file = relative(root, result.name).replaceAll("\\", "/");
    if (!/^[a-zA-Z0-9_./-]+$/.test(file) || file.startsWith("../"))
      throw new Error("Report contains an unexpected test path");
    const owners = projectsFor(file);
    if (owners.length !== 1 || owners[0].name !== area)
      throw new Error("Report contains a test outside the area");
    tally(totals, result.assertionResults);
  }
  return {
    schemaVersion: 1,
    area,
    result: exitCode === 0 && raw.success === true && totals.failed === 0 ? "passed" : "failed",
    ...totals,
    ranOn: SHA.test(env.GITHUB_SHA ?? "")
      ? { sha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID ?? null }
      : null,
  };
}

/**
 * `tests.json` do grafo: junta os recibos das áreas sob a revisão do checkout.
 * Passa só se toda área de `testProjects` tem recibo aprovado que contou
 * exatamente os arquivos que ela tem agora (`expectedFiles`). Área ausente,
 * reprovada, de outro esquema ou com outra contagem reprova o conjunto. Um
 * recibo repetido do cache vale porque o Vite Task só o restaura para as
 * mesmas entradas e nunca guarda uma execução que falhou.
 * @param {Record<string, unknown>} metadata revision.json
 * @param {Record<string, any>} receipts recibo por área, ou ausente
 * @param {Record<string, number>} expectedFiles arquivos de teste por área
 */
export function collectTests(metadata, receipts, expectedFiles) {
  const suites = Object.fromEntries(reportSuites.map((name) => [name, counts()]));
  /**
   * @type {Record<string, { result: string, files?: number, passed?: number,
   *   failed?: number, pending?: number, ranOn?: { sha: string, runId: string | null } | null }>}
   */
  const areas = {};
  let passed = true;
  for (const { name, report } of testProjects) {
    const receipt = receipts[name];
    if (!receipt) {
      passed = false;
      areas[name] = { result: "missing" };
      continue;
    }
    const valid =
      receipt.schemaVersion === 1 &&
      receipt.area === name &&
      receipt.result === "passed" &&
      receipt.failed === 0 &&
      receipt.files > 0 &&
      receipt.files === expectedFiles[name];
    if (!valid) passed = false;
    const entry = {
      result: valid ? "passed" : "failed",
      files: Number(receipt.files) || 0,
      passed: Number(receipt.passed) || 0,
      failed: Number(receipt.failed) || 0,
      pending: Number(receipt.pending) || 0,
      ranOn: receipt.ranOn ?? null,
    };
    areas[name] = entry;
    for (const key of ["files", "passed", "failed", "pending"]) suites[report][key] += entry[key];
  }
  return {
    schemaVersion: 2,
    revision: metadata,
    result: passed ? "passed" : "failed",
    suites,
    areas,
  };
}

/** O recibo de testes aprova este checkout: todas as áreas passaram sob a mesma revisão. */
export function approvedTests(revisionData, report) {
  return (
    report?.schemaVersion === 2 &&
    report.result === "passed" &&
    revisionData?.checkedSha === report.revision?.checkedSha &&
    testProjects.every(({ name }) => report.areas?.[name]?.result === "passed")
  );
}

export function publicationSha(env, testedSha) {
  if (!SHA.test(testedSha) || testedSha !== env.GITHUB_SHA)
    throw new Error("Publication requires the exact validated commit");
  // Under workflow_call the caller owns event, ref and workflow_ref: only the
  // manual validation workflow on main gets a SHA, never the production push.
  return env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_REF === "refs/heads/main" &&
    isProjectRepository(env.GITHUB_REPOSITORY) &&
    env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/${VALIDATION_WORKFLOW}`
    ? testedSha
    : "";
}
