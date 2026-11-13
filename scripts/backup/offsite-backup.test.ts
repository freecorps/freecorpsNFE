import { describe, expect, it } from "vite-plus/test";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import assert from "node:assert/strict";
import ts from "typescript";
import { spawnSync } from "node:child_process";
import {
  authenticateManifest,
  backupPlan,
  backupFailure,
  backupMetrics,
  certificateEnvelopes,
  custodyFingerprints,
  evaluateBackups,
  objectKeys,
  r2Client,
  readZip,
  signRequest,
  snapshotId,
  snapshotReserve,
  snapshotSummary,
  snapshotTime,
  verifyCustody,
  verifyManifestAuthentication,
  webhookSecrets,
} from "../lib/offsite-backup.mjs";
import { incrementalPlan } from "../lib/incremental-backup.mjs";
import { releaseTarget } from "../lib/platform-release.mjs";
import { productionTarget } from "../lib/issuance-gate.mjs";
import { backendRequest } from "../lib/validation.mjs";
import { repoRoot } from "../lib/repo-root.mjs";
import {
  decryptCertificate,
  encryptCertificate,
} from "../../platform/convex/lib/certificateCrypto.ts";

const release = releaseTarget(JSON.parse(readFileSync("deploy/platform-release.json", "utf8")));
const recipient = (seed: string) => `age1${seed.repeat(58).slice(0, 58)}`;
const raw = {
  version: 1,
  bucket: "freecorpsnfe-offsite-backups",
  prefix: "elated-possum-295/",
  cadenceHours: 12,
  alertAfterHours: 13,
  retentionDays: 14,
  rpoHours: 24,
  rtoHours: 24,
  maxSnapshotBytes: 1024,
  warnAboveRatio: 0.8,
  recipients: [
    { custodian: "dona-do-projeto", recipient: recipient("q") },
    { custodian: "outra-pessoa", recipient: recipient("p") },
  ],
};
const plan = backupPlan(raw, release);
const zipLimit = plan.maxSnapshotBytes;

it("keeps the in-memory format 1 capped when larger format 2 budgets are supported", () => {
  expect(() => backupPlan({ ...raw, maxSnapshotBytes: 2 * 1024 ** 3 }, release)).toThrow(
    /Formato 1 limitado/,
  );
  expect(
    backupPlan({ ...raw, maxSnapshotBytes: 8 * 1024 ** 3, incremental: { version: 2 } }, release)
      .maxSnapshotBytes,
  ).toBe(8 * 1024 ** 3);
});

