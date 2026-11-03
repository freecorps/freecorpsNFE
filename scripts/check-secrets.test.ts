import { describe, expect, it } from "vite-plus/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowlist, regularFileReader, scan, scanFile } from "./check-secrets.mjs";

// Canaries are assembled at runtime so this file never holds a matching literal.
const apiKey = () => ["fn", "fe_"].join("") + randomBytes(32).toString("base64url");
const awsKey = () => ["AK", "IA"].join("") + "Q7".repeat(8);
const pemHeader = () => ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
const files = (entries: Record<string, string>) => {
  const map = new Map(Object.entries(entries).map(([path, value]) => [path, Buffer.from(value)]));
  return { paths: [...map.keys()], read: (path: string) => map.get(path) ?? null };
};

describe("scanner de segredos", () => {
  it("detecta uma chave fnfe_ sintética e informa só arquivo, linha e regra", () => {
    const secret = apiKey();
    const { paths, read } = files({ "docs/nota.md": `linha\nAuthorization: Bearer ${secret}\n` });
    const result = scan(paths, read, { allow: [] });
    expect(result.blocked).toEqual([{ path: "docs/nota.md", line: 2, rule: "fnfe-api-key" }]);
    expect(JSON.stringify(result)).not.toContain(secret.slice(5));
  });

  it("detecta tokens de serviço e chaves privadas pelo padrão compartilhado", () => {
    const { paths, read } = files({
      "a.ts": `const id = "${awsKey()}";`,
      "b.txt": `${pemHeader()}\nMIIB\n`,
    });
    expect(scan(paths, read, { allow: [] }).blocked.map((f) => f.rule)).toEqual([
      "service-token",
      "private-key",
    ]);
  });

  it("não dispara em menções sem valor", () => {
    const text = [
      "Authorization: Bearer fnfe_...",
      "prefixo exibido: fnfe_WNK5H4cz…",
      'API_KEY_PREFIX = "fnfe_"',
      "chaves AKIA... da AWS",
      `${apiKey()}x`,
    ].join("\n");
    expect(scanFile("README.md", Buffer.from(text))).toEqual([]);
  });

  it("aceita a exceção do arquivo e da regra, e só dela", () => {
    const { paths, read } = files({
      "tests/a.test.ts": `const id = "${awsKey()}";`,
      "tests/b.test.ts": `const id = "${awsKey()}";`,
    });
    const allow = [{ path: "tests/a.test.ts", rule: "service-token", count: 1, reason: "exemplo" }];
    const result = scan(paths, read, { allow });
    expect(result.blocked).toEqual([{ path: "tests/b.test.ts", line: 1, rule: "service-token" }]);
    expect(result.stale).toEqual([]);
    const other = [
      { path: "tests/a.test.ts", rule: "private-key", count: 1, reason: "outra regra" },
    ];
    expect(scan(paths, read, { allow: other }).blocked).toHaveLength(2);
  });

  it("bloqueia uma ocorrência a mais da mesma regra num arquivo com exceção", () => {
    const allow = [{ path: "tests/a.test.ts", rule: "service-token", count: 1, reason: "exemplo" }];
    const sameLine = files({ "tests/a.test.ts": `["${awsKey()}", "${awsKey()}"]` });
    expect(scan(sameLine.paths, sameLine.read, { allow }).blocked).toEqual([
      { path: "tests/a.test.ts", line: 1, rule: "service-token" },
      { path: "tests/a.test.ts", line: 1, rule: "service-token" },
    ]);
    const nextLine = files({ "tests/a.test.ts": `"${awsKey()}"\n"${awsKey()}"` });
    expect(scan(nextLine.paths, nextLine.read, { allow }).blocked.map((f) => f.line)).toEqual([
      1, 2,
    ]);
    const pem = files({ "k.pem": `${pemHeader()}\nMIIB\n${pemHeader()}\nMIIC\n` });
    const key = [{ path: "k.pem", rule: "private-key", count: 1, reason: "fixture" }];
    expect(scan(pem.paths, pem.read, { allow: key }).blocked).toHaveLength(2);
  });

  it("recusa exceção com menos ocorrências que as declaradas", () => {
    const { paths, read } = files({ "a.ts": "nada aqui", "b.ts": `"${awsKey()}"` });
    const allow = [
      { path: "a.ts", rule: "private-key", count: 1, reason: "obsoleta" },
      { path: "b.ts", rule: "service-token", count: 2, reason: "uma removida" },
    ];
    const result = scan(paths, read, { allow });
    expect(result.stale).toEqual(allow);
    expect(result.blocked).toEqual([]);
  });

  it("pula arquivos binários, como imagens", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), Buffer.from(apiKey())]);
    const read = (path: string) => (path === "captura.png" ? png : null);
    expect(scan(["captura.png", "removido.txt"], read, { allow: [] })).toEqual({
      scanned: 0,
      blocked: [],
      stale: [],
    });
  });

  it("lê só arquivos regulares: pula diretório, symlink e caminho ausente", () => {
    const root = mkdtempSync(join(tmpdir(), "check-secrets-"));
    try {
      mkdirSync(join(root, "skills", "animate"), { recursive: true });
      writeFileSync(join(root, "skills", "animate", "SKILL.md"), `token ${apiKey()}\n`);
      writeFileSync(join(root, "nota.md"), "sem credencial\n");
      // A versioned symlink to a directory.
      // "junction" lets Windows create it without elevated privileges.
      symlinkSync(join(root, "skills", "animate"), join(root, "link"), "junction");
      const paths = ["nota.md", "skills", "link", "ausente.md", "skills/animate/SKILL.md"];
      const result = scan(paths, regularFileReader(root), { allow: [] });
      expect(result.scanned).toBe(2);
      expect(result.blocked).toEqual([
        { path: "skills/animate/SKILL.md", line: 1, rule: "fnfe-api-key" },
      ]);
      expect(regularFileReader(root)("link")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("justifica cada exceção versionada", () => {
    for (const entry of allowlist) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(Number.isInteger(entry.count) && entry.count > 0).toBe(true);
    }
  });
});
