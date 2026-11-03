// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { RouterProvider } from "@tanstack/react-router";
import { accessKeyDigit } from "../../../packages/fiscal-core/src/accessKey";
import { groupKey } from "./format";
import type { PhotoRead } from "./danfe-photo";

/**
 * The DANFE lookup (#296) in the real route tree, with the Convex hooks answering as a member of
 * one organization. Synthetic keys only: the fictitious CNPJ 11.222.333/0001-81 and the RFB
 * example 12.ABC.345/01DE-35, with a check digit computed here.
 */
const state = vi.hoisted(() => ({
  role: "viewer" as "viewer" | "developer" | "owner",
  writes: 0,
}));
vi.mock("./auth", () => ({ authClient: { signOut: vi.fn() } }));
// The barcode decoder at its boundary: what it would read from the chosen image. The real
// reader runs on synthetic images in danfe-photo.test.ts.
const photo = vi.hoisted(() => ({
  readPhoto: vi.fn<(file: Blob) => Promise<PhotoRead>>(),
}));
vi.mock("./danfe-photo", () => photo);
vi.mock("convex/react", async (original) => {
  const real = await original<typeof import("convex/react")>();
  const useQuery = (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(reference);
    if (name === "access:session")
      return { name: "Ana Sintética", email: "a@x.invalid", role: null };
    if (name === "account:profile") return { name: "Ana Sintética" };
    if (name === "organizations:context") return organization();
    return undefined;
  };
  return {
    ...real,
    ConvexReactClient: class {
      connectionState() {}
      prewarmQuery() {}
    },
    useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
    useConvexConnectionState: () => ({ isWebSocketConnected: true, connectionCount: 1 }),
    useMutation: () => () => {
      state.writes++;
      return Promise.resolve(null);
    },
    useAction: () => () => {
      state.writes++;
      return Promise.resolve(null);
    },
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useQuery,
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query, args }]) => [key, useQuery(query, args)]),
      ),
  };
});
// One object per role, stable across renders like a Convex query answer.
const organizations = new Map<string, ReturnType<typeof makeOrganization>>();
function organization() {
  if (!organizations.has(state.role)) organizations.set(state.role, makeOrganization());
  return organizations.get(state.role)!;
}
function makeOrganization() {
  const manager = state.role === "owner";
  return {
    id: "org",
    name: "Equipe Ipê",
    slug: "equipe",
    role: state.role,
    membershipId: "m",
    membershipVersion: 1,
    memberCount: 1,
    ownerCount: 1,
    closure: null,
    termsOfUse: null,
    capabilities: {
      manageOrganization: manager,
      manageMembers: manager,
      manageIntegrations: manager || state.role === "developer",
      operateDocuments: manager,
      readDocuments: state.role !== "developer",
    },
  };
}

const { router } = await import("./routes");

const withDigit = (base: string) => base + accessKeyDigit(base);
const valid = withDigit("3526091122233300018155001000000069112345678");
const printed = valid.replace(/(.{4})(?=.)/g, "$1 ");
const portal = "https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx";

beforeEach(() => {
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  localStorage.clear();
  sessionStorage.clear();
  state.role = "viewer";
  state.writes = 0;
});
afterEach(cleanup);

async function open(
  path = "/app/equipe/imports/danfe",
  heading: string | null = "Consultar NF-e pelo DANFE",
) {
  window.history.replaceState(null, "", path);
  render(<RouterProvider router={router} />);
  // The router is the console's single instance: a later test moves it to its own address.
  await act(async () => {
    await router.navigate({ href: path, replace: true });
  });
  if (heading) await screen.findByRole("heading", { level: 1, name: heading }, { timeout: 5000 });
}
const field = () => screen.getByLabelText("Chave de acesso da NF-e") as HTMLTextAreaElement;
function check(text: string) {
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Conferir chave" }));
}
const portalLink = () => screen.queryByRole("link", { name: /Consultar no Portal da NF-e/ });
/** The live region of the key's form (the copy button has another one, inside the result). */
const liveRegion = () =>
  within(screen.getByRole("region", { name: "Chave de acesso" })).getByRole("status");
const announced = () => liveRegion().textContent?.trim();
/** "Lido da chave" as term → definition, read the way a screen reader lists them. */
function readFrom(result: HTMLElement) {
  return Object.fromEntries(
    within(result)
      .getAllByRole("term")
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
  );
}
/** Everything the browser could keep beyond the component: address, history and storage. */
function kept() {
  const storage = (area: Storage) =>
    Array.from({ length: area.length }, (_, i) => `${area.key(i)}=${area.getItem(area.key(i)!)}`);
  return [
    window.location.href,
    JSON.stringify(window.history.state),
    router.state.location.href,
    ...storage(localStorage),
    ...storage(sessionStorage),
  ].join("\n");
}

