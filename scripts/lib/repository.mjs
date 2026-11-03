// Repositórios do projeto. Em 03/11/2026 o repositório privado virou
// `freecorpsNFE-arquivo` e o nome `freecorpsNFE` passou ao repositório
// público novo (decisão 6 de docs/v1.0/ACCEPTANCE.md). Até a virada, os
// workflows rodam no arquivo; depois dela, no público, e o arquivo sai desta
// lista e de `LOCAL_REPOSITORY`.
export const PROJECT_REPOSITORIES = Object.freeze([
  "freecorps/freecorpsNFE",
  "freecorps/freecorpsNFE-arquivo",
]);

/** Repositório que as ferramentas consultam fora de um run do projeto. */
export const LOCAL_REPOSITORY = "freecorps/freecorpsNFE-arquivo";

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
