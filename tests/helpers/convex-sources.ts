/// <reference types="vite/client" />

/**
 * O texto de cada módulo de platform/convex, sem os testes que ficam ao lado deles. Separado de
 * convex-modules.ts porque carrega tudo na importação. As chaves são relativas a este arquivo.
 */
export const sources = import.meta.glob<string>(
  ["../../platform/convex/**/*.ts", "!../../platform/convex/**/*.test.ts"],
  { query: "?raw", import: "default", eager: true },
);
