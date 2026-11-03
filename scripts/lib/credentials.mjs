// Credential formats shared by the package check (scripts/lib/distribution.mjs)
// and the repository scanner (scripts/check-secrets.mjs). Each rule matches a
// concrete value, not a mention: a name such as `AKIA...` or `fnfe_...` in a
// document does not match. The project's own secrets without a fixed prefix
// stay out by path (.gitignore) and, in packages, by the versioned-file
// fingerprints of distribution.mjs.

/** PEM header of a private key (PKCS#1, PKCS#8, EC, encrypted). */
export const privateKeyPattern = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/;
/** A certificate is public, but no package ships one. */
export const certificatePattern = /-----BEGIN CERTIFICATE-----/;
/** GitHub, Stripe, AWS, Google, Slack and npm tokens and Convex deploy keys. */
export const serviceTokenPattern =
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|[sr]k_live_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{36}|(?:prod|dev|preview|project):[a-z0-9-]+\|[A-Za-z0-9+/=]{40,})/;
/**
 * freecorpsNFE API key: `fnfe_` and 32 random bytes in base64url, exactly 43
 * characters (platform/convex/lib/apiKeyCrypto.ts). A shorter prefix, as shown
 * in the key list, or `fnfe_...` in prose does not match.
 */
export const apiKeyPattern = /\bfnfe_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/;

const union = (...patterns) => new RegExp(patterns.map(({ source }) => `(?:${source})`).join("|"));

/** What a distributed tarball may never contain. */
export const packageCredentialPattern = union(
  privateKeyPattern,
  certificatePattern,
  serviceTokenPattern,
);

/**
 * What no versioned file may contain, by rule name. Certificates are public
 * and appear in fixtures, so they are not a repository finding.
 */
export const repositoryCredentialRules = {
  "private-key": privateKeyPattern,
  "service-token": serviceTokenPattern,
  "fnfe-api-key": apiKeyPattern,
};
