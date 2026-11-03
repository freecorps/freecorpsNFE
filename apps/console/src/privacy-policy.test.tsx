// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PRIVACY_POLICY_ARCHIVE,
  PRIVACY_POLICY_VERSION,
} from "../../../platform/convex/lib/privacyPolicyArchive";
import {
  TERMS_OF_USE_ARCHIVE,
  TERMS_OF_USE_VERSION,
} from "../../../platform/convex/lib/termsOfUseArchive";
import { termsBlocks } from "./capture-terms";
import {
  CurrentPrivacyPolicyPage,
  CurrentTermsOfUsePage,
  PrivacyPolicyVersion,
  TermsOfUseVersion,
  archivedPrivacyPolicy,
} from "./public-texts";

vi.mock("./auth-layout", () => ({
  AuthLayout: (props: { children: React.ReactNode }) => <main>{props.children}</main>,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  Link: (props: { to: string; children: React.ReactNode }) => (
    <a href={props.to}>{props.children}</a>
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

describe("Política de privacidade arquivada (#428)", () => {
  it("cada arquivo tem a versão e o SHA-256 registrados, e só eles", () => {
    const files = readdirSync(archive)
      .filter((name) => name.startsWith("politica-de-privacidade-") && name.endsWith(".md"))
      .map((name) => name.slice(0, -3));
    expect(files.sort()).toEqual(Object.keys(PRIVACY_POLICY_ARCHIVE).sort());
    expect(Object.keys(archivedPrivacyPolicy).sort()).toEqual(files.sort());
    for (const version of files) {
      const data = readFileSync(join(archive, `${version}.md`));
      expect(data.includes(0x0d), `${version} tem CR`).toBe(false);
      expect(data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), version).toBe(false);
      expect(createHash("sha256").update(data).digest("hex"), version).toBe(
        PRIVACY_POLICY_ARCHIVE[version]?.sha256,
      );
      expect(PRIVACY_POLICY_ARCHIVE[version]?.since, version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(archivedPrivacyPolicy[version]).toBe(data.toString("utf8"));
      expect(() => termsBlocks(archivedPrivacyPolicy[version]!)).not.toThrow();
    }
    expect(PRIVACY_POLICY_ARCHIVE).toHaveProperty(PRIVACY_POLICY_VERSION);
  });
});

describe("Textos legais públicos (#428)", () => {
  it("/privacidade mostra a política em vigor, com versão, data e hash", () => {
    render(<CurrentPrivacyPolicyPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Política de privacidade" })).toBeTruthy();
    expect(screen.getByText(/Encarregado: Wolf Stievano/)).toBeTruthy();
    expect(screen.getByText(PRIVACY_POLICY_ARCHIVE[PRIVACY_POLICY_VERSION]!.sha256)).toBeTruthy();
    expect(screen.getByText("Versão atual")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Termos de uso" }).getAttribute("href")).toBe(
      "/termos",
    );
  });

  it("/termos mostra os termos de uso em vigor, com a cláusula de operadora", () => {
    expect(TERMS_OF_USE_VERSION).not.toBeNull();
    render(<CurrentTermsOfUsePage />);
    expect(screen.getByRole("heading", { level: 1, name: "Termos de uso" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Cláusula de operadora" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "5A. Cobrança" })).toBeTruthy();
    expect(screen.getByText(TERMS_OF_USE_ARCHIVE[TERMS_OF_USE_VERSION!]!.sha256)).toBeTruthy();
    // Without a return address there is nothing to go back to, only the other text.
    expect(screen.queryByText("Voltar")).toBeNull();
    expect(screen.getByRole("link", { name: "Política de privacidade" }).getAttribute("href")).toBe(
      "/privacidade",
    );
  });

  it("aberta do console, a página dos termos volta para onde estava", () => {
    render(<TermsOfUseVersion version={TERMS_OF_USE_VERSION!} voltar="/app/acme" />);
    expect(screen.getByRole("link", { name: "Voltar" }).getAttribute("href")).toBe("/app/acme");
  });

  it("uma versão desconhecida não mostra outro texto no lugar", () => {
    render(<TermsOfUseVersion version="termos-de-uso-2099-01-01" />);
    expect(screen.getByText("Versão dos termos de uso não encontrada.")).toBeTruthy();
    expect(screen.queryByText("SHA-256 do texto")).toBeNull();
    cleanup();
    render(<PrivacyPolicyVersion version="politica-de-privacidade-2099-01-01" />);
    expect(screen.getByText("Versão da política de privacidade não encontrada.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ler a política em vigor" })).toBeTruthy();
  });
});
