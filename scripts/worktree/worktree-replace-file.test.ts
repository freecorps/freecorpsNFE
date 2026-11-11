import { afterEach, expect, it } from "vite-plus/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceFileSync } from "../lib/worktree/exec.mjs";

const roots: string[] = [];
const holders: ChildProcess[] = [];
afterEach(async () => {
  for (const child of holders.splice(0))
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function files() {
  const root = mkdtempSync(join(tmpdir(), "fnfe-replace-"));
  roots.push(root);
  const destination = join(root, "worktree-setup.json");
  const temporary = `${destination}.tmp`;
  writeFileSync(destination, "antigo\n");
  writeFileSync(temporary, "novo\n");
  return { destination, temporary };
}

/** Outro processo com o destino aberto, como um `worktree status` lendo. */
async function holdOpen(path: string, ms: number) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require("fs");const fd=fs.openSync(process.argv[1],"r");console.log("aberto");
       setTimeout(()=>fs.closeSync(fd),Number(process.argv[2]))`,
      path,
      String(ms),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  holders.push(child);
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  return child;
}

it.skipIf(process.platform !== "win32")(
  "no Windows, troca o arquivo depois que o leitor o solta",
  async () => {
    const { destination, temporary } = files();
    const holder = await holdOpen(destination, 200);
    // A disputa é real: sem repetir, a troca falha enquanto o leitor segura o arquivo.
    expect(() => renameSync(temporary, destination)).toThrow(
      expect.objectContaining({ code: "EPERM" }),
    );
    replaceFileSync(temporary, destination, { timeoutMs: 2000, waitMs: 5 });
    expect(readFileSync(destination, "utf8")).toBe("novo\n");
    expect(existsSync(temporary)).toBe(false);
    await once(holder, "exit");
  },
);

it.skipIf(process.platform !== "win32")(
  "no Windows, desiste depois das tentativas e apaga o temporário",
  async () => {
    const { destination, temporary } = files();
    await holdOpen(destination, 5000);
    expect(() => replaceFileSync(temporary, destination, { timeoutMs: 30, waitMs: 10 })).toThrow(
      expect.objectContaining({ code: "EPERM" }),
    );
    expect(readFileSync(destination, "utf8")).toBe("antigo\n");
    expect(existsSync(temporary)).toBe(false);
  },
);

it("troca na hora sem disputa e sobe na hora um erro que não é transitório", () => {
  const { destination, temporary } = files();
  replaceFileSync(temporary, destination);
  expect(readFileSync(destination, "utf8")).toBe("novo\n");
  expect(() => replaceFileSync(temporary, destination)).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
});
