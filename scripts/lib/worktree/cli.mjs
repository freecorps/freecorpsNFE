/**
 * Parsing de argumentos e texto de ajuda da CLI de worktree.
 *
 * Mora separado do `scripts/worktree.mjs` porque aquele arquivo EXECUTA ao ser
 * importado (ele é o entrypoint). Aqui é tudo função pura, então o teste
 * consegue importar sem disparar um comando.
 */
import { WorktreeError } from "./exec.mjs";

/**
 * Flags que nunca consomem o próximo token. Sem esta lista,
 * `remove feat-x --force` engoliria um argumento que não existe, e
 * `create nome --no-install` roubaria o que viesse depois.
 */
export const BOOLEAN_FLAGS = new Set([
  "delete-branch",
  "dry-run",
  "force",
  "global",
  "json",
  "keep-branch",
  "no-fetch",
  "no-install",
  "no-setup",
  "no-sweep",
  "unset-dir",
]);

/**
 * Aceita `--flag`, `--chave valor` e `--chave=valor`.
 *
 * Flag booleana sempre sai da Map como boolean de verdade, inclusive na forma
 * `--flag=valor`. Sem essa normalização, `--no-fetch=false` chegaria ao chamador
 * como a STRING "false" — truthy — e desligaria justamente o que o operador
 * mandou manter ligado, enquanto `--no-fetch=true` chegaria como "true" e
 * falharia num `=== true`. Qualquer valor que não seja `false` liga a flag, que
 * é o que `--flag` sozinho já significa.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      const key = body.slice(0, equals);
      const value = body.slice(equals + 1);
      flags.set(key, BOOLEAN_FLAGS.has(key) ? value !== "false" : value);
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags.set(body, true);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(body, true);
      continue;
    }
    flags.set(body, next);
    index += 1;
  }
  return { flags, positional };
}

/** `--flag` sem valor vira `true`, que nunca é um valor utilizável aqui. */
export function optionalString(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function optionalPort(value) {
  const raw = optionalString(value);
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isSafeInteger(port)) {
    throw new WorktreeError(`--port espera um número, recebi "${raw}".`);
  }
  return port;
}

export function usage() {
  return [
    "Uso: bun scripts/worktree.mjs <comando> [opções]",
    "",
    "Ciclo de vida (de qualquer checkout):",
    "  create <nome>   Cria o worktree, reserva as portas e faz o setup",
    "                  --from <ref>  --branch <nome>  --dir <nome>",
    "                  --into <dir>  --path <dir>     --port <n>",
    "                  --app platform  --no-setup  --no-install",
    "  list            Mostra cada worktree com porta, deployment e estado",
    "  remove <nome>   Para, remove o worktree e libera as portas",
    "                  --force  --delete-branch",
    "  prune           Remove todo worktree cuja branch já foi mergeada ou",
    "                  cuja branch remota sumiu, preservando commits não integrados",
    "                  --dry-run  --keep-branch  --no-fetch",
    "  config          Mostra onde os worktrees são criados",
    "                  --set-dir <dir>  --unset-dir  --global",
    "",
    "Dentro de um worktree:",
    "  setup           Prepara o deployment local vazio do Convex",
    "                  --app platform  --port <n>  --no-install",
    "  dev             Sobe Convex e Vite nas portas reservadas",
    "  status          Observa operação, resultado do setup e configuração (--json)",
    "  wait            Aguarda setup com prazo; não inicia nem encerra serviços",
    "                  --timeout-ms <n>  --json",
    "  sync            Reaplica ambiente, schema e funções no Convex local,",
    "                  sem inserir nem apagar dados",
    "  doctor          Valida isolamento, URLs, runtime e arquivos ignorados",
    "  mail <email>    Mostra os códigos do coletor local da plataforma",
    "  cleanup         Para os processos de dev registrados e libera o lock",
    "                  de um dev que terminou sem soltá-lo",
    "  finish          Depois do merge: confere a integração, para os processos,",
    "                  libera as portas e remove os outros worktrees integrados",
    "                  --no-sweep  --no-fetch",
    "",
    "Compatibilidade: `seed [vazio]` e `--seed vazio` equivalem a `sync`; nenhum",
    "comando cria conta, empresa, API key ou outro dado.",
  ].join("\n");
}
