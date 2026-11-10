// Alvo e credencial da avaliação pré-B5 num preview Convex descartável (#642, ADR 0010).
// A chave vem só de um arquivo fora do checkout e nunca é impressa, registrada ou gravada:
// todo erro daqui sai como código controlado, e `redact` limpa o que vier de terceiros.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { serviceTokenPattern } from "./credentials.mjs";

/** Valor do marcador gravado no preview; espelha `HOSTED_READ_PROOF` de testing/operationProof.ts. */
export const HOSTED_READ_PROOF = "preview-642";
/** Variáveis do preview: o marcador, crons desligados e transporte fiscal desabilitado, nada mais. */
export const HOSTED_READ_ENVIRONMENT = Object.freeze({
  FNFE_HOSTED_PROOF: HOSTED_READ_PROOF,
  FNFE_CRONS: "off",
  FISCAL_ENV: "disabled",
});
/** Nome do preview: prefixo fixo, para nunca reaproveitar um preview de outra finalidade. */
export const previewNamePattern = /^fnfe-642-[a-z0-9][a-z0-9-]{0,39}$/;
/** Marcador do preview da prova da camada fria (#689); espelha `HOSTED_COLD_PROOF`. */
export const HOSTED_COLD_PROOF = "preview-689";
/** Variáveis sem segredo do preview da #689; o gate e o bucket entram pelo runner. */
export const HOSTED_COLD_ENVIRONMENT = Object.freeze({
  FNFE_HOSTED_PROOF: HOSTED_COLD_PROOF,
  FNFE_CRONS: "off",
  FISCAL_ENV: "disabled",
});
export const coldPreviewNamePattern = /^fnfe-689-[a-z0-9][a-z0-9-]{0,39}$/;
const deploymentNamePattern = /^[a-z]+-[a-z]+-\d{1,4}$/;
const slugPattern = /^[a-z0-9][a-z0-9-]*$/;
const secretPattern = /^[A-Za-z0-9+/=_-]{16,}$/;
const provisionHost = "https://api.convex.dev";

export class HostedProofError extends Error {}
const refuse = (code) => {
  throw new HostedProofError(code);
};

export const hostedUsage =
  "bun run content:prove-hosted --key-file <arquivo> --preview-name fnfe-642-<nome> --prepare\n" +
  "bun run content:prove-hosted --key-file <arquivo> [--preview-name fnfe-642-<nome>] (--read | --read-node) <fixtures.json>\n" +
  "--prepare cria o preview pelo CLI Convex fixado (--preview-create) e grava só as três variáveis da prova.\n" +
  "Somente preview Convex descartável com dados sintéticos (docs/v1.0/evidence/642/read-hosted.md).\n" +
  "O arquivo, fora de qualquer repositório Git, contém uma única linha CONVEX_DEPLOY_KEY=preview:...; a chave nunca é impressa.\n" +
  "Chave de preview do projeto (preview:<time>:<projeto>|...) exige --preview-name; chave do próprio\n" +
  "deployment de preview (preview:<deployment>|...) dispensa. Recusa chaves prod, dev, project e legadas.\n" +
  "Confere variáveis e crons do preview antes de escrever e grava read-hosted.json ou read-node-hosted.json\n" +
  "em docs/v1.0/evidence/642, sem sobrescrever recibos.";

/** Argumentos em ordem livre; flags desconhecidas, repetidas ou ausentes são recusadas. */
export function parseHostedArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (["--prepare", "--headroom"].includes(flag) && !Object.hasOwn(options, flag.slice(2))) {
      options[flag.slice(2)] = true;
      continue;
    }
    const name = {
      "--key-file": "keyFile",
      "--preview-name": "previewName",
      "--read": "read",
      "--read-node": "readNode",
    }[flag];
    const value = argv[index + 1];
    if (!name || Object.hasOwn(options, name) || value === undefined || value.startsWith("--"))
      refuse("HOSTED_ARGUMENTS_INVALID");
    options[name] = value;
    index++;
  }
  const modes = ["prepare", "headroom", "read", "readNode"].filter(
    (mode) => options[mode] !== undefined,
  );
  if (!options.keyFile || modes.length !== 1) refuse("HOSTED_ARGUMENTS_INVALID");
  if (options.previewName !== undefined && !previewNamePattern.test(options.previewName))
    refuse("PREVIEW_NAME_INVALID");
  if (options.prepare && options.previewName === undefined) refuse("PREVIEW_NAME_REQUIRED");
  return {
    keyFile: options.keyFile,
    previewName: options.previewName,
    prepare: options.prepare === true,
    headroom: options.headroom === true,
    node: options.readNode !== undefined,
    fixtures: options.readNode ?? options.read,
  };
}

