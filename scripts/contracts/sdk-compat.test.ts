import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  compareSdk,
  declarationFiles,
  publicationRecord,
  readPublished,
  sha256,
  versionFailures,
} from "../lib/sdk-compat.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

const root = repoRoot;
const { published } = readPublished(root);
const copy = resolve(root, published.declarations);
const compatPath = resolve(root, "packages/sdk/compat.ts");
const entries = published.entries as Record<string, string>;
const previous = Object.fromEntries(
  Object.entries(entries).map(([entry, path]) => [entry, join(copy, path)]),
);

// A fixture is the published copy with edits, served in memory at a path that does not exist,
// inside packages/sdk so that "zod" resolves as it does for the real copy.
// `changeBefore` edits the published side too, for shapes the real 0.1.0 does not have.
function fixture(
  change: (files: Map<string, string>) => void,
  changeBefore?: (files: Map<string, string>) => void,
) {
  const overlay = new Map<string, string>();
  const side = (name: string, edit: (files: Map<string, string>) => void) => {
    const directory = resolve(root, "packages/sdk/published", name);
    const files = new Map(
      declarationFiles(copy).map(({ path, bytes }) => [path, Buffer.from(bytes).toString("utf8")]),
    );
    edit(files);
    for (const [path, text] of files) overlay.set(join(directory, path), text);
    return Object.fromEntries(
      Object.entries(entries).map(([entry, path]) => [entry, join(directory, path)]),
    );
  };
  return compareSdk({
    previous: changeBefore ? side("fixture-before", changeBefore) : previous,
    next: side("fixture", change),
    compatPath,
    overlay,
  });
}

const edit = (files: Map<string, string>, path: string, from: string, to: string) => {
  const text = files.get(path)!;
  const next = text.replace(from, to);
  if (next === text) throw new Error(`Fixture sem efeito em ${path}`);
  files.set(path, next);
};
const index = "types/sdk/src/index.d.ts";
const webhooks = "types/sdk/src/webhooks.d.ts";
const contractWebhooks = "types/contracts/src/webhooks.d.ts";
// The published index imports and re-exports the route types from the contract; a fixture
// replaces both with local declarations built on top of them.
const routeTypes = (files: Map<string, string>, declarations: string[]) => {
  edit(
    files,
    index,
    'import { type RouteName, type RequestOf, type ResponseOf } from "../../contracts/src/external.js";\n',
    'import type { RouteName as BaseRoute, RequestOf as BaseRequest, ResponseOf as BaseResponse } from "../../contracts/src/external.js";\n' +
      declarations.join("\n") +
      "\n",
  );
  edit(
    files,
    index,
    'export type { RouteName, RequestOf, ResponseOf } from "../../contracts/src/external.js";\n',
    "",
  );
};
type Change = { subject: string; change: string; detail: string };
const subjects = (changes: Change[], kinds: string[]) =>
  changes.filter((c) => kinds.includes(c.change)).map((c) => c.subject);
const breaks = (changes: Change[]) =>
  changes.filter((c) => c.change === "breaking" || c.change === "removed");

