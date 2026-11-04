import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import schema from "./schema";
import { api, components, internal } from "./_generated/api";
import { register } from "../test-setup";
import { modules } from "../../tests/helpers/convex-modules";

const contextKey = "isolated-test";
beforeEach(() => {
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
});
function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}
type T = ReturnType<typeof setup>;
async function actor(t: T, verified = true) {
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
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "account",
      data: {
        accountId: user._id,
        providerId: "credential",
        userId: user._id,
        password: "synthetic-hash",
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return {
    email,
    userId: user._id as string,
    client: t.withIdentity({
      subject: user._id,
      sessionId: session._id,
      issuer: "http://127.0.0.1:3225",
    }),
  };
}
type Actor = Awaited<ReturnType<typeof actor>>;
async function organization(owner: Actor) {
  const slug = `org-${crypto.randomUUID()}`;
  const org = await owner.client.mutation(api.organizations.create, {
    name: "Organização de teste",
    slug,
  });
  return { ...org, owner };
}
async function join(t: T, org: Awaited<ReturnType<typeof organization>>, member: Actor) {
  await org.owner.client.action(api.invitations.send, {
    organizationId: org.organizationId,
    email: member.email,
    role: "operator",
  });
  const token = (await t.query(internal.mail.inbox, { email: member.email })).find(
    (m) => m.type === "organization-invitation",
  )!.otp;
  await member.client.action(api.invitations.accept, { token });
  return (await member.client.query(api.organizations.context, { slug: org.slug, contextKey }))!;
}
async function remove(org: Awaited<ReturnType<typeof organization>>, membershipId: string) {
  const members = await org.owner.client.query(api.organizations.members, {
    organizationId: org.organizationId,
    paginationOpts: { numItems: 50, cursor: null },
    contextKey,
  });
  const target = members.page.find((m) => m.id === membershipId)!;
  await org.owner.client.mutation(api.organizations.removeMember, {
    organizationId: org.organizationId,
    membershipId: target.id,
    expectedVersion: target.version,
  });
}
const memberships = (t: T, authUserId: string) =>
  t.run((ctx) =>
    ctx.db
      .query("memberships")
      .filter((q) => q.eq(q.field("authUserId"), authUserId))
      .collect(),
  );
const rows = (t: T, model: "session" | "account" | "verification", field: string, value: string) =>
  t.query(components.betterAuth.adapter.findMany, {
    model,
    where: [{ field, value }],
    paginationOpts: { cursor: null, numItems: 100 },
  });
const findUser = (t: T, id: string) =>
  t.query(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [{ field: "_id", value: id }],
  });
