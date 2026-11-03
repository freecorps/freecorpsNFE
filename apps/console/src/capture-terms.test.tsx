// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CAPTURE_TERMS_ARCHIVE,
  CAPTURE_TERMS_SHA256,
  CAPTURE_TERMS_VERSION,
} from "../../../platform/convex/lib/fiscalCaptureRelease";
import {
  CaptureTermsPage,
  archivedTerms,
  termsBlocks,
  termsPath,
  termsStanding,
} from "./capture-terms";
import { FiscalCaptureTerms } from "./fiscal-capture";

const route = vi.hoisted(() => ({
  version: "",
  search: {} as { voltar?: string },
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useParams: () => ({ version: route.version }),
  useSearch: () => route.search,
  useNavigate: () => route.navigate,
  Link: (props: {
    to: string;
    params?: { version: string };
    search?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a
      href={
        props.to.replace("$version", props.params?.version ?? "") +
        (props.search && Object.keys(props.search).length
          ? `?${new URLSearchParams(props.search)}`
          : "")
      }
    >
      {props.children}
    </a>
  ),
}));
afterEach(cleanup);

/** The repository root, from the root or from `apps/console` (its `test` script). */
function repository(dir = process.cwd()): string {
  if (existsSync(join(dir, "docs/termos/arquivo"))) return dir;
  if (dirname(dir) === dir) throw new Error("docs/termos/arquivo não encontrado");
  return repository(dirname(dir));
}
const root = repository();
const bytes = (version: string) => readFileSync(join(root, termsPath(version)));
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
/** What a reader sees of the file: each paragraph and each item, without the list mark. */
const lines = (text: string) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^- /, ""));

describe("Termos da captura fiscal arquivados (#428)", () => {
  it("cada arquivo tem a versão e o SHA-256 que o servidor registra, e só eles", () => {
    const files = readdirSync(join(root, "docs/termos/arquivo"))
      .filter((name) => name.startsWith("captura-fiscal-") && name.endsWith(".md"))
      .map((name) => name.slice(0, -3));
    expect(files.sort()).toEqual(Object.keys(CAPTURE_TERMS_ARCHIVE).sort());
    expect(Object.keys(archivedTerms).sort()).toEqual(files.sort());
    for (const version of files) {
      const data = bytes(version);
      // The hash is over these exact bytes: UTF-8 without BOM and LF only (`.gitattributes`).
      expect(data.includes(0x0d), `${version} tem CR`).toBe(false);
      expect(data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), version).toBe(false);
      expect(sha256(data), version).toBe(CAPTURE_TERMS_ARCHIVE[version]?.sha256);
      expect(CAPTURE_TERMS_ARCHIVE[version]?.since, version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The console shows the same bytes, not a copy of the text.
      expect(archivedTerms[version]).toBe(data.toString("utf8"));
      expect(() => termsBlocks(archivedTerms[version]!)).not.toThrow();
    }
    expect(CAPTURE_TERMS_SHA256).toBe(CAPTURE_TERMS_ARCHIVE[CAPTURE_TERMS_VERSION]?.sha256);
  });
  it("o texto que o console mostra para aceitar é o do arquivo da versão atual", () => {
    const { container } = render(<FiscalCaptureTerms version={CAPTURE_TERMS_VERSION} />);
    const shown = [...container.querySelectorAll(".capture-terms p, .capture-terms li")];
    expect(shown.map((node) => node.textContent)).toEqual(
      lines(archivedTerms[CAPTURE_TERMS_VERSION]!),
    );
    expect(container.textContent).toContain("Termos da captura fiscal de 22/10/2026.");
  });
  it("sem o texto da versão pedida, não mostra outro no lugar", () => {
    const { container } = render(<FiscalCaptureTerms version="captura-fiscal-2099-01-01" />);
    expect(container.querySelector(".capture-terms")).toBeNull();
    expect(container.textContent).toContain(
      "Esta página não tem o texto da versão captura-fiscal-2099-01-01 dos termos.",
    );
  });
  it.each([
    ["# Título", "título de primeiro nível"],
    ["### Título", "título de terceiro nível"],
    ["## Título\nmais uma linha", "título com outra linha"],
    ["## **Título**", "título com ênfase"],
    ["Texto com **ênfase**.", "ênfase"],
    ["Veja [o site](https://exemplo.invalid).", "link"],
    ["1. primeiro", "lista numerada"],
    ["  recuado", "recuo"],
    ["Parágrafo\n- item", "lista colada no parágrafo"],
  ])("recusa marcação que apareceria crua (%s, %s)", (text) => {
    expect(() => termsBlocks(text)).toThrow();
  });
  it("um bloco de uma linha com ## vira título de seção", () => {
    expect(termsBlocks("## 1. O serviço\n\nTexto.")).toEqual([
      { kind: "heading", text: "1. O serviço" },
      { kind: "paragraph", text: "Texto." },
    ]);
  });
  it("a página da versão mostra o texto, a situação, a versão e o hash, e volta à origem", () => {
    route.version = CAPTURE_TERMS_VERSION;
    route.search = { voltar: "/app/org/companies/company?aba=captura" };
    render(<CaptureTermsPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Termos da captura fiscal" }),
    ).toBeTruthy();
    expect(screen.getByText(/Termos de 22\/10\/2026, como o console/)).toBeTruthy();
    expect(screen.getByText("Em vigor para novas ativações")).toBeTruthy();
    expect(screen.getByText(CAPTURE_TERMS_VERSION)).toBeTruthy();
    expect(screen.getByText(CAPTURE_TERMS_SHA256)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar SHA-256 do texto" })).toBeTruthy();
    expect(screen.getByText(lines(archivedTerms[CAPTURE_TERMS_VERSION]!)[0]!)).toBeTruthy();
    const back = screen.getByRole("link", { name: "Voltar" });
    expect(back.getAttribute("href")).toBe("/app/org/companies/company?aba=captura");
    fireEvent.click(back);
    expect(route.navigate).toHaveBeenCalledWith({ href: "/app/org/companies/company?aba=captura" });
    cleanup();
    // A deep link, without an origin, offers the organizations.
    route.search = {};
    render(<CaptureTermsPage />);
    expect(screen.getByRole("link", { name: "Ir para as organizações" }).getAttribute("href")).toBe(
      "/app",
    );
    cleanup();
    route.version = "captura-fiscal-1999-01-01";
    render(<CaptureTermsPage />);
    expect(screen.getByRole("alert").textContent).toContain("Versão dos termos não encontrada.");
    expect(
      (screen.getByRole("link", { name: "Ler os termos em vigor" }) as HTMLAnchorElement).pathname,
    ).toBe(`/termos/captura-fiscal/${CAPTURE_TERMS_VERSION}`);
  });
  it("a situação de uma versão substituída diz quando e para quem ainda vale", () => {
    expect(termsStanding(CAPTURE_TERMS_VERSION)).toBe("Em vigor para novas ativações");
    expect(termsStanding("captura-fiscal-1999-01-01")).toBeNull();
    const archive = {
      "captura-fiscal-2026-10-22": { sha256: "a", since: "2026-10-22" },
      "captura-fiscal-2026-12-01": { sha256: "b", since: "2026-12-01" },
    };
    expect(termsStanding("captura-fiscal-2026-10-22", archive, "captura-fiscal-2026-12-01")).toBe(
      "Substituída em 01/12/2026; vale para as ativações feitas antes até 30/12/2026, prazo para aceitar a nova",
    );
    expect(termsStanding("captura-fiscal-2026-12-01", archive, "captura-fiscal-2026-12-01")).toBe(
      "Em vigor para novas ativações",
    );
  });
});
