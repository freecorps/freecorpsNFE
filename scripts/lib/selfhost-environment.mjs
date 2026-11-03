import assert from "node:assert/strict";
import { PLATFORM_BACKEND_ENV } from "./worktree/env-file.mjs";

export function localEnvironment(values, frontend) {
  for (const name of values.keys())
    assert.ok(PLATFORM_BACKEND_ENV.has(name), `Variável fora do perfil local: ${name}`);
  return new Map([
    ...values,
    ["APP_ENV", "development"],
    ["PRODUCT_ENV", "sandbox"],
    ["FISCAL_ENV", "disabled"],
    ["FNFE_CRONS", "off"],
    ["EMAIL_MODE", "local"],
    ["WEBHOOK_MODE", "disabled"],
    ["SITE_URL", frontend],
  ]);
}
