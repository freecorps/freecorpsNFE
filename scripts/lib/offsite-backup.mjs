import assert from "node:assert/strict";
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileDigest } from "./offsite-backup-zip.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// Code-unit order: digests must not depend on the locale of the machine.
export const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const HOUR = 3_600_000;

// D04: the plan names custodians and targets; credentials stay in the runner and with custodians.
export function backupPlan(raw, release) {
  assert.equal(raw.version, 1, "Plano de backup: versão desconhecida");
  assert.match(raw.bucket, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "Plano de backup: bucket inválido");
  assert.equal(raw.prefix, `${release.deployment}/`, "Plano de backup: prefixo difere do alvo");
  for (const name of ["cadenceHours", "alertAfterHours", "retentionDays", "rpoHours", "rtoHours"])
    assert.ok(Number.isInteger(raw[name]) && raw[name] > 0, `Plano de backup: ${name} inválido`);
  assert.ok(raw.alertAfterHours > raw.cadenceHours && raw.alertAfterHours < raw.rpoHours);
  assert.ok(Number.isInteger(raw.maxSnapshotBytes) && raw.maxSnapshotBytes > 0);
  assert.ok(
    raw.incremental?.version === 2 || raw.maxSnapshotBytes <= 1024 ** 3,
    "Formato 1 limitado a 1 GiB; use o formato 2 para volumes maiores",
  );
  // ADR 0010, phase C: the cold tier's bucket, which the backup references and checks.
  if (raw.coldTier !== undefined)
    assert.match(
      raw.coldTier?.bucket ?? "",
      /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
      "Plano de backup: bucket frio inválido",
    );
  const custodians = new Set(),
    recipients = new Set();
  for (const entry of raw.recipients) {
    assert.match(entry.custodian, /^[A-Za-z0-9-]{1,39}$/, "Plano de backup: custodiante inválido");
    assert.match(
      entry.recipient,
      /^age1[02-9ac-hj-np-z]{58}$/,
      "Plano de backup: chave age inválida",
    );
    custodians.add(entry.custodian);
    recipients.add(entry.recipient);
  }
  // A single lost identity must not make every retained copy unreadable.
  assert.ok(
    custodians.size >= 2 && recipients.size === raw.recipients.length,
    "Custódia exige chaves públicas age de ao menos dois custodiantes distintos",
  );
  return {
    ...raw,
    deployment: release.deployment,
    accountId: release.accountId,
    site: release.site,
    cloud: release.cloud,
  };
}

const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
export const snapshotId = (date) => date.toISOString().slice(0, 19).replaceAll(":", "-") + "Z";
export const snapshotTime = (id) => {
  assert.match(id, stamp, "Identificador de snapshot inválido");
  return Date.parse(id.slice(0, 11) + id.slice(11, 19).replaceAll("-", ":") + "Z");
};
export const objectKeys = (plan, id) => ({
  snapshot: `${plan.prefix}snapshots/${id}/snapshot.zip.age`,
  manifest: `${plan.prefix}snapshots/${id}/manifest.json`,
});

// Fingerprints let a restore prove custody matches the snapshot without storing key material.
const fingerprint = (name, value) => sha256(`fnfe-custody:v1:${name}:${value}`);
const custodyValue = (values, name) => {
  const value = values instanceof Map ? values.get(name) : values[name];
  assert.ok(typeof value === "string" && value.length > 0, `Custódia incompleta: ${name}`);
  return value;
};
export function custodyFingerprints(values) {
  const get = (name) => custodyValue(values, name);
  let ring;
  try {
    ring = JSON.parse(get("FNFE_PLATFORM_CERT_KEYS"));
  } catch {
    throw new Error("Custódia incompleta: FNFE_PLATFORM_CERT_KEYS");
  }
  assert.ok(
    ring?.keys && typeof ring.keys === "object" && Object.hasOwn(ring.keys, ring.active),
    "Custódia incompleta: FNFE_PLATFORM_CERT_KEYS",
  );
  return {
    BETTER_AUTH_SECRET: fingerprint("BETTER_AUTH_SECRET", get("BETTER_AUTH_SECRET")),
    FNFE_WEBHOOK_MASTER_KEY: fingerprint("FNFE_WEBHOOK_MASTER_KEY", get("FNFE_WEBHOOK_MASTER_KEY")),
    FNFE_PLATFORM_CERT_KEYS: {
      active: ring.active,
      versions: Object.fromEntries(
        Object.entries(ring.keys)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([version, key]) => [
            version,
            fingerprint(`FNFE_PLATFORM_CERT_KEYS:${version}`, key),
          ]),
      ),
    },
  };
}
/** Every key version used by the snapshot must exist in custody with the recorded bytes. */
export function verifyCustody(manifest, values) {
  const actual = custodyFingerprints(values),
    expected = manifest.custody;
  // assert.ok keeps fingerprints out of the diagnostic; the name is enough to act on.
  for (const name of ["BETTER_AUTH_SECRET", "FNFE_WEBHOOK_MASTER_KEY"])
    assert.ok(actual[name] === expected[name], `Custódia difere do snapshot: ${name}`);
  for (const version of manifest.requiredCertificateKeyVersions)
    assert.ok(
      actual.FNFE_PLATFORM_CERT_KEYS.versions[version] ===
        expected.FNFE_PLATFORM_CERT_KEYS.versions[version],
      `Custódia difere do snapshot: FNFE_PLATFORM_CERT_KEYS:${version}`,
    );
  return actual;
}

