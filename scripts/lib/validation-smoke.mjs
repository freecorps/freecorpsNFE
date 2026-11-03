import { validationTarget as target } from "./validation.mjs";
import { smokeFailure, smokeRequestId, withCleanupFailure } from "./smoke-diagnostic.mjs";

export function smokeCredentials(env) {
  const email = env.VALIDATION_SMOKE_EMAIL;
  const password = env.VALIDATION_SMOKE_PASSWORD;
  if (
    !/^[a-z0-9.-]+@validation\.invalid$/.test(email ?? "") ||
    typeof password !== "string" ||
    password.length < 16
  )
    throw new Error("A pre-provisioned synthetic smoke account is required");
  return { email, password };
}

export async function smokeValidation(
  sha,
  credentials,
  request = fetch,
  { attempts = 6, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 6)
    throw new Error("Revision polling requires between one and six attempts");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Smoke requires a full revision");
  const secrets = [credentials.email, credentials.password];
  const fail = (context, code) => smokeFailure({ ...context, expectedSha: sha, code });
  const read = async (phase, service, url, kind, options = {}) => {
    const context = { phase, service };
    const signal = AbortSignal.timeout(30_000);
    let response;
    try {
      response = await request(url, { ...options, redirect: "error", signal });
    } catch (error) {
      throw fail(
        context,
        signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "TIMEOUT"
          : "UNAVAILABLE",
      );
    }
    context.httpStatus = response.status;
    context.requestId = smokeRequestId(response.headers, secrets);
    if (!response.ok)
      throw fail(
        context,
        [401, 403].includes(response.status)
          ? "AUTH_FAILED"
          : response.status >= 500
            ? "UNAVAILABLE"
            : "HTTP_ERROR",
      );
    let value;
    try {
      value =
        kind === "json" ? await response.json() : kind === "html" ? await response.text() : null;
    } catch (error) {
      throw fail(
        context,
        signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "TIMEOUT"
          : error instanceof SyntaxError
            ? "INVALID_RESPONSE"
            : "UNAVAILABLE",
      );
    }
    if (kind === "json" && (!value || typeof value !== "object" || Array.isArray(value)))
      throw fail(context, "INVALID_RESPONSE");
    if (
      kind === "html" &&
      (!response.headers.get("content-type")?.includes("text/html") || !value.includes('id="root"'))
    )
      throw fail(context, "INVALID_RESPONSE");
    return { value, response, context };
  };

  // Retry public revision mismatches only. Authentication is never retried.
  for (let attempt = 0; attempt < attempts; attempt++) {
    const frontend = await read("revision", "frontend", target.consoleUrl + "/build.json", "json");
    const backend = await read("revision", "backend", target.siteUrl + "/health", "json");
    let mismatch;
    for (const result of [frontend, backend]) {
      if (!/^[a-f0-9]{40}$/.test(result.value.sha ?? ""))
        throw fail(result.context, "INVALID_RESPONSE");
      if (result.value.sha !== sha)
        mismatch ??= fail({ ...result.context, observedSha: result.value.sha }, "SHA_MISMATCH");
    }
    if (frontend.value.environment !== "validation")
      throw fail(frontend.context, "ENVIRONMENT_MISMATCH");
    if (
      backend.value.appEnv !== "validation" ||
      backend.value.status !== "ok" ||
      backend.value.productEnv !== "sandbox" ||
      backend.value.fiscalEnv !== "disabled" ||
      // Every revision since #337 reports `issuanceEnv`. Without it, the answer is an older
      // revision still being replaced: the SHA mismatch above retries it. With the published SHA,
      // a missing or other value is the wrong deployment.
      (backend.value.issuanceEnv !== undefined && backend.value.issuanceEnv !== "disabled") ||
      (backend.value.sha === sha && backend.value.issuanceEnv !== "disabled")
    )
      throw fail(backend.context, "ENVIRONMENT_MISMATCH");
    if (!mismatch) break;
    if (attempt + 1 === attempts) throw mismatch;
    await pause(3_000);
  }
  await read("spa-login", "frontend", target.consoleUrl + "/login", "html");
  await read("spa-console", "frontend", target.consoleUrl + "/console/diagnostico", "html");
  const headers = {
    Origin: target.consoleUrl,
    "Content-Type": "application/json",
    "Better-Auth-Cookie": "",
  };
  const login = await read("login", "auth", target.consoleUrl + "/api/auth/sign-in/email", "none", {
    method: "POST",
    headers,
    body: JSON.stringify(credentials),
  });
  const sessionCookie = (login.response.headers.get("set-better-auth-cookie") ?? "").match(
    /(?:^|,\s*)(__Secure-better-auth\.session_token=[^;,\s]+)/,
  )?.[1];
  if (!sessionCookie) throw fail(login.context, "AUTH_FAILED");
  headers["Better-Auth-Cookie"] = sessionCookie;
  secrets.push(sessionCookie, sessionCookie.slice(sessionCookie.indexOf("=") + 1));
  let token;
  const query = (phase) =>
    read(phase, "backend", target.url + "/api/query", "json", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ path: "access:overview", args: {}, format: "json" }),
    });
  let primary;
  try {
    const result = await read(
      "token",
      "auth",
      target.consoleUrl + "/api/auth/convex/token",
      "json",
      { headers },
    );
    token = result.value.token;
    if (typeof token !== "string" || !token) throw fail(result.context, "AUTH_FAILED");
    secrets.push(token);
    const overview = await query("query");
    if (
      overview.value.status !== "success" ||
      overview.value.value?.status !== "authorized" ||
      overview.value.value?.environment !== "validation" ||
      overview.value.value?.role !== "viewer"
    )
      throw fail(overview.context, "AUTH_FAILED");
  } catch (error) {
    primary = error;
  } finally {
    try {
      await read("logout", "auth", target.consoleUrl + "/api/auth/sign-out", "none", {
        method: "POST",
        headers,
        body: "{}",
      });
    } catch (error) {
      primary = primary ? withCleanupFailure(primary, error) : error;
    }
  }
  if (primary) throw primary;
  const revoked = await query("revocation");
  if (revoked.value.status !== "error") throw fail(revoked.context, "REVOCATION_FAILED");
  return { sha, authenticatedOperation: "passed", revocation: "passed" };
}
