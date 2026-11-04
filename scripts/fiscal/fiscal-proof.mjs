import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { validateBackupDirectory } from "../lib/validation-backup.mjs";
import { shutdownFiscalProof, signOutFiscalProof } from "../lib/fiscal-proof-cleanup.mjs";
import {
  acquireProofLock,
  assertAuthorizationActive,
  assertCommand,
  assertFiscalWindow,
  assertOperatorHost,
  productEnvironmentOf,
  proofBaseline,
  publicReceipt,
  validatePlan,
} from "../lib/fiscal-proof-plan.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

// Local operator job only. No workflow receives the fiscal certificate.
const root = repoRoot;
const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
const readPrivate = (path, code, encoding = "utf8") => {
  try {
    return readFileSync(path, encoding);
  } catch {
    throw new Error(code);
  }
};
const ps = join(process.env.SystemRoot ?? "", "System32/WindowsPowerShell/v1.0/powershell.exe");
const protect = (input, decrypt = false) => {
  const script = decrypt
    ? "$s = ConvertTo-SecureString ([Console]::In.ReadToEnd()); $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p); $s.Dispose() }"
    : "$s = ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force; try { [Console]::Out.Write((ConvertFrom-SecureString $s)) } finally { $s.Dispose() }";
  const result = spawnSync(ps, ["-NoProfile", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    // PowerShell 7 exports a module path that Windows PowerShell 5.1 cannot load.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"),
    ),
    timeout: 15_000,
  });
  check(result.status === 0, "DPAPI_FAILED");
  return result.stdout;
};

/** Offline: the vault's validator, before the certificate leaves this machine. */
async function validateLocal(privateDir, plan) {
  // The validator imports workspace TypeScript sources, which only Bun resolves.
  check(process.versions.bun, "VALIDATE_LOCAL_REQUIRES_BUN");
  const build = spawnSync(process.execPath, [join(root, "scripts/build/build-fiscal-packages.mjs")], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
  });
  check(build.status === 0, "FISCAL_PACKAGES_BUILD_FAILED");
  const { validateCertificate } = await import("../../platform/convex/lib/certificateValidation.ts");
  const pfx = Buffer.from(readPrivate(join(privateDir, plan.pfxFile), "PFX_MISSING", null));
  const password = Buffer.from(
    protect(readPrivate(join(privateDir, "password.dpapi"), "PASSWORD_MISSING"), true),
    "utf8",
  );
  try {
    const metadata = validateCertificate(pfx, password, plan.company.cnpj);
    check(metadata.notAfter > plan.expiresAt, "CERTIFICATE_EXPIRES_IN_WINDOW");
    const local = {
      state: "validated-local",
      validatedAt: new Date().toISOString(),
      pfxSha256: createHash("sha256").update(pfx).digest("hex"),
      certificate: {
        cnpj: metadata.cnpj,
        fingerprint: metadata.fingerprint,
        notBefore: metadata.notBefore,
        notAfter: metadata.notAfter,
      },
    };
    writeFileSync(
      join(privateDir, "local-validation.json"),
      JSON.stringify(local, null, 2) + "\n",
      {
        mode: 0o600,
      },
    );
    console.log(JSON.stringify({ phase, state: local.state, notAfter: metadata.notAfter }));
  } finally {
    pfx.fill(0);
    password.fill(0);
  }
}

