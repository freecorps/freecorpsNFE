import { afterEach, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKTREE_CONVEX_PORT_END,
  WORKTREE_CONVEX_PORT_START,
  WORKTREE_CONVEX_PORT_STRIDE,
} from "../lib/worktree-local.ts";
import { portIsAvailable, resolveConvexPort } from "../scripts/lib/worktree/registry.mjs";

// Um processo alheio segurando a porta, como o backend Convex local de outro
// projeto (que escuta em `*:porta`). O teste nunca encerra nada além dos
// próprios servidores.
const servers: Server[] = [];

function listen(host: string, port = 0): Promise<Server | null> {
  return new Promise((resolveListen) => {
    const server = createServer();
    server.once("error", () => resolveListen(null));
    server.listen({ host, port }, () => {
      servers.push(server);
      resolveListen(server);
    });
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Servidor sem porta TCP.");
  return address.port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((done) => server.close(() => done(null)))),
  );
});

describe("portIsAvailable", () => {
  it("dá como livre uma porta que ninguém segura", async () => {
    const server = await listen("127.0.0.1");
    const port = portOf(server!);
    await new Promise((done) => server!.close(() => done(null)));
    servers.splice(servers.indexOf(server!), 1);
    expect(await portIsAvailable(port)).toBe(true);
  });

  for (const host of ["0.0.0.0", "127.0.0.1", "::", "::1"]) {
    it(`acusa a porta de outro processo escutando em ${host}`, async () => {
      const server = await listen(host);
      // Máquina sem IPv6: não há como ocupar a porta nesse endereço.
      if (!server) return;
      expect(await portIsAvailable(portOf(server))).toBe(false);
      // A sondagem não derruba o dono da porta.
      expect(server.listening).toBe(true);
    });
  }
});

describe("resolveConvexPort", () => {
  let repo: string | null = null;
  const previousStart = process.env.FNFE_WORKTREE_CONVEX_PORT_START;

  afterEach(() => {
    if (previousStart === undefined) delete process.env.FNFE_WORKTREE_CONVEX_PORT_START;
    else process.env.FNFE_WORKTREE_CONVEX_PORT_START = previousStart;
    if (repo) rmSync(repo, { force: true, recursive: true });
    repo = null;
  });

  it("pula o par ocupado por um processo fora do registro e não o encerra", async () => {
    // Um par livre agora, seguido de outro par livre para onde a reserva deve ir.
    let start: number | null = null;
    for (
      let port = WORKTREE_CONVEX_PORT_END - 1 - 4 * WORKTREE_CONVEX_PORT_STRIDE;
      port >= WORKTREE_CONVEX_PORT_START;
      port -= WORKTREE_CONVEX_PORT_STRIDE
    ) {
      const free = await Promise.all([0, 1, 2, 3].map((offset) => portIsAvailable(port + offset)));
      if (free.every(Boolean)) {
        start = port;
        break;
      }
    }
    expect(start).not.toBeNull();
    const occupied = start!;

    // Exatamente o caso de um backend observado em outro projeto: `*:porta` em IPv4.
    const holder = await listen("0.0.0.0", occupied);
    expect(holder).not.toBeNull();

    repo = mkdtempSync(join(tmpdir(), "fnfe-worktree-ports-"));
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    process.env.FNFE_WORKTREE_CONVEX_PORT_START = String(occupied);

    const claimed = await resolveConvexPort(repo, { preferred: occupied });

    expect(claimed).toBe(occupied + WORKTREE_CONVEX_PORT_STRIDE);
    expect(holder!.listening).toBe(true);
  });
});
