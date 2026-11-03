// @vitest-environment jsdom
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useAsyncAction } from "./async-action";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const describeFailure = (error: unknown) =>
  error instanceof Error ? `Falhou: ${error.message}` : "Falhou";

describe("useAsyncAction", () => {
  it("sucesso libera o estado ocupado e entrega o resultado ao chamador", async () => {
    const { result } = renderHook(() => useAsyncAction(describeFailure)),
      work = deferred<number>();
    const done = vi.fn();
    let request!: Promise<string>;
    act(() => {
      request = result.current.run(() => work.promise, { done });
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      work.resolve(7);
      expect(await request).toBe("");
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe("");
    expect(done).toHaveBeenCalledWith(7);
  });

  it("rejeição libera o estado ocupado, mostra o motivo e permite tentar de novo", async () => {
    const { result } = renderHook(() => useAsyncAction(describeFailure));
    await act(async () => {
      expect(await result.current.run(() => Promise.reject(new Error("rede")))).toBe(
        "Falhou: rede",
      );
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe("Falhou: rede");
    await act(async () => {
      expect(await result.current.run(() => Promise.resolve())).toBe("");
    });
    expect(result.current.error).toBe("");
  });

  it("uma confirmação com mensagem própria recebe a falha sem repeti-la na página", async () => {
    const { result } = renderHook(() => useAsyncAction(describeFailure));
    await act(async () => {
      expect(
        await result.current.run(() => Promise.reject(new Error("versão")), { quiet: true }),
      ).toBe("Falhou: versão");
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe("");
  });

  it("depois de desmontar, nem sucesso nem falha tardios chegam à tela", async () => {
    const { result, unmount } = renderHook(() => useAsyncAction(describeFailure)),
      ok = deferred<string>(),
      failed = deferred<string>();
    const done = vi.fn();
    let first!: Promise<string>, second!: Promise<string>;
    act(() => {
      first = result.current.run(() => ok.promise, { done });
    });
    unmount();
    ok.resolve("synthetic");
    expect(await first).toBe("");
    expect(done).not.toHaveBeenCalled();
    // A run started by a stale reference also stays out of the screen.
    second = result.current.run(() => failed.promise);
    failed.reject(new Error("tarde"));
    expect(await second).toBe("Falhou: tarde");
  });

  it("a resposta da organização anterior não aparece na que entrou", async () => {
    // The organization layout remounts its pages by slug and membership version.
    const work = deferred<string>(),
      done = vi.fn();
    const first = renderHook(() => useAsyncAction(describeFailure));
    let request!: Promise<string>;
    act(() => {
      request = first.result.current.run(() => work.promise, { done });
    });
    first.unmount();
    const second = renderHook(() => useAsyncAction(describeFailure));
    await act(async () => {
      work.reject(new Error("outra organização"));
      await request;
    });
    expect(second.result.current.busy).toBe(false);
    expect(second.result.current.error).toBe("");
    expect(done).not.toHaveBeenCalled();
  });

  it("só a execução mais recente decide o estado e o resultado", async () => {
    const { result } = renderHook(() => useAsyncAction(describeFailure)),
      old = deferred<string>(),
      latest = deferred<string>();
    const done = vi.fn();
    let one!: Promise<string>, two!: Promise<string>;
    act(() => {
      one = result.current.run(() => old.promise, { done });
      two = result.current.run(() => latest.promise, { done });
    });
    await act(async () => {
      old.reject(new Error("antiga"));
      await one;
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.error).toBe("");
    await act(async () => {
      latest.resolve("nova");
      await two;
    });
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith("nova");
    expect(result.current.busy).toBe(false);
  });

  it("o trabalho sabe quando deixou de ser o atual e para entre etapas", async () => {
    const { result, unmount } = renderHook(() => useAsyncAction(describeFailure)),
      read = deferred<void>();
    const send = vi.fn();
    let request!: Promise<string>;
    act(() => {
      request = result.current.run(async (current) => {
        await read.promise;
        if (current()) send();
      });
    });
    unmount();
    read.resolve();
    await request;
    expect(send).not.toHaveBeenCalled();
  });
});
