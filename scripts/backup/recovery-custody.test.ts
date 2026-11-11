import { afterEach, expect, it } from "vite-plus/test";
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileHash, saveCustody, readCustody, restoreCustody } from "../lib/recovery-custody.mjs";
import { localEnvironment } from "../lib/selfhost-environment.mjs";
import { readEnvFile, formatEnvFile } from "../lib/worktree/env-file.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "fnfe-custody-test-"));
  directories.push(directory);
  const source = join(directory, "source.env"),
    custody = join(directory, "keys.json"),
    snapshot = join(directory, "snapshot.zip"),
    destination = join(directory, "destination.env");
  const keys = {
    BETTER_AUTH_SECRET: "synthetic-auth-secret",
    FNFE_WEBHOOK_MASTER_KEY: "a".repeat(64),
    FNFE_PLATFORM_CERT_KEYS: JSON.stringify({
      active: "v2",
      keys: { v1: "b".repeat(64), v2: "c".repeat(64) },
    }),
  };
  writeFileSync(source, formatEnvFile({ ...keys, SITE_URL: "http://localhost:5510" }, "test"));
  writeFileSync(snapshot, "synthetic snapshot");
  writeFileSync(
    destination,
    formatEnvFile({ SITE_URL: "http://localhost:5520", FNFE_CRONS: "off" }, "test"),
  );
  const snapshotHash = fileHash(snapshot);
  const custodyHash = saveCustody(source, custody, snapshotHash);
  return { source, custody, snapshot, destination, snapshotHash, custodyHash, keys };
}
it("recovers retained versions without the source environment and preserves destination gates and origins", () => {
  const f = fixture();
  unlinkSync(f.source);
  const keys = readCustody(f.custody, f.custodyHash, f.snapshot, f.snapshotHash);
  restoreCustody(f.destination, keys);
  expect(Object.fromEntries(readEnvFile(f.destination))).toEqual({
    ...f.keys,
    SITE_URL: "http://localhost:5520",
    FNFE_CRONS: "off",
  });
});
it.each(["missing", "changed", "wrong-snapshot", "incomplete"])(
  "refuses %s custody before changing destination",
  (scenario) => {
    const f = fixture();
    const before = fileHash(f.destination);
    if (scenario === "missing") unlinkSync(f.custody);
    if (scenario === "changed") writeFileSync(f.custody, "corrupted");
    if (scenario === "wrong-snapshot" || scenario === "incomplete") {
      writeFileSync(
        f.custody,
        JSON.stringify({
          snapshotSha256: scenario === "wrong-snapshot" ? "f".repeat(64) : f.snapshotHash,
          keys: scenario === "incomplete" ? {} : f.keys,
        }),
      );
      f.custodyHash = fileHash(f.custody);
    }
    expect(() =>
      restoreCustody(
        f.destination,
        readCustody(f.custody, f.custodyHash, f.snapshot, f.snapshotHash),
      ),
    ).toThrow();
    expect(fileHash(f.destination)).toBe(before);
  },
);
it("refuses a modified snapshot and will not overwrite a custody copy", () => {
  const f = fixture();
  writeFileSync(f.snapshot, "modified");
  expect(() => readCustody(f.custody, f.custodyHash, f.snapshot, f.snapshotHash)).toThrow(
    "Snapshot difere",
  );
  expect(() => saveCustody(f.source, f.custody, f.snapshotHash)).toThrow();
});
it("reapplies local gates even if the operator changed the environment file", () => {
  const values = new Map(
    Object.entries({
      APP_ENV: "installation",
      FISCAL_ENV: "homologation",
      FNFE_CRONS: "on",
      WEBHOOK_MODE: "https",
      EMAIL_MODE: "mail",
      SITE_URL: "https://foreign.invalid",
      BETTER_AUTH_SECRET: "preserve",
    }),
  );
  expect(Object.fromEntries(localEnvironment(values, "http://localhost:5520"))).toEqual({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    WEBHOOK_MODE: "disabled",
    EMAIL_MODE: "local",
    SITE_URL: "http://localhost:5520",
    BETTER_AUTH_SECRET: "preserve",
  });
  values.set("MAIL_API_KEY", "never-print-this");
  expect(() => localEnvironment(values, "http://localhost:5520")).toThrow(
    "Variável fora do perfil local: MAIL_API_KEY",
  );
});
