import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { acquireLocalBrowserLock, probeLocalBrowser } from "../lib/local-browser.mjs";
import { localBrowserIdentity } from "../lib/local-browser-identity.mjs";
import { subprocessEnvironment } from "../lib/subprocess-environment.mjs";

const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "fnfe-browser-preflight-"));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("preflight das jornadas locais", () => {
  it("confere backend autenticado e frontend correto sem escrever dados", async () => {
    const frontendRoot = directory();
    const calls: { path: string; body: string }[] = [];
    const cloud = "http://127.0.0.1:3210";
    await probeLocalBrowser(
      {
        site: "http://localhost:5174",
        cloud,
        backendSite: "http://127.0.0.1:3211",
        deploymentName: "anonymous-test",
        adminKey: "local-test-secret",
        frontendRoot,
      },
      async (url: string, options: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push({ path, body: typeof options.body === "string" ? options.body : "" });
        if (path === "/instance_name") return new Response("anonymous-test");
        if (path === "/api/query") {
          expect(new Headers(options.headers).get("authorization")).toBe(
            "Convex local-test-secret",
          );
          return new Response(JSON.stringify({ status: "success" }));
        }
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            application: "freecorps-console",
            rootId: localBrowserIdentity(frontendRoot),
            convexUrl: cloud,
            authUrl: "http://127.0.0.1:3211",
            apiUrl: "http://127.0.0.1:3211",
          }),
        );
      },
    );
    expect(calls.map(({ path }) => path)).toEqual([
      "/instance_name",
      "/api/query",
      "/__freecorps_worktree",
    ]);
    expect(JSON.parse(calls[1].body).path).toBe("_system/frontend/listCronJobs");
  });

  it("recusa alvo remoto antes de qualquer requisição", async () => {
    let requests = 0;
    await expect(
      probeLocalBrowser(
        {
          site: "https://nfe.freecorps.com.br",
          cloud: "http://127.0.0.1:3210",
          backendSite: "http://127.0.0.1:3211",
          deploymentName: "anonymous-test",
          adminKey: "secret",
          frontendRoot: directory(),
        },
        async () => {
          requests++;
          return new Response();
        },
      ),
    ).rejects.toThrow(/loopback/);
    expect(requests).toBe(0);
  });

  it("não aceita frontend de outro worktree nem inclui a chave no erro", async () => {
    const responses = [
      new Response("anonymous-test"),
      new Response('{"status":"success"}'),
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          application: "freecorps-console",
          rootId: "other",
          convexUrl: "http://127.0.0.1:3210",
        }),
      ),
    ];
    await expect(
      probeLocalBrowser(
        {
          site: "http://localhost:5174",
          cloud: "http://127.0.0.1:3210",
          backendSite: "http://127.0.0.1:3211",
          deploymentName: "anonymous-test",
          adminKey: "never-log-me",
          frontendRoot: directory(),
        },
        async (_url: string, options: RequestInit) => {
          expect(options.redirect).toBe("error");
          expect(options.signal).toBeInstanceOf(AbortSignal);
          return responses.shift()!;
        },
      ),
    ).rejects.toThrow("O frontend não corresponde");
  });

  it.each(["authUrl", "apiUrl"])(
    "recusa %s divergente mesmo com frontend e Convex corretos",
    async (field) => {
      const frontendRoot = directory();
      const cloud = "http://127.0.0.1:3210";
      const backendSite = "http://127.0.0.1:3211";
      const responses = [
        new Response("anonymous-test"),
        new Response('{"status":"success"}'),
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            application: "freecorps-console",
            rootId: localBrowserIdentity(frontendRoot),
            convexUrl: cloud,
            authUrl: backendSite,
            apiUrl: backendSite,
            [field]: "https://outro-backend.example",
          }),
        ),
      ];
      await expect(
        probeLocalBrowser(
          {
            site: "http://localhost:5174",
            cloud,
            backendSite,
            deploymentName: "anonymous-test",
            adminKey: "secret",
            frontendRoot,
          },
          async () => responses.shift()!,
        ),
      ).rejects.toThrow("O frontend não corresponde");
    },
  );

  it("encerra uma sonda que não responde pelo timeout", async () => {
    await expect(
      probeLocalBrowser(
        {
          site: "http://localhost:5174",
          cloud: "http://127.0.0.1:3210",
          backendSite: "http://127.0.0.1:3211",
          deploymentName: "anonymous-test",
          adminKey: "secret",
          frontendRoot: directory(),
        },
        async (_url: string, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
              once: true,
            });
          }),
        30,
      ),
    ).rejects.toThrow();
  });
});

