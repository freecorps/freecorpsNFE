import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { scanPublicText } from "./scan-public-text.mjs";

// Valores montados em tempo de execução: este arquivo também é varrido pelo
// pre-push e pelo Public scan e não pode conter um CNPJ, token ou e-mail que
// eles acusem.
const cnpjWithDv = (base: string) => {
  const dv = (digits: string) => {
    let sum = 0;
    let weight = digits.length - 7;
    for (const c of digits) {
      sum += (c.charCodeAt(0) - 48) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }
    const rest = sum % 11;
    return String(rest < 2 ? 0 : 11 - rest);
  };
  const first = base + dv(base);
  return first + dv(first);
};
const email = (local: string, domain: string) => [local, domain].join("@");
const fictitiousCnpj = cnpjWithDv(["9876", "5432", "0001"].join(""));
const githubToken = ["gh", "p_", "a".repeat(36)].join("");
const localPath = ["C:", "Users", ["mar", "ia"].join(""), "repo"].join("/");

const kinds = (text: string) => scanPublicText("corpo.md", text).map((f) => f.kind);

describe("scanPublicText", () => {
  it("deixa passar texto com dados sintéticos e endereços de função", () => {
    const text = [
      "## Problema",
      "Importar a nota da empresa 11222333000181 falha com `NFE_INVALIDA`.",
      `Contato: ${email("seguranca", "nfe.freecorps.com.br")} ou ${email("ana", "example.com")}.`,
      "Relacionado a #123, em `platform/convex/imports.ts:42`.",
    ].join("\n");
    expect(scanPublicText("corpo.md", text)).toEqual([]);
  });

  it("acusa credencial, CNPJ real, e-mail externo e caminho local, sem o valor", () => {
    const text = [githubToken, fictitiousCnpj, email("cliente", "gmail.com"), localPath].join("\n");
    const findings = scanPublicText("corpo.md", text);
    expect(findings).toEqual([
      { path: "corpo.md", line: 1, kind: "segredo", rule: "service-token" },
      { path: "corpo.md", line: 2, kind: "cnpj-nao-sintetico" },
      { path: "corpo.md", line: 3, kind: "email-externo" },
      { path: "corpo.md", line: 4, kind: "caminho-local" },
    ]);
    expect(JSON.stringify(findings)).not.toContain(fictitiousCnpj);
  });

  it("para no e-mail pessoal da Freecorps, que depende de decisão", () => {
    expect(kinds(email("fulano.tal", "freecorps.com.br"))).toEqual(["email-pessoal-freecorps"]);
  });
});

describe("scan-public-text CLI", () => {
  const script = fileURLToPath(new URL("./scan-public-text.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "scan-public-text-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true });

  it("sai com 0 no texto limpo e com 1 no achado, sem imprimir o valor", () => {
    const clean = join(dir, "limpo.md");
    const dirty = join(dir, "sujo.md");
    writeFileSync(clean, "Título sem dado real\n");
    writeFileSync(dirty, `Nota da empresa ${fictitiousCnpj}\n`);

    expect(run(clean).status).toBe(0);
    const blocked = run(clean, dirty);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("sujo.md:1  cnpj-nao-sintetico");
    expect(blocked.stderr + blocked.stdout).not.toContain(fictitiousCnpj);
  });

  it("sai com 2 sem argumento ou com arquivo ilegível", () => {
    expect(run().status).toBe(2);
    expect(run(join(dir, "ausente.md")).status).toBe(2);
  });
});
