import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, writeFile, open, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tableRows, sortedTableDigest, ROW_LIMIT } from "./lib/backup-table-stream.mjs";
import {
  diskSummary,
  preflight,
  prepareDatabase,
  GLOBAL_LIMIT,
  readSystemInventory,
} from "./lib/incremental-backup.mjs";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "backup-stream-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

it("preserves existing sorted digests, duplicate rows, Unicode order and empty tables across merge passes", async () => {
  const dir = await directory(),
    path = join(dir, "table");
  const rows = Array.from({ length: 200 }, (_, n) =>
    JSON.stringify({ text: ["á", "😀", "\uE000", "a"][n % 4], n: n % 7 }),
  );
  await writeFile(path, rows.join("\n") + "\n");
  const legacy = createHash("sha256")
    .update([...rows].sort().join("\n"))
    .digest("hex");
  expect(await sortedTableDigest(tableRows(path), path, 1)).toBe(legacy);
  expect(await readdir(dir)).toEqual(["table"]);
  await writeFile(path, "");
  expect(await sortedTableDigest(tableRows(path), path, 1)).toBe(
    createHash("sha256").update("").digest("hex"),
  );
});

it("handles UTF-8 characters split across read buffers and a final row without newline", async () => {
  const path = join(await directory(), "table");
  const rows = ["a".repeat(65535) + "😀", "última"];
  await writeFile(path, rows.join("\n"));
  const actual = [];
  for await (const row of tableRows(path)) actual.push(row);
  expect(actual).toEqual(rows);
});

it("refuses an oversized row and cleans temporary sort files on failure", async () => {
  const dir = await directory(),
    path = join(dir, "table");
  await writeFile(path, "x".repeat(ROW_LIMIT + 1));
  await expect(sortedTableDigest(tableRows(path), path)).rejects.toThrow(/Linha JSONL/);
  expect(await readdir(dir)).toEqual(["table"]);
});

it("prepares and verifies a table above 64 MiB without changing its historical digest", async () => {
  const dir = await directory(),
    path = join(dir, "table"),
    index = join(dir, "index");
  const row = JSON.stringify({ payload: "a".repeat(600_000), storageId: "synthetic" });
  const expected = createHash("sha256");
  const file = await open(path, "wx");
  try {
    for (let i = 0; i < 120; i++) {
      await file.writeFile(row + "\n");
      if (i) expected.update("\n");
      expected.update(row);
    }
  } finally {
    await file.close();
  }
  await writeFile(index, "");
  const entries = new Map([
    ["_tables/documents.jsonl", index],
    ["documentArtifacts/documents.jsonl", path],
  ]);
  expect((await prepareDatabase(entries)).references).toEqual(new Set(["synthetic"]));
  const summary = await diskSummary(entries);
  expect(summary.tables).toMatchObject({ documentArtifacts: 120 });
  expect(summary.digests).toMatchObject({
    "documentArtifacts/documents.jsonl": expected.digest("hex"),
  });
  const query = async (functionPath: string, _args: unknown, component: string) => ({
    page: component
      ? []
      : functionPath.endsWith("/tables")
        ? [{ name: "documentArtifacts" }]
        : Array.from({ length: 120 }, () => JSON.parse(row)),
    isDone: true,
    continueCursor: "done",
  });
  expect((await readSystemInventory(query, GLOBAL_LIMIT)).databaseBytes).toBeGreaterThan(
    64 * 1024 ** 2,
  );
  await expect(readSystemInventory(query, GLOBAL_LIMIT, { legacyFormat: true })).rejects.toThrow(
    /64 MiB/,
  );
}, 60_000);

it("admits 2 GiB of files plus database reserve only with an explicit larger budget", () => {
  const storage = [
    {
      metadata: {
        _id: "synthetic",
        _creationTime: 0,
        size: 2 * 1024 ** 3,
        sha256: Buffer.alloc(32).toString("base64"),
      },
    },
  ];
  const input = { databaseBytes: 256 * 1024 ** 2, storage, tables: 200 };
  expect(() => preflight({ ...input, maxBytes: 1024 ** 3 })).toThrow(/acima do limite/);
  expect(preflight({ ...input, maxBytes: GLOBAL_LIMIT }).storageBytes).toBe(2 * 1024 ** 3);
  expect(() => preflight({ ...input, maxBytes: GLOBAL_LIMIT + 1 })).toThrow(
    /Limite global inválido/,
  );
});
