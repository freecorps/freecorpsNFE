import { afterEach, expect, it } from "vite-plus/test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { subprocessEnvironment } from "./lib/subprocess-environment.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function execute(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), "fnfe-browser-lifecycle-"));
  temporary.push(directory);
  const main = join(directory, "main");
  const root = join(directory, "worktree");
  mkdirSync(main);
  const env = subprocessEnvironment(process.env);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: main, env, stdio: "pipe" });
  git("init", "--quiet");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@development.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  git("worktree", "add", "--quiet", "--detach", root);
  mkdirSync(join(root, ".convex"));
  writeFileSync(join(root, ".convex/worktree-app.json"), JSON.stringify({ app: "platform" }));
  mkdirSync(join(root, "platform/.convex/local/default"), { recursive: true });
  writeFileSync(
    join(root, "platform/.convex/local/default/config.json"),
    JSON.stringify({
      deploymentName: "anonymous-fixture",
      adminKey: "PRIVATE_SENTINEL",
      ports: { cloud: 3210, site: 3211 },
    }),
  );
  writeFileSync(join(root, ".env.local"), "VITE_SITE_URL=http://localhost:5174\n");
  const module = pathToFileURL(resolve("scripts/lib/local-browser.mjs")).href;
  const identity = pathToFileURL(resolve("scripts/lib/local-browser-identity.mjs")).href;
  const script = join(directory, "run.mjs");
  writeFileSync(
    script,
    `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
    import { join } from 'node:path';
    import { beginLocalBrowser, withLocalBrowser } from ${JSON.stringify(module)};
    import { localBrowserIdentity } from ${JSON.stringify(identity)};
    const root = ${JSON.stringify(root)};
    const mode = ${JSON.stringify(mode)};
    const lock = join(root, '.convex/browser.lock');
    const runs = join(root, '.browser-results/runs');
    const receiptPath = () => join(runs, readdirSync(runs)[0], 'preflight.json');
    const primary = new Error('PRIVATE_SENTINEL');
    const blockReceipt = () => { const path = receiptPath(); unlinkSync(path); mkdirSync(path); };
    globalThis.fetch = async (url) => {
      if (mode === 'preflight-error') throw primary;
      if (mode === 'preflight-save-error') { blockReceipt(); throw primary; }
      if (url === 'http://127.0.0.1:3210/instance_name') return new Response('anonymous-fixture');
      if (url === 'http://127.0.0.1:3210/api/query') return Response.json({ status: 'success' });
      assert.equal(url, 'http://localhost:5174/__freecorps_worktree');
      return Response.json({ schemaVersion: 1, application: 'freecorps-console',
        rootId: localBrowserIdentity(join(root, 'apps/console')),
        convexUrl: 'http://127.0.0.1:3210', authUrl: 'http://127.0.0.1:3211', apiUrl: 'http://127.0.0.1:3211' });
    };
    if (mode === 'incomplete') {
      await beginLocalBrowser(root, mode);
    } else {
      let rejected = false;
      try {
        await withLocalBrowser(root, mode, async () => {
          assert.ok(existsSync(lock));
          if (mode === 'throw') throw primary;
          if (mode === 'primary-save-error') { blockReceipt(); throw primary; }
          if (mode === 'complete-save-error') blockReceipt();
          if (mode === 'failed') return 'failed';
          if (mode === 'absent') return;
          return 'passed';
        });
      } catch (error) {
        rejected = true;
        if (['throw', 'primary-save-error', 'preflight-error', 'preflight-save-error'].includes(mode)) {
          assert.equal(error, primary, 'Erro primário substituído');
          console.log('PRIMARY_PRESERVED');
        } else if (mode === 'complete-save-error') {
          assert.ok(['EISDIR', 'EACCES', 'EPERM'].includes(error?.code), 'Expected filesystem write failure');
          assert.equal(error.path, receiptPath());
          console.log('SAVE_FAILURE_OBSERVED');
        } else throw error;
        process.exitCode = 1;
      }
      if (mode === 'throw' || mode.endsWith('save-error') || mode === 'preflight-error') {
        assert.ok(rejected, 'Expected failure');
      }
    }
    if (!mode.startsWith('preflight')) {
      assert.ok(existsSync(lock), 'Conclusão liberou o lock antes da saída');
      if (mode === 'passed') {
        const terminal = JSON.parse(readFileSync(receiptPath(), 'utf8'));
        assert.equal(terminal.phase, 'finished');
        assert.equal(terminal.result, 'passed');
        const contender = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
          'import { acquireLocalBrowserLock } from ' + JSON.stringify(${JSON.stringify(module)}) + '; acquireLocalBrowserLock(' + JSON.stringify(join(root, '.convex')) + ', "competitor");'],
          { encoding: 'utf8', timeout: 10000 });
        assert.notEqual(contender.status, 0);
        assert.match(contender.stderr, /Já existe uma jornada/);
      }
    }
    if (mode === 'late-error') throw primary;
    if (mode === 'exit-code') process.exitCode = 1;
  `,
  );
  const child = spawnSync(process.execPath, ["--experimental-strip-types", script], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  const runs = join(root, ".browser-results/runs");
  const receipts = readdirSync(runs);
  expect(receipts).toHaveLength(1);
  expect(existsSync(join(root, ".convex/browser.lock")), child.stderr).toBe(false);
  return { child, receipt: join(runs, receipts[0], "preflight.json") };
}

it.each([
  ["passed", "passed", "finished", false],
  ["failed", "failed", "finished", true],
  ["absent", "failed", "finished", true],
  ["throw", "failed", "finished", true],
  ["late-error", "failed", "finished", true],
  ["exit-code", "failed", "finished", true],
  ["incomplete", "incomplete", "finished", false],
  ["preflight-error", "failed", "preflight", true],
] as const)(
  "persiste o desfecho real de %s e libera somente na saída",
  (mode, result, phase, failed) => {
    const { child, receipt } = execute(mode);
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    if (failed) expect(child.status, child.stderr).not.toBe(0);
    else expect(child.status, child.stderr).toBe(0);
    const raw = readFileSync(receipt, "utf8");
    expect(raw).not.toContain("PRIVATE_SENTINEL");
    expect(JSON.parse(raw)).toMatchObject({ result, phase });
    if (mode === "throw" || mode === "preflight-error")
      expect(child.stdout).toContain("PRIMARY_PRESERVED");
  },
);

it.each(["primary-save-error", "preflight-save-error", "complete-save-error"])(
  "%s não esconde a falha nem abandona a liberação do lock",
  (mode) => {
    const { child } = execute(mode);
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).not.toBe(0);
    expect(child.stdout).toContain(
      mode === "complete-save-error" ? "SAVE_FAILURE_OBSERVED" : "PRIMARY_PRESERVED",
    );
  },
);
