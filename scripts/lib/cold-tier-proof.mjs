// Real-path proof of the cold tier (#689, ADR 0010, phases C and C2): the shared, offline part of
// `prove-cold-tier-hosted.mjs` and `prove-cold-rehydration-local.mjs`. The R2 credentials come
// only from files outside every Git tree, are never printed, and reach a deployment only through
// its admin API in the body of one request. Every object these runners write or delete is under
// the Sandbox prefix of a proof organization or under `proof-689/`.
import { execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { HostedProofError, coldPreviewNamePattern } from "./hosted-read-proof.mjs";

export const COLD_ACCOUNT = "ceccd1846b474bb179054a3c2c4a6185";
export const COLD_BUCKET = "freecorpsnfe-cold-documents";
export const COLD_ENDPOINT = `https://${COLD_ACCOUNT}.r2.cloudflarestorage.com`;
/** Where the C2 proof keeps the ADR 0009 package; a prefix of its own, with no lock rule. */
export const PACKAGE_PREFIX = "proof-689/cold/";

const refuse = (code) => {
  throw new HostedProofError(code);
};

export const coldHostedUsage =
  "bun run cold:prove-hosted --key-file <arquivo> --preview-name fnfe-689-<nome> --prepare\n" +
  "bun run cold:prove-hosted --key-file <arquivo> --preview-name fnfe-689-<nome> --r2-key-id-file <arquivo> --r2-secret-file <arquivo> --run\n" +
  "--prepare cria o preview pelo CLI Convex fixado e grava as três variáveis do perfil de prova (marcador preview-689).\n" +
  "--run grava o gate e o bucket frio no preview pela API administrativa, confere a lista exata de variáveis e,\n" +
  "com dados Sandbox sintéticos, prova a passagem, a leitura, o expurgo, o órfão e o reconhecimento pelo backup\n" +
  "contra o bucket real. No fim apaga os objetos da organização sintética e retira gate e bucket do preview.\n" +
  "Chave de preview do projeto em arquivo (CONVEX_DEPLOY_KEY=preview:...); credenciais R2 em arquivos de uma linha,\n" +
  "fora de qualquer repositório Git. Nada disso é impresso. Grava docs/v1.0/evidence/689/receipts/hosted.json.";

export const coldLocalUsage =
  "bun run cold:prove-rehydration --port <porta> --r2-key-id-file <arquivo> --r2-secret-file <arquivo>\n" +
  "Só no Convex local deste worktree (bun run dev aberto, porta conferida com a configuração local).\n" +
  "Liga FNFE_COLD_ARCHIVE e a camada fria com o bucket real, arquiva uma organização sintética (ADR 0009) com o\n" +
  "pacote em proof-689/cold/ e a reidrata (ADR 0010, C2), interrompendo a etapa fria uma vez. No fim apaga os\n" +
  "objetos criados e retira as variáveis. Grava docs/v1.0/evidence/689/receipts/local.json.";

/** Arguments in any order; unknown, repeated or missing flags are refused. */
export function parseColdArgs(argv, { local = false } = {}) {
  const options = {};
  const flags = local
    ? { "--port": "port", "--r2-key-id-file": "keyIdFile", "--r2-secret-file": "secretFile" }
    : {
        "--key-file": "keyFile",
        "--preview-name": "previewName",
        "--r2-key-id-file": "keyIdFile",
        "--r2-secret-file": "secretFile",
      };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!local && ["--prepare", "--run"].includes(flag) && !Object.hasOwn(options, flag.slice(2))) {
      options[flag.slice(2)] = true;
      continue;
    }
    const name = flags[flag];
    const value = argv[index + 1];
    if (!name || Object.hasOwn(options, name) || value === undefined || value.startsWith("--"))
      refuse("COLD_ARGUMENTS_INVALID");
    options[name] = value;
    index++;
  }
  if (local) {
    const port = Number(options.port);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || !/^\d+$/.test(options.port))
      refuse("COLD_ARGUMENTS_INVALID");
    if (!options.keyIdFile || !options.secretFile) refuse("COLD_ARGUMENTS_INVALID");
    return { port, keyIdFile: options.keyIdFile, secretFile: options.secretFile };
  }
  if (!options.keyFile || options.prepare === options.run) refuse("COLD_ARGUMENTS_INVALID");
  if (!coldPreviewNamePattern.test(options.previewName ?? "")) refuse("PREVIEW_NAME_INVALID");
  if (options.run && (!options.keyIdFile || !options.secretFile)) refuse("COLD_ARGUMENTS_INVALID");
  if (options.prepare && (options.keyIdFile || options.secretFile))
    refuse("COLD_ARGUMENTS_INVALID");
  return {
    keyFile: options.keyFile,
    previewName: options.previewName,
    prepare: options.prepare === true,
    keyIdFile: options.keyIdFile,
    secretFile: options.secretFile,
  };
}

/** One-line secret from a file outside the checkout and outside any Git tree, in its shape. */
export function readSecretLine(file, root, pattern) {
  if (typeof file !== "string" || !isAbsolute(file)) refuse("R2_FILE_NOT_ABSOLUTE");
  let real;
  let text;
  try {
    real = realpathSync(file);
    if (!statSync(real).isFile() || statSync(real).size > 1024) refuse("R2_FILE_INVALID");
    text = readFileSync(real, "utf8");
  } catch (error) {
    if (error instanceof HostedProofError) throw error;
    refuse("R2_FILE_UNREADABLE");
  }
  const inside = relative(realpathSync(root), real);
  if (!inside.startsWith("..") && !isAbsolute(inside)) refuse("R2_FILE_INSIDE_CHECKOUT");
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) refuse("R2_FILE_INSIDE_GIT");
    if (dirname(dir) === dir) break;
  }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  while (lines.length > 1 && lines.at(-1) === "") lines.pop();
  if (lines.length !== 1 || !pattern.test(lines[0])) refuse("R2_FILE_FORMAT");
  return lines[0];
}

