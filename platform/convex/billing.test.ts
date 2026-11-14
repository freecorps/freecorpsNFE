import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { activateCatalogPlan } from "./lib/planCore";
import {
  OCT,
  NOV,
  NOV_10,
  DEC_10,
  JAN_10,
  WEBHOOK_SECRET,
  s,
  BILLING_ENVIRONMENT,
  useStripeKeys,
  type Json,
  fakeStripe,
  startInvoice,
  cycleInvoice,
  fixture,
  code,
  refusal,
  sign,
  deliver,
  processEvents,
  startCard,
} from "../../tests/helpers/billing";

/**
 * Card subscriptions through Stripe (#556): the card portal, permissions and isolation,
 * and the life cycle of a monthly subscription from Checkout to cancellation.
 * Synthetic Stripe from `tests/helpers/billing.ts`: nothing here reaches Stripe, test mode or live.
 */
usePlatformEnvironment(BILLING_ENVIRONMENT);
useStripeKeys();

describe("portal de cartão e faturas", () => {
  it("abre para gestores usando o cliente da organização e a configuração conferida", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const admin = await person(f.t, f.organizationId, "admin");
    for (const manager of [f.owner, admin])
      expect(
        await manager.action(api.billing.portal, { organizationId: f.organizationId }),
      ).toEqual({
        url: "https://billing.stripe.com/p/session/synthetic",
      });
    for (const call of f.fake.sent("/v1/billing_portal/sessions")) {
      expect(call.params.get("customer")).toBe(customer);
      expect(call.params.get("expand[0]")).toBe("configuration");
    }
  });

  it.each([
    ["subscription_cancel", true],
    ["subscription_update", true],
    ["invoice_history", false],
    ["payment_method_update", false],
    ["subscription_cancel", undefined],
  ] as const)("recusa o portal com %s = %s", async (feature, enabled) => {
    const f = await fixture();
    await startCard(f);
    const features = f.fake.state.portalConfiguration.features as Json;
    features[feature] = { enabled };
    expect(
      await code(f.owner.action(api.billing.portal, { organizationId: f.organizationId })),
    ).toBe("BILLING_UNAVAILABLE");
  });

  it.each([{ active: false }, { livemode: true }, { features: null }])(
    "recusa configuração inativa, de outro ambiente ou incompleta: %j",
    async (patch) => {
      const f = await fixture();
      await startCard(f);
      Object.assign(f.fake.state.portalConfiguration, patch);
      expect(
        await code(f.owner.action(api.billing.portal, { organizationId: f.organizationId })),
      ).toBe("BILLING_UNAVAILABLE");
    },
  );

  it("não abre sessão para pessoas sem acesso à organização ou sem gestão", async () => {
    const f = await fixture();
    await startCard(f);
    const args = { organizationId: f.organizationId };
    for (const role of ["developer", "operator", "viewer"] as const) {
      const member = await person(f.t, f.organizationId, role);
      expect(await code(member.action(api.billing.portal, args))).toBe("ACCESS_DENIED");
    }
    expect(await code(f.t.action(api.billing.portal, args))).toBe("UNAUTHENTICATED");
    const other = await f.org("Outra organização");
    expect(await code(f.owner.action(api.billing.portal, { organizationId: other }))).toBe(
      "ACCESS_DENIED",
    );
    expect(f.fake.sent("/v1/billing_portal/sessions")).toHaveLength(0);
  });
});

describe("respostas inconsistentes do portal", () => {
  it.each([
    { customer: "cus_other" },
    { livemode: true },
    { configuration: "bpc_not_expanded" },
    { url: "http://billing.stripe.com/unsafe" },
  ])("não entrega a sessão: %j", async (response) => {
    const f = await fixture();
    await startCard(f);
    f.fake.state.portalSessionOverrides = response;
    expect(
      await code(f.owner.action(api.billing.portal, { organizationId: f.organizationId })),
    ).toBe("BILLING_UNAVAILABLE");
  });
});

describe("cartão sem configuração", () => {
  it("billing:overview responde sem o cartão configurado", async () => {
    const f = await fixture();
    vi.stubEnv("STRIPE_BILLING_SECRET_KEY", "");
    vi.stubEnv("STRIPE_BILLING_WEBHOOK_SECRET", "");
    expect(await f.billing()).toMatchObject({ card: false, account: null, checkout: null });
  });
});

