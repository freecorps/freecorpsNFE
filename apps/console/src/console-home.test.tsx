// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";

const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  args: {} as Record<string, unknown>,
  search: {} as Record<string, unknown>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    className,
    children,
  }: {
    to: string;
    search?: Record<string, string>;
    className?: string;
    children: ReactNode;
  }) => {
    const query = new URLSearchParams(search).toString();
    return (
      <a className={className} href={query ? `${to}?${query}` : to}>
        {children}
      </a>
    );
  },
  useSearch: () => state.search,
  Navigate: ({
    to,
    params,
    search,
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
  }) => {
    const query = new URLSearchParams(search).toString();
    const path = to.replace("$organizationSlug", params?.organizationSlug ?? "");
    return <p data-navigate={query ? `${path}?${query}` : path} />;
  },
}));
vi.mock("convex/react", async (original) => ({
  ...(await original<typeof import("convex/react")>()),
  ConvexReactClient: class {
    connectionState() {}
    prewarmQuery() {}
  },
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) => {
    state.args[getFunctionName(fn)] = args;
    return args === "skip" ? undefined : state.queries[getFunctionName(fn)];
  },
}));

/** O início como cada build o compila (`VITE_APP_ENV` entra no bundle). */
async function renderHome(appEnv: string) {
  vi.resetModules();
  vi.stubEnv("VITE_APP_ENV", appEnv);
  const { Overview } = await import("./console-home");
  return render(createElement(Overview)).container;
}

beforeEach(() => {
  localStorage.clear();
  state.search = {};
  state.args = {};
  state.queries = {
    // Operador da plataforma: o papel de `validationAccess`.
    "access:session": { name: "Ana Sintética", email: "ana@example.invalid", role: "operator" },
    "access:overview": { status: "authorized", role: "operator", environment: "validation" },
    "organizations:landing": { slug: "equipe" },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("início do console por perfil (#517)", () => {
  it("só o console de validação mostra a visão de validação aos operadores", async () => {
    const page = await renderHome("");
    expect(page.textContent).toContain("Validação · Visão geral");
    expect(page.textContent).toContain("Desativadas neste ambiente");
  });

  for (const appEnv of ["installation", "development", "selfhost-local"])
    it(`${appEnv}: o operador vai ao trabalho, sem texto de validação nem aviso fiscal`, async () => {
      const page = await renderHome(appEnv);
      expect(page.querySelector("[data-navigate]")?.getAttribute("data-navigate")).toBe(
        "/app/equipe",
      );
      for (const text of ["Validação", "validar", "ambiente de teste", "Integrações fiscais"])
        expect(page.textContent).not.toContain(text);
    });

  it("sem organização a abrir, vai à lista de organizações", async () => {
    state.queries["organizations:landing"] = null;
    const page = await renderHome("installation");
    expect(page.querySelector("[data-navigate]")?.getAttribute("data-navigate")).toBe("/app");
  });
});

/**
 * #510: the task chosen on the landing (`taskEntryHref`) arrives at `/console?tarefa=…` after the
 * signup or the login; the home takes it to the organization the server opens, or to the list.
 */
describe("tarefa levada pelo início (#510)", () => {
  const destination = (page: HTMLElement) =>
    page.querySelector("[data-navigate]")?.getAttribute("data-navigate");

  it("leva a tarefa à organização que o servidor abre", async () => {
    state.search = { tarefa: "importar" };
    expect(destination(await renderHome("installation"))).toBe("/app/equipe?tarefa=importar");
  });

  it("descarta uma tarefa desconhecida e o resto da consulta", async () => {
    for (const search of [
      { tarefa: "excluir" },
      { tarefa: "importar\r\n" },
      { tarefa: ["importar"] },
      { redirect: "//evil.example", company: "k57abc" },
    ]) {
      state.search = search;
      expect([search, destination(await renderHome("installation"))]).toEqual([
        search,
        "/app/equipe",
      ]);
      cleanup();
    }
  });

  it("com a organização lembrada sem acesso, segue para a que o servidor encontrar", async () => {
    localStorage.setItem("fnfe:console-organization", "antiga");
    state.search = { tarefa: "emitir" };
    // `organizations.landing` ignores a remembered address the person no longer opens.
    state.queries["organizations:landing"] = { slug: "atual" };
    const page = await renderHome("installation");
    expect(state.args["organizations:landing"]).toEqual({ remembered: "antiga" });
    expect(destination(page)).toBe("/app/atual?tarefa=emitir");
  });

  it("a visão de validação leva a tarefa conhecida às organizações, e só ela", async () => {
    state.search = { tarefa: "importar" };
    const link = (page: HTMLElement) =>
      page.querySelector("a.ui-link[href^='/app']")?.getAttribute("href");
    expect(link(await renderHome(""))).toBe("/app?tarefa=importar");
    cleanup();
    state.search = { tarefa: "excluir", redirect: "//evil.example" };
    expect(link(await renderHome(""))).toBe("/app");
  });

  it("sem organização, leva a tarefa à lista que cria a primeira", async () => {
    state.search = { tarefa: "importar" };
    state.queries["organizations:landing"] = null;
    expect(destination(await renderHome("installation"))).toBe("/app?tarefa=importar");
  });
});
