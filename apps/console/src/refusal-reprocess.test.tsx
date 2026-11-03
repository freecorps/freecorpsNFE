// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { RefusalReprocess } from "./refusal-reprocess";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../platform/convex/_generated/api";

type Status = FunctionReturnType<typeof api.refusalReprocess.status>;
const mock = vi.hoisted(() => ({
  request: vi.fn(),
  status: undefined as unknown,
}));
vi.mock("convex/react", () => ({
  useMutation: () => mock.request,
  useQuery: () => mock.status,
  usePaginatedQuery: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, search }: { children: ReactNode; search: { ref?: string } }) =>
    createElement(
      "a",
      { href: search.ref ? `/operations?ref=${search.ref}` : "/operations" },
      children,
    ),
}));
const props = {
  org: { slug: "equipe", capabilities: { manageOrganization: false } },
  scope: { organizationId: "org", companyId: "company", environment: "production" },
  canRequest: true,
} as ComponentProps<typeof RefusalReprocess>;
const run = (status: Partial<NonNullable<Status>>): Status => ({
  operationId: "op" as never,
  state: "succeeded",
  code: null,
  done: true,
  live: false,
  requested: 3,
  busy: 0,
  reprocessed: 0,
  stillRefused: 0,
  failed: 0,
  pending: 0,
  partial: false,
  ...status,
});
const action = () => screen.queryByRole("button", { name: "Reprocessar recusas técnicas" });
beforeEach(() => {
  mock.request.mockReset().mockResolvedValue({ operationId: "op", reused: false });
  mock.status = null;
});
afterEach(cleanup);

it("asks once for the company and environment, and offers again after a refused request", async () => {
  const user = userEvent.setup();
  mock.request.mockRejectedValueOnce(new Error("response lost"));
  render(createElement(RefusalReprocess, props));
  await user.click(action()!);
  expect(mock.request).toHaveBeenCalledWith(props.scope);
  expect((await screen.findByRole("alert")).textContent).toMatch(/o pedido não se repete/);
  await user.click(action()!);
  expect(mock.request).toHaveBeenCalledTimes(2);
});

it("shows nothing to ask while the status loads", () => {
  mock.status = undefined;
  render(createElement(RefusalReprocess, props));
  expect(action()).toBeNull();
});

it.each([
  [
    run({ state: "queued", done: false, live: true, requested: 0 }),
    /^Pedido registrado. Procurando originais recusados .*: 0 enviados/,
  ],
  [
    run({ state: "retry_wait", code: "SWEEP_CONTINUES", done: false, live: true, requested: 1 }),
    /1 enviado para reprocessamento/,
  ],
])("follows a live run without offering a second one (%#)", (status, text) => {
  mock.status = status;
  render(createElement(RefusalReprocess, props));
  expect(action()).toBeNull();
  expect(screen.getByRole("status").textContent).toMatch(text);
  expect(screen.getByText(/pedir de novo devolve a mesma execução/)).toBeTruthy();
});

it.each([
  [
    run({ requested: 3, reprocessed: 1, pending: 2 }),
    /^Reprocessando: 1 de 3 originais concluídos\.$/,
  ],
  [run({ requested: 1, pending: 1 }), /^Reprocessando: 0 de 1 original concluído\.$/],
  [
    run({ requested: 3, reprocessed: 2, stillRefused: 1 }),
    /^Concluído: 2 entraram no histórico da nota, 1 continua recusado\.$/,
  ],
  [run({ requested: 0 }), /^Nada restou para reprocessar nesta empresa e ambiente\.$/],
])("reports a finished run and offers a new one for what is left (%#)", (status, text) => {
  mock.status = status;
  render(createElement(RefusalReprocess, props));
  expect(screen.getByRole("status").textContent).toMatch(text);
  expect(action()).toBeTruthy();
});

it("never reads as concluded while a reprocessing is pending or the count is partial", () => {
  for (const status of [
    run({ requested: 3, reprocessed: 2, pending: 1 }),
    run({ requested: 450, reprocessed: 200, partial: true }),
    run({ state: "running", done: false, live: true, requested: 3, reprocessed: 3 }),
  ]) {
    mock.status = status;
    const view = render(createElement(RefusalReprocess, props));
    expect(screen.getByRole("status").textContent).not.toMatch(/Concluído/);
    view.unmount();
  }
  mock.status = run({ requested: 450, reprocessed: 199, stillRefused: 1, partial: true });
  render(createElement(RefusalReprocess, props));
  expect(screen.getByRole("status").textContent).toMatch(
    /^450 originais enviados .* Contagem parcial, dos 200 primeiros: 199 entraram no histórico da nota, 1 continua recusado, 0 em andamento\.$/,
  );
});

