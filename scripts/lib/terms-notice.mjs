// The e-mail notice of a new version of the terms of use (#594) after a publication. Every
// publisher of a profile with organizations (hosted sandbox, NFS-e fiscal production, validation
// and self-host) calls it once its revision serves, bootstrap included. `termsOfUseNotice:start`
// is idempotent: no current version, account e-mail disabled or a sweep already done answer
// without sending, and a sweep cut short resumes from its cursor.

const OUTCOMES = new Set(["none", "disabled", "started", "resumed", "done"]);

/**
 * Starts the notice through `mutation(path)`, the publisher's own admin call to the deployment it
 * just published. Never throws: the revision is already served, so a failed call is recorded as
 * `failed` in the receipt and the log, and the next publication, or the same call by an operator,
 * starts it again. The error is not printed, since a provider message may carry a credential.
 * @param {(path: string) => Promise<unknown>} mutation
 * @param {{ log: (line: string) => void, warn: (line: string) => void }} [log]
 */
export async function startTermsOfUseNotice(mutation, log = console) {
  let value;
  try {
    value = await mutation("termsOfUseNotice:start");
  } catch {
    value = null;
  }
  if (!OUTCOMES.has(value?.outcome)) {
    log.warn(
      "terms of use notice: failed; the publication stands. Publish again or run termsOfUseNotice:start on this deployment (idempotent).",
    );
    return { state: "failed", version: null };
  }
  const version = typeof value.version === "string" ? value.version : null;
  log.log(`terms of use notice: ${value.outcome}${version ? ` (${version})` : ""}`);
  return { state: value.outcome, version };
}
