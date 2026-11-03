const fakes = {
  playwright: new URL("./playwright.mjs", import.meta.url).href,
  "@axe-core/playwright": new URL("./axe.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, next) {
  return fakes[specifier]
    ? { url: fakes[specifier], shortCircuit: true }
    : next(specifier, context);
}
