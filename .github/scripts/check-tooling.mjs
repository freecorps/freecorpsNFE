import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Resolve the exact chain used by Wrangler, including its patched sharp override.
const require = createRequire(import.meta.url);
const fromWrangler = createRequire(require.resolve("wrangler/package.json"));
const fromMiniflare = createRequire(fromWrangler.resolve("miniflare/package.json"));
const { Miniflare, convertV4MiniflareOptions } = fromWrangler("miniflare");
const sharp = fromMiniflare("sharp");
const input = await sharp({ create: { width: 8, height: 8, channels: 4, background: "red" } })
  .png()
  .toBuffer();
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: "2026-09-01",
    images: { binding: "IMAGES" },
    script: `export default { async fetch(request, env) {
    const image = await env.IMAGES.input(request.body).transform({ width: 4, height: 4 }).output({ format: "image/png" });
    return image.response();
  } };`,
  }),
);
try {
  const response = await mf.dispatchFetch("http://local/image", { method: "POST", body: input });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  assert.equal(metadata.width, 4);
  assert.equal(metadata.height, 4);
  console.log(`Miniflare image transform passed with sharp ${sharp.versions.sharp}`);
} finally {
  await mf.dispose();
}