/**
 * The age recipients are public, so a bucket writer can produce a coherent ciphertext and
 * manifest. The manifest is authenticated with a key only the producer and the custodians hold:
 * HKDF-SHA256 of two custody secrets that the snapshot job already reads from the source and
 * that recovery already requires. The key and the secrets never leave this module.
 */
const manifestScheme = "hmac-sha256:fnfe-offsite-manifest:v1";
function manifestMac(manifest, values) {
  const part = (name) => {
    const bytes = Buffer.from(custodyValue(values, name), "utf8"),
      length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.concat([part("BETTER_AUTH_SECRET"), part("FNFE_WEBHOOK_MASTER_KEY")]),
      Buffer.alloc(0),
      "fnfe-offsite-manifest:v1",
      32,
    ),
  );
  const { authentication: _authentication, ...body } = manifest;
  return createHmac("sha256", key).update(JSON.stringify(body)).digest();
}
export function authenticateManifest(manifest, values) {
  assert.ok(!Object.hasOwn(manifest, "authentication"), "Manifesto já autenticado");
  return {
    ...manifest,
    authentication: { scheme: manifestScheme, mac: manifestMac(manifest, values).toString("hex") },
  };
}
/**
 * Runs before recovery uses any size, hash or object from the manifest. A manifest without
 * authentication predates it and is accepted only when the custodian names the ciphertext hash
 * read from the producer's receipt in GitHub Actions; an invalid MAC is never accepted.
 */