/** The R2 token of the cold bucket: Access Key ID (32 hex) and Secret Access Key (64 hex). */
export function readR2Credentials({ keyIdFile, secretFile }, root) {
  return {
    accessKeyId: readSecretLine(keyIdFile, root, /^[a-f0-9]{32}$/),
    secretAccessKey: readSecretLine(secretFile, root, /^[a-f0-9]{64}$/),
  };
}

/** The cold tier's gate and bucket, as the deployment reads them (`lib/coldObjects.ts`). */
export function coldVariables(credentials) {
  return {
    FNFE_COLD_TIER: "enabled",
    FNFE_COLD_R2_ENDPOINT: COLD_ENDPOINT,
    FNFE_COLD_R2_BUCKET: COLD_BUCKET,
    FNFE_COLD_R2_ACCESS_KEY_ID: credentials.accessKeyId,
    FNFE_COLD_R2_SECRET_ACCESS_KEY: credentials.secretAccessKey,
  };
}

/**
 * Sets (or, with `null`, removes) variables through the deployment's admin API, the request
 * `convex env set` makes, so no value ever reaches a command line. Only the status leaves.
 */
export async function updateVariables(url, adminKey, variables, fetchImpl = fetch) {
  const changes = Object.entries(variables).map(([name, value]) => ({ name, value }));
  let response;
  try {
    response = await fetchImpl(`${url}/api/update_environment_variables`, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Convex ${adminKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ changes }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    refuse("ENV_UPDATE_FAILED");
  }
  if (!response.ok) refuse("ENV_UPDATE_FAILED");
}

/** A key this proof may delete: the Sandbox prefix of its organization, or the package prefix. */
export function proofKey(key, organizationIds) {
  return (
    typeof key === "string" &&
    !key.includes("..") &&
    (key.startsWith(PACKAGE_PREFIX) ||
      organizationIds.some(
        (id) => /^[A-Za-z0-9]+$/.test(id) && key.startsWith(`documents/sandbox/${id}/`),
      ))
  );
}

/**
 * Deletes every object under each prefix and lists it again; returns what is left per prefix.
 * Refuses, before deleting anything, a prefix outside the proof's own.
 */
export async function clearPrefixes(client, prefixes, organizationIds) {
  for (const prefix of prefixes)
    if (!prefix.endsWith("/") || !proofKey(prefix, organizationIds)) refuse("CLEANUP_PREFIX");
  const left = {};
  for (const prefix of prefixes) {
    for (const key of await client.list(prefix)) {
      if (!proofKey(key, organizationIds)) refuse("CLEANUP_PREFIX");
      await client.delete(key);
    }
    left[prefix] = (await client.list(prefix)).length;
  }
  return left;
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A key as the receipt shows it: IDs and hashes replaced by their shape. */
export function keyShape(key) {
  return key
    .replace(/^documents\/sandbox\/[A-Za-z0-9]+\//, "documents/sandbox/<org>/")
    .replace(/\/[A-Za-z0-9]+\/(content|original)-[a-f0-9]{64}\.gz$/, "/<id>/$1-<sha256>.gz");
}

/** The object as the bucket holds it, read back whole: its SHA-256 and size. */
export async function objectDigest(client, key) {
  const bytes = await client.get(key);
  return { sha256: sha256(bytes), bytes: bytes.length };
}

/** Polls `check` until it returns a truthy value, at most `attempts` times. */
export async function waitFor(
  check,
  { attempts = 120, delay = 2000, code = "PROOF_TIMEOUT" } = {},
) {
  for (let i = 0; i < attempts; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return refuse(code);
}

/** The XML original every proof note stores, and the test that parses it for the seed. */
export const PROOF_XML = "tests/fixtures/nfe/4.00/invoice-authorized.xml";
const FIXTURE_TEST = "platform/convex/testing/coldTierProof.test.ts";

/**
 * The parsed content of `PROOF_XML` ({ result, items }), as the real import stores it: the
 * fixture test runs that import under convex-test and writes it out (`FNFE_COLD_FIXTURE`).
 */
export function parsedFixture(root) {
  const dir = mkdtempSync(join(tmpdir(), "fnfe-689-fixture-"));
  try {
    const file = join(dir, "fixture.json");
    try {
      execFileSync(
        process.execPath,
        [join(root, "node_modules/vite-plus/bin/vp"), "test", "run", FIXTURE_TEST],
        {
          cwd: root,
          env: { ...process.env, FNFE_COLD_FIXTURE: file, VITEST_MAX_WORKERS: "2" },
          stdio: "ignore",
        },
      );
    } catch {
      refuse("FIXTURE_TEST_FAILED");
    }
    const fixture = JSON.parse(readFileSync(file, "utf8"));
    if (typeof fixture?.result !== "string" || !Array.isArray(fixture.items))
      refuse("FIXTURE_INVALID");
    return { result: fixture.result, items: fixture.items };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fresh 44-digit access key of model 55 (positions 21-22), unique per proof note. */
export const proofFiscalKey = () => {
  const digits = (n) => Array.from({ length: n }, () => randomInt(10)).join("");
  return `${digits(20)}55${digits(22)}`;
};
