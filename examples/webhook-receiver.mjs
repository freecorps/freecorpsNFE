import { DatabaseSync } from "node:sqlite";
import { verifyWebhook } from "../packages/contracts/src/webhooks.ts";

/** Node 24 reference receiver. Effects and deduplication commit in the same local transaction. */
export function createWebhookReceiver({ database = ":memory:", secrets, clock = Date.now }) {
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, version INTEGER NOT NULL, effects INTEGER NOT NULL);`);
  return {
    async receive(body, headers) {
      const verification = await verifyWebhook({ body, headers, secrets: secrets(), now: clock() });
      if (!verification.ok) return { status: 400, code: verification.code };
      const event = verification.event;
      const id = `${event.environment}:${event.companyId}:${event.resource.type}:${event.resource.id}`;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (db.prepare("SELECT id FROM events WHERE id = ?").get(event.eventId)) {
          db.exec("COMMIT");
          return { status: 204, code: "DUPLICATE" };
        }
        const resource = db.prepare("SELECT version, effects FROM resources WHERE id = ?").get(id);
        db.prepare("INSERT INTO events(id) VALUES (?)").run(event.eventId);
        if (resource && resource.version >= event.resource.version) {
          db.exec("COMMIT");
          return { status: 204, code: "STALE_VERSION" };
        }
        // The reference business effect is a counter. Real effects must share this transaction.
        db.prepare(
          "INSERT INTO resources(id,version,effects) VALUES (?,?,1) ON CONFLICT(id) DO UPDATE SET version=excluded.version,effects=resources.effects+1",
        ).run(id, event.resource.version);
        db.exec("COMMIT");
        return { status: 204, code: "APPLIED" };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    inspect() {
      return {
        events: db.prepare("SELECT count(*) AS count FROM events").get().count,
        resources: db
          .prepare("SELECT version,effects FROM resources ORDER BY id")
          .all()
          .map((row) => ({ ...row })),
      };
    },
    close() {
      db.close();
    },
  };
}
