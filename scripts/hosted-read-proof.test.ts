import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  checkHostedEnvironment,
  deniedDeployments,
  deploymentSuffix,
  failureCode,
  parseHostedArgs,
  parsePreviewKey,
  prepareCommands,
  previewChildEnv,
  readPreviewKey,
  redact,
  resolvePreviewTarget,
  verifyPreviewEnvironment,
} from "./lib/hosted-read-proof.mjs";

const root = resolve(".");
// Synthetic keys built at runtime, so no key-shaped literal reaches the repository scanner.
const secret = "s".repeat(24) + "Q".repeat(24);
const projectKey = ["preview", "freecorps", "freecorpsnfe"].join(":") + "|" + secret;
const deploymentKey = ["preview", "happy-otter-123"].join(":") + "|" + secret;
const adminKey = ["preview", "happy-otter-123"].join(":") + "|" + "a".repeat(48);
const denied = ["modest-seal-118", "elated-possum-295"];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hosted-read-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const keyFile = async (content: string, name = "preview.env") => {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
};
const code = async (promise: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    return (error as Error).message;
  }
  return "accepted";
};

describe("argumentos", () => {
  it("aceita a forma documentada em qualquer ordem", () => {
    expect(
      parseHostedArgs([
        "--read-node",
        "f.json",
        "--key-file",
        "/k",
        "--preview-name",
        "fnfe-642-a",
      ]),
    ).toEqual({
      keyFile: "/k",
      previewName: "fnfe-642-a",
      prepare: false,
      headroom: false,
      node: true,
      fixtures: "f.json",
    });
    expect(parseHostedArgs(["--key-file", "/k", "--read", "f.json"])).toMatchObject({
      node: false,
      previewName: undefined,
    });
    expect(parseHostedArgs(["--headroom", "--key-file", "/k"])).toMatchObject({
      headroom: true,
      prepare: false,
      fixtures: undefined,
    });
  });
  it("recusa modo ausente ou duplo, flags estranhas, repetidas ou sem valor e nomes de preview fora do prefixo", async () => {
    for (const argv of [
      [],
      ["--key-file", "/k"],
      ["--key-file", "/k", "--read", "f", "--read-node", "f"],
      ["--key-file", "/k", "--headroom", "--read", "f"],
      ["--key-file", "/k", "--headroom", "--headroom"],
      ["--key-file", "/k", "--read", "f", "--prod", "x"],
      ["--key-file", "/k", "--key-file", "/j", "--read", "f"],
      ["--key-file", "--read", "f"],
      ["--key-file", "/k", "--read", "f", "--url", "https://happy-otter-123.convex.cloud"],
    ])
      expect(await code(() => parseHostedArgs(argv))).toBe("HOSTED_ARGUMENTS_INVALID");
    for (const name of ["main", "fnfe-642-", "fnfe-642-A", "production", "fnfe-642-a b"])
      expect(
        await code(() =>
          parseHostedArgs(["--key-file", "/k", "--read", "f", "--preview-name", name]),
        ),
      ).toBe("PREVIEW_NAME_INVALID");
  });
  it("prepara só com nome de preview e um único modo", async () => {
    expect(
      parseHostedArgs(["--prepare", "--key-file", "/k", "--preview-name", "fnfe-642-a"]),
    ).toMatchObject({ prepare: true, previewName: "fnfe-642-a", fixtures: undefined });
    expect(await code(() => parseHostedArgs(["--prepare", "--key-file", "/k"]))).toBe(
      "PREVIEW_NAME_REQUIRED",
    );
    for (const argv of [
      ["--prepare", "--prepare", "--key-file", "/k", "--preview-name", "fnfe-642-a"],
      ["--prepare", "--key-file", "/k", "--preview-name", "fnfe-642-a", "--read", "f"],
    ])
      expect(await code(() => parseHostedArgs(argv))).toBe("HOSTED_ARGUMENTS_INVALID");
  });
  it("monta o deploy e as três variáveis sempre no preview nomeado, com a chave só por arquivo", async () => {
    const commands = prepareCommands(parsePreviewKey(projectKey), "/k.env", "fnfe-642-a");
    expect(commands).toEqual([
      [
        "deploy",
        "--env-file",
        "/k.env",
        "--preview-create",
        "fnfe-642-a",
        "--typecheck",
        "disable",
        "--codegen",
        "disable",
        "--yes",
      ],
      [
        "env",
        "set",
        "--env-file",
        "/k.env",
        "--preview-name",
        "fnfe-642-a",
        "FNFE_HOSTED_PROOF",
        "preview-642",
      ],
      ["env", "set", "--env-file", "/k.env", "--preview-name", "fnfe-642-a", "FNFE_CRONS", "off"],
      [
        "env",
        "set",
        "--env-file",
        "/k.env",
        "--preview-name",
        "fnfe-642-a",
        "FISCAL_ENV",
        "disabled",
      ],
    ]);
    expect(commands.flat().join(" ")).not.toContain(secret);
    // A deployment key cannot create previews; a missing name never falls back to a default.
    expect(
      await code(() => prepareCommands(parsePreviewKey(deploymentKey), "/k", "fnfe-642-a")),
    ).toBe("PROJECT_PREVIEW_KEY_REQUIRED");
    expect(await code(() => prepareCommands(parsePreviewKey(projectKey), "/k", undefined))).toBe(
      "PREVIEW_NAME_REQUIRED",
    );
    expect(
      previewChildEnv({
        PATH: "/bin",
        CONVEX_DEPLOY_KEY: "x",
        CONVEX_DEPLOYMENT: "prod:x",
        VALIDATION_CONVEX_DEPLOY_KEY: "x",
        FNFE_HOSTED_PROOF: "x",
        NODE_OPTIONS: "--require x",
      }),
    ).toEqual({ PATH: "/bin" });
  });
  it("recusa chave ou seletor Convex herdado do terminal", async () => {
    expect(await code(() => checkHostedEnvironment({}))).toBe("accepted");
    for (const name of [
      "CONVEX_DEPLOY_KEY",
      "CONVEX_DEPLOYMENT",
      "CONVEX_SELF_HOSTED_URL",
      "CONVEX_SELF_HOSTED_ADMIN_KEY",
      "CONVEX_PROVISION_HOST",
    ])
      expect(await code(() => checkHostedEnvironment({ [name]: "x" }))).toBe(
        "INHERITED_CONVEX_SELECTOR",
      );
  });
});

