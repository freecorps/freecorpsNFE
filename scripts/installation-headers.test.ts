import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { installationHeaders, verifyInstallationPolicy } from "./lib/installation-headers.mjs";

const source = readFileSync(new URL("../apps/console/public/_headers", import.meta.url), "utf8");
const target = {
  cloud: "https://elated-possum-295.convex.cloud",
  site: "https://elated-possum-295.convex.site",
};
const policy = (headers: string) => headers.split("Content-Security-Policy: ")[1].trim();

it("rejects the validation CSP for an installation and keeps other protections when rebuilding", () => {
  expect(() => verifyInstallationPolicy(policy(source), target)).toThrow();
  const generated = installationHeaders(source, target);
  expect(generated).toContain("wss://elated-possum-295.convex.cloud");
  expect(generated).not.toContain("modest-seal-118");
  expect(generated.replace(/connect-src [^;]+;/, "")).toBe(
    source.replace(/connect-src [^;]+;/, ""),
  );
  expect(() => verifyInstallationPolicy(policy(generated), target)).not.toThrow();
  expect(() => verifyInstallationPolicy(policy(generated) + "; connect-src *", target)).toThrow();
  expect(() => verifyInstallationPolicy(null, target)).toThrow();
});

it("supports explicit operator domains but refuses wildcard, credentials and policy injection", () => {
  const own = { cloud: "https://rpc.operator.invalid", site: "https://api.operator.invalid" };
  expect(() =>
    verifyInstallationPolicy(policy(installationHeaders(source, own)), own),
  ).not.toThrow();
  for (const cloud of [
    "https://*.operator.invalid",
    "https://user:pass@rpc.operator.invalid",
    "https://rpc.operator.invalid; connect-src *",
  ]) {
    expect(() => installationHeaders(source, { ...own, cloud })).toThrow();
  }
});

it("includes the public REST address when the installation has one", () => {
  const withApi = {
    cloud: "https://elated-possum-295.convex.cloud",
    site: "https://elated-possum-295.convex.site",
    api: "https://api.nfe.freecorps.com.br",
  };
  const generated = policy(installationHeaders(source, withApi));
  expect(generated).toContain(" https://api.nfe.freecorps.com.br;");
  expect(() => verifyInstallationPolicy(generated, withApi)).not.toThrow();
  expect(() => verifyInstallationPolicy(generated, target)).toThrow();
  expect(() =>
    installationHeaders(source, { ...withApi, api: "https://*.freecorps.com.br" }),
  ).toThrow();
});
