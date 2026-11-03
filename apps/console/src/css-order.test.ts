import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";

// O CSS do console entra só por main.tsx, na ordem tokens, base e componentes (`ui/ui.css`) e
// arranjos das telas. Um CSS importado por uma página vai para o chunk dela ou para o
// `console-shared`, que o navegador carrega antes do CSS de main: as regras dele ficariam antes
// da base e dos componentes na camada `ui`, e eles venceriam os arranjos da tela.
it("importa o CSS do console só em main.tsx", () => {
  const dir = new URL("./", import.meta.url);
  const offenders = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !file.startsWith("site") && file !== "main.tsx")
    .filter((file) =>
      /^import\s+["'][^"']+\.css["'];/m.test(readFileSync(new URL(file, dir), "utf8")),
    );
  expect(offenders).toEqual([]);
});
