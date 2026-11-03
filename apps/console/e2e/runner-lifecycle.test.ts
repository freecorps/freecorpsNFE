import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const edge = vi.hoisted(() => ({
  run: vi.fn(),
  config: vi.fn(),
  reference: vi.fn(),
  git: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  launch: vi.fn(),
  newContext: vi.fn(),
  newPage: vi.fn(),
  browserClose: vi.fn(),
  contextClose: vi.fn(),
  goto: vi.fn(),
  screenshot: vi.fn(),
  pageUrl: vi.fn(),
  video: vi.fn(),
  fetch: vi.fn(),
  rpc: vi.fn(),
}));

// The callback is executed unchanged. Receipt/lock semantics belong to the real
// helper's subprocess tests; here we observe what each real consumer hands it.
vi.mock("../../../scripts/lib/local-browser.mjs", () => ({
  withLocalBrowser: edge.run,
  localBrowserFetch: edge.fetch,
}));
vi.mock("playwright", () => ({ chromium: { launch: edge.launch } }));
vi.mock("@axe-core/playwright", () => ({ default: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: edge.git }));
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  readFileSync: edge.read,
  writeFileSync: edge.write,
}));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));
vi.mock("../../../scripts/lib/worktree/paths.mjs", () => ({
  worktreePaths: () => ({ app: "platform" }),
}));
vi.mock("../../../scripts/lib/worktree/state.mjs", () => ({ assertLinkedWorktree: vi.fn() }));
vi.mock("../../../scripts/lib/worktree/deployment.mjs", () => ({
  readLocalConfig: edge.config,
  localUrls: () => ({ cloud: "http://localhost:3210" }),
}));
vi.mock("../../../scripts/lib/worktree/env-file.mjs", () => ({
  currentLocalSiteUrl: () => "http://localhost:5174",
}));
vi.mock("../../../scripts/lib/reference-local.mjs", () => ({ referenceLocal: edge.reference }));
vi.mock("./local-auth-pacing.mjs", () => ({ localAuthPacer: () => async () => {} }));
// These packages are not exercised before the injected first-action failure.
vi.mock("../../../packages/fiscal-nfe/dist/index.js", () => ({ processNfe: vi.fn() }));
vi.mock("../../../packages/sdk/dist/index.js", () => ({ FreecorpsClient: vi.fn() }));
vi.mock("../../../tests/helpers/certificates.ts", () => ({ syntheticCertificate: vi.fn() }));
vi.mock("../../../tests/helpers/distribution.ts", () => ({ distributionXml: vi.fn() }));
vi.mock("../../../tests/helpers/nfe-corpus.ts", () => ({ fixture: vi.fn() }));

