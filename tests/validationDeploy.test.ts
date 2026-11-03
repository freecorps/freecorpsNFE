import { mkdtempSync, rmdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { parse } from "yaml";
import {
  checkPublication,
  obsoleteMessage,
  sameRevision,
  publishRevision,
  withRehearsalLock,
  requireRehearsalWindow,
} from "../scripts/lib/validation-deploy.mjs";

const sha = "a".repeat(40);
const newer = "b".repeat(40);
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "freecorps/freecorpsNFE",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: sha,
  CI_TESTED_SHA: sha,
};
const probe = { key: "persistence-v1", nonce: "synthetic", _id: "record", createdAt: 1 };
it("rejects ambiguous GitHub 404s and only accepts an authenticated workflow listing without the writer", async () => {
  const request = vi.fn();
  await expect(requireRehearsalWindow("", request)).rejects.toThrow("authenticated");
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValueOnce(new Response("", { status: 404 }));
  await expect(requireRehearsalWindow("synthetic-token", request)).rejects.toThrow(
    "authenticate access",
  );
  request
    .mockResolvedValueOnce(Response.json({ object: { sha } }))
    .mockResolvedValueOnce(new Response("", { status: 404 }));
  await expect(requireRehearsalWindow("synthetic-token", request)).rejects.toThrow("Cannot prove");
  request
    .mockResolvedValueOnce(Response.json({ object: { sha } }))
    .mockResolvedValueOnce(Response.json([{ name: "ci.yml" }, { name: "deploy-validation.yml" }]));
  await expect(requireRehearsalWindow("synthetic-token", request)).rejects.toThrow(
    "automatic writer",
  );
  request
    .mockResolvedValueOnce(Response.json({ object: { sha } }))
    .mockResolvedValueOnce(Response.json([{ name: "ci.yml" }, { name: "deploy.yml" }]));
  await expect(requireRehearsalWindow("synthetic-token", request)).resolves.toBeUndefined();
});
function operations() {
  return {
    preflight: vi.fn(async () => {}),
    build: vi.fn(async () => {}),
    probe: vi.fn(async () => probe),
    eligible: vi.fn(async () => true),
    backend: vi.fn(async () => {}),
    frontend: vi.fn(async () => {}),
    smoke: vi.fn(async () => {}),
  };
}
it("rejects another SHA, missing CI, forks, PR merges, pushes and other branches before publication", () => {
  expect(checkPublication(env, sha)).toBe(sha);
  for (const overrides of [
    { CI_TESTED_SHA: newer },
    { CI_TESTED_SHA: "" },
    { GITHUB_SHA: newer },
    { GITHUB_REPOSITORY: "fork/repo" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/heads/feat/fiscal-platform-v1" },
  ])
    expect(() => checkPublication({ ...env, ...overrides }, sha)).toThrow();
});
it("checks source eligibility after build and skips obsolete commits without writing", async () => {
  const ops = operations();
  let current = sha;
  ops.build.mockImplementation(async () => {
    current = newer;
  });
  ops.eligible.mockImplementation(async () => current === sha);
  const receipt = await publishRevision(sha, ops, vi.fn());
  expect(receipt.state).toBe("obsolete");
  expect(ops.backend).not.toHaveBeenCalled();
  expect(ops.frontend).not.toHaveBeenCalled();
});
it("finishes both services if the branch advances during publication, then refuses the old queued revision", async () => {
  const ops = operations();
  let current = sha;
  const deployed: string[] = [];
  ops.eligible.mockImplementation(async () => current === sha);
  ops.backend.mockImplementation(async () => {
    deployed.push(`backend:${sha}`);
    current = newer;
  });
  ops.frontend.mockImplementation(async () => {
    deployed.push(`frontend:${sha}`);
  });
  expect((await publishRevision(sha, ops, vi.fn())).state).toBe("validated");
  const next = operations();
  next.backend.mockImplementation(async () => {
    deployed.push(`backend:${newer}`);
  });
  next.frontend.mockImplementation(async () => {
    deployed.push(`frontend:${newer}`);
  });
  await publishRevision(newer, next, vi.fn());
  expect((await publishRevision(sha, ops, vi.fn())).state).toBe("obsolete");
  expect(deployed).toEqual([
    `backend:${sha}`,
    `frontend:${sha}`,
    `backend:${newer}`,
    `frontend:${newer}`,
  ]);
});
it("records partial state after backend publication and recovers by repeating the same compatible revision", async () => {
  const ops = operations();
  const record = vi.fn();
  ops.frontend.mockRejectedValueOnce(new Error("private provider response"));
  await expect(publishRevision(sha, ops, record)).rejects.toThrow("state=partial");
  expect(record.mock.lastCall?.[0]).toMatchObject({
    state: "partial",
    phase: "frontend",
    backendSha: sha,
  });
  expect(JSON.stringify(record.mock.calls)).not.toContain("private provider");
  expect(ops.smoke).not.toHaveBeenCalled();
  expect((await publishRevision(sha, ops, record)).state).toBe("validated");
});
it("does not approve missing persistent data, changed data or a failed authenticated smoke", async () => {
  const ops = operations();
  ops.probe.mockResolvedValueOnce(null as never);
  await expect(publishRevision(sha, ops, vi.fn())).rejects.toThrow("failed-before-publication");
  expect(ops.backend).not.toHaveBeenCalled();
  ops.probe.mockResolvedValueOnce(probe).mockResolvedValueOnce({ ...probe, createdAt: 2 });
  await expect(publishRevision(sha, ops, vi.fn())).rejects.toThrow("state=partial");
  ops.smoke.mockRejectedValueOnce(new Error("auth failure"));
  await expect(publishRevision(sha, ops, vi.fn())).rejects.toThrow("state=partial");
});
it("requires matching full SHAs and disabled fiscal effects", () => {
  const frontend = { sha, environment: "validation" };
  const backend = {
    sha,
    status: "ok",
    appEnv: "validation",
    productEnv: "sandbox",
    fiscalEnv: "disabled",
    issuanceEnv: "disabled",
  };
  expect(() => sameRevision(sha, frontend, backend)).not.toThrow();
  // A build before #337 (no `issuanceEnv`) is not the approved revision: the same answer as an
  // older SHA, never another kind of error.
  const { issuanceEnv: _, ...older } = backend;
  expect(() => sameRevision(sha, frontend, older)).toThrow(
    "Published services do not match the approved validation revision",
  );
  for (const changes of [
    { sha: newer },
    { sha: null },
    { fiscalEnv: "production" },
    { appEnv: "production" },
    { issuanceEnv: "production" },
    { issuanceEnv: "" },
  ])
    expect(() => sameRevision(sha, frontend, { ...backend, ...changes })).toThrow();
});
it.each(["missing", "changed", "unavailable"])(
  "attributes a %s post-smoke probe to persistence",
  async (failure) => {
    const ops = operations();
    const record = vi.fn();
    ops.probe.mockResolvedValueOnce(probe);
    if (failure === "unavailable")
      ops.probe.mockRejectedValueOnce(new Error("private provider response"));
    else
      ops.probe.mockResolvedValueOnce(
        failure === "missing" ? (null as never) : { ...probe, createdAt: 2 },
      );
    await expect(publishRevision(sha, ops, record)).rejects.toThrow("state=partial");
    expect(ops.smoke).toHaveBeenCalledOnce();
    expect(record.mock.lastCall?.[0]).toMatchObject({ phase: "persistence", state: "partial" });
    expect(record.mock.lastCall?.[0]).not.toHaveProperty("diagnostic");
    expect(JSON.stringify(record.mock.calls)).not.toContain("private provider");
  },
);
it("excludes a concurrent operator and releases the actual filesystem lock after failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fnfe-writer-"));
  const lock = join(directory, "writer");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const first = withRehearsalLock(lock, async () => {
      await blocked;
    });
    await expect(withRehearsalLock(lock, vi.fn())).rejects.toThrow();
    release();
    await first;
    await expect(
      withRehearsalLock(lock, async () => {
        throw new Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    expect(await withRehearsalLock(lock, async () => "recovered")).toBe("recovered");
  } finally {
    release();
    rmdirSync(directory);
  }
});
type Job = Record<string, unknown> & { steps?: Array<{ uses?: string; with?: { ref?: string } }> };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };
const readWorkflow = (name: string) => {
  const text = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
  return { text, workflow: parse(text) as Workflow };
};
// Expressions compared without `${{ }}` and whitespace: reformatting keeps
// the proof, changing the condition breaks it.
const expression = (value: unknown) =>
  String(value)
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    .replace(/\s+/g, "");
it("keeps the writer serialized and secret-free PR validation separate from deployment", () => {
  const { text, workflow } = readWorkflow("deploy-validation.yml");
  // Manual only, from main: a push to main publishes production, never validation.
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(expression(workflow.jobs.validate!.if)).toBe(
    "github.ref=='refs/heads/main'&&inputs.target=='validation'",
  );
  const deploy = workflow.jobs.deploy!;
  expect([deploy.needs].flat()).toEqual(["validate"]);
  expect(expression(deploy.if)).toBe(
    "needs.validate.outputs.tested_sha==github.sha&&github.ref=='refs/heads/main'&&inputs.target=='validation'",
  );
  expect(deploy.concurrency).toEqual({
    group: "validation-publication",
    "cancel-in-progress": false,
  });
  const checkout = deploy.steps!.find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(expression(checkout?.with?.ref)).toBe("needs.validate.outputs.tested_sha");
  // Absences are checked on the whole text: no part of the file may name them.
  expect(text).not.toMatch(
    /pull_request|secrets\.CLOUDFLARE_API_TOKEN|secrets\.CONVEX_DEPLOY_KEY|continue-on-error/,
  );
  const ci = readWorkflow("ci.yml").workflow;
  expect(Object.keys(ci.on)).not.toContain("push");
  expect(Object.keys(ci.on)).toContain("pull_request");
});

