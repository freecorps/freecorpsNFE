/** Shared by runtime and deployment preflight. No secrets or recipients in the manifest. */
export const accountEnvironmentNames = [
  "AUTH_PROXY_MODE",
  "AUTH_PROXY_SECRET",
  // `EMAIL_MODE=cloudflare`: Email Sending of the operator's Cloudflare account, called directly.
  "CLOUDFLARE_EMAIL_API_TOKEN",
  "CLOUDFLARE_EMAIL_ACCOUNT_ID",
  // `EMAIL_MODE=mail`: an Ember Mail (freecorps/mail), which owns queue, events and suppressions.
  "MAIL_API_URL",
  "MAIL_API_KEY",
  "ACCOUNT_EMAIL_FROM",
  "ACCOUNT_EMAIL_RECIPIENTS",
];

/** The Freecorps account, the Email Sending account when `CLOUDFLARE_EMAIL_ACCOUNT_ID` is absent. */
export const FREECORPS_CLOUDFLARE_ACCOUNT = "ceccd1846b474bb179054a3c2c4a6185";

/**
 * The provider of `EMAIL_MODE` and its credentials, or null when they are missing or malformed.
 * Only the chosen provider's variables count: the other one's are ignored, so a deployment can
 * switch provider one variable at a time.
 * @param {Record<string, string | undefined>} env
 * @returns {{ provider: "cloudflare"; accountId: string; apiKey: string } | { provider: "mail"; apiUrl: string; apiKey: string } | null}
 */
export function mailServiceOf(env) {
  if (env.EMAIL_MODE === "cloudflare") {
    const accountId = env.CLOUDFLARE_EMAIL_ACCOUNT_ID || FREECORPS_CLOUDFLARE_ACCOUNT;
    const apiKey = env.CLOUDFLARE_EMAIL_API_TOKEN ?? "";
    return /^[0-9a-f]{32}$/.test(accountId) && apiKey.length >= 20
      ? { provider: "cloudflare", accountId, apiKey }
      : null;
  }
  if (env.EMAIL_MODE === "mail") {
    const apiUrl = env.MAIL_API_URL ?? "";
    const apiKey = env.MAIL_API_KEY ?? "";
    return mailServiceUrl(apiUrl) && apiKey.length >= 20
      ? { provider: "mail", apiUrl, apiKey }
      : null;
  }
  return null;
}

/** @param {Record<string, string | undefined>} env */
export function accountPolicy(env, local = false) {
  const proxy = env.AUTH_PROXY_MODE ?? "disabled";
  const emailMode = env.EMAIL_MODE;
  if (local) {
    if (
      emailMode !== "local" ||
      proxy !== "disabled" ||
      accountEnvironmentNames.some((key) => env[key])
    )
      throw new Error("Local accounts cannot use remote mail or proxy credentials");
    /** @type {readonly string[] | "any"} */
    const allowedRecipients = [];
    return {
      enabled: true,
      proxy: false,
      recipients: [],
      allowedRecipients,
      from: "",
      service: null,
      secret: "",
    };
  }
  if (
    !["disabled", "signed"].includes(proxy) ||
    !["disabled", "cloudflare", "mail"].includes(emailMode ?? "")
  )
    throw new Error("Unsupported validation account mode");
  const secret = env.AUTH_PROXY_SECRET ?? "";
  if (proxy === "signed" && !/^[a-f0-9]{64}$/.test(secret))
    throw new Error("Signed authentication requires a dedicated 32-byte proxy secret");
  if (proxy === "disabled" && secret) throw new Error("Proxy credential requires signed mode");
  const enabled = emailMode !== "disabled";
  const from = env.ACCOUNT_EMAIL_FROM ?? "";
  const service = enabled ? mailServiceOf(env) : null;
  // `*` lifts the allowlist, and only in the installation profile, which serves the customers:
  // the notice of a new version of the terms of use must reach every owner and admin (#428).
  // Validation always keeps its 1-10 explicit recipients.
  const open = (env.ACCOUNT_EMAIL_RECIPIENTS ?? "").trim() === "*";
  if (open && env.APP_ENV !== "installation")
    throw new Error("Unrestricted account email is only allowed in the installation profile");
  const recipients = open
    ? []
    : (env.ACCOUNT_EMAIL_RECIPIENTS ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean);
  const email = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (
    enabled &&
    (proxy !== "signed" ||
      !service ||
      !email.test(from) ||
      (!open &&
        (recipients.length < 1 ||
          recipients.length > 10 ||
          recipients.some((value) => !email.test(value)))))
  )
    throw new Error(
      "Controlled email requires a signed proxy, a dedicated provider and 1-10 recipients or *",
    );
  const credentials = accountEnvironmentNames.some(
    (key) => !key.startsWith("AUTH_PROXY_") && !key.startsWith("ACCOUNT_EMAIL_") && env[key],
  );
  if (!enabled && (credentials || from || open || recipients.length))
    throw new Error("Disabled email cannot retain provider credentials or recipients");
  /** @type {readonly string[] | "any"} */
  const allowedRecipients = open ? "any" : recipients;
  return {
    enabled,
    proxy: proxy === "signed",
    recipients,
    allowedRecipients,
    from,
    /** @type {ReturnType<typeof mailServiceOf>} */
    service,
    secret,
  };
}

/** The mail service address: HTTPS, no credentials, query or fragment. */
export function mailServiceUrl(/** @type {string} */ value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Whether the account channel may write to `email`.
 * @param {{ allowedRecipients: readonly string[] | "any" }} policy
 * @param {string} email
 */
export function recipientAllowed(policy, email) {
  return (
    policy.allowedRecipients === "any" || policy.allowedRecipients.includes(email.toLowerCase())
  );
}
