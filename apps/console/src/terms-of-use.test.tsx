// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import {
  TERMS_OF_USE_ARCHIVE,
  TERMS_OF_USE_VERSION,
} from "../../../platform/convex/lib/termsOfUseArchive";
import { termsBlocks } from "./capture-terms";
import { TermsOfUseNotice, archivedTermsOfUse, effectiveDate } from "./terms-of-use";

const accept = vi.hoisted(() => vi.fn());
vi.mock("convex/react", () => ({ useMutation: () => accept }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: (props: { to: string; params?: { version: string }; children: React.ReactNode }) => (
    <a href={props.to.replace("$version", props.params?.version ?? "")}>{props.children}</a>
  ),
}));
afterEach(cleanup);

/** The repository root, from the root or from `apps/console` (its `test` script). */
function repository(dir = process.cwd()): string {
  if (existsSync(join(dir, "docs/termos/arquivo"))) return dir;
  if (dirname(dir) === dir) throw new Error("docs/termos/arquivo não encontrado");
  return repository(dirname(dir));
}
const archive = join(repository(), "docs/termos/arquivo");

describe("Termos de uso arquivados (#586)", () => {
  it("cada arquivo tem a versão e o SHA-256 que o servidor registra, e só eles", () => {
    const names = readdirSync(archive).filter((name) => name.endsWith(".md"));
    // Every archived text belongs to the capture terms, the terms of use or the privacy policy.
    for (const name of names)
      expect(name).toMatch(/^(captura-fiscal|termos-de-uso|politica-de-privacidade)-.+\.md$/);
    const files = names
      .filter((name) => name.startsWith("termos-de-uso-"))
      .map((name) => name.slice(0, -3));
    expect(files.sort()).toEqual(Object.keys(TERMS_OF_USE_ARCHIVE).sort());
    expect(Object.keys(archivedTermsOfUse).sort()).toEqual(files.sort());
    for (const version of files) {
      const data = readFileSync(join(archive, `${version}.md`));
      expect(data.includes(0x0d), `${version} tem CR`).toBe(false);
      expect(data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), version).toBe(false);
      expect(createHash("sha256").update(data).digest("hex"), version).toBe(
        TERMS_OF_USE_ARCHIVE[version]?.sha256,
      );
      expect(TERMS_OF_USE_ARCHIVE[version]?.since, version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(archivedTermsOfUse[version]).toBe(data.toString("utf8"));
      expect(() => termsBlocks(archivedTermsOfUse[version]!)).not.toThrow();
    }
    if (TERMS_OF_USE_VERSION !== null)
      expect(TERMS_OF_USE_ARCHIVE).toHaveProperty(TERMS_OF_USE_VERSION);
  });
});

describe("Aviso dos termos de uso pendentes (#586)", () => {
  const organizationId = "org" as Id<"organizations">;
  // 09/01/2027, midnight in Brasília.
  const pending = { version: "termos-de-uso-2026-12-10", effectiveAt: Date.UTC(2027, 0, 9, 3) };

  it("antes da vigência, avisa a data; o proprietário lê e aceita no console", () => {
    expect(effectiveDate(pending.effectiveAt)).toBe("09/01/2027");
    render(
      <TermsOfUseNotice
        organizationId={organizationId}
        role="owner"
        pending={pending}
        now={pending.effectiveAt - 1}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("passam a valer em 09/01/2027");
    fireEvent.click(screen.getByRole("button", { name: "Ler e aceitar" }));
    const dialog = screen.getByRole("alertdialog");
    // Without the text of the version the server asks for, nothing can be accepted.
    expect(dialog.textContent).toContain(
      `Esta página não tem o texto da versão ${pending.version} dos termos de uso.`,
    );
    expect(
      (screen.getByRole("checkbox") as HTMLInputElement).disabled &&
        (screen.getByRole("button", { name: "Aceitar os termos" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(accept).not.toHaveBeenCalled();
  });

  it("na vigência, diz o que parou e, para os outros papéis, quem aceita", () => {
    render(
      <TermsOfUseNotice
        organizationId={organizationId}
        role="admin"
        pending={pending}
        now={pending.effectiveAt}
      />,
    );
    const notice = screen.getByRole("alert");
    expect(notice.textContent).toContain("valem desde 09/01/2027");
    expect(notice.textContent).toContain("a organização não cria operações novas");
    expect(notice.textContent).toContain("Só um proprietário da organização aceita os termos.");
    expect(screen.queryByRole("button", { name: "Ler e aceitar" })).toBeNull();
    expect(screen.getByRole("link", { name: "Ler os termos" }).getAttribute("href")).toBe(
      `/termos/uso/${pending.version}`,
    );
  });
});
