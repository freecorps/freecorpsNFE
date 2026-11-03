import { expect, it, vi } from "vite-plus/test";
import { hasSessionHint } from "./session-hint";
import {
  organizationSlugOf,
  prewarmOrganization,
  takeOrganizationKey,
} from "./organization-prewarm";

const now = Date.parse("2026-10-16T12:00:00Z");
const storage = (value: string | null) => () => ({ getItem: () => value });
const cookie = (cookies: Record<string, unknown>) => storage(JSON.stringify(cookies));

it("sees a session only in an unexpired Better Auth session cookie", () => {
  const token = { value: "abc.def", expires: "2026-10-16T13:00:00.000Z" };
  expect(hasSessionHint(cookie({ "better-auth.session_token": token }), now)).toBe(true);
  // The secure prefix of HTTPS deployments.
  expect(hasSessionHint(cookie({ "__Secure-better-auth.session_token": token }), now)).toBe(true);
  // A session cookie without an expiry lasts while the storage keeps it.
  expect(
    hasSessionHint(cookie({ "better-auth.session_token": { value: "x", expires: null } }), now),
  ).toBe(true);
  expect(
    hasSessionHint(
      cookie({ "better-auth.session_token": { ...token, expires: "2026-10-16T11:59:59.000Z" } }),
      now,
    ),
  ).toBe(false);
  // Only the Convex token, an empty value or another cookie: no session.
  expect(hasSessionHint(cookie({ "better-auth.convex_jwt": token }), now)).toBe(false);
  expect(
    hasSessionHint(cookie({ "better-auth.session_token": { ...token, value: "" } }), now),
  ).toBe(false);
  expect(
    hasSessionHint(cookie({ "better-auth.session_token": { ...token, expires: "amanhã" } }), now),
  ).toBe(false);
});

it("treats a missing, malformed or unreadable storage as no session", () => {
  expect(hasSessionHint(storage(null), now)).toBe(false);
  expect(hasSessionHint(storage("{"), now)).toBe(false);
  expect(hasSessionHint(storage("null"), now)).toBe(false);
  expect(hasSessionHint(storage('"texto"'), now)).toBe(false);
  expect(hasSessionHint(() => undefined, now)).toBe(false);
  expect(
    hasSessionHint(() => {
      throw new Error("SecurityError");
    }, now),
  ).toBe(false);
});

it("reads the organization of the address only under /app/<slug>", () => {
  expect(organizationSlugOf("/app/equipe-ipe")).toBe("equipe-ipe");
  expect(organizationSlugOf("/app/equipe-ipe/documents")).toBe("equipe-ipe");
  expect(organizationSlugOf("/app")).toBeUndefined();
  expect(organizationSlugOf("/app/")).toBeUndefined();
  expect(organizationSlugOf("/console")).toBeUndefined();
  expect(organizationSlugOf("/apps/equipe")).toBeUndefined();
});

it("asks for the organization once and hands its key to the first entry only", () => {
  vi.useFakeTimers({ now });
  try {
    const client = { prewarmQuery: vi.fn() };
    prewarmOrganization(client, "equipe");
    prewarmOrganization(client, "equipe");
    expect(client.prewarmQuery).toHaveBeenCalledTimes(1);
    const { args } = client.prewarmQuery.mock.calls[0][0] as {
      args: { slug: string; contextKey: string };
    };
    expect(args.slug).toBe("equipe");
    expect(takeOrganizationKey("outra")).toBeUndefined();
    expect(takeOrganizationKey("equipe")).toBe(args.contextKey);
    // A later entry of the same address draws its own key, as always.
    expect(takeOrganizationKey("equipe")).toBeUndefined();
    // A reservation that waited too long is not used.
    prewarmOrganization(client, "lenta");
    vi.advanceTimersByTime(10_001);
    expect(takeOrganizationKey("lenta")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
