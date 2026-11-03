// Conferência só de leitura da conta Stripe da cobrança dos planos (BILLING.md, "Configuração").
// Espelha as regras de platform/convex/lib/billingStripe.ts; o teste
// scripts/billing-stripe-check.test.ts confere que as duas não se afastam.

export const STRIPE_API_VERSION = "2025-03-31.basil";
export const DEFAULT_ENDPOINT = "https://api.nfe.freecorps.com.br/v1/billing/stripe/events";

/** Lookup key, intervalo e valor em centavos de cada preço do catálogo. */
export const CATALOG_PRICES = {
  fnfe_plan_intermediate_monthly_brl: { interval: "month", cents: 14900 },
  fnfe_plan_large_monthly_brl: { interval: "month", cents: 49900 },
  fnfe_plan_intermediate_annual_brl: { interval: "year", cents: 149000 },
  fnfe_plan_large_annual_brl: { interval: "year", cents: 499000 },
};

export const BILLING_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
];

/** O que a API não expõe e uma pessoa confere no painel antes de ligar. */
export const MANUAL_ITEMS = [
  "Smart Retries ligados, cancelando a assinatura depois da última tentativa, dentro do mês",
  "Pix não habilitado nos métodos de pagamento do Stripe",
  "E-mails de fatura e de recibo do Stripe conforme a política decidida",
];

export const usage =
  "uso: node scripts/check-billing-stripe.mjs --key-file <arquivo absoluto> [--endpoint <url>]\n" +
  "A chave (sk_ ou rk_, test ou live) precisa de leitura em Prices, Webhook Endpoints e\n" +
  "Customer portal. Nada é escrito no Stripe; a saída não traz chaves nem ids da conta.";

export function parseArgs(argv) {
  const options = { endpoint: DEFAULT_ENDPOINT };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = argv[i + 1];
    if ((name !== "--key-file" && name !== "--endpoint") || !value || value.startsWith("--"))
      throw new Error("BILLING_CHECK_ARGUMENTS_INVALID");
    options[name === "--key-file" ? "keyFile" : "endpoint"] = value;
    i++;
  }
  if (!options.keyFile) throw new Error("BILLING_CHECK_ARGUMENTS_INVALID");
  if (!/^https:\/\/[^/]+\/v1\/billing\/stripe\/events$/.test(options.endpoint))
    throw new Error("BILLING_CHECK_ENDPOINT_INVALID");
  return options;
}

/** Modo da chave lida do arquivo. Recusa qualquer outra coisa sem ecoar o conteúdo. */
export function readKey(text) {
  const key = String(text).trim();
  const match = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.exec(key);
  if (!match) throw new Error("BILLING_CHECK_KEY_INVALID");
  return { key, livemode: match[1] === "live" };
}

const items = (body) => (Array.isArray(body?.data) ? body.data : []);
const result = (name, problems) => ({ name, ok: problems.length === 0, problems });

/** Os quatro preços com as lookup keys, ativos, em BRL, licenciados e no valor do catálogo. */
export function checkPrices(body, livemode) {
  const problems = [];
  for (const [key, expected] of Object.entries(CATALOG_PRICES)) {
    const matches = items(body).filter((price) => price?.lookup_key === key);
    if (matches.length === 0) {
      problems.push(`${key}: ausente`);
      continue;
    }
    const price = matches[0];
    const recurring = price.recurring ?? {};
    const wrong = [
      price.active !== true && "inativo",
      price.livemode !== livemode && "outro modo",
      price.currency !== "brl" && "moeda",
      price.type !== "recurring" && "não recorrente",
      price.unit_amount !== expected.cents && "valor",
      recurring.interval !== expected.interval && "intervalo",
      recurring.interval_count !== 1 && "contagem do intervalo",
      recurring.usage_type !== undefined && recurring.usage_type !== "licensed" && "uso medido",
    ].filter(Boolean);
    if (wrong.length) problems.push(`${key}: ${wrong.join(", ")}`);
  }
  return result("preços do catálogo", problems);
}

/** Um único endpoint na URL da plataforma, ativo, no modo da chave e com todos os eventos. */
export function checkWebhook(body, endpoint, livemode) {
  const matches = items(body).filter((item) => item?.url === endpoint);
  if (matches.length === 0) return result("endpoint de eventos", ["nenhum endpoint na URL"]);
  // Dois endpoints na mesma URL têm segredos diferentes: um deles sempre recebe 400.
  if (matches.length > 1) return result("endpoint de eventos", ["mais de um endpoint na URL"]);
  const [hook] = matches;
  const events = Array.isArray(hook.enabled_events) ? hook.enabled_events : [];
  const missing = events.includes("*") ? [] : BILLING_EVENTS.filter((e) => !events.includes(e));
  return result(
    "endpoint de eventos",
    [
      hook.status !== "enabled" && "desativado",
      hook.livemode !== livemode && "outro modo",
      missing.length > 0 && `eventos ausentes: ${missing.join(", ")}`,
    ].filter(Boolean),
  );
}

/**
 * A configuração padrão do portal, que `billing.portal` usa: só cartão e faturas. A plataforma
 * recusa entregar o link com qualquer outra (`readPortalSession`).
 */
export function checkPortal(body, livemode) {
  const defaults = items(body).filter((item) => item?.is_default === true);
  if (defaults.length !== 1) return result("portal do cliente", ["sem configuração padrão"]);
  const [configuration] = defaults;
  const features = configuration.features ?? {};
  return result(
    "portal do cliente",
    [
      configuration.active !== true && "configuração inativa",
      configuration.livemode !== livemode && "outro modo",
      features.subscription_cancel?.enabled !== false && "cancelamento habilitado",
      features.subscription_update?.enabled !== false && "troca de plano habilitada",
      features.invoice_history?.enabled !== true && "histórico de faturas desligado",
      features.payment_method_update?.enabled !== true && "troca de cartão desligada",
    ].filter(Boolean),
  );
}

/** Relatório sem segredos nem ids: modo, resultado de cada item e o que fica para uma pessoa. */
export function report({ livemode, endpoint, prices, webhooks, portal }) {
  const checks = [
    checkPrices(prices, livemode),
    checkWebhook(webhooks, endpoint, livemode),
    checkPortal(portal, livemode),
  ];
  return {
    mode: livemode ? "live" : "test",
    endpoint,
    ok: checks.every((check) => check.ok),
    checks,
    manual: MANUAL_ITEMS,
  };
}
