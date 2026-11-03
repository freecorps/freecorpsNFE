// @vitest-environment jsdom
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import { useSecretOnce } from "./async-action";

afterEach(cleanup);
it("discards the displayed secret before a page can enter the browser back-forward cache", async () => {
  const { result } = renderHook(useSecretOnce);
  await act(() => result.current.receive(async () => "synthetic-before-pagehide"));
  expect(result.current.secret).toBe("synthetic-before-pagehide");
  act(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
  expect(result.current.secret).toBeNull();
});
function pending() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("discards a delayed creation response after the form closes", async () => {
  const { result } = renderHook(useSecretOnce),
    work = pending();
  let request!: Promise<void>;
  act(() => {
    request = result.current.receive(() => work.promise);
  });
  act(() => result.current.discard());
  await act(async () => {
    work.resolve("synthetic-secret");
    await request;
  });
  expect(result.current.secret).toBeNull();
});
it("does not carry a secret into a remounted organization/form", async () => {
  const first = renderHook(useSecretOnce),
    work = pending();
  let request!: Promise<void>;
  act(() => {
    request = first.result.current.receive(() => work.promise);
  });
  first.unmount();
  const second = renderHook(useSecretOnce);
  await act(async () => {
    work.resolve("synthetic-secret");
    await request;
  });
  expect(second.result.current.secret).toBeNull();
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});
it("only displays the latest live response and clears the displayed value", async () => {
  const { result } = renderHook(useSecretOnce),
    old = pending(),
    latest = pending();
  let one!: Promise<void>, two!: Promise<void>;
  act(() => {
    one = result.current.receive(() => old.promise);
    two = result.current.receive(() => latest.promise);
  });
  await act(async () => {
    latest.resolve("latest-synthetic");
    await two;
    old.resolve("old-synthetic");
    await one;
  });
  expect(result.current.secret).toBe("latest-synthetic");
  act(() => result.current.discard());
  expect(result.current.secret).toBeNull();
});
