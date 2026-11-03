// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { Reprocess } from "./document-reprocess";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../platform/convex/_generated/api";

type OperationState = NonNullable<FunctionReturnType<typeof api.operations.get>>["state"];

const mock = vi.hoisted(() => ({
  run: vi.fn(),
  operation: undefined as { state: OperationState } | undefined,
}));
vi.mock("convex/react", () => ({
  useMutation: () => mock.run,
  useQuery: (_reference: unknown, args: unknown) => (args === "skip" ? undefined : mock.operation),
  usePaginatedQuery: vi.fn(),
}));
const props = {
  org: { slug: "equipe", capabilities: { manageOrganization: false } },
  scope: {
    organizationId: "org",
    companyId: "company",
    environment: "sandbox",
  },
  documentId: "document",
} as ComponentProps<typeof Reprocess>;
const button = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: "Reprocessar XML atual" });
beforeEach(() => {
  mock.run.mockReset().mockResolvedValue({ operationId: "operation" });
  mock.operation = undefined;
});
afterEach(cleanup);

it.each(["succeeded", "failed"] as const)(
  "permite nova solicitação após %s e preserva a nova chave se a resposta se perde",
  async (state) => {
    const user = userEvent.setup();
    const view = render(createElement(Reprocess, props));
    await user.click(button());
    await waitFor(() => expect(button().disabled).toBe(true));
    const firstKey = mock.run.mock.calls[0][0].key;
    mock.operation = { state };
    view.rerender(createElement(Reprocess, props));
    expect(button().disabled).toBe(false);
    mock.run.mockRejectedValueOnce(new Error("response lost"));
    await user.click(button());
    await screen.findByRole("alert");
    const secondKey = mock.run.mock.calls[1][0].key;
    expect(secondKey).not.toBe(firstKey);
    expect(button().disabled).toBe(false);
    await user.click(button());
    expect(mock.run).toHaveBeenCalledTimes(3);
    expect(mock.run.mock.calls[2][0].key).toBe(secondKey);
  },
);

it.each(["queued", "running", "retry_wait", "reconciling", "paused"] as const)(
  "não abre operação concorrente enquanto a anterior está %s",
  async (state) => {
    const user = userEvent.setup();
    const view = render(createElement(Reprocess, props));
    await user.click(button());
    mock.operation = { state };
    view.rerender(createElement(Reprocess, props));
    expect(button().disabled).toBe(true);
    await user.click(button());
    expect(mock.run).toHaveBeenCalledTimes(1);
  },
);
