// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createKeyBlocker,
  inheritedKeyAccess,
  KeyForm,
  keyBlocker,
  rotationBlocker,
} from "./project-keys";
import { CopyButton, OneTimeSecret } from "./integration-controls";
import { ConfirmDialog } from "./ui/dialog";
import {
  bashExample,
  DeveloperQuickstart,
  powershellExample,
  quickstartEnvironment,
  pollingNote,
  quickstartFailures,
  quickstartScopes,
  quickstartSteps,
  resultExample,
  runExample,
  webhookExample,
} from "./developer-quickstart";
import { apiOrigin, publicApiUrl } from "./api-origin";
import { Webhooks, webhookCompanyBlocker, webhookEventsBlocker } from "./webhooks";

const shell = vi.hoisted(() => ({ environment: "sandbox" as "sandbox" | "production" }));
vi.mock("./product-environment", () => ({
  useProductEnvironment: () => ({
    environment: shell.environment,
    offered: ["sandbox", "production"],
    choose: vi.fn(),
  }),
}));
vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/rota">{children}</a>,
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));
afterEach(() => {
  cleanup();
  shell.environment = "sandbox";
  vi.useRealTimers();
});

type FormProps = Parameters<typeof KeyForm>[0];
const org = { id: "org", slug: "org" } as unknown as FormProps["org"];
const project = {
  id: "p1",
  name: "ERP",
  state: "active",
  deploymentEnvironment: "sandbox",
  grantableScopes: [
    "companies:read",
    "documents:read",
    "documents:import",
    "documents:issue",
    "webhooks:manage",
  ],
} as unknown as FormProps["project"];
const grant = (
  companyId: string,
  name: string,
  scopes: string[],
  environments = ["sandbox"],
  offeredEnvironments = ["sandbox"],
) =>
  ({
    companyId,
    name,
    scopes,
    environments,
    offeredEnvironments,
    version: 1,
  }) as unknown as FormProps["grants"][number];