describe("arquivo da chave", () => {
  it("aceita só CONVEX_DEPLOY_KEY de preview, numa linha, fora do checkout", async () => {
    expect(readPreviewKey(await keyFile(`CONVEX_DEPLOY_KEY=${projectKey}\r\n`), root)).toEqual({
      kind: "project",
      key: projectKey,
      teamSlug: "freecorps",
      projectSlug: "freecorpsnfe",
    });
    expect(readPreviewKey(await keyFile(`CONVEX_DEPLOY_KEY=${deploymentKey}`), root)).toEqual({
      kind: "deployment",
      key: deploymentKey,
      deploymentName: "happy-otter-123",
    });
  });
  it("recusa chaves de produção, dev, projeto, legadas e malformadas sem ecoar o valor", async () => {
    for (const key of [
      `prod:elated-possum-295|${secret}`,
      `dev:modest-seal-118|${secret}`,
      `project:freecorps:freecorpsnfe|${secret}`,
      secret,
      `preview:|${secret}`,
      `preview:a:b:c|${secret}`,
      `preview:Happy-Otter-1|${secret}`,
      "preview:happy-otter-123|short",
      `preview:happy-otter-123|${secret}|x`,
      `custom:happy-otter-123|${secret}`,
    ]) {
      const message = await code(() => parsePreviewKey(key));
      expect(message).toBe("PREVIEW_KEY_REQUIRED");
      const file = await keyFile(`CONVEX_DEPLOY_KEY=${key}\n`);
      expect(await code(() => readPreviewKey(file, root))).toBe("PREVIEW_KEY_REQUIRED");
    }
  });
  it("recusa caminho relativo, arquivo ausente, pasta, formato diferente e arquivo no checkout", async () => {
    expect(await code(() => readPreviewKey("preview.env", root))).toBe("KEY_FILE_NOT_ABSOLUTE");
    expect(await code(() => readPreviewKey(join(dir, "missing.env"), root))).toBe(
      "KEY_FILE_UNREADABLE",
    );
    await mkdir(join(dir, "folder"));
    expect(await code(() => readPreviewKey(join(dir, "folder"), root))).toBe("KEY_FILE_INVALID");
    for (const content of [
      projectKey,
      `CONVEX_DEPLOY_KEY=${projectKey}\nCONVEX_DEPLOYMENT=prod:elated-possum-295\n`,
      `CONVEX_DEPLOY_KEY="${projectKey}"`,
      `export CONVEX_DEPLOY_KEY=${projectKey}`,
      "",
      "x".repeat(5000),
    ])
      expect(await code(async () => readPreviewKey(await keyFile(content), root))).toMatch(
        /^(KEY_FILE_FORMAT|KEY_FILE_INVALID|PREVIEW_KEY_REQUIRED)$/,
      );
    // A file inside the checkout is refused even with a valid key; its root is a temp dir here.
    const inside = await keyFile(`CONVEX_DEPLOY_KEY=${projectKey}`);
    expect(await code(() => readPreviewKey(inside, dir))).toBe("KEY_FILE_INSIDE_CHECKOUT");
  });
  it("recusa arquivo dentro de qualquer árvore Git, com .git pasta ou arquivo de worktree", async () => {
    for (const [repo, makeGit] of [
      ["repo", (path: string) => mkdir(path)],
      ["worktree", (path: string) => writeFile(path, "gitdir: /elsewhere\n")],
    ] as const) {
      await mkdir(join(dir, repo, "deep", "er"), { recursive: true });
      await makeGit(join(dir, repo, ".git"));
      const path = join(dir, repo, "deep", "er", "preview.env");
      await writeFile(path, `CONVEX_DEPLOY_KEY=${projectKey}`);
      expect(await code(() => readPreviewKey(path, root))).toBe("KEY_FILE_INSIDE_GIT");
    }
    // The same file outside any tree is accepted.
    expect(readPreviewKey(await keyFile(`CONVEX_DEPLOY_KEY=${projectKey}`), root).kind).toBe(
      "project",
    );
  });
});

