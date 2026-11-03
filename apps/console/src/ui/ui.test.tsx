// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Button } from "./button";
import { ConfirmDialog } from "./dialog";
import { Menu, MenuItem, MenuRadioItem } from "./menu";
import { TabNav, Tabs, tabLinkClass } from "./tabs";
import { CopyButton } from "./copy-button";
import { CursorPager, firstPage, type PageCursor } from "./pagination";
import { CommandPalette, filterCommands, type Command } from "./command-palette";
import { DataTable } from "./data-table";
import { Disclosure } from "./disclosure";
import { CodeBlock, Progress } from "./code-block";
import { RadioCard } from "./choice";
import { Callout, Card } from "./layout";
import { readThemePreference, setThemePreference, THEME_STORAGE_KEY } from "./theme";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Button", () => {
  it("espera o servidor desabilitado, com o indicador e o texto de espera", () => {
    const click = vi.fn();
    render(
      <Button variant="primary" loading loadingLabel="Salvando…" onClick={click}>
        Salvar
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Salvando…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.type).toBe("button");
    fireEvent.click(button);
    expect(click).not.toHaveBeenCalled();
  });
});

describe("Card", () => {
  it("nomeia a seção pelo título e, com titleRef, deixa o título receber o foco", () => {
    const ref = createRef<HTMLHeadingElement>();
    render(
      <Card id="ancora" title="Cadastrar uma empresa." titleRef={ref}>
        Conteúdo
      </Card>,
    );
    const region = screen.getByRole("region", { name: "Cadastrar uma empresa." });
    expect(region.id).toBe("ancora");
    expect(ref.current?.tabIndex).toBe(-1);
    ref.current?.focus();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Cadastrar uma empresa." }),
    );
    cleanup();
    render(<Card title="Sem foco">Conteúdo</Card>);
    expect(screen.getByRole("heading", { name: "Sem foco" }).hasAttribute("tabindex")).toBe(false);
  });
});

