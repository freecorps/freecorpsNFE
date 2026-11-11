/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vite-plus/test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { NOTICE_BATCH } from "./termsOfUseNotice";
import {
  platformTest,
  usePlatformEnvironment,
  type PlatformTest,
} from "../../tests/helpers/platform";

/**
 * The e-mail notice of a new version of the terms of use (#594). The archive is empty until D06;
 * each test publishes synthetic versions, as in `platform/convex/termsOfUse.test.ts`. Organizations,
 * people and addresses are synthetic; the provider is a stubbed `fetch`.
 */
const terms = vi.hoisted(() => ({
  version: null as string | null,
  archive: {} as Record<string, { sha256: string; since: string }>,
}));
vi.mock("./lib/termsOfUseArchive", () => ({
  get TERMS_OF_USE_ARCHIVE() {
    return terms.archive;
  },
  get TERMS_OF_USE_VERSION() {
    return terms.version;
  },
}));

const FIRST = "termos-de-uso-a",
  SECOND = "termos-de-uso-b";
function publish(version: string, since = "2026-12-10") {
  terms.archive = { ...terms.archive, [version]: { sha256: "a".repeat(64), since } };
  terms.version = version;
}
function reset() {
  terms.version = null;
  terms.archive = {};
}

usePlatformEnvironment({
  siteUrl: "http://localhost:5209",
  convexSiteUrl: "http://127.0.0.1:3279",
  secret: "synthetic-terms-notice-secret",
  now: Date.UTC(2026, 11, 10, 15),
});

type Role = "owner" | "admin" | "developer" | "operator" | "viewer";
/** An organization with one member per entry; a `removed` entry is a former member. */
async function organization(
  t: PlatformTest,
  name: string,
  members: (Role | `removed-${Role}`)[],
  options: { closed?: boolean; accepted?: string } = {},
) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name,
      slug: name.toLowerCase().replaceAll(" ", "-"),
      ownerCount: 1,
      memberCount: members.length,
      createdAt: now,
      updatedAt: now,
    });
    const emails: Record<string, string> = {};
    const ids: Id<"memberships">[] = [];
    for (const [index, entry] of members.entries()) {
      const removed = entry.startsWith("removed-");
      const role = entry.replace("removed-", "") as Role;
      const email = `${name.toLowerCase().replaceAll(" ", "-")}-${entry}-${index}@development.invalid`;
      emails[`${entry}-${index}`] = email;
      ids.push(
        await ctx.db.insert("memberships", {
          organizationId,
          authUserId: `${organizationId}-${index}`,
          name: "Pessoa sintética",
          email,
          role,
          state: removed ? "removed" : "active",
          version: 1,
          joinedAt: now,
          updatedAt: now,
        }),
      );
    }
    if (options.closed)
      await ctx.db.insert("organizationClosures", {
        organizationId,
        state: "closing",
        requestedAt: now,
        exportUntil: now + 30 * 86_400_000,
        purgeBy: now + 37 * 86_400_000,
        generation: 1,
      });
    if (options.accepted)
      await ctx.db.insert("termsOfUseAcceptances", {
        organizationId,
        membershipId: ids[0],
        version: options.accepted,
        sha256: "a".repeat(64),
        createdAt: now,
      });
    return { organizationId, emails };
  });
}

const notices = (t: PlatformTest) =>
  t.run(async (ctx) =>
    (await ctx.db.query("termsOfUseNotices").collect()).map(
      ({ organizationId, version, state, recipients, confirmed }) => ({
        organizationId,
        version,
        state,
        recipients,
        confirmed,
      }),
    ),
  );
const mailbox = (t: PlatformTest) =>
  t.run(async (ctx) =>
    (await ctx.db.query("developmentMail").collect())
      .filter((mail) => mail.type === "terms-of-use")
      .map(({ email, otp }) => ({ email, version: otp }))
      .sort((a, b) => a.email.localeCompare(b.email)),
  );
