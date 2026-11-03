// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ErrorBoundary, isAccessFailure } from "./route-errors";

afterEach(cleanup);

describe("erros de página", () => {
  it("só sessão e acesso negados pelo servidor contam como falha de acesso", () => {
    for (const code of ["UNAUTHENTICATED", "EMAIL_UNVERIFIED", "ACCESS_DENIED"])
      expect([code, isAccessFailure(new ConvexError({ code }))]).toEqual([code, true]);
    for (const error of [
      new ConvexError({ code: "NOT_FOUND" }),
      new ConvexError({ code: "SCOPE_DENIED" }),
      new ConvexError({ code: "RATE_LIMITED" }),
      new ConvexError("ACCESS_DENIED"),
      new Error("ACCESS_DENIED"),
      new TypeError("Failed to fetch dynamically imported module"),
      { code: "ACCESS_DENIED" },
      null,
    ])
      expect(isAccessFailure(error)).toBe(false);
  });

  let failing = true;
  function Page({ code }: { code: string }) {
    if (failing) throw new ConvexError({ code });
    return <h1>Documentos</h1>;
  }
  // The boundary silences React's own report of the caught error.
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

  it("arquivo econômico orienta atendimento e permite conferir acesso sem novo login", () => {
    const spy = quiet();
    failing = true;
    render(
      <ErrorBoundary>
        <Page code="ORGANIZATION_ARCHIVED" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("heading", { name: "Organização em arquivo econômico" })).toBeTruthy();
    expect(screen.getByText(/indisponíveis até a reativação, que não é imediata/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /sessão/ })).toBeNull();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Verificar acesso" }));
    expect(screen.getByRole("heading", { name: "Documentos" })).toBeTruthy();
    spy.mockRestore();
  });

  it("acesso negado pede para conferir a sessão; outro erro fica na página com nova tentativa", () => {
    const spy = quiet();
    failing = true;
    render(
      <ErrorBoundary resetKey="/app/equipe">
        <Page code="ACCESS_DENIED" />
      </ErrorBoundary>,
    );
    expect(
      screen.getByRole("heading", { name: "Não foi possível confirmar o acesso" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Verificar sessão novamente" }).getAttribute("href"),
    ).toBe("/login");
    cleanup();
    render(
      <ErrorBoundary resetKey="/app/equipe">
        <Page code="NOT_FOUND" />
      </ErrorBoundary>,
    );
    expect(
      screen.getByRole("heading", { name: "Não foi possível carregar esta página." }),
    ).toBeTruthy();
    expect(screen.queryByText("Não foi possível confirmar o acesso")).toBeNull();
    expect(screen.queryByRole("link", { name: /sessão/ })).toBeNull();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(screen.getByRole("heading", { name: "Documentos" })).toBeTruthy();
    spy.mockRestore();
  });

  it("esquece a falha ao mudar de endereço, sem remontar o que deu certo", () => {
    const spy = quiet();
    failing = true;
    let mounts = 0;
    function Counted() {
      useState(() => ++mounts);
      return <Page code="NOT_FOUND" />;
    }
    const view = render(
      <ErrorBoundary resetKey="/app/equipe/documents">
        <Counted />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    failing = false;
    view.rerender(
      <ErrorBoundary resetKey="/app/equipe/issuances">
        <Counted />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("heading", { name: "Documentos" })).toBeTruthy();
    const before = mounts;
    view.rerender(
      <ErrorBoundary resetKey="/app/equipe/imports">
        <Counted />
      </ErrorBoundary>,
    );
    // A new address while nothing failed only re-renders.
    expect(mounts).toBe(before);
    spy.mockRestore();
  });
});
