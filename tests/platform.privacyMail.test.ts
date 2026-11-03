import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { api, components, internal } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import * as privacyMail from "../platform/convex/privacyMail";
import { platformTest, usePlatformEnvironment, type PlatformTest } from "./helpers/platform";
import {
  digestMail,
  LEGACY_ORIGINAL_MIME,
  MAINTENANCE_HELD_HEADER,
  mailHeaders,
  mailSignature,
  ORIGINAL_MIME,
  ORPHAN_GRACE,
  PRIVACY_ADDRESS,
  SECURITY_ADDRESS,
  SUPPORT_ADDRESS,
  OPERATION_ADDRESS,
} from "../platform/convex/lib/privacyMailProtocol";

usePlatformEnvironment({
  siteUrl: "http://localhost:5174",
  convexSiteUrl: "http://127.0.0.1:3215",
  secret: "synthetic-better-auth-secret-for-privacy",
});
const operatorEmail = "privacy-operator@development.invalid";
const secret = "synthetic-mail-signature-secret-only-for-tests";
beforeEach(() => {
  vi.stubEnv("FNFE_PRIVACY_OPERATOR_EMAILS", operatorEmail);
  vi.stubEnv("INBOUND_EMAIL_SECRET", secret);
  vi.stubEnv("FNFE_PRIVACY_SEND_MODE", "local");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function actor(t: PlatformTest, email = operatorEmail, emailVerified = true) {
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Pessoa sintética",
        email,
        emailVerified,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  });
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        expiresAt: Date.now() + 3600_000,
        token: crypto.randomUUID(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  });
  return {
    user,
    client: t.withIdentity({
      subject: user._id,
      sessionId: session._id,
      issuer: process.env.CONVEX_SITE_URL,
    }),
  };
}
const paginationOpts = { numItems: 20, cursor: null };
const mime = (extra = "") =>
  `From: Pessoa <person@example.com>\r\nTo: ${PRIVACY_ADDRESS}\r\nSubject: Acesso aos meus dados\r\nMessage-ID: <synthetic@example.com>\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\nQuero consultar meus dados.\r\n`;