it("o smoke estrito só roda depois de publicar o backend e conferir o SHA", async () => {
  // The validation target before #337 (no `issuanceEnv`) leads to a normal republication: no
  // step before publishing reads `/health`, and the smoke comes after backend and frontend.
  const ops = operations();
  const order: string[] = [];
  for (const name of Object.keys(ops) as Array<keyof typeof ops>) {
    const original = ops[name].getMockImplementation()!;
    (ops[name] as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push(name);
      return original();
    });
  }
  expect((await publishRevision(sha, ops, vi.fn())).state).toBe("validated");
  expect(order).toEqual([
    "preflight",
    "build",
    "probe",
    "eligible",
    "backend",
    "frontend",
    "smoke",
    "probe",
  ]);
  const script = readFileSync(new URL("../scripts/deploy-validation.mjs", import.meta.url), "utf8");
  const at = (text: string) => script.indexOf(text);
  // The only `/health` read is inside the backend step, after `validation.mjs deploy`, and it
  // compares the SHA; the strict smoke is called only in the smoke step.
  const read = "${context.target.siteUrl}/health";
  expect(script.split(read)).toHaveLength(2);
  expect(at('run("scripts/validation.mjs", ["deploy"')).toBeLessThan(at(read));
  expect(at(read)).toBeLessThan(at("(await health.json()).sha !== sha"));
  expect(script.match(/smokeValidation\(/g)).toHaveLength(1);
  expect(at("smoke: async () =>")).toBeLessThan(at("await smokeValidation("));
  expect(at("backend: async () =>")).toBeLessThan(at(read));
  expect(at(read)).toBeLessThan(at("frontend: async () =>"));
});

it("explains an obsolete run with both revisions and that nothing was published", () => {
  expect(obsoleteMessage(sha, newer)).toBe(
    `Obsolete revision: tested ${sha}, but main is now at ${newer}. Nothing was published; dispatch again on the current main.`,
  );
  expect(obsoleteMessage(sha, null)).toContain("main is now at unknown.");
  expect(obsoleteMessage(sha, "main\nforged")).toContain("main is now at unknown.");
});
