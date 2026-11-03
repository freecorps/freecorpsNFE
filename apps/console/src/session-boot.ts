import { authClient } from "./auth";
import { browserSessionHint } from "./session-hint";

/** How long the first render waits for the early answers before going the usual way. */
export const earlyAuthWaitMs = 4_000;

/**
 * The session this browser holds, asked as soon as the console starts: `entry.ts` loads this
 * small module next to `main`, so the requests travel while the console's code downloads, not
 * after React rendered. Two requests, in parallel:
 *
 * - the Convex token, which the provider receives as `initialToken` and authenticates the Convex
 *   connection with right away;
 * - Better Auth's `get-session`, through the same session store `useSession` reads. The provider
 *   rebuilds its token fetcher when the session id appears; with the session already known at the
 *   first render, it authenticates the connection once, instead of again (and with a moment
 *   signed out) when `get-session` answers after the connection was confirmed.
 *
 * Only a head start: the server issues the token from the session cookie and checks it on the
 * connection, and a session that ended clears it. The provider keeps the token in memory; the
 * requests store nothing beyond what Better Auth's own requests store. Without a session in this
 * browser, nothing is asked here.
 */
const hint = browserSessionHint();

export const earlyToken: Promise<string | null> | null = hint
  ? authClient.convex.token({ fetchOptions: { throw: false } }).then(
      ({ data }) => data?.token ?? null,
      () => null,
    )
  : null;

const earlySession: Promise<void> | null = hint
  ? new Promise<void>((resolve) => {
      // Subscribing mounts the store, which asks `get-session` once; `useSession` reuses it.
      // A store that cannot be read only costs the head start: the console boots the usual way.
      try {
        const stop = authClient.$store.atoms.session.subscribe((value: { isPending: boolean }) => {
          if (value.isPending) return;
          resolve();
          queueMicrotask(() => stop());
        });
      } catch {
        resolve();
      }
    })
  : null;

/** The early token once both answers arrived; `null` without them or after `waitMs`. */
export function settledEarlyToken(waitMs = earlyAuthWaitMs): Promise<string | null> {
  if (!earlyToken) return Promise.resolve(null);
  return Promise.race([
    Promise.all([earlyToken, earlySession]).then(
      ([token]) => token,
      () => null,
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
  ]);
}
