import { describe, expect, it } from "vite-plus/test";
import { api } from "../../../platform/convex/_generated/api";
import { FakeConvex, render } from "../test/render";
import { Captures } from "./captures";
import { FixedProductEnvironment } from "./product-environment";

const manager = {
  id: "org",
  slug: "equipe",
  name: "Equipe",
  role: "admin",
  capabilities: { operateDocuments: true, manageOrganization: true },
} as unknown as Parameters<typeof Captures>[0]["org"];
const release = (stateName: string) => ({
  available: true,
  state: stateName,
  blocked: false,
  minIntervalHours: 1,
  updatedAt: null,
  canManage: true,
  requirements: { declared: true, certificate: true },
  terms: "captura-fiscal-2026-10-22",
  acceptedTerms: null,
});
/** A captura em Produção, como a casca a mostra com Produção escolhida na lateral. */
const productionCaptures = (
  <FixedProductEnvironment environment="production">
    <Captures org={manager} companyId={"company" as never} />
  </FixedProductEnvironment>
);

describe("organização da tela (#432)", () => {
  it("um passo só: depois de ativar, o foco vai a Iniciar captura fiscal, sem iniciar sozinho", async () => {
    const convex = new FakeConvex();
    convex.answer(api.captures.get, null, { environment: "sandbox" });
    convex.answer(api.captureRelease.status, release("none"));
    convex.handle(api.captureRelease.enable, () => ({ version: 1, revokedKeys: 0 }));
    {
      await using screen = await render(productionCaptures, { convex });
      await screen.getByLabelText("Li e aceito os termos da captura fiscal").click();
      await screen.getByRole("button", { name: "Ativar captura fiscal" }).click();
      await expect
        .poll(() => convex.calls.map(({ name }) => name))
        .toEqual(["captureRelease:enable"]);
      // The server answers through the subscriptions: released, no capture yet.
      convex.answer(api.captureRelease.status, release("released"));
      convex.answer(api.captures.get, null, { environment: "production" });
      // A real focus: the browser moves it only to an element it can focus and that is shown.
      await expect
        .element(screen.getByRole("button", { name: "Iniciar captura fiscal" }))
        .toHaveFocus();
      await expect
        .element(screen.getByRole("heading", { name: "Falta um passo: Iniciar captura fiscal" }))
        .toBeVisible();
      // Starting is the person's click: real queries to the Receita.
      expect(convex.calls.map(({ name }) => name)).toEqual(["captureRelease:enable"]);
    }
    // Opening the tab later does not take the focus.
    await using later = await render(productionCaptures, { convex });
    await expect
      .element(later.getByRole("button", { name: "Iniciar captura fiscal" }))
      .toBeVisible();
    expect(document.activeElement).toBe(document.body);
  });
});
