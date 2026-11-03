import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

// Resolve links in the existing ancestor even when the backup directory is new.
function canonicalDestination(directory) {
  let ancestor = resolve(directory);
  const missing = [];
  while (true) {
    try {
      lstatSync(ancestor);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
      continue;
    }
    // Broken links and access errors fail closed instead of falling back to a lexical path.
    return resolve(realpathSync(ancestor), ...missing);
  }
}

export function validateBackupDirectory(directory, checkoutRoot) {
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw new Error("VALIDATION_BACKUP_DIR must be an absolute path outside the checkout");
  }
  const destination = canonicalDestination(directory);
  const checkout = realpathSync(checkoutRoot);
  const offset = relative(checkout, destination);
  if (offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`))) {
    throw new Error("VALIDATION_BACKUP_DIR must be outside the checkout, including linked paths");
  }
  return destination;
}
