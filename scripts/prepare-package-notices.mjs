import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { packageLicenseText } from "./lib/first-party-licenses.mjs";

function installed(name, from) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name, "package.json");
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
    if (dirname(directory) === directory) throw new Error(`Dependência não instalada: ${name}`);
  }
}

// Only third-party runtime dependencies; workspace code is covered by LICENSE.
for (const name of ["contracts", "fiscal-core", "fiscal-nfe", "fiscal-nfse", "sdk"]) {
  const base = resolve("packages", name),
    packageName = JSON.parse(readFileSync(join(base, "package.json"), "utf8")).name,
    seen = new Set(),
    sections = [];
  function visit(directory) {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (seen.has(`${manifest.name}@${manifest.version}`)) return;
    seen.add(`${manifest.name}@${manifest.version}`);
    if (!manifest.name.startsWith("@freecorps/")) {
      const files = readdirSync(directory).filter((file) =>
        /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[._-].*)?$/i.test(file),
      );
      const supplemental =
        manifest.name === "@nodable/entities" && ["3.0.0", "3.1.0"].includes(manifest.version)
          ? readFileSync(`docs/licenses/texts/nodable-entities-${manifest.version}-LICENSE`, "utf8")
          : null;
      if (!files.length && !supplemental)
        throw new Error(`Licença ausente no runtime: ${manifest.name}`);
      sections.push(
        `${manifest.name}@${manifest.version}\nDeclared license: ${manifest.license}\n` +
          (supplemental ??
            files
              .sort()
              .map((file) => `${file}\n${readFileSync(join(directory, file), "utf8")}`)
              .join("\n")),
      );
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort())
      visit(installed(dependency, directory));
  }
  visit(base);
  if (name === "fiscal-nfe" && !seen.has("@nodable/entities@3.1.0"))
    sections.push(
      "@nodable/entities@3.1.0\nDeclared license: MIT\n" +
        readFileSync("docs/licenses/texts/nodable-entities-3.1.0-LICENSE", "utf8"),
    );
  const text = (
    "Third-party runtime notices. These components retain their own licenses.\n" +
    (sections.length
      ? "\n" + sections.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n\n---\n\n")
      : "No third-party runtime dependencies.\n")
  ).replaceAll("\r\n", "\n");
  const target = join(base, "THIRD_PARTY_NOTICES.txt");
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== text) throw new Error(`Avisos desatualizados: ${name}`);
    if (
      readFileSync(join(base, "LICENSE"), "utf8").replaceAll("\r\n", "\n") !==
      packageLicenseText(packageName)
    )
      throw new Error(`Texto de licença divergente: ${name}`);
  } else {
    writeFileSync(target, text);
    writeFileSync(join(base, "LICENSE"), packageLicenseText(packageName));
  }
}
console.log(
  "Avisos de runtime conferidos para contracts, fiscal-core, fiscal-nfe, fiscal-nfse e sdk",
);
