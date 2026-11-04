import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import { scanPlan, stepExit } from "./public-scan.mjs";
import { GITLEAKS_VERSION } from "./public-tree.mjs";
import { repoUrl } from "../lib/repo-root.mjs";

describe("varredura pública no CI", () => {
  it("monta a cópia no arquivo privado e varre o checkout no público", () => {
    expect(scanPlan({ out: "/o", custody: true, enforce: false }).args).toEqual([
      "--sha",
      "HEAD",
      "--out",
      "/o",
    ]);
    expect(
      scanPlan({ out: "/o", custody: false, denylistFile: "/t/d.json", enforce: true }),
    ).toEqual({
      mode: "checkout",
      args: ["--checkout", "--sha", "HEAD", "--out", "/o", "--denylist", "/t/d.json"],
      enforce: true,
    });
    // Fork PRs get no secret: the scan runs without the names.
    expect(scanPlan({ out: "/o", custody: false, enforce: false }).args).not.toContain(
      "--denylist",
    );
  });

  it("uma varredura bloqueada só falha quando bloqueante; erro de uso sempre falha", () => {
    expect(stepExit(0, true)).toBe(0);
    expect(stepExit(1, false)).toBe(0);
    expect(stepExit(1, true)).toBe(1);
    expect(stepExit(2, false)).toBe(2);
    expect(stepExit(null, false)).toBe(2);
  });

  it("o workflow roda em todo PR e na main, com o Gitleaks fixado e só leitura", () => {
    type Step = {
      uses?: string;
      run?: string;
      env?: Record<string, string>;
      with?: Record<string, string>;
    };
    const workflow = parse(
      readFileSync(new URL(".github/workflows/public-scan.yml", repoUrl), "utf8"),
    ) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<string, { permissions: Record<string, string>; steps: Step[] }>;
    };
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const { steps, permissions } = workflow.jobs.scan!;
    expect(permissions).toEqual({ contents: "read" });
    for (const step of steps) {
      if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
      if (step.run) expect(step.run).not.toContain("${{");
    }
    const install = steps.find((step) => step.run?.includes("gitleaks.tar.gz"))!;
    expect(install.env?.GITLEAKS_VERSION).toBe(GITLEAKS_VERSION);
    expect(install.env?.GITLEAKS_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(install.run).toContain("sha256sum -c -");
    const scan = steps.find((step) => step.run?.includes("scripts/public-copy/public-scan.mjs"))!;
    expect(scan.env?.FNFE_PUBLIC_DENYLIST).toBe("${{ secrets.FNFE_PUBLIC_DENYLIST }}");
    // Since phase 1e of #267, a blocked scan fails the check.
    expect(scan.env?.PUBLIC_SCAN_ENFORCE).toBe("true");
  });
});
