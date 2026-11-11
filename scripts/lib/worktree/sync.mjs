import { worktreeConvexPorts, worktreeSiteUrl } from "../worktree-local.ts";
import {
  localPortArgs,
  runConvexStreaming,
  startBackendForSetup,
  stopWorktreeBackends,
  syncBackendEnvironment,
} from "./convex-local.mjs";
import { readLocalConfig } from "./deployment.mjs";
import { currentLocalSiteUrl, ensureBackendEnvFile, writeRuntimeEnv } from "./env-file.mjs";
import { commandResult, fail, stopWorktreeNodeExecutors } from "./exec.mjs";
import { stopRecordedProcesses } from "./process-identity.mjs";
import { bunExecutable } from "./paths.mjs";
import { resolveConvexPort, resolveFrontendPort } from "./registry.mjs";
import { assertLinkedWorktree, assertPlatformWorktree, devIsRunning } from "./state.mjs";

/**
 * Único valor do antigo `--seed` e de `seed [perfil]`. Continua aceito para
 * quem ainda chama `worktree seed vazio`; nenhum outro perfil existe.
 */
export const LEGACY_SEED_PROFILE = "vazio";

export function assertLegacySeedProfile(value) {
  if (value === undefined || value === null || value === "" || value === LEGACY_SEED_PROFILE)
    return;
  fail(
    `Perfil de seed desconhecido: "${value}". O worktree não semeia dados; use bun run worktree sync.`,
  );
}

/**
 * Sincroniza o backend local com o checkout: variáveis de ambiente, schema e
 * funções. Não insere nem apaga dados.
 */
export async function syncWorktree(paths, options = {}) {
  assertLinkedWorktree(paths);
  assertPlatformWorktree(paths);
  if (devIsRunning(paths)) fail("Pare o dev com worktree:cleanup antes de publicar novamente.");
  commandResult(bunExecutable, ["run", "packages:build"], { cwd: paths.root });
  const config = readLocalConfig(paths);
  if (!config) fail("Rode bun run worktree:setup primeiro.");
  // Sem dev rodando, um backend no banco deste worktree é sobra de um comando
  // anterior e seguraria a porta reservada.
  await stopWorktreeBackends(paths);
  const siteUrl =
    options.siteUrl ??
    currentLocalSiteUrl(paths) ??
    worktreeSiteUrl(await resolveFrontendPort(paths.root));
  const ports = worktreeConvexPorts(
    await resolveConvexPort(paths.root, { preferred: config.ports.cloud }),
  );
  ensureBackendEnvFile(paths, siteUrl);
  writeRuntimeEnv(paths, config, siteUrl);
  let backend;
  try {
    backend = await startBackendForSetup(paths, ports);
    syncBackendEnvironment(paths);
  } finally {
    if (backend) await stopRecordedProcesses(backend.processRecord);
    // O CLI pode ter reaproveitado um backend que não está no grupo dele.
    await stopWorktreeBackends(paths);
  }
  try {
    const result = await runConvexStreaming(paths, [
      "dev",
      "--once",
      "--env-file",
      paths.runtimeEnv,
      "--typecheck",
      "disable",
      ...localPortArgs(ports),
    ]);
    if (result.code !== 0) fail("Falhou o push do schema e funções locais.");
    const latest = readLocalConfig(paths);
    if (!latest || latest.ports.cloud !== ports.cloud || latest.ports.site !== ports.site)
      fail("O Convex mudou as portas reservadas.");
    writeRuntimeEnv(paths, latest, siteUrl);
  } finally {
    await stopWorktreeBackends(paths);
    stopWorktreeNodeExecutors(paths.nodeExecutable);
  }
}