describe("permissões e isolamento", () => {
  it("recusa papel sem gestão, sessão ausente, outra organização e cobrança desligada", async () => {
    const f = await fixture();
    const viewer = await person(f.t, f.organizationId, "viewer");
    const operator = await person(f.t, f.organizationId, "operator");
    const args = {
      organizationId: f.organizationId,
      tier: "intermediate" as const,
      key: "denied-key-1",
    };
    expect(
      await code(
        viewer.query(api.billing.overview, { asOf: Date.now(), organizationId: f.organizationId }),
      ),
    ).toBe("ACCESS_DENIED");
    expect(await code(viewer.action(api.billing.checkout, args))).toBe("ACCESS_DENIED");
    expect(await code(operator.action(api.billing.checkout, args))).toBe("ACCESS_DENIED");
    expect(
      await code(
        operator.action(api.billing.changeRenewal, {
          organizationId: f.organizationId,
          change: "cancel",
        }),
      ),
    ).toBe("ACCESS_DENIED");
    expect(
      await code(operator.action(api.billing.portal, { organizationId: f.organizationId })),
    ).toBe("ACCESS_DENIED");
    expect(await code(f.t.action(api.billing.checkout, args))).toBe("UNAUTHENTICATED");
    const other = await f.org("Outra organização");
    expect(
      await code(f.owner.action(api.billing.checkout, { ...args, organizationId: other })),
    ).toBe("ACCESS_DENIED");
    expect(
      await code(f.owner.query(api.billing.overview, { asOf: Date.now(), organizationId: other })),
    ).toBe("ACCESS_DENIED");
    expect(f.fake.state.calls).toEqual([]);
    vi.stubEnv("STRIPE_BILLING_SECRET_KEY", "");
    vi.stubEnv("STRIPE_BILLING_WEBHOOK_SECRET", "");
    expect(await code(f.owner.action(api.billing.checkout, args))).toBe("BILLING_DISABLED");
    expect(await f.billing()).toMatchObject({ card: false });
    expect(
      (await deliver(f, { type: "invoice.paid", data: { object: { id: "in_1" } } })).status,
    ).toBe(404);
  });

  it("um evento de outro cliente ou de outro modo nunca mexe no plano", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    // Invoice of this customer claiming another organization: blocked, never granted.
    f.fake.invoice({ ...startInvoice(customer, sub.id, "j57other", 14900) });
    expect(
      await deliver(f, { type: "invoice.paid", data: { object: { id: "in_1", customer } } }),
    ).toEqual({ status: 200, code: "RECEIVED" });
    expect(
      await deliver(f, {
        type: "invoice.paid",
        livemode: true,
        data: { object: { id: "in_1", customer } },
      }),
    ).toEqual({ status: 200, code: "RECEIVED" });
    expect(
      await deliver(f, {
        type: "invoice.paid",
        data: { object: { id: "in_9", customer: "cus_stranger" } },
      }),
    ).toEqual({ status: 200, code: "RECEIVED" });
    await processEvents(f);
    expect(await f.plan()).toBeNull();
    const events = await f.t.run((ctx) => ctx.db.query("billingEvents").collect());
    expect(events.map((e) => [e.state, e.code ?? null])).toEqual([
      ["processed", null],
      ["ignored", "LIVEMODE_MISMATCH"],
      ["ignored", "UNKNOWN_CUSTOMER"],
    ]);
    expect(await f.t.run((ctx) => ctx.db.query("billingGrants").collect())).toMatchObject([
      { state: "blocked", code: "ORGANIZATION_MISMATCH" },
    ]);
    expect((await f.billing()).reviews).toMatchObject([
      { source: "grant", code: "ORGANIZATION_MISMATCH" },
    ]);
  });

  it("recusa assinatura de outro segredo, vencida ou ausente sem registrar nada", async () => {
    const f = await fixture();
    const event = { type: "invoice.paid", data: { object: { id: "in_1" } } };
    // Each signature covers the exact body sent, so only the secret or the time is wrong.
    expect(await deliver(f, event, (body) => sign(body, "whsec_outro_segredo_sint"))).toEqual({
      status: 400,
      code: "SIGNATURE_INVALID",
    });
    expect(
      await deliver(f, event, (body) => sign(body, WEBHOOK_SECRET, s(Date.now()) - 3600)),
    ).toEqual({ status: 400, code: "SIGNATURE_EXPIRED" });
    expect(await deliver(f, event, "")).toEqual({ status: 400, code: "SIGNATURE_MISSING" });
    expect(await f.t.run((ctx) => ctx.db.query("billingEvents").collect())).toEqual([]);
  });
});

