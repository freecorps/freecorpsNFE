/**
 * O descritor do deployment local do Convex. O backend escreve as portas que
 * de fato ligou, então elas são LIDAS daqui, não deduzidas.
 */
import { existsSync, readFileSync } from "node:fs";

import { fail } from "./exec.mjs";

export function readLocalConfig(paths) {
  if (!existsSync(paths.localConfig)) return null;
  const config = JSON.parse(readFileSync(paths.localConfig, "utf8"));
  if (
    typeof config.deploymentName !== "string" ||
    !/^(anonymous|local)-[A-Za-z0-9-]+$/.test(config.deploymentName) ||
    !Number.isInteger(config.ports?.cloud) ||
    config.ports.cloud < 1 ||
    config.ports.cloud > 65534 ||
    config.ports?.site !== config.ports.cloud + 1
  ) {
    fail(`Config do deployment local do Convex inválida em ${paths.localConfig}.`);
  }
  return config;
}

export function localUrls(config) {
  return {
    cloud: `http://127.0.0.1:${config.ports.cloud}`,
    site: `http://127.0.0.1:${config.ports.site}`,
  };
}