const consumers = [
  { name: "foundation", load: () => import("./foundation.mjs"), rethrows: true },
  { name: "imports", load: () => import("./imports.mjs"), rethrows: true },
  { name: "issuances", load: () => import("./issuances.mjs"), rethrows: true },
  { name: "references", load: () => import("./references.mjs"), rethrows: true },
  { name: "registry", load: () => import("./registry.mjs"), rethrows: true },
  { name: "organizations", load: () => import("./organizations.mjs"), rethrows: false },
  { name: "companies", load: () => import("./companies.mjs"), rethrows: false },
  { name: "keys", load: () => import("./keys.mjs"), rethrows: false },
  { name: "operations", load: () => import("./operations.mjs"), rethrows: false },
  { name: "certificates", load: () => import("./certificates.mjs"), rethrows: false },
  { name: "captures", load: () => import("./captures.mjs"), rethrows: false },
];
const exitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  edge.run.mockImplementation(async (_root, _journey, run) => run());
  edge.config.mockReturnValue({});
  edge.reference.mockReturnValue({
    site: "http://localhost:5174",
    urls: { cloud: "http://localhost:3210" },
    rpc: edge.rpc,
  });
  edge.git.mockReturnValue("fixture.ts");
  edge.read.mockReturnValue(Buffer.from("synthetic source"));
  edge.browserClose.mockResolvedValue(undefined);
  edge.contextClose.mockResolvedValue(undefined);
  edge.screenshot.mockResolvedValue(undefined);
  edge.pageUrl.mockReturnValue("http://localhost:5174/app/synthetic");
  edge.video.mockReturnValue(null);
  const page = {
    goto: edge.goto,
    screenshot: edge.screenshot,
    url: edge.pageUrl,
    on: vi.fn(),
    setDefaultTimeout: vi.fn(),
    video: edge.video,
    locator: () => ({ innerText: async () => "", allTextContents: async () => [] }),
    getByRole: () => ({ allTextContents: async () => [] }),
  };
  edge.newPage.mockResolvedValue(page);
  edge.newContext.mockResolvedValue({
    newPage: edge.newPage,
    close: edge.contextClose,
    on: vi.fn(),
    pages: () => (edge.newPage.mock.results.length ? [page] : []),
  });
  edge.launch.mockResolvedValue({ newContext: edge.newContext, close: edge.browserClose });
  const unexpectedNetwork = () => {
    throw new Error("Unexpected network call in the isolated runner test");
  };
  edge.fetch.mockImplementation(async (_url, options) => {
    // imports checks deployment readiness before its first browser navigation.
    if (JSON.parse(options.body).path !== "testing/importProof:ready") unexpectedNetwork();
    return { json: async () => ({ status: "success", value: "imports-published-history/2" }) };
  });
  edge.rpc.mockImplementation(unexpectedNetwork);
  vi.stubGlobal("fetch", vi.fn(unexpectedNetwork));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(consumers)("$name: execução real com bordas simuladas", (consumer) => {
  it.each(["config", "metadata"])("protege falha de %s anterior ao launch", async (stage) => {
    const primary = new Error(`synthetic ${stage}`);
    const fail = () => {
      throw primary;
    };
    if (stage === "config") {
      edge.config.mockImplementation(fail);
      edge.reference.mockImplementation(fail);
    } else edge.git.mockImplementation(fail);

    await expect(consumer.load()).rejects.toBe(primary);
    expect(edge.run).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      consumer.name,
      expect.any(Function),
    );
    await expect(edge.run.mock.results[0].value).rejects.toBe(primary);
    expect(edge.launch).not.toHaveBeenCalled();
    expect(edge.browserClose).not.toHaveBeenCalled();
    expect(edge.fetch).not.toHaveBeenCalled();
    expect(edge.rpc).not.toHaveBeenCalled();
  });

  it.each(["launch", "context", "page", "action", "close", "persist"])(
    "preserva a falha primária e tenta finalizar quando falha %s",
    async (stage) => {
      const primary = new Error("synthetic primary failure");
      const secondary = new Error("synthetic secondary failure");
      if (stage === "launch") edge.launch.mockRejectedValue(primary);
      else if (stage === "context") edge.newContext.mockRejectedValue(primary);
      else if (stage === "page") edge.newPage.mockRejectedValue(primary);
      else edge.goto.mockRejectedValue(primary);
      if (stage === "close") {
        edge.contextClose.mockRejectedValue(secondary);
        edge.browserClose.mockRejectedValue(secondary);
      }
      if (stage === "persist")
        edge.write.mockImplementation(() => {
          throw secondary;
        });

      const outcome = await consumer.load().then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      expect(edge.run).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        consumer.name,
        expect.any(Function),
      );
      if (outcome.status === "rejected") expect(outcome.error).toBe(primary);
      else {
        expect(consumer.rethrows).toBe(false);
        await expect(edge.run.mock.results[0].value).resolves.toBe("failed");
      }
      expect(edge.browserClose).toHaveBeenCalledTimes(stage === "launch" ? 0 : 1);
      expect(edge.contextClose).toHaveBeenCalledTimes(
        ["launch", "context"].includes(stage) ? 0 : 1,
      );
      expect(edge.write).toHaveBeenCalledTimes(1);
      expect(JSON.parse(edge.write.mock.calls[0][1])).toMatchObject({ result: "failed" });
      if (!["launch", "context", "page"].includes(stage))
        expect(edge.goto).toHaveBeenCalledTimes(1);
      expect(edge.fetch).toHaveBeenCalledTimes(
        consumer.name === "imports" && !["launch", "context", "page"].includes(stage) ? 1 : 0,
      );
      expect(edge.rpc).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe.each(consumers.filter(({ name }) => !["references", "keys"].includes(name)))(
  "$name: diagnóstico secundário",
  (consumer) => {
    it("não substitui a falha da jornada nem impede fechamento e relatório", async () => {
      const primary = new Error("synthetic journey failure");
      const diagnostic = new Error("synthetic diagnostic failure");
      edge.goto.mockRejectedValue(primary);
      // Throw synchronously as well: chaining .catch on a screenshot promise
      // alone cannot protect URL extraction or a synchronously failing API.
      edge.screenshot.mockImplementation(() => {
        throw diagnostic;
      });
      edge.pageUrl.mockImplementation(() => {
        throw diagnostic;
      });
      const outcome = await consumer.load().then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      expect(edge.goto).toHaveBeenCalledTimes(1);
      expect(edge.screenshot.mock.calls.length + edge.pageUrl.mock.calls.length).toBeGreaterThan(0);
      if (outcome.status === "rejected") expect(outcome.error).toBe(primary);
      else {
        expect(consumer.rethrows).toBe(false);
        await expect(edge.run.mock.results[0].value).resolves.toBe("failed");
      }
      expect(edge.browserClose).toHaveBeenCalledTimes(1);
      expect(edge.write).toHaveBeenCalledTimes(1);
      expect(JSON.parse(edge.write.mock.calls[0][1])).toMatchObject({ result: "failed" });
    });
  },
);

describe.each(consumers)("$name: valores lançados sem Error", (consumer) => {
  it.each([undefined, null, "synthetic thrown value"])(
    "preserva o diagnóstico e finaliza os recursos para %s",
    async (primary) => {
      edge.goto.mockRejectedValue(primary);
      if (consumer.rethrows) await expect(consumer.load()).rejects.toBe(primary);
      else {
        await consumer.load();
        await expect(edge.run.mock.results[0].value).resolves.toBe("failed");
      }
      const report = JSON.parse(edge.write.mock.calls[0][1]);
      expect(report.result).toBe("failed");
      if (consumer.name === "foundation") {
        expect(report.failedAfter).toBe(0);
        expect(report).not.toHaveProperty("error");
      } else if (["companies", "organizations"].includes(consumer.name)) {
        expect(report.failure).toBe("UnknownError");
        expect(report.pages).toHaveLength(1);
      } else if (consumer.name === "keys") {
        expect(report.failure).toEqual({ name: "UnknownError", message: String(primary) });
      } else {
        expect(report.error).toBe(
          ["captures", "certificates"].includes(consumer.name) ? "unknown" : String(primary),
        );
      }
      if (!["references", "keys", "companies", "organizations"].includes(consumer.name))
        expect(edge.screenshot).toHaveBeenCalledTimes(1);
      expect(edge.contextClose).toHaveBeenCalledTimes(1);
      expect(edge.browserClose).toHaveBeenCalledTimes(1);
    },
  );
});

it("imports preserva falha da sonda anterior à navegação e fecha os recursos", async () => {
  const primary = new Error("synthetic readiness failure");
  edge.fetch.mockRejectedValue(primary);
  await expect(import("./imports.mjs")).rejects.toBe(primary);
  await expect(edge.run.mock.results[0].value).rejects.toBe(primary);
  expect(edge.goto).not.toHaveBeenCalled();
  expect(edge.contextClose).toHaveBeenCalledTimes(1);
  expect(edge.browserClose).toHaveBeenCalledTimes(1);
  expect(JSON.parse(edge.write.mock.calls[0][1])).toMatchObject({ result: "failed" });
});

it("imports tenta fechar o navegador e persistir mesmo se salvar o vídeo falhar", async () => {
  const primary = new Error("synthetic journey failure");
  const saveAs = vi.fn().mockRejectedValue(new Error("synthetic video failure"));
  edge.goto.mockRejectedValue(primary);
  edge.video.mockReturnValue({ saveAs });
  await expect(import("./imports.mjs")).rejects.toBe(primary);
  expect(saveAs).toHaveBeenCalledTimes(1);
  expect(edge.contextClose).toHaveBeenCalledTimes(1);
  expect(edge.browserClose).toHaveBeenCalledTimes(1);
  expect(JSON.parse(edge.write.mock.calls[0][1])).toMatchObject({ result: "failed" });
});

it.each(consumers.filter(({ name }) => ["imports", "keys"].includes(name)))(
  "$name finaliza recursos e relatório se o fingerprint final falhar",
  async (consumer) => {
    const primary = new Error("synthetic journey failure");
    const fingerprint = new Error("synthetic final fingerprint failure");
    edge.goto.mockImplementation(async () => {
      // Initial metadata has already succeeded. Only final source reads fail.
      edge.git.mockImplementation(() => {
        throw fingerprint;
      });
      throw primary;
    });
    if (consumer.rethrows) await expect(consumer.load()).rejects.toBe(primary);
    else {
      await consumer.load();
      await expect(edge.run.mock.results[0].value).resolves.toBe("failed");
    }
    expect(
      edge.git.mock.results.some(
        (result) => result.type === "throw" && result.value === fingerprint,
      ),
    ).toBe(true);
    expect(edge.contextClose).toHaveBeenCalledTimes(1);
    expect(edge.browserClose).toHaveBeenCalledTimes(1);
    expect(JSON.parse(edge.write.mock.calls[0][1])).toMatchObject({ result: "failed" });
  },
);
