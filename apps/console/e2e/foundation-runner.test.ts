import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  run: vi.fn(),
  launch: vi.fn(),
  close: vi.fn(),
  newPage: vi.fn(),
  contextClose: vi.fn(),
  write: vi.fn(),
  fetch: vi.fn(),
  axe: vi.fn(),
}));
vi.mock("playwright", () => ({ chromium: { launch: fixture.launch } }));
vi.mock("@axe-core/playwright", () => ({ default: fixture.axe }));
vi.mock("../../../scripts/lib/local-browser.mjs", () => ({
  withLocalBrowser: fixture.run,
  localBrowserFetch: fixture.fetch,
}));
vi.mock("node:child_process", () => ({ execFileSync: () => "fixture" }));
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: fixture.write,
}));
vi.mock("../../../scripts/lib/worktree/paths.mjs", () => ({
  worktreePaths: () => ({ app: "platform" }),
}));
vi.mock("../../../scripts/lib/worktree/state.mjs", () => ({ assertLinkedWorktree: vi.fn() }));
vi.mock("../../../scripts/lib/worktree/deployment.mjs", () => ({
  readLocalConfig: () => ({}),
  localUrls: () => ({}),
}));
vi.mock("../../../scripts/lib/worktree/env-file.mjs", () => ({
  currentLocalSiteUrl: () => "http://localhost:5174",
}));
vi.mock("./local-auth-pacing.mjs", () => ({
  localAuthPacer: () => async () => {},
}));
const exitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  fixture.run.mockImplementation(async (_root, _journey, run) => run());
  fixture.close.mockResolvedValue(undefined);
  fixture.contextClose.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

it.each(["launch", "page", "page-close"])(
  "entrega erro ao callback e relatório reprovado quando %s falha",
  async (stage) => {
    const failure = new Error("Falha sintética da jornada");
    if (stage === "launch") fixture.launch.mockRejectedValue(failure);
    else {
      if (stage === "page-close") fixture.close.mockRejectedValue(new Error("Falha ao fechar"));
      fixture.newPage.mockRejectedValue(failure);
      fixture.launch.mockResolvedValue({
        newContext: async () => ({
          on: vi.fn(),
          newPage: fixture.newPage,
          close: fixture.contextClose,
        }),
        close: fixture.close,
      });
    }
    await expect(import("./foundation.mjs")).rejects.toBe(failure);
    expect(fixture.run).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      "foundation",
      expect.any(Function),
    );
    await expect(fixture.run.mock.results[0].value).rejects.toBe(failure);
    expect(JSON.parse(fixture.write.mock.calls[0][1])).toMatchObject({
      result: "failed",
      failedAfter: 0,
    });
    expect(fixture.close).toHaveBeenCalledTimes(stage === "launch" ? 0 : 1);
  },
);

// Only exercises runner control flow. These no-op UI responses and synthetic
// RPC values do not prove authentication, accessibility or an XML runtime.
function simulateCompletedJourney() {
  const locator = {
    fill: async () => {},
    click: async () => {},
    waitFor: async () => {},
    selectOption: async () => {},
    isVisible: async () => true,
    getAttribute: async () => "true",
    filter: () => locator,
  };
  const page = {
    goto: async () => {},
    waitForURL: async () => {},
    getByLabel: () => locator,
    getByRole: () => locator,
    getByText: () => locator,
    screenshot: async () => {},
    evaluate: async () => true,
    setViewportSize: async () => {},
    reload: async () => {},
    bringToFront: async () => {},
  };
  fixture.newPage.mockResolvedValue(page);
  fixture.launch.mockResolvedValue({
    newContext: async () => ({
      on: vi.fn(),
      newPage: fixture.newPage,
      close: fixture.contextClose,
    }),
    close: fixture.close,
  });
  fixture.axe.mockImplementation(function () {
    return { withTags: () => ({ analyze: async () => ({ violations: [] }) }) };
  });
  fixture.fetch.mockImplementation(async (_url, options) => {
    const { path } = JSON.parse(options.body);
    if (path === "mail:inbox") {
      return {
        json: async () => ({
          status: "success",
          value: [
            { type: "email-verification", otp: "12345678" },
            { type: "forget-password", otp: "87654321" },
          ],
        }),
      };
    }
    expect(path).toBe("xml:extract");
    return {
      json: async () => ({
        status: "success",
        value: { json: '{"items":[{"unitPrice":"12.3456789012"}]}', runtime: "v24.synthetic" },
      }),
    };
  });
}

it("retorna passed explicitamente depois de concluir e persistir a jornada simulada", async () => {
  simulateCompletedJourney();
  await import("./foundation.mjs");
  await expect(fixture.run.mock.results[0].value).resolves.toBe("passed");
  expect(fixture.close).toHaveBeenCalledTimes(1);
  expect(fixture.write).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fixture.write.mock.calls[0][1])).toMatchObject({ result: "passed" });
});

it.each(["context-close", "browser-close", "persist"])(
  "não aprova jornada simulada concluída se %s falhar",
  async (stage) => {
    simulateCompletedJourney();
    const failure = new Error(`synthetic ${stage} failure`);
    if (stage === "context-close") {
      // The old login context closes during the journey; fail only the final close.
      fixture.contextClose.mockResolvedValueOnce(undefined).mockRejectedValue(failure);
    } else if (stage === "browser-close") fixture.close.mockRejectedValue(failure);
    else
      fixture.write.mockImplementation(() => {
        throw failure;
      });

    await expect(import("./foundation.mjs")).rejects.toBe(failure);
    await expect(fixture.run.mock.results[0].value).rejects.toBe(failure);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.write).toHaveBeenCalledTimes(1);
    const report = JSON.parse(fixture.write.mock.calls[0][1]);
    expect(report.scenarios).toContain("xml-real-node-action-v24.synthetic");
    // A failed write receives the pre-write value but cannot persist a receipt.
    if (stage !== "persist") expect(report.result).toBe("failed");
  },
);
