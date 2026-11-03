import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vite-plus/test";
import { subprocessEnvironment } from "../scripts/lib/subprocess-environment.mjs";

/**
 * O projeto `platform` roda sem isolamento por arquivo, e
 * tests/setup/file-isolation.ts devolve ao arquivo seguinte o worker como um
 * worker novo o receberia. A fixture roda dois arquivos num worker só: o
 * primeiro deixa timers falsos, um timer real pendente, env, global e spy; o
 * segundo confere que nada disso chegou até ele.
 */
const run = (setup: boolean) =>
  spawnSync(
    process.execPath,
    [
      resolve("node_modules/vite-plus/bin/vp"),
      "test",
      "run",
      "--root",
      "tests/fixtures/file-isolation",
    ],
    {
      cwd: resolve("."),
      env: {
        ...subprocessEnvironment(process.env),
        ...(setup ? { FILE_ISOLATION_SETUP: "1" } : {}),
      },
      encoding: "utf8",
      windowsHide: true,
    },
  );

it("hands the next file a clean worker", () => {
  const result = run(true);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("3 passed");
});

it("fails the same files without the setup, so the fixture really leaks", () => {
  const result = run(false);
  expect(result.status).toBe(1);
  expect(result.stdout).toMatch(/starts as a fresh worker would/);
  expect(result.stdout).toContain("2 passed");
});
