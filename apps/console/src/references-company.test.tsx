// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { References } from "./references";

const state = vi.hoisted(() => ({
  asked: [] as Array<{ organizationId: string; company: string }>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("convex/react", () => ({
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) => {
    if (args === "skip" || getFunctionName(fn) !== "consoleCompany:context") return undefined;
    const { organizationId, company } = args as { organizationId: string; company: string };
    state.asked.push({ organizationId, company });
    return null;
  },
}));
const org = (id: string) =>
  ({
    id,
    slug: id,
    role: "owner",
    capabilities: { manageOrganization: true },
  }) as unknown as Parameters<typeof References>[0]["org"];
beforeEach(() => {
  localStorage.clear();
  state.asked = [];
});
afterEach(cleanup);

it("troca de organização usa a empresa lembrada da nova organização", () => {
  localStorage.setItem("fnfe:console-company:a", "empresa-a");
  localStorage.setItem("fnfe:console-company:b", "empresa-b");
  const view = render(<References org={org("a")} contextKey="k" />);
  expect(state.asked.at(-1)).toEqual({ organizationId: "a", company: "empresa-a" });
  view.rerender(<References org={org("b")} contextKey="k" />);
  expect(state.asked.at(-1)).toEqual({ organizationId: "b", company: "empresa-b" });
  expect(screen.getByLabelText("Empresa da consulta")).toBeTruthy();
});
