// @vitest-environment jsdom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";

const state = vi.hoisted(() => ({
  session: undefined as undefined | null | { role: "operator" | "viewer" | null },
  asked: [] as Array<{ name: string; args: unknown }>,
  persistentRecordPresent: true,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: React.ReactNode }) => createElement("a", null, children),
  useSearch: () => ({}),
}));
vi.mock("convex/react", async (original) => ({
  ...(await original<typeof import("convex/react")>()),
  ConvexReactClient: class {
    connectionState() {}
    prewarmQuery() {}
  },
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference);
    state.asked.push({ name, args });
    if (name === "access:session") return state.session;
    if (name === "access:overview") return state.session?.role ? state.session : undefined;
    if (name === "access:diagnostics" && args !== "skip")
      return { persistentRecordPresent: state.persistentRecordPresent };
    return undefined;
  },
}));
import { diagnosticsHeading, homeDestination } from "../e2e/m0-headings.mjs";

/**
 * The page as each build compiles it (`VITE_APP_ENV` goes into the bundle). The M0 journey runs on
 * the validation console, built without `VITE_APP_ENV`: stubbing it empty keeps the worktree's
 * `.env.local` (`VITE_APP_ENV=development`) from sending `/console` to the redirect.
 */
async function load(appEnv = "") {
  vi.resetModules();
  vi.stubEnv("VITE_APP_ENV", appEnv);
  return import("./console-home");
}

beforeEach(() => {
  state.session = undefined;
  state.asked = [];
  state.persistentRecordPresent = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

it("nega o diagnóstico a quem não é operador sem pedir os dados nem mandar ao login", async () => {
  for (const appEnv of ["", "installation", "development", "selfhost-local"]) {
    const { Diagnostics } = await load(appEnv);
    for (const session of [{ role: null }, { role: "viewer" }] as const) {
      state.session = session;
      state.asked = [];
      const html = renderToString(createElement(Diagnostics));
      expect(html).toContain("Diagnóstico restrito.");
      expect(html).toContain("Sua sessão continua ativa");
      expect(html).not.toContain("/login");
      expect(state.asked).toContainEqual({ name: "access:diagnostics", args: "skip" });
      expect(state.asked).not.toContainEqual({ name: "access:diagnostics", args: {} });
    }
  }
});

it("espera a sessão antes de decidir", async () => {
  const { Diagnostics } = await load();
  expect(renderToString(createElement(Diagnostics))).toContain("Verificando sua sessão");
});

it("mostra o diagnóstico ao operador", async () => {
  const { Diagnostics } = await load();
  state.session = { role: "operator" };
  const html = renderToString(createElement(Diagnostics));
  expect(html).toContain("Estado do ambiente.");
  expect(html).toContain("Preservado");
});

// #539, #625: the server does not report fiscal integrations. Only the validation console, where
// nothing fiscal runs, states they are disabled; the hosted service releases NF-e capture per
// company in production.
describe("diagnóstico por perfil (#539)", () => {
  const validationTexts = [
    "Validação",
    "validar",
    "ambiente de teste",
    "Integrações fiscais",
    "Desativadas",
  ];

  it("o console de validação continua como antes, com o registro preservado ou ausente", async () => {
    const { Diagnostics } = await load();
    state.session = { role: "operator" };
    for (const [present, status] of [
      [true, "Preservado"],
      [false, "Ausente"],
    ] as const) {
      state.persistentRecordPresent = present;
      const page = render(createElement(Diagnostics)).container;
      expect(page.textContent).toContain("Validação · Diagnóstico");
      expect(page.textContent).toContain("Informações verificadas pelo servidor.");
      expect(page.textContent).toContain("Verificações do servidor");
      expect(page.textContent).toContain("Registro de persistência");
      expect(page.textContent).toContain(status);
      expect(page.textContent).toContain("Integrações fiscais");
      expect(page.textContent).toContain("Desativadas");
      cleanup();
    }
  });

  // The persistence record is a validation probe: besides validation, only the hosted service
  // creates it, once at bootstrap, and other builds never have it.
  for (const appEnv of ["installation", "development", "selfhost-local"])
    it(`${appEnv}: mostra só a versão do painel, sem texto de validação nem verificações`, async () => {
      const { Diagnostics } = await load(appEnv);
      state.session = { role: "operator" };
      for (const present of [true, false]) {
        state.persistentRecordPresent = present;
        const page = render(createElement(Diagnostics)).container;
        expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Estado do ambiente.");
        expect(page.textContent).toContain("Plataforma · Diagnóstico");
        expect(page.textContent).toContain("Versão deste painel. Disponível para operadores.");
        expect(screen.getByRole("heading", { name: "Painel" })).toBeTruthy();
        expect(page.textContent).toContain("Versão do painel");
        for (const text of [
          ...validationTexts,
          "Registro de persistência",
          "Preservado",
          "Ausente",
          "Servidor",
          "servidor",
          "verificad",
          "Verificações",
        ])
          expect(page.textContent).not.toContain(text);
        cleanup();
      }
    });
});

// The deploy validation (e2e/m0.mjs) waits for these headings on the published console; the
// viewer's journey once timed out waiting for "Não foi possível confirmar o acesso".
it("mostra a cada papel da validação o título que a jornada M0 espera", async () => {
  const { Diagnostics } = await load();
  for (const [role, session] of [
    ["operator", { role: "operator" }],
    ["viewer", { role: "viewer" }],
    ["none", { role: null }],
  ] as const) {
    state.session = session;
    render(createElement(Diagnostics));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(diagnosticsHeading(role));
    cleanup();
  }
});

// `/console` of the validation console: the M0 journey waits there for this heading before it
// opens the drawer to sign out. (The list of the `none` account is in navigation.test.tsx.)
it("mostra a viewer e operador da validação o título que a jornada M0 espera em /console", async () => {
  const { Overview } = await load();
  for (const role of ["viewer", "operator"] as const) {
    state.session = { role };
    render(createElement(Overview));
    expect(screen.getByRole("heading", { name: homeDestination(role).heading })).toBeTruthy();
    cleanup();
  }
});
