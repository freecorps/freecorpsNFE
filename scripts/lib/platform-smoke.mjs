import { verifyInstallationPolicy } from "./installation-headers.mjs";
import { smokeFailure, smokeRequestId } from "./smoke-diagnostic.mjs";

export async function smokePlatform(
  sha,
  target,
  query,
  {
    request = fetch,
    attempts = 6,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Smoke requires a full revision");
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 6)
    throw new Error("Revision polling requires between one and six attempts");
  const fail = (context, code) => smokeFailure({ ...context, expectedSha: sha, code });
  const read = async (phase, service, url, kind) => {
    const context = { phase, service };
    const signal = AbortSignal.timeout(30_000);
    let response, value;
    try {
      response = await request(url, { redirect: "error", signal, cache: "no-store" });
    } catch (error) {
      throw fail(
        context,
        signal.aborted || ["TimeoutError", "AbortError"].includes(error?.name)
          ? "TIMEOUT"
          : "UNAVAILABLE",
      );
    }
    context.httpStatus = response.status;
    context.requestId = smokeRequestId(response.headers);
    if (!response.ok)
      throw fail(
        context,
        [401, 403].includes(response.status)
          ? "AUTH_FAILED"
          : response.status >= 500
            ? "UNAVAILABLE"
            : "HTTP_ERROR",
      );
    try {
      value = kind === "json" ? await response.json() : await response.text();
    } catch (error) {
      throw fail(
        context,
        signal.aborted || ["TimeoutError", "AbortError"].includes(error?.name)
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

  // Only a valid but stale revision is retried. Never repeat publication or hide
  // authentication, policy, environment or transport failures behind polling.
  for (let attempt = 0; attempt < attempts; attempt++) {
    const backend = await read("revision", "backend", `${target.site}/health`, "json");
    const frontend = await read("revision", "frontend", `${target.frontend}/build.json`, "json");
    // The public REST address reaches the same backend through the Worker.
    const api = target.api ? [await read("revision", "api", `${target.api}/health`, "json")] : [];
    let mismatch;
    for (const result of [backend, frontend, ...api]) {
      if (!/^[a-f0-9]{40}$/.test(result.value.sha ?? ""))
        throw fail(result.context, "INVALID_RESPONSE");
      if (result.value.sha !== sha)
        mismatch ??= fail({ ...result.context, observedSha: result.value.sha }, "SHA_MISMATCH");
    }
    if (
      api.some((result) => result.value.appEnv !== backend.value.appEnv) ||
      backend.value.status !== "ok" ||
      backend.value.appEnv !== "installation" ||
      backend.value.productEnv !== "sandbox" ||
      backend.value.fiscalEnv !== "disabled" ||
      // Every revision since #337 reports it; a missing field is not the hosted sandbox.
      backend.value.issuanceEnv !== "disabled"
    )
      throw fail(backend.context, "ENVIRONMENT_MISMATCH");
    // The Worker could route the public API to another backend: its `/health` must describe the
    // same sandbox, never the NFS-e fiscal production.
    for (const result of api)
      if (
        result.value.productEnv !== "sandbox" ||
        result.value.fiscalEnv !== "disabled" ||
        result.value.issuanceEnv !== "disabled"
      )
        throw fail(result.context, "ENVIRONMENT_MISMATCH");
    if (frontend.value.environment !== "installation")
      throw fail(frontend.context, "ENVIRONMENT_MISMATCH");
    if (!mismatch) break;
    if (attempt + 1 === attempts) throw mismatch;
    await pause(3_000);
  }
  for (const [phase, path] of [
    ["spa-root", ""],
    ["spa-login", "/login"],
    ["spa-console", "/console"],
  ]) {
    const document = await read(phase, "frontend", target.frontend + path, "html");
    try {
      verifyInstallationPolicy(document.response.headers.get("content-security-policy"), target);
    } catch {
      throw fail(document.context, "POLICY_MISMATCH");
    }
  }
  let crons;
  try {
    crons = await query("_system/frontend/listCronJobs");
  } catch {
    throw fail({ phase: "crons", service: "backend" }, "QUERY_FAILED");
  }
  if (!Array.isArray(crons)) throw fail({ phase: "crons", service: "backend" }, "INVALID_RESPONSE");
  if (crons.length) throw fail({ phase: "crons", service: "backend" }, "ENVIRONMENT_MISMATCH");
}
