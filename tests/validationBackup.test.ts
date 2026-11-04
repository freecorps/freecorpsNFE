import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBackupDirectory } from "../scripts/lib/validation-backup.mjs";

let temporary: string;
let checkout: string;
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "fnfe-backup-test-"));
  checkout = join(temporary, "checkout");
  mkdirSync(checkout);
});
afterEach(() => {
  // Only remove the fixture directory allocated by this test, never a checkout.
  expect(dirname(resolve(temporary))).toBe(resolve(tmpdir()));
  expect(basename(temporary)).toMatch(/^fnfe-backup-test-/);
  rmSync(temporary, { recursive: true, force: true });
});

it("rejects relative, identical and nested destinations without creating them", () => {
  const nested = join(checkout, "new", "backups");
  for (const path of [undefined, "backups", checkout, nested]) {
    expect(() => validateBackupDirectory(path, checkout)).toThrow("VALIDATION_BACKUP_DIR");
  }
  expect(existsSync(nested)).toBe(false);
});

it("allows existing and new outside directories, including a sibling with the same prefix", () => {
  const existing = join(temporary, "durable");
  mkdirSync(existing);
  expect(validateBackupDirectory(existing, checkout)).toBe(realpathSync(existing));
  const sibling = join(temporary, "checkout-backups", "new");
  expect(validateBackupDirectory(sibling, checkout)).toBe(
    join(realpathSync(temporary), "checkout-backups", "new"),
  );
  expect(existsSync(sibling)).toBe(false);
});

it("rejects an external junction or symlink leading into the checkout", () => {
  const alias = join(temporary, "alias");
  symlinkSync(checkout, alias, process.platform === "win32" ? "junction" : "dir");
  expect(() => validateBackupDirectory(join(alias, "new", "backup"), checkout)).toThrow(
    "outside the checkout",
  );
});

it("canonicalizes the checkout itself when it is reached through an alias", () => {
  const alias = join(temporary, "alias");
  symlinkSync(checkout, alias, process.platform === "win32" ? "junction" : "dir");
  expect(() => validateBackupDirectory(join(checkout, "backup"), alias)).toThrow(
    "outside the checkout",
  );
});

it("fails closed on a dangling link without creating its target", () => {
  const missing = join(temporary, "missing");
  const alias = join(temporary, "broken");
  symlinkSync(missing, alias, process.platform === "win32" ? "junction" : "dir");
  expect(() => validateBackupDirectory(join(alias, "backup"), checkout)).toThrow();
  expect(existsSync(missing)).toBe(false);
});

it("rejects an inside path in the actual backup command before network or filesystem writes", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const target = join(root, "backup-must-not-be-created");
  const child = spawnSync(process.execPath, [join(root, "scripts/validation/validation.mjs"), "backup"], {
    env: {
      ...process.env,
      VALIDATION_CONVEX_DEPLOY_KEY: "dev:modest-seal-118|synthetic-test-key",
      VALIDATION_BACKUP_DIR: target,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(child.status).toBe(1);
  expect(child.stderr).toContain("outside the checkout");
  expect(child.stdout).not.toContain("target:");
  expect(existsSync(target)).toBe(false);
});