export function verifyManifestAuthentication(manifest, values, acceptedCiphertextSha256) {
  if (acceptedCiphertextSha256 !== undefined)
    assert.match(
      acceptedCiphertextSha256,
      /^[a-f0-9]{64}$/,
      "--accept-unauthenticated exige o sha256 da cifra do recibo",
    );
  if (!Object.hasOwn(manifest, "authentication")) {
    assert.ok(
      acceptedCiphertextSha256 !== undefined,
      "Manifesto sem autenticação; confira o recibo do snapshot e use --accept-unauthenticated <sha256 da cifra>",
    );
    assert.ok(
      manifest.ciphertext?.sha256 === acceptedCiphertextSha256,
      "Cifra do manifesto difere do hash aceito",
    );
    return "accepted-unauthenticated";
  }
  const { scheme, mac } = manifest.authentication ?? {};
  const expected = manifestMac(manifest, values);
  assert.ok(
    scheme === manifestScheme &&
      typeof mac === "string" &&
      /^[a-f0-9]{64}$/.test(mac) &&
      timingSafeEqual(Buffer.from(mac, "hex"), expected),
    "Manifesto com autenticação inválida",
  );
  return "verified";
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const MAX32 = 0xffffffff;
const u64 = (buffer, at) => Number(buffer.readBigUInt64LE(at));
/**
 * Reads every entry of a Convex export, which writes zip64 fields, and checks its CRC.
 * `maxBytes` caps the expanded total: the declared sizes are summed before anything is
 * inflated, and no deflated entry may expand beyond its declared size.
 */
export function readZip(buffer, maxBytes) {
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0, "Zip: limite de expansão inválido");
  // The EOCD sits within the last 22 bytes plus at most a 64 KiB comment.
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), buffer.length - 22);
  assert.ok(end >= 0 && end >= buffer.length - 22 - 0xffff, "Snapshot não é um zip válido");
  let count = buffer.readUInt16LE(end + 10),
    offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || offset === MAX32) {
    assert.ok(end >= 20 && buffer.readUInt32LE(end - 20) === 0x07064b50, "Zip64 sem localizador");
    const record = u64(buffer, end - 12);
    assert.equal(buffer.readUInt32LE(record), 0x06064b50, "Zip64 corrompido");
    count = u64(buffer, record + 32);
    offset = u64(buffer, record + 48);
  }
  const directoryStart = offset,
    members = [],
    names = new Set();
  let total = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "Diretório do zip corrompido");
    const method = buffer.readUInt16LE(offset + 10),
      crc = buffer.readUInt32LE(offset + 16),
      nameLength = buffer.readUInt16LE(offset + 28),
      extra = buffer.readUInt16LE(offset + 30),
      comment = buffer.readUInt16LE(offset + 32);
    let compressed = buffer.readUInt32LE(offset + 20),
      size = buffer.readUInt32LE(offset + 24),
      local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    // Zip64 extra (0x0001) holds, in order, only the fields saturated in the header.
    for (let at = offset + 46 + nameLength; at < offset + 46 + nameLength + extra;) {
      const id = buffer.readUInt16LE(at),
        length = buffer.readUInt16LE(at + 2);
      if (id === 1) {
        let field = at + 4;
        const next = () => ((field += 8), u64(buffer, field - 8));
        if (size === MAX32) size = next();
        if (compressed === MAX32) compressed = next();
        if (local === MAX32) local = next();
      }
      at += 4 + length;
    }
    assert.ok(
      size !== MAX32 && compressed !== MAX32 && local !== MAX32,
      `Zip64 incompleto: ${name}`,
    );
    assert.ok(method === 0 || method === 8, `Compressão não suportada: ${name}`);
    assert.ok(!names.has(name), `Entrada repetida: ${name}`);
    names.add(name);
    total += size;
    assert.ok(total <= maxBytes, "Snapshot descompactado acima do limite do plano");
    assert.ok(local + 30 <= directoryStart, `Entrada fora do arquivo: ${name}`);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50, `Entrada corrompida: ${name}`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    assert.ok(start + compressed <= directoryStart, `Entrada fora do arquivo: ${name}`);
    members.push({ name, method, crc, size, local, start, end: start + compressed });
    offset += 46 + nameLength + extra + comment;
  }
  // Names sharing compressed bytes would expand the same member more than once.
  const byPosition = members.toSorted((a, b) => a.local - b.local);
  for (let i = 1; i < byPosition.length; i++)
    assert.ok(
      byPosition[i].local >= byPosition[i - 1].end,
      `Entradas sobrepostas: ${byPosition[i].name}`,
    );
  const entries = new Map();
  for (const { name, method, crc, size, start, end: stop } of members) {
    const raw = buffer.subarray(start, stop);
    let data;
    try {
      // Inflation stops past the declared size; zlib needs a positive bound for empty entries.
      data =
        method === 0
          ? Buffer.from(raw)
          : inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    } catch (error) {
      if (error?.code !== "ERR_BUFFER_TOO_LARGE") throw error;
      throw new Error(`Entrada expande além do tamanho declarado: ${name}`);
    }
    assert.ok(data.length === size && crc32(data) === crc, `CRC divergente: ${name}`);
    entries.set(name, data);
  }
  return entries;
}

const lines = (data) => (data.length ? data.toString("utf8").split("\n").filter(Boolean) : []);
const tablePath = (name) =>
  /^(?:_components\/.+\/)?[A-Za-z][A-Za-z0-9_]*\/documents\.jsonl$/.test(name);
/** Counts, order-independent digests and storage integrity for an export. */
export function snapshotSummary(entries) {
  /** @type {Record<string, number>} */
  const tables = {};
  /** @type {Record<string, string>} */
  const digests = {};
  let files = 0,
    bytes = 0;
  for (const [name, data] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    if (name.endsWith("/_storage/documents.jsonl") || name === "_storage/documents.jsonl") {
      const base = name.slice(0, -"documents.jsonl".length);
      // The export appends an extension derived from contentType: _storage/<id>.xml, .pdf.
      /** @type {Map<string, Buffer>} */
      const blobs = new Map();
      for (const [path, blob] of entries) {
        if (!path.startsWith(base) || path === name || path.slice(base.length).includes("/"))
          continue;
        const id = path.slice(base.length).split(".")[0];
        assert.ok(!blobs.has(id), `Arquivo repetido no snapshot: ${base}${id}`);
        blobs.set(id, blob);
      }
      for (const line of lines(data)) {
        const meta = JSON.parse(line),
          blob = blobs.get(meta._id);
        assert.ok(blob, `Arquivo ausente no snapshot: ${base}${meta._id}`);
        // Convex records storage sha256 in base64; a mismatch means a corrupt or partial export.
        assert.equal(
          createHash("sha256").update(blob).digest("base64"),
          meta.sha256,
          `Arquivo divergente no snapshot: ${base}${meta._id}`,
        );
        files++;
        bytes += blob.length;
      }
      digests[name] = sha256(lines(data).sort(byCodeUnit).join("\n"));
      continue;
    }
    if (!tablePath(name) || name.includes("/_tables/") || name.startsWith("_tables/")) continue;
    const rows = lines(data);
    tables[name.slice(0, -"/documents.jsonl".length)] = rows.length;
    digests[name] = sha256(rows.sort(byCodeUnit).join("\n"));
  }
  assert.ok(entries.has("_tables/documents.jsonl"), "Snapshot sem índice de tabelas");
  return { tables, storage: { files, bytes }, digests };
}