async function verification(t: T, identifier: string) {
  const now = Date.now();
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "verification",
      data: {
        identifier,
        value: "hashed:0",
        expiresAt: now + 600_000,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
}
async function emailCode(t: T, email: string) {
  return (await t.query(internal.mail.inbox, { email })).find((m) => m.type === "email-change")
    ?.otp;
}

it("corrects the name in the account and in every membership of the holder only", async () => {
  const t = setup();
  const person = await actor(t),
    other = await actor(t);
  const first = await organization(await actor(t)),
    second = await organization(await actor(t));
  const removed = await join(t, first, person);
  await join(t, second, person);
  await join(t, second, other);
  await remove(first, removed.membershipId);

  await expect(person.client.mutation(api.account.rename, { name: " x " })).rejects.toThrow(
    "INVALID_NAME",
  );
  await person.client.mutation(api.account.rename, { name: "  Nome Corrigido " });

  expect(await person.client.query(api.access.session, {})).toMatchObject({
    name: "Nome Corrigido",
  });
  const own = await memberships(t, person.userId);
  expect(own.map((m) => [m.state, m.name]).sort(([a], [b]) => a.localeCompare(b))).toEqual([
    ["active", "Nome Corrigido"],
    ["removed", "Nome Corrigido"],
  ]);
  expect((await memberships(t, other.userId))[0].name).toBe("Pessoa de teste");
  // The version guards role changes and issued invitations: a correction leaves it.
  expect(own.find((m) => m.state === "active")!.version).toBe(1);

  const unverified = await actor(t, false);
  await expect(unverified.client.mutation(api.account.rename, { name: "Outro" })).rejects.toThrow(
    "EMAIL_UNVERIFIED",
  );
  await expect(t.mutation(api.account.rename, { name: "Outro" })).rejects.toThrow(
    "UNAUTHENTICATED",
  );
});

it("changes the e-mail only with the code sent to the new address and ends the sessions", async () => {
  const t = setup();
  const person = await actor(t);
  const org = await organization(await actor(t));
  await join(t, org, person);
  const next = `Novo-${crypto.randomUUID()}@Development.Invalid`;
  const normalized = next.toLowerCase();
  await verification(t, `forget-password-otp-${person.email}`);
  await verification(t, `email-verification-otp-${normalized}`);

  await person.client.action(api.account.requestEmailChange, { email: next });
  const code = await emailCode(t, normalized);
  expect(code).toMatch(/^\d{8}$/);
  const wrong = code === "00000000" ? "11111111" : "00000000";
  expect(await person.client.mutation(api.account.confirmEmailChange, { code: wrong })).toBe(
    "invalid",
  );
  expect(await findUser(t, person.userId)).toMatchObject({ email: person.email });

  expect(await person.client.mutation(api.account.confirmEmailChange, { code: code! })).toBe(
    "changed",
  );
  expect(await findUser(t, person.userId)).toMatchObject({
    email: normalized,
    emailVerified: true,
  });
  expect((await memberships(t, person.userId)).map((m) => m.email)).toEqual([normalized]);
  expect((await rows(t, "session", "userId", person.userId)).page).toEqual([]);
  for (const identifier of [
    `forget-password-otp-${person.email}`,
    `email-verification-otp-${normalized}`,
  ])
    expect((await rows(t, "verification", "identifier", identifier)).page).toEqual([]);
  await expect(person.client.query(api.access.session, {})).resolves.toBeNull();
  expect(await t.run((ctx) => ctx.db.query("emailChanges").collect())).toEqual([]);
});

it("refuses an address of another account and an unverified or unchanged request", async () => {
  const t = setup();
  const person = await actor(t),
    taken = await actor(t),
    unverified = await actor(t, false);
  await expect(
    unverified.client.action(api.account.requestEmailChange, { email: "x@development.invalid" }),
  ).rejects.toThrow("EMAIL_UNVERIFIED");
  await expect(
    person.client.action(api.account.requestEmailChange, { email: person.email }),
  ).rejects.toThrow("EMAIL_UNCHANGED");

  // Same answer as a free address, but no code leaves for an address already in use.
  expect(
    await person.client.action(api.account.requestEmailChange, { email: taken.email }),
  ).toEqual({
    requestAccepted: true,
  });
  expect(await emailCode(t, taken.email)).toBeUndefined();
  expect(await person.client.mutation(api.account.confirmEmailChange, { code: "12345678" })).toBe(
    "invalid",
  );

  // An account created with the address after the code left: refused after a valid code.
  const late = `late-${crypto.randomUUID()}@development.invalid`;
  await person.client.action(api.account.requestEmailChange, { email: late });
  const code = (await emailCode(t, late))!;
  const now = Date.now();
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Outra conta",
        email: late,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  expect(await person.client.mutation(api.account.confirmEmailChange, { code })).toBe(
    "unavailable",
  );
  expect(await findUser(t, person.userId)).toMatchObject({ email: person.email });
  expect((await rows(t, "session", "userId", person.userId)).page).toHaveLength(1);
});

it("bounds the attempts and the lifetime of an e-mail change code", async () => {
  const t = setup();
  const person = await actor(t);
  const next = `next-${crypto.randomUUID()}@development.invalid`;
  await person.client.action(api.account.requestEmailChange, { email: next });
  const code = (await emailCode(t, next))!;
  const wrong = code === "00000000" ? "11111111" : "00000000";
  expect(await person.client.mutation(api.account.confirmEmailChange, { code: wrong })).toBe(
    "invalid",
  );
  expect(await person.client.mutation(api.account.confirmEmailChange, { code: "abc" })).toBe(
    "invalid",
  );
  expect(await person.client.mutation(api.account.confirmEmailChange, { code: wrong })).toBe(
    "exhausted",
  );
  expect(await person.client.mutation(api.account.confirmEmailChange, { code })).toBe("invalid");

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
  await person.client.action(api.account.requestEmailChange, { email: next });
  const fresh = (await emailCode(t, next))!;
  vi.setSystemTime(Date.now() + 11 * 60_000);
  expect(await person.client.mutation(api.account.confirmEmailChange, { code: fresh })).toBe(
    "expired",
  );
  expect(await findUser(t, person.userId)).toMatchObject({ email: person.email });
});

it("refuses the deletion while a membership is active and lists what is missing", async () => {
  const t = setup();
  const owner = await actor(t);
  const org = await organization(owner);
  expect(await owner.client.query(api.account.deletion, {})).toEqual({
    blockers: [
      {
        organizationId: org.organizationId,
        name: "Organização de teste",
        slug: org.slug,
        role: "owner",
        onlyOwner: true,
      },
    ],
    more: false,
  });
  await expect(
    owner.client.mutation(api.account.remove, { confirmation: owner.email }),
  ).rejects.toThrow("ACCOUNT_HAS_MEMBERSHIPS");
  await expect(
    owner.client.mutation(api.account.remove, { confirmation: "other@x.invalid" }),
  ).rejects.toThrow("CONFIRMATION_MISMATCH");
  expect(await findUser(t, owner.userId)).not.toBeNull();
  const unverified = await actor(t, false);
  await expect(
    unverified.client.mutation(api.account.remove, { confirmation: unverified.email }),
  ).rejects.toThrow("EMAIL_UNVERIFIED");
});

it("deletes the account, anonymizes its memberships and revokes open invitations everywhere", async () => {
  const t = setup();
  const person = await actor(t),
    colleague = await actor(t);
  const first = await organization(await actor(t)),
    second = await organization(await actor(t));
  const member = await join(t, first, person);
  await join(t, first, colleague);
  await remove(first, member.membershipId);
  // An invitation still open in another organization would serve whoever registered the address.
  const open = await second.owner.client.action(api.invitations.send, {
    organizationId: second.organizationId,
    email: person.email,
    role: "viewer",
  });
  const third = await organization(await actor(t));
  const another = await third.owner.client.action(api.invitations.send, {
    organizationId: third.organizationId,
    email: person.email,
    role: "operator",
  });
  await t.mutation(internal.access.grant, { authUserId: person.userId, role: "viewer" });
  await verification(t, `forget-password-otp-${person.email}`);

  expect(await person.client.query(api.account.deletion, {})).toEqual({
    blockers: [],
    more: false,
  });
  await person.client.mutation(api.account.remove, {
    confirmation: ` ${person.email.toUpperCase()} `,
  });

  expect(await findUser(t, person.userId)).toBeNull();
  for (const model of ["session", "account"] as const)
    expect((await rows(t, model, "userId", person.userId)).page).toEqual([]);
  expect(
    (await rows(t, "verification", "identifier", `forget-password-otp-${person.email}`)).page,
  ).toEqual([]);
  const [anonymized] = await memberships(t, person.userId);
  expect(anonymized).toMatchObject({
    name: "Conta excluída",
    email: "",
    state: "removed",
    role: "operator",
    authUserId: person.userId,
    joinedAt: expect.any(Number),
  });
  expect((await memberships(t, colleague.userId))[0]).toMatchObject({
    name: "Pessoa de teste",
    email: colleague.email,
  });
  for (const id of [open.invitationId, another.invitationId])
    expect(await t.run((ctx) => ctx.db.get("invitations", id))).toMatchObject({
      status: "revoked",
      email: "",
    });
  // Closed invitations keep status and role for the organization, without the address.
  const invitations = await t.run((ctx) => ctx.db.query("invitations").collect());
  expect(invitations.filter((i) => i.email === person.email)).toEqual([]);
  expect(
    invitations
      .filter((i) => i.organizationId === first.organizationId)
      .map((i) => [i.status, i.email])
      .sort(([a], [b]) => a.localeCompare(b)),
  ).toEqual([
    ["accepted", ""],
    ["accepted", colleague.email],
  ]);
  expect(
    await t.run((ctx) =>
      ctx.db
        .query("validationAccess")
        .withIndex("by_authUserId", (q) => q.eq("authUserId", person.userId))
        .unique(),
    ),
  ).toBeNull();
  await expect(person.client.query(api.access.session, {})).resolves.toBeNull();
});

it("lets a login without membership delete its own account", async () => {
  const t = setup();
  const person = await actor(t);
  await person.client.mutation(api.account.remove, { confirmation: person.email });
  expect(await findUser(t, person.userId)).toBeNull();
  await expect(
    person.client.mutation(api.account.remove, { confirmation: person.email }),
  ).rejects.toThrow("UNAUTHENTICATED");
});

it("reapplies a deletion over a restored snapshot and stops at a sole owner", async () => {
  const t = setup();
  // The restored snapshot predates both the removal from the organization and the deletion.
  const person = await actor(t);
  const org = await organization(await actor(t));
  const member = await join(t, org, person);
  const other = await organization(await actor(t));
  const open = await other.owner.client.action(api.invitations.send, {
    organizationId: other.organizationId,
    email: person.email,
    role: "viewer",
  });

  expect(await t.mutation(internal.account.reapplyDeletion, { authUserId: person.userId })).toEqual(
    {
      state: "applied",
      blockedOrganizations: [],
    },
  );
  expect(await findUser(t, person.userId)).toBeNull();
  expect((await rows(t, "session", "userId", person.userId)).page).toEqual([]);
  expect(await t.run((ctx) => ctx.db.get("memberships", member.membershipId))).toMatchObject({
    state: "removed",
    name: "Conta excluída",
    email: "",
  });
  expect(await t.run((ctx) => ctx.db.get("organizations", org.organizationId))).toMatchObject({
    memberCount: 1,
    ownerCount: 1,
  });
  expect(await t.run((ctx) => ctx.db.get("invitations", open.invitationId))).toMatchObject({
    status: "revoked",
  });
  expect(await t.mutation(internal.account.reapplyDeletion, { authUserId: person.userId })).toEqual(
    {
      state: "unchanged",
      blockedOrganizations: [],
    },
  );

  const owner = await actor(t);
  const sole = await organization(owner);
  expect(await t.mutation(internal.account.reapplyDeletion, { authUserId: owner.userId })).toEqual({
    state: "blocked",
    blockedOrganizations: [sole.organizationId],
  });
  expect(await findUser(t, owner.userId)).not.toBeNull();
  expect((await memberships(t, owner.userId))[0]).toMatchObject({
    state: "active",
    email: owner.email,
  });
});