describe("consulta pelo DANFE", () => {
  it("abre pelo endereço direto, para qualquer membro, sem empresa escolhida", async () => {
    state.role = "developer";
    await open();
    expect(field().value).toBe("");
    expect(portalLink()).toBeNull();
  });

  it("chega pela tela de importação e devolve a ela quem importa", async () => {
    state.role = "owner";
    await open("/app/equipe/imports", "Importar XML");
    fireEvent.click(await screen.findByRole("link", { name: "Consultar pelo DANFE" }));
    await screen.findByRole("heading", { level: 1, name: "Consultar NF-e pelo DANFE" });
    expect(router.state.location.pathname).toBe("/app/equipe/imports/danfe");
    const nav = screen.getByRole("navigation", { name: "Navegação da organização" });
    await waitFor(() =>
      expect(
        within(nav).getByRole("link", { name: "Importar XML" }).getAttribute("aria-current"),
      ).toBe("page"),
    );
    // The back link and the closing notice both lead to the import.
    const main = screen.getByRole("main");
    expect(
      within(main)
        .getAllByRole("link", { name: /Importar XML/ })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/app/equipe/imports", "/app/equipe/imports"]);
  });

  it("chega por Documentos quem só lê, sem apontar para a importação", async () => {
    await open("/app/equipe/documents", "Documentos fiscais");
    fireEvent.click(await screen.findByRole("link", { name: "Consultar pelo DANFE" }));
    await screen.findByRole("heading", { level: 1, name: "Consultar NF-e pelo DANFE" });
    const nav = screen.getByRole("navigation", { name: "Navegação da organização" });
    await waitFor(() =>
      expect(
        within(nav).getByRole("link", { name: "Documentos" }).getAttribute("aria-current"),
      ).toBe("page"),
    );
    const main = screen.getByRole("main");
    expect(within(main).queryByRole("link", { name: /Importar XML/ })).toBeNull();
    expect(within(main).getByRole("link", { name: "Documentos" }).getAttribute("href")).toBe(
      "/app/equipe/documents",
    );
    expect(main.textContent).toContain(
      "o XML precisa ser importado por quem tem papel de Operador, Administrador ou Proprietário, ou por uma integração",
    );
  });

  it("chega pela busca do painel quem trabalha só pelas integrações", async () => {
    state.role = "developer";
    await open("/app/equipe", null);
    const search = await screen.findAllByRole(
      "button",
      { name: /Buscar ou ir para/ },
      { timeout: 5000 },
    );
    fireEvent.click(search[0]!);
    fireEvent.click(await screen.findByRole("option", { name: /Consultar NF-e pelo DANFE/ }));
    await screen.findByRole("heading", { level: 1, name: "Consultar NF-e pelo DANFE" });
    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: "Início" }).getAttribute("href")).toBe(
      "/app/equipe",
    );
    expect(within(main).queryByRole("link", { name: /Importar XML/ })).toBeNull();
  });

  it("lê a chave colada como no DANFE, mostra o que leu e abre o portal oficial com ela", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open();
    check(` ${printed.slice(0, 27)}\n${printed.slice(27).toLowerCase()} `);

    // The field shows the key in groups of four, for the person to compare with the DANFE.
    expect(field().value).toBe(printed);
    expect(field().getAttribute("aria-invalid")).toBeNull();
    const result = screen.getByRole("region", { name: "Lido da chave" });
    expect(within(result).getByText(printed)).toBeTruthy();
    expect(result.textContent).toContain("não que a NF-e exista ou esteja autorizada");
    // The person lands on what was read: the result's heading takes the focus.
    expect(document.activeElement).toBe(
      within(result).getByRole("heading", { name: "Lido da chave" }),
    );
    expect(readFrom(result)).toMatchObject({
      UF: "SP (código 35)",
      "Mês de emissão": "09/2026",
      Modelo: "55 (NF-e)",
      Série: "1",
      Número: "69",
      "CNPJ do emitente": "11.222.333/0001-81",
      "Tipo de emissão": "Normal",
    });

    const link = portalLink()!;
    expect(link.getAttribute("href")).toBe(`${portal}?tipoConsulta=resumo&nfe=${valid}`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("abre em nova aba");
    expect(result.textContent).toContain("CAPTCHA");
    expect(result.textContent).toContain("parcialmente ocultos");
    expect(result.textContent).toContain("exigem certificado digital");

    await act(async () => {
      fireEvent.click(within(result).getByRole("button", { name: "Copiar chave" }));
    });
    expect(writeText).toHaveBeenCalledWith(valid);
    expect(within(result).getByRole("status").textContent).toBe("Copiado.");

    // Opening the portal is the person's own step: nothing is written to the platform.
    expect(state.writes).toBe(0);
  });

  it("anuncia a recusa de novo a cada Enter, sem conferir durante a composição", async () => {
    await open();
    fireEvent.change(field(), { target: { value: valid.slice(0, 40) } });
    field().focus();
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    expect(announced()).toBe("");
    fireEvent.keyDown(field(), { key: "Enter" });
    const message = "A chave tem 40 de 44 posições. Confira no DANFE se faltou algum grupo.";
    expect(announced()).toBe(message);
    // The same refusal again still changes the live region, so it is read again.
    const first = liveRegion();
    const before = first.textContent;
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(first.textContent).not.toBe(before);
    expect(first.textContent?.trim()).toBe(message);
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute("enterkeyhint")).toBe("go");
  });

  it("mostra as duas leituras quando o emitente vale como CNPJ e como CPF", async () => {
    await open();
    // The placeholder CPF 001.234.567-97 after three zeros is also a valid CNPJ.
    check(withDigit("4326010000012345679755001000000001912345678"));
    const result = screen.getByRole("region", { name: "Lido da chave" });
    expect(readFrom(result)).toMatchObject({
      "CNPJ ou CPF do emitente": "00.000.123/4567-97 ou 001.234.567-97",
      "Tipo de emissão": "9 (contingência off-line, própria da NFC-e)",
    });
  });

  it("aceita a chave com CNPJ alfanumérico", async () => {
    await open();
    const key = withDigit("53261212ABC34501DE3555002000001234912345678");
    check(key);
    const result = screen.getByRole("region", { name: "Lido da chave" });
    expect(result.textContent).toContain("12.ABC.345/01DE-35");
    expect(result.textContent).toContain("DF (código 53)");
    expect(portalLink()?.getAttribute("href")).toBe(`${portal}?tipoConsulta=resumo&nfe=${key}`);
  });

  it.each([
    ["vazia", "", "Digite ou cole a chave de acesso impressa no DANFE."],
    [
      "incompleta",
      valid.slice(0, 40),
      "A chave tem 40 de 44 posições. Confira no DANFE se faltou algum grupo.",
    ],
    [
      "longa demais",
      valid + "12",
      "A chave tem 46 posições, mais que as 44 de uma NF-e. Confira se outro número entrou junto.",
    ],
    [
      "com caractere estranho",
      valid.slice(0, 10) + "#" + valid.slice(11),
      "A chave só tem números e, no CNPJ do emitente, letras. Remova “#”.",
    ],
    [
      "com letra fora do CNPJ",
      valid.slice(0, 30) + "O" + valid.slice(31),
      "Há uma letra na posição 31. Letras só aparecem nas posições 7 a 18, do CNPJ do emitente; confira se é um número.",
    ],
    [
      "com dígito verificador errado",
      valid.slice(0, 43) + String((Number(valid[43]) + 1) % 10),
      "O dígito verificador (última posição) não confere com as outras 43. Algum caractere está diferente do DANFE: confira a chave grupo por grupo.",
    ],
    [
      "de NFC-e",
      withDigit("3526091122233300018165001000000069112345678"),
      "Esta chave é de NFC-e (modelo 65), o cupom do consumidor. Esta consulta atende só NF-e modelo 55.",
    ],
    [
      "com UF inexistente",
      withDigit("3426091122233300018155001000000069112345678"),
      "As duas primeiras posições (34) não são o código de uma UF.",
    ],
    [
      "com mês inexistente",
      withDigit("3526131122233300018155001000000069112345678"),
      "O mês de emissão (posições 5 e 6) é 13, que não existe.",
    ],
    [
      "com tipo de emissão inexistente",
      withDigit("3526091122233300018155001000000069812345678"),
      "O tipo de emissão (posição 35) é 8, que não existe na NF-e.",
    ],
    [
      "com número zerado",
      withDigit("3526091122233300018155001000000000112345678"),
      "O número da nota (posições 26 a 34) está zerado.",
    ],
    [
      "com CNPJ inválido",
      withDigit("3526091122233300018255001000000069112345678"),
      "O CNPJ ou CPF do emitente (posições 7 a 20) não é válido.",
    ],
  ])("recusa a chave %s com a mensagem do problema e sem portal", async (_, text, message) => {
    await open();
    check(text);
    const control = field();
    const description = (control.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(description).toContain(message);
    // The click moves the focus to the field, which reads the refusal from its description; the
    // status line stays quiet so it is not read twice.
    expect(announced()).toBe("");
    expect(control.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(control);
    expect(portalLink()).toBeNull();
    // Never completed or guessed: the field keeps exactly the characters typed.
    expect(control.value.replace(/\s/g, "")).toBe(text.toUpperCase());
  });

  it("uma correção pede nova conferência antes do portal", async () => {
    await open();
    check(valid);
    expect(portalLink()).not.toBeNull();
    fireEvent.change(field(), { target: { value: valid.slice(0, 43) } });
    expect(portalLink()).toBeNull();
    // Enter reaches the field only while it has the focus.
    field().focus();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(announced()).toMatch(/^A chave tem 43 de 44 posições/);
  });

  it("não guarda a chave no endereço nem no armazenamento do navegador", async () => {
    await open();
    check(printed);
    expect(portalLink()).not.toBeNull();
    await waitFor(() => expect(router.state.location.pathname).toBe("/app/equipe/imports/danfe"));
    const everything = kept();
    expect(everything).not.toContain(valid);
    expect(everything).not.toContain(valid.slice(0, 20));
    expect(everything).not.toContain(printed.slice(0, 24));
  });
});