/**
 * Comandos do CLI Convex fixado em platform/, na ordem: cria (ou recria) o preview nomeado e grava
 * as três variáveis da prova nele. A chave chega ao CLI só por `--env-file`, e cada comando nomeia
 * o preview: sem `--preview-name`, `env set` agiria sobre o dev pessoal de quem tem login.
 */
export function prepareCommands(
  parsed,
  keyFile,
  previewName,
  { environment = HOSTED_READ_ENVIRONMENT, namePattern = previewNamePattern } = {},
) {
  if (parsed.kind !== "project") refuse("PROJECT_PREVIEW_KEY_REQUIRED");
  if (!namePattern.test(previewName ?? "")) refuse("PREVIEW_NAME_REQUIRED");
  return [
    [
      "deploy",
      "--env-file",
      keyFile,
      "--preview-create",
      previewName,
      "--typecheck",
      "disable",
      "--codegen",
      "disable",
      "--yes",
    ],
    ...Object.entries(environment).map(([name, value]) => [
      "env",
      "set",
      "--env-file",
      keyFile,
      "--preview-name",
      previewName,
      name,
      value,
    ]),
  ];
}

/** Ambiente do CLI sem credenciais ou seletores herdados, como `validationChildEnv`. */
export function previewChildEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !/^(CLOUDFLARE_|MAIL_|ACCOUNT_|AUTH_PROXY_|CONVEX_|VALIDATION_|FNFE_|VITE_|CLERK_|RESEND_|BETTER_AUTH_|NODE_OPTIONS$)/i.test(
          name,
        ),
    ),
  );
}

/** Recusa credenciais e seletores herdados do terminal; a chave vem só do arquivo. */
export function checkHostedEnvironment(env) {
  for (const name of [
    "CONVEX_DEPLOY_KEY",
    "CONVEX_DEPLOYMENT",
    "CONVEX_SELF_HOSTED_URL",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
    "CONVEX_PROVISION_HOST",
  ])
    if (env[name]) refuse("INHERITED_CONVEX_SELECTOR");
}

/**
 * Lê `CONVEX_DEPLOY_KEY=<chave>` (o formato que `convex --env-file` aceita) de um arquivo fora
 * do checkout. Só chaves de preview: a do projeto (`preview:<time>:<projeto>|`) ou a de um
 * deployment de preview (`preview:<deployment>|`).
 */
export function readPreviewKey(keyFile, root) {
  if (typeof keyFile !== "string" || !isAbsolute(keyFile)) refuse("KEY_FILE_NOT_ABSOLUTE");
  let real;
  let text;
  try {
    real = realpathSync(keyFile);
    if (!statSync(real).isFile() || statSync(real).size > 4096) refuse("KEY_FILE_INVALID");
    text = readFileSync(real, "utf8");
  } catch (error) {
    if (error instanceof HostedProofError) throw error;
    refuse("KEY_FILE_UNREADABLE");
  }
  const inside = relative(realpathSync(root), real);
  if (!inside.startsWith("..") && !isAbsolute(inside)) refuse("KEY_FILE_INSIDE_CHECKOUT");
  // Nor inside any other Git working tree (`.git` is a folder, or a file in a worktree), where a
  // later `git add` could version it.
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) refuse("KEY_FILE_INSIDE_GIT");
    if (dirname(dir) === dir) break;
  }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  while (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const match = lines.length === 1 ? /^CONVEX_DEPLOY_KEY=(\S+)$/.exec(lines[0]) : null;
  if (!match) refuse("KEY_FILE_FORMAT");
  return parsePreviewKey(match[1]);
}

export function parsePreviewKey(key) {
  const separator = key.indexOf("|");
  const prefix = separator > 0 ? key.slice(0, separator) : "";
  const secret = separator > 0 ? key.slice(separator + 1) : "";
  const parts = prefix.split(":");
  if (parts[0] !== "preview" || !secretPattern.test(secret)) refuse("PREVIEW_KEY_REQUIRED");
  if (parts.length === 3 && slugPattern.test(parts[1]) && slugPattern.test(parts[2]))
    return { kind: "project", key, teamSlug: parts[1], projectSlug: parts[2] };
  if (parts.length === 2 && deploymentNamePattern.test(parts[1]))
    return { kind: "deployment", key, deploymentName: parts[1] };
  return refuse("PREVIEW_KEY_REQUIRED");
}

/** Nomes que nunca são alvo: validação, produção e a produção fiscal da emissão. */
export function deniedDeployments(root) {
  const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
  return [
    read("platform/validation.json").deploymentName,
    read("deploy/platform-release.json").target?.deployment,
    read("deploy/issuance-production.json").deployment,
  ].filter((name) => typeof name === "string");
}

