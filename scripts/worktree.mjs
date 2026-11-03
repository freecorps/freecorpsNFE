/** Worktrees locais do freecorpsNFE. Origem e uso em docs/worktrees.md. */
import { optionalPort, optionalString, parseArgs, usage } from "./lib/worktree/cli.mjs";
import { currentRoot, worktreePaths } from "./lib/worktree/paths.mjs";
import { withOperation } from "./lib/worktree/operation.mjs";
import { readWorktreeStatus, waitForSetup } from "./lib/worktree/readiness.mjs";

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = parseArgs(rest);
const stateLabels = {
  idle: "nenhuma",
  unobserved: "não observado",
  running: "rodando",
  succeeded: "sucesso",
  failed: "falha",
  interrupted: "interrompido",
  indeterminate: "indeterminado",
  timeout: "prazo esgotado",
  present: "presente",
  absent: "ausente",
  invalid: "inválida",
};

try {
  if (["setup", "dev", "sync", "seed"].includes(command))
    (await import("./lib/worktree/state.mjs")).assertLinkedWorktree({ root: currentRoot });
  switch (command) {
    case "status": {
      const status = readWorktreeStatus(currentRoot);
      console.log(
        flags.get("json")
          ? JSON.stringify(status)
          : `Operação: ${stateLabels[status.operation.state]}; setup: ${stateLabels[status.setup.state]}; configuração: ${stateLabels[status.configuration.state]}.`,
      );
      break;
    }
    case "wait": {
      const timeout = flags.get("timeout-ms");
      const result = await waitForSetup(currentRoot, {
        timeoutMs:
          timeout === undefined
            ? undefined
            : typeof timeout === "string" && /^\d+$/.test(timeout)
              ? Number(timeout)
              : NaN,
      });
      console.log(
        flags.get("json")
          ? JSON.stringify(result)
          : `Espera: ${stateLabels[result.outcome]} (${result.elapsedMs} ms).`,
      );
      process.exitCode = result.outcome === "succeeded" ? 0 : result.outcome === "timeout" ? 2 : 1;
      break;
    }
    case "mail":
      await (
        await import("./lib/worktree/mail.mjs")
      ).readMailbox(worktreePaths(currentRoot), positional[0]);
      break;
    case "create":
      await (
        await import("./lib/worktree/lifecycle.mjs")
      ).create(positional[0], {
        branch: optionalString(flags.get("branch")),
        app: optionalString(flags.get("app")),
        directory: optionalString(flags.get("dir")),
        from: optionalString(flags.get("from")),
        install: flags.get("no-install") ? false : undefined,
        into: optionalString(flags.get("into")),
        path: optionalString(flags.get("path")),
        port: optionalPort(flags.get("port")),
        profile: optionalString(flags.get("seed")),
        setup: flags.get("no-setup") ? false : undefined,
      });
      break;
    case "list":
      (await import("./lib/worktree/lifecycle.mjs")).list();
      break;
    case "config":
      (await import("./lib/worktree/lifecycle.mjs")).config({
        global: flags.get("global") === true,
        setDir: optionalString(flags.get("set-dir")),
        unsetDir: flags.get("unset-dir") === true,
      });
      break;
    case "remove":
      await (
        await import("./lib/worktree/lifecycle.mjs")
      ).remove(positional[0], {
        deleteBranch: flags.get("delete-branch") === true,
        force: flags.get("force") === true,
      });
      break;
    case "prune":
      await (
        await import("./lib/worktree/lifecycle.mjs")
      ).prune({
        dryRun: flags.get("dry-run") === true,
        fetch: flags.get("no-fetch") ? false : undefined,
        keepBranch: flags.get("keep-branch") === true,
      });
      break;
    case "finish":
      await (
        await import("./lib/worktree/lifecycle.mjs")
      ).finish({
        fetch: flags.get("no-fetch") ? false : undefined,
        sweep: flags.get("no-sweep") ? false : undefined,
      });
      break;
    case "setup": {
      const { setup } = await import("./lib/worktree/session.mjs");
      await withOperation(worktreePaths(currentRoot), "setup", () =>
        setup({
          app: optionalString(flags.get("app")),
          install: flags.get("no-install") ? false : undefined,
          port: optionalPort(flags.get("port")),
          profile: optionalString(flags.get("seed")),
        }),
      );
      break;
    }
    case "dev":
      await (await import("./lib/worktree/session.mjs")).dev();
      break;
    case "seed":
      // Alias de compatibilidade: o seed nunca inseriu dados.
      (await import("./lib/worktree/sync.mjs")).assertLegacySeedProfile(
        optionalString(flags.get("seed")) ?? positional[0],
      );
      console.log("`seed` é o nome antigo de `sync`; nenhum dado é inserido.");
    // falls through
    case "sync": {
      const { syncWorktree } = await import("./lib/worktree/sync.mjs");
      await withOperation(worktreePaths(currentRoot), "sync", () =>
        syncWorktree(worktreePaths(currentRoot)),
      );
      break;
    }
    case "doctor":
      (await import("./lib/worktree/state.mjs")).doctor(worktreePaths(currentRoot));
      break;
    case "cleanup":
      await (await import("./lib/worktree/session.mjs")).cleanup();
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(usage());
      break;
    default:
      console.error(usage());
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
