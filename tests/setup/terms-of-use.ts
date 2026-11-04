import { vi } from "vite-plus/test";

/**
 * Nos testes da plataforma, nenhuma versão dos termos de uso está em vigor. As organizações das
 * suítes nascem por inserção direta ou pelos `testing/*Proof`, sem o aceite que
 * `organizations.create` grava (#586), e o corte da seção 11 recusaria os comandos delas assim que
 * o relógio, real ou simulado, passasse da vigência da versão publicada. O aceite, o aviso e o
 * corte são provados em `platform/convex/termsOfUse.test.ts` e `platform/convex/termsOfUseNotice.test.ts`, que
 * trocam este módulo pelo próprio, e o arquivo publicado, em
 * `apps/console/src/terms-of-use.test.tsx`.
 */
vi.mock("../../platform/convex/lib/termsOfUseArchive", () => ({
  TERMS_OF_USE_ARCHIVE: {},
  TERMS_OF_USE_VERSION: null,
}));
