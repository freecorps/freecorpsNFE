import { readFileSync } from "node:fs";
import { join } from "node:path";

export function sdkTarballPath() {
  const { version } = JSON.parse(readFileSync("packages/sdk/package.json", "utf8"));
  return join(".ci-results", "74", `freecorps-freecorpsnfe-sdk-${version}.tgz`);
}
