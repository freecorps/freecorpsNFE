// Repositório do projeto. Desde a virada de 03/11/2026 (decisão 6 de
// docs/v1.0/ACCEPTANCE.md), os workflows rodam só no repositório público
// `freecorps/freecorpsNFE`; o histórico anterior fica no repositório
// arquivado `freecorps/freecorpsNFE-arquivo`, que não é mais origem aceita.
export const PROJECT_REPOSITORIES = Object.freeze(["freecorps/freecorpsNFE"]);

/** Repositório que as ferramentas consultam fora de um run do projeto. */
export const LOCAL_REPOSITORY = "freecorps/freecorpsNFE";

/** @param {unknown} name */
export function isProjectRepository(name) {
  return typeof name === "string" && PROJECT_REPOSITORIES.includes(name);
}

/**
 * O repositório do run em curso, quando é do projeto; senão, o local. As
 * conferências de origem do run continuam com `isProjectRepository`.
 * @param {Record<string, string | undefined>} [env]
 */
export function projectRepository(env = process.env) {
  return isProjectRepository(env.GITHUB_REPOSITORY) ? env.GITHUB_REPOSITORY : LOCAL_REPOSITORY;
}