/**
 * `projectKey`: the Convex API answers `authorize_preview` with the project preview key itself as
 * the admin key (seen on 01/11/2026), not a key of the deployment; the URL names the preview.
 */
function checkTarget({ deploymentName, url, adminKey }, denied, projectKey) {
  if (
    typeof deploymentName !== "string" ||
    !deploymentNamePattern.test(deploymentName) ||
    denied.includes(deploymentName) ||
    url !== `https://${deploymentName}.convex.cloud` ||
    typeof adminKey !== "string" ||
    !(adminKey.startsWith(`preview:${deploymentName}|`) || adminKey === projectKey)
  )
    refuse("PREVIEW_TARGET_INVALID");
  return { deploymentName, url, adminKey };
}

/**
 * Endereço e chave administrativa do preview. A chave de um deployment de preview já nomeia o
 * alvo; a do projeto é trocada, como o CLI faz em `--preview-name`, pela chave do preview
 * nomeado, e a resposta precisa ser um preview com URL e chave do mesmo deployment.
 */
export async function resolvePreviewTarget(
  parsed,
  previewName,
  { fetchImpl = fetch, clientVersion, denied },
) {
  if (parsed.kind === "deployment") {
    if (previewName !== undefined) refuse("PREVIEW_NAME_UNEXPECTED");
    return checkTarget(
      {
        deploymentName: parsed.deploymentName,
        url: `https://${parsed.deploymentName}.convex.cloud`,
        adminKey: parsed.key,
      },
      denied,
    );
  }
  if (previewName === undefined) refuse("PREVIEW_NAME_REQUIRED");
  let body;
  try {
    const response = await fetchImpl(`${provisionHost}/api/deployment/authorize_preview`, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${parsed.key}`,
        "Convex-Client": `npm-cli-${clientVersion}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        previewName,
        projectSelection: {
          kind: "teamAndProjectSlugs",
          teamSlug: parsed.teamSlug,
          projectSlug: parsed.projectSlug,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) refuse("PREVIEW_AUTHORIZATION_FAILED");
    body = await response.json();
  } catch (error) {
    if (error instanceof HostedProofError) throw error;
    refuse("PREVIEW_AUTHORIZATION_FAILED");
  }
  if (body?.deploymentType !== "preview") refuse("PREVIEW_TARGET_INVALID");
  return checkTarget(body, denied, parsed.key);
}

/**
 * O preview tem exatamente as variáveis da prova e nenhum cron registrado. `environment` é a
 * lista exata; a da #689 inclui os valores do bucket, comparados em memória e nunca impressos.
 */
export async function verifyPreviewEnvironment(call, environment = HOSTED_READ_ENVIRONMENT) {
  const variables = await call("query", "_system/cli/queryEnvironmentVariables");
  const actual = Object.fromEntries(variables.map(({ name, value }) => [name, value]));
  const expected = Object.entries(environment);
  // Only names leave this function, never values: the operator removes them by name.
  const wrong = [
    ...Object.keys(actual).filter((name) => !Object.hasOwn(environment, name)),
    ...expected.filter(([name, value]) => actual[name] !== value).map(([name]) => name),
  ];
  if (wrong.length)
    refuse(
      `PREVIEW_ENVIRONMENT_INVALID ${wrong
        .map((name) => (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? name : "?"))
        .sort()
        .join(",")}`,
    );
  if ((await call("query", "_system/frontend/listCronJobs")).length !== 0)
    refuse("PREVIEW_CRONS_PRESENT");
}

/** Somente o sufixo numérico do deployment vai para o recibo. */
export const deploymentSuffix = (deploymentName) => deploymentName.split("-").at(-1);

const keyLike = /\b(?:prod|dev|preview|project)(?::[A-Za-z0-9_-]+)*\|[^\s"'`,;)]+/g;
/** Remove segredos conhecidos e qualquer valor com forma de chave Convex ou token de serviço. */
export function redact(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets)
    if (typeof secret === "string" && secret) result = result.split(secret).join("[redigido]");
  return result
    .replace(keyLike, "[redigido]")
    .replace(new RegExp(serviceTokenPattern.source, "g"), "[redigido]");
}

/** Mensagem pública de uma falha: só códigos controlados passam, o resto vira um código fixo. */
export function failureCode(error, secrets = []) {
  const code =
    error instanceof HostedProofError || /^[A-Z][A-Z0-9_]+$/.test(String(error?.message))
      ? error.message
      : "HOSTED_PROOF_FAILED";
  return redact(code, secrets);
}