// Copy: a small Buffer's .buffer is the shared allocation pool, not just these bytes.
const bytesOf = (value) =>
  Uint8Array.from(Buffer.from(typeof value === "string" ? value : value.$bytes, "base64")).buffer;
export function certificateEnvelopes(entries) {
  return lines(entries.get("certificates/documents.jsonl") ?? Buffer.alloc(0))
    .map((line) => JSON.parse(line))
    .filter((row) => row.envelope)
    .map((row) => ({
      context: {
        organizationId: row.organizationId,
        companyId: row.companyId,
        id: row._id,
        version: row.version,
      },
      envelope: {
        format: row.envelope.format,
        keyVersion: row.envelope.keyVersion,
        wrappedKey: bytesOf(row.envelope.wrappedKey),
        pfx: bytesOf(row.envelope.pfx),
        password: bytesOf(row.envelope.password),
      },
    }));
}
export function webhookSecrets(entries) {
  const result = [];
  for (const line of lines(entries.get("webhookEndpoints/documents.jsonl") ?? Buffer.alloc(0))) {
    const row = JSON.parse(line);
    if (row.secret) result.push({ cipher: row.secret, context: `${row._id}:${row.secretVersion}` });
    if (row.previousSecret)
      result.push({ cipher: row.previousSecret, context: `${row._id}:${row.previousVersion}` });
  }
  return result;
}

/** Health of the off-host copies as seen by the monitor. */
export function evaluateBackups(plan, ids, latest, now) {
  const problems = [];
  if (!ids.length) return { problems: ["Nenhum backup externo encontrado"], count: 0 };
  const sorted = [...ids].sort(byCodeUnit),
    newest = sorted.at(-1),
    oldest = sorted[0];
  // The recovery point is the export start, not the upload time.
  const latestAgeHours = latest ? (now - latest.snapshotStartedAt) / HOUR : null;
  if (!latest) problems.push("Nenhum backup externo íntegro encontrado");
  else if (latest.id !== newest) problems.push(`Snapshot ${newest} sem manifesto íntegro`);
  if (latest && latestAgeHours > plan.alertAfterHours)
    problems.push(
      `Último backup íntegro tem ${latestAgeHours.toFixed(1)} h (alerta acima de ${plan.alertAfterHours} h; RPO ${plan.rpoHours} h)`,
    );
  // Lifecycle deletion is asynchronous; one extra day avoids false alarms.
  const oldestAgeDays = (now - snapshotTime(oldest)) / (24 * HOUR);
  if (oldestAgeDays > plan.retentionDays + 1)
    problems.push(
      `Cópia de ${oldest} excede a retenção de ${plan.retentionDays} dias; conferir lifecycle do bucket`,
    );
  return { problems, count: ids.length, newest, oldest, latestAgeHours, oldestAgeDays };
}

