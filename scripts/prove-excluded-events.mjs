import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { processNfe, deriveFiscalSituation } from "../packages/fiscal-nfe/dist/index.js";
import { proveExcludedEvents } from "./lib/nfe-situation-proof.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const beforeSha = "2947b9c6d9b1671a7d5100c447d68f10d9537e5d";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const source = git("show", `${beforeSha}:packages/fiscal-nfe/src/status.ts`);
const output = join(root, ".ci-results/nfe");
mkdirSync(output, { recursive: true });
const historicalModule = join(mkdtempSync(join(output, "status-before-")), "status.mjs");
const compiled = ts
  .transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  })
  .outputText.replace(
    '"@freecorps/fiscal-core"',
    JSON.stringify(pathToFileURL(join(root, "packages/fiscal-core/dist/index.js")).href),
  )
  .replace(
    '"./types.js"',
    JSON.stringify(pathToFileURL(join(root, "packages/fiscal-nfe/dist/types.js")).href),
  );
writeFileSync(historicalModule, compiled, "utf8");
const { deriveFiscalSituation: before } = await import(pathToFileURL(historicalModule).href);
const manifest = JSON.parse(
  readFileSync(join(root, "tests/fixtures/nfe/4.00/manifest.json"), "utf8"),
);
const cases = manifest.cases.map((entry) => {
  const bytes = readFileSync(join(root, "tests/fixtures/nfe/4.00", entry.path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  return {
    id: entry.id,
    result: processNfe(bytes, { source: "synthetic", evaluatedAt: manifest.evaluatedAt }),
  };
});
// The historical status function must fail the exact same contract that passes today.
assert.throws(() => proveExcludedEvents(cases, before), assert.AssertionError);
const get = (id) => cases.find((entry) => entry.id === id).result;
const failures = [
  "event-rejected-conflicting-claims",
  "event-unlinked-conflicting-claims",
  "event-rejected-other-identity",
].map((id) => {
  const result = before([get("invoice-authorized"), get("event-110111"), get(id)]);
  assert.equal(result.reportedStatus, "conflict");
  return { id, expectedStatus: "cancelled", observed: result };
});
const receipt = {
  codeSha: git("rev-parse", "HEAD"),
  dirty: Boolean(git("status", "--porcelain")),
  runtime: process.version,
  environment: "offline-synthetic",
  beforeSha,
  comparison:
    "Historical status function with current parser/core and identical signed synthetic XML; not a replay of the entire old release",
  beforeSourceSha256: createHash("sha256").update(source).digest("hex"),
  failures,
  current: proveExcludedEvents(cases, deriveFiscalSituation),
};
writeFileSync(join(output, "excluded-events.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(
  JSON.stringify({
    before: failures.map(({ id, observed }) => ({
      id,
      status: observed.reportedStatus,
      conflicts: observed.conflicts,
    })),
    current: receipt.current.result,
  }),
);
