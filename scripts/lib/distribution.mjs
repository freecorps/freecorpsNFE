import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  packageLicenses,
  packageLicenseText,
  assertSdkDeclarations,
  firstPartyScope,
} from "./first-party-licenses.mjs";
import { packageCredentialPattern } from "./credentials.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Technical packaging success is separate from permission to distribute.
// On #83, on 2026-11-01, the maintainer selected sdk, fiscal-core, fiscal-nfe and
// fiscal-nfse, version 0.1.0, for publication; contracts stays private (the SDK
// bundles the four MIT contracts and depends only on zod). The acceptance covers the
// tarball hashes recorded in docs/v1.0/evidence/83/2026-11-01, not any bytes that
// pass here, and `rights` rests on the per-file relation recorded there. The SDK,
// renamed to @freecorps/freecorpsnfe-sdk on #72, was accepted again under that name
// on #73, on 2026-11-03, for the hash in docs/v1.0/evidence/73/2026-11-03.
// The legal reviews and the XSD permission were replaced by the maintainer
// decisions of 2026-10-20; the schemas still have to match their manifest.
const acceptance = {
  conditions: ["rights", "release-acceptance"],
  version: "0.1.0",
  record: "docs/v1.0/evidence/83/2026-11-01/README.md",
};
const acceptanceRecords = {
  "@freecorps/freecorpsnfe-sdk": "docs/v1.0/evidence/73/2026-11-03/README.md",
};
const acceptedPackages = new Set([
  "@freecorps/freecorpsnfe-sdk",
  "@freecorps/fiscal-core",
  "@freecorps/fiscal-nfe",
  "@freecorps/fiscal-nfse",
]);
// Packages that ship LICENSE-MIT for the files named in docs/licenses/first-party.json.
const mixedLicensePackages = new Set(["@freecorps/contracts"]);
// Packages whose dist embeds an XSD catalog, checked against its manifest.
const schemaPackages = new Set(["@freecorps/fiscal-nfe", "@freecorps/fiscal-nfse"]);
// CC BY-ND 3.0: the NFS-e catalog carries the original bytes; the adjustments
// happen in memory when loading (packages/fiscal-nfse/src/schema.ts).
const unmodifiedSchemaPackages = new Set(["@freecorps/fiscal-nfse"]);

// Credential formats that may reach a build through configuration, shared
// with the repository scanner (./credentials.mjs). The project's own secrets
// have no fixed prefix; those stay out by path and by the versioned-file
// fingerprints below, not by this list.
const credentialPattern = packageCredentialPattern;
// A signed NF-e document or an embedded signing certificate is corpus, never
// library code. Element names alone, as in the XSD catalog, do not match.
const documentPattern =
  /<(?:\w+:)?X509Certificate>\s*[A-Za-z0-9+/]{64}|\bId="(?:NFe|ID\d{6})[0-9A-Z]{44}/;
const compact = (text) => text.replace(/\s+/g, "");

/**
 * Fingerprints of versioned internal material: test fixtures and PEM/PKCS#12
 * files. A tarball entry is refused when its bytes equal one of these files or
 * when it embeds the body of a versioned certificate or key, so a build that
 * inlines the corpus fails even under an allowed `dist/` path.
 */
export function internalCorpus(root = fileURLToPath(new URL("../..", import.meta.url))) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, windowsHide: true })
    .toString("utf8")
    .split("\0")
    .filter((path) => /(?:^|\/)fixtures?\/|\.(?:pem|pfx|p12|key|crt|cer|der)$/i.test(path));
  const hashes = new Map();
  const fragments = new Map();
  for (const path of tracked) {
    const bytes = readFileSync(join(root, path));
    if (bytes.length < 64) continue;
    hashes.set(sha256(bytes), path);
    const text = bytes.toString("utf8");
    const bodies = [
      ...text.matchAll(/-----BEGIN [A-Z ]+-----([\s\S]+?)-----END [A-Z ]+-----/g),
      ...text.matchAll(/<(?:\w+:)?X509Certificate>([^<]+)</g),
    ];
    for (const [, body] of bodies) {
      const value = compact(body);
      if (value.length >= 128)
        fragments.set(value.slice(value.length / 2 - 32, value.length / 2 + 32), path);
    }
  }
  return { files: tracked.length, hashes, fragments };
}

/**
 * Copies a package directory as maintained in the repository, without
 * node_modules or previous tarballs. The packer then applies the manifest's own
 * `files` field, so the inspected bytes are those a pack of that directory
 * would produce, not a hand-picked list.
 */