// SigV4 for the S3-compatible R2 endpoint (region "auto", path-style).
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export function signRequest({ method, url, headers = {}, payloadHash, credentials, region, now }) {
  const target = new URL(url),
    date = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, ""),
    day = date.slice(0, 8);
  const all = {
    ...Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]),
    ),
    host: target.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
  };
  const names = Object.keys(all).sort(byCodeUnit);
  const query = [...target.searchParams]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const path = target.pathname
    .split("/")
    .map((segment) => encode(decodeURIComponent(segment)))
    .join("/");
  const canonical = [
    method,
    path,
    query,
    names.map((name) => `${name}:${all[name]}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonical)].join("\n");
  const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [region, "s3", "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const xmlText = (value) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => entities[name]);
/** Actionable diagnostics without copying external payloads or assertion values. */
export function backupFailure(error) {
  const message = error instanceof Error ? error.message : "";
  const gc = message.match(
    /^BACKUP_GC_(SOURCE_NOT_PAUSED|INVENTORY_INCOMPLETE|LEGAL_HOLD|ARCHIVE_MOVING|ARCHIVE_INCOMPLETE|SNAPSHOTS_INCOMPLETE|MANIFEST_INVALID|BACKUP_STALE|OBJECT_INCOMPLETE|PLAN_CHANGED|PERMANENT_LOCK_MISSING|LOCK_RECOVERY_REQUIRED|LOCK_RULE_LIMIT|LOCK_VERIFY_FAILED|DELETE_NOT_CONFIRMED|LOCK_TOKEN_REQUIRED|LOCK_API_FAILED|LIST_INCOMPLETE|IDENTITY_REQUIRED|PLAN_INVALID)(?:\n|$)/,
  );
  if (gc) return `BACKUP_GC_${gc[1]}`;
  // Return our own literals, never the assertion diff or a provider's payload.
  const known = [
    "BACKUP_BUSY: backup ou coleta em andamento; lease sem expiração automática",
    "BACKUP_LEASE_CHANGED",
    "Use --target issuance, ou nenhum",
    "--target issuance só vale para snapshot e check",
    "BACKUP_CRYPTO_TOOL_FAILED: confira age e age-keygen no runner",
    "Produção não informa o SHA publicado",
    "Validation backend rejected the operation",
    "Invalid worktree application",
    "CERTIFICATE_KEY_UNAVAILABLE",
    "CERTIFICATE_ENVELOPE_INVALID",
    "CONVEX_DEPLOY_KEY deve ser a chave de produção do alvo aprovado",
    "Houve publicação durante o export; o próximo ciclo repete",
    "Snapshot acima do limite do plano",
    "Arquivo econômico exige backup incremental com manifesto frio verificável",
    "Cifra não reproduz o snapshot",
    "Cópia enviada difere do arquivo cifrado",
    "Inventário de storage inválido",
    "Preflight: acima do limite global; export não iniciado",
    "Inventário sem progresso",
    "Cifra não reproduz o original",
    "Snapshot já existe; não sobrescrever",
    "Houve publicação durante o export; repetir",
    "Banco acima do limite global",
    "Referência criada/removida durante snapshot sem cópia comprovada; repetir",
    "Snapshot incompleto",
    "Versão de chave ausente da custódia",
    "BACKUP_CHECK_FAILED: consulte problems no recibo",
    "O diretório de recuperação precisa estar vazio",
    "Informe --identity e --custody",
    "Manifesto já autenticado",
    "--accept-unauthenticated exige o sha256 da cifra do recibo",
    "Manifesto sem autenticação; confira o recibo do snapshot e use --accept-unauthenticated <sha256 da cifra>",
    "Cifra do manifesto difere do hash aceito",
    "Manifesto com autenticação inválida",
    "--accept-unauthenticated só vale para fetch e rehearse",
    "--accept-unauthenticated exige --snapshot <id> conferido no recibo",
    "Nenhum backup externo completo encontrado",
    "Snapshot decifrado difere do manifesto",
    "Conteúdo do snapshot difere do manifesto",
    "Cifra do banco divergente",
    "Banco decifrado divergente",
    "Destino precisa ser um worktree da plataforma",
    "Destino sem deployment local configurado",
    "Destino precisa ser local",
    "BACKUP_LOCAL_CALL_FAILED: confira o backend local e as pré-condições do ensaio",
    "O destino precisa estar no SHA do snapshot",
    "Ensaio fora das metas de RPO/RTO",
    "Use snapshot, check, fetch --out <dir> ou rehearse <worktree>, com --identity/--custody na recuperação",
    "Plano de backup: versão desconhecida",
    "Plano de backup: bucket inválido",
    "Plano de backup: prefixo difere do alvo",
    "Plano de backup: custodiante inválido",
    "Plano de backup: chave age inválida",
    "Custódia exige chaves públicas age de ao menos dois custodiantes distintos",
    "Identificador de snapshot inválido",
    "Custódia incompleta: FNFE_PLATFORM_CERT_KEYS",
    "Snapshot não é um zip válido",
    "Zip64 sem localizador",
    "Zip64 corrompido",
    "Diretório do zip corrompido",
    "Zip: limite de expansão inválido",
    "Snapshot descompactado acima do limite do plano",
    "Snapshot sem índice de tabelas",
    "Credenciais R2 ausentes",
    "Objeto R2 acima do limite",
    "Objeto R2 acima do tamanho esperado",
    "Objeto R2 corrompido",
    "Configure incremental.version=2 antes de ativar",
    "Plano de backup: bucket frio inválido",
    "Documento frio sem referência íntegra",
    "Tabela sem objeto frio",
    "Backup com documentos frios exige coldTier.bucket no plano",
    "Backup com documentos frios exige acesso de leitura ao bucket frio",
    "Documento frio ausente ou alterado",
    "Backup não cobre os documentos frios",
    "Lista de documentos frios ausente ou alterada",
    "Documentos frios do pacote inválidos",
    "Define R2_COLD_READ_ACCESS_KEY_ID e R2_COLD_READ_SECRET_ACCESS_KEY juntos.",
    "Pacote com documentos frios exige o bucket frio",
    "Lista de documentos frios divergente",
    "Pacote com documentos frios exige acesso às regras de lock",
    "Prefixo de objetos deve ser separado de snapshots/",
    "Confirme lifecycle separado, lock e coleta por referências antes de ativar",
    "Incremental mantém a cadência de 12 h",
    "Limite global máximo: 1 GiB",
    "Limite global máximo: 8 GiB",
    "Linha JSONL acima do limite de processamento",
    "Formato 1 limitado a 1 GiB; use o formato 2 para volumes maiores",
    "Hash de arquivo inválido",
    "Storage ID inválido",
    "Metadados de storage inválidos",
    "Hash de storage inválido",
    "Preflight sem medição de banco",
    "Limite global inválido",
    "Preflight: banco + arquivos + reserva acima do limite global; export não iniciado",
    "Inventário incompleto",
    "Tabela inválida no inventário",
    "Preflight: tabela acima do limite de processamento (64 MiB)",
    "Preflight: banco acima do limite global; export não iniciado",
    "Tabela acima do limite de processamento (64 MiB)",
    "Runtime sem JSON.parse source; preserve o export original",
    "Componente ausente do preflight",
    "Storage de componente exige inventário próprio",
    "Backup aguarda conclusão da movimentação do arquivo econômico",
    "Catálogo frio sem manifesto íntegro",
    "Manifesto frio fora da organização",
    "Cifra fria inválida",
    "Catálogo compactado sem manifesto",
    "Manifesto frio corrompido",
    "Manifesto frio ausente ou alterado",
    "Manifesto do catálogo ausente ou alterado",
    "Catálogo frio fora do pacote",
    "Arquivo ausente no snapshot",
    "Arquivo divergente no snapshot",
    "Storage excedeu tamanho previsto",
    "Storage diverge dos metadados",
    "Prova de objeto inválida",
    "Objeto sem prova; reconciliar antes de repetir",
    "Arquivo desapareceu antes da cópia; manifesto não publicado",
    "Objeto criado por outro executor; repita",
    "Prova concorrente; repita",
    "Storage ID repetido",
    "Backup não cobre o catálogo frio",
    "Manifesto sem objetos",
    "Objeto repetido no manifesto",
    "Snapshot sem metadados de storage",
    "Restore acima do limite global",
    "Manifesto não cobre referência de storage",
    "Objeto fora do prefixo permanente",
    "Cifra de objeto divergente",
    "Original restaurado divergente",
    "Storage ID repetido no restore",
    "Conteúdo restaurado diverge do manifesto",
    "Prova de restore diverge do original",
    "Snapshot concorrente",
    "Manifesto concorrente",
    "ZIP: tamanho inválido",
    "ZIP truncado",
    "ZIP inválido",
    "ZIP multidisco não suportado",
    "ZIP64 sem localizador",
    "ZIP64 inválido",
    "ZIP: excesso de entradas",
    "Diretório ZIP inválido",
    "ZIP: compressão inválida",
    "ZIP: caminho inválido",
    "ZIP: entrada repetida",
    "ZIP: extra truncado",
    "ZIP descompactado acima do limite global",
    "Entrada ZIP inválida",
    "ZIP: entrada fora do arquivo",
    "ZIP: tamanho descompactado divergente",
    "ZIP: CRC ou tamanho divergente",
    "ZIP acima do limite global",
    "VALIDATION_BACKUP_DIR must be an absolute path outside the checkout",
    "VALIDATION_BACKUP_DIR must be outside the checkout, including linked paths",
    "Unsupported release plan or product environment",
    "Approved legacy production deployment required",
    "Existing backoffice Worker and account required",
    "Approved backoffice address required",
    "Approved API address required",
    "PLAN_INVALID: deploy/issuance-production.json fora do formato da versão 1.",
    "PLAN_INVALID: deploy/issuance-production.json com deployment ou url inválidos.",
  ];
  const diagnostic = known.find((text) => message === text || message.startsWith(`${text}\n`));
  if (diagnostic) return diagnostic;
  // Snapshot identifiers and assertion values are not part of the public diagnostic.
  if (/^Snapshot [^\n]+: hash divergente(?:\n|$)/.test(message))
    return "BACKUP_CIPHERTEXT_HASH_MISMATCH: preserve a cópia e investigue a integridade";
  if (/^Snapshot [^\n]+: tamanho divergente(?:\n|$)/.test(message))
    return "BACKUP_CIPHERTEXT_SIZE_MISMATCH: preserve a cópia e investigue a integridade";
  const http = message.match(
    /^(R2 (?:GET|PUT|HEAD|DELETE)|Health de produção|Download de storage falhou): HTTP ([1-5][0-9]{2})(?:\n|$)/,
  );
  if (http) return `${http[1]}: HTTP ${http[2]}`;
  const backendHttp = message.match(/^Validation backend HTTP ([1-5][0-9]{2})(?:\n|$)/);
  if (backendHttp) return `Validation backend HTTP ${backendHttp[1]}`;
  for (const [prefix, code] of [
    ["Plano de backup:", "BACKUP_PLAN_INVALID: confira o plano versionado"],
    ["Custódia incompleta:", "BACKUP_CUSTODY_INCOMPLETE: confira as versões no cofre"],
    ["Custódia difere do snapshot:", "BACKUP_CUSTODY_MISMATCH: confira o cofre do snapshot"],
    ["Manifesto ", "BACKUP_MANIFEST_INVALID: confira a integridade e o alvo do manifesto"],
    ["convex ", "BACKUP_CONVEX_CLI_FAILED: confira o CLI, o acesso e o alvo da operação"],
    [
      "Versão de chave usada por certificados ausente do ambiente:",
      "BACKUP_CERT_KEY_MISSING: confira as versões de chave no cofre e no ambiente",
    ],
    [
      "Destino difere do snapshot:",
      "BACKUP_RESTORE_MISMATCH: preserve a cópia e investigue a restauração",
    ],
    ["Zip64 incompleto:", "BACKUP_ZIP64_INCOMPLETE: preserve o export e confira sua integridade"],
    [
      "Entrada corrompida:",
      "BACKUP_ZIP_ENTRY_CORRUPT: preserve o export e confira sua integridade",
    ],
    [
      "Compressão não suportada:",
      "BACKUP_ZIP_COMPRESSION_UNSUPPORTED: confira o formato do export",
    ],
    ["CRC divergente:", "BACKUP_ZIP_CRC_MISMATCH: preserve o export e confira sua integridade"],
    ["Entrada repetida:", "BACKUP_ZIP_ENTRY_DUPLICATED: confira as entradas do export"],
    [
      "Entrada fora do arquivo:",
      "BACKUP_ZIP_ENTRY_OUT_OF_BOUNDS: preserve o export e confira sua integridade",
    ],
    [
      "Entradas sobrepostas:",
      "BACKUP_ZIP_ENTRY_OVERLAP: preserve o export e confira sua integridade",
    ],
    [
      "Entrada expande além do tamanho declarado:",
      "BACKUP_ZIP_ENTRY_OVERSIZED: preserve o export e confira sua integridade",
    ],
    [
      "Arquivo repetido no snapshot:",
      "BACKUP_STORAGE_DUPLICATED: confira o inventário do snapshot",
    ],
    [
      "Arquivo ausente no snapshot:",
      "BACKUP_STORAGE_MISSING: preserve a cópia e confira o inventário",
    ],
    [
      "Arquivo divergente no snapshot:",
      "BACKUP_STORAGE_MISMATCH: preserve a cópia e investigue a integridade",
    ],
  ])
    if (message.startsWith(prefix)) return code;
  return "BACKUP_FAILED";
}

/** Aggregate observations only. Null means the stage has not produced a measurement. */
export function backupMetrics(format) {
  return {
    version: 1,
    format,
    observed: {
      exportZipBytes: null,
      databaseJsonlBytes: null,
      snapshotZipBytes: null,
      snapshotCiphertextBytes: null,
      newBlobObjects: 0,
      reusedBlobReferences: 0,
      r2: {
        completedPutRequests: 0,
        acknowledgedPutBodyBytes: 0,
        verificationReadBytes: 0,
        verifiedCiphertextBytes: 0,
        completedVerifications: 0,
      },
      durationsMs: /** @type {Record<string, number>} */ ({}),
    },
  };
}

export async function measureBackupPhase(metrics, phase, action) {
  const start = performance.now();
  try {
    return await action();
  } finally {
    metrics.observed.durationsMs[phase] = performance.now() - start;
  }
}

/**
 * Credentials to read the cold tier's bucket (ADR 0010, phase C): its own read-only token when
 * both `R2_COLD_READ_*` are set, else the R2 credentials of the step. Half set is refused.
 * @param {Record<string, string | undefined>} [env]
 */
export function coldReadCredentials(env = process.env) {
  const accessKeyId = env.R2_COLD_READ_ACCESS_KEY_ID,
    secretAccessKey = env.R2_COLD_READ_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey };
  if (accessKeyId || secretAccessKey)
    throw new Error("Define R2_COLD_READ_ACCESS_KEY_ID e R2_COLD_READ_SECRET_ACCESS_KEY juntos.");
  return { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY };
}

export function r2Client({
  accountId,
  bucket,
  credentials,
  fetchImpl = fetch,
  now = () => new Date(),
  metrics = /** @type {ReturnType<typeof backupMetrics> | undefined} */ (undefined),
}) {
  assert.ok(credentials.accessKeyId && credentials.secretAccessKey, "Credenciais R2 ausentes");
  const base = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`;
  async function send(
    method,
    key,
    { body, query, headers, payloadHash, conditional = false } = {},
  ) {
    const url = new URL(key ? `${base}/${key.split("/").map(encode).join("/")}` : base);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const signed = signRequest({
      method,
      url: url.href,
      headers,
      payloadHash: payloadHash ?? sha256(body ?? ""),
      credentials,
      region: "auto",
      now: now(),
    });
    delete signed.host;
    const response = await fetchImpl(url, {
      method,
      headers: signed,
      body,
      ...(payloadHash ? { duplex: "half" } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15 * 60_000),
    });
    // Provider error bodies can echo request details; only the status leaves this function.
    if (
      !response.ok &&
      !(method === "HEAD" && response.status === 404) &&
      !(conditional && response.status === 412)
    )
      throw new Error(`R2 ${method}: HTTP ${response.status}`);
    return response;
  }
  return {
    async put(key, body, contentType) {
      await send("PUT", key, { body, headers: { "content-type": contentType } });
      if (metrics) {
        metrics.observed.r2.completedPutRequests++;
        metrics.observed.r2.acknowledgedPutBodyBytes += Buffer.byteLength(body);
      }
    },
    async get(key) {
      return Buffer.from(await (await send("GET", key)).arrayBuffer());
    },
    async delete(key) {
      await send("DELETE", key);
    },
    async putFile(key, path, { immutable = false } = {}) {
      const digest = await fileDigest(path);
      const response = await send("PUT", key, {
        body: createReadStream(path),
        payloadHash: digest.sha256,
        conditional: immutable,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(digest.bytes),
          ...(immutable ? { "if-none-match": "*" } : {}),
        },
      });
      if (metrics && response.status !== 412) {
        metrics.observed.r2.completedPutRequests++;
        metrics.observed.r2.acknowledgedPutBodyBytes += digest.bytes;
      }
      return response.status !== 412;
    },
    async putImmutable(key, body, contentType) {
      const response = await send("PUT", key, {
        body,
        conditional: true,
        headers: { "content-type": contentType, "if-none-match": "*" },
      });
      if (metrics && response.status !== 412) {
        metrics.observed.r2.completedPutRequests++;
        metrics.observed.r2.acknowledgedPutBodyBytes += Buffer.byteLength(body);
      }
      return response.status !== 412;
    },
    async getFile(key, path, maxBytes) {
      const response = await send("GET", key);
      assert.ok(
        Number(response.headers.get("content-length") ?? 0) <= maxBytes,
        "Objeto R2 acima do limite",
      );
      let bytes = 0;
      await pipeline(
        response.body,
        new Transform({
          transform(chunk, _encoding, done) {
            bytes += chunk.length;
            done(bytes > maxBytes ? new Error("Objeto R2 acima do limite") : null, chunk);
          },
        }),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      );
      return fileDigest(path);
    },
    async verifyFile(key, expected) {
      const response = await send("GET", key);
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (metrics) metrics.observed.r2.verificationReadBytes += chunk.length;
        assert.ok(bytes <= expected.bytes, "Objeto R2 acima do tamanho esperado");
        hash.update(chunk);
      }
      assert.ok(
        bytes === expected.bytes && hash.digest("hex") === expected.sha256,
        "Objeto R2 corrompido",
      );
      if (metrics) {
        metrics.observed.r2.completedVerifications++;
        metrics.observed.r2.verifiedCiphertextBytes += bytes;
      }
    },
    async head(key) {
      const response = await send("HEAD", key);
      const modifiedAt = Date.parse(response.headers.get("last-modified"));
      return response.status === 404
        ? null
        : {
            size: Number(response.headers.get("content-length")),
            ...(Number.isFinite(modifiedAt) ? { modifiedAt } : {}),
          };
    },
    async list(prefix) {
      const keys = [];
      const tokens = new Set();
      let token;
      do {
        const text = await (
          await send("GET", "", {
            query: { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) },
          })
        ).text();
        for (const match of text.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(xmlText(match[1]));
        const next = text.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
        assert.ok(
          text.includes("</ListBucketResult>") &&
            /<IsTruncated>(true|false)<\/IsTruncated>/.test(text),
          "BACKUP_GC_LIST_INCOMPLETE",
        );
        if (/<IsTruncated>true<\/IsTruncated>/.test(text)) {
          assert.ok(next && !tokens.has(xmlText(next)), "BACKUP_GC_LIST_INCOMPLETE");
          token = xmlText(next);
          tokens.add(token);
        } else token = undefined;
      } while (token);
      return keys;
    },
  };
}
