import assert from "node:assert/strict";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fchmodSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const windowsProtection = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PrivateStateHandle {
  [StructLayout(LayoutKind.Sequential)]
  public struct Information {
    public uint Attributes, CreatedLow, CreatedHigh, AccessedLow, AccessedHigh;
    public uint WrittenLow, WrittenHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information info);
  [DllImport("kernel32.dll")]
  private static extern uint GetFileType(SafeFileHandle handle);
  public static void Validate(SafeFileHandle handle) {
    Information info;
    if (GetFileType(handle) != 1 || !GetFileInformationByHandle(handle, out info)
      || (info.Attributes & (0x10 | 0x400)) != 0 || info.Links != 1)
      throw new IOException("Expected a regular non-reparse file with one link");
  }
  public static FileStream OpenExisting(string path) {
    // GENERIC_READ/WRITE + READ_CONTROL/WRITE_DAC; exclusive, OPEN_EXISTING,
    // FILE_FLAG_OPEN_REPARSE_POINT prevents following a swapped symbolic link.
    var handle = CreateFileW(path, 0xC0060000, 0, IntPtr.Zero, 3, 0x00200080, IntPtr.Zero);
    try {
      if (handle.IsInvalid) throw new IOException("Cannot open private state");
      Validate(handle);
      return new FileStream(handle, FileAccess.ReadWrite);
    } catch { handle.Dispose(); throw; }
  }
}
'@
$path = [Environment]::GetEnvironmentVariable('FNFE_PRIVATE_STATE_PATH')
$mode = [Environment]::GetEnvironmentVariable('FNFE_PRIVATE_STATE_MODE')
$create = $mode -eq 'create'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
$acl.AddAccessRule($rule)
if ($create) {
  # This .NET Framework overload supplies the security descriptor to CreateFile.
  $stream = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew,
    [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None,
    4096, [IO.FileOptions]::None, $acl)
} else {
  $stream = [PrivateStateHandle]::OpenExisting($path)
}
try {
[PrivateStateHandle]::Validate($stream.SafeFileHandle)
$actual = $stream.GetAccessControl()
if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Foreign owner' }
if (-not $create) {
  $actual.SetAccessRuleProtection($true, $false)
  foreach ($entry in $actual.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
    [void]$actual.RemoveAccessRuleSpecific($entry)
  }
  $actual.AddAccessRule($rule)
  $stream.SetAccessControl($actual)
}
$actual = $stream.GetAccessControl()
if (-not $actual.AreAccessRulesProtected) { throw 'Inherited file permissions remain' }
foreach ($entry in $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($entry.IdentityReference.Value -ne $sid.Value) { throw 'Non-owner file permissions remain' }
}
if ($create) {
  $bytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush($true)
} elseif ($mode -eq 'read') {
  $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true, 4096, $true)
  try { [Console]::Out.Write($reader.ReadToEnd()) } finally { $reader.Dispose() }
}
} finally { $stream.Dispose() }
`;

function windowsState(path, mode, content = "") {
  try {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsProtection, "utf16le").toString("base64"),
      ],
      {
        env: {
          ...process.env,
          FNFE_PRIVATE_STATE_PATH: path,
          FNFE_PRIVATE_STATE_MODE: mode,
        },
        windowsHide: true,
        stdio: "pipe",
        input: content,
        encoding: "utf8",
      },
    );
  } catch {
    throw new Error(
      "Private Windows state operation failed: expected a regular file with one link and private access",
    );
  }
}

function privateDescriptor(path, create = false) {
  if (existsSync(path))
    assert.ok(lstatSync(path).isFile(), "State must be a regular file, not a link");
  const fd = openSync(
    path,
    constants.O_RDWR |
      (constants.O_NOFOLLOW ?? 0) |
      (create ? constants.O_CREAT | constants.O_EXCL : 0),
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.nlink === 1, "State must be a regular file with one link");
    assert.equal(stat.uid, process.getuid(), "State is owned by another user");
    fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readPrivateState(path) {
  if (!existsSync(path)) return null;
  if (process.platform === "win32") return JSON.parse(windowsState(path, "read"));
  const fd = privateDescriptor(path);
  try {
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

export function writePrivateState(path, state) {
  if (existsSync(path)) {
    if (process.platform === "win32") windowsState(path, "protect");
    else closeSync(privateDescriptor(path));
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if (process.platform === "win32")
      windowsState(temporary, "create", JSON.stringify(state, null, 2));
    else {
      const fd = privateDescriptor(temporary, true);
      try {
        writeFileSync(fd, JSON.stringify(state, null, 2), "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