export function stagePackage(source, target, dependencyVersions = {}) {
  cpSync(source, target, {
    recursive: true,
    filter: (path) =>
      !relative(source, path).split(/[\\/]/).includes("node_modules") && !path.endsWith(".tgz"),
  });
  const manifestPath = join(target, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const [name, version] of Object.entries(dependencyVersions))
    if (manifest.dependencies?.[name]) manifest.dependencies[name] = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export function checkPackageFiles(entries, expectedName, corpus) {
  const licenses = packageLicenses;
  const paths = new Set();
  const allowed =
    /^(?:package\.json|README\.md|LICENSE(?:-MIT)?|NOTICE|LICENSING\.md|THIRD_PARTY_NOTICES\.txt|schemas\/manifest\.json|(?:dist|types)\/[\w./-]+\.(?:js|mjs|cjs|ts|json)|(?:index|webhooks)\.js)$/;
  for (const { path, bytes } of entries) {
    if (
      !allowed.test(path) ||
      path.split("/").includes("..") ||
      paths.has(path) ||
      /(?:^|\/)(?:fixtures?|tests?|node_modules|\.env)(?:[./]|$)/i.test(path)
    )
      throw new Error(`Arquivo não permitido no pacote: ${path}`);
    paths.add(path);
    const text = bytes.toString("utf8");
    if (credentialPattern.test(text)) throw new Error(`Possível credencial no pacote: ${path}`);
    if (documentPattern.test(text))
      throw new Error(`Documento ou certificado de corpus no pacote: ${path}`);
    if (corpus) {
      const copied = corpus.hashes.get(sha256(bytes));
      if (copied) throw new Error(`Arquivo interno versionado no pacote: ${path} = ${copied}`);
      const flat = compact(text);
      for (const [fragment, origin] of corpus.fragments)
        if (flat.includes(fragment))
          throw new Error(`Certificado ou chave interna no pacote: ${path} contém ${origin}`);
    }
  }
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "NOTICE",
    "LICENSING.md",
    "THIRD_PARTY_NOTICES.txt",
  ])
    if (!paths.has(required)) throw new Error(`Aviso obrigatório ausente: ${required}`);
  // Only contracts mixes licenses: Freecorps in LICENSE, MIT for four files.
  if (paths.has("LICENSE-MIT") !== mixedLicensePackages.has(expectedName))
    throw new Error("LICENSE-MIT diverge da política do artefato");
  if (mixedLicensePackages.has(expectedName)) {
    const prefix = "packages/contracts/src/";
    const mit = new Set(
      firstPartyScope()
        .mit.files.filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length, -3)),
    );
    for (const { path, bytes } of entries) {
      const stem = /^dist\/(.+?)(?:\.d\.ts|\.js)$/.exec(path)?.[1];
      if (
        stem !== undefined &&
        /^\/\/ SPDX-License-Identifier: MIT$/m.test(bytes.toString("utf8")) !== mit.has(stem)
      )
        throw new Error(`Licença MIT diverge do escopo declarado: ${path}`);
    }
  }
  const manifest = JSON.parse(
    entries.find((e) => e.path === "package.json").bytes.toString("utf8"),
  );
  if (
    !licenses[expectedName] ||
    manifest.name !== expectedName ||
    manifest.license !== licenses[expectedName]
  )
    throw new Error("Identidade ou licença divergente");
  // Only an accepted version leaves the private preparation, and always public.
  const accepted = acceptedPackages.has(expectedName);
  if (!accepted && (manifest.private !== true || manifest.publishConfig !== undefined))
    throw new Error("Pacote não aceito precisa continuar privado, sem publicação");
  if (
    accepted &&
    (manifest.version !== acceptance.version ||
      manifest.private !== undefined ||
      manifest.publishConfig?.access !== "public" ||
      Object.keys(manifest.publishConfig).length !== 1)
  )
    throw new Error("Versão ou configuração de publicação fora do aceite");
  const visit = (value) => {
    if (typeof value === "string") {
      if (!value.startsWith("./") || !paths.has(value.slice(2)))
        throw new Error("Export ausente no tarball");
    } else if (value && typeof value === "object") Object.values(value).forEach(visit);
    else throw new Error("Export inválido");
  };
  if (!manifest.exports) throw new Error("Pacote sem exports");
  visit(manifest.exports);
  if (Object.values(manifest.dependencies ?? {}).some((v) => /^(workspace:|file:|link:)/.test(v)))
    throw new Error("Dependência local no artefato final");
  const embeddedSchemas = entries.filter((e) => /(?:^|\/)schemas\.json$/.test(e.path));
  if (schemaPackages.has(expectedName) !== embeddedSchemas.length > 0)
    throw new Error("Schemas incorporados divergem da política do artefato");
  if (embeddedSchemas.length > 0) {
    // The embedded catalog must be exactly the runtime copy the manifest
    // records, file by file, so the tarball carries no unlisted schema.
    const schemaManifest = entries.find((e) => e.path === "schemas/manifest.json");
    if (embeddedSchemas.length !== 1 || !schemaManifest)
      throw new Error("Schemas incorporados sem manifesto no pacote");
    const manifestFiles = JSON.parse(schemaManifest.bytes.toString("utf8")).files;
    if (
      unmodifiedSchemaPackages.has(expectedName) &&
      manifestFiles.some((file) => file.runtimeUtf8Sha256 !== file.sha256)
    )
      throw new Error("Schemas sob ND precisam ser os originais intactos");
    const recorded = new Map(manifestFiles.map((file) => [file.path, file.runtimeUtf8Sha256]));
    const catalog = Object.entries(JSON.parse(embeddedSchemas[0].bytes.toString("utf8")));
    if (
      catalog.length !== recorded.size ||
      catalog.some(([path, text]) => recorded.get(path) !== sha256(text))
    )
      throw new Error("Schemas incorporados divergem dos hashes do manifesto");
  }
  if (expectedName === "@freecorps/freecorpsnfe-sdk") assertSdkDeclarations([...paths]);
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    private: manifest.private === true,
    distribution: accepted
      ? {
          status: "accepted",
          acceptedConditions: [...acceptance.conditions],
          acceptance: acceptanceRecords[expectedName] ?? acceptance.record,
          policy: "docs/licenses/DISTRIBUTION.md",
        }
      : {
          status: "private",
          decision: acceptance.record,
          policy: "docs/licenses/DISTRIBUTION.md",
        },
    embeddedSchemas: embeddedSchemas.map((e) => e.path),
    internalCorpusFilesCompared: corpus?.files ?? 0,
    files: entries.map((e) => ({ path: e.path, bytes: e.bytes.length, sha256: sha256(e.bytes) })),
  };
}

