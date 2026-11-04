/// <reference types="vite/client" />

/**
 * Os módulos de platform/convex para o convex-test, sem os testes que ficam ao lado deles: um
 * teste que percorre todos os módulos executaria os outros testes. As chaves são relativas a
 * este arquivo (`../../platform/convex/<módulo>.ts`); quem substitui um módulo usa a mesma forma.
 */
export const modules = import.meta.glob([
  "../../platform/convex/**/*.ts",
  "!../../platform/convex/**/*.test.ts",
]);

/** O caminho do módulo dentro de platform/convex, sem a extensão, a partir da chave. */
export const modulePath = (key: string) =>
  key.replace("../../platform/convex/", "").replace(/\.ts$/, "");
