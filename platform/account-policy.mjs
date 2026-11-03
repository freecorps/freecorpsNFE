/** Shared by runtime and deployment preflight. No secrets or recipients in the manifest. */
export const accountEnvironmentNames = [
  "AUTH_PROXY_MODE",
  "AUTH_PROXY_SECRET",
  "CLOUDFLARE_EMAIL_API_TOKEN",
  "ACCOUNT_EMAIL_FROM",
  "ACCOUNT_EMAIL_RECIPIENTS",
];

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
      apiKey: "",
      secret: "",
    };
  }
  if (
    !["disabled", "signed"].includes(proxy) ||
    !["disabled", "cloudflare"].includes(emailMode ?? "")
  )
    throw new Error("Unsupported validation account mode");
  const secret = env.AUTH_PROXY_SECRET ?? "";
  if (proxy === "signed" && !/^[a-f0-9]{64}$/.test(secret))
    throw new Error("Signed authentication requires a dedicated 32-byte proxy secret");
  if (proxy === "disabled" && secret) throw new Error("Proxy credential requires signed mode");
  const enabled = emailMode === "cloudflare";
  const from = env.ACCOUNT_EMAIL_FROM ?? "";
  const apiKey = env.CLOUDFLARE_EMAIL_API_TOKEN ?? "";
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
      apiKey.length < 20 ||
      !email.test(from) ||
      (!open &&
        (recipients.length < 1 ||
          recipients.length > 10 ||
          recipients.some((value) => !email.test(value)))))
  )
    throw new Error(
      "Controlled email requires a signed proxy, dedicated provider and 1-10 recipients or *",
    );
  if (!enabled && (apiKey || from || open || recipients.length))
    throw new Error("Disabled email cannot retain provider credentials or recipients");
  /** @type {readonly string[] | "any"} */
  const allowedRecipients = open ? "any" : recipients;
  return {
    enabled,
    proxy: proxy === "signed",
    recipients,
    allowedRecipients,
    from,
    apiKey,
    secret,
  };
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
