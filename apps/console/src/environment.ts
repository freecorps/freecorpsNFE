/**
 * Ambiente que o build espera do backend (`VITE_PRODUCT_ENV`): `production` só no console da
 * produção fiscal, `sandbox` em todos os outros. Só serve ao selo antes da resposta do servidor;
 * nenhuma query com escopo fiscal parte dele (ver `useDeployment`).
 */
export const productEnvironmentHint: "sandbox" | "production" =
  import.meta.env.VITE_PRODUCT_ENV === "production" ? "production" : "sandbox";
/** Versão publicada do console, no título do indicador de ambiente e no rodapé das telas de conta. */
export const version = (import.meta.env.VITE_APP_SHA as string | undefined) ?? "local";
const appEnvironment = import.meta.env.VITE_APP_ENV as string | undefined;
/** Perfis que rodam na máquina de quem desenvolve ou opera: worktree e servidor próprio local. */
export function isLocalProfile(appEnv: string | undefined) {
  return appEnv === "development" || appEnv === "selfhost-local";
}
/**
 * Rótulo do perfil técnico (`VITE_APP_ENV`) ao lado do selo do ambiente, ou nenhum. O perfil
 * `installation` não tem rótulo: `scripts/selfhost.mjs build-hosted` compila com ele tanto o
 * serviço hospedado da Freecorps quanto a instalação hospedada de um operador, e o build não
 * distingue os dois. Chamar o serviço de "Instalação própria" seria falso para quem o usa. Os
 * perfis locais e o de validação existem só para quem desenvolve, opera ou valida, e o rótulo os
 * separa do serviço; outro valor também fica sem rótulo. Nunca afirma disponibilidade fiscal.
 */
export function deploymentLabelFor(appEnv: string | undefined): string | undefined {
  if (appEnv === "selfhost-local") return "Instalação própria local";
  if (appEnv === "development") return "Desenvolvimento local";
  return isValidationProfile(appEnv) ? "Ambiente de validação" : undefined;
}
/** O console de validação da Freecorps (`scripts/lib/console.mjs`) compila sem `VITE_APP_ENV`. */
export function isValidationProfile(appEnv: string | undefined) {
  return appEnv === undefined || appEnv === "";
}
export const local = isLocalProfile(appEnvironment);
export const validationProfile = isValidationProfile(appEnvironment);
export const deploymentLabel = deploymentLabelFor(appEnvironment);