it("keeps target validation failures actionable before snapshot metrics exist", () => {
  const valid = JSON.parse(readFileSync("deploy/platform-release.json", "utf8"));
  const invalid = [
    () => releaseTarget({ ...valid, version: 0 }),
    () => releaseTarget({ ...valid, target: null }),
    () => releaseTarget({ ...valid, target: { ...valid.target, worker: "wrong" } }),
    () =>
      releaseTarget({ ...valid, target: { ...valid.target, frontend: "https://example.invalid" } }),
    () => releaseTarget({ ...valid, target: { ...valid.target, api: "https://example.invalid" } }),
    () => productionTarget({ version: 0 }),
    () => productionTarget({ version: 1, deployment: "invalid", url: "https://example.invalid" }),
  ];
  for (const run of invalid) {
    let failure: unknown;
    try {
      run();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(backupFailure(failure)).not.toBe("BACKUP_FAILED");
  }
});

it("preserves origin HTTP status and rejection without the backend payload", async () => {
  const secret = "synthetic-private-marker";
  for (const status of [401, 403, 503, 200]) {
    let failure: unknown;
    try {
      await backendRequest(
        { target: { url: "https://example.invalid" }, key: secret },
        "/api/query",
        {},
        async () =>
          new Response(JSON.stringify({ status: "error", errorMessage: secret }), { status }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(backupFailure(failure)).toBe(
      status === 200
        ? "Validation backend rejected the operation"
        : `Validation backend HTTP ${status}`,
    );
    expect(backupFailure(failure)).not.toContain(secret);
  }
  expect(backupFailure(new Error(`Validation backend HTTP 401 ${secret}`))).toBe("BACKUP_FAILED");
});

it("preserves every explicit backup diagnostic from its source without assertion values", () => {
  const privateMarker = "synthetic-private-marker";
  const files: [string, string?][] = [
    ["scripts/backup/backup-offsite.mjs"],
    ["scripts/lib/offsite-backup.mjs"],
    ["scripts/lib/incremental-backup.mjs"],
    ["scripts/lib/backup-table-stream.mjs"],
    ["scripts/lib/offsite-backup-zip.mjs"],
    ["scripts/lib/validation-backup.mjs"],
    ["scripts/lib/validation.mjs", "backendRequest"],
    ["scripts/lib/platform-release.mjs", "releaseTarget"],
    ["scripts/lib/worktree/paths.mjs", "worktreePaths"],
    ["platform/convex/lib/certificateCrypto.ts"],
  ];
  let checked = 0;
  for (const [file, entry] of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const visit = (node: ts.Node) => {
      let message: ts.Expression | undefined;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "assert"
      ) {
        message = node.arguments[node.expression.name.text === "ok" ? 1 : 2];
      }
      if (ts.isNewExpression(node) && node.expression.getText(source) === "Error")
        message = node.arguments?.[0];
      if (message) {
        let text: string;
        if (ts.isStringLiteral(message) || ts.isNoSubstitutionTemplateLiteral(message))
          text = message.text;
        else if (ts.isTemplateExpression(message)) {
          text =
            message.head.text +
            message.templateSpans
              .map(({ expression, literal }) => {
                const name = expression.getText(source);
                return (
                  (name === "response.status" ? "403" : name === "method" ? "GET" : privateMarker) +
                  literal.text
                );
              })
              .join("");
        } else
          throw new Error(
            `Classifique o diagnóstico em ${file}:${source.getLineAndCharacterOfPosition(message.getStart(source)).line + 1}`,
          );
        const location = `${file}:${source.getLineAndCharacterOfPosition(message.getStart(source)).line + 1}`;
        const errors: unknown[] = [new Error(text)];
        try {
          assert.deepEqual({ value: privateMarker }, {}, text);
        } catch (error) {
          errors.push(error);
        }
        for (const error of errors) {
          const diagnostic = backupFailure(error);
          expect(diagnostic, location).not.toBe("BACKUP_FAILED");
          expect(diagnostic, location).not.toContain(privateMarker);
          expect(diagnostic, location).not.toContain("\n");
          if (!ts.isTemplateExpression(message)) expect(diagnostic, location).toBe(text);
        }
        checked++;
      }
      ts.forEachChild(node, visit);
    };
    const target = entry
      ? source.statements.find(
          (node) => ts.isFunctionDeclaration(node) && node.name?.text === entry,
        )
      : source;
    expect(target, `${file}: ${entry ?? "module"}`).toBeDefined();
    visit(target!);
  }
  expect(checked).toBeGreaterThan(0);
});

it("keeps actionable backup diagnostics without external payloads or assertion diffs", () => {
  const secret = "synthetic-private-marker";
  expect(backupFailure(new Error("Informe --identity e --custody"))).toContain("--identity");
  expect(backupFailure(new Error("Use --target issuance, ou nenhum"))).toContain(
    "--target issuance",
  );
  expect(
    backupFailure(new Error(`O diretório de recuperação precisa estar vazio\n${secret}`)),
  ).toBe("O diretório de recuperação precisa estar vazio");
  expect(backupFailure(new Error(`Custódia difere do snapshot: ${secret}`))).toMatch(
    /^BACKUP_CUSTODY_MISMATCH:/,
  );
  expect(backupFailure(new Error("BACKUP_CHECK_FAILED: consulte problems no recibo"))).toContain(
    "problems",
  );
  expect(backupFailure(new Error("R2 GET: HTTP 403"))).toBe("R2 GET: HTTP 403");
  for (const [reason, code] of [
    ["hash divergente", "BACKUP_CIPHERTEXT_HASH_MISMATCH"],
    ["tamanho divergente", "BACKUP_CIPHERTEXT_SIZE_MISMATCH"],
  ]) {
    const result = backupFailure(new Error(`Snapshot ${secret}: ${reason}\n${secret}`));
    expect(result).toContain(code);
    expect(result).not.toContain(secret);
  }
  expect(backupFailure(new Error("Objeto sem prova; reconciliar antes de repetir"))).toContain(
    "reconciliar antes de repetir",
  );
  for (const message of [
    secret,
    `R2 GET: HTTP 403 ${secret}`,
    `Informe --identity e --custody ${secret}`,
  ])
    expect(backupFailure(new Error(message))).toBe("BACKUP_FAILED");
});

// Minimal writer; `zip64` mirrors the Convex export, which saturates header fields.
function zip(files: Record<string, Buffer | string>, method = 8, zip64 = false) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content),
      body = method ? deflateRawSync(data) : data,
      path = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    const entry = Buffer.alloc(46),
      extra = Buffer.alloc(zip64 ? 28 : 0);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
    entry.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    entry.writeUInt16LE(path.length, 28);
    entry.writeUInt16LE(extra.length, 30);
    entry.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    if (zip64) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    locals.push(local, path, body);
    central.push(entry, path, extra);
    offset += 30 + path.length + body.length;
  }
  const directory = Buffer.concat(central),
    count = Object.keys(files).length,
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : count, 8);
  end.writeUInt16LE(zip64 ? 0xffff : count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  if (!zip64) return Buffer.concat([...locals, directory, end]);
  const record = Buffer.alloc(56),
    locator = Buffer.alloc(20);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(offset), 48);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
  return Buffer.concat([...locals, directory, record, locator, end]);
}
// Adds central entries to a zip, so names can point at bytes another entry already owns.
function withCentral(base: Buffer, extra: Buffer[]) {
  const directoryAt = base.readUInt32LE(base.length - 6),
    count = base.readUInt16LE(base.length - 12),
    directory = Buffer.concat([base.subarray(directoryAt, base.length - 22), ...extra]),
    end = Buffer.from(base.subarray(base.length - 22));
  end.writeUInt16LE(count + extra.length, 8);
  end.writeUInt16LE(count + extra.length, 10);
  end.writeUInt32LE(directory.length, 12);
  return Buffer.concat([base.subarray(0, directoryAt), directory, end]);
}
const centralOf = (archive: Buffer) =>
  archive.subarray(archive.readUInt32LE(archive.length - 6), archive.length - 22);