describe("SDK compatibility gate against the published version (#135)", () => {
  it("records 0.1.0 with the accepted tarball and an unchanged copy of its declarations", () => {
    expect(published).toMatchObject({
      version: "0.1.0",
      contractVersion: "8.0.0",
      tarballSha256: "36c29407c77216f798aeb73601020554c51fb8bcf5c8a41f2cb80b6c72ba5159",
      accepted: "docs/v1.0/evidence/73/2026-11-03/accepted.json",
    });
  });

  // The current tree against the record runs in `ci:sdk` (bun run sdk:compat), without cache.
  it("classifies an untouched copy as equal, comparing every route", () => {
    const result = fixture(() => {});
    expect(result.changes).toEqual([]);
    expect(result.classification).toBe("equal");
    expect(result.checks).toBeGreaterThan(100);
  });

  it("names each broken route, symbol and member", () => {
    const result = fixture((files) => {
      routeTypes(files, [
        'export type RouteName = Exclude<BaseRoute, "revokeExport">;',
        'export type RequestOf<K extends RouteName> = K extends "createExport" ? BaseRequest<K> & { extra: string } : BaseRequest<K>;',
        'export type ResponseOf<K extends RouteName> = K extends "getExport" ? { data: null; requestId: string } : BaseResponse<K>;',
      ]);
      edit(
        files,
        index,
        "    downloadDanfe(input: {\n        documentId: string;\n        companyId: string;\n    }, signal?: AbortSignal): Promise<Uint8Array>;\n",
        "",
      );
      edit(files, index, "    apiKey: string;\n", "    apiKey: string;\n    region: string;\n");
      edit(files, webhooks, "{ verifyWebhook, ", "{ ");
    });
    expect(result.classification).toBe("breaking");
    expect(subjects(result.changes, ["removed"])).toEqual(
      expect.arrayContaining([
        "rota revokeExport",
        ". FreecorpsClient.downloadDanfe",
        ". verifyWebhook",
        "./webhooks verifyWebhook",
      ]),
    );
    expect(subjects(result.changes, ["breaking"])).toEqual(
      expect.arrayContaining([
        "rota createExport (entrada)",
        "rota getExport (resposta)",
        ". ClientOptions",
        ". FreecorpsClient (construtor)",
      ]),
    );
    // The untouched routes keep passing.
    const named = result.changes.map((c) => c.subject);
    expect(named).not.toContain("rota getExport (entrada)");
    expect(named).not.toContain("rota createExport (resposta)");
    expect(named).not.toContain("rota exportParts (resposta)");
  });

  it("compares what call<route> takes and returns, not only the exported route types", () => {
    const result = fixture((files) =>
      edit(
        files,
        index,
        "options?: CallOptions): Promise<ResponseOf<K>>;",
        'options?: CallOptions): Promise<ResponseOf<K>["data"]>;',
      ),
    );
    expect(result.classification).toBe("breaking");
    expect(subjects(result.changes, ["breaking"])).toContain("rota getExport (resposta)");
    expect(subjects(result.changes, ["breaking"])).not.toContain("rota getExport (entrada)");
  });

  it("treats a removed optional field as a break and a new optional field as additive", () => {
    const removed = fixture((files) => edit(files, index, "    timeoutMs?: number;\n", ""));
    expect(breaks(removed.changes)).toContainEqual({
      subject: ". ClientOptions",
      change: "breaking",
      detail: "campo timeoutMs removido",
    });
    const added = fixture((files) =>
      edit(
        files,
        contractWebhooks,
        "    eventId: string;\n",
        "    eventId: string;\n    note?: string;\n",
      ),
    );
    expect(breaks(added.changes)).toEqual([]);
    expect(subjects(added.changes, ["additive"])).toEqual(
      expect.arrayContaining([". WebhookEnvelope", "./webhooks WebhookEnvelope"]),
    );
    expect(added.classification).toBe("additive");
  });

  it("names fields lost inside a route, even when the object is left empty", () => {
    const external = "types/contracts/src/external.d.ts";
    const result = fixture((files) => {
      edit(
        files,
        external,
        "exportId: z.ZodString;\n            }, z.core.$strict>;\n            query: z.ZodObject<{\n                cursor: z.ZodOptional<z.ZodString>;\n                limit: z.ZodOptional<z.ZodNumber>;\n            }, z.core.$strict>;",
        "exportId: z.ZodString;\n            }, z.core.$strict>;\n            query: z.ZodObject<{}, z.core.$strict>;",
      );
      edit(
        files,
        external,
        "sequence: z.ZodNumber;\n                    sha256: z.ZodString;\n                    size: z.ZodNumber;\n",
        "sequence: z.ZodNumber;\n                    sha256: z.ZodString;\n",
      );
    });
    expect(breaks(result.changes)).toEqual(
      expect.arrayContaining([
        {
          subject: "rota exportParts (entrada)",
          change: "breaking",
          detail: "campo RequestOf.query.cursor removido",
        },
        {
          subject: "rota exportParts (entrada)",
          change: "breaking",
          detail: "campo RequestOf.query.limit removido",
        },
        {
          subject: "rota exportParts (resposta)",
          change: "breaking",
          detail: "campo ResponseOf.data.page[].size removido",
        },
      ]),
    );
  });

  it("refuses wider or nullable outputs and lost index signature fields", () => {
    const widened = fixture((files) =>
      edit(
        files,
        contractWebhooks,
        '    environment: "sandbox" | "production";\n',
        '    environment: "sandbox" | "production" | "homologacao";\n',
      ),
    );
    expect(subjects(widened.changes, ["breaking"])).toContain(". WebhookEnvelope");
    const nullable = fixture((files) =>
      edit(files, contractWebhooks, "    eventId: string;\n", "    eventId: string | null;\n"),
    );
    expect(subjects(nullable.changes, ["breaking"])).toContain(". WebhookEnvelope");
    const record = (shape: string) => (files: Map<string, string>) =>
      edit(
        files,
        contractWebhooks,
        '    decidedBy: "owner";\n',
        `    decidedBy: "owner";\n    extra: Record<string, ${shape}>;\n`,
      );
    const index = fixture(record("{ a: string }"), record("{ a: string; b?: string }"));
    expect(breaks(index.changes)).toContainEqual({
      subject: ". HistoryLimitedData",
      change: "breaking",
      detail: "campo extra[*].b removido",
    });
  });

  it("refuses a field widened to any at any depth", () => {
    const result = fixture((files) =>
      edit(files, contractWebhooks, "    eventId: string;\n", "    eventId: any;\n"),
    );
    expect(breaks(result.changes)).toContainEqual({
      subject: ". WebhookEnvelope",
      change: "breaking",
      detail: "campo eventId virou any",
    });
  });

  it("requires an overloaded method to stay identical", () => {
    const result = fixture((files) =>
      edit(
        files,
        index,
        "    upload(ticket: {",
        "    upload(ticket: string, bytes: Uint8Array): Promise<void>;\n    upload(ticket: {",
      ),
    );
    expect(subjects(result.changes, ["breaking"])).toContain(". FreecorpsClient.upload");
  });

  it("refuses declarations that do not compile instead of reading them as any", () => {
    expect(() =>
      fixture((files) =>
        edit(files, contractWebhooks, "    eventId: string;\n", "    eventId: Unknown;\n"),
      ),
    ).toThrow("Declaração com erro");
  });

  it("classifies a new route, symbol, member and a wider input as additive", () => {
    const result = fixture((files) => {
      routeTypes(files, [
        'export type RouteName = BaseRoute | "novaRota";',
        "export type RequestOf<K extends RouteName> = K extends BaseRoute ? BaseRequest<K> : { path: {}; query: {}; body: {} };",
        "export type ResponseOf<K extends RouteName> = K extends BaseRoute ? BaseResponse<K> : { data: string; requestId: string };",
        'export declare const sdkVersion = "0.2.0";',
      ]);
      edit(
        files,
        index,
        '    environment: "sandbox" | "production";\n',
        '    environment: "sandbox" | "production" | "homologacao";\n',
      );
      edit(
        files,
        index,
        "    private binary;\n",
        "    private binary;\n    ping(): Promise<void>;\n    static defaultTimeoutMs: number;\n",
      );
    });
    expect(breaks(result.changes)).toEqual([]);
    expect(result.classification).toBe("additive");
    expect(subjects(result.changes, ["added"])).toEqual(
      expect.arrayContaining([
        "rota novaRota",
        ". sdkVersion",
        ". FreecorpsClient.ping",
        ". FreecorpsClient (estático).defaultTimeoutMs",
      ]),
    );
    expect(subjects(result.changes, ["additive"])).toContain(". ClientOptions");
  });
});

