// Plugin oxlint com as regras do AGENTS.md que viraram verificação mecânica.
// Registrado em `lint.jsPlugins` do vite.config.ts; cada regra tem o seu teste
// ao lado e a sua seção em docs/desenvolvimento/lint.md.
import { definePlugin } from "vite-plus/lint/plugins";
import noFloatFiscalValues from "./rules/no-float-fiscal-values.mjs";
import noWallClockInTests from "./rules/no-wall-clock-in-tests.mjs";
import requireAccessHelperInConvexFunctions from "./rules/require-access-helper-in-convex-functions.mjs";
import requireSuppressionReason from "./rules/require-suppression-reason.mjs";

export default definePlugin({
  meta: { name: "freecorps" },
  rules: {
    "no-float-fiscal-values": noFloatFiscalValues,
    "require-access-helper-in-convex-functions": requireAccessHelperInConvexFunctions,
    "no-wall-clock-in-tests": noWallClockInTests,
    "require-suppression-reason": requireSuppressionReason,
  },
});
