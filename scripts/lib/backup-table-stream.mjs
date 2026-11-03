import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, writeFile, open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { dirname, join } from "node:path";

// One Convex record, including JSON encoding overhead; never buffer an entire table.
export const ROW_LIMIT = 16 * 1024 ** 2;
export async function* tableRows(path) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const row = pending.slice(0, end);
      assert.ok(
        Buffer.byteLength(row) <= ROW_LIMIT,
        "Linha JSONL acima do limite de processamento",
      );
      if (row) yield row;
      pending = pending.slice(end + 1);
    }
    assert.ok(
      Buffer.byteLength(pending) <= ROW_LIMIT,
      "Linha JSONL acima do limite de processamento",
    );
  }
  pending += decoder.end();
  assert.ok(
    Buffer.byteLength(pending) <= ROW_LIMIT,
    "Linha JSONL acima do limite de processamento",
  );
  if (pending) yield pending;
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
async function* merge(paths) {
  const iterators = paths.map((path) => tableRows(path)[Symbol.asyncIterator]());
  try {
    const heads = await Promise.all(iterators.map((iterator) => iterator.next()));
    while (true) {
      let smallest = -1;
      for (let i = 0; i < heads.length; i++)
        if (!heads[i].done && (smallest < 0 || compare(heads[i].value, heads[smallest].value) < 0))
          smallest = i;
      if (smallest < 0) return;
      yield heads[smallest].value;
      heads[smallest] = await iterators[smallest].next();
    }
  } finally {
    await Promise.all(iterators.map((iterator) => iterator.return()));
  }
}

/** Identical to sha256(rows.sort(byCodeUnit).join("\n")), with bounded memory/fan-in. */
export async function sortedTableDigest(rows, tablePath, chunkBytes = 8 * 1024 ** 2) {
  assert.ok(Number.isSafeInteger(chunkBytes) && chunkBytes > 0);
  const directory = await mkdtemp(join(dirname(tablePath), "digest-"));
  let sequence = 0;
  const nextPath = () => join(directory, String(sequence++));
  try {
    let runs = [],
      batch = [],
      bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const path = nextPath();
      await writeFile(path, batch.sort(compare).join("\n") + "\n", { mode: 0o600 });
      runs.push(path);
      batch = [];
      bytes = 0;
    };
    for await (const row of rows) {
      assert.ok(
        Buffer.byteLength(row) <= ROW_LIMIT,
        "Linha JSONL acima do limite de processamento",
      );
      batch.push(row);
      bytes += row.length * 2;
      if (bytes >= chunkBytes) await flush();
    }
    await flush();
    while (runs.length > 16) {
      const next = [];
      for (let i = 0; i < runs.length; i += 16) {
        const path = nextPath(),
          file = await open(path, "wx", 0o600);
        try {
          for await (const row of merge(runs.slice(i, i + 16))) await file.writeFile(row + "\n");
        } finally {
          await file.close();
        }
        next.push(path);
      }
      // Keep only the current merge level; failed passes are cleaned by finally.
      for (const path of runs) await rm(path);
      runs = next;
    }
    const hash = createHash("sha256");
    let first = true;
    for await (const row of merge(runs)) {
      if (!first) hash.update("\n");
      hash.update(row);
      first = false;
    }
    return hash.digest("hex");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