describe("SDK version required by the change", () => {
  const record = { version: "0.1.0", contractVersion: "8.0.0" };
  const check = (version: string, classification: string, contractVersion = "8.0.0") =>
    versionFailures({ published: record, version, contractVersion, classification });

  it("asks nothing of an equal API on the published contract major", () => {
    expect(check("0.1.0", "equal")).toEqual([]);
    expect(check("0.1.0", "equal", "8.3.0")).toEqual([]);
  });

  it("asks a version above the published one for an additive API", () => {
    expect(check("0.1.0", "additive")).toEqual([
      "a API TypeScript mudou de forma compatível: o SDK precisa de versão acima da publicada 0.1.0",
    ]);
    expect(check("0.1.1", "additive")).toEqual([]);
  });

  it("asks a minor above the published 0.x for a break", () => {
    expect(check("0.1.0", "breaking")).toHaveLength(1);
    expect(check("0.1.9", "breaking")[0]).toContain("precisa de 0.2.0 ou acima");
    expect(check("0.2.0", "breaking")).toEqual([]);
  });

  it("refuses contract 9.0.0 with SDK 0.1.x, even with an equal API", () => {
    expect(check("0.1.0", "equal", "9.0.0")).toEqual([
      "o contrato passou de 8.0.0 para 9.0.0: o SDK precisa de 0.2.0 ou acima (está em 0.1.0, publicado 0.1.0)",
    ]);
    expect(check("0.1.4", "additive", "9.0.0")).toHaveLength(1);
    expect(check("0.2.0", "equal", "9.0.0")).toEqual([]);
  });

  it("asks a major from 1.0 on", () => {
    const stable = { version: "1.2.3", contractVersion: "9.0.0" };
    const failures = (version: string) =>
      versionFailures({
        published: stable,
        version,
        contractVersion: "9.0.0",
        classification: "breaking",
      });
    expect(failures("1.9.0")[0]).toContain("precisa de 2.0.0 ou acima");
    expect(failures("2.0.0")).toEqual([]);
  });

  it("refuses a version or contract below the published one and a malformed version", () => {
    expect(check("0.0.9", "equal")).toEqual(["versão 0.0.9 abaixo da publicada 0.1.0"]);
    expect(check("0.1.0", "equal", "7.0.0")).toEqual(["contrato 7.0.0 abaixo do publicado 8.0.0"]);
    expect(() => check("0.2.0-beta.1", "equal")).toThrow("Versão inválida");
  });
});

