import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vite-plus/test";
import { subprocessEnvironment } from "./lib/subprocess-environment.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.each(["deploy", "publish", "package"])(
  "isolates credentials in the actual console %s command",
  (command) => {
    const root = mkdtempSync(join(tmpdir(), "fnfe-console-execution-"));
    roots.push(root);
    const log = join(root, "calls.json"),
      preload = join(root, "preload.mjs");
    writeFileSync(
      preload,
      `
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const calls = [], read = fs.readFileSync, write = fs.writeFileSync;
cp.execFileSync = (_file, args) => args[0] === "rev-parse" ? "a".repeat(40) : "";
cp.spawnSync = (_file, args, options) => {
  calls.push({ args, env: options.env });
  write(${JSON.stringify(log)}, JSON.stringify(calls));
  return { status: 0 };
};
fs.readFileSync = (file, ...args) => String(file).replaceAll("\\\\", "/").endsWith("/dist/build.json")
  ? JSON.stringify({ sha: "a".repeat(40), environment: "validation" }) : read(file, ...args);
fs.writeFileSync = (file, ...args) => String(file).replaceAll("\\\\", "/").endsWith("/dist/build.json") ? undefined : write(file, ...args);
syncBuiltinESMExports();
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, resolve("scripts/console.mjs"), command],
      {
        cwd: resolve("."),
        env: {
          ...subprocessEnvironment(process.env),
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REPOSITORY: "freecorps/freecorpsNFE",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          CLOUDFLARE_API_TOKEN: "synthetic-cloudflare",
          CLOUDFLARE_ACCOUNT_ID: "ceccd1846b474bb179054a3c2c4a6185",
          CONVEX_DEPLOY_KEY: "synthetic-convex",
          ACTIONS_RUNTIME_TOKEN: "synthetic-runner",
          UNLISTED_SECRET: "synthetic-custom",
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const calls: Array<{ args: string[]; env: Record<string, string> }> = JSON.parse(
      readFileSync(log, "utf8"),
    );
    expect(calls.filter((call) => call.args[0]!.endsWith("typecheck.mjs"))).toHaveLength(
      // Console, console Worker and docs (apps/docs).
      command === "publish" ? 0 : 3,
    );
    const publications = calls.filter((call) => call.args[0]!.includes("wrangler"));
    expect(publications).toHaveLength(1);
    expect(publications[0]!.args.includes("--dry-run")).toBe(command === "package");
    for (const call of calls) {
      const publishes = call.args[0]!.includes("wrangler") && command !== "package";
      expect(call.env.CLOUDFLARE_API_TOKEN).toBe(publishes ? "synthetic-cloudflare" : undefined);
      expect(call.env.CONVEX_DEPLOY_KEY).toBeUndefined();
      expect(call.env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
      expect(call.env.UNLISTED_SECRET).toBeUndefined();
    }
  },
);