const full = grant("c1", "Empresa Ipê", ["companies:read", "documents:read", "webhooks:manage"]);
const narrow = grant("c2", "Empresa Jatobá", ["companies:read"]);
const generate = () => screen.getByRole("button", { name: "Gerar chave" });
const box = (name: string | RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("chave de API herda a concessão do projeto", () => {
  it("começa com as empresas e os escopos concedidos, sem pedir de novo", () => {
    render(<KeyForm org={org} project={project} grants={[full]} close={vi.fn()} />);
    expect(box("Empresa Ipê").checked).toBe(true);
    expect(box("Webhooks").checked).toBe(true);
    expect(box(/^Consultar documentos/).checked).toBe(true);
    // Escopo não concedido ao projeto não aparece para a chave.
    expect(screen.queryByRole("checkbox", { name: "Emitir e cancelar NFS-e" })).toBeNull();
    expect(generate()).toHaveProperty("disabled", false);
  });

  it("nunca esconde uma empresa por escopo e explica o bloqueio sem perder a seleção", () => {
    render(<KeyForm org={org} project={project} grants={[full, narrow]} close={vi.fn()} />);
    // Só o escopo comum às duas empresas vem marcado.
    expect(box(/^Listar empresas concedidas/).checked).toBe(true);
    expect(box("Webhooks").checked).toBe(false);
    fireEvent.click(box("Webhooks"));
    expect(box("Empresa Jatobá").checked).toBe(true);
    expect(box("Empresa Ipê").checked).toBe(true);
    expect(screen.getByText("Falta concessão: Gerenciar destinos de webhook.")).toBeTruthy();
    expect(generate()).toHaveProperty("disabled", true);
    expect(generate().getAttribute("aria-describedby")).toBe("key-blocker");
    expect(document.getElementById("key-blocker")?.textContent).toMatch(
      /^Empresa Jatobá não tem concedido/,
    );
    fireEvent.click(box("Empresa Jatobá"));
    expect(generate()).toHaveProperty("disabled", false);
  });

  it("a chave nasce no ambiente da lateral, sem escolha no formulário", () => {
    render(<KeyForm org={org} project={project} grants={[full]} close={vi.fn()} />);
    const field = screen.getByLabelText("Ambiente da chave") as HTMLSelectElement;
    expect(field.disabled).toBe(true);
    expect([...field.options].map((o) => o.textContent)).toEqual(["Sandbox"]);
    expect(field.getAttribute("aria-describedby")).toBe("key-environment-help");
    expect(
      screen.getByText(/Para uma chave de Produção, troque o ambiente na lateral/),
    ).toBeTruthy();
  });

  it("abre Produção só para a empresa com a captura fiscal ativada", () => {
    const released = grant(
      "c3",
      "Empresa Embaúba",
      ["companies:read", "documents:read"],
      ["sandbox", "production"],
      ["sandbox", "production"],
    );
    const granted = grant("c4", "Empresa Cedro", ["companies:read"], ["sandbox", "production"]);
    shell.environment = "production";
    render(<KeyForm org={org} project={project} grants={[released, granted]} close={vi.fn()} />);
    expect((screen.getByLabelText("Ambiente da chave") as HTMLSelectElement).value).toBe(
      "production",
    );
    expect(box("Empresa Embaúba").checked).toBe(true);
    expect(box("Empresa Cedro").disabled).toBe(true);
    expect(
      screen.getByText("Produção indisponível para esta empresa neste ambiente da plataforma."),
    ).toBeTruthy();
  });

  it("deriva a herança só das empresas do ambiente e exige escopo em todas", () => {
    expect(inheritedKeyAccess([full, narrow], ["companies:read", "webhooks:manage"])).toEqual({
      companyIds: ["c1", "c2"],
      scopes: ["companies:read"],
    });
    expect(inheritedKeyAccess([], ["companies:read"]).scopes).toEqual([]);
  });
});

describe("motivos de botões desabilitados", () => {
  it("Criar chave", () => {
    expect(createKeyBlocker({ projectActive: false, grants: 1 })).toMatch(/Reative o projeto/);
    expect(createKeyBlocker({ projectActive: true, grants: 0 })).toMatch(/Conceda uma empresa/);
    expect(createKeyBlocker({ projectActive: true, grants: 1 })).toBe("");
  });
  it("Gerar chave", () => {
    const companies = [{ name: "Empresa Ipê", missing: [] }];
    expect(keyBlocker({ projectActive: true, companies: [], scopes: 1 })).toBe(
      "Selecione pelo menos uma empresa.",
    );
    expect(keyBlocker({ projectActive: true, companies, scopes: 0 })).toBe(
      "Marque pelo menos um escopo.",
    );
    expect(keyBlocker({ projectActive: false, companies, scopes: 1 })).toMatch(/Reative/);
    expect(keyBlocker({ projectActive: true, companies, scopes: 1 })).toBe("");
  });
  it("Rotacionar", () => {
    const key = {
      revokedAt: null,
      rotatedAt: null,
      projectInvalidated: false,
      rotationAvailable: true,
    };
    const live = { projectActive: true, expired: false };
    expect(rotationBlocker(key, live)).toBe("");
    expect(rotationBlocker({ ...key, rotatedAt: 1 }, live)).toMatch(/já foi rotacionada/);
    expect(rotationBlocker({ ...key, rotationAvailable: false }, live)).toMatch(/concessões/);
    expect(rotationBlocker(key, { ...live, expired: true })).toMatch(/expirada/);
    expect(rotationBlocker(key, { ...live, projectActive: false })).toMatch(/Reative/);
    expect(rotationBlocker({ ...key, projectInvalidated: true }, live)).toMatch(/desativação/);
  });
  it("Webhooks apontam o escopo que filtra a lista e os escopos dos eventos", () => {
    expect(
      webhookCompanyBlocker({ scopes: ["documents:read"], environments: ["sandbox"] }),
    ).toMatch(/webhooks:manage/);
    expect(webhookCompanyBlocker({ scopes: ["webhooks:manage"], environments: ["sandbox"] })).toBe(
      "",
    );
    // In the production deployment, the company needs production access.
    expect(
      webhookCompanyBlocker(
        { scopes: ["webhooks:manage"], environments: ["sandbox"] },
        "production",
      ),
    ).toMatch(/acesso em Produção/);
    expect(
      webhookCompanyBlocker(
        { scopes: ["webhooks:manage"], environments: ["production"] },
        "production",
      ),
    ).toBe("");
    expect(webhookEventsBlocker([])).toMatch(/Importar e consultar documentos/);
    expect(webhookEventsBlocker(["document.received"])).toBe("");
  });
});

function DialogHarness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Revogar chave</button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Revogar chave?"
        description="Novas chamadas serão recusadas."
        confirmLabel="Confirmar revogação"
        onConfirm={async () => {
          onConfirm();
          return "";
        }}
      />
    </>
  );
}
describe("confirmação de ação destrutiva", () => {
  it("prende o foco, cancela com Escape e devolve o foco ao gatilho", () => {
    const confirm = vi.fn();
    render(<DialogHarness onConfirm={confirm} />);
    const trigger = screen.getByRole("button", { name: "Revogar chave" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("alertdialog", { name: "Revogar chave?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const cancel = within(dialog).getByRole("button", { name: "Cancelar" });
    const ok = within(dialog).getByRole("button", { name: "Confirmar revogação" });
    expect(document.activeElement).toBe(cancel);
    ok.focus();
    fireEvent.keyDown(ok, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(ok);
    fireEvent.keyDown(ok, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("só executa a ação ao confirmar", async () => {
    const confirm = vi.fn();
    render(<DialogHarness onConfirm={confirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Revogar chave" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirmar revogação" }));
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

function clipboard(value: { writeText: (text: string) => Promise<void> }) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}
describe("copiar", () => {
  it("copia o segredo de uso único e anuncia o resultado", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard({ writeText });
    render(
      <OneTimeSecret
        id="secret-once"
        label="Segredo da chave"
        value="fnfe_sintetico"
        created="Chave criada."
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText(/Uso único: este segredo aparece só agora/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copiar segredo" }));
    });
    expect(writeText).toHaveBeenCalledWith("fnfe_sintetico");
    expect(screen.getByText("Copiado.")).toBeTruthy();
  });
  it("orienta a cópia manual quando a área de transferência recusa", async () => {
    clipboard({ writeText: vi.fn().mockRejectedValue(new Error("negado")) });
    render(<CopyButton value="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copiar" }));
    });
    expect(screen.getByText(/copie manualmente/)).toBeTruthy();
  });
});

describe("primeira chamada", () => {
  const quickProject = { id: "p1", name: "ERP", state: "active", deploymentEnvironment: "sandbox" };
  const both = ["documents:import", "documents:read"];
  const demo = (...args: Parameters<typeof grant>) =>
    ({ ...grant(...args), kind: "demonstration" }) as never;
  const declared = (...args: Parameters<typeof grant>) =>
    ({ ...grant(...args), kind: "declared" }) as never;
  it("mostra só a empresa com acesso em Sandbox e os dois escopos, com ID, URL e escopos", () => {
    render(
      <DeveloperQuickstart
        org={org}
        project={quickProject as never}
        grants={[
          demo("c1", "Empresa Ipê", [...both, "webhooks:manage"]),
          demo("c2", "Empresa Embaúba", ["documents:read", "companies:read"]),
          demo("c3", "Empresa Aroeira", both, ["production"]),
        ]}
      />,
    );
    expect(screen.getByText("Empresa autorizada")).toBeTruthy();
    expect(screen.getByText("c1")).toBeTruthy();
    expect(screen.getByText("Demonstração")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar ID de Empresa Ipê" })).toBeTruthy();
    expect(screen.queryByText(/Nenhuma destas é a empresa de demonstração/)).toBeNull();
    for (const hidden of ["Empresa Embaúba", "c2", "Empresa Aroeira", "c3"])
      expect(screen.queryByText(hidden)).toBeNull();
    expect(screen.getByText(apiOrigin())).toBeTruthy();
    expect(apiOrigin()).not.toMatch(/\/v1/);
    expect(screen.getByRole("button", { name: "Copiar URL da API" })).toBeTruthy();
    for (const scope of both) expect(screen.getByText(scope)).toBeTruthy();
    expect(screen.queryByText("companies:read")).toBeNull();
    expect(screen.queryByText(/Nenhuma empresa deste projeto/)).toBeNull();
    expect(screen.queryByText(/O exemplo só roda em Sandbox/)).toBeNull();
    // Webhooks are the next step, not one of the steps.
    expect(document.querySelector("ol.gestao-steps")?.textContent).not.toMatch(/webhook/i);
    expect(screen.getByRole("heading", { name: "Próximo passo: receber um webhook" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar verificação em Node.js" })).toBeTruthy();
    for (const name of ["variáveis do PowerShell", "variáveis do Bash", "comando de importação"])
      expect(screen.getByRole("button", { name: `Copiar ${name}` })).toBeTruthy();
  });
  it("avisa e indica o caminho quando nenhuma empresa serve ao exemplo", () => {
    render(
      <DeveloperQuickstart
        org={org}
        project={quickProject as never}
        grants={[demo("c1", "Empresa Ipê", ["companies:read", "documents:read"])]}
      />,
    );
    expect(
      screen.getByText(
        /Nenhuma empresa deste projeto tem acesso em Sandbox com Importar XML e Consultar documentos/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Primeiros passos")).toBeTruthy();
    expect(screen.getAllByText("Empresas e acesso").length).toBeGreaterThan(0);
    expect(screen.queryByText("c1")).toBeNull();
    expect(screen.queryByRole("button", { name: /Copiar ID/ })).toBeNull();
  });
  it("põe a empresa de demonstração primeiro e avisa quando ela não está entre as que servem", () => {
    const view = render(
      <DeveloperQuickstart
        org={org}
        project={{ ...quickProject, deploymentEnvironment: "production" } as never}
        grants={[
          declared("c1", "Empresa Ipê", both),
          demo("c2", "Empresa Embaúba", both, ["sandbox", "production"]),
        ]}
      />,
    );
    expect(screen.getByText("Empresas autorizadas")).toBeTruthy();
    expect(
      screen
        .getAllByRole("button", { name: /^Copiar ID de / })
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Copiar ID de Empresa Embaúba", "Copiar ID de Empresa Ipê"]);
    expect(screen.getAllByText("Demonstração")).toHaveLength(1);
    expect(screen.getByText(/O exemplo só roda em Sandbox/)).toBeTruthy();
    view.unmount();
    render(
      <DeveloperQuickstart
        org={org}
        project={quickProject as never}
        grants={[declared("c1", "Empresa Ipê", both)]}
      />,
    );
    expect(screen.getByText(/Nenhuma destas é a empresa de demonstração/)).toBeTruthy();
    expect(
      screen.getByText(/Proprietário ou Administrador usa Explorar demonstração/),
    ).toBeTruthy();
    expect(screen.getByText("Primeiros passos")).toBeTruthy();
    expect(screen.queryByText("Demonstração")).toBeNull();
  });
  it("com mais concessões a carregar, não afirma que falta a empresa de demonstração", () => {
    const view = render(
      <DeveloperQuickstart
        org={org}
        project={quickProject as never}
        grants={[declared("c1", "Empresa Ipê", both)]}
        complete={false}
      />,
    );
    expect(screen.queryByText(/Nenhuma destas é a empresa de demonstração/)).toBeNull();
    expect(screen.getByText(/não está entre as empresas carregadas até agora/)).toBeTruthy();
    view.unmount();
    render(
      <DeveloperQuickstart
        org={org}
        project={quickProject as never}
        grants={[declared("c1", "Empresa Ipê", ["companies:read"])]}
        complete={false}
      />,
    );
    expect(screen.queryByText(/Nenhuma empresa deste projeto/)).toBeNull();
    expect(screen.getByText(/Nenhuma das empresas carregadas até agora/)).toBeTruthy();
  });
  it("o painel e o guia listam as mesmas falhas, com a mesma recuperação", () => {
    const guide = readFileSync(
      join(process.cwd(), "apps/docs/content/docs/primeira-chamada.mdx"),
      "utf8",
    ).replaceAll("\r\n", "\n");
    const section = guide.slice(guide.indexOf("## Se algo falhar"), guide.indexOf("## O que"));
    const plain = (cell: string) =>
      cell
        .replace(/<Ui>([^<]*)<\/Ui>/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replaceAll("`", "")
        .trim();
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("| ") && !/^\| (O script imprime|-)/.test(line))
      .map((line) => line.split(" | ").map((cell) => plain(cell.replace(/^\| | \|$/g, ""))));
    expect(rows).toEqual(
      quickstartFailures.map((f) => [`${f.message}${f.when ? ` ${f.when}` : ""}`, f.fix]),
    );
    expect(rows.map(([message]) => message)).toEqual(
      expect.arrayContaining([
        "reserva: NOT_FOUND",
        "reserva: IDEMPOTENCY_CONFLICT",
        "resultado: COMPANY_MISMATCH",
        "…: RATE_LIMITED",
      ]),
    );
    // Every step and message in the table is one the script prints.
    const script = readFileSync(join(process.cwd(), "examples/quickstart-curl.mjs"), "utf8");
    const steps = quickstartFailures
      .map((f) => /^([a-zçãõ]+): /.exec(f.message)?.[1])
      .filter((s): s is string => Boolean(s));
    expect(new Set(steps)).toEqual(new Set(["reserva", "envio", "processamento", "resultado"]));
    // The script's steps, in order, are the ones the guide names before the table.
    const scriptSteps = [...script.matchAll(/step = "([^"]+)"/g)].map((m) => m[1]);
    expect(scriptSteps[0]).toBe("reserva");
    for (const step of steps) expect(scriptSteps, step).toContain(step);
    const prose = /parou: (.+?)\. /.exec(section)![1]!;
    expect(prose.replaceAll("`", "").split(/, | ou /)).toEqual(scriptSteps);
    expect(scriptSteps).toEqual([...quickstartSteps]);
    expect(guide).toContain("se ele estourar, o script espera o `Retry-After` e continua");
    for (const literal of [
      "throw new Error(`Defina ${name}`)",
      '"Origem inválida"',
      "Origem de upload inesperada",
      "curl falhou",
      "resposta sem JSON",
      "processamento: Operação ${operation.state}",
      "resultado: ${batch.files[0].code",
      "${step}: ${value.error.code}; requestId=",
    ])
      expect(script).toContain(literal);
    render(
      <DeveloperQuickstart
        org={org}
        project={quickProject as never}
        grants={[demo("c1", "Empresa Ipê", both)]}
      />,
    );
    for (const f of quickstartFailures)
      expect(screen.getAllByText(f.fix).length).toBeGreaterThan(0);
    // The panel's help names every step, in the script's order, and what has no requestId.
    const help = screen.getByText(/A mensagem começa pela etapa/).textContent ?? "";
    expect(help).toContain(
      `parou: ${quickstartSteps.slice(0, -1).join(", ")} ou ${quickstartSteps.at(-1)}.`,
    );
    expect(help).toContain("(Origem inválida, curl falhou, resposta sem JSON) não têm requestId");
    expect(help).toContain("…: vale para qualquer etapa");
    expect(screen.getByText(pollingNote)).toBeTruthy();
    expect(pollingNote).toContain("Retry-After");
    expect(screen.getByRole("link", { name: "Documentos" })).toBeTruthy();
  });
  it("mostra os comandos do guia, com a URL do build e sem segredo", () => {
    render(
      <DeveloperQuickstart
        org={org}
        project={quickProject as never}
        grants={[demo("c1", "Empresa Ipê", both)]}
      />,
    );
    const powershell = screen.getByRole("region", { name: "Variáveis no PowerShell" });
    const bash = screen.getByRole("region", { name: "Variáveis no Bash" });
    expect(powershell.textContent).toBe(powershellExample(apiOrigin()));
    expect(bash.textContent).toBe(bashExample(apiOrigin()));
    expect(powershell.textContent).toContain("Read-Host 'Chave de API' -AsSecureString");
    expect(bash.textContent).toContain("read -r -s -p 'Chave de API: '");
    expect(screen.getByRole("region", { name: "Comando de importação" }).textContent).toBe(
      "node quickstart-curl.mjs",
    );
    const downloads = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"))
      .filter((href) => href?.match(/\.(xml|mjs)$/));
    expect(downloads).toEqual(["/examples/nfe-demonstracao.xml", "/developer/quickstart-curl.mjs"]);
  });
  it("o guia público pede os mesmos escopos e mostra os mesmos comandos do painel", () => {
    const guide = readFileSync(
      join(process.cwd(), "apps/docs/content/docs/primeira-chamada.mdx"),
      "utf8",
    ).replaceAll("\r\n", "\n");
    expect(guide).toContain(powershellExample(publicApiUrl));
    expect(guide).toContain(bashExample(publicApiUrl));
    expect(guide).toContain(runExample);
    expect(guide).toContain(resultExample);
    for (const scope of quickstartScopes) expect(guide).toContain(`\`${scope}\``);
    expect(guide).not.toContain("companies:read");
    for (const file of ["/examples/nfe-demonstracao.xml", "/developer/quickstart-curl.mjs"])
      expect(guide).toContain(`href="${file}"`);
  });
  it("os escopos pedidos são exatamente os das rotas que o script chama", () => {
    const root = process.cwd();
    // /developer/quickstart-curl.mjs is this file, copied by the console build
    // (developer-plugin.ts; tests/publicSite.test.ts checks the bytes).
    const script = readFileSync(join(root, "examples/quickstart-curl.mjs"), "utf8");
    expect(script).toContain('"X-Environment: sandbox"');
    expect(new Set(script.match(/\/v1\/[a-z-]+/g))).toEqual(
      new Set(["/v1/imports", "/v1/operations", "/v1/documents"]),
    );
    const used: Record<string, string> = {
      reserveImport: '"/v1/imports", "POST"',
      getImport: "curl(`/v1/imports/${encodeURIComponent(reserved.importId)}`)",
      createUpload: "`${path}/upload`",
      uploadImport: "curl(ticket.url",
      confirmImport: "`${path}/confirm`",
      getOperation: "/v1/operations/",
      documentJson: "/json?",
      documentItems: "/items?",
    };
    const openapi = JSON.parse(readFileSync(join(root, "docs/v1.0/openapi.json"), "utf8")) as {
      paths: Record<string, Record<string, { operationId: string; "x-scope": string }>>;
    };
    const scopeOf = new Map(
      Object.values(openapi.paths)
        .flatMap((methods) => Object.values(methods))
        .map((op) => [op.operationId, op["x-scope"]]),
    );
    const scopes = new Set<string>();
    for (const [operationId, marker] of Object.entries(used)) {
      expect(script, operationId).toContain(marker);
      const scope = scopeOf.get(operationId);
      expect(scope, operationId).toBeTruthy();
      if (/^[a-z]+:[a-z]+$/.test(scope!)) scopes.add(scope!);
    }
    // getOperation takes the scope of the task: the import's, documents:import.
    expect(scopeOf.get("getOperation")).toBe("escopo da operação");
    expect([...scopes].sort()).toEqual([...quickstartScopes].sort());
    expect(quickstartEnvironment).toBe("sandbox");
  });
  it("o verificador de webhook do exemplo aceita os vetores do contrato e recusa adulteração", () => {
    const vectors = JSON.parse(
      readFileSync(join(process.cwd(), "packages/contracts/fixtures/webhooks.json"), "utf8"),
    ) as Array<{
      name: string;
      body: string;
      headers: Record<string, string>;
      secrets: Array<{ version: number; secret: string }>;
      now: number;
      expected: string;
    }>;
    // Run the exact text a person copies, as an ES module in a separate Node process.
    const valid = vectors.find((v) => v.name === "new")!;
    const secret = valid.secrets[0]!;
    expect(valid.expected).toBe("OK");
    const cases = [
      [secret.secret, valid.body, valid.now],
      [secret.secret, `${valid.body} `, valid.now],
      ["outro", valid.body, valid.now],
      [secret.secret, valid.body, valid.now + 400_000],
    ];
    const harness = `${webhookExample}
const cases = ${JSON.stringify(cases)};
const headers = ${JSON.stringify(valid.headers)};
console.log(JSON.stringify(cases.map(([s, body, now]) =>
  assinaturaValida(s, ${secret.version}, headers, Buffer.from(body), now))));`;
    const output = execFileSync("node", ["--input-type=module", "-e", harness], {
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toEqual([true, false, false, false]);
  });
});

describe("webhooks em Produção", () => {
  const orgFull = { id: "org", slug: "org" } as unknown as Parameters<typeof Webhooks>[0]["org"];
  it("segue o ambiente da lateral, e Produção só para a empresa com a captura fiscal ativada", () => {
    const released = grant(
      "c3",
      "Empresa Embaúba",
      ["documents:read", "webhooks:manage"],
      ["sandbox", "production"],
      ["sandbox", "production"],
    );
    const view = render(
      <Webhooks org={orgFull} projectId={"p1" as never} grants={[released] as never} />,
    );
    // No environment field: the shell's choice, named on the card.
    expect(screen.queryByLabelText("Ambiente")).toBeNull();
    expect(screen.getByText("Sandbox", { selector: ".ui-badge" })).toBeTruthy();
    view.unmount();
    shell.environment = "production";
    const production = render(
      <Webhooks org={orgFull} projectId={"p1" as never} grants={[released] as never} />,
    );
    expect(screen.getByText("Produção", { selector: ".ui-badge" })).toBeTruthy();
    production.unmount();
    render(
      <Webhooks
        org={orgFull}
        projectId={"p1" as never}
        grants={[grant("c1", "Empresa Ipê", ["webhooks:manage"])] as never}
      />,
    );
    expect(screen.getByText(/Esta empresa não tem Produção/)).toBeTruthy();
  });
});
