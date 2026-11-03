import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { subprocessEnvironment } from "./subprocess-environment.mjs";

/** Build workspace exports before Convex resolves the independent XML package. */
export function buildPlatformPackages() {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const env = subprocessEnvironment(process.env);
  for (const name of ["fiscal-core", "fiscal-nfe", "fiscal-nfse"]) {
    const directory = join(root, "packages", name);
    const output = join(directory, "dist");
    if (
      realpathSync(directory) !== directory ||
      (existsSync(output) && realpathSync(output) !== output)
    )
      throw new Error("Saída de pacote deve pertencer a este checkout");
    rmSync(output, { recursive: true, force: true });
    const result = spawnSync(
      process.execPath,
      [join(root, "node_modules/typescript/bin/tsc"), "-p", `packages/${name}/tsconfig.json`],
      { cwd: root, env, stdio: "inherit" },
    );
    if (result.error || result.status !== 0) throw new Error("Platform package build failed");
  }
}
