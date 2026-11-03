import { describe, expect, it } from "vite-plus/test";
import {
  checkPackageFiles,
  inspectTarball,
  internalCorpus,
  readTarball,
  stagePackage,
} from "./lib/distribution.mjs";
import { npmRunner } from "./lib/npm-cli.mjs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const valid = () => [
  {
    path: "package.json",
    bytes: Buffer.from(
      JSON.stringify({
        name: "@freecorps/fiscal-core",
        version: "0.1.0",
        license: "SEE LICENSE IN LICENSING.md",
        publishConfig: { access: "public" },
        exports: { ".": "./dist/index.js" },
      }),
    ),
  },
  ...[
    "README.md",
    "LICENSE",
    "NOTICE",
    "LICENSING.md",
    "THIRD_PARTY_NOTICES.txt",
    "dist/index.js",
  ].map((path) => ({ path, bytes: Buffer.from("example") })),
];
describe("distribuição aceita na #83", () => {
  it("confere bytes e exports do artefato", () => {
    const report = checkPackageFiles(valid(), "@freecorps/fiscal-core");
    expect(report.files).toHaveLength(7);
    expect(report.distribution.status).toBe("accepted");
    expect(report.distribution.acceptedConditions).toEqual(["rights", "release-acceptance"]);
  });
  it("separa o aceite do SDK dos direitos sobre motor e XSDs", () => {
    const files = valid();
    const manifest = JSON.parse(files[0]!.bytes.toString());
    manifest.name = "@freecorps/freecorpsnfe-sdk";
    manifest.license = "MIT";
    files[0]!.bytes = Buffer.from(JSON.stringify(manifest));
    files.push({ path: "types/sdk/src/index.d.ts", bytes: Buffer.from("export {};") });
    const decision = checkPackageFiles(files, manifest.name).distribution;
    expect(decision.status).toBe("accepted");
    expect(decision.acceptedConditions).toEqual(["rights", "release-acceptance"]);
  });
  // contracts: Freecorps em LICENSE e MIT só para os quatro arquivos externos.
  const contracts = (mitHeaderIn = ["dist/external.js", "dist/external.d.ts"]) => {
    const files = valid().filter((file) => file.path !== "dist/index.js");
    const manifest = JSON.parse(files[0]!.bytes.toString());
    manifest.name = "@freecorps/contracts";
    manifest.private = true;
    delete manifest.publishConfig;
    files[0]!.bytes = Buffer.from(JSON.stringify(manifest));
    files.push({ path: "LICENSE-MIT", bytes: Buffer.from("example") });
    for (const path of ["dist/index.js", "dist/external.js", "dist/external.d.ts"])
      files.push({
        path,
        bytes: Buffer.from(
          (mitHeaderIn.includes(path) ? "// SPDX-License-Identifier: MIT\n" : "") + "export {};",
        ),
      });
    return files;
  };
  it("aceita contracts com LICENSE-MIT e cabeçalho MIT só no escopo declarado", () => {
    const decision = checkPackageFiles(contracts(), "@freecorps/contracts").distribution;
    expect(decision.status).toBe("private");
  });
  it("recusa contracts publicável: o aceite de 01/11 o mantém privado", () => {
    const files = contracts();
    const manifest = JSON.parse(files[0]!.bytes.toString());
    delete manifest.private;
    manifest.publishConfig = { access: "public" };
    files[0]!.bytes = Buffer.from(JSON.stringify(manifest));
    expect(() => checkPackageFiles(files, "@freecorps/contracts")).toThrow("privado");
  });
  it("recusa contracts sem LICENSE-MIT e LICENSE-MIT em outro pacote", () => {
    expect(() =>
      checkPackageFiles(
        contracts().filter((file) => file.path !== "LICENSE-MIT"),
        "@freecorps/contracts",
      ),
    ).toThrow("LICENSE-MIT diverge");
    expect(() =>
      checkPackageFiles(
        [...valid(), { path: "LICENSE-MIT", bytes: Buffer.from("example") }],
        "@freecorps/fiscal-core",
      ),
    ).toThrow("LICENSE-MIT diverge");
  });
  it.each([
    ["sem cabeçalho num arquivo MIT", ["dist/external.js"]],
    ["com cabeçalho fora do escopo", ["dist/external.js", "dist/external.d.ts", "dist/index.js"]],
  ])("recusa contracts %s", (_, headers) => {
    expect(() => checkPackageFiles(contracts(headers), "@freecorps/contracts")).toThrow(
      "Licença MIT diverge do escopo declarado",
    );
  });
  // Catálogo mínimo: um XSD e o manifesto com o hash da cópia de runtime.
  const withSchemas = (name: string, xsd = "<xs:schema/>", recorded = xsd, source = recorded) => {
    const original = createHash("sha256").update(source).digest("hex");
    const files = valid();
    const manifest = JSON.parse(files[0]!.bytes.toString());
    manifest.name = name;
    files[0]!.bytes = Buffer.from(JSON.stringify(manifest));
    const runtimeUtf8Sha256 = createHash("sha256").update(recorded).digest("hex");
    files.push(
      { path: "dist/schemas.json", bytes: Buffer.from(JSON.stringify({ "v1/a.xsd": xsd })) },
      {
        path: "schemas/manifest.json",
        bytes: Buffer.from(
          JSON.stringify({ files: [{ path: "v1/a.xsd", sha256: original, runtimeUtf8Sha256 }] }),
        ),
      },
    );
    return files;
  };
  it.each(["@freecorps/fiscal-nfe", "@freecorps/fiscal-nfse"])(
    "registra o aceite da release quando o tarball fiscal %s passa",
    (name) => {
      const decision = checkPackageFiles(withSchemas(name), name).distribution;
      expect(decision.status).toBe("accepted");
      expect(decision.acceptedConditions).toEqual(["rights", "release-acceptance"]);
    },
  );
  it.each(["@freecorps/fiscal-nfe", "@freecorps/fiscal-nfse"])(
    "recusa catálogo de %s sem schemas, sem manifesto ou fora dos hashes",
    (name) => {
      const files = withSchemas(name);
      expect(() =>
        checkPackageFiles(
          files.filter((file) => file.path !== "dist/schemas.json"),
          name,
        ),
      ).toThrow("Schemas incorporados divergem da política");
      expect(() =>
        checkPackageFiles(
          files.filter((file) => file.path !== "schemas/manifest.json"),
          name,
        ),
      ).toThrow("sem manifesto");
      expect(() =>
        checkPackageFiles(withSchemas(name, "<xs:schema/>", "<xs:schema></xs:schema>"), name),
      ).toThrow("hashes do manifesto");
    },
  );
  it("recusa XSD NFS-e (CC BY-ND) alterado na cópia distribuída; NF-e registra a conversão", () => {
    const adjusted = [
      "<xs:schema/>",
      "<xs:schema/>",
      String.fromCharCode(0xfeff) + "<xs:schema/>",
    ] as const;
    expect(() =>
      checkPackageFiles(
        withSchemas("@freecorps/fiscal-nfse", ...adjusted),
        "@freecorps/fiscal-nfse",
      ),
    ).toThrow("originais intactos");
    expect(
      checkPackageFiles(withSchemas("@freecorps/fiscal-nfe", ...adjusted), "@freecorps/fiscal-nfe")
        .distribution.status,
    ).toBe("accepted");
  });
  it.each([
    ".env",
    "fixture.pfx",
    "dist/fixtures/secret.json",
    "dist/../secret.js",
    "dist/index.js",
  ])("recusa arquivo ou duplicata %s", (path) => {
    expect(() =>
      checkPackageFiles(
        [...valid(), { path, bytes: Buffer.from("secret") }],
        "@freecorps/fiscal-core",
      ),
    ).toThrow();
  });
  it("recusa chave privada embutida num JS", () => {
    const files = valid();
    files.at(-1)!.bytes = Buffer.from("-----BEGIN PRIVATE KEY-----");
    expect(() => checkPackageFiles(files, "@freecorps/fiscal-core")).toThrow("credencial");
  });
  it.each([
    ["certificado PEM", "-----BEGIN CERTIFICATE-----"],
    ["chave AWS", "AKIA" + "ABCDEFGHIJKLMNOP"],
    ["chave de deploy Convex", "prod:happy-animal-123|" + "a".repeat(48)],
    ["token npm", "npm_" + "a".repeat(36)],
  ])("recusa %s embutido num JS", (_, secret) => {
    const files = valid();
    files.at(-1)!.bytes = Buffer.from(`export const value = ${JSON.stringify(secret)};`);
    expect(() => checkPackageFiles(files, "@freecorps/fiscal-core")).toThrow("credencial");
  });
  it("recusa NF-e assinada ou certificado incorporados mesmo em dist/", () => {
    const corpus = internalCorpus();
    expect(corpus.files).toBeGreaterThan(50);
    const invoice = readFileSync("tests/fixtures/nfe/4.00/invoice-signed.xml");
    for (const [path, bytes] of [
      ["dist/invoice.json", invoice],
      ["dist/corpus.json", Buffer.from(JSON.stringify({ xml: invoice.toString("utf8") }))],
    ]) {
      expect(() =>
        checkPackageFiles(
          [...valid(), { path, bytes: bytes as Buffer }],
          "@freecorps/fiscal-core",
          corpus,
        ),
      ).toThrow(/corpus|interno/);
    }
  });
  it("recusa cópia de fixture ou corpo de chave versionados", () => {
    const corpus = internalCorpus();
    const manifest = readFileSync("tests/fixtures/nfe/4.00/manifest.json");
    expect(() =>
      checkPackageFiles(
        [...valid(), { path: "dist/manifest.json", bytes: manifest }],
        "@freecorps/fiscal-core",
        corpus,
      ),
    ).toThrow("Arquivo interno versionado");
    const key = readFileSync("tests/fixtures/nfe/4.00/synthetic-signing-key.pem", "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("-----"))
      .join("");
    expect(() =>
      checkPackageFiles(
        [...valid(), { path: "dist/key.js", bytes: Buffer.from(`export default "${key}";`) }],
        "@freecorps/fiscal-core",
        corpus,
      ),
    ).toThrow("Certificado ou chave interna");
  });
  it("aplica o campo files do manifesto ao diretório inteiro do pacote", () => {
    const directory = mkdtempSync(join(tmpdir(), "fnfe-stage-"));
    try {
      const source = join(directory, "source");
      for (const entry of valid()) {
        const target = join(source, entry.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, entry.path === "LICENSE" ? readFileSync("LICENSE") : entry.bytes);
      }
      for (const path of ["fixtures/invoice.xml", "src/index.ts", "node_modules/x/index.js"]) {
        mkdirSync(dirname(join(source, path)), { recursive: true });
        writeFileSync(join(source, path), "internal");
      }
      const npm = npmRunner();
      const pack = (files: string[], name: string) => {
        const manifest = JSON.parse(valid()[0]!.bytes.toString());
        writeFileSync(join(source, "package.json"), JSON.stringify({ ...manifest, files }));
        const staged = join(directory, name);
        stagePackage(source, staged);
        expect(() => readFileSync(join(staged, "node_modules/x/index.js"))).toThrow();
        const [packed] = JSON.parse(
          npm(["pack", "--json", "--pack-destination", directory], staged),
        );
        return join(directory, packed.filename);
      };
      const notices = ["README.md", "LICENSE", "NOTICE", "LICENSING.md", "THIRD_PARTY_NOTICES.txt"];
      const report = inspectTarball(pack(["dist", ...notices], "narrow"), "@freecorps/fiscal-core");
      expect(report.files.map((file: { path: string }) => file.path)).not.toContain("src/index.ts");
      expect(report.internalCorpusFilesCompared).toBeGreaterThan(50);
      expect(() =>
        inspectTarball(pack(["dist", "fixtures", ...notices], "wide"), "@freecorps/fiscal-core"),
      ).toThrow("Arquivo não permitido no pacote: fixtures/invoice.xml");
    } finally {
      if (dirname(resolve(directory)) === resolve(tmpdir()))
        rmSync(directory, { recursive: true, force: true });
    }
  });
  it("recusa aviso removido", () => {
    expect(() =>
      checkPackageFiles(
        valid().filter((f) => f.path !== "NOTICE"),
        "@freecorps/fiscal-core",
      ),
    ).toThrow("Aviso");
  });
  it("recusa export quebrado", () => {
    expect(() =>
      checkPackageFiles(
        valid().filter((f) => f.path !== "dist/index.js"),
        "@freecorps/fiscal-core",
      ),
    ).toThrow("Export");
  });
  it.each([
    ["privado", { private: true }],
    ["com private false", { private: false }],
    ["sem acesso público", { publishConfig: undefined }],
    ["com acesso restrito", { publishConfig: { access: "restricted" } }],
    ["com outro registry", { publishConfig: { access: "public", registry: "https://x.test/" } }],
    ["em versão não aceita", { version: "0.1.1" }],
  ])("recusa artefato %s", (_, change) => {
    const files = valid();
    const manifest = { ...JSON.parse(files[0]!.bytes.toString()), ...change };
    files[0]!.bytes = Buffer.from(JSON.stringify(manifest));
    expect(() => checkPackageFiles(files, "@freecorps/fiscal-core")).toThrow("publicação");
  });
  it("não permite chamar o artefato com schemas de Apache-2.0", () => {
    const files = valid();
    const manifest = JSON.parse(files[0]!.bytes.toString());
    manifest.name = "@freecorps/fiscal-nfe";
    manifest.license = "Apache-2.0";
    files[0]!.bytes = Buffer.from(JSON.stringify(manifest));
    expect(() => checkPackageFiles(files, "@freecorps/fiscal-nfe")).toThrow("licença");
  });
  it("não permite incorporar schemas no pacote puro", () => {
    expect(() =>
      checkPackageFiles(
        [...valid(), { path: "dist/schemas.json", bytes: Buffer.from("{}") }],
        "@freecorps/fiscal-core",
      ),
    ).toThrow("Schemas");
  });
  it("confere o texto real da licença, mesmo com metadata correto no tgz", () => {
    const directory = mkdtempSync(join(tmpdir(), "fnfe-tarball-license-"));
    try {
      const packageDirectory = join(directory, "package");
      for (const entry of valid()) {
        const target = join(packageDirectory, entry.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, entry.path === "LICENSE" ? readFileSync("LICENSE") : entry.bytes);
      }
      const npm = npmRunner();
      const pack = () => {
        const [packed] = JSON.parse(
          npm(["pack", "--json", "--pack-destination", directory], packageDirectory),
        );
        return join(directory, packed.filename);
      };
      expect(inspectTarball(pack(), "@freecorps/fiscal-core").license).toBe(
        "SEE LICENSE IN LICENSING.md",
      );
      writeFileSync(join(packageDirectory, "LICENSE"), readFileSync("LICENSES/MIT.txt"));
      expect(() => inspectTarball(pack(), "@freecorps/fiscal-core")).toThrow(
        "Texto de licença incorreto",
      );
    } finally {
      // Only the directory just created by mkdtemp is eligible for cleanup.
      if (dirname(resolve(directory)) === resolve(tmpdir()))
        rmSync(directory, { recursive: true, force: true });
    }
  });
  it("lê no próprio processo os nomes longos que o npm grava no tarball", () => {
    const directory = mkdtempSync(join(tmpdir(), "fnfe-tarball-names-"));
    try {
      const long = "dist/" + "nivel-de-diretorio/".repeat(6) + "index.js";
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name: "x", version: "1.0.0" }),
      );
      mkdirSync(join(directory, dirname(long)), { recursive: true });
      writeFileSync(join(directory, long), "export {};");
      const [packed] = JSON.parse(
        npmRunner()(["pack", "--json", "--pack-destination", directory], directory),
      );
      const entries = readTarball(readFileSync(join(directory, packed.filename)));
      expect(long.length).toBeGreaterThan(100);
      expect(entries.find((entry) => entry.name === "package/" + long)?.bytes.toString()).toBe(
        "export {};",
      );
    } finally {
      if (dirname(resolve(directory)) === resolve(tmpdir()))
        rmSync(directory, { recursive: true, force: true });
    }
  });
});