const blob = Buffer.from("<nfeProc/>");
const storageMeta = (id: string, bytes: Buffer) =>
  JSON.stringify({ _id: id, sha256: createHash("sha256").update(bytes).digest("base64") });
function exportFiles(extra: Record<string, string> = {}) {
  return {
    "_tables/documents.jsonl": '{"name":"documents","id":10001}\n',
    "documents/documents.jsonl": '{"_id":"a","n":1}\n{"_id":"b","n":2}\n',
    "documents/generated_schema.jsonl": '"uniform"\n',
    "_components/betterAuth/user/documents.jsonl": '{"_id":"u"}\n',
    "_components/betterAuth/_tables/documents.jsonl": '{"name":"user","id":1}\n',
    "_storage/documents.jsonl": storageMeta("kg1", blob) + "\n",
    "_storage/kg1": blob.toString(),
    ...extra,
  };
}
const custodyValues = {
  BETTER_AUTH_SECRET: "s".repeat(40),
  FNFE_WEBHOOK_MASTER_KEY: "a".repeat(64),
  FNFE_PLATFORM_CERT_KEYS: JSON.stringify({
    active: "v2",
    keys: { v1: "b".repeat(64), v2: "c".repeat(64) },
  }),
};

describe("plan", () => {
  it("requires two distinct custodians and the release prefix", () => {
    expect(plan.deployment).toBe("elated-possum-295");
    expect(() => backupPlan({ ...raw, recipients: raw.recipients.slice(0, 1) }, release)).toThrow(
      /dois custodiantes/,
    );
    expect(() =>
      backupPlan(
        { ...raw, recipients: raw.recipients.map((r) => ({ ...r, custodian: "dona-do-projeto" })) },
        release,
      ),
    ).toThrow(/dois custodiantes/);
    expect(() => backupPlan({ ...raw, prefix: "other/" }, release)).toThrow(/prefixo/);
    expect(() =>
      backupPlan(
        {
          ...raw,
          recipients: [...raw.recipients, { custodian: "x", recipient: "ssh-ed25519 AAAA" }],
        },
        release,
      ),
    ).toThrow(/chave age/);
    const { warnAboveRatio: _ratio, ...withoutRatio } = raw;
    for (const invalid of [
      withoutRatio,
      { ...raw, warnAboveRatio: 1 },
      { ...raw, warnAboveRatio: 0 },
    ])
      expect(() => backupPlan(invalid, release)).toThrow(/warnAboveRatio inválido/);
  });
  it("opens the versioned plan only with registered custodians", () => {
    const versioned = JSON.parse(readFileSync("deploy/offsite-backup.json", "utf8"));
    expect({ ...versioned, recipients: raw.recipients }).toEqual({
      ...raw,
      maxSnapshotBytes: 4 * 1024 ** 3,
      coldTier: { bucket: "freecorpsnfe-cold-documents" },
      incremental: {
        version: 2,
        blobPrefix: "elated-possum-295/objects/",
        retentionConfigured: true,
      },
    });
    expect(incrementalPlan(backupPlan(versioned, release)).version).toBe(2);
    const custodians = backupPlan(versioned, release).recipients.map(
      (r: { custodian: string }) => r.custodian,
    );
    expect(custodians).toEqual(["hhs0001", "wolf-stievano"]);
  });
  it("names objects by the UTC export start", () => {
    const id = snapshotId(new Date("2026-10-07T15:00:03.456Z"));
    expect(id).toBe("2026-10-07T15-00-03Z");
    expect(snapshotTime(id)).toBe(Date.parse("2026-10-07T15:00:03Z"));
    expect(objectKeys(plan, id)).toEqual({
      snapshot: "elated-possum-295/snapshots/2026-10-07T15-00-03Z/snapshot.zip.age",
      manifest: "elated-possum-295/snapshots/2026-10-07T15-00-03Z/manifest.json",
    });
  });
});

