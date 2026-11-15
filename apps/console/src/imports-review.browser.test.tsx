import { afterEach, expect, it, vi } from "vite-plus/test";
import { api } from "../../../platform/convex/_generated/api";
import { FakeConvex, render } from "../test/render";
import { ImportFlow } from "./imports";

const scope = {
  organizationId: "org",
  companyId: "company",
  environment: "sandbox",
} as unknown as Parameters<typeof ImportFlow>[0]["scope"];
afterEach(() => vi.restoreAllMocks());

/** A synthetic activation: `false` when the input prevented it, so no picker opens. */
const activate = (input: HTMLInputElement) =>
  input.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

it("keeps the focus on the file input before, during and after the reading (#535)", async () => {
  // The reading (SHA-256 of each chosen file) waits for the test.
  let digested!: () => void;
  const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        digested = () => resolve(new Uint8Array(32).buffer);
      }),
  );
  const convex = new FakeConvex();
  convex.answer(api.imports.recent, []);
  await using screen = await render(
    <ImportFlow scope={scope} writable organizationSlug="organization" />,
    { convex },
  );
  const drop = screen.getByLabelText("Arraste os XMLs aqui ou escolha os arquivos");
  const input = drop.element() as HTMLInputElement;
  input.focus();
  await expect.element(drop).toHaveFocus();
  await drop.upload(new File(["<xml/>"], "a.xml", { type: "application/xml" }));
  // Blocked without leaving the tab order: the browser drops the focus of a disabled input.
  await expect.element(drop).toHaveAttribute("aria-disabled", "true");
  expect(input.disabled).toBe(false);
  await expect.element(drop).toHaveFocus();
  // Activating it meanwhile opens no picker.
  expect(activate(input)).toBe(false);
  // The file's bytes come first; then the hash, which the test answers.
  await expect.poll(() => digest.mock.calls.length).toBe(1);
  digested();
  await expect.element(drop).not.toHaveAttribute("aria-disabled");
  await expect.element(drop).toHaveFocus();
  expect(activate(input)).toBe(true);
  await expect
    .element(screen.getByRole("list", { name: "Arquivos escolhidos" }).getByText("a.xml"))
    .toBeVisible();
  // Reading is not sending: nothing went to the server.
  expect(convex.calls).toEqual([]);
});
