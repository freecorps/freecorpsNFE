import assert from "node:assert/strict";
import { createReadStream, createWriteStream } from "node:fs";
import { open, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createInflateRaw, crc32 } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX32 = 0xffffffff;
const integer = (n) => {
  assert.ok(Number.isSafeInteger(n) && n >= 0, "ZIP: tamanho inválido");
  return n;
};
const u64 = (b, at) => integer(Number(b.readBigUInt64LE(at)));
async function read(handle, offset, size) {
  const b = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const result = await handle.read(b, done, size - done, offset + done);
    assert.ok(result.bytesRead > 0, "ZIP truncado");
    done += result.bytesRead;
  }
  return b;
}
export async function fileDigest(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** ZIP/ZIP64: only the directory and one 64 KiB stream chunk need memory. */
export async function extractZip(path, directory, maxBytes) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(path, "r");
  const entries = new Map();
  try {
    const length = (await handle.stat()).size;
    const tailOffset = Math.max(0, length - 22 - 0xffff);
    const tail = await read(handle, tailOffset, length - tailOffset);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), tail.length - 22);
    assert.ok(end >= 0 && end + 22 + tail.readUInt16LE(end + 20) === tail.length, "ZIP inválido");
    assert.equal(tail.readUInt32LE(end + 4), 0, "ZIP multidisco não suportado");
    let count = tail.readUInt16LE(end + 10),
      offset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || offset === MAX32) {
      const locator = await read(handle, tailOffset + end - 20, 20);
      assert.equal(locator.readUInt32LE(0), 0x07064b50, "ZIP64 sem localizador");
      const record = await read(handle, u64(locator, 8), 56);
      assert.equal(record.readUInt32LE(0), 0x06064b50, "ZIP64 inválido");
      count = u64(record, 32);
      offset = u64(record, 48);
    }
    assert.ok(count <= 1_000_000, "ZIP: excesso de entradas");
    let total = 0;
    for (let i = 0; i < count; i++) {
      const h = await read(handle, offset, 46);
      assert.equal(h.readUInt32LE(0), 0x02014b50, "Diretório ZIP inválido");
      const method = h.readUInt16LE(10),
        crc = h.readUInt32LE(16);
      assert.ok(!(h.readUInt16LE(8) & 1) && [0, 8].includes(method), "ZIP: compressão inválida");
      const nameSize = h.readUInt16LE(28),
        extraSize = h.readUInt16LE(30);
      const fields = await read(handle, offset + 46, nameSize + extraSize);
      const name = fields.toString("utf8", 0, nameSize);
      assert.ok(
        name && !name.startsWith("/") && !name.includes("\\") && !name.split("/").includes(".."),
        "ZIP: caminho inválido",
      );
      assert.ok(!entries.has(name), "ZIP: entrada repetida");
      let size = h.readUInt32LE(24),
        compressed = h.readUInt32LE(20),
        local = h.readUInt32LE(42);
      for (let at = nameSize; at < fields.length;) {
        const id = fields.readUInt16LE(at),
          n = fields.readUInt16LE(at + 2);
        assert.ok(at + 4 + n <= fields.length, "ZIP: extra truncado");
        if (id === 1) {
          let cursor = at + 4;
          const next = () => {
            const value = u64(fields, cursor);
            cursor += 8;
            assert.ok(cursor <= at + 4 + n);
            return value;
          };
          if (size === MAX32) size = next();
          if (compressed === MAX32) compressed = next();
          if (local === MAX32) local = next();
        }
        at += 4 + n;
      }
      total += size;
      assert.ok(total <= maxBytes, "ZIP descompactado acima do limite global");
      const header = await read(handle, local, 30);
      assert.equal(header.readUInt32LE(0), 0x04034b50, "Entrada ZIP inválida");
      const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      assert.ok(start + compressed <= offset, "ZIP: entrada fora do arquivo");
      const target = join(directory, String(i));
      let actual = 0,
        checksum = 0;
      const verify = new Transform({
        transform(chunk, _encoding, done) {
          actual += chunk.length;
          checksum = crc32(chunk, checksum);
          done(actual > size ? new Error("ZIP: tamanho descompactado divergente") : null, chunk);
        },
      });
      if (compressed) {
        const source = createReadStream(path, { start, end: start + compressed - 1 });
        await pipeline([
          source,
          ...(method === 8 ? [createInflateRaw()] : []),
          verify,
          createWriteStream(target, { mode: 0o600, flags: "wx" }),
        ]);
      } else {
        const empty = await open(target, "wx", 0o600);
        await empty.close();
      }
      assert.ok(actual === size && checksum === crc, "ZIP: CRC ou tamanho divergente");
      entries.set(name, target);
      offset += 46 + nameSize + extraSize + h.readUInt16LE(32);
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** Stored ZIP64, preserving names and bytes, with a descriptor after each streamed file. */
export async function writeZip(entries, destination, maxBytes) {
  const out = await open(destination, "wx", 0o600);
  let position = 0,
    total = 0;
  const central = [];
  const write = async (b) => {
    let at = 0;
    while (at < b.length) {
      const r = await out.write(b, at, b.length - at, position);
      assert.ok(r.bytesWritten);
      at += r.bytesWritten;
      position += r.bytesWritten;
    }
  };
  try {
    for (const [name, path] of entries) {
      const start = position,
        text = Buffer.from(name),
        header = Buffer.alloc(30),
        extra = Buffer.alloc(20);
      assert.ok(text.length <= 0xffff);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(45, 4);
      header.writeUInt16LE(0x808, 6);
      header.writeUInt32LE(MAX32, 18);
      header.writeUInt32LE(MAX32, 22);
      header.writeUInt16LE(text.length, 26);
      header.writeUInt16LE(extra.length, 28);
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(16, 2);
      await write(header);
      await write(text);
      await write(extra);
      let size = 0,
        checksum = 0;
      for await (const chunk of createReadStream(path)) {
        size += chunk.length;
        total += chunk.length;
        assert.ok(total <= maxBytes, "ZIP acima do limite global");
        checksum = crc32(chunk, checksum);
        await write(chunk);
      }
      const descriptor = Buffer.alloc(24);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeBigUInt64LE(BigInt(size), 8);
      descriptor.writeBigUInt64LE(BigInt(size), 16);
      await write(descriptor);
      const h = Buffer.alloc(46),
        e = Buffer.alloc(28);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(45, 4);
      h.writeUInt16LE(45, 6);
      h.writeUInt16LE(0x808, 8);
      h.writeUInt32LE(checksum, 16);
      h.writeUInt32LE(MAX32, 20);
      h.writeUInt32LE(MAX32, 24);
      h.writeUInt16LE(text.length, 28);
      h.writeUInt16LE(e.length, 30);
      h.writeUInt32LE(MAX32, 42);
      e.writeUInt16LE(1, 0);
      e.writeUInt16LE(24, 2);
      e.writeBigUInt64LE(BigInt(size), 4);
      e.writeBigUInt64LE(BigInt(size), 12);
      e.writeBigUInt64LE(BigInt(start), 20);
      central.push(h, text, e);
    }
    const directory = position;
    for (const b of central) await write(b);
    const directoryBytes = position - directory,
      recordAt = position,
      record = Buffer.alloc(56),
      locator = Buffer.alloc(20),
      end = Buffer.alloc(22);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.size), 24);
    record.writeBigUInt64LE(BigInt(entries.size), 32);
    record.writeBigUInt64LE(BigInt(directoryBytes), 40);
    record.writeBigUInt64LE(BigInt(directory), 48);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(recordAt), 8);
    locator.writeUInt32LE(1, 16);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0xffff, 8);
    end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(MAX32, 12);
    end.writeUInt32LE(MAX32, 16);
    await write(record);
    await write(locator);
    await write(end);
  } finally {
    await out.close();
  }
}