describe("alvo", () => {
  const authorized = (body: unknown, status = 200) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    };
    return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
  };
  const preview = {
    deploymentType: "preview",
    deploymentName: "happy-otter-123",
    url: "https://happy-otter-123.convex.cloud",
    adminKey,
  };

  it("deriva a URL da chave de um deployment de preview, sem rede", async () => {
    const { calls, fetchImpl } = authorized({});
    expect(
      await resolvePreviewTarget(parsePreviewKey(deploymentKey), undefined, {
        fetchImpl,
        clientVersion: "1.48.0",
        denied,
      }),
    ).toEqual({
      deploymentName: "happy-otter-123",
      url: "https://happy-otter-123.convex.cloud",
      adminKey: deploymentKey,
    });
    expect(calls).toHaveLength(0);
    expect(
      await code(
        resolvePreviewTarget(parsePreviewKey(deploymentKey), "fnfe-642-a", {
          fetchImpl,
          clientVersion: "1.48.0",
          denied,
        }),
      ),
    ).toBe("PREVIEW_NAME_UNEXPECTED");
  });
  it("troca a chave do projeto pela do preview nomeado e confere tipo, URL e chave", async () => {
    const { calls, fetchImpl } = authorized(preview);
    const parsed = parsePreviewKey(projectKey);
    expect(
      await resolvePreviewTarget(parsed, "fnfe-642-a", {
        fetchImpl,
        clientVersion: "1.48.0",
        denied,
      }),
    ).toEqual({ deploymentName: preview.deploymentName, url: preview.url, adminKey });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.convex.dev/api/deployment/authorize_preview");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      previewName: "fnfe-642-a",
      projectSelection: {
        kind: "teamAndProjectSlugs",
        teamSlug: "freecorps",
        projectSlug: "freecorpsnfe",
      },
    });
    expect(
      await code(
        resolvePreviewTarget(parsed, undefined, { fetchImpl, clientVersion: "1", denied }),
      ),
    ).toBe("PREVIEW_NAME_REQUIRED");
    // The API may answer with the project key itself; only that exact key is accepted.
    expect(
      await resolvePreviewTarget(parsed, "fnfe-642-a", {
        fetchImpl: authorized({ ...preview, adminKey: projectKey }).fetchImpl,
        clientVersion: "1.48.0",
        denied,
      }),
    ).toEqual({ deploymentName: preview.deploymentName, url: preview.url, adminKey: projectKey });
  });
  it("recusa resposta que não é o mesmo preview, alvo proibido e falha de autorização", async () => {
    const parsed = parsePreviewKey(projectKey);
    for (const body of [
      { ...preview, deploymentType: "prod" },
      { ...preview, deploymentType: "dev" },
      { ...preview, url: "https://happy-otter-123.convex.site" },
      { ...preview, url: "https://evil.example/happy-otter-123.convex.cloud" },
      { ...preview, url: "http://happy-otter-123.convex.cloud" },
      { ...preview, url: "https://other-otter-9.convex.cloud" },
      { ...preview, adminKey: `prod:happy-otter-123|${secret}` },
      { ...preview, adminKey: `preview:other-otter-9|${secret}` },
      { ...preview, adminKey: `preview:freecorps:other|${secret}` },
      {
        ...preview,
        deploymentName: "modest-seal-118",
        url: "https://modest-seal-118.convex.cloud",
        adminKey: `preview:modest-seal-118|${secret}`,
      },
      null,
    ])
      expect(
        await code(
          resolvePreviewTarget(parsed, "fnfe-642-a", {
            ...authorized(body),
            clientVersion: "1",
            denied,
          }),
        ),
      ).toBe("PREVIEW_TARGET_INVALID");
    expect(
      await code(
        resolvePreviewTarget(parsed, "fnfe-642-a", {
          ...authorized({ error: secret }, 401),
          clientVersion: "1",
          denied,
        }),
      ),
    ).toBe("PREVIEW_AUTHORIZATION_FAILED");
    const throwing = (async () => {
      throw new Error(`network failed for ${projectKey}`);
    }) as unknown as typeof fetch;
    const message = await code(
      resolvePreviewTarget(parsed, "fnfe-642-a", {
        fetchImpl: throwing,
        clientVersion: "1",
        denied,
      }),
    );
    expect(message).toBe("PREVIEW_AUTHORIZATION_FAILED");
    expect(
      await code(
        resolvePreviewTarget(parsePreviewKey(`preview:modest-seal-118|${secret}`), undefined, {
          clientVersion: "1",
          denied,
        }),
      ),
    ).toBe("PREVIEW_TARGET_INVALID");
  });
  it("lê os deployments proibidos dos manifestos versionados", () => {
    expect(deniedDeployments(root)).toEqual(
      expect.arrayContaining(["modest-seal-118", "elated-possum-295"]),
    );
    expect(deploymentSuffix("happy-otter-123")).toBe("123");
  });
});

