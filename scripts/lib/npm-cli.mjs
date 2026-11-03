import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// Resolve the JS entrypoint without shell interpolation, including when the
// caller is Bun and npm is installed beside a separate Node executable.
export function npmRunner() {
  const node = execFileSync("node", ["-p", "process.execPath"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const candidates = [
    process.env.npm_execpath,
    join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
  ];
  try {
    for (const path of execFileSync(process.platform === "win32" ? "where.exe" : "which", ["npm"], {
      encoding: "utf8",
      windowsHide: true,
    })
      .trim()
      .split(/\r?\n/))
      candidates.push(realpathSync(path), join(dirname(path), "node_modules/npm/bin/npm-cli.js"));
  } catch {
    /* The runtime may provide npm beside node. */
  }
  const cli = candidates.find((path) => path?.endsWith("npm-cli.js") && existsSync(path));
  if (!cli) throw new Error("Instale npm junto do Node para provar o consumidor independente");
  return (args, cwd, env = process.env) =>
    execFileSync(node, [cli, ...args], {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
}
