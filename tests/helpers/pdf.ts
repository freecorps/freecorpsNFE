import path from "node:path";
import { createRequire } from "node:module";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import jsQR from "jsqr";

/** Lê texto e rasteriza o PDF final com outro motor, inclusive o QR impresso. */
export async function inspectPdf(bytes: Uint8Array) {
  const require = createRequire(import.meta.url);
  const loading = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl:
      path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + "/",
  });
  const pdf = await loading.promise;
  const pages: {
    text: string;
    qr: string | null;
    png: Buffer;
    outside: string[];
    /** Caixa de cada texto em pontos do PDF: origem na linha de base, altura igual ao corpo. */
    boxes: Array<{ str: string; x: number; y: number; width: number; height: number }>;
  }[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      const decoded = jsQR(pixels.data, pixels.width, pixels.height);
      const items = content.items.filter((item) => "str" in item);
      const [x0, y0, x1, y1] = page.view;
      pages.push({
        text: items.map((item) => item.str).join(" "),
        qr: decoded?.data ?? null,
        // Codificar o PNG custa mais que rasterizar; só quem o lê paga.
        get png() {
          return canvas.toBuffer("image/png");
        },
        boxes: items.map((item) => ({
          str: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
          height: item.height,
        })),
        outside: items
          .filter(
            (item) =>
              item.transform[4] < x0! ||
              item.transform[4] + item.width > x1! ||
              item.transform[5] < y0! ||
              item.transform[5] + item.height > y1!,
          )
          .map((item) => item.str),
      });
      page.cleanup();
    }
  } finally {
    await loading.destroy();
  }
  return pages;
}