// Reads a gzipped tarball in-process. One `tar` per entry made the inspection
// fail under load on Windows, where Git's MSYS tar aborts with
// "MapViewOfFileEx ... Win32 error 487" (#573). npm and Bun write ustar with
// pax headers for long names; GNU long names are accepted too.
export function readTarball(bytes) {
  const tar = gunzipSync(bytes);
  const field = (block, start, length) => {
    const end = block.indexOf(0, start);
    return block.toString("utf8", start, end === -1 || end > start + length ? start + length : end);
  };
  const octal = (block, start, length) => {
    const text = field(block, start, length).trim();
    if (!/^[0-7]+$/.test(text)) throw new Error("Cabeçalho de tarball inválido");
    return parseInt(text, 8);
  };
  const entries = [];
  let longName;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== octal(header, 148, 8)) throw new Error("Cabeçalho de tarball inválido");
    const size = octal(header, 124, 12);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) throw new Error("Tarball truncado");
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156] || 48);
    if (type === "x") {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (path) longName = path[1];
    } else if (type === "L") longName = field(body, 0, size);
    else if (type === "g") continue;
    else {
      const prefix = field(header, 345, 155);
      const name = longName ?? (prefix ? `${prefix}/` : "") + field(header, 0, 100);
      longName = undefined;
      if (type === "5") continue;
      if (type !== "0") throw new Error("Entrada de tarball não é arquivo: " + name);
      entries.push({ name, bytes: Buffer.from(body) });
    }
  }
  return entries;
}

let corpusCache;
export function inspectTarball(path, expectedName) {
  const tarball = readFileSync(path);
  const entries = readTarball(tarball).map(({ name, bytes }) => {
    if (!name.startsWith("package/") || name.includes("..") || name.includes("\\"))
      throw new Error("Caminho de tarball inválido");
    return { path: name.slice(8), bytes };
  });
  corpusCache ??= internalCorpus();
  const report = checkPackageFiles(entries, expectedName, corpusCache);
  const license = entries
    .find((entry) => entry.path === "LICENSE")
    .bytes.toString("utf8")
    .replaceAll("\r\n", "\n");
  if (license !== packageLicenseText(expectedName))
    throw new Error("Texto de licença incorreto no tarball");
  const mit = entries.find((entry) => entry.path === "LICENSE-MIT");
  if (
    mit &&
    mit.bytes.toString("utf8").replaceAll("\r\n", "\n") !==
      packageLicenseText("@freecorps/freecorpsnfe-sdk")
  )
    throw new Error("Texto MIT incorreto no tarball");
  return { tarballSha256: sha256(tarball), ...report };
}
