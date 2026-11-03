import { describe, expect, it, vi } from "vite-plus/test";
import { startTermsOfUseNotice } from "./lib/terms-notice.mjs";

/** A silent log that keeps what the publisher would print. */
function log() {
  return { log: vi.fn(), warn: vi.fn() };
}

describe("aviso dos termos de uso depois da publicação (#594)", () => {
  it("registra o desfecho da chamada ao deployment publicado", async () => {
    const out = log();
    const mutation = vi.fn(async () => ({ version: "1.0", outcome: "started" }));
    expect(await startTermsOfUseNotice(mutation, out)).toEqual({
      state: "started",
      version: "1.0",
    });
    expect(mutation).toHaveBeenCalledWith("termsOfUseNotice:start");
    expect(out.log).toHaveBeenCalledWith("terms of use notice: started (1.0)");
    expect(out.warn).not.toHaveBeenCalled();
  });

  it("não reprova a publicação quando a chamada falha, e a próxima retoma", async () => {
    const out = log();
    // The provider error may carry a credential: it is neither returned nor printed.
    const failing = vi.fn(async () => {
      throw new Error("backend 500 token=secret-value");
    });
    await expect(startTermsOfUseNotice(failing, out)).resolves.toEqual({
      state: "failed",
      version: null,
    });
    expect(JSON.stringify([out.log.mock.calls, out.warn.mock.calls])).not.toContain("secret-value");
    expect(out.warn).toHaveBeenCalledTimes(1);
    // An answer it does not understand is also a recorded failure, not a crash.
    expect(await startTermsOfUseNotice(async () => ({ outcome: "?" }), out)).toEqual({
      state: "failed",
      version: null,
    });
    // The next publication calls again; the mutation itself resumes or finds the sweep done.
    expect(
      await startTermsOfUseNotice(async () => ({ version: "1.0", outcome: "resumed" }), out),
    ).toEqual({ state: "resumed", version: "1.0" });
    expect(
      await startTermsOfUseNotice(async () => ({ version: null, outcome: "none" }), out),
    ).toEqual({ state: "none", version: null });
  });
});
