import assert from "node:assert/strict";
import { worktreePaths } from "./worktree/paths.mjs";
import { readLocalConfig, localUrls } from "./worktree/deployment.mjs";
import { currentLocalSiteUrl } from "./worktree/env-file.mjs";
import { assertLinkedWorktree } from "./worktree/state.mjs";
import { localBrowserFetch as fetch } from "./local-browser.mjs";

/** Deliberately has no remote/deploy-key option. Credentials never leave loopback. */
export function referenceLocal(root) {
  const paths = worktreePaths(root);
  assertLinkedWorktree(paths);
  assert.equal(paths.app, "platform");
  const config = readLocalConfig(paths);
  assert.ok(config);
  const urls = localUrls(config),
    site = currentLocalSiteUrl(paths);
  assert.equal(new URL(site).hostname, "localhost");
  async function rpc(kind, path, args, authorization = `Convex ${config.adminKey}`) {
    const response = await fetch(`${urls.cloud}/api/${kind}`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const result = await response.json();
    if (result.status !== "success")
      throw new Error(`Local ${path}: ${result.errorMessage ?? response.status}`);
    return result.value;
  }
  async function stage(payload) {
    const uploadUrl = await rpc("mutation", "referenceImport:uploadUrl", {});
    assert.equal(new URL(uploadUrl).origin, urls.cloud);
    const response = await fetch(uploadUrl, {
      method: "POST",
      body: new Blob([payload], { type: "application/json" }),
      redirect: "error",
    });
    assert.equal(response.status, 200);
    const { storageId } = await response.json();
    return rpc("action", "referenceLoad:stage", { storageId });
  }
  async function publish(versionId, dataset, reason) {
    const { generation } = await rpc("query", "referenceImport:current", { dataset });
    return rpc("mutation", "referenceImport:publish", {
      versionId,
      expectedGeneration: generation,
      reason,
    });
  }
  return { urls, site, rpc, stage, publish };
}
