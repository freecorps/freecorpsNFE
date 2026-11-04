import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { isPageRequest, serveAsset } from "../../apps/console/asset-fallback.ts";
import { checkConsoleWorker } from "../lib/console.mjs";
import { issuanceReleaseWorker } from "../lib/issuance-release.mjs";
import { releaseWorker } from "../lib/platform-release.mjs";
import { repoUrl } from "../lib/repo-root.mjs";

// The asset layer with `not_found_handling: "none"`: a listed file or 404 with
// no body. Each answer carries the header of the address asked, as `_headers`.
const files: Record<string, string> = {
  "/": "<title>landing</title>",
  "/docs/404": "<h1>Página não encontrada</h1>",
  "/assets/app-12345678.js": "export {};",
};
const asked: string[] = [];
const assets = {
  async fetch(input: Request): Promise<Response> {
    const { pathname } = new URL(input.url);
    asked.push(`${input.method} ${pathname}${input.headers.has("If-None-Match") ? " (cond)" : ""}`);
    if (!(pathname in files))
      return new Response(null, {
        status: 404,
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      });
    return new Response(input.method === "HEAD" ? null : files[pathname], {
      headers: { "Content-Type": "text/html", "X-Asked": pathname, "Cache-Control": "no-store" },
    });
  },
};

const html = "text/html,application/xhtml+xml,*/*;q=0.8";
const get = (path: string, accept = html, method = "GET") =>
  serveAsset(
    new Request(`https://nfe.example${path}`, {
      method,
      headers: { Accept: accept, "If-None-Match": '"x"' },
    }),
    assets,
  );

describe("fallback dos arquivos estáticos", () => {
  it("entrega o arquivo existente como a camada de assets o serviu", async () => {
    const response = await get("/assets/app-12345678.js", "*/*");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export {};");
  });

  it.each(["/assets/nao-existe.js", "/docs/assets/nao-existe.js", "/favicon.ico", "/algo.png"])(
    "responde 404 curto e sem cache a %s, mesmo pedindo HTML",
    async (path) => {
      for (const accept of ["*/*", html]) {
        const response = await get(path, accept);
        expect(response.status).toBe(404);
        expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.text()).not.toContain("<");
      }
    },
  );

  it.each(["/login", "/app/acme/companies/x", "/console/privacidade", "/qualquer.html"])(
    "mantém o acesso direto e a recarga de %s no index.html, com noindex",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Asked")).toBe("/");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
      expect(await response.text()).toContain("landing");
    },
  );

  // /docs/404 is a file: run_worker_first sends it here, and it answers 404 too.
  it.each(["/docs/pagina-inexistente", "/docs/api/inexistente", "/docs/velha.html", "/docs/404"])(
    "abre a página de não encontrado da documentação em %s, com status 404",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("X-Asked")).toBe("/docs/404");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toContain("Página não encontrada");
    },
  );

  it("não serve página a dados, métodos de escrita ou HEAD sem corpo", async () => {
    expect((await get("/login", "application/json")).status).toBe(404);
    expect((await get("/docs/pagina.data", "*/*")).status).toBe(404);
    expect((await get("/login", html, "POST")).status).toBe(404);
    const head = await get("/docs/pagina-inexistente", html, "HEAD");
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
    expect(asked).toContain("HEAD /docs/404");
    // A 304 could not become a page: the fallback asks without the condition.
    expect(asked).not.toContain("GET / (cond)");
    expect(asked).not.toContain("GET /docs/404 (cond)");
  });

  it("reconhece navegação pelo Accept e pela extensão do último segmento", () => {
    const page = (path: string, accept = html) =>
      isPageRequest(new Request(`https://nfe.example${path}`, { headers: { Accept: accept } }));
    expect(page("/app/acme")).toBe(true);
    expect(page("/docs/")).toBe(true);
    expect(page("/v1.0/guia")).toBe(true);
    expect(page("/assets/x.js")).toBe(false);
    expect(page("/assets/x.js", "*/*")).toBe(false);
    // The publication smoke reads /login and /console with fetch's */*.
    expect(page("/login", "*/*")).toBe(true);
    expect(page("/login", "text/*;q=0.5")).toBe(true);
    expect(page("/login", "application/json")).toBe(false);
    expect(page("/login", "image/avif,image/webp")).toBe(false);
    expect(page("/login", "text/html;q=0, application/json")).toBe(false);
    expect(isPageRequest(new Request("https://nfe.example/login"))).toBe(true);
  });
});

describe("configuração dos assets publicados", () => {
  const root = "/repo";
  const target = {
    worker: "w",
    accountId: "0".repeat(32),
    frontend: "https://nfe.example",
    api: "https://api.nfe.example",
    site: "https://site.example",
  };
  it("deixa o fallback ao Worker em todos os Workers do console", () => {
    const validation = JSON.parse(
      readFileSync(new URL("apps/console/wrangler.json", repoUrl), "utf8"),
    );
    const example = JSON.parse(
      readFileSync(new URL("deploy/selfhost/wrangler.example.json", repoUrl), "utf8"),
    );
    for (const config of [
      releaseWorker(target, root),
      issuanceReleaseWorker(target, root),
      validation,
      example,
    ]) {
      expect(config.assets.not_found_handling).toBe("none");
      expect(config.assets.run_worker_first).toContain("/docs/404");
    }
    expect(() =>
      checkConsoleWorker({
        ...validation,
        assets: { ...validation.assets, not_found_handling: "single-page-application" },
      }),
    ).toThrow();
  });

  it("guarda por um ano só os nomes com hash do console e da documentação", () => {
    const rules = readFileSync(new URL("apps/console/public/_headers", repoUrl), "utf8")
      .split(/\n(?=\S)/)
      .filter((block) => !block.startsWith("#"));
    const cache = (path: string) =>
      rules
        .filter((block) => block.startsWith(`${path}\n`))
        .map((block) => block.split("\n").filter((line) => line.includes("Cache-Control")));
    expect(cache("/*")).toEqual([["  Cache-Control: no-store"]]);
    for (const path of ["/assets/*", "/docs/assets/*"])
      expect(cache(path)).toEqual([
        ["  ! Cache-Control", "  Cache-Control: public, max-age=31536000, immutable"],
      ]);
    expect(
      rules.filter((block) => block.includes("immutable")).map((b) => b.split("\n")[0]),
    ).toEqual(["/assets/*", "/docs/assets/*"]);
  });
});
