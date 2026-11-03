// SPDX-License-Identifier: MIT
/*
MIT License

Copyright (c) 2026 FREECORPS TECNOLOGIA DA INFORMACAO LTDA

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { verifyWebhook, FreecorpsClient } from "@freecorps/sdk";

/** Persistent inbox and local business effect commit together. Verification never performs I/O. */
export function createReceiver({ database, secrets, client, now = Date.now }) {
  const db = new DatabaseSync(database);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, version INTEGER NOT NULL, effects INTEGER NOT NULL, document TEXT); CREATE TABLE IF NOT EXISTS history_limits(connection TEXT NOT NULL, lost_from TEXT NOT NULL, lost_to TEXT NOT NULL, decided_by TEXT NOT NULL, occurred_at INTEGER NOT NULL, PRIMARY KEY(connection, lost_from));",
    );
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    async receive(body, headers) {
      const checked = await verifyWebhook({ body, headers, secrets: secrets(), now: now() });
      if (!checked.ok) return { status: 400, code: checked.code };
      const event = checked.event;
      const id = `${event.environment}:${event.companyId}:${event.resource.type}:${event.resource.id}`;
      if (db.prepare("SELECT id FROM events WHERE id=?").get(event.eventId))
        return { status: 204, code: "DUPLICATE" };
      const existing = db.prepare("SELECT version FROM resources WHERE id=?").get(id);
      let document = null;
      if (
        event.resource.type === "document" &&
        (!existing || existing.version < event.resource.version)
      ) {
        // The API key is scoped by the caller. Signed selectors do not grant API access.
        document = (
          await client.call("getDocument", {
            path: { documentId: event.resource.id },
            query: { companyId: event.companyId },
            body: {},
          })
        ).data;
        if (document.summary.resourceVersion < event.resource.version)
          return { status: 503, code: "DOCUMENT_BEHIND" };
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        if (db.prepare("SELECT id FROM events WHERE id=?").get(event.eventId)) {
          db.exec("COMMIT");
          return { status: 204, code: "DUPLICATE" };
        }
        const current = db.prepare("SELECT version FROM resources WHERE id=?").get(id);
        db.prepare("INSERT INTO events(id) VALUES (?)").run(event.eventId);
        // The owner accepted, in the console, that these NSUs will never arrive (#442). The range
        // is a fact of its own, kept even if a newer version of the connection arrived first.
        if (event.type === "connection.history_limited")
          db.prepare(
            "INSERT OR IGNORE INTO history_limits(connection,lost_from,lost_to,decided_by,occurred_at) VALUES (?,?,?,?,?)",
          ).run(
            id,
            event.data.lost.from,
            event.data.lost.to,
            event.data.decidedBy,
            event.occurredAt,
          );
        if (current && current.version >= event.resource.version) {
          db.exec("COMMIT");
          return { status: 204, code: "STALE_VERSION" };
        }
        const version = document?.summary.resourceVersion ?? event.resource.version;
        db.prepare(
          "INSERT INTO resources(id,version,effects,document) VALUES (?,?,1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,effects=resources.effects+1,document=excluded.document",
        ).run(id, version, document ? JSON.stringify(document) : null);
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
        historyLimits: db
          .prepare(
            'SELECT lost_from AS "from",lost_to AS "to",decided_by AS decidedBy FROM history_limits ORDER BY connection,lost_from',
          )
          .all()
          .map((row) => ({ ...row })),
      };
    },
    close() {
      db.close();
    },
  };
}

if (process.argv.includes("--serve")) {
  const required = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`Defina ${name}`);
    return value;
  };
  const environment = required("FREECORPS_ENVIRONMENT");
  if (!["sandbox", "production"].includes(environment)) throw new Error("Ambiente inválido");
  const client = new FreecorpsClient({
    baseUrl: required("FREECORPS_BASE_URL"),
    apiKey: required("FREECORPS_API_KEY"),
    environment,
  });
  // Reload a protected file on each delivery to allow rotation without restarting the receiver.
  const { readFileSync } = await import("node:fs");
  const secretFile = required("FREECORPS_WEBHOOK_SECRETS_FILE");
  const receiver = createReceiver({
    database: required("FREECORPS_WEBHOOK_DATABASE"),
    secrets: () => JSON.parse(readFileSync(secretFile, "utf8")),
    client,
  });
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/webhook") {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65_536) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name,
          typeof value === "string" ? value : undefined,
        ]),
      );
      const result = await receiver.receive(Buffer.concat(chunks), headers);
      response.writeHead(result.status).end();
    } catch {
      response.writeHead(503).end();
    }
  });
  server.listen(Number(process.env.PORT ?? 8787), "127.0.0.1", () =>
    console.log("Receptor disponível em /webhook; configure HTTPS para entregas externas."),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => server.close(() => receiver.close()));
}
