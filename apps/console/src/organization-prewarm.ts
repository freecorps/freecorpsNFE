import type { ConvexReactClient } from "convex/react";
import { api } from "../../../platform/convex/_generated/api";

/**
 * The cold load of `/app/<slug>` asks for `organizations.context` together with the session,
 * instead of after the shell appeared. The organization layout keys that query by a fresh
 * `contextKey` per entry, so the key is chosen here first and handed to the layout's first entry
 * of that address (`takeOrganizationKey`), once: a later entry draws a new key, as always.
 *
 * Only an earlier subscription, sent on the connection after the session's token: the server
 * authorizes it like any other, and the layout shows the answer only after the session check
 * let the shell through. Nothing is written anywhere.
 */
const reservationMs = 10_000;
const reserved = new Map<string, { key: string; at: number }>();

/** `/app/<slug>` and its pages: the organization of the address, if any. */
export function organizationSlugOf(pathname: string) {
  const match = /^\/app\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(pathname);
  return match?.[1];
}

export function prewarmOrganization(client: Pick<ConvexReactClient, "prewarmQuery">, slug: string) {
  const current = reserved.get(slug);
  if (current && Date.now() - current.at < reservationMs) return;
  const key = crypto.randomUUID();
  reserved.set(slug, { key, at: Date.now() });
  client.prewarmQuery({
    query: api.organizations.context,
    args: { slug, contextKey: key },
    extendSubscriptionFor: reservationMs,
  });
}

/** The key already asked for this address, for the layout's first entry; then forgotten. */
export function takeOrganizationKey(slug: string) {
  const entry = reserved.get(slug);
  reserved.delete(slug);
  return entry && Date.now() - entry.at < reservationMs ? entry.key : undefined;
}