it("says a paused run can be resumed, and one that stopped for good cannot", () => {
  mock.status = run({ state: "paused", code: "PAUSED_BY_USER", done: false, live: true });
  const view = render(createElement(RefusalReprocess, props));
  expect(screen.getByRole("status").textContent).toMatch(
    /pausada. Motivo: Pausada por uma pessoa\. Ela pode ser retomada em Operação e suporte\./,
  );
  expect(
    screen.getByRole("link", { name: "Abrir em Operação e suporte" }).getAttribute("href"),
  ).toBe("/operations?ref=op");
  expect(action()).toBeNull();
  view.unmount();
  mock.status = run({ state: "paused", code: "ACCESS_REVOKED", done: false });
  const stopped = render(createElement(RefusalReprocess, props));
  expect(screen.getByRole("status").textContent).toMatch(
    /parou e não pode ser retomada. Motivo: Interrompida por perda de acesso\. Um novo pedido abre outra execução/,
  );
  expect(screen.getByRole("status").textContent).not.toMatch(/ACCESS_REVOKED/);
  expect(action()).toBeTruthy();
  stopped.unmount();
  // Without a code, the state in Portuguese, never the raw English state.
  mock.status = run({ state: "failed", done: false });
  render(createElement(RefusalReprocess, props));
  expect(screen.getByRole("status").textContent).toMatch(/Motivo: falhou\./);
});

it("shows unfinished children in danger and offers a new run for them", () => {
  mock.status = run({ requested: 2, reprocessed: 1, failed: 1 });
  render(createElement(RefusalReprocess, props));
  expect(screen.getByRole("status").textContent).toMatch(
    /^Concluído: 1 entrou no histórico da nota, 0 continuam recusados, 1 não concluiu\. Um novo pedido abre outra execução, que pega só o que sobrou\./,
  );
  expect(screen.getByRole("link", { name: "Abrir em Operação e suporte" })).toBeTruthy();
  expect(action()).toBeTruthy();
});

it("shows the progress to a reader without the button", () => {
  mock.status = run({ requested: 3, reprocessed: 1, pending: 2 });
  const view = render(createElement(RefusalReprocess, { ...props, canRequest: false }));
  expect(screen.getByRole("status").textContent).toMatch(/^Reprocessando: 1 de 3/);
  expect(action()).toBeNull();
  view.unmount();
  mock.status = null;
  render(createElement(RefusalReprocess, { ...props, canRequest: false }));
  expect(action()).toBeNull();
});

it("says when an earlier operation still holds the originals, instead of nothing left", () => {
  mock.status = run({ requested: 0, busy: 2 });
  const view = render(createElement(RefusalReprocess, props));
  const region = screen.getByRole("status");
  expect(region.textContent).toMatch(
    /^Nada novo para reprocessar agora\. 2 originais seguem com uma operação anterior, que ainda trabalha neles\. Acompanhe em Operação e suporte/,
  );
  expect(region.textContent).not.toMatch(/Nada restou/);
  expect(
    screen.getByRole("link", { name: "Abrir em Operação e suporte" }).getAttribute("href"),
  ).toBe("/operations");
  view.unmount();
  mock.status = run({ requested: 2, reprocessed: 2, busy: 1 });
  render(createElement(RefusalReprocess, props));
  expect(screen.getByRole("status").textContent).toMatch(
    /^Concluído: 2 entraram no histórico da nota, 0 continuam recusados\. 1 original segue com uma operação anterior, que ainda trabalha nele\.$/,
  );
});

it("keeps one live region when the tone changes", () => {
  mock.status = run({ state: "running", done: false, live: true, requested: 1 });
  const view = render(createElement(RefusalReprocess, props));
  const region = screen.getByRole("status");
  mock.status = run({ state: "paused", code: "ACCESS_REVOKED", done: false });
  view.rerender(createElement(RefusalReprocess, props));
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toMatch(/parou e não pode ser retomada/);
});
