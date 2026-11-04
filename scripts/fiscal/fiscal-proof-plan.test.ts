import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import {
  acquireProofLock,
  assertAuthorizationActive,
  assertCommand,
  assertFiscalWindow,
  assertOperatorHost,
  assertSanitized,
  isSharedTarget,
  SHARED_TARGET_SHA256,
  proofBaseline,
  publicReceipt,
  validatePlan,
} from "../lib/fiscal-proof-plan.mjs";
import { repoUrl } from "../lib/repo-root.mjs";

// Synthetic plan only: no real company, certificate or deployment.
const startsAt = 1_800_000_000_000;
const plan = () => ({
  approvedSha: "a".repeat(40),
  target: { name: "synthetic-target-123", type: "dev", reference: "dev/issue-50-fiscal-proof" },
  service: "nfe-distribution",
  fiscalEnvironment: "homologation",
  authorization: {
    approvedBy: "mantenedor-sintetico",
    approvedAt: startsAt - 60_000,
    reference: "registro restrito 1",
  },
  company: { cnpj: "00000000000191", name: "Empresa Sintética Ltda", address: {} },
  pfxFile: "certificado.pfx",
  startsAt,
  expiresAt: startsAt + 2 * 3_600_000,
  maxRequests: 2,
});
type Plan = ReturnType<typeof plan>;

it("accepts only a plan that names every input explicitly", () => {
  expect(validatePlan(plan())).toEqual(plan());
});

it.each<[string, (p: Plan) => unknown, string]>([
  ["no plan", () => null, "PLAN_INVALID"],
  ["missing SHA", (p) => ({ ...p, approvedSha: undefined }), "PLAN_SHA_REQUIRED"],
  ["short SHA", (p) => ({ ...p, approvedSha: "abc123" }), "PLAN_SHA_REQUIRED"],
  ["branch as SHA", (p) => ({ ...p, approvedSha: "main" }), "PLAN_SHA_REQUIRED"],
  ["missing target", (p) => ({ ...p, target: undefined }), "PLAN_TARGET_REQUIRED"],
  ["prod target", (p) => ({ ...p, target: { ...p.target, type: "prod" } }), "PLAN_TARGET_REQUIRED"],
  [
    "other reference",
    (p) => ({ ...p, target: { ...p.target, reference: "dev/other" } }),
    "PLAN_TARGET_REQUIRED",
  ],
  [
    "reference with another prefix",
    (p) => ({ ...p, target: { ...p.target, reference: "dev/issue-50-fiscal-proof/x" } }),
    "PLAN_TARGET_REQUIRED",
  ],
  [
    "production deployment",
    (p) => ({ ...p, target: { ...p.target, name: "elated-possum-295" } }),
    "PLAN_TARGET_SHARED",
  ],
  [
    "persistent validation",
    (p) => ({ ...p, target: { ...p.target, name: "modest-seal-118" } }),
    "PLAN_TARGET_SHARED",
  ],
  ["missing service", (p) => ({ ...p, service: undefined }), "PLAN_SERVICE_REQUIRED"],
  ["other service", (p) => ({ ...p, service: "nfe-manifestation" }), "PLAN_SERVICE_REQUIRED"],
  [
    "unknown fiscal environment",
    (p) => ({ ...p, fiscalEnvironment: "producao" }),
    "PLAN_FISCAL_ENVIRONMENT_REQUIRED",
  ],
  [
    "missing fiscal environment",
    (p) => ({ ...p, fiscalEnvironment: undefined }),
    "PLAN_FISCAL_ENVIRONMENT_REQUIRED",
  ],
  ["no authorization", (p) => ({ ...p, authorization: undefined }), "PLAN_AUTHORIZATION_REQUIRED"],
  [
    "blank approver",
    (p) => ({ ...p, authorization: { ...p.authorization, approvedBy: " " } }),
    "PLAN_AUTHORIZATION_REQUIRED",
  ],
  [
    "no authorization reference",
    (p) => ({ ...p, authorization: { ...p.authorization, reference: "" } }),
    "PLAN_AUTHORIZATION_REQUIRED",
  ],
  [
    "authorization date as text",
    (p) => ({ ...p, authorization: { ...p.authorization, approvedAt: "2026-10-09" } }),
    "PLAN_AUTHORIZATION_REQUIRED",
  ],
  ["no company", (p) => ({ ...p, company: undefined }), "PLAN_COMPANY_REQUIRED"],
  [
    "formatted CNPJ",
    (p) => ({ ...p, company: { ...p.company, cnpj: "00.000.000/0001-91" } }),
    "PLAN_COMPANY_REQUIRED",
  ],
  [
    "unknown company field",
    (p) => ({ ...p, company: { ...p.company, extra: true } }),
    "PLAN_COMPANY_REQUIRED",
  ],
  ["no PFX", (p) => ({ ...p, pfxFile: undefined }), "PLAN_PFX_REQUIRED"],
  ["PFX outside the folder", (p) => ({ ...p, pfxFile: "../cert.pfx" }), "PLAN_PFX_REQUIRED"],
  ["absolute PFX path", (p) => ({ ...p, pfxFile: "C:\\certs\\a.pfx" }), "PLAN_PFX_REQUIRED"],
  ["no window", (p) => ({ ...p, startsAt: undefined }), "PLAN_WINDOW_REQUIRED"],
  ["inverted window", (p) => ({ ...p, expiresAt: p.startsAt }), "PLAN_WINDOW_REQUIRED"],
  [
    "window over three hours",
    (p) => ({ ...p, expiresAt: p.startsAt + 3 * 3_600_000 + 1 }),
    "PLAN_WINDOW_REQUIRED",
  ],
  [
    "window in seconds",
    (p) => ({ ...p, startsAt: p.startsAt / 1000 + 0.5 }),
    "PLAN_WINDOW_REQUIRED",
  ],
  [
    "authorization after the window",
    (p) => ({ ...p, authorization: { ...p.authorization, approvedAt: p.expiresAt } }),
    "PLAN_WINDOW_REQUIRED",
  ],
  ["no budget", (p) => ({ ...p, maxRequests: undefined }), "PLAN_REQUESTS_REQUIRED"],
  ["zero calls", (p) => ({ ...p, maxRequests: 0 }), "PLAN_REQUESTS_REQUIRED"],
  ["three calls", (p) => ({ ...p, maxRequests: 3 }), "PLAN_REQUESTS_REQUIRED"],
])("refuses a plan with %s", (_, change, code) => {
  expect(() => validatePlan(change(plan()))).toThrow(code);
});

