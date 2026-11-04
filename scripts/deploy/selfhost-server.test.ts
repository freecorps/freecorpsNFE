import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { serve } from "../lib/selfhost-server.mjs";

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe: Server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

// The installation's own server answers missing addresses by the Worker's rule
// (apps/console/page-request.mjs): docs pages get the docs' 404 page.
async function start(withNotFoundPage = true) {
  const dist = mkdtempSync(join(tmpdir(), "selfhost-dist-"));
  mkdirSync(join(dist, "docs"), { recursive: true });
  writeFileSync(join(dist, "index.html"), '<div id="root"></div>');
  writeFileSync(join(dist, "docs/index.html"), "<h1>Documentação</h1>");
  writeFileSync(join(dist, "docs/webhooks.html"), "<h1>Webhooks</h1>");
  if (withNotFoundPage)
    writeFileSync(join(dist, "docs/404.html"), "<h1>Página não encontrada</h1>");
  const frontend = `http://127.0.0.1:${await freePort()}`;
  const server = serve({ frontend, dist, site: "http://127.0.0.1:9" });
  cleanup.push(() => {
    server.close();
    rmSync(dist, { recursive: true, force: true });
  });
  // The suite forbids HTTP clients (tests/setup/offline.ts): the request
  // handler is called directly, with the parts of req and res it uses.
  const [handler] = server.listeners("request") as ((req: unknown, res: unknown) => unknown)[];
  return (path: string, accept = "text/html") =>
    new Promise<{ status: number; type: string; body: string }>((resolve) => {
      const headers: Record<string, string> = {};
      const res = {
        status: 0,
        setHeader: (name: string, value: string) => (headers[name.toLowerCase()] = value),
        writeHead(status: number, extra: Record<string, string> = {}) {
          this.status = status;
          Object.assign(headers, extra);
          return this;
        },
        end(body?: string | Buffer) {
          resolve({
            status: this.status,
            type: headers["content-type"] ?? "",
            body: body ? String(body) : "",
          });
        },
      };
      handler({ method: "GET", url: path, headers: { host: new URL(frontend).host, accept } }, res);
    });
}

describe("servidor da instalação própria", () => {
  it.each(["/docs/inexistente", "/docs/velha.html", "/docs/api/inexistente"])(
    "entrega a página de não encontrado da documentação em %s, com 404",
    async (path) => {
      const response = await (await start())(path);
      expect(response.status).toBe(404);
      expect(response.type).toContain("text/html");
      expect(response.body).toContain("Página não encontrada");
    },
  );

  it("responde 404 curto, e não 502, quando a página de não encontrado falta", async () => {
    const get = await start(false);
    for (const path of ["/docs/inexistente", "/docs/velha.html"]) {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(response.body).toBe("");
    }
  });

  it("mantém guias, painel e arquivos ausentes como antes", async () => {
    const get = await start();
    expect((await get("/docs/webhooks")).body).toContain("Webhooks");
    expect((await get("/app/acme/companies/x")).body).toContain('id="root"');
    for (const path of ["/docs/inexistente.data", "/assets/inexistente.js"])
      expect(await get(path, "*/*")).toMatchObject({ status: 404, body: "" });
    expect(await get("/docs/inexistente", "application/json")).toMatchObject({
      status: 404,
      body: "",
    });
  });
});
