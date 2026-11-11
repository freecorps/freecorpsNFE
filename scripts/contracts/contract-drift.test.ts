import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { routes } from "../../packages/contracts/src/external";
import { renderContractArtifacts, staleContractArtifacts } from "../lib/contract-artifacts.mjs";
import { openApi } from "../lib/external-contract.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

// Prova no CI que `contracts:check` recusa uma mudança de contrato sem os
// artefatos derivados regenerados e que a regeneração restaura a concordância.
// A mudança é feita no objeto de rotas que a geração lê, nunca nos arquivos do
// checkout; a regeneração grava numa pasta temporária.
const root = repoRoot;
const temporary: string[] = [];
const derivedFromRoutes = ["docs/v1.0/openapi.json", "docs/v1.0/API-REFERENCE.md"];
type Route = (typeof routes)[keyof typeof routes];
const mutable = routes as unknown as Record<string, Route>;

const regenerate = (artifacts: Record<string, string>) => {
  const folder = mkdtempSync(join(tmpdir(), "fnfe-contract-drift-"));
  temporary.push(folder);
  for (const [path, content] of Object.entries(artifacts)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
  }
  return folder;
};

afterEach(() => {
  for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true });
});

it("accepts the committed derived artifacts of the current contract", async () => {
  expect(staleContractArtifacts(await renderContractArtifacts(openApi()), root)).toEqual([]);
});

it.each([
  {
    change: "scope of an existing route",
    apply: () => {
      const route = mutable.getExport;
      const scope = route.scope;
      (route as { scope: string }).scope = "documents:drift-probe";
      return () => void ((route as { scope: string }).scope = scope);
    },
  },
  {
    change: "new route",
    apply: () => {
      mutable.driftProbe = { ...mutable.getExport, path: "/v1/drift-probe/{exportId}" };
      return () => void delete mutable.driftProbe;
    },
  },
])(
  "rejects a $change without regenerated artifacts and accepts the regeneration",
  async ({ apply }) => {
    const restore = apply();
    try {
      const changed = await renderContractArtifacts(openApi());
      expect(staleContractArtifacts(changed, root)).toEqual(derivedFromRoutes);
      expect(staleContractArtifacts(changed, regenerate(changed))).toEqual([]);
    } finally {
      restore();
    }
    expect(staleContractArtifacts(await renderContractArtifacts(openApi()), root)).toEqual([]);
  },
);

it("rejects a hand-edited or missing derived file while the contract is unchanged", async () => {
  const current = await renderContractArtifacts(openApi());
  const folder = regenerate(current);
  writeFileSync(join(folder, "docs/v1.0/openapi.json"), current["docs/v1.0/openapi.json"] + "\n");
  unlinkSync(join(folder, "docs/v1.0/API-REFERENCE.md"));
  expect(staleContractArtifacts(current, folder)).toEqual([
    "docs/v1.0/openapi.json",
    "docs/v1.0/API-REFERENCE.md",
  ]);
  // Uma cópia com fim de linha do Windows continua concordante.
  writeFileSync(
    join(folder, "docs/v1.0/openapi.json"),
    current["docs/v1.0/openapi.json"].replaceAll("\n", "\r\n"),
  );
  writeFileSync(join(folder, "docs/v1.0/API-REFERENCE.md"), current["docs/v1.0/API-REFERENCE.md"]);
  expect(staleContractArtifacts(current, folder)).toEqual([]);
});