it.each([
  [{ CI: "true" }, "win32", "CI_FORBIDDEN"],
  [{ GITHUB_ACTIONS: "true" }, "win32", "CI_FORBIDDEN"],
  [{ RUNNER_NAME: "self-hosted" }, "win32", "CI_FORBIDDEN"],
  [{}, "linux", "OPERATOR_HOST_REQUIRED"],
])("never runs in CI or outside the operator host: %j on %s", (env, platform, code) => {
  expect(() => assertOperatorHost(env, platform)).toThrow(code);
});

it("accepts the operator host and only the documented commands", () => {
  expect(() => assertOperatorHost({}, "win32")).not.toThrow();
  for (const command of [
    "validate-local",
    "publish",
    "provision",
    "step",
    "inspect",
    "receipt",
    "pause",
    "stop",
  ])
    expect(assertCommand(command)).toBe(command);
  for (const command of [undefined, "", "deploy", "manifest", "emit"])
    expect(() => assertCommand(command)).toThrow("COMMAND_REQUIRED");
});

it("releases credentials only after authorization and calls the source only inside the window", () => {
  const p = validatePlan(plan());
  const approvedAt = p.authorization.approvedAt;
  expect(() => assertAuthorizationActive(p, approvedAt - 1)).toThrow("AUTHORIZATION_INACTIVE");
  expect(() => assertAuthorizationActive(p, approvedAt)).not.toThrow();
  expect(() => assertAuthorizationActive(p, p.expiresAt)).toThrow("AUTHORIZATION_INACTIVE");
  expect(() => assertFiscalWindow(p, p.startsAt - 1)).toThrow("FISCAL_WINDOW_CLOSED");
  expect(() => assertFiscalWindow(p, p.startsAt)).not.toThrow();
  expect(() => assertFiscalWindow(p, p.expiresAt - 1)).not.toThrow();
  expect(() => assertFiscalWindow(p, p.expiresAt)).toThrow("FISCAL_WINDOW_CLOSED");
});

