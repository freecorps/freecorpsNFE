import { afterEach, expect, it, vi } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";

import { worktreePaths } from "../lib/worktree/paths.mjs";
import { readMailbox } from "../lib/worktree/mail.mjs";
import {
  listenerOwnershipFromWindows,
  listenerUidsFromLsof,
  listenerUidsFromProcNet,
  portOwnership,
} from "../lib/worktree/port-owner.mjs";

vi.mock("../lib/worktree/state.mjs", async (original) => ({
  ...(await original<typeof import("../lib/worktree/state.mjs")>()),
  assertLinkedWorktree: vi.fn(),
}));

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function listen() {
  const server = createServer();
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function freePort() {
  const port = await listen();
  const server = servers.pop()!;
  await new Promise((done) => server.close(done));
  return port;
}

function platformWorktree(port: number) {
  const root = mkdtempSync(join(tmpdir(), "fnfe-port-owner-"));
  roots.push(root);
  mkdirSync(join(root, ".convex"));
  writeFileSync(join(root, ".convex", "worktree-app.json"), JSON.stringify({ app: "platform" }));
  const paths = worktreePaths(root);
  mkdirSync(dirname(paths.localConfig), { recursive: true });
  writeFileSync(
    paths.localConfig,
    JSON.stringify({
      deploymentName: "local-fixture",
      ports: { cloud: port, site: port + 1 },
      adminKey: "synthetic-admin-key",
    }),
  );
  return paths;
}

it("lê de /proc/net só os sockets em LISTEN da porta, em IPv4 e IPv6", () => {
  const header =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  const tcp =
    header +
    "   0: 0100007F:0C8A 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11 1\n" +
    "   1: 0100007F:0C8A 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1001        0 12 1\n" +
    "   2: 0100007F:0C8B 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 13 1\n";
  const tcp6 =
    header +
    "   0: 00000000000000000000000000000000:0C8A 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1003        0 14 1\n";
  expect(listenerUidsFromProcNet(tcp, 3210)).toEqual([1000]);
  expect(listenerUidsFromProcNet(tcp6, 3210)).toEqual([1003]);
  expect(listenerUidsFromProcNet(header, 3210)).toEqual([]);
});

it("lê os donos dos ouvintes do lsof e do PowerShell", () => {
  expect(listenerUidsFromLsof("p101\nu501\np202\nu502\n")).toEqual([501, 502]);
  expect(listenerOwnershipFromWindows("own\r\nforeign\r\n")).toEqual([true, false]);
  expect(listenerOwnershipFromWindows("")).toEqual([]);
});

it("aceita a porta ouvida por este usuário e recusa porta sem ouvinte", async () => {
  expect(portOwnership(await listen())).toBe("own");
  expect(portOwnership(await freePort())).toBe("absent");
  expect(portOwnership(0)).toBe("absent");
});

it("o coletor envia a chave ao backend do usuário e recusa porta não confirmada", async () => {
  // A suíte bloqueia HTTP real: o servidor só ocupa a porta e o fetch responde.
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ status: "success", value: [] }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const port = await listen();
  await readMailbox(platformWorktree(port), "pessoa@example.com");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0]!;
  expect(url).toBe(`http://127.0.0.1:${port}/api/query`);
  expect(new Headers(init?.headers).get("authorization")).toBe("Convex synthetic-admin-key");

  fetchSpy.mockClear();
  await expect(
    readMailbox(platformWorktree(await freePort()), "pessoa@example.com"),
  ).rejects.toThrow(/chave administrativa não foi enviada/);
  expect(fetchSpy).not.toHaveBeenCalled();
});