function DialogHarness({ onConfirm }: { onConfirm: () => Promise<string> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Revogar acesso</button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Revogar o acesso?"
        description="A pessoa deixa de ver os documentos."
        confirmLabel="Confirmar revogação"
        busyLabel="Revogando…"
        onConfirm={onConfirm}
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("abre no Cancelar, prende o Tab, fecha com Esc e devolve o foco a quem abriu", () => {
    render(<DialogHarness onConfirm={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Revogar acesso" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("alertdialog", { name: "Revogar o acesso?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancelar" });
    const confirm = screen.getByRole("button", { name: "Confirmar revogação" });
    expect(document.activeElement).toBe(cancel);
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("não fecha numa recusa do servidor e fecha quando ele confirma", async () => {
    const onConfirm = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("Este membro foi alterado.")
      .mockResolvedValueOnce("");
    render(<DialogHarness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Revogar acesso" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirmar revogação" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Este membro foi alterado.");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirmar revogação" }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("aberto por um clique que não focou o botão (Safari), devolve o foco ao destino indicado", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <h3 tabIndex={-1}>Captura</h3>
          <button onClick={() => setOpen(true)}>Pausar</button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Pausar?"
            confirmLabel="Pausar"
            onConfirm={vi.fn()}
            returnFocusTo={() => screen.getByRole("heading", { name: "Captura" })}
          />
        </>
      );
    }
    render(<Harness />);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Captura" }));
  });
});

describe("Menu", () => {
  function Harness({ onSelect }: { onSelect: (value: string) => void }) {
    return (
      <Menu trigger="Conta">
        <MenuRadioItem checked onSelect={() => onSelect("claro")}>
          Claro
        </MenuRadioItem>
        <MenuItem onSelect={() => onSelect("organizacoes")}>Todas as organizações</MenuItem>
        <MenuItem onSelect={() => onSelect("sair")}>Sair</MenuItem>
      </Menu>
    );
  }
  it("abre pelo teclado, percorre com as setas, Home e End, e Esc devolve o foco", () => {
    render(<Harness onSelect={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Conta" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = [...document.querySelectorAll<HTMLElement>("[role^=menuitem]")];
    expect(document.activeElement).toBe(items[0]);
    expect(items[0]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "t" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("executa o item escolhido e fecha; um clique fora fecha sem executar", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const trigger = screen.getByRole("button", { name: "Conta" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Sair" }));
    expect(onSelect).toHaveBeenCalledWith("sair");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("Tabs", () => {
  it("troca e foca a aba pelas setas, Home e End, montando só o painel ativo", () => {
    const change = vi.fn();
    render(
      <Tabs
        label="Seções"
        onValueChange={change}
        tabs={[
          { id: "a", label: "Resumo", content: <p>Painel resumo</p> },
          { id: "b", label: "Fiscal", content: <p>Painel fiscal</p> },
          { id: "c", label: "Certificado", content: <p>Painel certificado</p> },
        ]}
      />,
    );
    const [first, second, third] = screen.getAllByRole("tab");
    expect(first!.getAttribute("aria-selected")).toBe("true");
    expect(second!.tabIndex).toBe(-1);
    expect(screen.queryByText("Painel fiscal")).toBeNull();
    fireEvent.keyDown(first!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);
    expect(screen.getByRole("tabpanel").textContent).toBe("Painel fiscal");
    fireEvent.keyDown(second!, { key: "End" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third!, { key: "Home" });
    expect(change).toHaveBeenLastCalledWith("a");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(first!.id);
  });
});

describe("TabNav", () => {
  it("é uma navegação de links com a aba atual marcada como página, sem papel de tablist", () => {
    render(
      <TabNav label="Seções do projeto">
        {["Empresas", "Chaves"].map((label) => (
          <li key={label}>
            <a
              href={`#${label}`}
              className={tabLinkClass}
              aria-current={label === "Chaves" ? "page" : undefined}
            >
              {label}
            </a>
          </li>
        ))}
      </TabNav>,
    );
    const nav = screen.getByRole("navigation", { name: "Seções do projeto" });
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([null, "page"]);
    expect(links.every((link) => nav.contains(link))).toBe(true);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("list").className).toBe("ui-tabs__list");
  });
});

describe("CopyButton", () => {
  it("diz que copiou e, sem área de transferência, pede a cópia manual", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyButton value="fnfe_live_123" label="Copiar chave" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copiar chave" }));
    });
    expect(writeText).toHaveBeenCalledWith("fnfe_live_123");
    expect(screen.getByRole("status").textContent).toBe("Copiado.");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copiar chave" }));
    });
    expect(screen.getByRole("status").textContent).toMatch(/copie manualmente/);
  });
  it("só com ícone, mantém o nome acessível e a dica, sem o rótulo visível", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyButton value="ref123" label="Copiar referência da empresa" iconOnly />);
    const button = screen.getByRole("button", { name: "Copiar referência da empresa" });
    expect(button.textContent).toBe("");
    expect(button.getAttribute("title")).toBe("Copiar referência da empresa");
    expect(button.className).toContain("ui-button--ghost");
    expect(button.className).toContain("ui-button--icon");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith("ref123");
    expect(screen.getByRole("status").textContent).toBe("Copiado.");
  });
});

describe("CursorPager", () => {
  it("some sem outras páginas e anda para a frente e para trás guardando o cursor", () => {
    const { container, rerender } = render(
      <CursorPager label="Páginas" cursor={firstPage} nextCursor={null} onChange={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
    const onChange = vi.fn();
    rerender(
      <CursorPager label="Páginas" cursor={firstPage} nextCursor="c2" onChange={onChange} />,
    );
    expect(
      (screen.getByRole("button", { name: "Página anterior" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(onChange).toHaveBeenLastCalledWith({ current: "c2", previous: [null] });
    const second: PageCursor = { current: "c2", previous: [null] };
    rerender(<CursorPager label="Páginas" cursor={second} nextCursor={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Página anterior" }));
    expect(onChange).toHaveBeenLastCalledWith(firstPage);
  });
  it("volta direto a qualquer página já percorrida e marca a atual", () => {
    const onChange = vi.fn();
    const fourth: PageCursor = { current: "c4", previous: [null, "c2", "c3"] };
    render(<CursorPager label="Páginas" cursor={fourth} nextCursor="c5" onChange={onChange} />);
    expect(screen.getByText("4").closest("[aria-current]")?.getAttribute("aria-current")).toBe(
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "Ir para a página 1" }));
    expect(onChange).toHaveBeenLastCalledWith(firstPage);
    fireEvent.click(screen.getByRole("button", { name: "Ir para a página 3" }));
    expect(onChange).toHaveBeenLastCalledWith({ current: "c3", previous: [null, "c2"] });
  });
  it("recolhe as páginas do meio numa lista longa, mantendo a primeira", () => {
    const previous = [null, ...Array.from({ length: 10 }, (_, index) => `c${index + 2}`)];
    render(
      <CursorPager
        label="Páginas"
        cursor={{ current: "c12", previous }}
        nextCursor={null}
        onChange={vi.fn()}
      />,
    );
    const pages = screen.getAllByRole("button", { name: /^Ir para a página/ });
    expect(pages.map((page) => page.textContent)).toEqual(["1", "8", "9", "10", "11"]);
  });
});

describe("CommandPalette", () => {
  const run = vi.fn();
  const commands: Command[] = [
    { id: "1", label: "Documentos", group: "Ir para", run: () => run("documentos") },
    {
      id: "2",
      label: "Nova emissão NFS-e",
      group: "Ações",
      keywords: "nfse",
      run: () => run("emissao"),
    },
    { id: "3", label: "Importar XML", group: "Ações", run: () => run("importar") },
  ];
  beforeEach(() => run.mockReset());
  it("encontra sem acento e por termos extras", () => {
    expect(filterCommands(commands, "emissao").map((c) => c.id)).toEqual(["2"]);
    expect(filterCommands(commands, "nfse nova").map((c) => c.id)).toEqual(["2"]);
    expect(filterCommands(commands, "  ")).toHaveLength(3);
  });
  it("escolhe com as setas, executa com Enter e devolve o foco ao fechar", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Buscar</button>
          <CommandPalette open={open} onClose={() => setOpen(false)} commands={commands} />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Buscar" });
    trigger.focus();
    fireEvent.click(trigger);
    const input = screen.getByRole("combobox", { name: "Buscar telas e ações" });
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "inexistente" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Nada encontrado/);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("DataTable", () => {
  it("rotula cada célula para o modo cartão e usa o vazio quando não há linhas", () => {
    const columns = [
      { key: "doc", header: "Documento", primary: true, cell: (row: { id: string }) => row.id },
      { key: "total", header: "Total", align: "end" as const, cell: () => "R$ 1,00" },
    ];
    const { rerender } = render(
      <DataTable
        label="Emissões"
        columns={columns}
        rows={[{ id: "NFS-e 1" }]}
        rowKey={(r) => r.id}
      />,
    );
    expect(screen.getByRole("table", { name: "Emissões" })).toBeTruthy();
    const [doc, total] = screen.getAllByRole("cell");
    expect(doc!.dataset.label).toBe("Documento");
    expect(doc!.hasAttribute("data-primary")).toBe(true);
    expect(total!.dataset.align).toBe("end");
    // One box per value: on the phone, a badge and its notes stay in the value column.
    expect(doc!.children).toHaveLength(1);
    expect(doc!.firstElementChild!.className).toBe("ui-table__value");
    rerender(
      <DataTable
        label="Emissões"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<p>Nenhuma emissão</p>}
      />,
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Nenhuma emissão")).toBeTruthy();
  });
});

describe("tema", () => {
  beforeEach(() => localStorage.clear());
  it("guarda só a escolha explícita e aplica o tema resolvido na raiz", async () => {
    const dark = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => dark),
    );
    setThemePreference("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    setThemePreference("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(readThemePreference()).toBe("system");
    // "Sistema" segue a preferência do sistema operacional.
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(document.documentElement.dataset.themePreference).toBe("system");
    localStorage.setItem(THEME_STORAGE_KEY, "qualquer");
    expect(readThemePreference()).toBe("system");
    vi.unstubAllGlobals();
  });
});

describe("Disclosure, CodeBlock, Progress, RadioCard e Callout com título", () => {
  it("abre pelo summary nativo e avisa quem controla", () => {
    const change = vi.fn();
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <Disclosure
          summary="Evidências"
          open={open}
          onOpenChange={(value) => {
            change(value);
            setOpen(value);
          }}
        >
          {open ? <p>Conteúdo consultado ao abrir</p> : null}
        </Disclosure>
      );
    }
    render(<Controlled />);
    const details = screen.getByText("Evidências").closest("details")!;
    expect(details.open).toBe(false);
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(change).toHaveBeenLastCalledWith(true);
    expect(screen.getByText("Conteúdo consultado ao abrir")).toBeTruthy();
  });
  it("mostra código como texto, focável e com nome", () => {
    render(<CodeBlock label="JSON público">{'{"a":"<img src=x>"}'}</CodeBlock>);
    const pre = screen.getByLabelText("JSON público");
    expect(pre.tagName).toBe("PRE");
    expect(pre.tabIndex).toBe(0);
    expect(pre.querySelector("img")).toBeNull();
    expect(pre.textContent).toBe('{"a":"<img src=x>"}');
  });
  it("dá nome e valor à barra de progresso", () => {
    render(<Progress value={40} label="Envio de nota.xml" />);
    const bar = screen.getByRole("progressbar", {
      name: "Envio de nota.xml",
    }) as HTMLProgressElement;
    expect(bar.value).toBe(40);
    expect(bar.max).toBe(100);
  });
  it("escolhe uma opção do grupo pelo rótulo do cartão", () => {
    const change = vi.fn();
    render(
      <div role="radiogroup" aria-label="Mercado" className="ui-choice-group">
        <RadioCard name="m" value="a" label="Mercado interno" help="Em reais" onChange={change} />
        <RadioCard name="m" value="b" label="Exportação" onChange={change} />
      </div>,
    );
    fireEvent.click(screen.getByLabelText(/Exportação/));
    expect(change).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("radio", { name: /Exportação/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });
  it("faz do título do aviso um título de seção quando pedido", () => {
    render(
      <Callout tone="danger" headingLevel={2} title="Empresa indisponível">
        <p>Sem acesso.</p>
      </Callout>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Empresa indisponível" })).toBeTruthy();
  });
});
