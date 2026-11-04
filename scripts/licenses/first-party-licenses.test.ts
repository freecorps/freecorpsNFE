import { describe, expect, it } from "vite-plus/test";
import {
  assertMitSources,
  assertSdkDeclarations,
  assertDeclaredMitScope,
} from "../lib/first-party-licenses.mjs";

describe("fronteira MIT do cliente SDK", () => {
  it("recusa cabeçalho próprio MIT que ampliaria a concessão sem atualizar a lista", () => {
    const own =
      "// SPDX-License-Identifier: MIT\n// Copyright (c) 2026 FREECORPS TECNOLOGIA DA INFORMACAO LTDA\n";
    expect(() => assertDeclaredMitScope("packages/fiscal-core/src/index.ts", own)).toThrow(
      "fora da lista",
    );
    expect(() => assertDeclaredMitScope("packages/sdk/src/index.ts", own)).not.toThrow();
    expect(() =>
      assertDeclaredMitScope(
        "third-party.ts",
        "// SPDX-License-Identifier: MIT\n// Copyright Another Author",
      ),
    ).not.toThrow();
  });
  it("aceita cliente e contratos externos sem abrir o motor", () => {
    expect(() =>
      assertMitSources(["packages/sdk/src/index.ts", "packages/contracts/src/external.ts"]),
    ).not.toThrow();
    expect(() =>
      assertSdkDeclarations(["types/sdk/src/index.d.ts", "types/contracts/src/webhooks.d.ts"]),
    ).not.toThrow();
  });
  it.each([
    "packages/fiscal-core/src/index.ts",
    "packages/fiscal-nfe/src/index.ts",
    "packages/contracts/src/documents.ts",
    "platform/convex/documents.ts",
    "node_modules/zod/index.js",
  ])("recusa incorporar fonte fora da concessão MIT: %s", (path) => {
    expect(() => assertMitSources([path])).toThrow("fora do escopo MIT");
  });
  it("recusa tipo restrito mesmo quando não entra no JavaScript", () => {
    expect(() => assertSdkDeclarations(["types/contracts/src/documents.d.ts"])).toThrow(
      "fora do escopo MIT",
    );
  });
  it("recusa ausência de proveniência e caminho que escapa do pacote", () => {
    expect(() => assertMitSources([])).toThrow("Grafo MIT vazio");
    expect(() => assertSdkDeclarations([])).toThrow("sem declarações");
    expect(() => assertSdkDeclarations(["types/../../LICENSE"])).toThrow("inesperado");
  });
});
