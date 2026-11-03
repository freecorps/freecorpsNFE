// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import {
  ArchiveNoticeCallout,
  ArchivedCallout,
  SandboxClosureCallout,
  archiveDate,
} from "./archive-notice";

const keepActive = vi.hoisted(() => vi.fn());
vi.mock("convex/react", () => ({ useMutation: () => keepActive }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: (props: {
    to: string;
    params?: { organizationSlug: string };
    className?: string;
    children: React.ReactNode;
  }) => (
    <a href={props.to.replace("$organizationSlug", props.params?.organizationSlug ?? "")}>
      {props.children}
    </a>
  ),
}));
afterEach(() => {
  cleanup();
  keepActive.mockReset();
});

const organizationId = "org" as Id<"organizations">;
const runId = "run" as Id<"coldArchiveRuns">;
// 26/11/2026 at 23:30 in Brasília, already the 27th in UTC.
const eligibleAt = Date.UTC(2026, 10, 27, 2, 30);
const standing = (reason: "free_inactive" | "paid_expired", canAct: boolean) => ({
  runId,
  state: "notice" as const,
  reason,
  eligibleAt,
  archivedAt: null,
  canAct,
});

describe("Aviso de arquivamento de organização aberta (ADR 0009)", () => {
  it("mostra a data de Brasília e o que acontece no arquivamento", () => {
    expect(archiveDate(eligibleAt)).toBe("26/11/2026");
    render(
      <ArchiveNoticeCallout
        organizationId={organizationId}
        slug="aberta"
        standing={standing("free_inactive", false)}
      />,
    );
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("arquivada a partir de 26/11/2026");
    expect(notice.textContent).toContain("90 dias sem atividade");
    expect(notice.textContent).toContain("a reativação não é imediata");
    expect(notice.textContent).toContain("Um proprietário ou administrador pode evitar");
    // Other roles read the notice; only owners and admins act.
    expect(screen.queryByRole("button", { name: "Manter ativa" })).toBeNull();
  });

  it("no Gratuito, owner ou admin mantém ativa pelo aviso que viu", async () => {
    keepActive.mockResolvedValue(null);
    render(
      <ArchiveNoticeCallout
        organizationId={organizationId}
        slug="aberta"
        standing={standing("free_inactive", true)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Manter ativa" }));
    await waitFor(() => expect(keepActive).toHaveBeenCalledWith({ organizationId, runId }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("mostra a recusa do servidor sem sugerir sucesso", async () => {
    keepActive.mockRejectedValue(new ConvexError({ code: "ORGANIZATION_ARCHIVING" }));
    render(
      <ArchiveNoticeCallout
        organizationId={organizationId}
        slug="aberta"
        standing={standing("free_inactive", true)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Manter ativa" }));
    expect((await screen.findByRole("alert")).textContent).toContain("O arquivamento já começou");
  });

  it("um aviso que já terminou pede para recarregar", async () => {
    keepActive.mockRejectedValue(new ConvexError({ code: "ARCHIVE_NOTICE_NOT_FOUND" }));
    render(
      <ArchiveNoticeCallout
        organizationId={organizationId}
        slug="aberta"
        standing={standing("free_inactive", true)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Manter ativa" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Este aviso já terminou. Recarregue a página para ver a situação atual.",
    );
  });

  it("no plano pago, aponta a renovação em Uso e limites", () => {
    render(
      <ArchiveNoticeCallout
        organizationId={organizationId}
        slug="aberta"
        standing={standing("paid_expired", true)}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("período pago do plano terminou");
    expect(screen.queryByRole("button", { name: "Manter ativa" })).toBeNull();
    expect(screen.getByRole("link", { name: "Renovar o plano" }).getAttribute("href")).toBe(
      "/app/aberta/usage",
    );
  });
});

const noticeId = "notice" as Id<"sandboxClosureNotices">;
const sandbox = (canAct: boolean) => ({ noticeId, closeAt: eligibleAt, canAct });

describe("Aviso de encerramento de organização só com Sandbox (ADR 0009, decisão 2)", () => {
  it("mostra a data de Brasília, o porquê e o que é apagado, sem ação para outros papéis", () => {
    render(<SandboxClosureCallout organizationId={organizationId} standing={sandbox(false)} />);
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("encerrada a partir de 26/11/2026");
    expect(notice.textContent).toContain(
      "Esta organização só tem dados de Sandbox e está sem uso há 90 dias.",
    );
    expect(notice.textContent).toContain("não têm validade fiscal");
    expect(notice.textContent).toContain("eles são apagados");
    expect(notice.textContent).toContain("A conta de cada pessoa continua.");
    expect(notice.textContent).toContain("Um proprietário ou administrador pode manter");
    expect(screen.queryByRole("button", { name: "Manter ativa" })).toBeNull();
  });

  it("owner ou admin mantém ativa pelo aviso que viu", async () => {
    keepActive.mockResolvedValue(null);
    render(<SandboxClosureCallout organizationId={organizationId} standing={sandbox(true)} />);
    expect(screen.getByRole("status").textContent).toContain("o prazo de 90 dias recomeça");
    fireEvent.click(screen.getByRole("button", { name: "Manter ativa" }));
    await waitFor(() => expect(keepActive).toHaveBeenCalledWith({ organizationId, noticeId }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("mostra a recusa do servidor sem sugerir sucesso", async () => {
    keepActive.mockRejectedValue(new ConvexError({ code: "SANDBOX_CLOSURE_NOTICE_NOT_FOUND" }));
    render(<SandboxClosureCallout organizationId={organizationId} standing={sandbox(true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Manter ativa" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Este aviso já terminou. Recarregue a página para ver a situação atual.",
    );
  });
});

describe("Organização em custódia fria (ADR 0009, §3)", () => {
  const custody = (
    state: "frozen" | "archived" | "restoring",
    reason: "free_inactive" | "paid_expired" = "free_inactive",
  ) => ({
    ...standing(reason, true),
    state,
    archivedAt: state === "archived" ? eligibleAt : null,
  });

  it("arquivada: data de Brasília, motivo, o que continua e o caminho de volta, sem retomada imediata", () => {
    render(<ArchivedCallout standing={custody("archived", "paid_expired")} />);
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("Organização arquivada desde 26/11/2026.");
    expect(notice.textContent).toContain("O período pago do plano terminou sem renovação.");
    expect(notice.textContent).toContain("para revogar ou desligar, e o plano em Uso e limites");
    expect(notice.textContent).toContain("reativar a organização ou receber uma cópia dos dados");
    expect(notice.textContent).toContain("A reativação não é imediata.");
    // Nothing to click that would suggest the organization resumes now.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("em arquivamento só oferece a exportação assistida; na reativação, espera", () => {
    render(<ArchivedCallout standing={custody("frozen")} />);
    let notice = screen.getByRole("status");
    expect(notice.textContent).toContain("Arquivamento da organização em curso.");
    expect(notice.textContent).toContain("90 dias sem atividade");
    expect(notice.textContent).not.toContain("plano em Uso e limites");
    expect(notice.textContent).not.toContain("reativar a organização");
    expect(notice.textContent).toContain("exportação assistida");
    cleanup();
    render(<ArchivedCallout standing={custody("restoring")} />);
    notice = screen.getByRole("status");
    expect(notice.textContent).toContain("Reativação da organização em curso.");
    expect(notice.textContent).toContain("ela não é imediata");
  });
});
