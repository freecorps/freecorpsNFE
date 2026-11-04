import { describe, expect, it } from "vite-plus/test";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import assert from "node:assert/strict";
import ts from "typescript";
import {
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
  snapshotSummary,
  snapshotTime,
  verifyCustody,
  webhookSecrets,
} from "../lib/offsite-backup.mjs";
import { incrementalPlan } from "../lib/incremental-backup.mjs";
import { releaseTarget } from "../lib/platform-release.mjs";
import { productionTarget } from "../lib/issuance-gate.mjs";
import { backendRequest } from "../lib/validation.mjs";
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
  recipients: [
    { custodian: "dona-do-projeto", recipient: recipient("q") },
    { custodian: "outra-pessoa", recipient: recipient("p") },
  ],
};
const plan = backupPlan(raw, release);

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
      const summary = snapshotSummary(readZip(zip(exportFiles(), method, zip64)));
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
    const a = snapshotSummary(readZip(zip(exportFiles())));
    const b = snapshotSummary(
      readZip(
        zip(exportFiles({ "documents/documents.jsonl": '{"_id":"b","n":2}\n{"_id":"a","n":1}\n' })),
      ),
    );
    const c = snapshotSummary(
      readZip(
        zip(exportFiles({ "documents/documents.jsonl": '{"_id":"a","n":1}\n{"_id":"b","n":3}\n' })),
      ),
    );
    expect(b.digests).toEqual(a.digests);
    expect(c.digests["documents/documents.jsonl"]).not.toBe(a.digests["documents/documents.jsonl"]);
  });
  it("rejects corrupt archives, files and missing storage", () => {
    const good = zip(exportFiles(), 0);
    const flipped = Buffer.from(good);
    flipped[good.indexOf("<nfeProc/>")] ^= 1;
    expect(() => readZip(flipped)).toThrow(/CRC/);
    expect(() => readZip(good.subarray(0, good.length - 30))).toThrow(/zip/);
    // A trailing comment moves the EOCD; one beyond the 64 KiB limit is not a zip.
    const withComment = Buffer.concat([good, Buffer.alloc(100)]);
    withComment.writeUInt16LE(100, good.length - 2);
    expect(readZip(withComment).size).toBe(readZip(good).size);
    expect(() => readZip(Buffer.concat([good, Buffer.alloc(70_000)]))).toThrow(/zip/);
    expect(() =>
      snapshotSummary(readZip(zip(exportFiles({ "_storage/kg1": "<nfeProc/ >" })))),
    ).toThrow(/Arquivo divergente/);
    const files: Record<string, string> = exportFiles();
    delete files["_storage/kg1"];
    expect(() => snapshotSummary(readZip(zip(files)))).toThrow(/Arquivo ausente/);
  });

  it("finds storage files exported with a contentType extension", () => {
    const files: Record<string, string> = exportFiles({ "_storage/kg1.xml": blob.toString() });
    delete files["_storage/kg1"];
    expect(snapshotSummary(readZip(zip(files))).storage).toEqual({
      files: 1,
      bytes: blob.length,
    });
    expect(() =>
      snapshotSummary(readZip(zip(exportFiles({ "_storage/kg1.xml": blob.toString() })))),
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
