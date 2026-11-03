import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectTarball, stagePackage } from "./lib/distribution.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const coreVersion = JSON.parse(
  readFileSync(join(root, "packages/fiscal-core/package.json"), "utf8"),
).version;
const temporary = mkdtempSync(join(tmpdir(), "fnfe-xml-consumer-"));
// Use npm's JavaScript entry point, not a shell or .cmd interpolation on Windows.
const candidates = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
];
try {
  const located = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["npm"], {
    encoding: "utf8",
    windowsHide: true,
  })
    .trim()
    .split(/\r?\n/);
  for (const path of located)
    candidates.push(realpathSync(path), join(dirname(path), "node_modules/npm/bin/npm-cli.js"));
} catch {
  /* The runtime may already provide npm beside node. */
}
const npm = candidates.find((path) => path?.endsWith("npm-cli.js") && existsSync(path));
if (!npm) throw new Error("Install npm alongside Node to run the independent consumer proof.");
const run = (args, cwd) =>
  execFileSync(process.execPath, [npm, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
const artifacts = [];
for (const name of ["fiscal-core", "fiscal-nfe", "fiscal-nfse"]) {
  const staged = join(temporary, name);
  // npm applies the manifest's `files` field to the full package directory.
  const manifest = stagePackage(join(root, "packages", name), staged, {
    "@freecorps/fiscal-core": coreVersion,
  });
  const [packed] = JSON.parse(run(["pack", "--json", "--pack-destination", temporary], staged));
  artifacts.push(join(temporary, packed.filename));
  inspectTarball(join(temporary, packed.filename), manifest.name);
}
writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
run(["install", "--ignore-scripts", "--no-audit", "--no-fund", ...artifacts], temporary);
cpSync(join(root, "tests/fixtures/nfe/4.00"), join(temporary, "corpus"), { recursive: true });
cpSync(join(root, "scripts/lib/nfe-consumer.mjs"), join(temporary, "consumer.mjs"));
cpSync(join(root, "scripts/lib/nfse-consumer.mjs"), join(temporary, "nfse-consumer.mjs"));
cpSync(
  join(root, "scripts/lib/nfe-situation-proof.mjs"),
  join(temporary, "nfe-situation-proof.mjs"),
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(CONVEX_|VITE_|BETTER_AUTH_|FNFE_|CLERK_)/.test(key),
  ),
);
const consume = (file) =>
  execFileSync(process.execPath, [join(temporary, file)], {
    cwd: temporary,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
const result = consume("consumer.mjs");
const nfse = JSON.parse(consume("nfse-consumer.mjs"));
const installed = JSON.parse(run(["ls", "--all", "--json"], temporary));
function inspect(node) {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    if (
      /^(convex|better-auth|react|react-dom|wrangler|@convex-dev\/|@clerk\/|@cloudflare\/)/.test(
        name,
      )
    )
      throw new Error("SaaS dependency installed: " + name);
    inspect(child);
  }
}
inspect(installed);
const receipt = JSON.parse(result);
mkdirSync(join(root, ".ci-results/nfe"), { recursive: true });
writeFileSync(
  join(root, ".ci-results/nfe/independent.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
mkdirSync(join(root, ".ci-results/nfse"), { recursive: true });
writeFileSync(
  join(root, ".ci-results/nfse/independent.json"),
  JSON.stringify(nfse, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    result: "passed",
    runtime: receipt.runtime,
    cases: receipt.cases.length,
    nfse: { dps: nfse.dps.xsd, signature: nfse.signature.verified, danfse: nfse.danfse.bytes },
  }),
);
console.log(`Reproducible consumer retained at ${temporary}`);
