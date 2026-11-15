import { beforeEach, describe, expect, it } from "vite-plus/test";
import { api } from "../../../platform/convex/_generated/api";
import { FakeConvex, render, type Rendered } from "../test/render";
import { OrganizationStart } from "./organization-home";
import type { Organization } from "./organizations";

const owner: Organization = {
  id: "org" as Organization["id"],
  name: "Equipe Ipê",
  slug: "equipe",
  role: "owner",
  membershipId: "m" as Organization["membershipId"],
  membershipVersion: 1,
  memberCount: 3,
  ownerCount: 1,
  closure: null,
  termsOfUse: null,
  capabilities: {
    manageOrganization: true,
    manageMembers: true,
    manageIntegrations: true,
    operateDocuments: true,
    readDocuments: true,
  },
};
type StepRow = [key: string, state: string, companyId?: string | null, reason?: string];
const homeTask = (complete: boolean, ...rows: StepRow[]) => ({
  complete,
  steps: rows.map(([key, state, companyId = null, reason]) => ({
    key,
    state,
    companyId,
    ...(reason ? { reason } : {}),
  })),
});
/** `consoleHome.summary` of an owner who has a demonstration company and a declared one. */
const summary = {
  environment: "sandbox",
  companies: { count: 2, truncated: false },
  month: {
    issuances: { authorized: 0, processing: 0, rejected: 0, cancelled: 0 },
    received: 0,
    production: null,
    failedImports: 0,
    partial: false,
  },
  pending: [],
  tasks: {
    import: {
      ...homeTask(
        false,
        ["company", "done", "demo"],
        ["permission", "done"],
        ["document", "todo", "demo"],
      ),
      demonstrationCompanyId: "demo",
    },
    issue: homeTask(
      false,
      ["company", "done", "c1"],
      ["permission", "done"],
      ["certificate", "todo", "c1"],
      ["profile", "todo", "c1"],
    ),
    capture: homeTask(
      false,
      ["company", "done", "c1"],
      ["certificate", "todo", "c1"],
      ["authorize", "blocked", "c1", "previous"],
      ["start", "blocked", "c1", "previous"],
    ),
    integrate: homeTask(false, ["project", "todo"], ["key", "blocked", null, "previous"]),
  },
};
const headerAction = (screen: Rendered) =>
  screen.container.querySelector(".ui-page-header a.ui-button--primary")?.textContent;
const storedTask = () => localStorage.getItem("fnfe:console-task:equipe");

describe("Início por tarefa (#510)", () => {
  beforeEach(() => localStorage.clear());

  it("trocar de tarefa lembra a escolha e muda a ação do cabeçalho", async () => {
    const convex = new FakeConvex();
    convex.answer(api.consoleHome.summary, summary);
    {
      await using screen = await render(<OrganizationStart org={owner} contextKey="k" />, {
        convex,
        path: "/app/equipe",
      });
      const integrate = screen.getByRole("radio", { name: /Integrar meu sistema/ });
      await integrate.click();
      await expect.element(integrate).toBeChecked();
      expect(storedTask()).toBe("integrar");
      await expect.poll(() => headerAction(screen)).toBe("Abrir integrações");
      // Without `?tarefa=`, the address stays as it is.
      expect(screen.router.state.location.href).toBe("/app/equipe");
    }
    await using screen = await render(<OrganizationStart org={owner} contextKey="k" />, {
      convex,
      path: "/app/equipe?tarefa=importar",
    });
    await screen.getByRole("radio", { name: /Capturar NF-e/ }).click();
    // The address follows the choice in place, without a new history entry.
    await expect.poll(() => screen.router.state.location.search).toEqual({ tarefa: "capturar" });
    expect(screen.router.state.location.pathname).toBe("/app/equipe");
    expect(screen.router.history.length).toBe(1);
    expect(storedTask()).toBe("capturar");
  });
});
