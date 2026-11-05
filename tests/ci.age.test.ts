import { readFileSync } from "node:fs";
import type { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import { repoUrl } from "../scripts/lib/repo-root.mjs";
import { ageBinaries, hasAge } from "./helpers/age";

type Step = {
  name?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  "continue-on-error"?: boolean;
};
type Workflow = { env?: Record<string, string>; jobs: Record<string, { steps: Step[] }> };
const workflow = (file: string) =>
  parse(readFileSync(new URL(`.github/workflows/${file}`, repoUrl), "utf8")) as Workflow;

/** `spawnSync` falso: só os binários em `present` respondem a `--version`. */
const runner = (present: string[], calls: string[] = []) =>
  ((bin: string) => {
    calls.push(bin);
    return { status: present.includes(bin) ? 0 : null };
  }) as unknown as typeof spawnSync;

describe("hasAge", () => {
  it("usa AGE_BIN e AGE_KEYGEN_BIN, ou os nomes do PATH", () => {
    expect(ageBinaries({})).toEqual({ age: "age", keygen: "age-keygen" });
    expect(ageBinaries({ AGE_BIN: "/opt/age", AGE_KEYGEN_BIN: "/opt/keygen" })).toEqual({
      age: "/opt/age",
      keygen: "/opt/keygen",
    });
  });

  it("libera os testes de cifra só com os dois binários", () => {
    const calls: string[] = [];
    expect(hasAge({ CI: "true" }, runner(["age", "age-keygen"], calls))).toBe(true);
    expect(calls).toEqual(["age", "age-keygen"]);
    expect(hasAge({}, runner(["age"]))).toBe(false);
    expect(hasAge({}, runner([]))).toBe(false);
  });

  it("com CI=true, reprova em vez de pular quando falta um binário", () => {
    expect(() => hasAge({ CI: "true" }, runner([]))).toThrow("age, age-keygen");
    expect(() => hasAge({ CI: "true" }, runner(["age"]))).toThrow("age-keygen");
    expect(hasAge({ CI: "false" }, runner([]))).toBe(false);
  });
});

it("o validate do ci.yml instala no PATH o age fixado do backup antes dos testes", () => {
  const backup = workflow("offsite-backup.yml").env!;
  const steps = workflow("ci.yml").jobs.validate!.steps;
  const install = steps.findIndex((step) => step.name === "Install pinned age");
  const graph = steps.findIndex((step) => step.name === "Build, check and test");
  expect(install).toBeGreaterThanOrEqual(0);
  expect(install).toBeLessThan(graph);
  const step = steps[install]!;
  // Roda sempre que o grafo roda, e uma instalação que falha reprova o job.
  expect(step.if).toBe(steps[graph]!.if);
  expect(step["continue-on-error"]).toBeUndefined();
  expect(step.env).toEqual({ AGE_VERSION: backup.AGE_VERSION, AGE_SHA256: backup.AGE_SHA256 });
  expect(step.run).toContain("sha256sum -c -");
  // A tarefa de testes do Vite Task não recebe AGE_BIN; recebe o PATH.
  expect(step.run).toContain('>> "$GITHUB_PATH"');
  expect(step.run).not.toContain("GITHUB_ENV");
});
