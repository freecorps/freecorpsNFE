import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectTarball, sha256, stagePackage } from "../lib/distribution.mjs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { npmRunner } from "../lib/npm-cli.mjs";

if (!process.versions.bun) throw new Error("Execute com Bun fixado no package.json");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim();
const codeSha = git("rev-parse", "HEAD");
const dirty = !!git("status", "--porcelain");
const staging = mkdtempSync(join(tmpdir(), "fnfe-distribution-"));
// --registry installs the published versions instead of the local tarballs, after
// checking that the registry holds exactly the bytes rebuilt at this revision. A
// private artifact (contracts) is still installed from its local tarball.
const fromRegistry = process.argv.includes("--registry");
const reportName = fromRegistry ? "registry.json" : "tarballs.json";
const output = resolve(".ci-results/83");
mkdirSync(output, { recursive: true });
writeFileSync(
  join(output, reportName),
  JSON.stringify({ codeSha, dirty, result: "incomplete" }) + "\n",
);
const reports = [];
const tarballs = {};
const coreVersion = JSON.parse(readFileSync("packages/fiscal-core/package.json", "utf8")).version;
for (const name of ["contracts", "fiscal-core", "fiscal-nfe", "fiscal-nfse", "sdk"]) {
  // contracts and sdk publish a generated directory; the fiscal packages, their own.
  const source = resolve(
    "packages",
    name,
    ...(["contracts", "sdk"].includes(name) ? ["dist"] : []),
  );
  const target = join(staging, name);
  // The whole directory, including sources, tests and fixtures: the manifest's
  // `files` field must keep them out, and the inspector refuses them otherwise.
  const manifest = stagePackage(source, target, { "@freecorps/fiscal-core": coreVersion });
  execFileSync(process.execPath, ["pm", "pack", "--destination", output], {
    cwd: target,
    stdio: "pipe",
  });
  const tarball = join(
    output,
    `${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`,
  );
  reports.push(inspectTarball(tarball, manifest.name));
  tarballs[manifest.name] = `file:${tarball.replaceAll("\\", "/")}`;
}
// Install the exact inspected bytes, outside the monorepo. Test corpus is
// copied separately after packaging, never included in an artifact.
const consumer = join(staging, "consumer");
mkdirSync(consumer);
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify({ private: true, type: "module", dependencies: tarballs }),
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/^(CONVEX_|FNFE_|VITE_|CLERK_|BETTER_AUTH_|CLOUDFLARE_|CF_|ACCOUNT_|AUTH_PROXY_|VALIDATION_|NODE_OPTIONS$)/i.test(
        name,
      ),
  ),
);
const npm = npmRunner();
const registry = {};
if (fromRegistry) {
  for (const artifact of reports.filter((r) => !r.private)) {
    const bytes = readFileSync(tarballs[artifact.name].slice(5));
    const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
    const spec = `${artifact.name}@${artifact.version}`;
    const published = JSON.parse(npm(["view", spec, "dist", "--json"], consumer, env));
    assert.equal(
      published.integrity,
      integrity,
      `Registry difere do tarball desta revisão: ${spec}`,
    );
    registry[artifact.name] = { version: artifact.version, integrity, tarball: published.tarball };
  }
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: Object.fromEntries(
        reports.map((r) => [r.name, r.private ? tarballs[r.name] : r.version]),
      ),
    }),
  );
}
npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer, env);
const installed = npm(["ls", "--all", "--json"], consumer, env);
writeFileSync(join(output, "runtime-tree.json"), installed);
assert.ok(
  !/"(?:convex|react(?:-dom)?|better-auth|wrangler|@convex-dev\/[^"/]+|@clerk\/[^"/]+|@cloudflare\/[^"/]+)"/.test(
    installed,
  ),
  "Dependência SaaS no consumidor",
);
const inventory = [
  ...JSON.parse(readFileSync("docs/licenses/dependencies.json", "utf8")).packages,
  ...JSON.parse(readFileSync("docs/licenses/runtime-additions.json", "utf8")).packages,
];
const inventoried = new Set(inventory.map((item) => item.id));
const consumerLock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
for (const [path, entry] of Object.entries(consumerLock.packages)) {
  if (!path) continue;
  const name = path.split("node_modules/").at(-1);
  if (name.startsWith("@freecorps/")) {
    if (fromRegistry && registry[name]) {
      assert.equal(
        entry.integrity,
        registry[name]?.integrity,
        `Instalado difere do aceito: ${name}`,
      );
      assert.ok(entry.resolved?.startsWith("https://registry.npmjs.org/"), `Origem: ${name}`);
    }
    continue;
  }
  const reviewed = inventory.find((item) => item.id === `${name}@${entry.version}`);
  assert.equal(
    entry.integrity,
    reviewed?.integrity,
    `Integridade instalada fora do inventário: ${name}`,
  );
}
const runtimeDependencies = new Set();
function inspectDependencies(tree) {
  for (const [name, dependency] of Object.entries(tree.dependencies ?? {})) {
    if (!name.startsWith("@freecorps/")) {
      const id = `${name}@${dependency.version}`;
      assert.ok(inventoried.has(id), `Runtime instalado fora do inventário: ${id}`);
      runtimeDependencies.add(id);
    }
    inspectDependencies(dependency);
  }
}
inspectDependencies(JSON.parse(installed));
cpSync("tests/fixtures/nfe/4.00", join(consumer, "corpus"), { recursive: true });
cpSync("packages/contracts/fixtures/webhooks.json", join(consumer, "vectors.json"));
cpSync("scripts/lib/nfe-consumer.mjs", join(consumer, "xml.mjs"));
cpSync("scripts/lib/nfse-consumer.mjs", join(consumer, "nfse.mjs"));
cpSync("scripts/lib/nfe-situation-proof.mjs", join(consumer, "nfe-situation-proof.mjs"));
cpSync("scripts/lib/sdk-distribution-consumer.mjs", join(consumer, "sdk.mjs"));
cpSync("scripts/lib/contracts-distribution-consumer.mjs", join(consumer, "contracts.mjs"));
const runConsumer = (file) =>
  JSON.parse(
    execFileSync("node", [file], {
      cwd: consumer,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }),
  );
