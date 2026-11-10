/** Shared by runtime and deployment preflight. No secrets or recipients in the manifest. */
export const accountEnvironmentNames = [
  "AUTH_PROXY_MODE",
  "AUTH_PROXY_SECRET",
  "MAIL_API_URL",
  "MAIL_API_KEY",
  "ACCOUNT_EMAIL_FROM",
  "ACCOUNT_EMAIL_RECIPIENTS",
  // The former direct Email Sending token: ignored, tolerated only while the deployments switch to
  // the mail service (docs/operacao/email.md#troca), then removed.
  "CLOUDFLARE_EMAIL_API_TOKEN",
];

/**
 * `EMAIL_MODE`, with `cloudflare` (the name before the mail service) read as `mail` while the
 * deployments switch: the code that reads `MAIL_*` goes out before the variable changes.
 * @param {Record<string, string | undefined>} env
 */
export function emailModeOf(env) {
  return env.EMAIL_MODE === "cloudflare" ? "mail" : env.EMAIL_MODE;
}

/** @param {Record<string, string | undefined>} env */
export function accountPolicy(env, local = false) {
  const proxy = env.AUTH_PROXY_MODE ?? "disabled";
  const emailMode = emailModeOf(env);
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
      apiUrl: "",
      apiKey: "",
      secret: "",
    };
  }
  if (!["disabled", "signed"].includes(proxy) || !["disabled", "mail"].includes(emailMode ?? ""))
    throw new Error("Unsupported validation account mode");
  const secret = env.AUTH_PROXY_SECRET ?? "";
  if (proxy === "signed" && !/^[a-f0-9]{64}$/.test(secret))
    throw new Error("Signed authentication requires a dedicated 32-byte proxy secret");
  if (proxy === "disabled" && secret) throw new Error("Proxy credential requires signed mode");
  const enabled = emailMode === "mail";
  const from = env.ACCOUNT_EMAIL_FROM ?? "";
  // Ember Mail (freecorps/mail): its API address and this deployment's sending key.
  const apiUrl = env.MAIL_API_URL ?? "";
  const apiKey = env.MAIL_API_KEY ?? "";
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
      !mailServiceUrl(apiUrl) ||
      apiKey.length < 20 ||
      !email.test(from) ||
      (!open &&
        (recipients.length < 1 ||
          recipients.length > 10 ||
          recipients.some((value) => !email.test(value)))))
  )
    throw new Error(
      "Controlled email requires a signed proxy, the mail service and 1-10 recipients or *",
    );
  if (!enabled && (apiUrl || apiKey || from || open || recipients.length))
    throw new Error("Disabled email cannot retain provider credentials or recipients");
  /** @type {readonly string[] | "any"} */
  const allowedRecipients = open ? "any" : recipients;
  return {
    enabled,
    proxy: proxy === "signed",
    recipients,
    allowedRecipients,
    from,
    apiUrl,
    apiKey,
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
