import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Bucket-wide: lock configuration is shared even by distinct deployment prefixes.
export const BACKUP_LEASE_KEY = "__fnfe_backup_maintenance__/lease.json";
export async function withBackupLease(client, purpose, action) {
  const body = Buffer.from(JSON.stringify({ owner: randomUUID(), purpose, startedAt: Date.now() }));
  assert.ok(
    await client.putImmutable(BACKUP_LEASE_KEY, body, "application/json"),
    "BACKUP_BUSY: backup ou coleta em andamento; lease sem expiração automática",
  );
  let retain = false;
  try {
    return await action();
  } catch (error) {
    retain = error.retainBackupLease === true;
    throw error;
  } finally {
    if (!retain) {
      assert.ok((await client.get(BACKUP_LEASE_KEY)).equals(body), "BACKUP_LEASE_CHANGED");
      await client.delete(BACKUP_LEASE_KEY);
    }
  }
}
