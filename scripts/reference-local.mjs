import { readFileSync } from "node:fs";
import { referenceLocal } from "./lib/reference-local.mjs";
import { repoRoot } from "./lib/repo-root.mjs";

const local = referenceLocal(repoRoot);
const [command, value, generation, reason] = process.argv.slice(2);
if (command === "stage") {
  console.log(await local.stage(readFileSync(value, "utf8")));
} else if (command === "current" && ["ncm", "municipalities"].includes(value)) {
  console.log(await local.rpc("query", "referenceImport:current", { dataset: value }));
} else if (command === "publish" && /^\d+$/.test(generation ?? "") && reason) {
  console.log(
    await local.rpc("mutation", "referenceImport:publish", {
      versionId: value,
      expectedGeneration: Number(generation),
      reason,
    }),
  );
} else
  throw new Error(
    "Uso local: stage arquivo.json | current ncm|municipalities | publish versionId geração motivo",
  );
