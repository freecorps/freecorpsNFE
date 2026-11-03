/**
 * What the console carries between the account screens without writing it anywhere: the e-mail
 * typed in the signup (to fill the verification and the login) and the invitation code opened
 * from the e-mail link. Both live only in this module's memory, so they survive navigation inside
 * the console and disappear on reload. The invitation code is sensitive and single use: never in
 * localStorage, sessionStorage, analytics or the address bar (docs/desenvolvimento/frontend.md, "Sessão, convite e formulários de conta").
 */
let pendingEmail = "";
let pendingInvitation = "";

export const invitationCodePattern = /^[a-f0-9]{64}$/;

export function rememberEmail(email: string) {
  pendingEmail = email.trim();
}
export function rememberedEmail() {
  return pendingEmail;
}

/** Normalizes a pasted code: trims spaces and line breaks, lowercase. */
export function normalizeInvitationCode(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}
export function hasPendingInvitation() {
  return pendingInvitation !== "";
}
/** Hands the pending code over once; the screen keeps it in its own state from then on. */
export function takePendingInvitation() {
  const code = pendingInvitation;
  pendingInvitation = "";
  return code;
}

/**
 * Reads the invitation link (`/accept-invitation#code=…`) once, at boot, and removes the code
 * from the address before anything else runs. The fragment is never sent to a server or in a
 * Referer; a `?code=` from an older link is accepted the same way and also removed.
 */
export function captureInvitationLink(location: Location, history: History) {
  if (location.pathname !== "/accept-invitation") return;
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(location.search);
  const raw = fragment.get("code") ?? query.get("code");
  if (raw === null) return;
  const code = normalizeInvitationCode(raw);
  if (invitationCodePattern.test(code)) pendingInvitation = code;
  query.delete("code");
  const search = query.toString();
  history.replaceState(history.state, "", `/accept-invitation${search ? `?${search}` : ""}`);
}

/**
 * Internal destinations the login may return to: a path of the console (`/app…`, `/console…`)
 * or the invitation, with the query the page had (company, filters, the open record), never a
 * fragment. The path admits only letters, digits, `-` and `_` between single slashes, so no
 * `//host`, backslash, `..`, scheme or percent-encoded trick can turn it into another origin;
 * the query cannot change where the address points and is limited to URL-safe characters,
 * without control characters even when percent-encoded. Anything else falls back to the
 * console home.
 */
const redirectPath = /^\/(?:accept-invitation|app|console)(?:\/[a-zA-Z0-9_-]+)*\/?$/;
const redirectQuery = /^\?[a-zA-Z0-9\-._~%=&+:,@!]*$/;
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  const queryStart = value.indexOf("?");
  const path = queryStart < 0 ? value : value.slice(0, queryStart);
  const query = queryStart < 0 ? "" : value.slice(queryStart);
  if (!redirectPath.test(path)) return undefined;
  if (path.startsWith("/accept-invitation") && path !== "/accept-invitation") return undefined;
  if (query && !redirectQuery.test(query)) return undefined;
  if (query) {
    try {
      // Malformed escapes or encoded control characters are not an address the console builds.
      const decoded = decodeURIComponent(query.replace(/\+/g, " "));
      for (const char of decoded) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f || char === "\\") return undefined;
      }
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * Where the login and the brand open the work: the last organization of this browser, straight
 * to its page (the server checks the address again), or the console home that finds it.
 */
const slugPattern = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
export function rememberedOrganizationSlug() {
  const slug = rememberedOrganization();
  return slug && slugPattern.test(slug) ? slug : undefined;
}
export function homeHref() {
  const slug = rememberedOrganizationSlug();
  return slug ? `/app/${slug}` : "/console";
}
/** After the login: the page that asked for it, or the home above. */
export function afterLoginHref(redirect: string | undefined) {
  return redirect ?? homeHref();
}

/** Last organization opened in this browser: only its public address, checked by the server. */
const organizationKey = "fnfe:console-organization";
export function rememberOrganization(slug: string) {
  try {
    localStorage.setItem(organizationKey, slug);
  } catch {
    /* Private mode: the console still opens the list. */
  }
}
export function rememberedOrganization() {
  try {
    return localStorage.getItem(organizationKey) ?? undefined;
  } catch {
    return undefined;
  }
}
export function forgetOrganization() {
  try {
    localStorage.removeItem(organizationKey);
  } catch {
    /* Nothing to forget. */
  }
}

/** Leaves the console with a full load, without an entry for Back (the logout). */
export function leaveConsole(href: string) {
  window.location.replace(href);
}