describe("ciclo da assinatura", () => {
  it("recupera resposta perdida na criação da sessão sem duplicar a sessão", async () => {
    const f = await fixture();
    const args = {
      organizationId: f.organizationId,
      tier: "intermediate" as const,
      key: "retry-monthly",
    };
    f.fake.state.loseResponseOnce = "/v1/checkout/sessions";
    expect(await code(f.owner.action(api.billing.checkout, args))).toBe("BILLING_UNAVAILABLE");
    expect(await f.t.run((ctx) => ctx.db.query("billingCheckouts").first())).toMatchObject({
      state: "creating",
    });
    const result = await f.owner.action(api.billing.checkout, args);
    expect(result.url).toContain("checkout.stripe.com");
    expect(f.fake.state.sessions.size).toBe(1);
    const calls = f.fake.sent("/v1/checkout/sessions");
    expect(new Set(calls.map((call) => call.key)).size).toBe(1);
    expect(new Set(calls.map((call) => call.params.toString())).size).toBe(1);
    expect(await f.plan()).toBeNull();
  });

  it("o Stripe simulado recusa a combinação original da #668", async () => {
    fakeStripe();
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { "stripe-version": "2025-03-31.basil" },
      body: new URLSearchParams({
        "subscription_data[proration_behavior]": "none",
        "line_items[1][price_data][unit_amount]": "14900",
      }).toString(),
    });
    expect(response.status).toBe(400);
  });

  it("contrata pelo Checkout, só ativa com a fatura paga e não repete o efeito", async () => {
    const f = await fixture();
    const { url, customer } = await startCard(f);
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [created] = f.fake.sent("/v1/checkout/sessions");
    // ADR 0012, slice 2a: the recurring price alone, charged at the signing, which Stripe takes
    // as the anchor. No anchor on the 1st, one-off item, coupon or proration; the marks carry no
    // period, since the month starts when it is paid. The link lasts a day.
    expect(Object.fromEntries(created!.params)).toEqual({
      mode: "subscription",
      customer,
      client_reference_id: f.organizationId,
      locale: "pt-BR",
      "payment_method_types[0]": "card",
      success_url: expect.stringContaining("cobranca=retorno"),
      cancel_url: expect.stringContaining("cobranca=cancelado"),
      expires_at: String(s(OCT + 24 * 3600_000)),
      "line_items[0][price]": "price_int",
      "line_items[0][quantity]": "1",
      "metadata[organizationId]": f.organizationId,
      "metadata[kind]": "start",
      "metadata[tier]": "intermediate",
      "metadata[grantCents]": "14900",
      "subscription_data[metadata][organizationId]": f.organizationId,
      "subscription_data[metadata][kind]": "start",
      "subscription_data[metadata][tier]": "intermediate",
      "subscription_data[metadata][grantCents]": "14900",
    });
    expect(f.fake.state.calls.some((call) => call.path === "/v1/coupons")).toBe(false);
    // Same intention after an uncertain answer: same session, one Stripe creation.
    expect(
      await f.owner.action(api.billing.checkout, {
        organizationId: f.organizationId,
        tier: "intermediate",
        key: "start-intermediate-key",
      }),
    ).toEqual({ url });
    expect(f.fake.sent("/v1/checkout/sessions")).toHaveLength(1);
    expect(
      await code(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "large",
          key: "second-checkout",
        }),
      ),
    ).toBe("CHECKOUT_PENDING");
    // The browser coming back proves nothing.
    await f.owner.action(api.billing.refresh, { organizationId: f.organizationId });
    expect(await f.plan()).toBeNull();
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    f.fake.state.sessions.get(
      `cs_${(await f.t.run((ctx) => ctx.db.query("billingCheckouts").first()))!._id}`,
    )!.status = "complete";
    const event = { type: "invoice.paid", data: { object: { id: "in_1", customer } } };
    const body = JSON.stringify({ id: "evt_dup", livemode: false, ...event });
    for (let i = 0; i < 2; i++)
      expect(
        (
          await f.t.fetch("/v1/billing/stripe/events", {
            method: "POST",
            headers: { "stripe-signature": sign(body) },
            body,
          })
        ).status,
      ).toBe(200);
    await processEvents(f);
    await f.owner.action(api.billing.refresh, { organizationId: f.organizationId });
    // From the signing, 10/10 at 12:00 UTC, to the same day and time next month, with that anchor.
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      startsAt: OCT,
      endsAt: NOV_10,
      periodAnchor: OCT,
      version: 1,
    });
    expect(await f.t.run((ctx) => ctx.db.query("billingEvents").collect())).toHaveLength(1);
    expect(await f.t.run((ctx) => ctx.db.query("billingGrants").collect())).toMatchObject([
      { state: "applied", invoiceId: "in_1", period: "2026-10-10T12:00:00.000Z" },
    ]);
    expect(await f.billing()).toMatchObject({
      checkout: null,
      account: {
        renewalTier: "intermediate",
        subscription: { tier: "intermediate", periodEnd: NOV_10, cancelAtPeriodEnd: false },
      },
    });
  });

  it("renova no aniversário, ignora fatura antiga atrasada, e sem carência vence até o pagamento ser recuperado", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    vi.setSystemTime(NOV_10 + 3600_000);
    f.fake.invoice(cycleInvoice(customer, sub.id, NOV_10));
    (sub.items.data[0] as Json).current_period_end = s(DEC_10);
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ endsAt: DEC_10, periodAnchor: OCT, version: 2 });
    // A late, repeated event for October's invoice changes nothing.
    await deliver(f, { type: "invoice.paid", data: { object: { id: "in_1", customer } } });
    await processEvents(f);
    expect(await f.plan()).toMatchObject({ endsAt: DEC_10, version: 2 });
    // December's charge is declined: the plan ends with the month paid, the documents stay.
    vi.setSystemTime(DEC_10 + 3600_000);
    const declined = f.fake.invoice(
      cycleInvoice(customer, sub.id, DEC_10, {
        status: "open",
        amount_paid: 0,
        hosted_invoice_url: "https://invoice.stripe.com/i/synthetic",
      }),
    );
    sub.status = "past_due";
    await deliver(f, {
      type: "invoice.payment_failed",
      data: { object: { id: declined.id, customer } },
    });
    await processEvents(f);
    expect(await f.plan()).toMatchObject({ endsAt: DEC_10 });
    // Months later the console session has expired; read the account directly.
    const account = () => f.t.run((ctx) => ctx.db.query("billingAccounts").first());
    expect(await account()).toMatchObject({
      subscription: { status: "past_due" },
      openInvoice: {
        id: declined.id,
        amountDueCents: 14900,
        url: "https://invoice.stripe.com/i/synthetic",
      },
    });
    // Recovered 4 days later: the whole month, still on the anchor's anniversaries.
    vi.setSystemTime(DEC_10 + 4 * 86400_000);
    Object.assign(declined, { status: "paid", amount_paid: 14900 });
    sub.status = "active";
    (sub.items.data[0] as Json).current_period_end = s(JAN_10);
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ endsAt: JAN_10, periodAnchor: OCT, version: 3 });
    expect((await account())?.openInvoice).toBeUndefined();
  });

  it("fechada a janela de admissão, quem já tem o plano renova; plano novo e upgrade são recusados (#549)", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: NOV_10 });
    // The window closes before the renewal on the anniversary.
    await f.t.run(async (ctx) => {
      const settings = await ctx.db.query("platformPlanSettings").first();
      await ctx.db.patch("platformPlanSettings", settings!._id, { admissionsUntil: NOV - 1 });
    });
    vi.setSystemTime(NOV_10 + 3600_000);
    f.fake.invoice(cycleInvoice(customer, sub.id, NOV_10));
    (sub.items.data[0] as Json).current_period_end = s(DEC_10);
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      endsAt: DEC_10,
      version: 2,
    });
    expect(
      (await f.t.run((ctx) => ctx.db.query("billingGrants").collect())).map((g) => g.state),
    ).toEqual(["applied", "applied"]);
    // Sessions from October have expired; fresh owners act in November.
    const owner = await person(f.t, f.organizationId, "owner");
    const other = await f.org("Outra organização");
    const otherOwner = await person(f.t, other, "owner");
    // An upgrade reserves more stock: it waits for a new window.
    expect(
      await code(
        owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "large",
          key: "upgrade-after-window",
        }),
      ),
    ).toBe("PLAN_UNAVAILABLE");
    // So does the first plan of another organization.
    expect(
      await code(
        otherOwner.action(api.billing.checkout, {
          organizationId: other,
          tier: "intermediate",
          key: "start-after-window",
        }),
      ),
    ).toBe("PLAN_UNAVAILABLE");
  });

  it("upgrade cobra a diferença integral, downgrade e cancelamento valem só na renovação", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    // Mid-period: the full difference now, for the same period, which keeps its anchor and end.
    vi.setSystemTime(Date.UTC(2026, 9, 25, 9));
    const owner = await person(f.t, f.organizationId, "owner");
    await owner.action(api.billing.checkout, {
      organizationId: f.organizationId,
      tier: "large",
      key: "upgrade-large-1",
    });
    const upgrade = f.fake.sent("/v1/checkout/sessions").at(-1)!;
    expect(Object.fromEntries(upgrade.params)).toMatchObject({
      mode: "payment",
      "line_items[0][price_data][unit_amount]": "35000",
      "invoice_creation[enabled]": "true",
      "invoice_creation[invoice_data][metadata][kind]": "upgrade",
      "invoice_creation[invoice_data][metadata][period]": "2026-10-10T12:00:00.000Z",
      expires_at: String(s(Date.UTC(2026, 9, 26, 9))),
    });
    expect(
      (
        await owner.query(api.billing.overview, {
          asOf: Date.now(),
          organizationId: f.organizationId,
        })
      ).checkout,
    ).toMatchObject({
      kind: "upgrade",
      periodStartsAt: OCT,
      grantCents: 35000,
    });
    f.fake.invoice({
      customer,
      amount_paid: 35000,
      amount_due: 35000,
      billing_reason: "manual",
      metadata: {
        organizationId: f.organizationId,
        kind: "upgrade",
        tier: "large",
        period: "2026-10-10T12:00:00.000Z",
        grantCents: "35000",
      },
    });
    for (const session of f.fake.state.sessions.values()) session.status = "complete";
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({
      catalogTier: "large",
      endsAt: NOV_10,
      periodAnchor: OCT,
      version: 2,
    });
    // The subscription now renews at Grande, without proration, on the same anniversary.
    expect(Object.fromEntries(f.fake.sent("/v1/subscriptions/sub_1").at(-1)!.params)).toEqual({
      "items[0][id]": "si_1",
      "items[0][price]": "price_large",
      proration_behavior: "none",
      billing_cycle_anchor: "unchanged",
    });
    // Downgrade: next renewal at Intermediário, the period paid keeps Grande.
    expect(
      await code(
        owner.action(api.billing.changeRenewal, {
          organizationId: f.organizationId,
          change: "large",
        }),
      ),
    ).toBe("PLAN_UNAVAILABLE");
    await owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "intermediate",
    });
    expect((sub.items.data[0] as Json).price).toBe("price_int");
    expect(await f.plan()).toMatchObject({ catalogTier: "large", version: 2 });
    // Cancel: no renewal, the paid period stays.
    await owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "cancel",
    });
    expect(sub.cancel_at_period_end).toBe(true);
    expect(await f.plan()).toMatchObject({ catalogTier: "large", endsAt: NOV_10 });
    expect(
      (
        await owner.query(api.billing.overview, {
          asOf: Date.now(),
          organizationId: f.organizationId,
        })
      ).account?.subscription?.cancelAtPeriodEnd,
    ).toBe(true);
    // One paid plan at a time: a new subscription beside the card plan in force waits for its
    // end, with the date; the renewal is "Retomar renovação".
    expect(
      await refusal(
        owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: "start-while-cancelling",
        }),
      ),
    ).toEqual({ code: "PLAN_UNAVAILABLE", availableAt: NOV_10 });
    await owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "resume",
    });
    expect(sub.cancel_at_period_end).toBe(false);
  });

  it("o upgrade fecha 45 minutos antes do aniversário e reabre depois da renovação", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    const upgrade = (key: string, owner = f.owner) =>
      owner.action(api.billing.checkout, { organizationId: f.organizationId, tier: "large", key });
    vi.setSystemTime(NOV_10 - 44 * 60_000);
    const late = await person(f.t, f.organizationId, "owner");
    expect(await refusal(upgrade("upgrade-at-the-end", late))).toEqual({
      code: "PERIOD_CLOSING",
      availableAt: NOV_10,
    });
    expect(f.fake.sent("/v1/checkout/sessions")).toHaveLength(1);
    // Just before the margin, the session expires before the period ends.
    vi.setSystemTime(NOV_10 - 46 * 60_000);
    await upgrade("upgrade-before-the-end", late);
    expect(f.fake.sent("/v1/checkout/sessions").at(-1)!.params.get("expires_at")).toBe(
      String(s(NOV_10 - 5 * 60_000)),
    );
    await late.action(api.billing.abandonCheckout, { organizationId: f.organizationId });
    // A difference paid after the period turned no longer matches it: a person looks.
    vi.setSystemTime(NOV_10 + 3600_000);
    f.fake.invoice(cycleInvoice(customer, sub.id, NOV_10));
    f.fake.invoice({
      customer,
      amount_paid: 35000,
      amount_due: 35000,
      billing_reason: "manual",
      metadata: {
        organizationId: f.organizationId,
        kind: "upgrade",
        tier: "large",
        period: "2026-10-10T12:00:00.000Z",
        grantCents: "35000",
      },
    });
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: DEC_10 });
    expect(
      (await f.t.run((ctx) => ctx.db.query("billingGrants").collect())).map((grant) => [
        grant.state,
        grant.code ?? null,
        grant.period,
      ]),
    ).toEqual([
      ["applied", null, "2026-10-10T12:00:00.000Z"],
      ["applied", null, "2026-11-10T12:00:00.000Z"],
      ["blocked", "LATE_PAYMENT", "2026-10-10T12:00:00.000Z"],
    ]);
    // In the next period, the upgrade is sold again, priced on it.
    const next = await person(f.t, f.organizationId, "owner");
    await upgrade("upgrade-next-period", next);
    expect(
      f.fake
        .sent("/v1/checkout/sessions")
        .at(-1)!
        .params.get("invoice_creation[invoice_data][metadata][period]"),
    ).toBe("2026-11-10T12:00:00.000Z");
  });

  it("uma linha de tier do catálogo atribuída pelo operador não segura o cartão", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      activateCatalogPlan(ctx, f.organizationId, "intermediate", OCT, NOV, 0, "op", "Atribuído"),
    );
    // No card invoice wrote the row: the upgrade by card is sold over it at once.
    expect(
      await code(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "large",
          key: "card-over-assigned",
        }),
      ),
    ).toBe("OK");
  });

  it("reembolso e contestação só sinalizam; timeout do Stripe é retentado sem repetir efeito", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    f.fake.state.failNext = 1;
    await deliver(f, { type: "invoice.paid", data: { object: { id: "in_1", customer } } });
    await processEvents(f);
    let [event] = await f.t.run((ctx) => ctx.db.query("billingEvents").collect());
    expect(event).toMatchObject({ state: "received", attempts: 1 });
    expect(await f.plan()).toBeNull();
    await processEvents(f);
    [event] = await f.t.run((ctx) => ctx.db.query("billingEvents").collect());
    expect(event).toMatchObject({ state: "processed" });
    expect(await f.plan()).toMatchObject({ version: 1 });
    f.fake.state.charges.set("ch_1", { id: "ch_1", customer });
    await deliver(f, {
      type: "charge.refunded",
      data: { object: { id: "ch_1", customer, amount_refunded: 14900, refunded: true } },
    });
    await deliver(f, {
      type: "charge.dispute.created",
      data: { object: { id: "dp_1", charge: "ch_1", amount: 14900 } },
    });
    await processEvents(f);
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", version: 1 });
    const { reviews } = await f.billing();
    expect(reviews.map((item) => item.code).sort()).toEqual(["DISPUTE_OPENED", "REFUND_FULL"]);
    const open = await f.t.run((ctx) => ctx.db.query("billingEvents").collect());
    await f.t.mutation(internal.billing.resolveReview, {
      eventId: open.find((e) => e.review)!._id,
      actor: "operator",
    });
    expect((await f.billing()).reviews).toHaveLength(1);
  });

  it("abandonar o Checkout expira a sessão no Stripe e libera um novo Checkout", async () => {
    const f = await fixture();
    await startCard(f);
    await f.owner.action(api.billing.abandonCheckout, { organizationId: f.organizationId });
    expect(f.fake.sent("/v1/checkout/sessions").length).toBe(1);
    expect((await f.billing()).checkout).toBeNull();
    expect(
      await code(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "large",
          key: "card-after-abandon",
        }),
      ),
    ).toBe("OK");
  });

  it("encerrar a organização cancela a assinatura no Stripe", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    await f.t.action(internal.billing.stopForClosure, {
      organizationId: f.organizationId as Id<"organizations">,
      attempt: 0,
    });
    expect(sub.status).toBe("canceled");
    expect((await f.billing()).account?.subscription).toBeNull();
  });
});
