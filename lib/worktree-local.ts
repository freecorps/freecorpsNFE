/** Portas e URLs locais. Adaptado de outro projeto do mantenedor, ver docs/worktrees.md. */
export const WORKTREE_FRONTEND_PORT_START = 5173;
export const WORKTREE_FRONTEND_PORT_END = 5372;

/**
 * 5173 fica fora da alocação: era a porta fixa do backoffice legado no checkout
 * principal, aposentado na #345, e continua livre para não mover os worktrees já
 * registrados, que alocam de 5174 para cima.
 */
export const WORKTREE_FRONTEND_ALLOCATION_START = WORKTREE_FRONTEND_PORT_START + 1;

/**
 * O backend local do Convex usa 3210 por padrão, então dois worktrees criados
 * em momentos diferentes caem os dois nela e não conseguem rodar juntos. Aqui
 * cada worktree reserva o próprio par, e o par é passado explicitamente ao
 * `convex dev`.
 *
 * A janela começa no próprio padrão do Convex, para o primeiro worktree manter
 * as portas que já tem, e termina bem abaixo da janela do frontend (5173+), de
 * modo que os dois alocadores nunca possam entregar a mesma porta.
 */
export const WORKTREE_CONVEX_PORT_START = 3210;
export const WORKTREE_CONVEX_PORT_END = 3609;

/** Um backend ocupa a porta cloud e a porta site logo em seguida. */
export const WORKTREE_CONVEX_PORT_STRIDE = 2;

export function isWorktreeFrontendPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= WORKTREE_FRONTEND_PORT_START &&
    value <= WORKTREE_FRONTEND_PORT_END
  );
}

/**
 * Só a porta cloud é reservada; a porta site é sempre a seguinte, então uma
 * reserva válida é um offset par a partir do início da janela.
 */
export function isWorktreeConvexPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= WORKTREE_CONVEX_PORT_START &&
    value <= WORKTREE_CONVEX_PORT_END - 1 &&
    (value - WORKTREE_CONVEX_PORT_START) % WORKTREE_CONVEX_PORT_STRIDE === 0
  );
}

export function worktreeConvexPorts(cloudPort: number): {
  cloud: number;
  site: number;
} {
  return { cloud: cloudPort, site: cloudPort + 1 };
}

export function worktreeSiteUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function isLocalWorktreeSiteUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;

  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "localhost" &&
      // Porta vazia vira 0, que está fora da janela permitida.
      isWorktreeFrontendPort(Number(url.port)) &&
      url.pathname === "/" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
