// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { Certificates, uploadErrors } from "./certificates";

const state = vi.hoisted(() => ({ upload: vi.fn(), revoke: vi.fn() }));
vi.mock("convex/react", () => ({
  useAction: () => (args: unknown) => state.upload(args),
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.revoke(getFunctionName(fn), args),
}));
type Props = Parameters<typeof Certificates>[0];
const org = { id: "org" } as unknown as Props["org"];
const company = {
  id: "c1",
  kind: "declared",
  capabilities: { manage: true },
} as unknown as Props["company"];
const page = (results: Array<Record<string, unknown>>) =>
  ({ results, status: "Exhausted", loadMore: vi.fn() }) as unknown as Props["certificates"];
const active = {
  id: "cert1",
  version: 1,
  state: "active",
  code: null,
  metadata: {
    cnpj: "00000000000191",
    notAfter: Date.UTC(2027, 0, 1),
    notBefore: 0,
    fingerprint: "ab",
    subject: "CN=x",
  },
};
const flushFrames = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("valida arquivo e senha antes de enviar, com mensagens em pt-BR", () => {
  const file = (name: string, size: number) => new File([new Uint8Array(size)], name);
  expect(uploadErrors(null, "").pfx).toMatch(/^Selecione o arquivo A1/);
  expect(uploadErrors(file("a.txt", 10), "").pfx).toMatch(/\.pfx ou \.p12/);
  expect(uploadErrors(file("a.pfx", 0), "").pfx).toMatch(/vazio/);
  expect(uploadErrors(file("a.p12", 300 * 1024), "").pfx).toBe(
    "O arquivo tem 300 KiB; o limite é 256 KiB.",
  );
  expect(uploadErrors(file("a.PFX", 10), "x".repeat(1025)).password).toMatch(/1024 bytes/);
  expect(uploadErrors(file("a.PFX", 10), "")).toEqual({});
});

it("sem arquivo, o erro aparece junto ao seletor em pt-BR e nada sai", async () => {
  render(<Certificates org={org} company={company} certificates={page([])} />);
  const input = screen.getByLabelText("Arquivo A1/PFX");
  expect(screen.getByText("Escolher arquivo")).toBeTruthy();
  expect(screen.getByText("Nenhum arquivo escolhido")).toBeTruthy();
  const form = input.closest("form")!;
  expect(form.noValidate).toBe(true);
  await act(async () => {
    fireEvent.submit(form);
  });
  expect(state.upload).not.toHaveBeenCalled();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toContain("certificate-pfx-error");
  expect(document.getElementById("certificate-pfx-error")!.textContent).toMatch(
    /^Selecione o arquivo A1/,
  );
  expect(document.activeElement).toBe(input);
});

it("mostra o nome do arquivo escolhido", () => {
  render(<Certificates org={org} company={company} certificates={page([])} />);
  const input = screen.getByLabelText("Arquivo A1/PFX");
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array(4)], "empresa.pfx")] },
  });
  expect(screen.getByText("empresa.pfx")).toBeTruthy();
});

it("desativar pede confirmação num diálogo, devolve o foco ao cancelar e revoga ao confirmar", async () => {
  state.revoke.mockResolvedValue(null);
  render(<Certificates org={org} company={company} certificates={page([active])} />);
  // A click focuses the button in the browser; jsdom does not.
  screen.getByRole("button", { name: "Desativar versão 1" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Desativar versão 1" }));
  const dialog = screen.getByRole("alertdialog", { name: "Desativar a versão 1 do certificado?" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancelar" }));
  expect(dialog.textContent).toContain("fica sem certificado ativo");
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  await flushFrames();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Desativar versão 1" }));
  expect(state.revoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Desativar versão 1" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar desativação" }));
  });
  await flushFrames();
  expect(state.revoke).toHaveBeenCalledWith("certificates:revoke", {
    organizationId: "org",
    companyId: "c1",
    id: "cert1",
  });
});
