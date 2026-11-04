// Confere, só lendo, a conta Stripe da cobrança dos planos antes de ligar o catálogo ou o anual
// (BILLING.md, "Configuração"). Não escreve no Stripe nem no Convex.
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  CATALOG_PRICES,
  STRIPE_API_VERSION,
  parseArgs,
  readKey,
  report,
  usage,
} from "../lib/billing-stripe-check.mjs";

if (process.argv.includes("--help")) {
  console.log(usage);
  process.exit(0);
}

let key;
try {
  const options = parseArgs(process.argv.slice(2));
  if (!isAbsolute(options.keyFile)) throw new Error("BILLING_CHECK_KEY_FILE_NOT_ABSOLUTE");
  const credential = readKey(readFileSync(options.keyFile, "utf8"));
  key = credential.key;

  async function get(path, params) {
    let response;
    try {
      response = await fetch(`https://api.stripe.com${path}?${new URLSearchParams(params)}`, {
        headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_API_VERSION },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(`BILLING_CHECK_TRANSPORT ${path}`);
    }
    const body = await response.json().catch(() => null);
    // Só o código do erro: a mensagem do Stripe pode citar ids da conta.
    if (!response.ok)
      throw new Error(
        `BILLING_CHECK_STRIPE_${response.status} ${path} ${body?.error?.code ?? body?.error?.type ?? ""}`.trim(),
      );
    return body;
  }

  const lookup = Object.fromEntries(
    Object.keys(CATALOG_PRICES).map((name, i) => [`lookup_keys[${i}]`, name]),
  );
  const result = report({
    livemode: credential.livemode,
    endpoint: options.endpoint,
    prices: await get("/v1/prices", { ...lookup, active: "true", limit: "10" }),
    webhooks: await get("/v1/webhook_endpoints", { limit: "100" }),
    portal: await get("/v1/billing_portal/configurations", { is_default: "true", limit: "10" }),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  const message = String(error?.message ?? error);
  console.error(key ? message.replaceAll(key, "[chave]") : message);
  if (message === "BILLING_CHECK_ARGUMENTS_INVALID") console.error(usage);
  process.exit(2);
}
