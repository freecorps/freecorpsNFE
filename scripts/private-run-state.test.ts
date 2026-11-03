import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  chmodSync,
  rmSync,
  rmdirSync,
  linkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { it, expect } from "vite-plus/test";
import { readPrivateState, writePrivateState } from "./lib/private-run-state.mjs";

it.skipIf(process.platform !== "win32")(
  "creates private state under a directory granting inherited Everyone read access",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "private-state-acl-")),
      path = join(dir, "state.json");
    const script = `
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('FNFE_TEST_ACL_PATH')
$acl = Get-Acl -LiteralPath $path
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [Security.AccessControl.FileSystemAccessRule]::new($everyone, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`;
    try {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { env: { ...process.env, FNFE_TEST_ACL_PATH: dir }, windowsHide: true, stdio: "pipe" },
      );
      writePrivateState(path, { synthetic: "privado: ação 🔒" });
      // The native stream validates its own DACL and performs IO without reopening the path.
      expect(readPrivateState(path)).toEqual({ synthetic: "privado: ação 🔒" });
      writePrivateState(path, { synthetic: "replacement" });
      expect(readPrivateState(path)).toEqual({ synthetic: "replacement" });
    } finally {
      rmSync(path, { force: true });
      rmdirSync(dir);
    }
  },
);

it("protects a preexisting checkpoint before reading and preserves protection on replacement", () => {
  const dir = mkdtempSync(join(tmpdir(), "private-run-state-")),
    path = join(dir, "state.json");
  try {
    writeFileSync(path, '{"synthetic":1}', { mode: 0o644 });
    expect(readPrivateState(path)).toEqual({ synthetic: 1 });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    writePrivateState(path, { synthetic: 2 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ synthetic: 2 });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    // Windows protection is verified inside the real DACL operation before any read/write.
  } finally {
    rmSync(path, { force: true });
    rmdirSync(dir);
  }
});

it("refuses multiply linked checkpoints without reading or replacing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "private-run-state-")),
    path = join(dir, "state.json"),
    alias = join(dir, "alias.json");
  try {
    writeFileSync(path, '{"synthetic":1}');
    linkSync(path, alias);
    expect(() => readPrivateState(path)).toThrow("one link");
    expect(() => writePrivateState(path, {})).toThrow("one link");
    expect(readFileSync(alias, "utf8")).toBe('{"synthetic":1}');
  } finally {
    rmSync(alias, { force: true });
    rmSync(path, { force: true });
    rmdirSync(dir);
  }
});