// A gzipped ustar archive, as npm and Bun write it, for the record tests.
function tarball(files: [string, string][]) {
  const blocks: Buffer[] = [];
  for (const [name, text] of files) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\u000000", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe("recording a publication", () => {
  const contents = (version: string, extra: [string, string][] = []): [string, string][] => [
    [
      "package/package.json",
      JSON.stringify({
        name: "@freecorps/freecorpsnfe-sdk",
        version,
        exports: { ".": { types: "./types/sdk/src/index.d.ts", import: "./index.js" } },
      }),
    ],
    ["package/index.js", "export {};\n"],
    ["package/types/sdk/src/index.d.ts", "export declare const x: 1;\n"],
    ["package/types/contracts/src/external.d.ts", 'export declare const apiVersion = "9.0.0";\n'],
    ...extra,
  ];
  const acceptedPath = "docs/v1.0/evidence/135/2026-11-12/accepted.json";
  const accept = (bytes: Buffer, version = "0.2.0") => ({
    codeSha: "a".repeat(40),
    packages: [{ name: "@freecorps/freecorpsnfe-sdk", version, sha256: sha256(bytes) }],
  });
  const record = (bytes: Buffer, accepted = accept(bytes), current?: unknown) =>
    publicationRecord({
      tarball: bytes,
      accepted,
      acceptedPath,
      publishedAt: "2026-11-12T10:00:00Z",
      current,
    });

  it("copies only the declarations of the accepted bytes and reads the contract from them", () => {
    const bytes = tarball(contents("0.2.0"));
    const { files, record: result } = record(bytes);
    expect(files.map((f) => f.path).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "types/contracts/src/external.d.ts",
      "types/sdk/src/index.d.ts",
    ]);
    expect(result.published).toMatchObject({
      version: "0.2.0",
      contractVersion: "9.0.0",
      publishedAt: "2026-11-12T10:00:00.000Z",
      tarballSha256: sha256(bytes),
      accepted: acceptedPath,
      declarations: "packages/sdk/published/0.2.0",
      entries: { ".": "types/sdk/src/index.d.ts" },
    });
  });

  it("refuses other bytes, a manifest that disagrees and a lower version", () => {
    const bytes = tarball(contents("0.2.0"));
    expect(() => record(bytes, accept(tarball(contents("0.2.1"))))).toThrow("não é o aceito");
    const other = tarball(contents("0.3.0"));
    expect(() => record(other, accept(other, "0.2.0"))).toThrow("difere do aceite");
    expect(() => record(bytes, accept(bytes), { published: { version: "0.3.0" } })).toThrow(
      "abaixo da registrada",
    );
  });

  it("refuses unsafe paths in the tarball", () => {
    const bytes = tarball(contents("0.2.0", [["package/types/../../escape.d.ts", "x"]]));
    expect(() => record(bytes)).toThrow("Caminho de tarball inválido");
  });
});

describe("published SDK record", () => {
  const temporary = mkdtempSync(join(tmpdir(), "sdk-published-"));
  afterAll(() => rmSync(temporary, { recursive: true, force: true }));
  const stage = (mutate: (record: any) => void, tamper = false) => {
    const target = mkdtempSync(join(temporary, "root-"));
    for (const path of ["packages/sdk/published.json", published.accepted, published.declarations])
      cpSync(resolve(root, path), join(target, path), { recursive: true });
    const record = JSON.parse(readFileSync(join(target, "packages/sdk/published.json"), "utf8"));
    mutate(record);
    writeFileSync(join(target, "packages/sdk/published.json"), JSON.stringify(record));
    if (tamper) {
      const file = join(target, published.declarations, entries["."]);
      writeFileSync(file, readFileSync(file, "utf8") + "export declare const extra: 1;\n");
    }
    return () => readPublished(target);
  };

  it("accepts an untouched copy", () => {
    expect(stage(() => {})().published.version).toBe("0.1.0");
  });

  it("refuses an edited declarations copy", () => {
    expect(stage(() => {}, true)).toThrow("cópia das declarações difere do registro");
  });

  it("refuses a tarball hash or version that the acceptance record does not hold", () => {
    expect(stage((r) => (r.published.tarballSha256 = "0".repeat(64)))).toThrow("aceite");
    expect(stage((r) => (r.published.version = "0.1.1"))).toThrow("aceite");
  });

  it("refuses paths outside the declarations copy", () => {
    expect(stage((r) => (r.published.declarations = "packages/sdk/src"))).toThrow(
      "diretório de declarações inválido",
    );
    expect(stage((r) => (r.published.entries["."] = "types/../../src/index.d.ts"))).toThrow(
      "entrada inválida",
    );
  });
});
