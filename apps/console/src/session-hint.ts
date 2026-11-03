/**
 * Whether this browser probably holds a Better Auth session: the cross-domain plugin keeps the
 * session cookie in `localStorage["better-auth_cookie"]`, as JSON `{ name: { value, expires } }`.
 * Only a hint to start earlier (the Convex token request, the shell frame): it proves nothing.
 * The server still decides, and nothing private is shown before it answers.
 */
export const sessionCookieKey = "better-auth_cookie";

export function hasSessionHint(
  storage: () => Pick<Storage, "getItem"> | undefined,
  now = Date.now(),
) {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(sessionCookieKey) ?? null;
  } catch {
    // No access to the storage: no hint.
    return false;
  }
  if (!raw) return false;
  let cookies: unknown;
  try {
    cookies = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!cookies || typeof cookies !== "object") return false;
  return Object.entries(cookies).some(([name, cookie]) => {
    if (!name.endsWith("session_token") || !cookie || typeof cookie !== "object") return false;
    const { value, expires } = cookie as { value?: unknown; expires?: unknown };
    if (typeof value !== "string" || value === "") return false;
    if (expires === null || expires === undefined) return true;
    const at = typeof expires === "string" ? Date.parse(expires) : Number.NaN;
    return Number.isFinite(at) && at > now;
  });
}

/** The hint of this browser now (the login and the logout change it without a reload). */
export const browserSessionHint = () =>
  typeof window !== "undefined" && hasSessionHint(() => window.localStorage);
