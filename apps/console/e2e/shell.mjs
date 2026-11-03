// Interações com o shell do console nos roteiros de navegador: seletor de organização no topo
// da lateral, menu da conta (com "Sair") e gaveta no telefone.

/** Item do seletor pelo endereço; o endereço vem da URL e é escapado para o seletor CSS. */
const option = (scope, slug) =>
  scope.locator(`[role="menuitemradio"][data-value="${slug.replace(/["\\]/g, "\\$&")}"]`);

/** A organização aberta, como o seletor a mostra (nome exato). */
export function currentOrganization(page, name) {
  return page.locator(".app-switcher").getByText(name, { exact: true });
}

/** Abre a gaveta quando a lateral está recolhida (telas estreitas). */
async function revealSidebar(page) {
  const open = page.getByRole("button", { name: "Abrir menu" });
  if ((await open.isVisible()) && (await open.getAttribute("aria-expanded")) !== "true")
    await open.click();
}

async function withSwitcher(page, action) {
  const switcher = page.locator(".app-switcher");
  if (!(await switcher.count())) return undefined;
  await revealSidebar(page);
  await switcher.click();
  try {
    return await action(page.getByRole("menu"));
  } finally {
    if (await page.getByRole("menu").count()) await page.keyboard.press("Escape");
  }
}

/** Se a organização aparece no seletor; `checked` diz se é a aberta. */
export async function organizationOption(page, slug) {
  return (
    (await withSwitcher(page, async (menu) => {
      const item = option(menu, slug);
      if (!(await item.count())) return { listed: false, checked: false };
      return { listed: true, checked: (await item.getAttribute("aria-checked")) === "true" };
    })) ?? { listed: false, checked: false }
  );
}

/** Troca de organização pelo seletor, como a pessoa faria. */
export async function switchOrganization(page, slug) {
  await revealSidebar(page);
  await page.locator(".app-switcher").click();
  await option(page.getByRole("menu"), slug).click();
}

/** "Sair" fica no menu da conta, no rodapé da lateral. */
export async function signOutButton(page) {
  await revealSidebar(page);
  const account = page.getByRole("button", { name: /menu da conta/ });
  // O botão alterna: só abre se o menu ainda estiver fechado.
  if ((await account.getAttribute("aria-expanded")) !== "true") await account.click();
  return page.getByRole("menuitem", { name: "Sair", exact: true });
}
