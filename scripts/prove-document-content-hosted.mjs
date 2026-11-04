import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadReadFixtures, readProof } from "./lib/document-read-proof.mjs";
import { headroomCode, headroomProof } from "./lib/document-headroom-proof.mjs";
import {
  checkHostedEnvironment,
  deniedDeployments,
  deploymentSuffix,
  failureCode,
  hostedUsage,
  parseHostedArgs,
  prepareCommands,
  previewChildEnv,
  readPreviewKey,
  resolvePreviewTarget,
  verifyPreviewEnvironment,
} from "./lib/hosted-read-proof.mjs";
import { repoRoot } from "./lib/repo-root.mjs";

if (process.argv.includes("--help")) {
  console.log(hostedUsage);
  process.exit(0);
}

const root = repoRoot;
const secrets = [];
const report = {
  version: 1,
  target: "hosted-preview",
  productionTouched: false,
  startedAt: new Date().toISOString(),
  results: [],
};
let receipt;
let failed = false;
let headroom = false;
try {
  // Everything below up to the authorization runs offline: arguments, inherited selectors,
  // receipt, fixtures and key file are refused before any network call.
  const args = parseHostedArgs(process.argv.slice(2));
  headroom = args.headroom;
  checkHostedEnvironment(process.env);
  if (args.prepare) {
    const parsed = readPreviewKey(args.keyFile, root);
    secrets.push(parsed.key);
    const commands = prepareCommands(parsed, args.keyFile, args.previewName);
    console.log(`preparando ${args.previewName}: deploy e ${commands.length - 1} variáveis`);
    for (const command of commands)
      try {
        execFileSync(process.execPath, ["node_modules/convex/bin/main.js", ...command], {
          cwd: join(root, "platform"),
          env: previewChildEnv(process.env),
          stdio: "inherit",
        });
      } catch {
        throw new Error(`PREPARE_${command[0] === "deploy" ? "DEPLOY" : "ENV"}_FAILED`);
      }
    console.log("preview preparado; rode --read e --read-node com o mesmo --preview-name");
    process.exit(0);
  }
  const receiptPath = join(
    root,
    `docs/v1.0/evidence/642/${args.headroom ? "margin-hosted" : args.node ? "read-node-hosted" : "read-hosted"}.json`,
  );
  const exists = await access(receiptPath).then(
    () => true,
    () => false,
  );
  // Receipts are never overwritten, local or hosted; preserve one under another name to repeat.
  if (exists) throw new Error("RECEIPT_EXISTS");
  report.memory = args.headroom
    ? "first-failure-size"
    : args.node
      ? "phase-samples-not-peak"
      : "unavailable";
  const fixtures = args.headroom ? null : await loadReadFixtures(args.fixtures);
  const parsed = readPreviewKey(args.keyFile, root);
  secrets.push(parsed.key);
  const clientVersion = JSON.parse(
    await readFile(join(root, "platform/node_modules/convex/package.json"), "utf8"),
  ).version;
  const target = await resolvePreviewTarget(parsed, args.previewName, {
    clientVersion,
    denied: deniedDeployments(root),
  });
  secrets.push(target.adminKey);
  report.previewName = args.previewName ?? null;
  report.deploymentSuffix = deploymentSuffix(target.deploymentName);
  console.log(
    `alvo: preview ...-${report.deploymentSuffix}${args.previewName ? ` (${args.previewName})` : ""}; dados sintéticos`,
  );
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  async function call(kind, path, callArgs = {}) {
    let result;
    try {
      const response = await fetch(`${target.url}/api/${kind}`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Convex ${target.adminKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path, args: callArgs, format: "json" }),
        signal: AbortSignal.timeout(120000),
      });
      result = await response.json();
    } catch {
      throw new Error("PROOF_CALL_FAILED");
    }
    if (result?.status !== "success" && args.headroom)
      throw new Error(headroomCode(result?.errorMessage));
    if (result?.status !== "success")
      throw new Error(
        ["BLOB_MISSING", "DOCUMENT_CONTENT_CORRUPT"].find((code) =>
          String(result?.errorMessage).includes(code),
        ) ?? "PROOF_CALL_FAILED",
      );
    return result.value;
  }
  await verifyPreviewEnvironment(call);
  // From here on the preview receives writes, so a failure still leaves a receipt.
  receipt = receiptPath;
  const safety = JSON.parse(await call("query", "coldArchive:restoreSafety"));
  assert.ok(safety.cronsOff && safety.fiscalDisabled && safety.captureDisabled, "PREVIEW_UNSAFE");
  try {
    const version = await fetch(`${target.url}/version`, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    const text = (await version.text()).trim();
    report.backendVersion = version.ok && /^[\w.+-]{1,64}$/.test(text) ? text : "unavailable";
  } catch {
    report.backendVersion = "unavailable";
  }
  if (args.headroom) {
    report.revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const verdict = await headroomProof({ call, report });
    if (!verdict.passed) throw new Error("HEADROOM_INSUFFICIENT");
  } else {
    const scope = await call("mutation", "testing/operationProof:prepare", {
      keyHash: hash(randomUUID()),
      suffix: `content642-${randomUUID()}`,
    });
    const storageId = await call("action", "testing/coldArchiveProof:store", {
      xml: "<synthetic>Prova hospedada pré-B5, sem validade fiscal</synthetic>",
    });
    await readProof({ call, scope, storageId, report, fixtures, node: args.node });
  }
} catch (error) {
  failed = true;
  report.error = failureCode(error, secrets);
}
if (receipt) {
  report.versions = { ...report.versions, backend: report.backendVersion ?? "unavailable" };
  delete report.backendVersion;
  // Bookkeeping must never lose the receipt of a preview already written to.
  try {
    report.localChanges =
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "";
  } catch {
    report.localChanges = "unavailable";
  }
  report.passed = !failed;
  report.finishedAt = new Date().toISOString();
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  try {
    report.codeHashes = Object.fromEntries(
      await Promise.all(
        [
          "scripts/prove-document-content-hosted.mjs",
          "scripts/lib/hosted-read-proof.mjs",
          "scripts/lib/document-read-proof.mjs",
          "platform/convex/testing/operationProof.ts",
          "platform/convex/testing/documentContentProof.ts",
          "platform/convex/testing/documentReadProof.ts",
          "platform/convex/testing/documentReadNodeProof.ts",
          "scripts/lib/document-headroom-proof.mjs",
          "platform/convex/testing/documentHeadroomNode.ts",
          "platform/convex/testing/documentHeadroomProof.ts",
          "platform/convex/testing/documentHeadroomValues.ts",
          "platform/convex/lib/documentContentRead.ts",
          "platform/convex/importProcessing.ts",
          "platform/convex/lib/documentContentWriter.ts",
          "platform/convex/lib/documentContent.ts",
          "tests/platform.documentReadProof.test.ts",
        ].map(async (path) => [path, hash(await readFile(join(root, path)))]),
      ),
    );
  } catch {
    report.codeHashes = "unavailable";
  }
  report.limitations = headroom
    ? [
        "Margem por tamanho da primeira falha, não pico de memória; o runtime hospedado não expõe pico",
        "Conteúdo sintético incompressível, com strings de dois bytes; pior caso do leitor",
        "Leitor modelado: arquivo inteiro, codec, todos os itens e serialização da projeção",
        "Concorrência só no limite (4 leituras simultâneas por runtime)",
        "Hashes das fontes locais; o código publicado no preview não é atestado pelo recibo",
      ]
    : [
        "Avaliação funcional pré-B5 num preview descartável, sem migração de consumidores",
        "Pico de memória indisponível; amostras Node são ocupação por fase, não teto",
        "Preparação após parser; parser exercitado apenas no convex-test",
        "Uma execução sequencial; sem concorrência, latência ou capacidade sob carga",
        "Hashes das fontes locais; o código publicado no preview não é atestado pelo recibo",
      ];
  // Only controlled fields reach the file; a last redaction guards against any echoed key.
  const text = JSON.stringify(report, null, 2) + "\n";
  assert.ok(!secrets.some((secret) => text.includes(secret)));
  await writeFile(receipt, text);
}
if (failed) console.error(report.error);
process.exitCode = failed ? 1 : 0;
