// Proxy TCP com atraso, para o benchmark de navegação do console (navigation-bench.mjs).
//
// Fica entre o navegador e um serviço local (o Convex ou o servidor do console) e segura cada
// pedaço de dados por `delayMs` em cada sentido, na ordem em que chegou. Com 60 ms de cada lado,
// uma ida e volta custa ~120 ms: HTTP, WebSocket e o handshake do WebSocket sofrem o mesmo atraso,
// sem o proxy precisar entender o protocolo. O atraso pode mudar entre perfis sem trocar a porta
// (a porta do Convex fica gravada no build do console).
import { createServer, connect } from "node:net";

/**
 * Abre o proxy em 127.0.0.1. `target` é `{ host, port }`; `port` 0 escolhe uma porta livre.
 * Devolve `{ port, setDelay(ms), close() }`.
 */
export async function startDelayProxy({ target, delayMs = 0, port = 0 }) {
  let delay = delayMs;
  const sockets = new Set();
  // Encaminha em ordem: com o mesmo atraso, os timers do Node disparam na ordem de criação.
  function pipe(from, to) {
    from.on("data", (chunk) => {
      if (!delay) {
        if (!to.destroyed) to.write(chunk);
        return;
      }
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
      }, delay);
    });
    from.on("end", () => setTimeout(() => to.end(), delay));
    from.on("error", () => to.destroy());
    from.on("close", () => setTimeout(() => to.destroy(), delay));
  }
  const server = createServer((client) => {
    client.setNoDelay(true);
    const upstream = connect(target.port, target.host);
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    client.on("close", () => sockets.delete(client));
    upstream.on("close", () => sockets.delete(upstream));
    pipe(client, upstream);
    pipe(upstream, client);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    setDelay(ms) {
      delay = ms;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
