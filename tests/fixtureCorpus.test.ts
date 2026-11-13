import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { XMLValidator } from "fast-xml-parser";
import manifest from "./fixtures/fiscal-v1/manifest.json";
import matrix from "./coverage-matrix.json";

const folder = new URL("./fixtures/fiscal-v1/", import.meta.url);
it("keeps the versioned synthetic corpus intact and lists every XML fixture", () => {
  expect(manifest.version).toBe(2);
  expect(manifest.provenance).toBe("handwritten-synthetic");
  expect(
    readdirSync(folder)
      .filter((file) => file.endsWith(".xml"))
      .sort(),
  ).toEqual(manifest.files.map((item) => item.file).sort());
  for (const item of manifest.files) {
    const bytes = readFileSync(new URL(item.file, folder));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.sha256);
    expect(bytes.toString("utf8")).toContain(`versao="${item.version}"`);
    expect(bytes.toString("utf8")).not.toMatch(/PRIVATE KEY|X509Certificate|<CNPJ>|<CPF>/);
  }
});
it("declares a known consumer for every fixture", () => {
  for (const item of manifest.files) expect(item.consumer).toBe("future-distribution");
});
it.each(manifest.files.filter((item) => item.consumer === "future-distribution"))(
  "exercises the declared consumer for $file",
  (item) => {
    const xml = readFileSync(new URL(item.file, folder), "utf8");
    expect(XMLValidator.validate(xml)).toBe(true);
  },
);
it("requires real evidence files for delivered modules and exposes future coverage", () => {
  for (const module of matrix.modules) {
    expect(module.id).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(["delivered", "pending"]).toContain(module.status);
    // Entregue cita ao menos um teste deste repositório, que roda a cada
    // mudança; recibos arquivados sozinhos não mostram a cobertura de hoje.
    if (module.status === "delivered")
      expect(
        module.evidence.some((file) => /\.test\.tsx?$/.test(file)),
        module.id,
      ).toBe(true);
    if (module.status === "pending") expect(module.evidence).toEqual([]);
    // Repositório público: os recibos (docs/v1.0/evidence/) ficam no repositório arquivado.
    for (const file of module.evidence.filter((f) => !f.startsWith("docs/v1.0/evidence/")))
      expect(existsSync(new URL(`../${file}`, import.meta.url))).toBe(true);
  }
});
