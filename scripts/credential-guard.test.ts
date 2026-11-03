import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { blocked } from "../.claude/hooks/guard-credentials.mjs";

const convexConfig = [".convex", "config.json"].join("/");

it("blocks agent tool calls that cite a credential file", () => {
  for (const [tool, input] of [
    ["Bash", { command: `cat ~/${convexConfig} | sed 's/token//'` }],
    ["Bash", { command: `node -p 'require(require("os").homedir()+"/${convexConfig}")'` }],
    ["PowerShell", { command: `Get-Content $HOME\\.convex\\config.json` }],
    ["Read", { file_path: `C:\\Users\\x\\.convex\\config.json` }],
    ["Bash", { command: "type C:\\private\\password.dpapi" }],
    ["Bash", { command: "base64 empresa.PFX" }],
    ["Read", { file_path: "/tmp/a1.p12" }],
    ["Bash", { command: "cat C:/privado/deployment.env" }],
    ["Grep", { pattern: "KEY", path: "platform/.env.local" }],
    // O diretório inteiro, não só o arquivo: globs, listagem e cópia.
    ["Bash", { command: "cat ~/.convex/*" }],
    ["Bash", { command: "ls ~/.convex" }],
    ["Bash", { command: "cp -r ~/.convex /tmp/x" }],
    ["Grep", { pattern: "token", path: "~/.convex" }],
    ["Glob", { pattern: "**/*", path: "C:\\Users\\x\\.convex" }],
  ] as const)
    expect(blocked(tool, input), JSON.stringify(input)).toBe(true);
});

it("lets through commands that use credentials without citing the file", () => {
  for (const [tool, input] of [
    ["Bash", { command: "CONVEX_DEPLOYMENT=prod:x npx convex data captureStreams" }],
    ["Bash", { command: "gh pr view 1" }],
    ["Read", { file_path: "platform/convex.json" }],
    ["Read", { file_path: "docs/operacao/deploy-producao.md" }],
    ["Bash", { command: "grep -rn deployment.environment scripts" }],
    ["Grep", { pattern: "convex", path: "platform/convex" }],
    ["Grep", { pattern: "[.]env[.]local", path: "scripts" }],
    ["Bash", { command: "cat .env.example" }],
    ["Bash", { command: "npx convex deploy --yes" }],
    ["Bash", { command: "vp run convex:dev" }],
  ] as const)
    expect(blocked(tool, input), JSON.stringify(input)).toBe(false);
});

it("is wired as a PreToolUse hook that exits 2 with a reason", () => {
  const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  const [entry] = settings.hooks.PreToolUse;
  for (const tool of ["Bash", "PowerShell", "Read", "Grep"])
    expect(new RegExp(`^(${entry.matcher})$`).test(tool), tool).toBe(true);
  const run = (command: string) =>
    spawnSync(process.execPath, [".claude/hooks/guard-credentials.mjs"], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
    });
  const refused = run(`cat ~/${convexConfig}`);
  expect(refused.status).toBe(2);
  expect(refused.stderr).toMatch(/^Bloqueado/);
  expect(run("ls").status).toBe(0);
  // Entrada ilegível: o hook sai limpo, sem decidir, em vez de quebrar.
  for (const input of ["{not json", ""]) {
    const result = spawnSync(process.execPath, [".claude/hooks/guard-credentials.mjs"], {
      input,
      encoding: "utf8",
    });
    expect(result.status, JSON.stringify(input)).toBe(0);
    expect(result.stderr).toBe("");
  }
});
