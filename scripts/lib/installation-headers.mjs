import assert from "node:assert/strict";
import { installationOrigin } from "../../platform/installation.ts";

function connectSources(config) {
  const cloud = installationOrigin(config.cloud);
  const site = installationOrigin(config.site);
  const api = config.api === undefined ? [] : [installationOrigin(config.api)];
  assert.ok(
    [cloud, site, ...api].every((origin) => !/[\s;*]/.test(origin)),
    "Exact CSP origins required",
  );
  return ["'self'", cloud, cloud.replace(/^https:/, "wss:"), site, ...api];
}

export function installationHeaders(source, config) {
  assert.equal([...source.matchAll(/connect-src\s+[^;]+;/g)].length, 1);
  return source.replace(/connect-src\s+[^;]+;/, `connect-src ${connectSources(config).join(" ")};`);
}

export function verifyInstallationPolicy(policy, config) {
  assert.equal(typeof policy, "string", "Hosted CSP missing");
  const matches = [...policy.matchAll(/(?:^|;)\s*connect-src\s+([^;]+)/g)];
  assert.equal(matches.length, 1, "Exactly one hosted connection policy required");
  const sort = (values) => values.sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    sort(matches[0][1].trim().split(/\s+/)),
    sort(connectSources(config)),
    "Hosted CSP must match the installation backend",
  );
}