async function signed(
  body: string,
  to = PRIVACY_ADDRESS,
  key = `pending/2026-10-21/${crypto.randomUUID()}.eml`,
  time = Date.now(),
) {
  const bytes = new TextEncoder().encode(body);
  const fields = {
    timestamp: String(time),
    key,
    from: "person@example.com",
    to,
    hash: await digestMail(bytes.buffer),
  };
  return {
    key,
    request: {
      method: "POST",
      body,
      headers: {
        [mailHeaders.timestamp]: fields.timestamp,
        [mailHeaders.key]: key,
        [mailHeaders.from]: fields.from,
        [mailHeaders.to]: to,
        [mailHeaders.signature]: await mailSignature(secret, fields),
      },
    },
  };
}
async function receive(t: PlatformTest, body = mime(), to = PRIVACY_ADDRESS) {
  const delivery = await signed(body, to);
  expect((await t.fetch("/privacy-mail", delivery.request)).status).toBe(204);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return (await t.query(internal.privacyMail.intake, { key: delivery.key }))!;
}
it("preserves the original, decodes the message and deduplicates concurrent deliveries", async () => {
  const t = platformTest(),
    { client } = await actor(t);
  const delivery = await signed(mime());
  const replies = await Promise.all([
    t.fetch("/privacy-mail", delivery.request),
    t.fetch("/privacy-mail", delivery.request),
  ]);
  expect(replies.map((r) => r.status)).toEqual([204, 204]);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const listed = await client.query(api.privacyMail.list, {
    mailbox: "privacy",
    status: "open",
    paginationOpts,
  });
  expect(listed.page).toHaveLength(1);
  const messages = await client.query(api.privacyMail.messages, {
    threadId: listed.page[0]!._id,
    paginationOpts,
  });
  expect(messages.page).toHaveLength(1);
  expect(messages.page[0]!.text).toContain("Quero consultar");
  expect(await t.run(async (ctx) => (await ctx.storage.get(messages.page[0]!.raw!))!.text())).toBe(
    mime(),
  );
  const changed = await signed(mime() + "changed", PRIVACY_ADDRESS, delivery.key);
  expect((await t.fetch("/privacy-mail", changed.request)).status).toBe(409);
});
it("rejects unsigned, modified, expired and foreign-domain deliveries before storing", async () => {
  const t = platformTest();
  expect((await t.fetch("/privacy-mail", { method: "POST", body: mime() })).status).toBe(401);
  const changed = await signed(mime());
  expect(
    (await t.fetch("/privacy-mail", { ...changed.request, body: mime() + "tampered" })).status,
  ).toBe(401);
  const expired = await signed(mime(), PRIVACY_ADDRESS, undefined, Date.now() - 360_000);
  expect((await t.fetch("/privacy-mail", expired.request)).status).toBe(401);
  const foreign = await signed(mime(), "privacidade@another.example");
  expect((await t.fetch("/privacy-mail", foreign.request)).status).toBe(400);
  expect(await t.run((ctx) => ctx.db.query("privacyIntakes").collect())).toHaveLength(0);
});
it("rejects a concurrent conflicting delivery without leaving its original in storage", async () => {
  const t = platformTest();
  const first = await signed(mime());
  const second = await signed(mime() + "Conteúdo diferente.", PRIVACY_ADDRESS, first.key);
  const replies = await Promise.all([
    t.fetch("/privacy-mail", first.request),
    t.fetch("/privacy-mail", second.request),
  ]);
  expect(replies.map((r) => r.status).sort((a, b) => a - b)).toEqual([204, 409]);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const intake = await t.query(internal.privacyMail.intake, { key: first.key });
  const stored = await t.run((ctx) => ctx.db.system.query("_storage").collect());
  expect(stored.map((row) => row._id)).toEqual([intake!.raw]);
  expect(await t.run((ctx) => ctx.db.query("privacyMessages").collect())).toHaveLength(1);
});
it("requires a verified operator; organization owners and operators cannot access the global inbox", async () => {
  const t = platformTest();
  const intake = await receive(t);
  const owner = await actor(t, "owner@development.invalid");
  const tenantOperator = await actor(t, "operator@development.invalid");
  const org = await t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: "Outra organização",
      slug: "other",
      ownerCount: 1,
      memberCount: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  for (const [person, role] of [
    [owner, "owner"],
    [tenantOperator, "operator"],
  ] as const)
    await t.run((ctx) =>
      ctx.db.insert("memberships", {
        organizationId: org,
        authUserId: person.user._id,
        email: person.user.email,
        name: person.user.name,
        role,
        state: "active",
        version: 1,
        joinedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  const unverified = await actor(t, "unverified@development.invalid", false);
  vi.stubEnv("FNFE_PRIVACY_OPERATOR_EMAILS", operatorEmail + ",unverified@development.invalid");
  for (const client of [t, owner.client, tenantOperator.client, unverified.client]) {
    await expect(
      client.query(api.privacyMail.list, { mailbox: "privacy", status: "open", paginationOpts }),
    ).rejects.toThrow();
    await expect(
      client.query(api.privacyMail.messages, { threadId: intake.threadId!, paginationOpts }),
    ).rejects.toThrow();
    await expect(
      client.mutation(api.privacyMail.note, { threadId: intake.threadId!, text: "unauthorized" }),
    ).rejects.toThrow();
  }
  const { client } = await actor(t);
  expect(
    (
      await client.query(api.privacyMail.list, {
        mailbox: "privacy",
        status: "open",
        paginationOpts,
      })
    ).page,
  ).toHaveLength(1);
  vi.stubEnv("FNFE_PRIVACY_OPERATOR_EMAILS", "");
  await expect(
    client.query(api.privacyMail.thread, { threadId: intake.threadId! }),
  ).rejects.toThrow();
});
const boxes = {
  privacy: { variable: "FNFE_PRIVACY_OPERATOR_EMAILS", email: operatorEmail, local: "privacidade" },
  security: {
    variable: "FNFE_SECURITY_OPERATOR_EMAILS",
    email: "security-operator@development.invalid",
    local: "seguranca",
  },
  support: {
    variable: "FNFE_SUPPORT_OPERATOR_EMAILS",
    email: "support-operator@development.invalid",
    local: "suporte",
  },
  operation: {
    variable: "FNFE_OPERATION_OPERATOR_EMAILS",
    email: "operation-operator@development.invalid",
    local: "operacao",
  },
} as const;
type Box = keyof typeof boxes;
const at = (local: string, token?: string) =>
  `${local}${token ? `+t_${token}` : ""}@nfe.freecorps.com.br`;
it.each([
  ["security", SECURITY_ADDRESS, "Freecorps Fiscal · Segurança"],
  ["support", SUPPORT_ADDRESS, "Freecorps Fiscal · Suporte"],
  ["operation", OPERATION_ADDRESS, "Freecorps Fiscal · Operação"],
] as const)(
  "keeps %s conversations in their own mailbox, with separate operators, tokens and sender",
  async (own, address, sender) => {
    const t = platformTest();
    vi.stubEnv(boxes.security.variable, boxes.security.email);
    vi.stubEnv(boxes.support.variable, boxes.support.email);
    vi.stubEnv(boxes.operation.variable, boxes.operation.email);
    const names = Object.keys(boxes) as Box[];
    const others = names.filter((box) => box !== own);
    const clients = {} as Record<Box, Awaited<ReturnType<typeof actor>>["client"]>;
    const threads = {} as Record<Box, Id<"privacyThreads">>;
    for (const box of names) {
      clients[box] = (await actor(t, boxes[box].email)).client;
      threads[box] = (await receive(t, mime(), at(boxes[box].local))).threadId!;
    }
    expect(address).toBe(at(boxes[own].local));
    const ids = async (client: (typeof clients)[Box], mailbox: Box) =>
      (
        await client.query(api.privacyMail.list, { mailbox, status: "open", paginationOpts })
      ).page.map((row) => row._id);
    const firstMessage = async (box: Box) =>
      (
        await clients[box].query(api.privacyMail.messages, {
          threadId: threads[box],
          paginationOpts,
        })
      ).page[0]!._id;
    for (const box of names) expect(await ids(clients[box], box)).toEqual([threads[box]]);
    const received = await firstMessage(own);
    // The shell's single subscription agrees with the per-mailbox answer.
    expect(await clients[own].query(api.privacyMail.mailboxes, {})).toEqual(
      Object.fromEntries(names.map((box) => [box, box === own])),
    );
    // Denied both ways: every other operator on this mailbox, this operator on every other one.
    for (const [client, mailbox] of others.flatMap(
      (other) =>
        [
          [clients[other], own],
          [clients[own], other],
        ] as const,
    )) {
      const threadId = threads[mailbox];
      expect(await client.query(api.privacyMail.access, { mailbox })).toMatchObject({
        allowed: false,
        address: at(boxes[mailbox].local),
      });
      await expect(ids(client, mailbox)).rejects.toThrow();
      await expect(client.query(api.privacyMail.thread, { threadId })).rejects.toThrow();
      await expect(
        client.query(api.privacyMail.messages, { threadId, paginationOpts }),
      ).rejects.toThrow();
      await expect(
        client.mutation(api.privacyMail.note, { threadId, text: "unauthorized" }),
      ).rejects.toThrow();
      await expect(
        client.mutation(api.privacyMail.setStatus, { threadId, status: "closed" }),
      ).rejects.toThrow();
      await expect(
        client.mutation(api.privacyMail.queueReply, {
          threadId,
          text: "unauthorized",
          requestId: crypto.randomUUID(),
        }),
      ).rejects.toThrow();
      await expect(
        client.mutation(api.privacyMail.download, { messageId: await firstMessage(mailbox) }),
      ).rejects.toThrow();
    }
    // A case token only joins its own mailbox.
    const row = await clients[own].query(api.privacyMail.thread, { threadId: threads[own] });
    for (const other of others) {
      const crossed = await receive(t, mime(), at(boxes[other].local, row!.token));
      expect(crossed.threadId).not.toBe(threads[own]);
      expect(await t.run((ctx) => ctx.db.get("privacyThreads", crossed.threadId!))).toMatchObject({
        mailbox: other,
      });
    }
    const answer = await receive(t, mime(), at(boxes[own].local, row!.token));
    expect(answer.threadId).toBe(threads[own]);
    vi.stubEnv("FNFE_PRIVACY_SEND_MODE", "cloudflare");
    vi.stubEnv("FNFE_PRIVACY_EMAIL_API_TOKEN", "synthetic");
    vi.stubEnv("FNFE_PRIVACY_EMAIL_ACCOUNT_ID", "synthetic");
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      expect(JSON.parse(init.body)).toMatchObject({
        from: { address, name: sender },
        reply_to: at(boxes[own].local, row!.token),
      });
      return Response.json({ success: true, result: { delivered: ["person@example.com"] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reply = await clients[own].mutation(api.privacyMail.queueReply, {
      threadId: threads[own],
      text: "Recebemos sua mensagem.",
      requestId: crypto.randomUUID(),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get("privacyMessages", reply))).toMatchObject({
      from: address,
      state: "accepted",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // An empty allowlist authorizes nobody and invalidates download tickets; the others are unrelated.
    const ticket = new URL(
      await clients[own].mutation(api.privacyMail.download, { messageId: received }),
    ).pathname;
    vi.stubEnv(boxes[own].variable, "");
    expect((await t.fetch(ticket)).status).toBe(404);
    expect(await clients[own].query(api.privacyMail.access, { mailbox: own })).toMatchObject({
      allowed: false,
    });
    expect(await clients[own].query(api.privacyMail.mailboxes, {})).toMatchObject({ [own]: false });
    await expect(ids(clients[own], own)).rejects.toThrow();
    for (const other of others) expect(await ids(clients[other], other)).toHaveLength(2);
  },
);
it("treats threads stored without a mailbox as privacy and assigns them during maintenance", async () => {
  const t = platformTest(),
    { client } = await actor(t);
  const [replied, waiting] = await Promise.all(
    [1, 2].map(async () => {
      const intake = await receive(t);
      await t.run((ctx) =>
        ctx.db.patch("privacyThreads", intake.threadId!, { mailbox: undefined }),
      );
      return intake;
    }),
  );
  expect(
    await client.query(api.privacyMail.thread, { threadId: replied!.threadId! }),
  ).not.toBeNull();
  const row = await t.run((ctx) => ctx.db.get("privacyThreads", replied!.threadId!));
  const answer = await receive(t, mime(), `privacidade+t_${row!.token}@nfe.freecorps.com.br`);
  expect(answer.threadId).toBe(replied!.threadId);
  // A legacy thread is privacy only: the support mailbox neither shows nor joins it.
  vi.stubEnv("FNFE_SUPPORT_OPERATOR_EMAILS", "support-operator@development.invalid");
  const support = await actor(t, "support-operator@development.invalid");
  await expect(
    support.client.query(api.privacyMail.thread, { threadId: replied!.threadId! }),
  ).rejects.toThrow();
  await expect(
    support.client.query(api.privacyMail.messages, {
      threadId: replied!.threadId!,
      paginationOpts,
    }),
  ).rejects.toThrow();
  const crossed = await receive(t, mime(), `suporte+t_${row!.token}@nfe.freecorps.com.br`);
  expect(crossed.threadId).not.toBe(replied!.threadId);
  expect(await t.run((ctx) => ctx.db.get("privacyThreads", crossed.threadId!))).toMatchObject({
    mailbox: "support",
  });
  await t.mutation(internal.privacyMail.sweep, {});
  for (const intake of [replied!, waiting!])
    expect(await t.run((ctx) => ctx.db.get("privacyThreads", intake.threadId!))).toMatchObject({
      mailbox: "privacy",
    });
  expect(
    (
      await client.query(api.privacyMail.list, {
        mailbox: "privacy",
        status: "open",
        paginationOpts,
      })
    ).page,
  ).toHaveLength(2);
});
it("joins only by the unguessable recipient token, never by spoofed References or subject", async () => {
  const t = platformTest(),
    { client } = await actor(t);
  const first = await receive(t);
  const forged = await receive(t, mime("References: <synthetic@example.com>\r\n"));
  expect(forged.threadId).not.toBe(first.threadId);
  const row = await client.query(api.privacyMail.thread, { threadId: first.threadId! });
  await client.mutation(api.privacyMail.setStatus, { threadId: first.threadId!, status: "closed" });
  const answer = await receive(t, mime(), `privacidade+t_${row!.token}@nfe.freecorps.com.br`);
  expect(answer.threadId).toBe(first.threadId);
  expect(await client.query(api.privacyMail.thread, { threadId: first.threadId! })).toMatchObject({
    status: "open",
    unread: true,
  });
});
it("download tickets expire, are single use and observe operator revocation", async () => {
  const t = platformTest(),
    { client } = await actor(t);
  const intake = await receive(t);
  const message = (
    await client.query(api.privacyMail.messages, { threadId: intake.threadId!, paginationOpts })
  ).page[0]!;
  const path = async () =>
    new URL(await client.mutation(api.privacyMail.download, { messageId: message._id })).pathname;
  const first = await path();
  const response = await t.fetch(first);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(await response.text()).toBe(mime());
  expect((await t.fetch(first)).status).toBe(404);
  const second = await path();
  vi.advanceTimersByTime(121_000);
  expect((await t.fetch(second)).status).toBe(404);
  const third = await path();
  vi.stubEnv("FNFE_PRIVACY_OPERATOR_EMAILS", "");
  expect((await t.fetch(third)).status).toBe(404);
});
it("persists one reply per request and refuses changed content under the same key", async () => {
  const t = platformTest(),
    { client } = await actor(t);
  const intake = await receive(t),
    requestId = crypto.randomUUID();
  const args = { threadId: intake.threadId!, text: "Resposta sintética.", requestId };
  const id = await client.mutation(api.privacyMail.queueReply, args);
  expect(await client.mutation(api.privacyMail.queueReply, args)).toBe(id);
  await expect(
    client.mutation(api.privacyMail.queueReply, { ...args, text: "Outra" }),
  ).rejects.toThrow();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run((ctx) => ctx.db.get("privacyMessages", id))).toMatchObject({
    state: "accepted",
  });
  expect(await client.query(api.privacyMail.thread, { threadId: intake.threadId! })).toMatchObject({
    status: "waiting",
  });
});
it("does not send for a revoked operator or resend a request after an uncertain transport", async () => {
  const t = platformTest(),
    { client } = await actor(t);
  const intake = await receive(t);
  vi.stubEnv("FNFE_PRIVACY_SEND_MODE", "cloudflare");
  vi.stubEnv("FNFE_PRIVACY_EMAIL_API_TOKEN", "synthetic");
  vi.stubEnv("FNFE_PRIVACY_EMAIL_ACCOUNT_ID", "synthetic");
  const fetchMock = vi.fn().mockRejectedValue(new Error("timeout"));
  vi.stubGlobal("fetch", fetchMock);
  const args = { threadId: intake.threadId!, text: "Resposta", requestId: crypto.randomUUID() };
  const id = await client.mutation(api.privacyMail.queueReply, args);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run((ctx) => ctx.db.get("privacyMessages", id))).toMatchObject({
    state: "uncertain",
  });
  await client.mutation(api.privacyMail.queueReply, args);
  await t.action(internal.privacyMailActions.send, { messageId: id });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const second = await client.mutation(api.privacyMail.queueReply, {
    ...args,
    requestId: crypto.randomUUID(),
  });
  vi.stubEnv("FNFE_PRIVACY_OPERATOR_EMAILS", "");
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run((ctx) => ctx.db.get("privacyMessages", second))).toMatchObject({
    state: "failed",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each([
  [200, { success: true, result: { delivered: ["person@example.com"] } }, "accepted"],
  [200, { success: true, result: { queued: ["person@example.com"] } }, "accepted"],
  [200, { success: true, result: { permanent_bounces: ["person@example.com"] } }, "failed"],
  [403, { success: false }, "failed"],
  [503, { success: false }, "uncertain"],
  [200, { success: true, result: {} }, "uncertain"],
] as const)(
  "records provider result %s/%j as %s without resending",
  async (status, body, state) => {
    const t = platformTest(),
      { client } = await actor(t);
    const intake = await receive(t);
    vi.stubEnv("FNFE_PRIVACY_SEND_MODE", "cloudflare");
    vi.stubEnv("FNFE_PRIVACY_EMAIL_API_TOKEN", "synthetic");
    vi.stubEnv("FNFE_PRIVACY_EMAIL_ACCOUNT_ID", "synthetic");
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const payload: unknown = JSON.parse(init.body);
      expect(payload).toMatchObject({
        from: { address: PRIVACY_ADDRESS },
        to: ["person@example.com"],
        text: "Resposta sintética.",
        reply_to: expect.stringMatching(/^privacidade\+t_[a-f0-9]{32}@nfe\.freecorps\.com\.br$/),
      });
      return Response.json(body, { status });
    });
    vi.stubGlobal("fetch", fetchMock);
    const id = await client.mutation(api.privacyMail.queueReply, {
      threadId: intake.threadId!,
      text: "Resposta sintética.",
      requestId: crypto.randomUUID(),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get("privacyMessages", id))).toMatchObject({ state });
    await t.action(internal.privacyMailActions.send, { messageId: id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);
it("purges only closed requests after five years, including original storage", async () => {
  const t = platformTest(),
    { client } = await actor(t);
  const first = await receive(t),
    other = await receive(t);
  await client.mutation(api.privacyMail.setStatus, { threadId: first.threadId!, status: "closed" });
  const closed = await client.query(api.privacyMail.thread, { threadId: first.threadId! });
  vi.setSystemTime(closed!.expiresAt! - 1);
  await t.mutation(internal.privacyMail.sweep, {});
  expect(await t.run((ctx) => ctx.db.get("privacyThreads", first.threadId!))).not.toBeNull();
  vi.setSystemTime(closed!.expiresAt! + 1);
  await t.mutation(internal.privacyMail.sweep, {});
  expect(await t.run((ctx) => ctx.db.get("privacyThreads", first.threadId!))).toBeNull();
  expect(await t.run((ctx) => ctx.storage.get(first.raw))).toBeNull();
  expect(await t.run((ctx) => ctx.db.get("privacyThreads", other.threadId!))).not.toBeNull();
});
it("continues the purge when an expired message's original and intake are already absent", async () => {
  const t = platformTest(),
    { client } = await actor(t);
  const first = await receive(t),
    second = await receive(t);
  for (const intake of [first, second])
    await client.mutation(api.privacyMail.setStatus, {
      threadId: intake.threadId!,
      status: "closed",
    });
  const closed = await client.query(api.privacyMail.thread, { threadId: first.threadId! });
  await t.run(async (ctx) => {
    await ctx.storage.delete(first.raw);
    await ctx.db.delete("privacyIntakes", first._id);
  });
  vi.setSystemTime(closed!.expiresAt! + 1);
  await t.mutation(internal.privacyMail.sweep, {});
  await t.mutation(internal.privacyMail.sweep, {});
  expect(await t.run((ctx) => ctx.db.query("privacyThreads").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("privacyMessages").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.storage.get(second.raw))).toBeNull();
});

type Handler = (...args: never[]) => unknown;
/** The registered handler convex-test calls, so a test can make one invocation fail. */
const handlerOf = (fn: unknown) => vi.spyOn(fn as { _handler: Handler }, "_handler");
/**
 * convex-test does not record a Blob's type in `_storage`; give the originals stored by the HTTP
 * action the one the backend sets, as the deployment records it.
 */
const blobs = (t: PlatformTest) =>
  t.run(async (ctx) => {
    const rows = await ctx.db.system.query("_storage").collect();
    for (const row of rows)
      if (!row.contentType)
        await ctx.db.patch(row._id as never, { contentType: ORIGINAL_MIME } as never);
    return rows.map((row) => ({ id: row._id, type: row.contentType ?? ORIGINAL_MIME }));
  });
const MINUTE = 60_000;
const collect = (t: PlatformTest) => t.mutation(internal.privacyMail.collectOrphans, {});
const maintenance = (t: PlatformTest) =>
  t.run((ctx) => ctx.db.query("privacyMaintenance").unique());
/** The first run creates the control row held from 0, as a deploy does; the operator releases. */
async function start(t: PlatformTest) {
  await collect(t);
  await t.mutation(internal.privacyMail.releaseHeldOriginals, { heldFrom: 0 });
}
/** Advances the clock with the Worker's maintenance every five minutes. */
async function elapse(t: PlatformTest, ms: number) {
  for (let left = ms; left > 0; left -= 5 * MINUTE) {
    vi.advanceTimersByTime(Math.min(left, 5 * MINUTE));
    await collect(t);
  }
}
const store = (t: PlatformTest, body: string, type: string) =>
  t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([body], { type }));
    await ctx.db.patch(id as never, { contentType: type } as never);
    return id;
  });
it("removes the original when recording fails before the commit, and a retry keeps one copy", async () => {
  const t = platformTest();
  const delivery = await signed(mime());
  handlerOf(privacyMail.recordIntake).mockImplementationOnce(() => {
    throw new Error("falha sintética antes do commit");
  });
  expect((await t.fetch("/privacy-mail", delivery.request)).status).toBe(503);
  expect(await blobs(t)).toEqual([]);
  expect(await t.query(internal.privacyMail.intake, { key: delivery.key })).toBeNull();
  expect((await t.fetch("/privacy-mail", delivery.request)).status).toBe(204);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const intake = await t.query(internal.privacyMail.intake, { key: delivery.key });
  expect(await blobs(t)).toEqual([{ id: intake!.raw, type: ORIGINAL_MIME }]);
  expect(await t.run(async (ctx) => (await ctx.storage.get(intake!.raw))!.text())).toBe(mime());
  const changed = await signed(mime() + "changed", PRIVACY_ADDRESS, delivery.key);
  expect((await t.fetch("/privacy-mail", changed.request)).status).toBe(409);
  expect(await blobs(t)).toHaveLength(1);
});
it("keeps the original when the intake committed and only the answer was lost", async () => {
  const t = platformTest();
  const delivery = await signed(mime());
  // Outside the running call, so the commit is its own transaction rather than a nested one.
  const outside = AsyncLocalStorage.snapshot();
  let committed: Promise<unknown> | undefined;
  handlerOf(privacyMail.recordIntake).mockImplementationOnce((...args: never[]) => {
    // The same call commits in its own transaction, queued ahead of the reconciliation lookup;
    // this attempt then fails as a lost answer would.
    committed = outside(() => t.mutation(internal.privacyMail.recordIntake, args[1]));
    throw new Error("resposta perdida");
  });
  expect((await t.fetch("/privacy-mail", delivery.request)).status).toBe(503);
  expect(await committed).toBe("stored");
  const intake = await t.query(internal.privacyMail.intake, { key: delivery.key });
  expect(await blobs(t)).toEqual([{ id: intake!.raw, type: ORIGINAL_MIME }]);
  expect((await t.fetch("/privacy-mail", delivery.request)).status).toBe(204);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await blobs(t)).toEqual([{ id: intake!.raw, type: ORIGINAL_MIME }]);
  expect(await t.run((ctx) => ctx.db.query("privacyMessages").collect())).toHaveLength(1);
  await start(t);
  await elapse(t, ORPHAN_GRACE + 10 * MINUTE);
  expect(await blobs(t)).toEqual([{ id: intake!.raw, type: ORIGINAL_MIME }]);
});
it("removes its own copy when a concurrent delivery of the same key recorded another", async () => {
  const t = platformTest();
  const delivery = await signed(mime());
  const outside = AsyncLocalStorage.snapshot();
  let concurrent: Promise<Response> | undefined;
  handlerOf(privacyMail.recordIntake).mockImplementationOnce(() => {
    concurrent = outside(() => t.fetch("/privacy-mail", delivery.request));
    throw new Error("falha sintética");
  });
  expect((await t.fetch("/privacy-mail", delivery.request)).status).toBe(503);
  expect((await concurrent!).status).toBe(204);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const intake = await t.query(internal.privacyMail.intake, { key: delivery.key });
  expect(await blobs(t)).toEqual([{ id: intake!.raw, type: ORIGINAL_MIME }]);
  expect(await t.run((ctx) => ctx.db.query("privacyMessages").collect())).toHaveLength(1);
});
it("refuses a late commit whose copy was already discarded, and the retry stores a new one", async () => {
  const t = platformTest();
  const delivery = await signed(mime());
  let late: unknown;
  handlerOf(privacyMail.recordIntake).mockImplementationOnce((...args: never[]) => {
    late = args[1];
    throw new Error("falha transitória");
  });
  expect((await t.fetch("/privacy-mail", delivery.request)).status).toBe(503);
  expect(await blobs(t)).toEqual([]);
  // The interrupted call commits only now: it must not record an intake without its original.
  await expect(t.mutation(internal.privacyMail.recordIntake, late as never)).rejects.toThrow();
  expect(await t.query(internal.privacyMail.intake, { key: delivery.key })).toBeNull();
  expect((await t.fetch("/privacy-mail", delivery.request)).status).toBe(204);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const intake = await t.query(internal.privacyMail.intake, { key: delivery.key });
  expect(await blobs(t)).toEqual([{ id: intake!.raw, type: ORIGINAL_MIME }]);
  expect(await t.run(async (ctx) => (await ctx.storage.get(intake!.raw))!.text())).toBe(mime());
});
it("collects unreferenced originals after the grace period, old and new, and nothing else", async () => {
  const t = platformTest();
  // Left before this fix: stored, never recorded, under the generic MIME.
  const legacy = await store(t, mime(), LEGACY_ORIGINAL_MIME);
  const otherMime = await store(t, "<xml/>", "application/xml");
  const reference = await store(t, "{}", LEGACY_ORIGINAL_MIME);
  await t.run((ctx) =>
    ctx.db.insert("referenceVersions", {
      storageId: reference,
      dataset: "ncm",
      version: "sintetica",
      manifest: "{}",
      count: 0,
      imported: 0,
      lastCode: "",
      state: "candidate",
      publishedAt: null,
      createdAt: Date.now(),
    }),
  );
  const kept = await receive(t);
  await blobs(t);
  // A received message whose intake is gone still keeps its original.
  await t.run((ctx) => ctx.db.delete("privacyIntakes", kept._id));
  vi.advanceTimersByTime(1);
  await start(t);
  // After the collector exists, a generic `message/rfc822` belongs to someone else.
  const laterLegacy = await store(t, mime(), LEGACY_ORIGINAL_MIME);
  // The discard fails too: the copy waits for the collector.
  const delivery = await signed(mime());
  handlerOf(privacyMail.recordIntake).mockImplementationOnce(() => {
    throw new Error("falha sintética");
  });
  handlerOf(privacyMail.discardUnclaimed).mockImplementationOnce(() => {
    throw new Error("indisponível");
  });
  expect((await t.fetch("/privacy-mail", delivery.request)).status).toBe(503);
  const before = [legacy, otherMime, reference, kept.raw, laterLegacy];
  const recent = (await blobs(t)).find((row) => !before.includes(row.id))!;
  expect(recent.type).toBe(ORIGINAL_MIME);
  await elapse(t, ORPHAN_GRACE - 5 * MINUTE);
  expect((await blobs(t)).map((row) => row.id).sort()).toEqual([...before, recent.id].sort());
  await elapse(t, 10 * MINUTE);
  expect((await blobs(t)).map((row) => row.id).sort()).toEqual(
    [otherMime, reference, kept.raw, laterLegacy].sort(),
  );
});
it("resumes the orphan scan across pages from the persisted cursor", async () => {
  const t = platformTest();
  for (let i = 0; i < 150; i++) await store(t, String(i), LEGACY_ORIGINAL_MIME);
  vi.advanceTimersByTime(1);
  await start(t);
  await elapse(t, ORPHAN_GRACE);
  expect(await blobs(t)).toHaveLength(50);
  expect(await maintenance(t)).toMatchObject({ cursor: expect.any(String) });
  await collect(t);
  expect(await blobs(t)).toEqual([]);
  expect(await maintenance(t)).toMatchObject({ scannedUntil: Date.now() - ORPHAN_GRACE });
});
it("holds originals after a gap in the maintenance, as after a restore, until released", async () => {
  const t = platformTest();
  await store(t, mime(), LEGACY_ORIGINAL_MIME);
  vi.advanceTimersByTime(1);
  // A new row is held from the beginning: a deploy and a restore of an older snapshot look alike.
  await collect(t);
  await elapse(t, ORPHAN_GRACE + 10 * MINUTE);
  expect(await blobs(t)).toHaveLength(1);
  await t.mutation(internal.privacyMail.releaseHeldOriginals, { heldFrom: 0 });
  await elapse(t, 5 * MINUTE);
  expect(await blobs(t)).toEqual([]);
  // The snapshot's last run; then a message arrives whose intake the restore does not bring back.
  const lastRun = (await maintenance(t))!.lastRunAt;
  vi.advanceTimersByTime(MINUTE);
  const afterSnapshot = await store(t, mime(), ORIGINAL_MIME);
  vi.advanceTimersByTime(2 * ORPHAN_GRACE);
  await collect(t);
  expect(await maintenance(t)).toMatchObject({ heldFrom: lastRun });
  await elapse(t, ORPHAN_GRACE);
  expect((await blobs(t)).map((row) => row.id)).toEqual([afterSnapshot]);
  await expect(
    t.mutation(internal.privacyMail.releaseHeldOriginals, { heldFrom: lastRun - 1 }),
  ).rejects.toThrow();
  await t.mutation(internal.privacyMail.releaseHeldOriginals, { heldFrom: lastRun });
  await elapse(t, 5 * MINUTE);
  expect(await blobs(t)).toEqual([]);
});
it("runs the collector in its own transaction, so its failure keeps the purge", async () => {
  const t = platformTest(),
    { client } = await actor(t);
  const first = await receive(t);
  await client.mutation(api.privacyMail.setStatus, { threadId: first.threadId!, status: "closed" });
  const closed = await client.query(api.privacyMail.thread, { threadId: first.threadId! });
  vi.setSystemTime(closed!.expiresAt! + 1);
  handlerOf(privacyMail.collectOrphans).mockImplementation(() => {
    throw new Error("coletor indisponível");
  });
  await t.mutation(internal.privacyMail.sweep, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers).catch(() => undefined);
  expect(await t.run((ctx) => ctx.db.get("privacyThreads", first.threadId!))).toBeNull();
  expect(await t.run((ctx) => ctx.storage.get(first.raw))).toBeNull();
});
const creation = (t: PlatformTest, id: Id<"_storage">) =>
  t.run(async (ctx) => (await ctx.db.system.get("_storage", id))!._creationTime);
it("holds manually from a given time, merging holds into the earliest, even before the row exists", async () => {
  const t = platformTest();
  await expect(
    t.mutation(internal.privacyMail.releaseHeldOriginals, { heldFrom: 0 }),
  ).rejects.toThrow();
  const from = Date.now() - MINUTE;
  await t.mutation(internal.privacyMail.holdOriginals, { from });
  expect(await maintenance(t)).toMatchObject({ heldFrom: from, scannedUntil: 0 });
  await t.mutation(internal.privacyMail.holdOriginals, { from: from + 10 });
  expect(await maintenance(t)).toMatchObject({ heldFrom: from });
  await t.mutation(internal.privacyMail.holdOriginals, { from: from - 5 });
  expect(await maintenance(t)).toMatchObject({ heldFrom: from - 5 });
  // A new gap while held keeps the reviewed boundary.
  vi.advanceTimersByTime(2 * ORPHAN_GRACE);
  await collect(t);
  expect(await maintenance(t)).toMatchObject({ heldFrom: from - 5 });
});
it("keeps an original created exactly at the hold boundary and collects the one before it", async () => {
  const t = platformTest();
  await start(t);
  await store(t, mime(), ORIGINAL_MIME);
  vi.advanceTimersByTime(1);
  const boundary = await store(t, mime(), ORIGINAL_MIME);
  await t.mutation(internal.privacyMail.holdOriginals, { from: await creation(t, boundary) });
  await elapse(t, ORPHAN_GRACE + 10 * MINUTE);
  expect((await blobs(t)).map((row) => row.id)).toEqual([boundary]);
});
it("restarts a pending scan cut by a hold and completes it after the release", async () => {
  const t = platformTest();
  for (let i = 0; i < 150; i++) await store(t, String(i), LEGACY_ORIGINAL_MIME);
  vi.advanceTimersByTime(1);
  await start(t);
  await elapse(t, ORPHAN_GRACE);
  expect(await maintenance(t)).toMatchObject({ cursor: expect.any(String) });
  await t.mutation(internal.privacyMail.holdOriginals, { from: 0 });
  await collect(t);
  expect(await blobs(t)).toHaveLength(50);
  expect((await maintenance(t))!.cursor).toBeUndefined();
  await t.mutation(internal.privacyMail.releaseHeldOriginals, { heldFrom: 0 });
  await collect(t);
  expect(await blobs(t)).toEqual([]);
});
it("deletes nothing while the collector fails and holds after the gap it leaves", async () => {
  const t = platformTest();
  await start(t);
  const orphan = await store(t, mime(), ORIGINAL_MIME);
  vi.advanceTimersByTime(5 * MINUTE);
  await collect(t);
  const lastRun = (await maintenance(t))!.lastRunAt;
  const failing = handlerOf(privacyMail.collectOrphans).mockImplementation(() => {
    throw new Error("coletor indisponível");
  });
  for (let i = 0; i < 8; i++) {
    vi.advanceTimersByTime(5 * MINUTE);
    await expect(collect(t)).rejects.toThrow();
  }
  failing.mockRestore();
  await collect(t);
  expect(await maintenance(t)).toMatchObject({ heldFrom: lastRun });
  expect((await blobs(t)).map((row) => row.id)).toEqual([orphan]);
  // The hold covers what came after the last run; the older orphan still leaves after the grace.
  await elapse(t, 20 * MINUTE);
  expect(await blobs(t)).toEqual([]);
});
it("reports a held collector in the maintenance response without content", async () => {
  const t = platformTest();
  const maintain = async () => {
    const fields = {
      timestamp: String(Date.now()),
      key: "maintenance",
      from: "",
      to: "",
      hash: await digestMail(new ArrayBuffer(0)),
    };
    const response = await t.fetch("/privacy-mail/maintenance", {
      method: "POST",
      headers: {
        [mailHeaders.timestamp]: fields.timestamp,
        [mailHeaders.key]: fields.key,
        [mailHeaders.from]: "",
        [mailHeaders.to]: "",
        [mailHeaders.signature]: await mailSignature(secret, fields),
      },
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    return response.headers.get(MAINTENANCE_HELD_HEADER);
  };
  expect(await maintain()).toBe("1");
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await maintain()).toBe("1");
  await t.mutation(internal.privacyMail.releaseHeldOriginals, { heldFrom: 0 });
  expect(await maintain()).toBeNull();
});
