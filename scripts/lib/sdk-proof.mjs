import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { sdkTarballPath } from "./sdk-artifact.mjs";

export function packageProof() {
  const report = JSON.parse(readFileSync(".ci-results/74/package.json", "utf8"));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(report.result, "passed", "Execute sdk:prove com sucesso antes do ensaio");
  assert.equal(report.dirty, false, "O pacote deve ser provado em checkout limpo");
  assert.equal(report.codeSha, head, "Execute sdk:prove para o HEAD atual");
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
    "",
    "O ensaio deve usar o mesmo checkout limpo da prova do pacote",
  );
  assert.equal(
    report.tarballSha256,
    createHash("sha256").update(readFileSync(sdkTarballPath())).digest("hex"),
    "O pacote mudou depois de sdk:prove",
  );
  return report;
}
export async function independentReceiver({ database, secrets, options }) {
  const { consumer } = packageProof();
  const { createReceiver } = await import(
    pathToFileURL(join(consumer, "sdk-webhook-receiver.mjs")).href
  );
  const { FreecorpsClient } = await import(pathToFileURL(join(consumer, "sdk-client.mjs")).href);
  let documentReads = 0;
  const receiver = createReceiver({
    database,
    secrets,
    client: {
      async call(...args) {
        documentReads++;
        return new FreecorpsClient(options()).call(...args);
      },
    },
  });
  return { ...receiver, documentReads: () => documentReads };
}
export async function proveQuickstarts({ baseUrl, apiKey, companyId, xmlPath }) {
  const { consumer } = packageProof();
  const intent = crypto.randomUUID(),
    curlIntent = crypto.randomUUID();
  async function run(example, key) {
    const stdout = await new Promise((resolve, reject) =>
      execFile(
        "node",
        ["--experimental-strip-types", example],
        {
          cwd: consumer,
          windowsHide: true,
          encoding: "utf8",
          timeout: 180_000,
          env: {
            ...process.env,
            FREECORPS_BASE_URL: baseUrl,
            FREECORPS_API_KEY: apiKey,
            FREECORPS_COMPANY_ID: companyId,
            FREECORPS_XML: xmlPath,
            FREECORPS_IDEMPOTENCY_KEY: key,
          },
        },
        (error, stdout, stderr) =>
          error
            ? reject(
                new Error(
                  `Quickstart ${example} falhou: ${stderr.replaceAll(apiKey, "[redacted]")}`,
                ),
              )
            : resolve(stdout),
      ),
    );
    return JSON.parse(stdout);
  }
  const sdk = await run("quickstart.ts", intent);
  const curl = await run("quickstart-curl.mjs", curlIntent);
  const repeated = await run("quickstart-curl.mjs", intent);
  assert.equal(sdk.documentId, curl.documentId);
  assert.equal(sdk.documentId, repeated.documentId);
  assert.equal(sdk.importId, repeated.importId);
  assert.equal(sdk.operationId, repeated.operationId);
  assert.notEqual(sdk.importId, curl.importId);
  assert.equal(sdk.total, curl.total);
  assert.deepEqual(sdk.items, curl.items);
  assert.equal(sdk.sha256, curl.sha256);
  assert.equal(sdk.resourceVersion, curl.resourceVersion);
  assert.equal(sdk.resourceVersion, repeated.resourceVersion);
  assert.equal(sdk.contractVersion, "documents/1");
  assert.ok(sdk.items.length > 0);
  return { sdk, curl, repeated, packageSha256: packageProof().tarballSha256 };
}
