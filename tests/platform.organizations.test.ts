/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import {
  canManageRole,
  membershipRoles,
  organizationCapabilities,
  type MembershipRole,
} from "../packages/contracts/src/organizations";
import schema from "../platform/convex/schema";
import { api, components, internal } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
const modules = import.meta.glob("../platform/convex/**/*.ts");
const paginationOpts = { numItems: 50, cursor: null };
const contextKey = "isolated-test";
beforeEach(() => {
  // Relógio fixo, longe de virada de dia e de mês (freecorps/no-wall-clock-in-tests).
  vi.setSystemTime(new Date("2026-06-15T15:00:00Z"));
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5182",
    CONVEX_SITE_URL: "http://127.0.0.1:3225",
    BETTER_AUTH_SECRET: "synthetic-secret-for-offline-local-tests-only",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}
async function actor(t: ReturnType<typeof setup>, verified = true) {
  const now = Date.now();
  const email = `${crypto.randomUUID()}@development.invalid`;
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Pessoa de teste",
        email,
        emailVerified: verified,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        expiresAt: now + 3600_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return {
    email,
    userId: user._id,
    sessionId: session._id,
    client: t.withIdentity({
      subject: user._id,
      sessionId: session._id,
      issuer: "http://127.0.0.1:3225",
    }),
  };
}
async function organization(t: ReturnType<typeof setup>) {
  const owner = await actor(t);
  const org = await owner.client.mutation(api.organizations.create, {
    name: "Organização de teste",
    slug: `org-${crypto.randomUUID()}`,
  });
  return { owner, ...org };
}
async function invite(
  t: ReturnType<typeof setup>,
  owner: Awaited<ReturnType<typeof actor>>,
  org: Awaited<ReturnType<typeof organization>>,
  recipient: Awaited<ReturnType<typeof actor>>,
  role: MembershipRole,
) {
  const result = await owner.client.action(api.invitations.send, {
    organizationId: org.organizationId,
    email: recipient.email,
    role,
  });
  expect(result.delivered).toBe(true);
  const inbox = await t.query(internal.mail.inbox, { email: recipient.email });
  const token = inbox.find((m) => m.type === "organization-invitation")!.otp;
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  return { ...result, token };
}
async function join(
  t: ReturnType<typeof setup>,
  org: Awaited<ReturnType<typeof organization>>,
  role: MembershipRole,
) {
  const recipient = await actor(t);
  const invitation = await invite(t, org.owner, org, recipient, role);
  await recipient.client.action(api.invitations.accept, { token: invitation.token });
  const member = await recipient.client.query(api.organizations.context, {
    slug: org.slug,
    contextKey,
  });
  return { ...recipient, member: member! };
}
it("requires a live verified identity; validation grants do not grant product membership", async () => {
  const t = setup(),
    org = await organization(t),
    unverified = await actor(t, false),
    outsider = await actor(t);
  await expect(
    t.mutation(api.organizations.create, { name: "Test", slug: "test-org" }),
  ).rejects.toThrow("UNAUTHENTICATED");
  await expect(
    unverified.client.query(api.organizations.context, { slug: org.slug, contextKey }),
  ).rejects.toThrow("EMAIL_UNVERIFIED");
  await t.mutation(internal.access.grant, { authUserId: outsider.userId, role: "operator" });
  expect(
    await outsider.client.query(api.organizations.context, { slug: org.slug, contextKey }),
  ).toBeNull();
  await expect(
    outsider.client.mutation(api.organizations.update, {
      organizationId: org.organizationId,
      name: "Forged",
    }),
  ).rejects.toThrow("ACCESS_DENIED");
  expect(
    (await outsider.client.query(api.organizations.listMine, { paginationOpts, contextKey })).page,
  ).toEqual([]);
  await t.mutation(components.betterAuth.adapter.deleteOne, {
    input: { model: "session", where: [{ field: "_id", value: org.owner.sessionId }] },
  });
  await expect(
    org.owner.client.query(api.organizations.context, { slug: org.slug, contextKey }),
  ).rejects.toThrow("UNAUTHENTICATED");
});
it.each(membershipRoles)(
  "enforces %s product capabilities and denies forged organization/target IDs",
  async (role) => {
    const t = setup(),
      org = await organization(t),
      other = await organization(t);
    const member =
      role === "owner"
        ? {
            ...org.owner,
            member: (await org.owner.client.query(api.organizations.context, {
              slug: org.slug,
              contextKey,
            }))!,
          }
        : await join(t, org, role);
    expect(member.member.capabilities).toEqual(organizationCapabilities(role));
    expect(
      await member.client.query(api.organizations.context, { slug: other.slug, contextKey }),
    ).toBeNull();
    for (const query of [
      api.organizations.members,
      api.organizations.activity,
      api.invitations.list,
    ])
      await expect(
        member.client.query(query, {
          organizationId: other.organizationId,
          paginationOpts,
          contextKey,
        }),
      ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      member.client.mutation(api.organizations.update, {
        organizationId: other.organizationId,
        name: "Forged",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    const foreign = (await other.owner.client.query(api.organizations.context, {
      slug: other.slug,
      contextKey,
    }))!;
    await expect(
      member.client.mutation(api.organizations.changeRole, {
        organizationId: org.organizationId,
        membershipId: foreign.membershipId,
        role: "viewer",
        expectedVersion: foreign.membershipVersion,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    const read = member.client.query(api.organizations.members, {
      organizationId: org.organizationId,
      paginationOpts,
      contextKey,
    });
    const rename = member.client.mutation(api.organizations.update, {
      organizationId: org.organizationId,
      name: "Renamed",
    });
    if (role === "owner" || role === "admin") {
      expect((await read).page.length).toBeGreaterThan(0);
      await rename;
    } else {
      await expect(read).rejects.toThrow("ACCESS_DENIED");
      await expect(rename).rejects.toThrow("ACCESS_DENIED");
    }
    if (role !== "owner")
      await expect(
        member.client.mutation(api.organizations.changeRole, {
          organizationId: org.organizationId,
          membershipId: member.member.membershipId,
          role: "owner",
          expectedVersion: member.member.membershipVersion,
        }),
      ).rejects.toThrow("ACCESS_DENIED");
  },
);
it("checks the complete grant matrix in the server and shared contract", async () => {
  const t = setup(),
    org = await organization(t);
  const actors = {
    owner: org.owner,
    admin: await join(t, org, "admin"),
    developer: await join(t, org, "developer"),
    operator: await join(t, org, "operator"),
    viewer: await join(t, org, "viewer"),
  };
  for (const actorRole of membershipRoles)
    for (const targetRole of membershipRoles) {
      const recipient = await actor(t);
      const attempt = actors[actorRole].client.action(api.invitations.send, {
        organizationId: org.organizationId,
        email: recipient.email,
        role: targetRole,
      });
      if (canManageRole(actorRole, targetRole)) expect((await attempt).delivered).toBe(true);
      else await expect(attempt).rejects.toThrow("ACCESS_DENIED");
    }
});
it("protects the last owner and uses versions to refuse stale membership edits", async () => {
  const t = setup(),
    org = await organization(t);
  const owner = (await org.owner.client.query(api.organizations.context, {
    slug: org.slug,
    contextKey,
  }))!;
  const args = {
    organizationId: org.organizationId,
    membershipId: owner.membershipId,
    expectedVersion: owner.membershipVersion,
  };
  await expect(org.owner.client.mutation(api.organizations.removeMember, args)).rejects.toThrow(
    "LAST_OWNER",
  );
  await expect(
    org.owner.client.mutation(api.organizations.changeRole, { ...args, role: "admin" }),
  ).rejects.toThrow("LAST_OWNER");
  const second = await join(t, org, "owner");
  await org.owner.client.mutation(api.organizations.changeRole, { ...args, role: "viewer" });
  await expect(second.client.mutation(api.organizations.removeMember, args)).rejects.toThrow(
    "MEMBERSHIP_CHANGED",
  );
  expect(
    (await second.client.query(api.organizations.context, { slug: org.slug, contextKey }))!
      .ownerCount,
  ).toBe(1);
});
it("consumes once, rejects wrong/unverified accounts, and stores only the hash in domain/audit", async () => {
  const t = setup(),
    org = await organization(t),
    recipient = await actor(t),
    wrong = await actor(t),
    unverified = await actor(t, false);
  const invitation = await invite(t, org.owner, org, recipient, "operator");
  await expect(
    wrong.client.action(api.invitations.preview, { token: invitation.token }),
  ).rejects.toThrow("INVITATION_UNAVAILABLE");
  await expect(
    wrong.client.action(api.invitations.accept, { token: invitation.token }),
  ).rejects.toThrow("INVITATION_UNAVAILABLE");
  await expect(
    unverified.client.action(api.invitations.accept, { token: invitation.token }),
  ).rejects.toThrow("EMAIL_UNVERIFIED");
  expect(
    await recipient.client.action(api.invitations.preview, { token: invitation.token }),
  ).toMatchObject({ organizationName: "Organização de teste", role: "operator" });
  await recipient.client.action(api.invitations.accept, { token: invitation.token });
  await expect(
    recipient.client.action(api.invitations.accept, { token: invitation.token }),
  ).rejects.toThrow("INVITATION_UNAVAILABLE");
  await t.run(async (ctx) => {
    const stored = await ctx.db.get("invitations", invitation.invitationId);
    expect(stored!.tokenHash).not.toBe(invitation.token);
    expect(JSON.stringify(stored)).not.toContain(invitation.token);
    const audit = await ctx.db.query("organizationAudit").collect();
    expect(JSON.stringify(audit)).not.toContain(invitation.token);
    expect(audit.filter((e) => e.action === "member.joined")).toHaveLength(1);
  });
});
it.each(["expired", "revoked", "issuer-removed", "issuer-role-changed"] as const)(
  "rejects an invitation when %s",
  async (failure) => {
    const t = setup(),
      org = await organization(t),
      issuer = await join(t, org, "admin"),
      recipient = await actor(t);
    const invitation = await invite(t, issuer, org, recipient, "viewer");
    if (failure === "expired")
      await t.run((ctx) =>
        ctx.db.patch("invitations", invitation.invitationId, { expiresAt: Date.now() - 1 }),
      );
    if (failure === "revoked")
      await org.owner.client.mutation(api.invitations.revoke, {
        organizationId: org.organizationId,
        invitationId: invitation.invitationId,
      });
    if (failure === "issuer-removed")
      await org.owner.client.mutation(api.organizations.removeMember, {
        organizationId: org.organizationId,
        membershipId: issuer.member.membershipId,
        expectedVersion: issuer.member.membershipVersion,
      });
    if (failure === "issuer-role-changed")
      await org.owner.client.mutation(api.organizations.changeRole, {
        organizationId: org.organizationId,
        membershipId: issuer.member.membershipId,
        expectedVersion: issuer.member.membershipVersion,
        role: "viewer",
      });
    await expect(
      recipient.client.action(api.invitations.accept, { token: invitation.token }),
    ).rejects.toThrow("INVITATION_UNAVAILABLE");
  },
);
it("revokes all private queries and mutations on removal, including previously read contexts", async () => {
  const t = setup(),
    org = await organization(t),
    member = await join(t, org, "admin");
  expect(
    (
      await member.client.query(api.organizations.members, {
        organizationId: org.organizationId,
        paginationOpts,
        contextKey,
      })
    ).page,
  ).toHaveLength(2);
  await org.owner.client.mutation(api.organizations.removeMember, {
    organizationId: org.organizationId,
    membershipId: member.member.membershipId,
    expectedVersion: member.member.membershipVersion,
  });
  expect(
    await member.client.query(api.organizations.context, { slug: org.slug, contextKey }),
  ).toBeNull();
  expect(
    (await member.client.query(api.organizations.listMine, { paginationOpts, contextKey })).page,
  ).toEqual([]);
  for (const query of [api.organizations.members, api.organizations.activity, api.invitations.list])
    await expect(
      member.client.query(query, {
        organizationId: org.organizationId,
        paginationOpts,
        contextKey,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
  await expect(
    member.client.mutation(api.organizations.update, {
      organizationId: org.organizationId,
      name: "Forged",
    }),
  ).rejects.toThrow("ACCESS_DENIED");
});
it("does not let another invitation overwrite an active membership", async () => {
  const t = setup(),
    org = await organization(t),
    member = await join(t, org, "viewer");
  const invitation = await invite(t, org.owner, org, member, "owner");
  await expect(
    member.client.action(api.invitations.accept, { token: invitation.token }),
  ).rejects.toThrow("ALREADY_MEMBER");
  expect(
    (await member.client.query(api.organizations.context, { slug: org.slug, contextKey }))!.role,
  ).toBe("viewer");
  await org.owner.client.mutation(api.organizations.removeMember, {
    organizationId: org.organizationId,
    membershipId: member.member.membershipId,
    expectedVersion: member.member.membershipVersion,
  });
  await expect(
    member.client.action(api.invitations.accept, { token: invitation.token }),
  ).rejects.toThrow("INVITATION_UNAVAILABLE");
});

it("keeps an ambiguous hosted delivery unusable and requires an explicit fresh send", async () => {
  const t = setup(),
    org = await organization(t),
    recipient = await actor(t);
  for (const [key, value] of Object.entries({
    APP_ENV: "validation",
    EMAIL_MODE: "cloudflare",
    SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    CONVEX_SITE_URL: "https://modest-seal-118.convex.site",
    AUTH_PROXY_MODE: "signed",
    AUTH_PROXY_SECRET: "a".repeat(64),
    CLOUDFLARE_EMAIL_API_TOKEN: "synthetic-provider-token",
    ACCOUNT_EMAIL_FROM: "sender@validation.invalid",
    ACCOUNT_EMAIL_RECIPIENTS: recipient.email,
  }))
    vi.stubEnv(key, value);
  const payloads: { text: string }[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (typeof init.body !== "string") throw new Error("Expected JSON request");
    payloads.push(JSON.parse(init.body));
    return new Response("private provider body", { status: 503 });
  });
  vi.stubGlobal("fetch", fetch);
  const args = {
    organizationId: org.organizationId,
    email: recipient.email,
    role: "viewer" as const,
  };
  const first = await org.owner.client.action(api.invitations.send, args);
  expect(first.delivered).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  const firstCode = payloads[0].text.match(/[a-f0-9]{64}/)![0];
  await expect(
    recipient.client.action(api.invitations.accept, { token: firstCode }),
  ).rejects.toThrow("INVITATION_UNAVAILABLE");
  fetch.mockImplementation(async (_url, init) => {
    if (typeof init.body !== "string") throw new Error("Expected JSON request");
    payloads.push(JSON.parse(init.body));
    return Response.json({
      success: true,
      result: { queued: [recipient.email], permanent_bounces: [] },
    });
  });
  const second = await org.owner.client.action(api.invitations.send, args);
  expect(second.delivered).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  const secondCode = payloads[1].text.match(/[a-f0-9]{64}/)![0];
  expect(secondCode).not.toBe(firstCode);
  await recipient.client.action(api.invitations.accept, { token: secondCode });
  expect(
    JSON.stringify(
      await org.owner.client.query(api.invitations.list, {
        organizationId: org.organizationId,
        paginationOpts,
        contextKey,
      }),
    ),
  ).not.toContain("private provider body");
});

it("cannot finalize a delivery after its invitation was revoked", async () => {
  const t = setup(),
    org = await organization(t),
    recipient = await actor(t);
  const invitationId = await org.owner.client.mutation(internal.invitations.reserve, {
    organizationId: org.organizationId,
    email: recipient.email,
    role: "viewer",
    tokenHash: "a".repeat(64),
  });
  await org.owner.client.mutation(api.invitations.revoke, {
    organizationId: org.organizationId,
    invitationId,
  });
  expect(
    await t.mutation(internal.invitations.finishDelivery, { invitationId, delivered: true }),
  ).toBe(false);
  await t.run(async (ctx) => {
    expect((await ctx.db.get("invitations", invitationId))!.status).toBe("revoked");
  });
});

it("checks the organization of invitation IDs and the role of existing member targets", async () => {
  const t = setup(),
    org = await organization(t),
    other = await organization(t),
    admin = await join(t, org, "admin"),
    recipient = await actor(t);
  const foreign = await invite(t, other.owner, other, recipient, "viewer");
  await expect(
    org.owner.client.mutation(api.invitations.revoke, {
      organizationId: org.organizationId,
      invitationId: foreign.invitationId,
    }),
  ).rejects.toThrow("ACCESS_DENIED");
  await expect(
    admin.client.action(api.invitations.send, {
      organizationId: other.organizationId,
      email: recipient.email,
      role: "viewer",
    }),
  ).rejects.toThrow("ACCESS_DENIED");
  const ownerContext = (await org.owner.client.query(api.organizations.context, {
    slug: org.slug,
    contextKey,
  }))!;
  const args = {
    organizationId: org.organizationId,
    membershipId: ownerContext.membershipId,
    expectedVersion: ownerContext.membershipVersion,
  };
  await expect(
    admin.client.mutation(api.organizations.changeRole, { ...args, role: "viewer" }),
  ).rejects.toThrow("ACCESS_DENIED");
  await expect(admin.client.mutation(api.organizations.removeMember, args)).rejects.toThrow(
    "ACCESS_DENIED",
  );
});

it("paginates every owned organization without leaking another account's membership", async () => {
  const t = setup(),
    user = await actor(t),
    outsider = await actor(t);
  await t.run(async (ctx) => {
    for (let index = 0; index < 55; index++) {
      const organizationId = await ctx.db.insert("organizations", {
        name: `Page ${index}`,
        slug: `page-${index}`,
        ownerCount: 1,
        memberCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        organizationId,
        authUserId: user.userId,
        name: "Page owner",
        email: user.email,
        role: "owner",
        state: "active",
        version: 1,
        joinedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  });
  const first = await user.client.query(api.organizations.listMine, {
    paginationOpts: { numItems: 100, cursor: null },
    contextKey,
  });
  expect(first.page).toHaveLength(50);
  expect(first.isDone).toBe(false);
  const second = await user.client.query(api.organizations.listMine, {
    paginationOpts: { numItems: 100, cursor: first.continueCursor },
    contextKey,
  });
  expect(second.page).toHaveLength(5);
  expect(second.isDone).toBe(true);
  expect(new Set([...first.page, ...second.page].map((org) => org.id)).size).toBe(55);
  expect(
    (await outsider.client.query(api.organizations.listMine, { paginationOpts, contextKey })).page,
  ).toEqual([]);
});

it("rejects duplicate pending invitations and lets a revoked member rejoin only by a new invitation", async () => {
  const t = setup(),
    org = await organization(t),
    member = await join(t, org, "viewer");
  const invitation = await invite(t, org.owner, org, member, "viewer");
  await expect(
    org.owner.client.action(api.invitations.send, {
      organizationId: org.organizationId,
      email: member.email,
      role: "viewer",
    }),
  ).rejects.toThrow("INVITATION_PENDING");
  await org.owner.client.mutation(api.organizations.removeMember, {
    organizationId: org.organizationId,
    membershipId: member.member.membershipId,
    expectedVersion: member.member.membershipVersion,
  });
  await expect(
    member.client.action(api.invitations.accept, { token: invitation.token }),
  ).rejects.toThrow("INVITATION_UNAVAILABLE");
  const fresh = await invite(t, org.owner, org, member, "operator");
  await member.client.action(api.invitations.accept, { token: fresh.token });
  const current = await member.client.query(api.organizations.context, {
    slug: org.slug,
    contextKey,
  });
  expect(current!.membershipId).toBe(member.member.membershipId);
  expect(current!.role).toBe("operator");
  expect(current!.memberCount).toBe(2);
  expect(current!.membershipVersion).toBeGreaterThan(member.member.membershipVersion);
});

it("keeps the native split metadata in organizations, members, activity and invitations pages", async () => {
  const t = setup(),
    org = await organization(t),
    other = await organization(t);
  const now = Date.now();
  await t.run(async (ctx) => {
    const issuer = (await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", org.organizationId).eq("state", "active"),
      )
      .first())!;
    for (let index = 0; index < 6; index++) {
      const organizationId = await ctx.db.insert("organizations", {
        name: `Split ${index}`,
        slug: `split-${crypto.randomUUID()}`,
        ownerCount: 1,
        memberCount: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("memberships", {
        organizationId,
        authUserId: org.owner.userId,
        name: "Pessoa de teste",
        email: org.owner.email,
        role: "owner",
        state: "active",
        version: 1,
        joinedAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("memberships", {
        organizationId: org.organizationId,
        authUserId: `member-${index}`,
        name: `Membro ${index}`,
        email: `member-${index}@development.invalid`,
        role: "viewer",
        state: "active",
        version: 1,
        joinedAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("organizationAudit", {
        organizationId: org.organizationId,
        actorUserId: org.owner.userId,
        action: "member.joined",
        target: `member-${index}`,
        createdAt: now,
      });
      await ctx.db.insert("invitations", {
        organizationId: org.organizationId,
        email: `invite-${index}@development.invalid`,
        role: "viewer",
        tokenHash: crypto.randomUUID(),
        status: "pending",
        expiresAt: now + 3600_000,
        issuerMembershipId: issuer._id,
        issuerVersion: issuer.version,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  const scoped = { organizationId: org.organizationId, contextKey };
  type Options = {
    cursor: string | null;
    endCursor?: string;
    numItems: number;
    maximumRowsRead?: number;
  };
  const paths = {
    listMine: (opts: Options) =>
      org.owner.client.query(api.organizations.listMine, { paginationOpts: opts, contextKey }),
    members: (opts: Options) =>
      org.owner.client.query(api.organizations.members, { ...scoped, paginationOpts: opts }),
    activity: (opts: Options) =>
      org.owner.client.query(api.organizations.activity, { ...scoped, paginationOpts: opts }),
    invitations: (opts: Options) =>
      org.owner.client.query(api.invitations.list, { ...scoped, paginationOpts: opts }),
  };
  const ids = (page: { id: string }[]) => page.map((item) => item.id);
  for (const [path, read] of Object.entries(paths)) {
    const whole = await read({ cursor: null, numItems: 50 });
    expect(whole.isDone, path).toBe(true);
    expect(whole.pageStatus ?? null, path).not.toBe("SplitRequired");
    expect(whole.page.length, path).toBeGreaterThanOrEqual(6);

    const split = await read({ cursor: null, numItems: 50, maximumRowsRead: 4 });
    expect(split.pageStatus, path).toBe("SplitRequired");
    expect(split.splitCursor, path).toEqual(expect.any(String));
    expect(split.isDone, path).toBe(false);
    expect(ids(split.page), path).toEqual(ids(whole.page).slice(0, 4));

    // What the Convex client does on SplitRequired: reread the same range in two halves.
    const head = await read({ cursor: null, endCursor: split.splitCursor!, numItems: 50 });
    const tail = await read({
      cursor: split.splitCursor!,
      endCursor: split.continueCursor,
      numItems: 50,
    });
    expect([...ids(head.page), ...ids(tail.page)], path).toEqual(ids(split.page));
  }
  // The split pages stay scoped: another organization's manager sees none of these rows.
  const foreign = await other.owner.client.query(api.organizations.members, {
    organizationId: other.organizationId,
    contextKey,
    paginationOpts: { cursor: null, numItems: 50, maximumRowsRead: 4 },
  });
  expect(foreign.page.map((m) => m.email)).toEqual([other.owner.email]);
  await expect(
    other.owner.client.query(api.invitations.list, {
      ...scoped,
      paginationOpts: { cursor: null, numItems: 50, maximumRowsRead: 4 },
    }),
  ).rejects.toThrow();
});