it("accepts a round suffix in the target reference", () => {
  const p = {
    ...plan(),
    target: { ...plan().target, reference: "dev/issue-50-fiscal-proof-20261020" },
  };
  expect(validatePlan(p)).toEqual(p);
});

it("accepts a production plan for the read-only distribution", () => {
  const p = { ...plan(), fiscalEnvironment: "production" };
  expect(validatePlan(p)).toEqual(p);
});

it("keeps transport, crons and notifications off in the target baseline", () => {
  const off = {
    APP_ENV: "validation",
    FISCAL_ENV: "disabled",
    FNFE_CAPTURE_TRANSPORT: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "disabled",
    WEBHOOK_MODE: "disabled",
  };
  const homologation = proofBaseline(plan());
  expect(homologation).toMatchObject({ ...off, PRODUCT_ENV: "sandbox" });
  expect(Object.keys(homologation)).not.toContain("FNFE_PROOF_FISCAL_ENV");
  const production = proofBaseline({ ...plan(), fiscalEnvironment: "production" });
  expect(production).toMatchObject({
    ...off,
    PRODUCT_ENV: "production",
    FNFE_PROOF_FISCAL_ENV: "production",
  });
  for (const baseline of [homologation, production])
    expect(Object.keys(baseline)).not.toContain("FNFE_FISCAL_PROOF");
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

it("allows one writer per private directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "fiscal-proof-lock-"));
  directories.push(directory);
  const release = acquireProofLock(directory);
  expect(() => acquireProofLock(directory)).toThrow("PROOF_LOCKED");
  release();
  release();
  const again = acquireProofLock(directory);
  // The operator may remove the lock meanwhile; releasing must not mask the result.
  rmSync(join(directory, "run.lock"), { recursive: true });
  expect(() => again()).not.toThrow();
});

it("copies only the declared target fields into the public receipt", () => {
  const p = validatePlan(plan()) as Plan & { target: Plan["target"] & { note?: string } };
  p.target.note = "segredo-sintetico-sem-marcador";
  const receipt = publicReceipt({
    plan: p,
    evidence: evidence(),
    environment: shutdown,
    certificateState: "revoked",
    generatedAt: startsAt,
  });
  expect(receipt.target).toEqual({
    name: "synthetic-target-123",
    type: "dev",
    reference: "dev/issue-50-fiscal-proof",
  });
  expect(JSON.stringify(receipt)).not.toContain("segredo-sintetico");
});

const evidence = () => ({
  sha: "a".repeat(40),
  stream: {
    _id: "stream-id",
    organizationId: "org-id",
    projectId: "project-id",
    companyId: "company-id",
    environment: "sandbox",
    identity: "00000000000191:sandbox:nfe-distribution",
    service: "nfe-distribution",
    state: "paused",
    version: 4,
    checkpoint: "000000000000002",
    mode: "distNSU",
    nextAllowedAt: startsAt + 3_600_000,
    code: "FISCAL_PROOF_STEP_COMPLETE",
    received: 2,
    createdAt: startsAt,
  },
  operation: { id: "operation-id", state: "succeeded", code: null, uncertain: false },
  batch: {
    _id: "batch-id",
    streamId: "stream-id",
    operationId: "operation-id",
    ownerVersion: 4,
    requestNsu: "000000000000000",
    mode: "distNSU",
    rawId: "storage-id",
    rawHash: "c".repeat(64),
    status: "138",
    lastNsu: "000000000000002",
    maxNsu: "000000000000002",
    envelopeCount: 2,
    storedBytes: 4096,
    saved: 2,
    committed: true,
    createdAt: startsAt + 1000,
  },
  envelopes: [
    { nsu: "000000000000001", schema: "resNFe_v1.01.xsd", sha256: "d".repeat(64) },
    { nsu: "000000000000002", schema: "procNFe_v4.00.xsd", sha256: "e".repeat(64) },
  ],
  authorizedCalls: 1,
});
const shutdown = {
  FISCAL_ENV: "disabled",
  FNFE_CAPTURE_TRANSPORT: "disabled",
  FNFE_CRONS: "off",
  EMAIL_MODE: "disabled",
  WEBHOOK_MODE: "disabled",
  BETTER_AUTH_SECRET: "synthetic-secret-never-copied",
  FNFE_FISCAL_PROOF: '{"cnpj":"00000000000191"}',
};

it("builds a public receipt with hashes and codes, without identity, storage or secrets", () => {
  const receipt = publicReceipt({
    plan: validatePlan(plan()),
    evidence: evidence(),
    environment: shutdown,
    certificateState: "revoked",
    generatedAt: startsAt + 7_200_000,
  });
  expect(receipt).toMatchObject({
    approvedSha: "a".repeat(40),
    deployedSha: "a".repeat(40),
    fiscalEnvironment: "homologation",
    authorizedCalls: 1,
    source: { status: "138", rawSha256: "c".repeat(64), envelopeCount: 2, committed: true },
    stream: { checkpoint: "000000000000002", state: "paused" },
    shutdown: { FISCAL_ENV: "disabled", certificateState: "revoked" },
  });
  expect(receipt.envelopes).toEqual(evidence().envelopes);
  const text = JSON.stringify(receipt);
  for (const leaked of [
    "00000000000191",
    "Empresa Sintética",
    "storage-id",
    "org-id",
    "company-id",
    "project-id",
    "synthetic-secret",
    "FNFE_FISCAL_PROOF",
  ])
    expect(text).not.toContain(leaked);
});

it("distinguishes an attempt without a persisted source answer", () => {
  const receipt = publicReceipt({
    plan: validatePlan(plan()),
    evidence: { ...evidence(), batch: null, envelopes: [] },
    environment: shutdown,
    certificateState: "active",
    generatedAt: startsAt,
  });
  expect(receipt.source).toBeNull();
  expect(receipt.envelopes).toEqual([]);
});

it.each([
  "<nfeProc>",
  "-----BEGIN PRIVATE KEY-----",
  "dev:synthetic-target-123|secret",
  "__Secure-better-auth.session_token=x",
  "eyJhbGciOi",
  "00000000000191",
])("refuses to release a receipt containing %s", (value) => {
  expect(() => assertSanitized(JSON.stringify({ value }), ["00000000000191"])).toThrow(
    "RECEIPT_NOT_SANITIZED",
  );
});

it("no workflow can run the fiscal proof, receive its policy or enable real transport", () => {
  const directory = new URL(".github/workflows/", repoUrl);
  const files = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const text = readFileSync(new URL(name, directory), "utf8");
    for (const forbidden of [
      "fiscal-proof",
      "FNFE_FISCAL_PROOF",
      "FNFE_CAPTURE_TRANSPORT",
      "FNFE_PROOF_FISCAL_ENV",
      "homologation",
      "sefaz",
      ".pfx",
      "password.dpapi",
    ])
      expect(text.toLowerCase(), `${name} mentions ${forbidden}`).not.toContain(
        forbidden.toLowerCase(),
      );
  }
});

it("recusa também o deployment compartilhado que a árvore pública só guarda por hash", () => {
  // A lista real fica em SHARED_TARGET_SHA256; o teste prova o mecanismo com um nome fictício.
  const name = "tidy-fictional-123";
  const hash = createHash("sha256").update(name).digest("hex");
  expect(isSharedTarget(name, [hash])).toBe(true);
  expect(isSharedTarget("other-fictional-9", [hash])).toBe(false);
  expect(isSharedTarget("elated-possum-295", [])).toBe(true);
  expect(SHARED_TARGET_SHA256.length).toBeGreaterThan(0);
  for (const h of SHARED_TARGET_SHA256) expect(h).toMatch(/^[0-9a-f]{64}$/);
});