let phase = "preflight";
let releaseLock;
async function main() {
  const [rawCommand, directory] = process.argv.slice(2);
  assertOperatorHost(process.env, process.platform);
  const command = assertCommand(rawCommand);
  const privateDir = validateBackupDirectory(directory, root);
  const planText = readPrivate(join(privateDir, "plan.json"), "PLAN_MISSING");
  let parsed;
  try {
    parsed = JSON.parse(planText);
  } catch {
    throw new Error("PLAN_INVALID");
  }
  const plan = validatePlan(parsed);
  if (command === "validate-local") {
    phase = "validate-local";
    return validateLocal(privateDir, plan);
  }
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  // Writers publish code, release the certificate or reach the source.
  if (["publish", "provision", "step"].includes(command)) {
    check(git("rev-parse", "HEAD") === plan.approvedSha, "CHECKOUT_NOT_APPROVED_SHA");
    check(git("status", "--porcelain") === "", "CHECKOUT_DIRTY");
    assertAuthorizationActive(plan, Date.now());
    if (command === "step") assertFiscalWindow(plan, Date.now());
    releaseLock = acquireProofLock(privateDir);
  }
  const url = `https://${plan.target.name}.convex.cloud`;
  const site = `https://${plan.target.name}.convex.site`;
  const envText = readPrivate(join(privateDir, "deployment.env"), "DEPLOY_KEY_MISSING");
  const key = /^CONVEX_DEPLOY_KEY=['"]?([^\r\n'" ]+)['"]?$/m.exec(envText)?.[1];
  check(key?.startsWith(`dev:${plan.target.name}|`), "DEPLOY_KEY_TARGET_MISMATCH");
  const admin = new ConvexHttpClient(url, { logger: false });
  admin.setAdminAuth(key);
  const client = new ConvexHttpClient(url, { logger: false });
  const ref = makeFunctionReference;
  const statePath = join(privateDir, "run-state.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const save = () =>
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  const request = async (address, options = {}) => {
    const response = await fetch(address, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return response;
  };
  const environment = async () =>
    Object.fromEntries(
      (await admin.query(ref("_system/cli/queryEnvironmentVariables"), {})).map(
        ({ name, value }) => [name, value],
      ),
    );
  const setEnvironment = async (values) => {
    await request(url + "/api/update_environment_variables", {
      method: "POST",
      headers: { Authorization: `Convex ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        changes: Object.entries(values).map(([name, value]) => ({ name, value })),
      }),
    });
    const actual = await environment();
    for (const [name, value] of Object.entries(values))
      check((actual[name] ?? null) === value, "ENVIRONMENT_NOT_APPLIED");
  };
  const health = async () => (await request(site + "/health")).json();
  const productEnv = productEnvironmentOf(plan);
  if (command === "publish") {
    // Transport stays disabled while code changes; secrets are generated only once.
    phase = "publish-environment";
    const current = await environment();
    const values = proofBaseline(plan);
    // A target keeps the fiscal environment of its first publish; a first publish
    // requires no mark, since the homologation baseline cannot clear a stale one.
    check(
      current.FNFE_PROOF_FISCAL_ENV === values.FNFE_PROOF_FISCAL_ENV ||
        (!current.BETTER_AUTH_SECRET && current.FNFE_PROOF_FISCAL_ENV == null),
      "TARGET_FISCAL_ENVIRONMENT_MISMATCH",
    );
    if (!current.BETTER_AUTH_SECRET)
      values.BETTER_AUTH_SECRET = randomBytes(48).toString("base64url");
    if (!current.FNFE_PLATFORM_CERT_KEYS)
      values.FNFE_PLATFORM_CERT_KEYS = JSON.stringify({
        active: "proof-v1",
        keys: { "proof-v1": randomBytes(32).toString("hex") },
      });
    await setEnvironment(values);
    phase = "publish-build";
    const node = (args, options = {}) => {
      const result = spawnSync(process.execPath, args, {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
        ...options,
      });
      check(result.status === 0, "PUBLISH_FAILED");
    };
    node([join(root, "scripts/build/build-fiscal-packages.mjs")]);
    phase = "publish-deploy";
    const buildFile = join(root, "platform/convex/buildInfo.ts");
    const originalBuild = readFileSync(buildFile);
    const deployEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(CONVEX_|VITE_|FNFE_|CLERK_|BETTER_AUTH_|VALIDATION_)/.test(name),
      ),
    );
    try {
      writeFileSync(
        buildFile,
        `export const buildSha: string | null = ${JSON.stringify(plan.approvedSha)};\n`,
      );
      node(
        [
          join(root, "node_modules/convex/bin/main.js"),
          "deploy",
          "--yes",
          "--typecheck",
          "disable",
          "--codegen",
          "disable",
        ],
        { cwd: join(root, "platform"), env: { ...deployEnv, CONVEX_DEPLOY_KEY: key } },
      );
    } finally {
      writeFileSync(buildFile, originalBuild);
    }
    phase = "publish-verify";
    const published = await health();
    check(published.sha === plan.approvedSha, "DEPLOYED_SHA_MISMATCH");
    check(
      published.appEnv === "validation" &&
        published.productEnv === productEnv &&
        published.fiscalEnv === "disabled" &&
        // The #50 target never serves the NFS-e fiscal production; older revisions omit the field.
        (published.issuanceEnv ?? "disabled") === "disabled",
      "TARGET_BASELINE_INVALID",
    );
    const crons = await admin.query(ref("_system/frontend/listCronJobs"), {});
    check(Array.isArray(crons) && crons.length === 0, "TARGET_CRONS_REGISTERED");
    console.log(JSON.stringify({ phase, sha: published.sha, fiscalEnv: "disabled", crons: 0 }));
    return;
  }
  const env = await environment();
  // Shutdown must stay possible even if the target no longer runs the approved code.
  if (!["pause", "stop"].includes(command)) {
    const current = await health();
    check(current.sha === plan.approvedSha, "DEPLOYED_SHA_MISMATCH");
    check(
      current.appEnv === "validation" &&
        current.productEnv === productEnv &&
        env.FNFE_CRONS === "off" &&
        env.EMAIL_MODE === "disabled" &&
        env.WEBHOOK_MODE === "disabled",
      "TARGET_BASELINE_INVALID",
    );
  }
  const accountPath = join(privateDir, "operator.dpapi");
  let account;
  if (existsSync(accountPath))
    account = JSON.parse(protect(readFileSync(accountPath, "utf8"), true));
  else {
    check(command === "provision", "OPERATOR_ACCOUNT_MISSING");
    account = {
      email: `fiscal-50-${randomBytes(6).toString("hex")}@validation.invalid`,
      password: randomBytes(32).toString("base64url"),
    };
    writeFileSync(accountPath, protect(JSON.stringify(account)), { mode: 0o600, flag: "wx" });
  }
  if (command === "provision" && !state.accountCreated) {
    check(env.FISCAL_ENV === "disabled", "TRANSPORT_ALREADY_ENABLED");
    check(!state.accountCreationStarted, "RECONCILE_ACCOUNT_BEFORE_RETRY");
    phase = "create-operator";
    state.accountCreationStarted = true;
    save();
    await admin.action(ref("provision:createTestAccount"), {
      ...account,
      name: "Operador manual da prova fiscal 50",
      role: "operator",
    });
    state.accountCreated = true;
    save();
  }
  phase = "login";
  const headers = {
    Origin: env.SITE_URL,
    "Content-Type": "application/json",
    "Better-Auth-Cookie": "",
  };
  const login = await request(site + "/api/auth/sign-in/email", {
    method: "POST",
    headers,
    body: JSON.stringify(account),
  });
  const cookie = (login.headers.get("set-better-auth-cookie") ?? "").match(
    /(?:^|,\s*)(__Secure-better-auth\.session_token=[^;,\s]+)/,
  )?.[1];
  check(cookie, "SESSION_MISSING");
  headers["Better-Auth-Cookie"] = cookie;
  try {
    const refreshAuth = async () => {
      const { token } = await (await request(site + "/api/auth/convex/token", { headers })).json();
      check(token, "SESSION_TOKEN_MISSING");
      client.setAuth(token);
    };
    await refreshAuth();
    const companyScope = () => ({
      organizationId: state.organizationId,
      companyId: state.companyId,
    });
    // Console capture belongs to the console project (ADR 0005); the policy names it.
    const captureScope = () => ({ ...companyScope(), environment: productEnv });
    const currentCapture = () => client.query(ref("captures:get"), captureScope());
    const pauseCapture = async () => {
      // The Convex JWT lasts 60 seconds; polling may take longer than that.
      await refreshAuth();
      const view = await currentCapture();
      if (view && view.state !== "paused")
        await client.mutation(ref("captures:control"), {
          ...captureScope(),
          action: "pause",
          expectedVersion: view.version,
        });
    };
    const shutdown = async (revoke = false) => {
      const failures = await shutdownFiscalProof({
        disableTransport: () =>
          setEnvironment({ FISCAL_ENV: "disabled", FNFE_CAPTURE_TRANSPORT: "disabled" }),
        pauseCapture,
        revokeCertificate:
          revoke && state.certificateId
            ? async () => {
                await refreshAuth();
                await client.mutation(ref("certificates:revoke"), {
                  ...companyScope(),
                  id: state.certificateId,
                });
              }
            : undefined,
      });
      for (const code of failures) console.error(JSON.stringify({ phase: "shutdown", code }));
      if (failures.length) process.exitCode = 1;
      return failures.length === 0;
    };
    if (command === "provision") {
      phase = "provision-domain";
      if (!state.organizationId) {
        const existing = await client.query(ref("organizations:context"), {
          slug: "fiscal-proof-50",
          contextKey: "operator",
        });
        state.organizationId =
          existing?.id ??
          (
            await client.mutation(ref("organizations:create"), {
              name: "Prova fiscal autorizada Freecorps",
              slug: "fiscal-proof-50",
            })
          ).organizationId;
        save();
      }
      if (!state.companyId) {
        check(!state.companyCreationStarted, "RECONCILE_COMPANY_BEFORE_RETRY");
        state.companyCreationStarted = true;
        save();
        state.companyId = (
          await client.mutation(ref("companies:create"), {
            organizationId: state.organizationId,
            ...plan.company,
          })
        ).companyId;
        save();
      }
      if (!state.projectId) {
        // The server reuses organization + externalReference after a lost response.
        state.projectId = (
          await client.mutation(ref("projects:create"), {
            organizationId: state.organizationId,
            name: "Consulta manual NF-e",
            externalReference: "issue-50",
          })
        ).projectId;
        save();
      }
      if (!state.companyGranted) {
        check(!state.companyGrantStarted, "RECONCILE_GRANT_BEFORE_RETRY");
        state.companyGrantStarted = true;
        save();
        await client.mutation(ref("projects:grantCompany"), {
          ...companyScope(),
          projectId: state.projectId,
          scopes: ["connections:read", "connections:write", "documents:read"],
          environments: [productEnv],
          expectedVersion: 0,
        });
        state.companyGranted = true;
        save();
      }
      phase = "certificate-upload";
      if (!state.certificateId) {
        const prior = await client.query(ref("certificates:list"), {
          ...companyScope(),
          contextKey: "operator",
          paginationOpts: { numItems: 10, cursor: null },
        });
        if (prior.page.length) {
          check(prior.page.length === 1, "RECONCILE_CERTIFICATES_BEFORE_RETRY");
          state.certificateId = prior.page[0].id;
          save();
        } else {
          const local = JSON.parse(
            readPrivate(join(privateDir, "local-validation.json"), "LOCAL_VALIDATION_MISSING"),
          );
          check(
            local.state === "validated-local" && local.certificate?.cnpj === plan.company.cnpj,
            "LOCAL_VALIDATION_INVALID",
          );
          const pfx = readPrivate(join(privateDir, plan.pfxFile), "PFX_MISSING", null);
          check(
            createHash("sha256").update(pfx).digest("hex") === local.pfxSha256,
            "PFX_HASH_MISMATCH",
          );
          let password = protect(readFileSync(join(privateDir, "password.dpapi"), "utf8"), true);
          try {
            state.certificateId = await client.action(ref("certificateWorker:upload"), {
              ...companyScope(),
              pfx: Uint8Array.from(pfx).buffer,
              password,
            });
            save();
          } finally {
            pfx.fill(0);
            password = "";
          }
        }
      }
      const page = await client.query(ref("certificates:list"), {
        ...companyScope(),
        contextKey: "operator",
        paginationOpts: { numItems: 10, cursor: null },
      });
      const cert = page.page.find((c) => c.id === state.certificateId);
      state.certificateState = cert?.state ?? "missing";
      save();
      console.log(JSON.stringify({ phase, certificateState: state.certificateState }));
    } else if (command === "step") {
      phase = "authorize-step";
      check(env.FISCAL_ENV === "disabled", "TRANSPORT_ALREADY_ENABLED");
      const prior = await currentCapture();
      check(!prior || prior.nextAllowedAt <= Date.now(), "SOURCE_COOLDOWN");
      check(!prior || prior.state !== "active", "RECONCILE_RUNNING_STEP");
      const page = await client.query(ref("certificates:list"), {
        ...companyScope(),
        contextKey: "operator",
        paginationOpts: { numItems: 10, cursor: null },
      });
      const cert = page.page.find((c) => c.id === state.certificateId);
      check(cert?.state === "active", "CERTIFICATE_NOT_ACTIVE");
      // Re-checked after the reads above; the server enforces the same window.
      if (!state.consoleProjectId) {
        state.consoleProjectId = await admin.mutation(
          ref("captureProcessing:proofConsoleProject"),
          { organizationId: state.organizationId },
        );
        save();
      }
      assertFiscalWindow(plan, Date.now());
      const policy = {
        deploymentUrl: url,
        fiscalEnvironment: plan.fiscalEnvironment,
        sha: plan.approvedSha,
        ...captureScope(),
        projectId: state.consoleProjectId,
        certificateId: cert.id,
        certificateVersion: cert.version,
        fingerprint: cert.metadata.fingerprint,
        cnpj: plan.company.cnpj,
        startsAt: plan.startsAt,
        expiresAt: plan.expiresAt,
        maxRequests: plan.maxRequests,
      };
      try {
        await setEnvironment({
          FNFE_FISCAL_PROOF: JSON.stringify(policy),
          FNFE_CAPTURE_TRANSPORT: "sefaz",
          FISCAL_ENV: plan.fiscalEnvironment,
        });
        phase = "capture-step";
        const view = prior
          ? await client.mutation(ref("captures:control"), {
              ...captureScope(),
              action: "resume",
              expectedVersion: prior.version,
            })
          : await client.mutation(ref("captures:activate"), captureScope());
        state.streamId = view.id;
        save();
        const deadline = Date.now() + 90_000;
        let evidence;
        do {
          evidence = await admin.query(ref("captureProcessing:proofEvidence"), {
            streamId: state.streamId,
          });
          if (
            ["succeeded", "failed", "paused", "reconciling", "retry_wait"].includes(
              evidence.operation?.state,
            )
          )
            break;
          await new Promise((done) => setTimeout(done, 2000));
        } while (Date.now() < deadline);
        writeFileSync(
          join(privateDir, `fiscal-step-${Date.now()}.json`),
          JSON.stringify(evidence, null, 2) + "\n",
          { mode: 0o600 },
        );
        console.log(
          JSON.stringify({
            phase,
            operationState: evidence.operation?.state,
            sourceStatus: evidence.batch?.status ?? null,
            envelopes: evidence.envelopes.length,
            checkpoint: evidence.stream.checkpoint,
            authorizedCalls: evidence.authorizedCalls,
            nextAllowedAt: evidence.stream.nextAllowedAt,
          }),
        );
      } finally {
        await shutdown();
      }
    } else if (command === "pause") {
      phase = "pause";
      if (await shutdown())
        console.log(JSON.stringify({ phase, transport: "disabled", stream: "paused" }));
    } else if (command === "inspect") {
      phase = "inspect";
      if (state.streamId) {
        const evidence = await admin.query(ref("captureProcessing:proofEvidence"), {
          streamId: state.streamId,
        });
        writeFileSync(
          join(privateDir, "latest-evidence.json"),
          JSON.stringify(evidence, null, 2) + "\n",
          { mode: 0o600 },
        );
        console.log(
          JSON.stringify({
            operation: evidence.operation,
            sourceStatus: evidence.batch?.status ?? null,
            checkpoint: evidence.stream.checkpoint,
            authorizedCalls: evidence.authorizedCalls,
            state: evidence.stream.state,
          }),
        );
      } else
        console.log(
          JSON.stringify({ certificateState: state.certificateState, streamCreated: false }),
        );
    } else if (command === "receipt") {
      phase = "receipt";
      check(state.streamId, "STREAM_NOT_CREATED");
      const evidence = await admin.query(ref("captureProcessing:proofEvidence"), {
        streamId: state.streamId,
      });
      const page = await client.query(ref("certificates:list"), {
        ...companyScope(),
        contextKey: "operator",
        paginationOpts: { numItems: 10, cursor: null },
      });
      const receipt = publicReceipt({
        plan,
        evidence,
        environment: await environment(),
        certificateState: page.page.find((c) => c.id === state.certificateId)?.state ?? "missing",
        generatedAt: Date.now(),
      });
      // The operator reviews it before copying into docs/v1.0/evidence/50/.
      writeFileSync(
        join(privateDir, "public-receipt.json"),
        JSON.stringify(receipt, null, 2) + "\n",
        { mode: 0o600 },
      );
      console.log(
        JSON.stringify({
          phase,
          file: "public-receipt.json",
          sourceStatus: receipt.source?.status ?? null,
          envelopes: receipt.envelopes.length,
        }),
      );
    } else {
      phase = "stop";
      if (await shutdown(true))
        console.log(
          JSON.stringify({
            phase,
            transport: "disabled",
            certificate: state.certificateId ? "revoked" : "not-provisioned",
          }),
        );
    }
  } finally {
    const code = await signOutFiscalProof(() =>
      request(site + "/api/auth/sign-out", { method: "POST", headers, body: "{}" }),
    );
    if (code) console.error(JSON.stringify({ phase: "sign-out", code }));
  }
}

try {
  await main();
} catch (error) {
  const code =
    error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
      ? error.message
      : "FISCAL_PROOF_FAILED";
  console.error(JSON.stringify({ phase, code }));
  process.exitCode = 1;
} finally {
  releaseLock?.();
}
