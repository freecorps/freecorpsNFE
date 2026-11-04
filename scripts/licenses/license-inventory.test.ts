import { expect, it } from "vite-plus/test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

it.each([
  "integrity",
  "source",
  "direct",
  "unknown-license",
  "runtime-license",
  "runtime-source",
  "runtime-last-integrity",
  "runtime-duplicate",
  "runtime-unknown",
  "runtime-extra",
])("check real recusa inventário adulterado: %s", (field) => {
  const temporary = mkdtempSync(join(tmpdir(), "fnfe-license-test-"));
  try {
    cpSync("bun.lock", join(temporary, "bun.lock"));
    mkdirSync(join(temporary, "docs/licenses"), { recursive: true });
    const inventory = JSON.parse(readFileSync("docs/licenses/dependencies.json", "utf8"));
    const additions = JSON.parse(readFileSync("docs/licenses/runtime-additions.json", "utf8"));
    const last = additions.packages.length - 1;
    if (field === "runtime-last-integrity") {
      additions.packages[last].integrity = "sha512-wrong";
    } else if (field === "runtime-duplicate") {
      additions.packages[last] = additions.packages[0];
    } else if (field === "runtime-unknown") {
      additions.packages[last].id = "strnum@9.9.9";
    } else if (field === "runtime-extra") {
      additions.packages.push({ ...additions.packages[last], id: "anynum@9.9.9" });
    } else if (field.startsWith("runtime-")) {
      additions.packages[0][field === "runtime-license" ? "declaredLicense" : "source"] = "wrong";
    } else if (field === "unknown-license") {
      inventory.packages[0].declaredLicense = "UNKNOWN";
    } else {
      inventory.packages[0][field] = field === "direct" ? [{ workspace: "fake" }] : "wrong";
    }
    writeFileSync(join(temporary, "docs/licenses/dependencies.json"), JSON.stringify(inventory));
    writeFileSync(
      join(temporary, "docs/licenses/runtime-additions.json"),
      JSON.stringify(additions),
    );
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/licenses/inventory-licenses.mjs"), "--check"],
      { cwd: temporary, encoding: "utf8", windowsHide: true },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Inventário diverge|Licença requer revisão|Runtime adicional/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