const xml = runConsumer("xml.mjs"),
  nfse = runConsumer("nfse.mjs"),
  sdk = runConsumer("sdk.mjs"),
  contracts = runConsumer("contracts.mjs");
// The declarations must resolve for a NodeNext consumer, outside the monorepo.
writeFileSync(
  join(consumer, "types.ts"),
  ["", "/external", "/organizations", "/references", "/registry", "/webhooks"]
    .map((subpath, index) => `import * as c${index} from "@freecorps/contracts${subpath}";`)
    .concat(
      'import { FreecorpsClient } from "@freecorps/freecorpsnfe-sdk";',
      "export const used = [c0, c1, c2, c3, c4, c5, FreecorpsClient];",
    )
    .join("\n") + "\n",
);
execFileSync(
  process.execPath,
  [
    resolve("node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--strict",
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "--target",
    "es2022",
    "--lib",
    "es2023,dom,dom.iterable",
    "types.ts",
  ],
  { cwd: consumer, env, stdio: "inherit", windowsHide: true },
);
for (const artifact of reports)
  assert.equal(
    sha256(readFileSync(tarballs[artifact.name].slice(5))),
    artifact.tarballSha256,
    "Tarball mudou durante a prova",
  );
assert.equal(git("rev-parse", "HEAD"), codeSha, "Checkout mudou durante a prova");
assert.equal(!!git("status", "--porcelain"), dirty, "Checkout mudou durante a prova");
const report = {
  codeSha,
  dirty,
  runtime: sdk.runtime,
  bun: process.versions.bun,
  runnerSha256: sha256(readFileSync("scripts/distribution/prove-distribution.mjs")),
  distributionPolicySha256: sha256(readFileSync("docs/licenses/DISTRIBUTION.md")),
  distributionInspectorSha256: sha256(readFileSync("scripts/lib/distribution.mjs")),
  result: "passed",
  publication:
    "accepted on #83 for the tarball hashes in docs/v1.0/evidence/83/2026-11-01; the renamed SDK on #73, in docs/v1.0/evidence/73/2026-11-03",
  artifacts: reports,
  installedFrom: fromRegistry ? "registry" : "local tarballs",
  ...(fromRegistry ? { registry } : { installedExactTarballs: true }),
  runtimeDependencies: [...runtimeDependencies].sort((a, b) => a.localeCompare(b)),
  consumer: {
    xmlCases: xml.cases.length,
    nfse: { dps: nfse.dps, signature: nfse.signature, danfseBytes: nfse.danfse.bytes },
    webhookVectors: sdk.vectors,
    exactDecimal: sdk.exactDecimal,
    contracts: { ...contracts, nodeNextDeclarations: "passed" },
  },
};
writeFileSync(join(output, reportName), JSON.stringify(report, null, 2) + "\n");
console.log(
  `Cinco tarballs inspecionados: ${reports.map((r) => r.files.length).join("/")} arquivos`,
);
