import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const lockBytes = readFileSync("bun.lock", "utf8");
const { config: lock, error } = ts.parseConfigFileTextToJson("bun.lock", lockBytes);
if (error) throw new Error("Lockfile inválido");
const identities = [...new Set(Object.values(lock.packages).map((entry) => entry[0]))]
  .filter((id) => !id.includes("@workspace:"))
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const destination = "docs/licenses/dependencies.json";
const lockSha256 = createHash("sha256").update(lockBytes).digest("hex");
// Lock keys and last fields per identity, indexed once: scanning every lock
// entry for each package made --check quadratic (about 9 s for 800 versions).
const lockedById = new Map();
for (const [locked, entry] of Object.entries(lock.packages)) {
  const index = lockedById.get(entry[0]) ?? { keys: new Set(), lasts: new Set() };
  index.keys.add(locked);
  index.lasts.add(entry.at(-1));
  lockedById.set(entry[0], index);
}

function facts(id) {
  const at = id.lastIndexOf("@");
  const name = id.slice(0, at),
    version = id.slice(at + 1);
  const { keys, lasts } = lockedById.get(id) ?? { keys: new Set(), lasts: new Set() };
  const direct = Object.entries(lock.workspaces).flatMap(([path, workspace]) =>
    ["dependencies", "devDependencies", "optionalDependencies"].flatMap((kind) =>
      Object.keys(workspace[kind] ?? {})
        .filter((key) => keys.has(key) || keys.has(`${path}/${key}`))
        .map((dependency) => ({ workspace: path || ".", kind, dependency })),
    ),
  );
  const integrity = [...lasts].filter(
    (value) => typeof value === "string" && value.startsWith("sha"),
  );
  if (integrity.length !== 1) throw new Error(`Integridade ambígua no lock: ${id}`);
  return {
    name,
    version,
    direct,
    integrity: integrity[0],
    source: `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
  };
}

if (process.argv.includes("--check")) {
  const inventory = JSON.parse(readFileSync(destination, "utf8"));
  if (
    inventory.lockSha256 !== lockSha256 ||
    JSON.stringify(inventory.packages.map((p) => p.id)) !== JSON.stringify(identities)
  )
    throw new Error(
      "Inventário de licenças desatualizado: execute licenses:inventory e revise o diff",
    );
  const reviewed = new Set([
    "MIT",
    "ISC",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "0BSD",
    "MIT-0",
    "MPL-2.0",
    "OFL-1.1",
    "CC0-1.0",
    "Python-2.0",
    "CC-BY-4.0",
    "Unlicense",
    "BlueOak-1.0.0",
    "MIT OR Apache-2.0",
    "LGPL-3.0-or-later",
    "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
    "Apache-2.0 AND LGPL-3.0-or-later",
    "(BSD-3-Clause OR GPL-2.0)",
    "(MIT AND Zlib)",
    "(MIT OR CC0-1.0)",
  ]);
  if (inventory.schemaVersion !== 1) throw new Error("Schema de inventário desconhecido");
  for (const item of inventory.packages) {
    const expected = facts(item.id);
    for (const field of ["direct", "integrity", "source"])
      if (JSON.stringify(item[field]) !== JSON.stringify(expected[field]))
        throw new Error(`Inventário diverge do lock: ${item.id}/${field}`);
    if (!reviewed.has(item.declaredLicense)) throw new Error(`Licença requer revisão: ${item.id}`);
    if (item.repository !== null && typeof item.repository !== "string")
      throw new Error("Repository inválido");
  }
  const additions = JSON.parse(readFileSync("docs/licenses/runtime-additions.json", "utf8"));
  // Each version npm resolves outside bun.lock is reviewed by hand and listed here.
  const reviewedAdditions = new Map([
    [
      "@nodable/entities@3.1.0",
      {
        source: "https://registry.npmjs.org/%40nodable%2Fentities/3.1.0",
        repository: "nodable/val-parsers",
      },
    ],
    [
      "strnum@2.5.1",
      {
        source: "https://registry.npmjs.org/strnum/2.5.1",
        repository: "NaturalIntelligence/strnum",
      },
    ],
    [
      "is-unsafe@2.0.3",
      {
        source: "https://registry.npmjs.org/is-unsafe/2.0.3",
        repository: "NaturalIntelligence/is-unsafe",
      },
    ],
  ]);
  if (
    additions.schemaVersion !== 1 ||
    additions.packages.length !== reviewedAdditions.size ||
    new Set(additions.packages.map((extra) => extra.id)).size !== reviewedAdditions.size
  )
    throw new Error("Runtime adicional requer revisão");
  for (const extra of additions.packages) {
    const expected = reviewedAdditions.get(extra.id);
    if (
      !expected ||
      extra.declaredLicense !== "MIT" ||
      extra.source !== expected.source ||
      extra.repository !== `git+https://github.com/${expected.repository}.git` ||
      !/^[a-f0-9]{40}$/.test(extra.gitHead ?? "") ||
      extra.licenseSource !==
        `https://github.com/${expected.repository}/blob/${extra.gitHead}/LICENSE` ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(extra.integrity ?? "")
    )
      throw new Error("Runtime adicional requer revisão");
  }
  console.log(`Inventário corresponde ao lock: ${identities.length} versões`);
} else {
  const results = new Map();
  const queue = [...identities];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (queue.length) {
        const id = queue.shift();
        const { name, version, source, direct, integrity } = facts(id);
        const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
        const manifest = await response.json();
        if (manifest.name !== name || manifest.version !== version)
          throw new Error(`Identidade divergente: ${id}`);
        const declaredLicense =
          typeof manifest.license === "string"
            ? manifest.license
            : (manifest.license?.type ?? "UNKNOWN");
        if (integrity !== manifest.dist?.integrity)
          throw new Error(`Integridade do registry diverge do lock: ${id}`);
        results.set(id, {
          id,
          declaredLicense,
          source,
          integrity,
          repository:
            typeof manifest.repository === "string"
              ? manifest.repository
              : (manifest.repository?.url ?? null),
          direct,
        });
      }
    }),
  );
  mkdirSync("docs/licenses", { recursive: true });
  writeFileSync(
    destination,
    JSON.stringify(
      {
        schemaVersion: 1,
        lockSha256,
        method:
          "Exact registry manifests matched to every locked tarball integrity, including optional platforms and development tools. License declarations require the review in LICENSING.md; this is not a compatibility verdict.",
        packages: identities.map((id) => results.get(id)),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Inventário gravado: ${results.size} versões`);
}