describe("snapshot integrity", () => {
  it("reads stored and deflated entries and summarizes tables and storage", () => {
    for (const [method, zip64] of [
      [0, false],
      [8, false],
      [8, true],
    ] as const) {
      const summary = snapshotSummary(readZip(zip(exportFiles(), method, zip64), zipLimit));
      expect(summary.tables).toEqual({ documents: 2, "_components/betterAuth/user": 1 });
      expect(summary.storage).toEqual({ files: 1, bytes: blob.length });
      expect(Object.keys(summary.digests).sort()).toEqual([
        "_components/betterAuth/user/documents.jsonl",
        "_storage/documents.jsonl",
        "documents/documents.jsonl",
      ]);
    }
  });
  it("compares table content independently of row order", () => {
    const a = snapshotSummary(readZip(zip(exportFiles()), zipLimit));
    const b = snapshotSummary(
      readZip(
        zip(exportFiles({ "documents/documents.jsonl": '{"_id":"b","n":2}\n{"_id":"a","n":1}\n' })),
        zipLimit,
      ),
    );
    const c = snapshotSummary(
      readZip(
        zip(exportFiles({ "documents/documents.jsonl": '{"_id":"a","n":1}\n{"_id":"b","n":3}\n' })),
        zipLimit,
      ),
    );
    expect(b.digests).toEqual(a.digests);
    expect(c.digests["documents/documents.jsonl"]).not.toBe(a.digests["documents/documents.jsonl"]);
  });
  it("rejects corrupt archives, files and missing storage", () => {
    const good = zip(exportFiles(), 0);
    const flipped = Buffer.from(good);
    const at = good.indexOf("<nfeProc/>");
    flipped[at] = (flipped[at] ?? 0) ^ 1;
    expect(() => readZip(flipped, zipLimit)).toThrow(/CRC/);
    expect(() => readZip(good.subarray(0, good.length - 30), zipLimit)).toThrow(/zip/);
    // A trailing comment moves the EOCD; one beyond the 64 KiB limit is not a zip.
    const withComment = Buffer.concat([good, Buffer.alloc(100)]);
    withComment.writeUInt16LE(100, good.length - 2);
    expect(readZip(withComment, zipLimit).size).toBe(readZip(good, zipLimit).size);
    expect(() => readZip(Buffer.concat([good, Buffer.alloc(70_000)]), zipLimit)).toThrow(/zip/);
    expect(() =>
      snapshotSummary(readZip(zip(exportFiles({ "_storage/kg1": "<nfeProc/ >" })), zipLimit)),
    ).toThrow(/Arquivo divergente/);
    const files: Record<string, string> = exportFiles();
    delete files["_storage/kg1"];
    expect(() => snapshotSummary(readZip(zip(files), zipLimit))).toThrow(/Arquivo ausente/);
  });

  it("bounds the expanded total before inflating any entry", () => {
    expect(readZip(zip({ a: Buffer.alloc(zipLimit) }), zipLimit).get("a")).toHaveLength(zipLimit);
    expect(() => readZip(zip({ a: Buffer.alloc(zipLimit + 1) }), zipLimit)).toThrow(
      /acima do limite/,
    );
    const zeros = Buffer.alloc(600);
    expect(() => readZip(zip({ a: zeros, b: zeros }), zipLimit)).toThrow(/acima do limite/);
    // A zip64 size beyond any budget is refused before its member is read.
    const huge = zip({ a: zeros }, 8, true);
    huge.writeBigUInt64LE(2n ** 60n, huge.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 46 + 1 + 4);
    expect(() => readZip(huge, zipLimit)).toThrow(/acima do limite/);
    expect(() => readZip(zip(exportFiles()), 0)).toThrow(/limite de expansão/);
  });

  it("refuses names that share compressed bytes or point outside the archive", () => {
    // Same member under another name.
    const single = zip({ "a/x": Buffer.alloc(100) }),
      alias = Buffer.from(centralOf(single));
    alias.write("b/x", 46);
    expect(() => readZip(withCentral(single, [alias]), zipLimit)).toThrow(
      /Entradas sobrepostas: b\/x/,
    );
    // A member hidden inside another one's stored bytes, at a different offset.
    const inner = zip({ b: Buffer.alloc(100) }),
      outer = zip({ a: inner.subarray(0, inner.readUInt32LE(inner.length - 6)) }, 0),
      nested = Buffer.from(centralOf(inner));
    nested.writeUInt32LE(30 + "a".length, 42);
    expect(() => readZip(withCentral(outer, [nested]), zipLimit)).toThrow(
      /Entradas sobrepostas: b/,
    );
    const outside = zip({ a: "x" }),
      at = outside.readUInt32LE(outside.length - 6);
    outside.writeUInt32LE(0x7fffffff, at + 42);
    expect(() => readZip(outside, zipLimit)).toThrow(/Entrada fora do arquivo: a/);
  });

  it("stops an entry that expands beyond its declared size", () => {
    const lying = zip({ a: Buffer.alloc(1024 ** 2) });
    lying.writeUInt32LE(10, lying.readUInt32LE(lying.length - 6) + 24);
    expect(() => readZip(lying, zipLimit)).toThrow(/além do tamanho declarado: a/);
  });

  it("finds storage files exported with a contentType extension", () => {
    const files: Record<string, string> = exportFiles({ "_storage/kg1.xml": blob.toString() });
    delete files["_storage/kg1"];
    expect(snapshotSummary(readZip(zip(files), zipLimit)).storage).toEqual({
      files: 1,
      bytes: blob.length,
    });
    expect(() =>
      snapshotSummary(readZip(zip(exportFiles({ "_storage/kg1.xml": blob.toString() })), zipLimit)),
    ).toThrow(/Arquivo repetido/);
  });
});

