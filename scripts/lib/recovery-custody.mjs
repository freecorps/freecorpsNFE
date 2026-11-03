import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readEnvFile, formatEnvFile } from "./worktree/env-file.mjs";

export const recoveryKeys = [
  "BETTER_AUTH_SECRET",
  "FNFE_WEBHOOK_MASTER_KEY",
  "FNFE_PLATFORM_CERT_KEYS",
];
export const fileHash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function requiredKeys(values) {
  return Object.fromEntries(
    recoveryKeys.map((key) => {
      const value = values.get(key);
      // Name only: malformed or missing material must not enter diagnostics.
      assert.ok(typeof value === "string" && value.length > 0, `Custódia incompleta: ${key}`);
      return [key, value];
    }),
  );
}

export function saveCustody(envPath, custodyPath, snapshotSha256) {
  const keys = requiredKeys(readEnvFile(envPath));
  writeFileSync(custodyPath, JSON.stringify({ snapshotSha256, keys }), { mode: 0o600, flag: "wx" });
  return fileHash(custodyPath);
}

export function readCustody(custodyPath, expectedCustodyHash, snapshotPath, expectedSnapshotHash) {
  assert.equal(
    fileHash(snapshotPath),
    expectedSnapshotHash,
    "Snapshot difere do backup registrado",
  );
  assert.equal(fileHash(custodyPath), expectedCustodyHash, "Custódia difere da cópia registrada");
  const custody = JSON.parse(readFileSync(custodyPath, "utf8"));
  assert.equal(custody.snapshotSha256, expectedSnapshotHash, "Custódia pertence a outro snapshot");
  return requiredKeys(new Map(Object.entries(custody.keys)));
}

export function restoreCustody(envPath, keys) {
  const values = readEnvFile(envPath);
  for (const [key, value] of Object.entries(requiredKeys(new Map(Object.entries(keys)))))
    values.set(key, value);
  writeFileSync(
    envPath,
    formatEnvFile(Object.fromEntries(values), "Custódia recuperada para destino sintético"),
    { mode: 0o600 },
  );
}
