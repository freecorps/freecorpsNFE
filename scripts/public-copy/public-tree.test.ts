import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_DENYLIST,
  DEFAULT_RESTRICTED_EDITS,
  applyAllowlist,
  applyGitleaks,
  build as buildTree,
  checkoutClass,
  classify,
  denyEntry,
  loadDenylist,
  loadFmtConfig,
  loadRestrictedEdits,
  lockedOxfmtVersion,
  oxfmtFormatter,
  parseGitleaks,
  scanText,
  unlinkExcluded,
  validAccessKey,
  validCnpj,
  validCpf,
} from "./public-tree.mjs";
import { repoRoot, repoUrl } from "../lib/repo-root.mjs";

// As árvores sintéticas daqui não têm os arquivos que as edições reais da
// cópia pública esperam; sem `editList`, a montagem as daria por pendentes.
const build: typeof buildTree = (options) => buildTree({ editList: [], ...options });

// Valores montados em tempo de execução: este arquivo também vai para a
// árvore pública e não pode conter um CNPJ, chave ou e-mail que a varredura
// acuse.
// DV do CNPJ pela regra da Receita: cada caractere vale o código ASCII menos
// 48 (dígitos de 0 a 9, letras de 17 a 42), pesos 2..9 da direita, módulo 11.
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
const accessKeyWithDv = (base43: string) => {
  let sum = 0;
  let weight = 2;
  for (let i = 42; i >= 0; i--) {
    sum += (base43.charCodeAt(i) - 48) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  return base43 + String(rest < 2 ? 0 : 11 - rest);
};
const fictitiousCnpj = cnpjWithDv(["9876", "5432", "0001"].join(""));
const syntheticCnpj = ["1122", "2333", "0001", "81"].join("");
const email = (local: string, domain: string) => [local, domain].join("@");
const host = (...labels: string[]) => [...labels, "convex", "cloud"].join(".");
const deployment = (env: string, name: string) => [env, name].join(":");
const privateKeyHeader = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
const kinds = (findings: { kind: string }[]) => findings.map((f) => f.kind);

describe("classificação da auditoria de 25/10", () => {
  it("copia só entra e entra com edição", () => {
    expect(classify("docs/v1.0/evidence/83/2026-10-25/README.md")?.class).toBe("custódia");
    expect(classify("docs/licenses/pareceres/2026-10-20/README.md")?.class).toBe("custódia");
    expect(classify("docs/historico/transicao-legado.md")?.class).toBe("sai");
    expect(classify("docs/operacao/backup.md")?.class).toBe("entra com edição");
    expect(classify("docs/v1.0/ACCEPTANCE.md")?.class).toBe("entra com edição");
    expect(classify("docs/licenses/DISTRIBUTION.md")?.class).toBe("entra");
    expect(classify("apps/console/src/main.tsx")?.class).toBe("entra");
    expect(classify("README.md")?.class).toBe("entra");
  });

  it("deixa de fora os testes que só conferem recibos", () => {
    for (const path of [
      "scripts/evidence-storage.test.ts",
      "scripts/observe-worktree.test.ts",
      "scripts/summarize-hosted-round.test.ts",
    ])
      expect(classify(path)?.class).toBe("sai");
    expect(classify("scripts/platform-release.test.ts")?.class).toBe("entra");
  });

  it("não classifica caminho que a auditoria não previu", () => {
    expect(classify("apps/novo/index.ts")).toBeNull();
    expect(classify("docs/NOVO.md")).toBeNull();
    expect(classify("README.md.bak")).toBeNull();
  });

  it("classifica todo arquivo versionado de HEAD", () => {
    const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    expect(paths.filter((p) => !classify(p))).toEqual([]);
  });
});

describe("identificadores fiscais", () => {
  it("confere os dígitos verificadores", () => {
    expect(validCnpj(fictitiousCnpj)).toBe(true);
    expect(
      validCnpj(fictitiousCnpj.slice(0, 13) + String((Number(fictitiousCnpj[13]) + 1) % 10)),
    ).toBe(false);
    expect(validCnpj("1".repeat(14))).toBe(false);
    expect(validCpf(["529", "982", "247", "25"].join(""))).toBe(true);
    expect(validCpf("1".repeat(11))).toBe(false);
    // Exemplo oficial da Receita para o CNPJ alfanumérico: 12.ABC.345/01DE-35.
    expect(validCnpj(["12", "ABC", "345", "01DE", "35"].join(""))).toBe(true);
    expect(validCnpj(["12", "ABC", "345", "01DE", "36"].join(""))).toBe(false);
    expect(cnpjWithDv("12ABC34501DE")).toBe(["12", "ABC", "345", "01DE", "35"].join(""));
    const key = accessKeyWithDv(`352610${fictitiousCnpj}55001000000123100000001`);
    expect(validAccessKey(key)).toBe(true);
    expect(validAccessKey(key.slice(0, 43) + String((Number(key[43]) + 1) % 10))).toBe(false);
  });
});

describe("varredura de um arquivo", () => {
  it("acusa CNPJ e chave de acesso fora dos sintéticos, com linha e sem o valor", () => {
    const key = accessKeyWithDv(`352610${fictitiousCnpj}55001000000123100000001`);
    const masked = fictitiousCnpj.replace(
      /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
      "$1.$2.$3/$4-$5",
    );
    const findings = scanText(
      "docs/a.md",
      `sintético ${syntheticCnpj}\nemitente ${masked}\nchave ${key}\n`,
    );
    expect(findings).toEqual([
      { path: "docs/a.md", line: 2, kind: "cnpj-nao-sintetico" },
      { path: "docs/a.md", line: 3, kind: "chave-de-acesso" },
    ]);
    expect(JSON.stringify(findings)).not.toContain(fictitiousCnpj);
  });

  it("acusa CNPJ depois de barra, hífen e ponto, só com DV válido", () => {
    const wrongDv = fictitiousCnpj.slice(0, 13) + String((Number(fictitiousCnpj[13]) + 1) % 10);
    const text = [
      `https://x.invalid/cnpj/${fictitiousCnpj}`,
      `empresa-${fictitiousCnpj}`,
      `v.${fictitiousCnpj}`,
      `https://x.invalid/cnpj/${wrongDv}`,
      `id-${syntheticCnpj}`,
    ].join("\n");
    expect(scanText("docs/a.md", text)).toEqual([
      { path: "docs/a.md", line: 1, kind: "cnpj-nao-sintetico" },
      { path: "docs/a.md", line: 2, kind: "cnpj-nao-sintetico" },
      { path: "docs/a.md", line: 3, kind: "cnpj-nao-sintetico" },
    ]);
  });

  it("acusa CNPJ alfanumérico com e sem máscara", () => {
    const alnum = cnpjWithDv(["98", "XYZ", "765", "0001"].join(""));
    const masked = alnum.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, "$1.$2.$3/$4-$5");
    const wrong = alnum.slice(0, 13) + String((Number(alnum[13]) + 1) % 10);
    expect(scanText("docs/a.md", `raiz ${alnum}\nmáscara ${masked}\nerrado ${wrong}\n`)).toEqual([
      { path: "docs/a.md", line: 1, kind: "cnpj-nao-sintetico" },
      { path: "docs/a.md", line: 2, kind: "cnpj-nao-sintetico" },
    ]);
  });

  it("aceita chave de emitente sintético", () => {
    const key = accessKeyWithDv(`352610${syntheticCnpj}55001000000123100000001`);
    expect(scanText("tests/x.xml", key)).toEqual([]);
  });

  it("acusa chave de emitente alfanumérico, inteira, depois de NFe e agrupada", () => {
    const alnum = cnpjWithDv(["98", "XYZ", "765", "0001"].join(""));
    const key = accessKeyWithDv(`352610${alnum}55001000000123100000001`);
    expect(validAccessKey(key)).toBe(true);
    const grouped = (sep: string) => key.match(/.{4}/g)!.join(sep);
    const text = [
      key,
      `<infNFe Id="NFe${key}">`,
      grouped(" "),
      grouped("."),
      grouped("-"),
      grouped(".").toLowerCase(),
      // DV errado, emitente com DV errado e emitente sintético não são achado.
      key.slice(0, 43) + String((Number(key[43]) + 1) % 10),
      accessKeyWithDv(
        `352610${alnum.slice(0, 13)}${(Number(alnum[13]) + 1) % 10}55001000000123100000001`,
      ),
      accessKeyWithDv(`352610${syntheticCnpj}55001000000123100000001`).match(/.{4}/g)!.join("."),
    ].join("\n");
    expect(scanText("docs/a.md", text).map((f) => [f.line, f.kind])).toEqual(
      [1, 2, 3, 4, 5, 6].map((line) => [line, "chave-de-acesso"]),
    );
  });

  it("acusa CNPJ alfanumérico em minúsculas", () => {
    const alnum = cnpjWithDv(["98", "XYZ", "765", "0001"].join("")).toLowerCase();
    const masked = alnum.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, "$1.$2.$3/$4-$5");
    expect(kinds(scanText("docs/a.md", `${alnum}\n${masked}\n`))).toEqual([
      "cnpj-nao-sintetico",
      "cnpj-nao-sintetico",
    ]);
  });

  it("separa e-mail de exemplo, de função, pessoal da Freecorps e externo", () => {
    const text = [
      email("ana", "example.com"),
      email("alguem", "development.invalid"),
      email("nome", "empresa.com.br"),
      email("privacidade", "nfe.freecorps.com.br"),
      email("seguranca+t_x", "nfe.freecorps.com.br"),
      email("fulano.tal", "freecorps.com.br"),
      email("cliente", "gmail.com"),
    ].join("\n");
    expect(kinds(scanText("docs/b.md", text))).toEqual([
      "email-funcao-freecorps",
      "email-funcao-freecorps",
      "email-pessoal-freecorps",
      "email-externo",
    ]);
    expect(
      kinds(scanText("packages/x/THIRD_PARTY_NOTICES.txt", email("autor", "gmail.com"))),
    ).toEqual(["email-licenca"]);
  });

  it("só dispensa domínio iniciado por dígito quando é versão de pacote", () => {
    const text = [
      email("contato", "1a.com.br"),
      email("pacote", "1.2.3"),
      email("pacote", "1.0.0-next.29"),
      email("pacote", "0.4.12.patch"),
    ].join("\n");
    expect(scanText("docs/b.md", text)).toEqual([
      { path: "docs/b.md", line: 1, kind: "email-externo" },
    ]);
  });

  it("aceita só os TLDs reservados e example.com/.net/.org como exemplo", () => {
    const allowed = [
      "example.com",
      "example.net",
      "example.org",
      "mail.example.com",
      "x.example",
      "x.test",
      "x.invalid",
      "x.localhost",
    ];
    const refused = ["example.com.br", "example.evil.io", "test.gmail.com", "invalid.dev"];
    const text = [...allowed, ...refused].map((d) => email("ana", d)).join("\n");
    expect(scanText("docs/b.md", text).map((f) => f.line)).toEqual(
      refused.map((_, i) => allowed.length + i + 1),
    );
  });

  it("acusa caminho local de uma pessoa, não o genérico", () => {
    const user = ["mar", "ia"].join("");
    expect(
      kinds(scanText("s.mjs", `C:/Users/${user}/repo\nC:\\Users\\...\n/home/runner/x`)),
    ).toEqual(["caminho-local"]);
  });

  it("acusa caminho local de Git Bash, WSL, URL de arquivo, minúsculas e /var/home", () => {
    const user = ["mar", "ia"].join("");
    const paths = [
      `/c/Users/${user}/repo`,
      `/mnt/c/Users/${user}/repo`,
      `c:/users/${user}/repo`,
      `C:\\\\Users\\\\${user}\\\\repo`,
      `file:///c%3A/Users/${user}/repo`,
      `file:///C:/Users/${user}/repo`,
      `/var/home/${user}/repo`,
    ];
    const generic = [
      "/c/Users/runner/x",
      "/mnt/c/Users/Public/x",
      `https://api.github.com/users/${user}`,
      `/api/users/${user}`,
    ];
    expect(scanText("s.mjs", [...paths, ...generic].join("\n")).map((f) => f.line)).toEqual(
      paths.map((_, i) => i + 1),
    );
  });

  it("acusa host Convex desconhecido e aceita produção, validação e fictícios", () => {
    const text = [host("elated-possum-295"), host("brave-otter-123"), host("quiet-heron-42")].join(
      " ",
    );
    expect(kinds(scanText("t.ts", text))).toEqual(["deployment-desconhecido"]);
  });

  it("acusa host Convex em maiúsculas", () => {
    const text = [
      host("QUIET-HERON-42"),
      host("Elated-Possum-295"),
      host("quiet-heron-42", "EU-WEST-1").toUpperCase(),
    ].join("\n");
    expect(scanText("t.ts", text)).toEqual([
      { path: "t.ts", line: 1, kind: "deployment-desconhecido" },
      { path: "t.ts", line: 3, kind: "deployment-desconhecido" },
    ]);
  });

  it("acusa o nome antes da região num host regional, não a região", () => {
    const text = [
      host("quiet-heron-42", "eu-west-1"),
      host("brave-otter-123", "eu-west-1"),
      `https://${["${NAMED}", "eu-west-1", "convex", "cloud"].join(".")}`,
    ].join("\n");
    expect(scanText("t.ts", text)).toEqual([
      { path: "t.ts", line: 1, kind: "deployment-desconhecido" },
    ]);
  });

  it("acusa deployment desconhecido em dev:<nome> e prod:<nome>", () => {
    const text = [
      deployment("dev", "quiet-heron-42"),
      deployment("prod", "calm-lynx-7"),
      deployment("prod", "elated-possum-295"),
      deployment("dev", "brave-otter-123"),
    ].join("\n");
    expect(scanText("t.ts", text)).toEqual([
      { path: "t.ts", line: 1, kind: "deployment-desconhecido" },
      { path: "t.ts", line: 2, kind: "deployment-desconhecido" },
    ]);
  });

  it("conta um deployment da lista em custódia só como deployment de teste", () => {
    const denylist = [denyEntry("deployment-teste", "quiet-heron-42")];
    const text = `${deployment("dev", "quiet-heron-42")} ${host("quiet-heron-42")}`;
    expect(kinds(scanText("t.ts", text, { denylist }))).toEqual([
      "deployment-teste",
      "deployment-teste",
    ]);
  });

  it("acha nomes da lista em custódia pelo hash, inclusive quebrados em linhas", () => {
    const denylist = [
      denyEntry("cliente", "Padaria Fictícia"),
      denyEntry("mantenedor", "fulana-de-tal"),
    ];
    const text = "Pedido da PADARIA\nficticia em 01/10.\nAprovado por Fulana de Tal.\n";
    expect(scanText("docs/c.md", text, { denylist })).toEqual([
      { path: "docs/c.md", line: 1, kind: "cliente" },
      { path: "docs/c.md", line: 3, kind: "mantenedor" },
    ]);
    expect(JSON.stringify(denylist)).not.toMatch(/padaria/i);
  });

  it("conta o nome completo uma vez quando o primeiro nome também está na lista", () => {
    const denylist = [denyEntry("mantenedor", "Fulana de Tal"), denyEntry("mantenedor", "Fulana")];
    const text = "Aprovado por Fulana de Tal.\nFulana revisou.\n";
    expect(scanText("docs/c.md", text, { denylist })).toEqual([
      { path: "docs/c.md", line: 1, kind: "mantenedor" },
      { path: "docs/c.md", line: 2, kind: "mantenedor" },
    ]);
  });

  it("recusa nome restrito sem letra nem dígito e lista com entrada inválida", () => {
    expect(() => denyEntry("cliente", "— · —")).toThrow(/sem letra nem dígito/);
    const dir = mkdtempSync(join(tmpdir(), "public-tree-"));
    try {
      const file = join(dir, "lista.json");
      const valid = denyEntry("cliente", "Padaria Fictícia");
      writeFileSync(file, JSON.stringify({ schema: 1, entries: [valid] }));
      expect(loadDenylist(file)).toEqual([valid]);
      writeFileSync(file, JSON.stringify({ schema: 1, entries: [{ ...valid, words: 0 }] }));
      expect(() => loadDenylist(file)).toThrow(/entrada 0 .*inválida/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("troca por texto só o link Markdown cujo alvo ficou de fora", () => {
    const context = {
      known: (p: string) =>
        ["docs/v1.0/evidence/1/README.md", "docs/historico/a.md", "docs/adr/0001.md"].includes(p),
      included: (p: string) => p === "docs/adr/0001.md",
    };
    const text = [
      "Ver o [recibo de\n05/10](../v1.0/evidence/1/README.md#resultado) e a [ADR](../adr/0001.md).",
      "![tela](../v1.0/evidence/1/README.md) [plano](../historico/a.md) [site](https://x.invalid/a)",
      "[novo](../nao-existe.md)",
    ].join("\n");
    expect(unlinkExcluded("docs/plataforma/a.md", text, context)).toEqual({
      text: [
        "Ver o recibo de\n05/10 e a [ADR](../adr/0001.md).",
        "tela plano [site](https://x.invalid/a)",
        "[novo](../nao-existe.md)",
      ].join("\n"),
      count: 3,
    });
  });

  it("aponta link e referência a caminho que ficou de fora", () => {
    const context = {
      known: (p: string) => ["docs/v1.0/evidence/1/README.md", "docs/adr/0001.md"].includes(p),
      included: (p: string) => p === "docs/adr/0001.md",
      excludedPrefixes: ["docs/v1.0/evidence/"],
    };
    expect(
      kinds(
        scanText(
          "docs/plataforma/a.md",
          "[r](../v1.0/evidence/1/README.md) [d](../adr/0001.md)",
          context,
        ),
      ),
    ).toEqual(["link-excluido"]);
    expect(
      scanText(
        "docs/v1.0/ACCEPTANCE.md",
        "[rodada](evidence/2/README.md#a)\n[ADR](../adr/0001.md) [raiz](/docs) [fora](../../../x.md)",
        context,
      ),
    ).toEqual([{ path: "docs/v1.0/ACCEPTANCE.md", line: 1, kind: "link-quebrado" }]);
    expect(
      kinds(scanText("scripts/a.mjs", `read("docs/v1.0/evidence/1/x.json")`, context)),
    ).toEqual(["referencia-excluida"]);
  });
});

describe("montagem", () => {
  const blob = (text: string) => ({
    object: createHash("sha1").update(text).digest("hex"),
    text,
  });
  const tree = (files: Record<string, string>, modes: Record<string, string> = {}) => {
    const blobs = new Map<string, Buffer>();
    const entries = Object.entries(files).map(([path, text]) => {
      const b = blob(text);
      blobs.set(b.object, Buffer.from(text));
      return { mode: modes[path] ?? "100644", type: "blob", object: b.object, path };
    });
    return { entries, read: (o: string) => blobs.get(o)! };
  };

  it("no repositório público (--checkout), varre tudo o que está versionado, recibos inclusive", () => {
    const { entries, read } = tree({
      "README.md": "# freecorpsNFE\n",
      // O caminho é montado aqui para que este arquivo não leve um caminho local.
      "docs/v1.0/evidence/1/README.md": `recibo de C:\\Users\\${"maria"}\\x\n`,
      "docs/historico/plano.md": "legado\n",
    });
    const result = build({ sha: "abc", entries, read, allow: [], classifyPath: checkoutClass });
    expect(result.files.map((f) => f.path)).toEqual([
      "README.md",
      "docs/historico/plano.md",
      "docs/v1.0/evidence/1/README.md",
    ]);
    expect(result.report.findings.items).toEqual([
      { path: "docs/v1.0/evidence/1/README.md", line: 1, kind: "caminho-local" },
    ]);
  });

  it("copia a seleção, deixa custódia de fora e gera o mesmo manifesto sempre", () => {
    const { entries, read } = tree({
      "README.md": "# freecorpsNFE\n",
      "docs/v1.0/evidence/1/README.md": "recibo\n",
      "docs/historico/plano.md": "legado\n",
      "apps/console/src/a.ts": "export const a = 1;\n",
    });
    const first = build({ sha: "abc", entries, read, allow: [] });
    const second = build({ sha: "abc", entries: [...entries].reverse(), read, allow: [] });
    expect(first.files.map((f) => f.path)).toEqual(["README.md", "apps/console/src/a.ts"]);
    expect(first.manifest).toEqual(second.manifest);
    expect(first.report.status).toBe("pronta para revisão");
    expect(first.report.counts).toEqual({ entra: 2, custódia: 1, sai: 1 });
    expect(first.report.excluded.map((e: { rule: string }) => e.rule)).toEqual([
      "docs/historico/",
      "docs/v1.0/evidence/",
    ]);
    expect(first.manifest.files[0]).toEqual({
      path: "README.md",
      class: "entra",
      sha256: createHash("sha256").update("# freecorpsNFE\n").digest("hex"),
      size: 15,
    });
  });

  it("publica sem link para recibo ou histórico e conta as trocas", () => {
    const { entries, read } = tree({
      "docs/plataforma/a.md": "[recibo](../v1.0/evidence/1/README.md) e [b](b.md)\n",
      "docs/plataforma/b.md": "[plano](../historico/plano.md)\n",
      "docs/v1.0/evidence/1/README.md": "recibo\n",
      "docs/historico/plano.md": "legado\n",
    });
    const { files, report } = build({ sha: "abc", entries, read, allow: [] });
    expect(Object.fromEntries(files.map((f) => [f.path, f.bytes.toString()]))).toEqual({
      "docs/plataforma/a.md": "recibo e [b](b.md)\n",
      "docs/plataforma/b.md": "plano\n",
    });
    expect(report.transforms).toEqual({ edits: 0, unlinked: 2, unlinkedFiles: 2, formatted: 0 });
    expect(report.findings.byKind).toEqual({});
    expect(report.status).toBe("pronta para revisão");
  });

  it("só desfaz link em arquivo .md ou .mdx, não em nome que só termina em md", () => {
    const text = "[plano](../docs/historico/plano.md)\n";
    const { entries, read } = tree({
      "scripts/run.cmd": text,
      "apps/docs/content/docs/a.mdx": "[plano](../../../../docs/historico/plano.md)\n",
      "docs/historico/plano.md": "legado\n",
    });
    const { files, report } = build({ sha: "abc", entries, read, allow: [] });
    expect(Object.fromEntries(files.map((f) => [f.path, f.bytes.toString()]))).toEqual({
      "apps/docs/content/docs/a.mdx": "plano\n",
      "scripts/run.cmd": text,
    });
    expect(report.transforms.unlinked).toBe(1);
  });

  it("formata só o que a montagem mudou, antes do hash e da varredura", () => {
    const { entries, read } = tree({
      "docs/plataforma/a.md": "[recibo](../v1.0/evidence/1/README.md)\n",
      "docs/plataforma/b.md": "*  intocado\n",
      "docs/v1.0/evidence/1/README.md": "recibo\n",
    });
    // Um achado que só o texto formatado tem: a varredura precisa vê-lo.
    const localPath = ["", "home", "fulana", "x"].join("/");
    const seen: string[][] = [];
    const format = (texts: Map<string, string>) => {
      seen.push([...texts.keys()]);
      return new Map([...texts].map(([path, text]) => [path, `${text}${localPath}\n`]));
    };
    const { files, manifest, report } = build({ sha: "abc", entries, read, allow: [], format });
    expect(seen).toEqual([["docs/plataforma/a.md"]]);
    const a = files.find((f) => f.path === "docs/plataforma/a.md")!;
    expect(a.bytes.toString()).toBe(`recibo\n${localPath}\n`);
    expect(manifest.files.find((f) => f.path === a.path)!.sha256).toBe(
      createHash("sha256").update(a.bytes).digest("hex"),
    );
    expect(files.find((f) => f.path === "docs/plataforma/b.md")!.bytes.toString()).toBe(
      "*  intocado\n",
    );
    expect(report.transforms.formatted).toBe(1);
    expect(report.findings.items).toEqual([
      { path: "docs/plataforma/a.md", line: 2, kind: "caminho-local" },
    ]);
  });

  it("sai, com o oxfmt e o bloco fmt do checkout, aprovada no fmt --check", async () => {
    const root = repoRoot;
    const config = await loadFmtConfig(root);
    const format = oxfmtFormatter(root, config);
    const table = (cell: string) =>
      `| Item | Onde |\n| ${"-".repeat(4)} | ${"-".repeat(Math.max(4, cell.length))} |\n| a    | ${cell} |\n`;
    const link = "[recibo](../v1.0/evidence/1/README.md)";
    const { entries, read } = tree({
      "docs/plataforma/a.md": table(link),
      ".agents/skills/x/SKILL.md":
        "[recibo](../../../docs/v1.0/evidence/1/README.md)\n\n*  lista\n",
      "docs/v1.0/evidence/1/README.md": "recibo\n",
    });
    const { files, report } = build({ sha: "abc", entries, read, allow: [], format });
    // A tabela perdeu largura com o link desfeito; sem formatar, o --check reprova.
    expect(report.transforms).toMatchObject({ unlinked: 2, formatted: 1 });
    // `.agents/**` está no ignorePatterns: sai com a formatação de origem.
    expect(files.find((f) => f.path === ".agents/skills/x/SKILL.md")!.bytes.toString()).toBe(
      "recibo\n\n*  lista\n",
    );
    const dir = mkdtempSync(join(tmpdir(), "public-tree-fmt-check-"));
    try {
      writeFileSync(join(dir, ".oxfmtrc.json"), JSON.stringify(config));
      for (const file of files) {
        mkdirSync(dirname(join(dir, file.path)), { recursive: true });
        writeFileSync(join(dir, file.path), file.bytes);
      }
      const check = (path: string) =>
        spawnSync(process.execPath, [format.bin, "--check", "-c", ".oxfmtrc.json", path], {
          cwd: dir,
          encoding: "utf8",
        });
      expect(check("docs/plataforma/a.md").status).toBe(0);
      // A mesma tabela, desfeita sem formatar, reprova: a prova enxerga o desalinhamento.
      writeFileSync(join(dir, "docs/plataforma/a.md"), table("recibo"));
      expect(check("docs/plataforma/a.md").status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("formata igual com um .editorconfig numa pasta acima da temporária", async () => {
    const root = repoRoot;
    const config = await loadFmtConfig(root);
    const format = oxfmtFormatter(root, config);
    const { entries, read } = tree({
      "docs/plataforma/a.md": "[recibo](../v1.0/evidence/1/README.md)\n\n*  lista\n",
      "packages/x/a.ts": "export const antigo = { b: 1, c: [1, 2, 3] };\n",
      "docs/v1.0/evidence/1/README.md": "recibo\n",
    });
    const edit = {
      path: "packages/x/a.ts",
      find: /antigo/,
      replace: "a",
      reason: "teste",
      count: 1,
    };
    const assemble = () =>
      build({ sha: "abc", entries, read, editList: [edit], allow: [], format });
    const expected = assemble();
    expect(expected.report.transforms.formatted).toBe(1);
    const hostile = mkdtempSync(join(tmpdir(), "public-tree-editorconfig-"));
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    try {
      writeFileSync(
        join(hostile, ".editorconfig"),
        "root = true\n[*]\nindent_style = tab\nindent_size = 8\nmax_line_length = 20\n",
      );
      const inner = join(hostile, "temp");
      mkdirSync(inner);
      // Sem a raiz na pasta da formatação, esse .editorconfig muda o resultado.
      writeFileSync(join(inner, ".oxfmtrc.json"), JSON.stringify(config));
      writeFileSync(join(inner, "a.ts"), "export const a = { b: 1, c: [1, 2, 3] };\n");
      spawnSync(process.execPath, [format.bin, "--write", "-c", ".oxfmtrc.json", "a.ts"], {
        cwd: inner,
      });
      expect(readFileSync(join(inner, "a.ts"), "utf8")).toContain("\tb: 1,");
      Object.assign(process.env, { TMPDIR: inner, TEMP: inner, TMP: inner });
      expect(tmpdir()).toBe(inner);
      expect(assemble().manifest).toEqual(expected.manifest);
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      rmSync(hostile, { recursive: true, force: true });
    }
  }, 60_000);

  it("lê a versão do oxfmt fixada no bun.lock", () => {
    const lock = readFileSync(fileURLToPath(new URL("bun.lock", repoUrl)), "utf8");
    const version = lockedOxfmtVersion(lock);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock).toContain(`"oxfmt": "=${version}"`);
    expect(
      lockedOxfmtVersion('{\n  "packages": {\n    "oxfmt": ["oxfmt@0.1.0", ""],\n  }\n}\n'),
    ).toBe("0.1.0");
    expect(lockedOxfmtVersion('{ "packages": {} }')).toBeNull();
  });

  it("aplica as edições em custódia como texto literal e recusa entrada inválida", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-tree-"));
    try {
      const file = join(dir, "edicoes.json");
      const entry = {
        path: "docs/plataforma/a.md",
        find: "por `fulana-de-tal` (a.b)",
        replace: "pela mantenedora $&",
        count: 1,
        reason: "teste",
      };
      writeFileSync(file, JSON.stringify({ schema: 1, edits: [entry] }));
      const editList = loadRestrictedEdits(file);
      const { entries, read } = tree({
        "docs/plataforma/a.md": "Aprovada por `fulana-de-tal` (a.b). Por `fulana-de-tal` (axb).\n",
      });
      const { files, report } = build({ sha: "abc", entries, read, editList, allow: [] });
      expect(files[0].bytes.toString()).toBe(
        "Aprovada pela mantenedora $&. Por `fulana-de-tal` (axb).\n",
      );
      expect(report.transforms.edits).toBe(1);
      expect(report.editProblems).toEqual([]);
      for (const invalid of [
        { ...entry, count: 0 },
        { ...entry, find: "" },
        { path: entry.path },
      ]) {
        writeFileSync(file, JSON.stringify({ schema: 1, edits: [invalid] }));
        expect(() => loadRestrictedEdits(file)).toThrow(/edição 0 .*inválida/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bloqueia caminho sem classificação e achado aberto", () => {
    const { entries, read } = tree({
      "novo/a.ts": "x\n",
      "docs/plataforma/a.md": email("cliente", "gmail.com"),
    });
    const { report } = build({ sha: "abc", entries, read, allow: [] });
    expect(report.status).toBe("bloqueada");
    expect(report.unclassified).toEqual(["novo/a.ts"]);
    expect(report.findings.byKind).toEqual({ "email-externo": 1 });
  });

  it("conserva as flags da expressão da edição", () => {
    const { entries, read } = tree({ "docs/plataforma/a.md": "Nome Antigo, NOME ANTIGO\n" });
    const edit = {
      path: "docs/plataforma/a.md",
      find: /nome antigo/i,
      replace: "nome novo",
      reason: "teste",
      count: 2,
    };
    const { files, report } = build({ sha: "abc", entries, read, editList: [edit], allow: [] });
    expect(report.editProblems).toEqual([]);
    expect(files[0].bytes.toString()).toBe("nome novo, nome novo\n");
  });

  it("bloqueia exceção de segredo sem a ocorrência que descreve", () => {
    const allow = { rule: "private-key", count: 1, reason: "teste" };
    const withKey = tree({ "scripts/a.test.ts": `"${privateKeyHeader}"\n` });
    const covered = build({
      sha: "abc",
      ...withKey,
      allow: [],
      secretAllow: [{ ...allow, path: "scripts/a.test.ts" }],
    });
    expect(covered.report.status).toBe("pronta para revisão");
    const withoutKey = tree({ "scripts/a.test.ts": "sem chave\n" });
    const stale = build({
      sha: "abc",
      ...withoutKey,
      allow: [],
      // A exceção de um arquivo fora da árvore pública não vale aqui.
      secretAllow: [
        { ...allow, path: "scripts/a.test.ts" },
        { ...allow, path: "docs/v1.0/evidence/x.md" },
      ],
    });
    expect(stale.report.status).toBe("bloqueada");
    expect(stale.report.findings.staleAllowlist).toEqual([
      { path: "scripts/a.test.ts", kind: "segredo", rule: "private-key", count: 1 },
    ]);
  });

  it("sem a lista de nomes, não julga obsoletas as exceções de nomes", () => {
    const files = tree({ "docs/c.md": "Aprovado por Fulana de Tal.\n" });
    const allow = [{ path: "docs/c.md", kind: "mantenedor", count: 1, reason: "teste" }];
    const denylist = [denyEntry("mantenedor", "Fulana de Tal")];
    expect(
      build({ sha: "abc", classifyPath: checkoutClass, ...files, allow, denylist }).report.status,
    ).toBe("pronta para revisão");
    // PR de fork e hook pre-push: os nomes não são procurados.
    expect(
      build({ sha: "abc", classifyPath: checkoutClass, ...files, allow }).report.findings
        .staleAllowlist,
    ).toEqual([]);
    // Com a lista, a exceção sem a ocorrência continua obsoleta.
    const without = tree({ "docs/c.md": "Aprovado pelo mantenedor.\n" });
    expect(
      build({ sha: "abc", classifyPath: checkoutClass, ...without, allow, denylist }).report.status,
    ).toBe("bloqueada");
  });

  it("conta por arquivo os e-mails dispensados de licença e de função", () => {
    const { entries, read } = tree({
      "LICENSES/MIT.txt": `${email("autor", "gmail.com")} ${email("outra", "gmail.com")}\n`,
      "docs/plataforma/a.md": `${email("privacidade", "nfe.freecorps.com.br")}\n`,
    });
    const { report } = build({ sha: "abc", entries, read, allow: [] });
    expect(report.status).toBe("pronta para revisão");
    expect(report.findings.byKind).toEqual({});
    expect(report.findings.waived).toEqual({
      "email-licenca": { "LICENSES/MIT.txt": 2 },
      "email-funcao-freecorps": { "docs/plataforma/a.md": 1 },
    });
  });

  it("aplica a edição definida e falha quando a contagem não confere", () => {
    const { entries, read } = tree({ "docs/plataforma/a.md": "nome antigo, nome antigo\n" });
    const edit = {
      path: "docs/plataforma/a.md",
      find: /nome antigo/,
      replace: "nome novo",
      reason: "teste",
    };
    const ok = build({ sha: "abc", entries, read, editList: [{ ...edit, count: 2 }] });
    expect(ok.files[0].bytes.toString()).toBe("nome novo, nome novo\n");
    const stale = build({ sha: "abc", entries, read, editList: [{ ...edit, count: 1 }] });
    expect(stale.report.status).toBe("bloqueada");
    expect(stale.report.editProblems).toEqual([
      { path: "docs/plataforma/a.md", reason: "teste", expected: 1, found: 2 },
    ]);
  });

  it("registra links simbólicos com o alvo quando o alvo também entra", () => {
    const { entries, read } = tree(
      { ".claude/skills/a": "../../.agents/skills/a", ".agents/skills/a/SKILL.md": "# a\n" },
      { ".claude/skills/a": "120000" },
    );
    const { manifest, report } = build({ sha: "abc", entries, read, allow: [] });
    expect(manifest.symlinks).toEqual([
      { path: ".claude/skills/a", target: "../../.agents/skills/a" },
    ]);
    expect(report.findings.byKind).toEqual({});
    expect(report.status).toBe("pronta para revisão");
  });

  it.each([
    ["na custódia", "../../docs/v1.0/evidence/1"],
    ["fora da raiz", "../../../fora"],
    ["absoluto", "/etc/hosts"],
    ["absoluto no Windows", "C:/Windows/win.ini"],
    ["quebrado", "../../.agents/skills/inexistente"],
  ])("bloqueia link simbólico com alvo %s", (_, target) => {
    const { entries, read } = tree(
      {
        ".claude/skills/a": target,
        ".agents/skills/a/SKILL.md": "# a\n",
        "docs/v1.0/evidence/1/README.md": "recibo\n",
      },
      { ".claude/skills/a": "120000" },
    );
    const { report } = build({ sha: "abc", entries, read, allow: [] });
    expect(report.findings.items).toEqual([
      { path: ".claude/skills/a", line: 1, kind: "link-simbolico-invalido" },
    ]);
    expect(report.status).toBe("bloqueada");
  });

  it("varre o texto do alvo do link simbólico", () => {
    const user = ["mar", "ia"].join("");
    const { entries, read } = tree(
      { ".claude/skills/a": `C:/Users/${user}/repo` },
      { ".claude/skills/a": "120000" },
    );
    const { report } = build({ sha: "abc", entries, read, allow: [] });
    expect(kinds(report.findings.items)).toEqual(["caminho-local", "link-simbolico-invalido"]);
  });
});

describe("CPF sem máscara, produtos da Freecorps e Gitleaks", () => {
  // CPF fictício com DV válido, montado no teste para não ficar no texto.
  const cpfWithDv = (base: string) => {
    const dv = (digits: string) => {
      let sum = 0;
      for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * (digits.length + 1 - i);
      const rest = (sum * 10) % 11;
      return rest === 10 ? 0 : rest;
    };
    const first = dv(base);
    return `${base}${first}${dv(base + first)}`;
  };

  it("acusa CPF sem máscara isolado, mas não dentro de hash, id ou número maior", () => {
    const cpf = cpfWithDv("483920175");
    expect(validCpf(cpf)).toBe(true);
    const text = [
      `titular ${cpf}`,
      `sintético 52998224725`,
      `hash a${cpf}b`,
      `id-${cpf}`,
      `timestamp ${cpf}12`,
      `caminho /x/${cpf}`,
    ].join("\n");
    expect(scanText("docs/a.md", text)).toEqual([
      { path: "docs/a.md", line: 1, kind: "cpf-nao-sintetico" },
    ]);
  });

  it("acusa o nome de outro produto da Freecorps da lista em custódia", () => {
    const denylist = [denyEntry("produto-freecorps", "Produto Fictício")];
    expect(scanText("docs/a.md", "o produto ficticio consome a API\n", { denylist })).toEqual([
      { path: "docs/a.md", line: 1, kind: "produto-freecorps" },
    ]);
  });

  it("lê o relatório do Gitleaks sem o valor e bloqueia o que passa da exceção", () => {
    const leaks = parseGitleaks(
      [
        {
          File: "C:\\out\\arvore\\a.ts",
          StartLine: 3,
          RuleID: "generic-api-key",
          Secret: "REDACTED",
        },
        { File: "/out/arvore/b.ts", StartLine: 7, RuleID: "private-key", Match: "REDACTED" },
      ],
      "C:\\out\\arvore",
    );
    expect(leaks).toEqual([
      { path: "a.ts", line: 3, rule: "generic-api-key" },
      { path: "/out/arvore/b.ts", line: 7, rule: "private-key" },
    ]);
    const report = () => ({
      status: "pronta para revisão",
      findings: { byKind: {}, allowed: 0, staleAllowlist: [] as object[], items: [] as object[] },
    });
    const allow = [{ path: "a.ts", rule: "generic-api-key", count: 1, reason: "teste" }];
    const one = [{ path: "a.ts", line: 3, rule: "generic-api-key" }];
    expect(applyGitleaks(report(), one, allow)).toMatchObject({
      status: "pronta para revisão",
      findings: { allowed: 1, items: [] },
      gitleaks: { findings: 1, open: 0 },
    });
    const blocked = applyGitleaks(
      report(),
      [...one, { path: "a.ts", line: 9, rule: "generic-api-key" }],
      allow,
    );
    expect(blocked.status).toBe("bloqueada");
    expect(blocked.findings.items).toHaveLength(2);
    expect(blocked.findings.byKind).toEqual({ "segredo-gitleaks": 2 });
    expect(applyGitleaks(report(), [], allow)).toMatchObject({
      status: "bloqueada",
      findings: {
        staleAllowlist: [{ path: "a.ts", kind: "segredo-gitleaks", rule: "generic-api-key" }],
      },
    });
  });
});

describe("exceções", () => {
  it("cobrem o número exato de ocorrências", () => {
    const f = (line: number) => ({ path: "a.xsd", line, kind: "email-externo" });
    const allow = [{ path: "a.xsd", kind: "email-externo", count: 1, reason: "teste" }];
    expect(applyAllowlist([f(1)], allow)).toEqual({ open: [], allowed: 1, stale: [] });
    expect(applyAllowlist([f(1), f(2)], allow).open).toHaveLength(2);
    expect(applyAllowlist([], allow).stale).toEqual(allow);
  });
});

describe("linha de comando", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/public-copy/public-tree.mjs", ...args], { encoding: "utf8" });

  it("diz na ajuda que só roda no repositório privado", () => {
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Roda só no repositório privado");
  });

  it("recusa --sem-gitleaks junto com --gitleaks", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-tree-"));
    try {
      const result = run(
        "--checkout",
        "--sem-gitleaks",
        "--gitleaks",
        "gitleaks",
        "--sha",
        "HEAD",
        "--out",
        join(dir, "saida"),
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--sem-gitleaks não combina com --gitleaks");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa saída que é um arquivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-tree-"));
    try {
      const file = join(dir, "arquivo");
      writeFileSync(file, "x");
      const result = run("--sha", "HEAD", "--out", file);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("não é uma pasta");
      expect(result.stderr).not.toContain("    at ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa montar sem as edições em custódia", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-tree-"));
    try {
      const denylist = join(dir, "lista.json");
      writeFileSync(denylist, JSON.stringify({ schema: 1, entries: [] }));
      const result = run(
        "--sha",
        "HEAD",
        "--out",
        join(dir, "saida"),
        "--denylist",
        denylist,
        "--edits",
        join(dir, "ausente.json"),
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("edições restritas ausentes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Um commit de HEAD com os arquivos trocados, gravado num banco de objetos
  // temporário que enxerga o do repositório: o .git não ganha objeto.
  const runOnCommit = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "public-tree-commit-"));
    try {
      const objects = execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
        { encoding: "utf8" },
      ).trim();
      // Pelo arquivo, não pela variável, que separa por `:` e quebra `C:/`.
      mkdirSync(join(dir, "objects", "info"), { recursive: true });
      writeFileSync(join(dir, "objects", "info", "alternates"), `${objects}\n`);
      const env = {
        ...process.env,
        GIT_OBJECT_DIRECTORY: join(dir, "objects"),
        GIT_INDEX_FILE: join(dir, "index"),
        GIT_AUTHOR_NAME: "teste",
        GIT_AUTHOR_EMAIL: "teste@example.com",
        GIT_COMMITTER_NAME: "teste",
        GIT_COMMITTER_EMAIL: "teste@example.com",
      };
      const git = (args: string[], input?: string) =>
        execFileSync("git", args, { encoding: "utf8", input, env }).trim();
      git(["read-tree", "HEAD"]);
      for (const [path, text] of Object.entries(files))
        git([
          "update-index",
          "--cacheinfo",
          `100644,${git(["hash-object", "-w", "--stdin"], text)},${path}`,
        ]);
      const commit = git(["commit-tree", git(["write-tree"]), "-p", "HEAD", "-m", "teste"]);
      return spawnSync(
        process.execPath,
        ["scripts/public-copy/public-tree.mjs", "--sha", commit, "--out", join(dir, "saida")],
        { encoding: "utf8", env },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const checkout = (path: string) =>
    readFileSync(fileURLToPath(new URL(`${path}`, repoUrl)), "utf8");
  // As recusas abaixo vêm depois das conferências dos arquivos em custódia,
  // que a cópia pública não tem; lá, a montagem para antes, e estes testes
  // não têm o que provar. Com a custódia e sem o commit da auditoria (clone
  // raso), eles falham dizendo que o commit falta, em vez de serem pulados.
  const privateRepo = [DEFAULT_DENYLIST, DEFAULT_RESTRICTED_EDITS].every((path) =>
    existsSync(fileURLToPath(new URL(`${path}`, repoUrl))),
  );

  it.skipIf(!privateRepo)(
    "recusa montar um commit cujo vite.config.ts difere do checkout",
    () => {
      const result = runOnCommit({ "vite.config.ts": `${checkout("vite.config.ts")}// outro\n` });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("o vite.config.ts do checkout difere");
    },
    120_000,
  );

  it.skipIf(!privateRepo)(
    "recusa formatar com um oxfmt diferente do fixado no bun.lock do commit",
    () => {
      const lock = checkout("bun.lock");
      const installed = lockedOxfmtVersion(lock)!;
      const result = runOnCommit({
        "vite.config.ts": checkout("vite.config.ts"),
        "bun.lock": lock.replace(`"oxfmt": ["oxfmt@${installed}"`, '"oxfmt": ["oxfmt@0.0.1"'),
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`o oxfmt instalado é ${installed}`);
      expect(result.stderr).toContain("fixa 0.0.1");
    },
    120_000,
  );

  it("recusa saída dentro do repositório", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/public-copy/public-tree.mjs", "--sha", "HEAD", "--out", join("node_modules", ".public-tree")],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("dentro do repositório");
  });
});
