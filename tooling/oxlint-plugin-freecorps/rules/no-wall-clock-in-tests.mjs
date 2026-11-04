import { defineRule } from "vite-plus/lint/plugins";
import { isTestFile, memberPath, unwrap } from "../lib/ast.mjs";

/**
 * Teste não depende do relógio real (docs/desenvolvimento/ci.md, Isolamento):
 * num arquivo sem timers falsos, `Date.now()`, `performance.now()`,
 * `new Date()` sem argumento e `setTimeout`/`setInterval` reais reprovam. Um
 * arquivo com `vi.useFakeTimers`, `vi.setSystemTime` ou `usePlatformEnvironment`
 * (que instala timers falsos) usa o relógio falso e passa. Loop de polling
 * (`while`, `do` ou `for`, inclusive `for…of` e `for…in`, com `await` de espera dentro) reprova sempre: use
 * `vi.waitFor` ou `vi.waitUntil`. Benchmarks (`*.benchmark.test.ts`) medem tempo
 * de propósito e ficam de fora.
 */
const FAKE_CLOCK = /\bvi\.(useFakeTimers|setSystemTime)\s*\(|\busePlatformEnvironment\s*\(/;
const TIMER_MODULES = new Set(["node:timers/promises", "timers/promises", "node:timers", "timers"]);
const TIMERS = new Set(["setTimeout", "setInterval"]);
const SLEEP_NAMES = /^(sleep|delay|wait|pause|nap)$/i;
const LOOPS = new Set([
  "WhileStatement",
  "DoWhileStatement",
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Proíbe relógio real e polling em testes sem timers falsos.",
      url: "docs/desenvolvimento/lint.md#no-wall-clock-in-tests",
    },
    messages: {
      clock:
        "`{{what}}` lê o relógio real. Use `vi.useFakeTimers()` com `vi.setSystemTime(...)` (ou `usePlatformEnvironment({ now })`); para um valor único, `randomUUID()`.",
      timer:
        "`{{what}}` espera tempo real. Use timers falsos (`vi.useFakeTimers()` e `vi.advanceTimersByTime`) ou `vi.waitFor`.",
      polling:
        "Loop de polling com espera real. Use `vi.waitFor(() => ...)` ou `vi.waitUntil(...)`, que limitam o tempo e explicam a falha.",
    },
    schema: [],
  },
  create(context) {
    if (!isTestFile(context.filename)) return {};
    const fake = FAKE_CLOCK.test(context.sourceCode.text);
    const timerLocals = new Set();

    const isTimerCall = (call) => {
      const callee = unwrap(call.callee);
      if (callee.type === "Identifier")
        return TIMERS.has(callee.name) || timerLocals.has(callee.name);
      const path = memberPath(callee);
      return (
        !!path &&
        path.length === 2 &&
        /^(globalThis|window|global)$/.test(path[0]) &&
        TIMERS.has(path[1])
      );
    };
    /** `await sleep(n)`, `await setTimeout(n)` de timers/promises ou `await new Promise(r => setTimeout(r, n))`. */
    const isWait = (argument) => {
      const target = unwrap(argument);
      if (target?.type === "CallExpression") {
        const callee = unwrap(target.callee);
        return (
          isTimerCall(target) || (callee.type === "Identifier" && SLEEP_NAMES.test(callee.name))
        );
      }
      if (target?.type === "NewExpression" && unwrap(target.callee).name === "Promise") {
        const executor = unwrap(target.arguments[0]);
        return (
          !!executor &&
          context.sourceCode.getText(executor).match(/\bset(Timeout|Interval)\s*\(/) !== null
        );
      }
      return false;
    };

    return {
      ImportDeclaration(node) {
        if (!TIMER_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers)
          if (specifier.type === "ImportSpecifier" && TIMERS.has(specifier.imported.name))
            timerLocals.add(specifier.local.name);
      },
      AwaitExpression(node) {
        if (!isWait(node.argument)) return;
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (/Function/.test(parent.type)) return;
          if (LOOPS.has(parent.type)) {
            context.report({ node: parent, messageId: "polling" });
            return;
          }
        }
      },
      CallExpression(node) {
        if (fake) return;
        const path = memberPath(unwrap(node.callee));
        const name = path?.join(".");
        if (name === "Date.now" || name === "performance.now")
          context.report({ node, messageId: "clock", data: { what: `${name}()` } });
        else if (isTimerCall(node))
          context.report({
            node,
            messageId: "timer",
            data: { what: context.sourceCode.getText(node.callee) },
          });
      },
      NewExpression(node) {
        if (fake || node.arguments.length) return;
        if (unwrap(node.callee).type === "Identifier" && unwrap(node.callee).name === "Date")
          context.report({ node, messageId: "clock", data: { what: "new Date()" } });
      },
    };
  },
});
