import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const licenseFile = /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[._-].*)?$/i;
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
// Code point order, the same on every machine.
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const nameOf = (id) => id.slice(0, id.lastIndexOf("@"));

function inventory() {
  const reviewed = new Map();
  for (const file of ["dependencies.json", "runtime-additions.json"])
    for (const item of read(`docs/licenses/${file}`).packages) reviewed.set(item.id, item);
  return reviewed;
}

// The nearest package.json with a name and a version; nested ones such as
// dist/esm/package.json only set the module type.
function packageOf(file) {
  for (let directory = dirname(file); dirname(directory) !== directory;) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      if (manifest.name && manifest.version) return { directory, manifest };
    }
    if (basename(directory) === "node_modules") return undefined;
    directory = dirname(directory);
  }
  return undefined;
}

// The copies that a dependency ships inside its own dist, listed in vendored.json:
// code under a path, or a compiled file (a .wasm) that links several projects.
// The host must be the reviewed version, or the copy may have changed.
function vendoredSections(file, copies) {
  const path = file.replaceAll("\\", "/");
  const sections = [];
  for (const copy of copies) {
    const host = `/node_modules/${nameOf(copy.vendoredIn)}`;
    const at = path.indexOf(`${host}/${copy.path}/`);
    if (at < 0) continue;
    const manifest = JSON.parse(readFileSync(path.slice(0, at + host.length) + "/package.json"));
    if (`${manifest.name}@${manifest.version}` !== copy.vendoredIn)
      throw new Error(`Cópia embutida fora da versão revisada: ${copy.id} em ${manifest.name}`);
    sections.push([
      copy.id,
      `${copy.id}\nDeclared license: ${copy.declaredLicense}\nVendored in ${copy.vendoredIn}\n` +
        readFileSync(join(root, copy.licenseText), "utf8"),
    ]);
  }
  return sections;
}

/**
 * Third-party notices for the packages whose modules reached the bundle. Each
 * version must be in the reviewed inventory, and each package must ship its
 * own license text or have one in bundle-texts.json; the build fails otherwise.
 */
export function bundleNotices(moduleIds) {
  const reviewed = inventory();
  const copies = read("docs/licenses/vendored.json").packages;
  // Packages published without a license file; the text comes from the repository.
  const supplied = new Map(
    read("docs/licenses/bundle-texts.json").packages.map((item) => [item.id, item]),
  );
  const packages = new Map();
  const missing = new Set();
  for (const raw of moduleIds) {
    const file = raw.replace(/^\0/, "").replace(/\?.*$/, "");
    if (!/[\\/]node_modules[\\/]/.test(file) || !existsSync(file)) continue;
    const vendored = vendoredSections(file, copies);
    if (vendored.length) {
      for (const section of vendored) packages.set(...section);
      continue;
    }
    const found = packageOf(file);
    if (!found) throw new Error(`Pacote não identificado no bundle: ${file}`);
    const id = `${found.manifest.name}@${found.manifest.version}`;
    if (found.manifest.name.startsWith("@freecorps/") || packages.has(id)) continue;
    const item = reviewed.get(id);
    if (!item) throw new Error(`Pacote no bundle fora do inventário de licenças: ${id}`);
    const files = readdirSync(found.directory)
      .filter((name) => licenseFile.test(name))
      .sort(byCode);
    const text = supplied.get(id);
    if (!files.length && !text) {
      missing.add(id);
      continue;
    }
    const body = files.length
      ? files.map((name) => `${name}\n${readFileSync(join(found.directory, name), "utf8")}`)
      : [
          `License text from ${text.licenseSource}\n${readFileSync(join(root, text.licenseText), "utf8")}`,
        ];
    packages.set(id, `${id}\nDeclared license: ${item.declaredLicense}\n` + body.join("\n"));
  }
  if (missing.size)
    throw new Error(
      `Licença ausente nos pacotes do bundle: ${[...missing].sort(byCode).join(", ")}`,
    );
  const sections = [...packages.keys()].sort(byCode).map((id) => packages.get(id));
  return (
    "Third-party notices for the code and fonts in this bundle. These components retain their own licenses.\n\n" +
    sections.join("\n\n---\n\n")
  ).replaceAll("\r\n", "\n");
}

/** Emits the notices of the client bundle as `fileName`. */
export function thirdPartyNotices(fileName) {
  return {
    name: "freecorps-third-party-notices",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle(_, bundle) {
      const ids = new Set();
      for (const output of Object.values(bundle))
        if (output.type === "chunk") for (const id of output.moduleIds) ids.add(id);
      this.emitFile({ type: "asset", fileName, source: bundleNotices(ids) });
    },
  };
}
