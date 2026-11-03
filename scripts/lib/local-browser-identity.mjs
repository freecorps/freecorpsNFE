import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const localBrowserIdentityPath = "/__freecorps_worktree";

/** Identifica a raiz do frontend sem expor o caminho da máquina no HTTP. */
export function localBrowserIdentity(root) {
  const normalized = resolve(root).replaceAll("\\", "/");
  return createHash("sha256")
    .update(process.platform === "win32" ? normalized.toLowerCase() : normalized)
    .digest("hex");
}
