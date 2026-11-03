// Only this closed vocabulary crosses the log/artifact boundary. Never serialize Error.
const phases = new Set([
  "revision",
  "spa-root",
  "spa-login",
  "spa-console",
  "login",
  "token",
  "query",
  "logout",
  "revocation",
  "crons",
  "smoke",
]);
const services = new Set(["frontend", "backend", "api", "auth", "unknown"]);
const codes = new Set([
  "TIMEOUT",
  "UNAVAILABLE",
  "HTTP_ERROR",
  "INVALID_RESPONSE",
  "SHA_MISMATCH",
  "ENVIRONMENT_MISMATCH",
  "POLICY_MISMATCH",
  "QUERY_FAILED",
  "AUTH_FAILED",
  "REVOCATION_FAILED",
  "UNKNOWN",
]);
const shaPattern = /^[a-f0-9]{40}$/;
const idPattern =
  /^(?:[a-f0-9]{16,32}(?:-[A-Z]{3})?|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const failures = new WeakMap();

export function sanitizeSmokeDiagnostic(value) {
  const safe = {
    phase: phases.has(value?.phase) ? value.phase : "smoke",
    service: services.has(value?.service) ? value.service : "unknown",
    code: codes.has(value?.code) ? value.code : "UNKNOWN",
  };
  if (Number.isInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)
    safe.httpStatus = value.httpStatus;
  for (const key of ["expectedSha", "observedSha"])
    if (typeof value?.[key] === "string" && shaPattern.test(value[key])) safe[key] = value[key];
  if (
    typeof value?.requestId === "string" &&
    value.requestId.length <= 64 &&
    idPattern.test(value.requestId)
  )
    safe.requestId = value.requestId;
  return safe;
}

export function smokeFailure(value) {
  // Labels come from the smoke code itself. An unlisted one is a programming
  // error that would otherwise reach the receipt as "smoke"/"unknown"/"UNKNOWN".
  const listed = (name, allowed) => {
    if (!allowed.has(value?.[name]))
      throw new TypeError("Unlisted smoke " + name + ": " + JSON.stringify(value?.[name]));
  };
  listed("phase", phases);
  listed("service", services);
  listed("code", codes);
  const diagnostic = sanitizeSmokeDiagnostic(value);
  const error = new Error(
    "Smoke " + diagnostic.phase + "/" + diagnostic.service + ": " + diagnostic.code,
  );
  failures.set(error, { diagnostic });
  return error;
}

export function smokeFailureDetails(error) {
  const details = failures.get(error);
  return {
    diagnostic: sanitizeSmokeDiagnostic(details?.diagnostic),
    ...(details?.cleanupDiagnostic
      ? { cleanupDiagnostic: sanitizeSmokeDiagnostic(details.cleanupDiagnostic) }
      : {}),
  };
}

export function withCleanupFailure(primary, cleanup) {
  const details = failures.get(primary);
  if (details) details.cleanupDiagnostic = smokeFailureDetails(cleanup).diagnostic;
  return primary;
}

export function smokeRequestId(headers, secrets = []) {
  for (const name of ["x-request-id", "x-convex-request-id", "cf-ray"]) {
    const value = headers.get(name);
    if (value && !secrets.some((secret) => secret && value.includes(secret))) {
      const safe = sanitizeSmokeDiagnostic({ requestId: value }).requestId;
      if (safe) return safe;
    }
  }
}

export function smokeDiagnosticText(value) {
  return JSON.stringify(sanitizeSmokeDiagnostic(value));
}
