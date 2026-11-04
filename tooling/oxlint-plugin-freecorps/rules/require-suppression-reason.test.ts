import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import rule from "./require-suppression-reason.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const ts = (code: string) => ({ code, filename: "apps/console/src/example.test.ts" });

new RuleTester().run("require-suppression-reason", rule, {
  valid: [
    ts(`// eslint-disable-next-line react-hooks/exhaustive-deps -- roda só na montagem, de propósito
      useEffect(() => load(), []);`),
    ts(`// oxlint-disable-next-line no-control-regex -- controles são justamente o alvo
      const re = /[\\x00-\\x1f]/;`),
    ts(`/* eslint-disable no-console -- script de linha de comando, a saída é o console */`),
    ts(`// eslint-enable no-console`),
    ts(`// Comentário comum que cita eslint-disable no meio do texto.`),
    ts(`// quarantine: #123 instável no Windows até trocar o lock de arquivo
      it.skip("trava", () => {});`),
    ts(`describe("x", () => {
      // quarantine: #45 depende do fisco de homologação, fora do ar
      describe.skip("homologação", () => {});
    });`),
    // Condição explícita já diz quando não roda.
    ts(`it.skipIf(process.platform === "win32")("sinais POSIX", () => {});`),
    ts(`it.runIf(hasAge)("decifra", () => {});`),
  ],
  invalid: [
    {
      ...ts(`// eslint-disable-next-line react-hooks/exhaustive-deps\nuseEffect(() => {}, []);`),
      errors: [{ messageId: "directive" }],
    },
    {
      ...ts(`// oxlint-disable-next-line no-control-regex -- curto\nconst re = 1;`),
      errors: [{ messageId: "directive" }],
    },
    { ...ts(`/* eslint-disable */`), errors: [{ messageId: "directive" }] },
    {
      ...ts(`const a = 1; // oxlint-disable-line no-unused-vars`),
      errors: [{ messageId: "directive" }],
    },
    { ...ts(`it.skip("trava", () => {});`), errors: [{ messageId: "skip" }] },
    { ...ts(`test.todo("falta escrever");`), errors: [{ messageId: "skip" }] },
    {
      ...ts(`// sem issue: instável no Windows\ndescribe.skip("x", () => {});`),
      errors: [{ messageId: "skip" }],
    },
    { ...ts(`// quarantine: #12 curto\nit.skip("x", () => {});`), errors: [{ messageId: "skip" }] },
    {
      ...ts(
        `// quarantine: #7 aguardando correção do runner do Windows\nconst x = 1;\nit.skip.each([1])("x %s", () => {});`,
      ),
      errors: [{ messageId: "skip" }],
    },
  ],
});