it("duas jornadas em processos distintos não adquirem o mesmo backend", () => {
  const path = directory();
  const release = acquireLocalBrowserLock(path, "owner");
  const module = pathToFileURL(resolve("scripts/lib/local-browser.mjs")).href;
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `import { acquireLocalBrowserLock } from ${JSON.stringify(module)}; acquireLocalBrowserLock(${JSON.stringify(path)}, "competitor");`,
      ],
      { encoding: "utf8", env: subprocessEnvironment(process.env), timeout: 10_000 },
    );
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("Já existe uma jornada");
    expect(JSON.parse(readFileSync(join(path, "browser.lock"), "utf8")).runId).toBe("owner");
  } finally {
    release();
  }
  acquireLocalBrowserLock(path, "next")();
});

it("lock incompleto bloqueia a jornada e permanece para inspeção", () => {
  const path = directory();
  writeFileSync(join(path, "browser.lock"), "{");
  expect(() => acquireLocalBrowserLock(path, "next")).toThrow(/interrompida/);
  expect(readFileSync(join(path, "browser.lock"), "utf8")).toBe("{");
});

it("erro anterior ao navegador deixa recibo por tentativa sem segredos", () => {
  const root = directory();
  const module = pathToFileURL(resolve("scripts/lib/local-browser.mjs")).href;
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `import { beginLocalBrowser } from ${JSON.stringify(module)}; await beginLocalBrowser(${JSON.stringify(root)}, "fixture");`,
      ],
      {
        encoding: "utf8",
        env: { ...subprocessEnvironment(process.env), PRIVATE_SENTINEL: "do-not-record" },
        timeout: 10_000,
      },
    );
    expect(child.status).not.toBe(0);
  }
  const runs = join(root, ".browser-results/runs");
  expect(readdirSync(runs)).toHaveLength(2);
  for (const run of readdirSync(runs)) {
    const raw = readFileSync(join(runs, run, "preflight.json"), "utf8");
    expect(raw).not.toContain("do-not-record");
    expect(JSON.parse(raw)).toMatchObject({ result: "failed", phase: "preflight" });
  }
});

it("a sonda do Vite e o backend em loopback passam pelo preflight real", () => {
  const root = directory();
  const module = pathToFileURL(resolve("scripts/lib/local-browser.mjs")).href;
  const plugin = pathToFileURL(resolve("apps/console/worktree-plugin.ts")).href;
  const vite = pathToFileURL(createRequire(import.meta.url).resolve("vite")).href;
  const code = `
    import assert from "node:assert/strict";
    import { createServer as httpServer } from "node:http";
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { once } from "node:events";
    import { createServer } from ${JSON.stringify(vite)};
    import { worktreePlugin } from ${JSON.stringify(plugin)};
    import { probeLocalBrowser } from ${JSON.stringify(module)};
    const root = ${JSON.stringify(root)};
    const backend = httpServer((req, res) => {
      if (req.url === "/instance_name") res.end("anonymous-fixture");
      else {
        assert.equal(req.headers.authorization, "Convex fixture-key");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({status:"success"}));
      }
    });
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    const cloud = "http://127.0.0.1:" + backend.address().port;
    writeFileSync(join(root, ".env"), ["VITE_CONVEX_URL=" + cloud, "VITE_CONVEX_SITE_URL=" + cloud, "VITE_API_URL=" + cloud].join(String.fromCharCode(10)));
    const frontend = await createServer({
      root, configFile:false, plugins:[worktreePlugin()],
      server:{host:"127.0.0.1", port:0}, optimizeDeps:{noDiscovery:true},
    });
    try {
      await frontend.listen();
      const site = "http://127.0.0.1:" + frontend.httpServer.address().port;
      const target = {site, cloud, backendSite:cloud, deploymentName:"anonymous-fixture", adminKey:"fixture-key", frontendRoot:root};
      await probeLocalBrowser(target);
      await assert.rejects(probeLocalBrowser({...target, frontendRoot:join(root,"other")}), /frontend não corresponde/);
      console.log("LOCAL_BROWSER_PROOF_PASSED");
    } finally {
      await frontend.close();
      backend.closeAllConnections();
      await new Promise(resolve => backend.close(resolve));
    }
  `;
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", code],
    {
      encoding: "utf8",
      env: subprocessEnvironment(process.env),
      timeout: 30_000,
    },
  );
  expect(child.stderr, child.stderr).not.toContain("fixture-key");
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("LOCAL_BROWSER_PROOF_PASSED");
});