describe("ambiente do preview", () => {
  const backend = (variables: Record<string, string>, crons: unknown[] = []) => {
    const paths: string[] = [];
    const call = async (_kind: string, path: string) => {
      paths.push(path);
      return path === "_system/cli/queryEnvironmentVariables"
        ? Object.entries(variables).map(([name, value]) => ({ name, value }))
        : crons;
    };
    return { paths, call };
  };
  const expected = { FNFE_HOSTED_PROOF: "preview-642", FNFE_CRONS: "off", FISCAL_ENV: "disabled" };
  it("aceita exatamente o marcador, crons desligados e fiscal desabilitado", async () => {
    const { paths, call } = backend(expected);
    expect(await code(verifyPreviewEnvironment(call))).toBe("accepted");
    expect(paths).toEqual([
      "_system/cli/queryEnvironmentVariables",
      "_system/frontend/listCronJobs",
    ]);
  });
  it("recusa perfil da plataforma, credenciais, valores divergentes e crons registrados", async () => {
    const secretValue = "x".repeat(32);
    for (const [variables, names] of [
      [{}, "FISCAL_ENV,FNFE_CRONS,FNFE_HOSTED_PROOF"],
      [{ ...expected, APP_ENV: "development" }, "APP_ENV"],
      [{ ...expected, BETTER_AUTH_SECRET: secretValue }, "BETTER_AUTH_SECRET"],
      [{ ...expected, FNFE_HOSTED_PROOF: "yes" }, "FNFE_HOSTED_PROOF"],
      [{ ...expected, FISCAL_ENV: "homologation" }, "FISCAL_ENV"],
      [{ FNFE_HOSTED_PROOF: "preview-642", FNFE_CRONS: "off" }, "FISCAL_ENV"],
      [{ ...expected, "bad name": secretValue }, "?"],
    ] as const) {
      // Names only: a value, even a secret one, never reaches the message.
      const message = await code(verifyPreviewEnvironment(backend(variables).call));
      expect(message).toBe(`PREVIEW_ENVIRONMENT_INVALID ${names}`);
      expect(message).not.toContain(secretValue);
    }
    expect(await code(verifyPreviewEnvironment(backend(expected, [{ name: "x" }]).call))).toBe(
      "PREVIEW_CRONS_PRESENT",
    );
  });
});

