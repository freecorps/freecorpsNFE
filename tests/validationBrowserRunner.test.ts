import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { browserTarget } from "../scripts/lib/browser-validation.mjs";
import { testEnvironment } from "../scripts/lib/ci.mjs";

it("the real browser entrypoint fails closed and writes only sanitized evidence for a rejected CI target", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const sentinel = "private-password-must-never-be-printed";
  const result = spawnSync(process.execPath, ["apps/console/e2e/m0.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...testEnvironment(process.env),
      GITHUB_ACTIONS: "true",
      GITHUB_STEP_SUMMARY: "",
      GITHUB_OUTPUT: "",
      GITHUB_REF: "refs/heads/main",
      VALIDATION_E2E_SHA: "a".repeat(40),
      VALIDATION_SMOKE_PASSWORD: sentinel,
    },
  });
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).not.toContain(sentinel);
  const receipt = JSON.parse(result.stdout.trim());
  expect(receipt).toMatchObject({ result: "failed", stage: "configuration" });
  expect(receipt.runId).toMatch(/^[a-f0-9-]{36}$/);
  const directory = join(root, ".browser-results", receipt.runId);
  try {
    expect(readdirSync(directory).sort()).toEqual(["report.json", "summary.md"]);
    const report = readFileSync(join(directory, "report.json"), "utf8");
    expect(report).not.toContain(sentinel);
    expect(JSON.parse(report)).toMatchObject({ result: "failed", scenarios: [] });
    expect(JSON.parse(report).browser).toBeUndefined();
  } finally {
    unlinkSync(join(directory, "report.json"));
    unlinkSync(join(directory, "summary.md"));
    rmdirSync(directory);
  }
});

it("the session journey types the planned account into the login form", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "m0-offline-"));
  const accountsFile = join(scratch, "accounts.json");
  const fills = join(scratch, "fills.jsonl");
  const viewer = {
    role: "viewer",
    email: "viewer-offline@validation.invalid",
    password: "viewer-offline-password",
    created: true,
  };
  writeFileSync(
    accountsFile,
    JSON.stringify({
      url: browserTarget.consoleUrl,
      accounts: [
        viewer,
        { ...viewer, role: "operator", email: "operator-offline@validation.invalid" },
        { ...viewer, role: "none", email: "none-offline@validation.invalid" },
      ],
    }),
  );
  writeFileSync(fills, "");
  const preload = new URL("./fixtures/m0-browser/preload.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", preload, "apps/console/e2e/m0.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...testEnvironment(process.env),
      GITHUB_ACTIONS: "",
      GITHUB_STEP_SUMMARY: "",
      VALIDATION_E2E_SHA: "b".repeat(40),
      VALIDATION_ACCESS_FILE: accountsFile,
      M0_FAKE_FILLS: fills,
    },
  });
  try {
    const receipt = JSON.parse(result.stdout.trim());
    // The fake never confirms a session; the run stops after the viewer submits the form.
    expect(receipt).toMatchObject({ result: "failed", stage: "mobile-viewer-session" });
    const report = JSON.parse(
      readFileSync(join(root, ".browser-results", receipt.runId, "report.json"), "utf8"),
    );
    expect(report.failure).toBeUndefined();
    expect(report.checkpoint).toBe("issued-token");
    const typed = readFileSync(fills, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(typed.slice(-2)).toEqual([
      { label: "E-mail", value: viewer.email },
      { label: "Senha", value: viewer.password },
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    const receipt = /"runId":"([a-f0-9-]{36})"/.exec(result.stdout)?.[1];
    if (receipt) rmSync(join(root, ".browser-results", receipt), { recursive: true, force: true });
  }
});

it("the logout on the phone opens the drawer only after the console settled on the role's page", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "m0-shell-"));
  const accountsFile = join(scratch, "accounts.json");
  const account = (role: string) => ({
    role,
    email: `${role}-offline@validation.invalid`,
    password: `${role}-offline-password`,
    created: true,
  });
  writeFileSync(
    accountsFile,
    JSON.stringify({
      url: browserTarget.consoleUrl,
      accounts: [account("viewer"), account("operator"), account("none")],
    }),
  );
  const preload = new URL("./fixtures/m0-browser/preload.mjs", import.meta.url).href;
  // The fake console renders its shell a moment after each load; a drawer opened before that
  // never opens, and the account menu with "Sair" stays hidden on the phone.
  const result = spawnSync(process.execPath, ["--import", preload, "apps/console/e2e/m0.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...testEnvironment(process.env),
      GITHUB_ACTIONS: "",
      GITHUB_STEP_SUMMARY: "",
      VALIDATION_E2E_SHA: "c".repeat(40),
      VALIDATION_ACCESS_FILE: accountsFile,
      M0_FAKE_FILLS: join(scratch, "fills.jsonl"),
      M0_FAKE_SHELL: "1",
    },
  });
  try {
    const receipt = JSON.parse(result.stdout.trim());
    const report = JSON.parse(
      readFileSync(join(root, ".browser-results", receipt.runId, "report.json"), "utf8"),
    );
    expect({ stage: report.stage, checkpoint: report.checkpoint }).toEqual({
      stage: "complete",
      checkpoint: "revocation",
    });
    expect(receipt.result).toBe("passed");
    const sessions = report.scenarios.filter((s: { id: string }) => s.id.endsWith("-session"));
    expect(sessions.map((s: { id: string; result: string }) => [s.id, s.result])).toEqual(
      ["mobile", "desktop"].flatMap((viewport) =>
        ["viewer", "operator", "none"].map((role) => [`${viewport}-${role}-session`, "passed"]),
      ),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    const receipt = /"runId":"([a-f0-9-]{36})"/.exec(result.stdout)?.[1];
    if (receipt) rmSync(join(root, ".browser-results", receipt), { recursive: true, force: true });
  }
});
