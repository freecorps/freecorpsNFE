import type { Plugin } from "vite";

// Why this exists: zxing-wasm, the barcode reader of the DANFE lookup (#296), loads its
// WebAssembly from the jsDelivr CDN unless told otherwise. src/danfe-photo.ts always tells it
// otherwise (the console's own /assets/ copy), so the default is dead code, but its URL would
// still ship in the chunk, and one missed override would send the browser to a third party the
// CSP refuses and the privacy promise excludes. The rewrite replaces only that default with an
// error; a chunk that still names a CDN fails the build.
//
// Checked against one version; another fails the build until someone repeats the review.
export const reviewedVersion = "3.1.6";

const shareFile = /[\\/]zxing-wasm[\\/]dist[\\/]es[\\/]share\.js$/;
const cdnTemplate = /`https:\/\/fastly\.jsdelivr\.net\/npm\/zxing-wasm@([\d.]+)\/dist\/[^`]*`/g;
const cdn = /jsdelivr|unpkg\.com|cdnjs|esm\.sh/;

export function withoutCdnDefault(code: string) {
  const found = [...code.matchAll(cdnTemplate)];
  if (found.length !== 1)
    throw new Error(
      "zxing-wasm: o endereço padrão do .wasm mudou de formato; revise zxing-plugin.ts",
    );
  if (found[0]![1] !== reviewedVersion)
    throw new Error(
      `zxing-wasm ${found[0]![1]} instalado; zxing-plugin.ts foi revisado para ${reviewedVersion}.`,
    );
  return code.replace(
    cdnTemplate,
    '(() => { throw new Error("zxing-wasm: o .wasm vem do próprio console (danfe-photo.ts)"); })()',
  );
}

export function zxingPlugin(): Plugin {
  let rewritten = false;
  return {
    name: "freecorps:zxing-self-hosted",
    // Served as plain modules in dev too, so the dev server rewrites the default like the build.
    config: () => ({ optimizeDeps: { exclude: ["zxing-wasm"] } }),
    transform(code, id) {
      // The dev server can add a query (`?v=<hash>`) to the module id.
      if (!shareFile.test(id.replace(/\?.*$/, ""))) return null;
      rewritten = true;
      return { code: withoutCdnDefault(code), map: null };
    },
    generateBundle(_, bundle) {
      if (!rewritten)
        this.error("zxing-wasm: o módulo do leitor não passou pelo build; revise zxing-plugin.ts");
      for (const output of Object.values(bundle))
        if (output.type === "chunk" && cdn.test(output.code))
          this.error(`Endereço de CDN no bundle do console: ${output.fileName}`);
    },
  };
}
