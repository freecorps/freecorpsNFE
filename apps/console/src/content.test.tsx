// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { makeFunctionReference } from "convex/server";
import { useContent } from "./content";

const state = vi.hoisted(() => ({
  token: undefined as string | undefined,
  run: vi.fn(),
}));
vi.mock("./convex-query", () => ({
  useQuery: (_fn: unknown, args: unknown) => (args === "skip" ? undefined : state.token),
}));
vi.mock("convex/react", () => ({ useAction: () => state.run }));

const token = makeFunctionReference<"query", { id: string }, string>("contentRead:testToken");
const read = makeFunctionReference<"action", { id: string }, string>("node:testRead");

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    return this.state.error ? <p>erro</p> : this.props.children;
  }
}
function View({ id }: { id: string | null }) {
  const value = useContent(token, read, id ? { id } : "skip");
  return <p>{value === undefined ? "carregando" : value}</p>;
}
const show = (id: string | null) =>
  render(
    <Boundary>
      <View id={id} />
    </Boundary>,
  );

beforeEach(() => {
  state.token = undefined;
  state.run.mockReset();
});
afterEach(cleanup);

it("reads once the token arrives and again only when it changes", async () => {
  state.token = "t1";
  state.run.mockResolvedValueOnce("primeira");
  const view = show("a");
  expect(screen.getByText("carregando")).toBeTruthy();
  await act(async () => {});
  expect(screen.getByText("primeira")).toBeTruthy();
  expect(state.run).toHaveBeenCalledWith({ id: "a" });

  // Same token: the answer stays, no new read.
  view.rerender(
    <Boundary>
      <View id="a" />
    </Boundary>,
  );
  expect(state.run).toHaveBeenCalledTimes(1);

  // New token: the last answer stays on screen while the new one is read.
  let resolve!: (value: string) => void;
  state.run.mockReturnValueOnce(new Promise((done) => (resolve = done)));
  state.token = "t2";
  view.rerender(
    <Boundary>
      <View id="a" />
    </Boundary>,
  );
  await act(async () => {});
  expect(screen.getByText("primeira")).toBeTruthy();
  await act(async () => resolve("segunda"));
  expect(screen.getByText("segunda")).toBeTruthy();
  expect(state.run).toHaveBeenCalledTimes(2);
});

it("answers a remount with the same token from memory", async () => {
  state.token = "t-cache";
  state.run.mockResolvedValueOnce("guardada");
  show("cache");
  await act(async () => {});
  cleanup();
  show("cache");
  expect(screen.getByText("guardada")).toBeTruthy();
  expect(state.run).toHaveBeenCalledTimes(1);
});

it("skips without reading and throws a failed read to the error boundary", async () => {
  state.token = "t3";
  show(null);
  await act(async () => {});
  expect(state.run).not.toHaveBeenCalled();
  cleanup();
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.run.mockRejectedValueOnce(new Error("UNAVAILABLE"));
  show("falha");
  await act(async () => {});
  expect(screen.getByText("erro")).toBeTruthy();
});

it("reads again after a failure when the token changes, instead of keeping the old error", async () => {
  state.token = "t4";
  state.run.mockRejectedValueOnce(new Error("UNAVAILABLE"));
  let value: string | undefined = "inicial";
  function Probe() {
    try {
      value = useContent(token, read, { id: "retry" });
    } catch {
      value = "erro";
    }
    return null;
  }
  const view = render(<Probe />);
  await act(async () => {});
  expect(value).toBe("erro");
  state.token = "t5";
  state.run.mockResolvedValueOnce("recuperada");
  view.rerender(<Probe />);
  expect(value).toBeUndefined();
  await act(async () => {});
  view.rerender(<Probe />);
  expect(value).toBe("recuperada");
});