describe("custody", () => {
  it("fingerprints every key version without exposing material", () => {
    const fingerprints = custodyFingerprints(custodyValues);
    expect(JSON.stringify(fingerprints)).not.toMatch(/s{40}|a{64}|b{64}|c{64}/);
    expect(Object.keys(fingerprints.FNFE_PLATFORM_CERT_KEYS.versions)).toEqual(["v1", "v2"]);
    expect(() => custodyFingerprints({ ...custodyValues, BETTER_AUTH_SECRET: "" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });
  it("requires every version used by the snapshot, with the recorded bytes", () => {
    const manifest = {
      custody: custodyFingerprints(custodyValues),
      requiredCertificateKeyVersions: ["v1"],
    };
    const rotated = JSON.stringify({
      active: "v3",
      keys: { v1: "b".repeat(64), v3: "d".repeat(64) },
    });
    expect(() =>
      verifyCustody(
        manifest,
        new Map(Object.entries({ ...custodyValues, FNFE_PLATFORM_CERT_KEYS: rotated })),
      ),
    ).not.toThrow();
    const lost = JSON.stringify({ active: "v2", keys: { v2: "c".repeat(64) } });
    expect(() =>
      verifyCustody(manifest, { ...custodyValues, FNFE_PLATFORM_CERT_KEYS: lost }),
    ).toThrow(/v1/);
    expect(() =>
      verifyCustody(manifest, { ...custodyValues, FNFE_WEBHOOK_MASTER_KEY: "e".repeat(64) }),
    ).toThrow(/FNFE_WEBHOOK_MASTER_KEY/);
  });
  it("extracts certificate envelopes and webhook secrets that open with the custody keys", async () => {
    const ring = JSON.parse(custodyValues.FNFE_PLATFORM_CERT_KEYS);
    const context = { organizationId: "o", companyId: "c", id: "cert", version: 2 };
    const sealed = encryptCertificate(ring, context, Buffer.from("pfx"), Buffer.from("senha"));
    const encode = (value: ArrayBuffer) => ({ $bytes: Buffer.from(value).toString("base64") });
    const key = await webcrypto.subtle.importKey(
      "raw",
      Buffer.from(custodyValues.FNFE_WEBHOOK_MASTER_KEY, "hex"),
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const iv = randomBytes(12);
    const data = await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: Buffer.from("w1:2") },
      key,
      Buffer.from("whsec"),
    );
    const entries = readZip(
      zip(
        exportFiles({
          "certificates/documents.jsonl":
            JSON.stringify({
              _id: "cert",
              organizationId: "o",
              companyId: "c",
              version: 2,
              envelope: {
                ...sealed,
                wrappedKey: encode(sealed.wrappedKey),
                pfx: encode(sealed.pfx),
                password: encode(sealed.password),
              },
            }) + '\n{"_id":"pending","organizationId":"o","companyId":"c","version":1}\n',
          "webhookEndpoints/documents.jsonl":
            JSON.stringify({
              _id: "w1",
              secretVersion: 2,
              secret: `${iv.toString("hex")}:${Buffer.from(data).toString("hex")}`,
            }) + "\n",
        }),
      ),
      zipLimit,
    );
    const [envelope] = certificateEnvelopes(entries);
    expect(certificateEnvelopes(entries)).toHaveLength(1);
    const opened = decryptCertificate(ring, envelope!.context, envelope!.envelope);
    expect(opened.password.toString()).toBe("senha");
    expect(webhookSecrets(entries)).toEqual([
      { cipher: `${iv.toString("hex")}:${Buffer.from(data).toString("hex")}`, context: "w1:2" },
    ]);
  });
});

describe("manifest authentication", () => {
  const custody = new Map(Object.entries(custodyValues));
  const unsigned = {
    format: 2,
    id: "2026-11-05T03-00-00Z",
    deployment: plan.deployment,
    codeSha: "1".repeat(40),
    plaintext: { sha256: "2".repeat(64), bytes: 10 },
    ciphertext: { sha256: "3".repeat(64), bytes: 20 },
    objects: [{ key: "k", plaintext: { sha256: "4".repeat(64), bytes: 1 } }],
    custody: custodyFingerprints(custodyValues),
  };
  // Stored as the producers write it: compact (format 2) or indented (format 1).
  const stored = (manifest: object, indent?: number) =>
    JSON.parse(JSON.stringify(manifest, null, indent));

  it("verifies the producer's MAC with the custody and keeps key material out of the manifest", () => {
    const manifest = authenticateManifest(unsigned, custody);
    expect(manifest.authentication.scheme).toBe("hmac-sha256:fnfe-offsite-manifest:v1");
    expect(JSON.stringify(manifest)).not.toMatch(/s{40}|a{64}/);
    expect(verifyManifestAuthentication(stored(manifest), custody)).toBe("verified");
    expect(verifyManifestAuthentication(stored(manifest, 2), custodyValues)).toBe("verified");
    expect(() => authenticateManifest(manifest, custody)).toThrow("Manifesto já autenticado");
  });

  it("refuses a coherent manifest written without the custody keys", () => {
    // Recipients are public: a bucket writer can encrypt a snapshot and describe it exactly.
    const forged = { ...unsigned, ciphertext: { sha256: "5".repeat(64), bytes: 21 } };
    const genuine = authenticateManifest(unsigned, custody);
    const otherKeys = { ...custodyValues, BETTER_AUTH_SECRET: "t".repeat(40) };
    for (const manifest of [
      { ...forged, authentication: genuine.authentication },
      authenticateManifest(forged, otherKeys),
      authenticateManifest(forged, { ...custodyValues, FNFE_WEBHOOK_MASTER_KEY: "e".repeat(64) }),
      { ...forged, authentication: { ...genuine.authentication, scheme: "none" } },
      { ...forged, authentication: { scheme: genuine.authentication.scheme, mac: "0" } },
      { ...forged, authentication: null },
      { ...genuine, objects: [] },
    ])
      expect(() => verifyManifestAuthentication(stored(manifest), custody)).toThrow(
        "Manifesto com autenticação inválida",
      );
    // An explicit acceptance of a legacy copy never overrides an invalid MAC.
    expect(() =>
      verifyManifestAuthentication(
        stored({ ...forged, authentication: genuine.authentication }),
        custody,
        "5".repeat(64),
      ),
    ).toThrow("Manifesto com autenticação inválida");
  });

  it("separates the two custody secrets in the key", () => {
    const shifted = (auth: string, webhook: string) =>
      authenticateManifest(unsigned, {
        ...custodyValues,
        BETTER_AUTH_SECRET: auth,
        FNFE_WEBHOOK_MASTER_KEY: webhook,
      }).authentication.mac;
    expect(shifted("ab", "c")).not.toBe(shifted("a", "bc"));
    expect(() =>
      authenticateManifest(unsigned, { ...custodyValues, FNFE_WEBHOOK_MASTER_KEY: "" }),
    ).toThrow(/FNFE_WEBHOOK_MASTER_KEY/);
  });

  it("accepts a manifest without MAC only for the ciphertext hash named by the custodian", () => {
    expect(() => verifyManifestAuthentication(stored(unsigned), custody)).toThrow(
      /Manifesto sem autenticação/,
    );
    expect(() => verifyManifestAuthentication(stored(unsigned), custody, "5".repeat(64))).toThrow(
      "Cifra do manifesto difere do hash aceito",
    );
    expect(() => verifyManifestAuthentication(stored(unsigned), custody, "3")).toThrow(
      "--accept-unauthenticated exige o sha256 da cifra do recibo",
    );
    expect(verifyManifestAuthentication(stored(unsigned), custody, "3".repeat(64))).toBe(
      "accepted-unauthenticated",
    );
  });

  it.each([
    ["check", "--accept-unauthenticated só vale para fetch e rehearse"],
    ["fetch", "--accept-unauthenticated exige --snapshot <id> conferido no recibo"],
  ])("refuses %s with --accept-unauthenticated before any credential", (mode, error) => {
    const result = spawnSync(
      process.execPath,
      ["scripts/backup/backup-offsite.mjs", mode, "--accept-unauthenticated", "3".repeat(64)],
      {
        cwd: repoRoot,
        env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toMatchObject({
      mode,
      result: "failed",
      error,
    });
  });
});

describe("monitor", () => {
  const now = Date.parse("2026-10-08T04:30:00Z");
  const manifest = (id: string) => ({ id, snapshotStartedAt: snapshotTime(id) });
  it("accepts a recent copy within the retention window", () => {
    const ids = ["2026-09-25T15-00-00Z", "2026-10-08T03-00-00Z"];
    expect(evaluateBackups(plan, ids, manifest(ids[1]!), now)).toMatchObject({
      problems: [],
      count: 2,
      latestAgeHours: 1.5,
    });
  });
  it("alerts before the RPO is violated, on orphan uploads and on retention drift", () => {
    expect(
      evaluateBackups(plan, ["2026-10-07T15-00-00Z"], manifest("2026-10-07T15-00-00Z"), now)
        .problems,
    ).toEqual([expect.stringMatching(/13\.5 h/)]);
    expect(
      evaluateBackups(
        plan,
        ["2026-10-07T15-00-00Z", "2026-10-08T03-00-00Z"],
        manifest("2026-10-07T15-00-00Z"),
        now,
      ).problems[0],
    ).toMatch(/sem manifesto/);
    expect(
      evaluateBackups(
        plan,
        ["2026-09-22T03-00-00Z", "2026-10-08T03-00-00Z"],
        manifest("2026-10-08T03-00-00Z"),
        now,
      ).problems,
    ).toEqual([expect.stringMatching(/retenção de 14 dias/)]);
    expect(evaluateBackups(plan, [], null, now).problems).toEqual([
      "Nenhum backup externo encontrado",
    ]);
    expect(evaluateBackups(plan, ["2026-10-08T03-00-00Z"], null, now).problems).toEqual([
      "Nenhum backup externo íntegro encontrado",
    ]);
  });
  describe("capacity", () => {
    const limit = 4 * 1024 ** 3,
      capped = backupPlan(
        { ...raw, maxSnapshotBytes: limit, incremental: { version: 2 } },
        release,
      ),
      id = "2026-10-08T03-00-00Z",
      at = (ratio: number) => Math.round(limit * ratio),
      tables = { certificates: 1, documents: 2 };
    const check = (latest: object) =>
      evaluateBackups(capped, [id], { ...manifest(id), tables, ...latest }, now);
    // The same content in both formats: format 1 holds the files inside the zip.
    const content = (ratio: number, format: 1 | 2) => {
      const database = at(0.2),
        files = 1000,
        reserve = snapshotReserve({ databaseBytes: database, tables: 2, files }),
        storage = { files, bytes: at(ratio) - database - reserve };
      return {
        format,
        plaintext: { bytes: format === 2 ? database : database + storage.bytes },
        storage,
      };
    };
    it.each([1, 2] as const)(
      "warns in format %i above 80% of the preflight estimate, counting the files once",
      (format) => {
        const over = check(content(0.81, format));
        expect(over.latestEstimatedBytes).toBe(at(0.81));
        expect(over.problems).toEqual([
          "Estimativa do último backup íntegro: 3.24 GiB de 4.00 GiB com a reserva do preflight (aviso acima de 80%); revise maxSnapshotBytes antes que o snapshot seja recusado",
        ]);
        expect(check(content(0.79, format))).toMatchObject({
          problems: [],
          latestEstimatedBytes: at(0.79),
        });
      },
    );
    it("counts the per-file reserve, which many small XMLs make large", () => {
      // 0.5 + 2.69 GiB is 79.7% of the limit; the preflight adds 2 KiB per file and refuses.
      expect(
        check({
          format: 2,
          plaintext: { bytes: at(0.125) },
          storage: { files: 420_000, bytes: Math.round(2.69 * 1024 ** 3) },
        }).problems,
      ).toEqual([expect.stringMatching(/íntegro: 4\.04 GiB de 4\.00 GiB/)]);
    });
    it("stays silent when the manifest carries no sizes", () => {
      expect(check({ format: 2 })).toMatchObject({ problems: [], latestEstimatedBytes: null });
    });
  });
});

describe("R2 transport", () => {
  const credentials = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };
  const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const now = new Date("2013-05-24T00:00:00Z");
  it("matches the AWS SigV4 reference signatures", () => {
    expect(
      signRequest({
        method: "GET",
        url: "https://examplebucket.s3.amazonaws.com/test.txt",
        headers: { Range: "bytes=0-9" },
        payloadHash: empty,
        credentials,
        region: "us-east-1",
        now,
      }).authorization,
    ).toMatch(/Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
    expect(
      signRequest({
        method: "GET",
        url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
        payloadHash: empty,
        credentials,
        region: "us-east-1",
        now,
      }).authorization,
    ).toMatch(/Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
  });
  it("talks path-style to the account endpoint, pages listings and hides provider bodies", async () => {
    const objects = new Map<string, Buffer>();
    const calls: string[] = [];
    const fetchImpl = async (url: URL, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIA[^/]+\/\d{8}\/auto\/s3\/aws4_request/,
      );
      calls.push(`${init.method} ${url.pathname}${url.search}`);
      const key = decodeURIComponent(url.pathname.replace("/bucket-name/", ""));
      if (init.method === "PUT") {
        objects.set(key, Buffer.from(init.body as Buffer));
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/bucket-name") {
        const page = url.searchParams.get("continuation-token") ? ["p/b&lt;&quot;"] : ["p/a&amp;"];
        const token = url.searchParams.get("continuation-token");
        if (token) expect(token).toBe("t1&");
        const more = !token;
        return new Response(
          `<ListBucketResult>${page.map((k) => `<Key>${k}</Key>`).join("")}<IsTruncated>${more}</IsTruncated>${more ? "<NextContinuationToken>t1&amp;</NextContinuationToken>" : ""}</ListBucketResult>`,
        );
      }
      const body = objects.get(key);
      if (!body) return new Response("<Error>secret request detail</Error>", { status: 404 });
      return init.method === "HEAD"
        ? new Response(null, { headers: { "content-length": String(body.length) } })
        : new Response(new Uint8Array(body));
    };
    const metrics = backupMetrics(1);
    const client = r2Client({
      metrics,
      accountId: "acc",
      bucket: "bucket-name",
      credentials,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await client.put("p/a b", Buffer.from("xyz"), "application/octet-stream");
    expect((await client.get("p/a b")).toString()).toBe("xyz");
    expect(await client.head("p/a b")).toEqual({ size: 3 });
    expect(await client.head("p/none")).toBeNull();
    expect(await client.list("p/")).toEqual(["p/a&", 'p/b<"']);
    await expect(client.get("p/none")).rejects.toThrow(/^R2 GET: HTTP 404$/);
    expect(metrics.format).toBe(1);
    expect(metrics.observed.r2).toEqual({
      completedPutRequests: 1,
      acknowledgedPutBodyBytes: 3,
      verificationReadBytes: 0,
      verifiedCiphertextBytes: 0,
      completedVerifications: 0,
    });
    expect(metrics.observed.snapshotZipBytes).toBeNull();
    expect(calls[0]).toBe("PUT /bucket-name/p/a%20b");
    expect(calls.filter((c) => c.startsWith("GET /bucket-name?"))).toHaveLength(2);
  });
});
