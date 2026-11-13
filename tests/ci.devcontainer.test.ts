import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import consoleManifest from "../apps/console/package.json";
import rootManifest from "../package.json";

/**
 * O devcontainer fixa no Dockerfile as versões que o repositório declara em
 * outros manifests. Quem atualiza o Bun, o Vite+ ou o Playwright atualiza o
 * container junto; senão o `--frozen-lockfile` ou o Chromium quebram só ali.
 */
const root = resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(resolve(root, ".devcontainer/Dockerfile"), "utf8");
const devcontainer = JSON.parse(
  readFileSync(resolve(root, ".devcontainer/devcontainer.json"), "utf8"),
) as {
  containerEnv: Record<string, string>;
  runArgs: string[];
  mounts: { target: string; type: string }[];
  customizations: { vscode: { extensions: string[] } };
};
const editor = JSON.parse(readFileSync(resolve(root, ".vscode/extensions.json"), "utf8")) as {
  recommendations: string[];
};

function arg(name: string) {
  return new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(dockerfile)?.[1];
}

describe("devcontainer", () => {
  it("fixa as versões de Bun, Vite+ e Playwright que os manifests declaram", () => {
    expect(arg("BUN_VERSION")).toBe(rootManifest.devEngines.packageManager.version);
    expect(arg("VP_VERSION")).toBe(rootManifest.devDependencies["vite-plus"]);
    expect(arg("PLAYWRIGHT_VERSION")).toBe(consoleManifest.devDependencies.playwright);
  });

  it("põe os worktrees no volume montado, que sobrevive ao rebuild", () => {
    const worktrees = devcontainer.containerEnv.FNFE_WORKTREES_DIR;
    expect(devcontainer.mounts).toContainEqual(
      expect.objectContaining({ target: worktrees, type: "volume" }),
    );
    // Criado como `node`, para o volume novo herdar esse dono, e não o root.
    const mkdir = dockerfile.indexOf(`mkdir -p ${worktrees}`);
    expect(mkdir).toBeGreaterThan(dockerfile.indexOf("USER node"));
    expect(dockerfile.indexOf("USER node")).toBeGreaterThan(-1);
  });

  it("desliga o IPv6, para localhost ser 127.0.0.1 no Bun, no Node e no Vite", () => {
    // Com IPv6 o Vite escuta só em ::1 e o preflight dos runners recusa (docs/worktrees.md).
    expect(devcontainer.runArgs.join(" ")).toContain("--sysctl net.ipv6.conf.all.disable_ipv6=1");
  });

  it("recomenda no container as mesmas extensões do editor local", () => {
    expect(devcontainer.customizations.vscode.extensions).toEqual(editor.recommendations);
  });
});
