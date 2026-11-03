// O entrypoint do CLI do Convex 1.48 chama process.exit() depois de --skip-push.
// No Windows isso pode derrubar o backend antes de a configuração do ambiente
// terminar. Só o spawn privado do bootstrap carrega este módulo; saídas de erro
// continuam encerrando normalmente.
if (!process.argv.includes("--skip-push")) throw new Error("BOOTSTRAP_ONLY");
const exit = process.exit.bind(process);
process.exit = (code) => {
  const status = Number(code ?? process.exitCode ?? 0);
  if (status !== 0) return exit(status);
  // O ChildProcess do backend mantém o event loop vivo. Se ele sair, o CLI sai
  // naturalmente, e waitForBackend rejeita em vez de inventar prontidão.
};