describe("redação", () => {
  it("remove a chave conhecida e qualquer valor com forma de chave Convex", () => {
    const text = `falhou ${projectKey} e ${adminKey}; prod:a-b-1|${secret}, project:t:p|${secret}`;
    const clean = redact(text, [projectKey]);
    for (const value of [projectKey, adminKey, secret]) expect(clean).not.toContain(value);
    expect(clean).toContain("falhou [redigido]");
  });
  it("publica só códigos controlados", () => {
    expect(failureCode(new Error("READ_PROOF_FAILED"))).toBe("READ_PROOF_FAILED");
    expect(failureCode(new Error(`Unauthorized: ${projectKey}`), [projectKey])).toBe(
      "HOSTED_PROOF_FAILED",
    );
    expect(failureCode("raw")).toBe("HOSTED_PROOF_FAILED");
  });
});

describe("CLI", () => {
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("CONVEX_")),
    );
    try {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ["scripts/prove-document-content-hosted.mjs", ...args],
        { cwd: root, env: { ...clean, ...env } },
      );
      return { status: 0, output: stdout + stderr };
    } catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string };
      return { status: failure.code, output: failure.stdout + failure.stderr };
    }
  };

  it("recusa antes da rede e sem imprimir a chave", async () => {
    const fixtures = join(dir, "fixtures.json");
    await writeFile(fixtures, "[]");
    const production = await keyFile(`CONVEX_DEPLOY_KEY=prod:elated-possum-295|${secret}`);
    const preview = await keyFile(`CONVEX_DEPLOY_KEY=${projectKey}`, "preview2.env");
    for (const [args, env, expected] of [
      [["--read", fixtures], {}, "HOSTED_ARGUMENTS_INVALID"],
      [
        ["--key-file", preview, "--read", fixtures],
        { CONVEX_DEPLOY_KEY: projectKey },
        "INHERITED_CONVEX_SELECTOR",
      ],
      // Fixtures are checked before the key file is even opened.
      [["--key-file", production, "--read", fixtures], {}, "READ_FIXTURES_INVALID"],
    ] as const) {
      const result = await run([...args], env);
      expect(result.status).toBe(1);
      expect(result.output.trim()).toBe(expected);
      expect(result.output).not.toContain(secret);
    }
    // With a complete synthetic matrix, a production key is the refusal, still offline.
    const valid = join(dir, "valid.json");
    await writeFile(
      valid,
      JSON.stringify(
        ["invoice", "service-invoice-batch", ...Array<string>(3).fill("service-invoice")].map(
          (kind, index) => ({
            model: kind === "invoice" ? "55" : "nfse",
            kind,
            content: {
              result: JSON.stringify({
                document: { kind, number: String(index) },
                documentCount: 3,
              }),
              items: [],
              ...(kind === "invoice" ? { fiscalEvidence: "{}", snapshot: "{}" } : {}),
            },
          }),
        ),
      ),
    );
    const refused = await run(["--key-file", production, "--read-node", valid]);
    expect(refused).toEqual({ status: 1, output: "PREVIEW_KEY_REQUIRED\n" });
    expect((await run(["--help"])).output).toContain("content:prove-hosted --key-file");
  });
});