/** The validation's account e-mail, with its allowlist; the provider is a stubbed `fetch`. */
function validationMail(recipients: string[]) {
  for (const [key, value] of Object.entries({
    APP_ENV: "validation",
    EMAIL_MODE: "mail",
    SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    CONVEX_SITE_URL: "https://modest-seal-118.convex.site",
    AUTH_PROXY_MODE: "signed",
    AUTH_PROXY_SECRET: "a".repeat(64),
    MAIL_API_URL: "https://mail.development.invalid",
    MAIL_API_KEY: "synthetic-provider-token",
    ACCOUNT_EMAIL_FROM: "sender@validation.invalid",
    ACCOUNT_EMAIL_RECIPIENTS: recipients.join(","),
  }))
    vi.stubEnv(key, value);
}
/** The installation with the allowlist lifted (`*`, #428); the provider is a stubbed `fetch`. */
function installationMail() {
  for (const [key, value] of Object.entries({
    APP_ENV: "installation",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "mail",
    SITE_URL: "https://console.operator.invalid",
    CONVEX_SITE_URL: "https://api.operator.invalid",
    API_URL: "https://rest.operator.invalid",
    AUTH_PROXY_MODE: "signed",
    AUTH_PROXY_SECRET: "a".repeat(64),
    MAIL_API_URL: "https://mail.development.invalid",
    MAIL_API_KEY: "synthetic-provider-token",
    ACCOUNT_EMAIL_FROM: "sender@operator.invalid",
    ACCOUNT_EMAIL_RECIPIENTS: "*",
  }))
    vi.stubEnv(key, value);
}
/** The validation with account e-mail turned off. */
function mailDisabled() {
  for (const [key, value] of Object.entries({
    APP_ENV: "validation",
    EMAIL_MODE: "disabled",
    SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    CONVEX_SITE_URL: "https://modest-seal-118.convex.site",
    MAIL_API_URL: "",
    MAIL_API_KEY: "",
    ACCOUNT_EMAIL_FROM: "",
    ACCOUNT_EMAIL_RECIPIENTS: "",
  }))
    vi.stubEnv(key, value);
}
async function run(t: PlatformTest) {
  const result = await t.mutation(internal.termsOfUseNotice.start, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return result;
}

describe("Aviso por e-mail de versão nova dos termos de uso (#594)", () => {
  it("sem versão em vigor, nada é registrado nem enviado", async () => {
    reset();
    const t = platformTest();
    await organization(t, "Aberta", ["owner", "admin"]);
    expect(await run(t)).toEqual({ version: null, outcome: "none" });
    expect(await notices(t)).toEqual([]);
    expect(await mailbox(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("termsOfUseNoticeRuns").collect())).toEqual([]);
  });

  it("avisa uma vez cada organização aberta e sem aceite, só aos owners e admins ativos", async () => {
    reset();
    const t = platformTest();
    const open = await organization(t, "Aberta", [
      "owner",
      "admin",
      "viewer",
      "developer",
      "operator",
      "removed-admin",
    ]);
    const other = await organization(t, "Outra", ["owner"]);
    const closed = await organization(t, "Encerrada", ["owner", "admin"], { closed: true });
    const accepted = await organization(t, "Aceitou", ["owner"], { accepted: FIRST });
    const older = await organization(t, "Aceite antigo", ["owner"], {
      accepted: "termos-de-uso-antigos",
    });
    const nobody = await organization(t, "Sem gestor", ["viewer"]);
    publish(FIRST);
    expect(await run(t)).toEqual({ version: FIRST, outcome: "started" });
    expect(await notices(t)).toEqual(
      expect.arrayContaining([
        {
          organizationId: open.organizationId,
          version: FIRST,
          state: "sent",
          recipients: 2,
          confirmed: 2,
        },
        {
          organizationId: other.organizationId,
          version: FIRST,
          state: "sent",
          recipients: 1,
          confirmed: 1,
        },
        {
          organizationId: older.organizationId,
          version: FIRST,
          state: "sent",
          recipients: 1,
          confirmed: 1,
        },
        {
          organizationId: nobody.organizationId,
          version: FIRST,
          state: "skipped",
          recipients: 0,
          confirmed: 0,
        },
      ]),
    );
    expect(await notices(t)).toHaveLength(4);
    expect(
      (await notices(t)).some((row) =>
        [closed.organizationId, accepted.organizationId].includes(row.organizationId),
      ),
    ).toBe(false);
    // Each organization's owners and admins, and nobody else.
    expect(await mailbox(t)).toEqual(
      [
        open.emails["owner-0"],
        open.emails["admin-1"],
        other.emails["owner-0"],
        older.emails["owner-0"],
      ]
        .map((email) => ({ email, version: FIRST }))
        .sort((a, b) => a.email.localeCompare(b.email)),
    );
  });

  it("retentativa, outra cadeia e novo deploy não repetem o envio", async () => {
    reset();
    const t = platformTest();
    const open = await organization(t, "Aberta", ["owner", "admin"]);
    publish(FIRST);
    // Two starts before any batch runs: the second fences the first chain.
    expect(await t.mutation(internal.termsOfUseNotice.start, {})).toMatchObject({
      outcome: "started",
    });
    expect(await t.mutation(internal.termsOfUseNotice.start, {})).toMatchObject({
      outcome: "resumed",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const sent = await mailbox(t);
    expect(sent).toHaveLength(2);
    // The next deploy, a retried notify and a stale batch find the work done.
    expect(await run(t)).toEqual({ version: FIRST, outcome: "done" });
    await t.mutation(internal.termsOfUseNotice.notify, {
      organizationId: open.organizationId,
      version: FIRST,
    });
    await t.mutation(internal.termsOfUseNotice.batch, { version: FIRST, generation: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await notices(t)).toEqual([
      {
        organizationId: open.organizationId,
        version: FIRST,
        state: "sent",
        recipients: 2,
        confirmed: 2,
      },
    ]);
    expect(await mailbox(t)).toEqual(sent);
    // A version that is no longer current is never sent, even if its notify is retried.
    const late = await organization(t, "Atrasada", ["owner"]);
    publish(SECOND);
    await t.mutation(internal.termsOfUseNotice.notify, {
      organizationId: late.organizationId,
      version: FIRST,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await notices(t)).filter((row) => row.version === FIRST)).toHaveLength(1);
    // The new version gets its own notice, once per organization.
    expect(await run(t)).toEqual({ version: SECOND, outcome: "started" });
    expect((await notices(t)).filter((row) => row.version === SECOND)).toHaveLength(2);
  });

  it("um lote da geração antiga não avança, não agenda e não encerra a varredura retomada", async () => {
    reset();
    const t = platformTest();
    const first = await organization(t, "Primeira", ["owner"]);
    const second = await organization(t, "Segunda", ["owner"]);
    publish(FIRST);
    await t.mutation(internal.termsOfUseNotice.start, {});
    expect(await t.mutation(internal.termsOfUseNotice.start, {})).toMatchObject({
      outcome: "resumed",
    });
    const sweep = () =>
      t.run(async (ctx) => {
        const row = await ctx.db.query("termsOfUseNoticeRuns").unique();
        return row && { organizations: row.organizations, state: row.state };
      });
    const scheduled = () =>
      t.run(async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect())
          .filter((job) => job.state.kind === "pending")
          .map(({ name, args }) => ({ name, args: args[0] as unknown })),
      );
    const before = await scheduled();
    // The first start's chain runs after the resume: it reads nothing and schedules nothing.
    await t.mutation(internal.termsOfUseNotice.batch, { version: FIRST, generation: 1 });
    expect(await sweep()).toEqual({ organizations: 0, state: "running" });
    expect(await scheduled()).toEqual(before);
    // The current generation's batch visits the page, and both organizations get their notice.
    await t.mutation(internal.termsOfUseNotice.batch, { version: FIRST, generation: 2 });
    expect(await sweep()).toEqual({ organizations: 2, state: "done" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await notices(t)).map((row) => row.organizationId).sort()).toEqual(
      [first.organizationId, second.organizationId].sort(),
    );
    expect(await mailbox(t)).toHaveLength(2);
  });

  it("percorre muitas organizações em lotes, cada uma avisada uma vez", async () => {
    reset();
    const t = platformTest();
    const total = NOTICE_BATCH * 2 + 5;
    for (let i = 0; i < total; i++) await organization(t, `Org ${i}`, ["owner"]);
    publish(FIRST);
    await t.mutation(internal.termsOfUseNotice.start, {});
    const sweep = () => t.run((ctx) => ctx.db.query("termsOfUseNoticeRuns").unique());
    // Each batch visits at most NOTICE_BATCH organizations, in its own transaction.
    for (const visited of [NOTICE_BATCH, NOTICE_BATCH * 2, total]) {
      await t.mutation(internal.termsOfUseNotice.batch, { version: FIRST, generation: 1 });
      expect(await sweep()).toMatchObject({ organizations: visited });
    }
    expect(await sweep()).toMatchObject({ state: "done" });
    // The chain's own scheduled batches find the sweep done; the repeated notifies send nothing.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await sweep()).toMatchObject({ state: "done", organizations: total });
    const rows = await notices(t);
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((row) => row.organizationId)).size).toBe(total);
    expect(rows.every((row) => row.state === "sent")).toBe(true);
    expect(await mailbox(t)).toHaveLength(total);
  });

  it("usa o canal do e-mail de contas: uma mensagem por autorizado, sem retentativa automática", async () => {
    reset();
    const t = platformTest();
    const open = await organization(t, "Aberta", ["owner", "admin", "viewer"]);
    const outside = await organization(t, "Fora da lista", ["owner"]);
    validationMail([open.emails["owner-0"], open.emails["admin-1"], open.emails["viewer-2"]]);
    const payloads: { to: string[]; subject: string; text: string }[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("Expected JSON request");
      payloads.push(JSON.parse(init.body));
      return new Response("private provider body", { status: 503 });
    });
    vi.stubGlobal("fetch", fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    publish(FIRST);
    await run(t);
    // Each refusal stays unconfirmed and is not sent again, by a retry or by the next deploy.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await notices(t)).toEqual(
      expect.arrayContaining([
        {
          organizationId: open.organizationId,
          version: FIRST,
          state: "unconfirmed",
          recipients: 2,
          confirmed: 0,
        },
        {
          organizationId: outside.organizationId,
          version: FIRST,
          state: "skipped",
          recipients: 0,
          confirmed: 0,
        },
      ]),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("@");
    await run(t);
    await t.mutation(internal.termsOfUseNotice.notify, {
      organizationId: open.organizationId,
      version: FIRST,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetch).toHaveBeenCalledTimes(2);
    // A new version, accepted by the provider: one message to each authorized owner and admin.
    fetch.mockImplementation(async (_url, init) => {
      if (typeof init.body !== "string") throw new Error("Expected JSON request");
      const body = JSON.parse(init.body);
      payloads.push(body);
      return Response.json({ id: "email-1" });
    });
    publish(SECOND);
    await run(t);
    expect(fetch).toHaveBeenCalledTimes(4);
    const messages = payloads.slice(2);
    // No message names another recipient.
    const byAddress = (a: string[], b: string[]) => a.join().localeCompare(b.join());
    expect(messages.map((message) => message.to).sort(byAddress)).toEqual(
      [[open.emails["admin-1"]], [open.emails["owner-0"]]].sort(byAddress),
    );
    for (const message of messages) {
      expect(message.subject).toContain("09/01/2027");
      expect(message.text).toContain(SECOND);
      expect(message.text).toContain("09/01/2027");
      expect(message.text).toContain(
        `https://freecorpsnfe-validation.freecorps.workers.dev/termos/uso/${SECOND}`,
      );
      expect(message.text).not.toContain("@");
    }
    expect(
      (await notices(t)).find(
        (row) => row.organizationId === open.organizationId && row.version === SECOND,
      ),
    ).toMatchObject({ state: "sent", recipients: 2, confirmed: 2 });
    vi.unstubAllGlobals();
  });

  it("na instalação sem allowlist (*), avisa todos os owners e admins, sem barrar ninguém (#428)", async () => {
    reset();
    const t = platformTest();
    const first = await organization(t, "Primeira", ["owner", "admin", "viewer"]);
    const second = await organization(t, "Segunda", ["owner"]);
    installationMail();
    const sent: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (typeof init.body !== "string") throw new Error("Expected JSON request");
        const body = JSON.parse(init.body);
        sent.push(body.to);
        return Response.json({ id: "email-1" });
      }),
    );
    publish(FIRST);
    await run(t);
    expect(sent.flat().sort()).toEqual(
      [first.emails["owner-0"], first.emails["admin-1"], second.emails["owner-0"]].sort(),
    );
    expect(await notices(t)).toEqual(
      expect.arrayContaining([
        {
          organizationId: first.organizationId,
          version: FIRST,
          state: "sent",
          recipients: 2,
          confirmed: 2,
        },
        {
          organizationId: second.organizationId,
          version: FIRST,
          state: "sent",
          recipients: 1,
          confirmed: 1,
        },
      ]),
    );
    expect(
      (await t.query(internal.termsOfUseNotice.status, { before: Date.now() })).withheld.count,
    ).toBe(0);
    vi.unstubAllGlobals();
  });

  it("o operador vê as organizações com destinatários barrados pela allowlist (#610)", async () => {
    reset();
    const t = platformTest();
    // Created in an order that differs from the order by `withheld`, either way.
    const one = await organization(t, "Um fora", ["owner", "admin"]);
    const outside = await organization(t, "Fora da lista", ["owner", "admin", "admin"]);
    const part = await organization(t, "Em parte", ["owner", "admin", "admin"]);
    const listed = await organization(t, "Na lista", ["owner"]);
    // Only the first owner of three organizations is authorized; nobody of "Fora da lista".
    validationMail([one.emails["owner-0"], part.emails["owner-0"], listed.emails["owner-0"]]);
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("Expected JSON request");
      return Response.json({ id: "email-1" });
    });
    vi.stubGlobal("fetch", fetch);
    publish(FIRST);
    await run(t);
    expect(fetch).toHaveBeenCalledTimes(3);
    const rows = await t.run((ctx) => ctx.db.query("termsOfUseNotices").collect());
    const idOf = (organizationId: Id<"organizations">) =>
      rows.find((row) => row.organizationId === organizationId)?._id;
    const status = await t.query(internal.termsOfUseNotice.status, { before: Date.now() });
    // `counts` alone shows one more `sent` and one `skipped`; `withheld` names who was left out.
    expect(status.counts).toEqual(
      expect.arrayContaining([
        { state: "sent", count: 3, capped: false },
        { state: "skipped", count: 1, capped: false },
      ]),
    );
    expect(status.withheld.count).toBe(3);
    expect(status.withheld.capped).toBe(false);
    // The organization with the most recipients left out comes first; "Na lista" is absent.
    expect(status.withheld.rows).toEqual([
      {
        noticeId: idOf(outside.organizationId),
        organizationId: outside.organizationId,
        state: "skipped",
        recipients: 0,
        withheld: 3,
      },
      {
        noticeId: idOf(part.organizationId),
        organizationId: part.organizationId,
        state: "sent",
        recipients: 1,
        withheld: 2,
      },
      {
        noticeId: idOf(one.organizationId),
        organizationId: one.organizationId,
        state: "sent",
        recipients: 1,
        withheld: 1,
      },
    ]);
    // Widening the allowlist sends nothing: the next publication finds the sweep done, and
    // `resumePending` only takes `pending` rows.
    validationMail([...Object.values(part.emails), ...Object.values(outside.emails)]);
    expect(await run(t)).toEqual({ version: FIRST, outcome: "done" });
    await t.mutation(internal.termsOfUseNotice.resumePending, { olderThanMinutes: 0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetch).toHaveBeenCalledTimes(3);
    // Another version's rows are not listed under this one.
    expect(
      (await t.query(internal.termsOfUseNotice.status, { version: SECOND, before: Date.now() }))
        .withheld,
    ).toEqual({ count: 0, capped: false, rows: [] });
    vi.unstubAllGlobals();
  });

  it("quando só parte dos envios é aceita, a linha fica parcial e não reenvia", async () => {
    reset();
    const t = platformTest();
    const open = await organization(t, "Aberta", ["owner", "admin", "admin"]);
    validationMail(Object.values(open.emails));
    const bounced = open.emails["admin-1"];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("Expected JSON request");
      const { to } = JSON.parse(init.body) as { to: string[] };
      // The refusal of one address does not touch the others' messages.
      return to.includes(bounced)
        ? Response.json(
            { statusCode: 422, name: "validation_error", message: "refused" },
            { status: 422 },
          )
        : Response.json({ id: `email-${to[0]}` });
    });
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    publish(FIRST);
    await run(t);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await notices(t)).toEqual([
      {
        organizationId: open.organizationId,
        version: FIRST,
        state: "partial",
        recipients: 3,
        confirmed: 2,
      },
    ]);
    await run(t);
    await t.mutation(internal.termsOfUseNotice.resumePending, { olderThanMinutes: 0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("acha os owners e admins numa organização com mais de 1000 membros ativos", async () => {
    reset();
    const t = platformTest();
    // The owner and the admin joined after a thousand other active members.
    const large = await organization(t, "Grande", [
      ...Array.from({ length: 1100 }, () => "viewer" as const),
      "owner",
      "admin",
    ]);
    publish(FIRST);
    await run(t);
    expect(await notices(t)).toEqual([
      {
        organizationId: large.organizationId,
        version: FIRST,
        state: "sent",
        recipients: 2,
        confirmed: 2,
      },
    ]);
    expect((await mailbox(t)).map(({ email }) => email).sort()).toEqual(
      [large.emails["owner-1100"], large.emails["admin-1101"]].sort(),
    );
  });

  it("com o e-mail de contas desligado, nada é registrado", async () => {
    reset();
    const t = platformTest();
    await organization(t, "Aberta", ["owner"]);
    mailDisabled();
    publish(FIRST);
    expect(await run(t)).toEqual({ version: FIRST, outcome: "disabled" });
    expect(await notices(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("termsOfUseNoticeRuns").collect())).toEqual([]);
  });

  it("e-mail de contas desligado entre o registro e o envio termina em skipped", async () => {
    reset();
    const t = platformTest();
    const open = await organization(t, "Aberta", ["owner"]);
    validationMail([open.emails["owner-0"]]);
    const fetch = vi.fn(async () => Response.json({ success: true, result: {} }));
    vi.stubGlobal("fetch", fetch);
    publish(FIRST);
    // The row is written with the channel on; the send runs after it was turned off.
    await t.mutation(internal.termsOfUseNotice.notify, {
      organizationId: open.organizationId,
      version: FIRST,
    });
    mailDisabled();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetch).not.toHaveBeenCalled();
    expect(await notices(t)).toEqual([
      {
        organizationId: open.organizationId,
        version: FIRST,
        state: "skipped",
        recipients: 0,
        confirmed: 0,
      },
    ]);
    vi.unstubAllGlobals();
  });

  it("o operador vê as linhas presas, retoma pending e não reenvia sending", async () => {
    reset();
    const t = platformTest();
    const stalled = await organization(t, "Parada", ["owner"]);
    const uncertain = await organization(t, "Incerta", ["owner"]);
    const fresh = await organization(t, "Recente", ["owner"]);
    publish(FIRST);
    const now = Date.now();
    const hour = 3_600_000;
    // A `deliver` that failed before its claim, one whose `finish` never ran, and a recent row.
    const ids = await t.run(async (ctx) => {
      const row = (organizationId: Id<"organizations">, state: "pending" | "sending", at: number) =>
        ctx.db.insert("termsOfUseNotices", {
          organizationId,
          version: FIRST,
          state,
          recipients: 0,
          confirmed: 0,
          withheld: 0,
          createdAt: at,
          ...(state === "sending" ? { claimedAt: at } : {}),
        });
      return {
        stalled: await row(stalled.organizationId, "pending", now - 2 * hour),
        uncertain: await row(uncertain.organizationId, "sending", now - 2 * hour),
        fresh: await row(fresh.organizationId, "pending", now),
      };
    });
    const status = await t.query(internal.termsOfUseNotice.status, { before: now - hour });
    expect(status.version).toBe(FIRST);
    expect(status.counts).toEqual(
      expect.arrayContaining([
        { state: "pending", count: 2, capped: false },
        { state: "sending", count: 1, capped: false },
        { state: "sent", count: 0, capped: false },
      ]),
    );
    expect(status.stuck).toEqual([
      {
        noticeId: ids.stalled,
        organizationId: stalled.organizationId,
        state: "pending",
        createdAt: now - 2 * hour,
      },
      {
        noticeId: ids.uncertain,
        organizationId: uncertain.organizationId,
        state: "sending",
        createdAt: now - 2 * hour,
        claimedAt: now - 2 * hour,
      },
    ]);
    // Only the old pending row is resumed; resuming again finds nothing.
    expect(await t.mutation(internal.termsOfUseNotice.resumePending, {})).toEqual({
      version: FIRST,
      resumed: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await mailbox(t)).toEqual([{ email: stalled.emails["owner-0"], version: FIRST }]);
    expect(await t.mutation(internal.termsOfUseNotice.resumePending, {})).toEqual({
      version: FIRST,
      resumed: 0,
    });
    const rows = await notices(t);
    expect(rows.find((row) => row.organizationId === stalled.organizationId)).toMatchObject({
      state: "sent",
      confirmed: 1,
    });
    expect(rows.find((row) => row.organizationId === uncertain.organizationId)).toMatchObject({
      state: "sending",
    });
    expect(rows.find((row) => row.organizationId === fresh.organizationId)).toMatchObject({
      state: "pending",
    });
    // A resumed `deliver` racing a late original one sends once: only one claim succeeds.
    await t.mutation(internal.termsOfUseNotice.resumePending, { olderThanMinutes: 0 });
    await t.action(internal.termsOfUseNotice.deliver, { noticeId: ids.fresh });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      (await mailbox(t)).filter(({ email }) => email === fresh.emails["owner-0"]),
    ).toHaveLength(1);
  });
});
