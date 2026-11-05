import { spawnSync } from "node:child_process";

type Env = Record<string, string | undefined>;

/** Os binários do age dos testes de cifra: `AGE_BIN` e `AGE_KEYGEN_BIN`, ou os do PATH. */
export function ageBinaries(env: Env = process.env) {
  return { age: env.AGE_BIN || "age", keygen: env.AGE_KEYGEN_BIN || "age-keygen" };
}

/**
 * Diz se os testes que cifram e decifram com o age real podem rodar. Fora do CI,
 * sem o binário, eles ficam pendentes. Com `CI=true` a falta lança e reprova o
 * arquivo de teste inteiro: o `validate` do ci.yml instala o age fixado no PATH,
 * e uma área não pode aprovar com a prova da cifra pulada (issue #109).
 */
export function hasAge(env: Env = process.env, run: typeof spawnSync = spawnSync): boolean {
  const missing = Object.values(ageBinaries(env)).filter(
    (bin) => run(bin, ["--version"], { windowsHide: true }).status !== 0,
  );
  if (missing.length === 0) return true;
  if (env.CI === "true")
    throw new Error(
      `CI=true sem o age (${missing.join(", ")}): os testes de cifra não podem ser pulados; ` +
        "instale o binário fixado como no passo Install pinned age do ci.yml",
    );
  return false;
}