describe("chave lida pela foto do DANFE", () => {
  const second = withDigit("3526091122233300018155001000000070112345678");
  const nfce = withDigit("3526091122233300018165001000000069112345678");
  const compare = "Chave lida do código de barras. Compare com a chave impressa no DANFE.";
  const photoInput = () =>
    screen.getByLabelText(/^(Ler a chave pela foto|Lendo a imagem…)$/) as HTMLInputElement;
  const image = (type = "image/jpeg", name = "danfe-sintetico.jpg") =>
    new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], name, { type });
  const choose = (...files: File[]) => fireEvent.change(photoInput(), { target: { files } });
  const help = () => document.getElementById(`${field().id}-help`)?.textContent ?? "";
  const notice = (title: string) => screen.getByText(title).closest(".ui-callout")!;
  /** What the reader would return: CODE-128 texts, as read. */
  const barcodes = (...texts: string[]): PhotoRead => ({
    kind: "read",
    codes: texts.map((text) => ({ format: "Code128", text })),
  });
  /** A reading that ends when the test says so. */
  function pending() {
    let finish!: (read: PhotoRead) => void;
    photo.readPhoto.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    return (read: PhotoRead) => act(async () => finish(read));
  }
  const createObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");

  beforeEach(() => {
    photo.readPhoto.mockReset();
  });
  afterEach(() => {
    if (createObjectURL) Object.defineProperty(URL, "createObjectURL", createObjectURL);
    else delete (URL as { createObjectURL?: unknown }).createObjectURL;
  });

  it("põe a chave lida no campo, em grupos, confere e pede a comparação com a impressa", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const xhr = vi.spyOn(XMLHttpRequest.prototype, "open");
    const objectUrl = vi.fn(() => "blob:nunca");
    URL.createObjectURL = objectUrl;
    photo.readPhoto.mockResolvedValue(barcodes(valid));
    await open();
    const file = image();
    choose(file);

    const result = await screen.findByRole("region", { name: "Lido da chave" });
    // The image goes to the local reader only, once, and the picker forgets it.
    expect(photo.readPhoto).toHaveBeenCalledExactlyOnceWith(file);
    expect(photoInput().value).toBe("");
    expect(field().value).toBe(printed);
    expect(result.textContent).toContain(compare);
    expect(help()).toContain(compare);
    expect(announced()).toBe(compare);
    expect(readFrom(result)).toMatchObject({ "CNPJ do emitente": "11.222.333/0001-81" });
    expect(portalLink()?.getAttribute("href")).toBe(`${portal}?tipoConsulta=resumo&nfe=${valid}`);

    // Nothing leaves the tab or stays behind: no request, no object URL, no address or storage.
    expect(fetch).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    expect(objectUrl).not.toHaveBeenCalled();
    const everything = kept();
    expect(everything).not.toContain(valid);
    expect(everything).not.toContain("danfe-sintetico");
    expect(state.writes).toBe(0);
    fetch.mockRestore();
    xhr.mockRestore();

    // Corrected by hand, the key is the person's: the request to compare goes away.
    fireEvent.change(field(), { target: { value: printed.slice(0, -1) } });
    expect(help()).not.toContain(compare);
    expect(portalLink()).toBeNull();
  });

  it("diz que está lendo e não aceita outra imagem até terminar", async () => {
    const finish = pending();
    await open();
    choose(image());
    expect(photoInput().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Lendo a imagem…", { selector: "label" })).toBeTruthy();
    expect(announced()).toBe("Lendo a imagem…");
    await waitFor(() => expect(photo.readPhoto).toHaveBeenCalledTimes(1));
    choose(image());
    await act(async () => {});
    expect(photo.readPhoto).toHaveBeenCalledTimes(1);

    await finish(barcodes());
    const title = "Não encontrei o código de barras da chave nesta imagem.";
    const box = notice(title);
    expect(box.textContent).toContain("Tente outra foto ou digite a chave no campo abaixo.");
    expect(box.textContent).toContain("Use boa luz, sem reflexo nem sombra sobre as barras.");
    expect(announced()?.startsWith(title)).toBe(true);
    expect(photoInput().getAttribute("aria-disabled")).toBeNull();
    // Typing stays available, and nothing was put in the field.
    expect(field().value).toBe("");
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });

  it("não troca o que a pessoa digitou enquanto a foto era lida", async () => {
    const finish = pending();
    await open();
    choose(image());
    await waitFor(() => expect(photo.readPhoto).toHaveBeenCalledTimes(1));
    fireEvent.change(field(), { target: { value: second } });
    await finish(barcodes(valid));

    expect(field().value).toBe(second);
    expect(portalLink()).toBeNull();
    const box = notice("Mantive o que você digitou.");
    expect(box.textContent).toContain("Para usar a foto, escolha a imagem de novo.");
    expect(announced()?.startsWith("Mantive o que você digitou.")).toBe(true);
    // The next photo, without typing meanwhile, fills the field again.
    photo.readPhoto.mockResolvedValue(barcodes(valid));
    choose(image());
    await screen.findByRole("region", { name: "Lido da chave" });
    expect(field().value).toBe(printed);
  });

  it.each([
    [["0123456789"], "O código lido tem 10 posições; a chave tem 44."],
    [
      ["0123456789", "1".repeat(36), "1".repeat(45)],
      "Os códigos lidos têm 10, 36 e 45 posições; a chave tem 44.",
    ],
    [
      [valid.slice(0, 43) + "a"],
      "O código lido tem 44 posições, mas com caracteres que uma chave não tem.",
    ],
    [
      ["0123456789", valid.slice(0, 43) + "a"],
      "O código lido tem 10 posições, e o de 44 posições tem caracteres que uma chave não tem.",
    ],
  ])("não preenche códigos que não são chave (%j)", async (texts, reason) => {
    photo.readPhoto.mockResolvedValue(barcodes(...texts));
    await open();
    choose(image());
    const box = await waitFor(() => notice("O código de barras lido não é a chave de acesso."));
    expect(box.textContent).toContain(reason);
    expect(box.textContent).not.toMatch(/têm 44|44 posições; a chave tem 44/);
    expect(field().value).toBe("");
    expect(portalLink()).toBeNull();
  });

  it("anuncia de novo a mesma recusa da foto", async () => {
    photo.readPhoto.mockResolvedValue(barcodes());
    await open();
    const title = "Não encontrei o código de barras da chave nesta imagem.";
    choose(image());
    await waitFor(() => notice(title));
    const first = liveRegion().textContent;
    // A refusal before the reader (no "Lendo a imagem…" in between) twice in a row.
    choose(image(), image());
    await waitFor(() => notice("Escolha uma imagem por vez."));
    const once = liveRegion().textContent;
    choose(image(), image());
    expect(liveRegion().textContent).not.toBe(once);
    expect(liveRegion().textContent?.trim()).toBe(once?.trim());
    expect(first?.startsWith(title)).toBe(true);
  });

  it("com duas chaves na imagem, lista as duas e usa só a que a pessoa escolhe", async () => {
    photo.readPhoto.mockResolvedValue(barcodes(valid, second));
    await open();
    choose(image());
    const list = await screen.findByRole("list", { name: "Chaves lidas da imagem" });
    expect(announced()).toBe(
      "Encontrei 2 chaves diferentes nesta imagem. Escolha a que você quer conferir.",
    );
    // Never picked by the console.
    expect(field().value).toBe("");
    expect(portalLink()).toBeNull();
    const options = within(list).getAllByRole("button");
    expect(options.map((option) => option.textContent)).toEqual([
      `Usar a chave ${groupKey(valid)}`,
      `Usar a chave ${groupKey(second)}`,
    ]);
    fireEvent.click(options[1]!);
    expect(field().value).toBe(groupKey(second));
    expect(screen.queryByRole("list", { name: "Chaves lidas da imagem" })).toBeNull();
    expect(portalLink()?.getAttribute("href")).toBe(`${portal}?tipoConsulta=resumo&nfe=${second}`);
  });

  it("a chave de NFC-e num código de barras recebe a mesma recusa da digitada", async () => {
    photo.readPhoto.mockResolvedValue(barcodes(nfce));
    await open();
    choose(image());
    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));
    expect(field().value).toBe(groupKey(nfce));
    expect(document.activeElement).toBe(field());
    const description = (field().getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(description).toContain(
      "Esta chave é de NFC-e (modelo 65), o cupom do consumidor. Esta consulta atende só NF-e modelo 55.",
    );
    expect(portalLink()).toBeNull();
  });

  it("o QR code de um cupom NFC-e diz que é NFC-e, sem preencher nada", async () => {
    const address = `https://www.nfce.fazenda.sp.gov.br/qrcode?p=${nfce}|2|1|1|ABCDEF`;
    photo.readPhoto.mockResolvedValue({
      kind: "read",
      codes: [{ format: "QRCode", text: address }],
    });
    await open();
    choose(image());
    const box = await waitFor(() => notice("Esta imagem é de uma NFC-e (modelo 65)."));
    expect(box.textContent).toContain("esta consulta atende só NF-e modelo 55");
    expect(box.textContent).not.toContain("boa luz");
    expect(field().value).toBe("");
    expect(portalLink()).toBeNull();
  });

  it.each([
    ["um arquivo que não é imagem", "pdf", "Este arquivo não é uma imagem."],
    ["uma imagem acima de 25 MB", "bytes", "A imagem passa de 25 MB."],
    ["uma imagem acima de 50 megapixels", "pixels", "A imagem tem 900 megapixels; o limite é 50."],
    ["uma imagem que o navegador não abre", "unreadable", "Não consegui abrir esta imagem."],
    ["uma falha do leitor", "failure", "Não consegui ler a imagem."],
  ] as const)("explica %s e mantém a digitação", async (_, outcome, title) => {
    if (outcome === "unreadable") photo.readPhoto.mockResolvedValue({ kind: "unreadable" });
    if (outcome === "pixels")
      photo.readPhoto.mockResolvedValue({ kind: "too_large", megapixels: 900, limit: 50 });
    if (outcome === "failure") photo.readPhoto.mockRejectedValue(new Error("wasm"));
    await open();
    const file = outcome === "pdf" ? image("application/pdf", "danfe.pdf") : image();
    if (outcome === "bytes") Object.defineProperty(file, "size", { value: 25 * 1024 * 1024 + 1 });
    choose(file);
    await waitFor(() => notice(title));
    expect(announced()?.startsWith(title)).toBe(true);
    if (outcome === "pdf" || outcome === "bytes") expect(photo.readPhoto).not.toHaveBeenCalled();
    expect(field().value).toBe("");
  });

  it("lê uma foto sem tipo informado pelo sistema, como HEIC", async () => {
    photo.readPhoto.mockResolvedValue(barcodes(valid));
    await open();
    choose(image("", "danfe.heic"));
    await screen.findByRole("region", { name: "Lido da chave" });
    expect(photo.readPhoto).toHaveBeenCalledTimes(1);
    expect(field().value).toBe(printed);
  });

  it("lê a imagem solta sobre a área e recusa mais de uma", async () => {
    photo.readPhoto.mockResolvedValue(barcodes(valid));
    await open();
    const zone = photoInput().closest(".fiscal-dropzone")!;
    fireEvent.drop(zone, { dataTransfer: { files: [image(), image()] } });
    await waitFor(() => notice("Escolha uma imagem por vez."));
    expect(photo.readPhoto).not.toHaveBeenCalled();
    fireEvent.drop(zone, { dataTransfer: { files: [image()] } });
    await screen.findByRole("region", { name: "Lido da chave" });
    expect(field().value).toBe(printed);
  });
});
