/**
 * As regras de porta são o coração do isolamento entre worktrees: se duas
 * reservas puderem se sobrepor, dois backends brigam e o dev descobre isso pelo
 * pior caminho — um frontend falando com o banco do worktree ao lado.
 */
import { describe, it, expect } from "vite-plus/test";

import {
  isLocalWorktreeSiteUrl,
  isWorktreeConvexPort,
  isWorktreeFrontendPort,
  WORKTREE_CONVEX_PORT_END,
  WORKTREE_CONVEX_PORT_START,
  WORKTREE_FRONTEND_ALLOCATION_START,
  WORKTREE_FRONTEND_PORT_END,
  WORKTREE_FRONTEND_PORT_START,
  worktreeConvexPorts,
  worktreeSiteUrl,
} from "./worktree-local";

describe("janelas de porta", () => {
  // As duas janelas não podem se tocar: o mesmo número entregue pelos dois
  // alocadores é exatamente a colisão que o registro existe para impedir. Qual
  // delas vem primeiro não importa — aqui o Convex fica ABAIXO, porque o Vite
  // usa 5173 e o backend local do Convex usa 3210.
  it("as janelas de frontend e de Convex não se sobrepõem", () => {
    const disjuntas =
      WORKTREE_CONVEX_PORT_END < WORKTREE_FRONTEND_PORT_START ||
      WORKTREE_CONVEX_PORT_START > WORKTREE_FRONTEND_PORT_END;
    expect(disjuntas).toBe(true);
  });

  // 5173 fica fora da alocação: era a porta fixa do backoffice legado no
  // checkout principal e continua livre para não mover worktrees registrados.
  it("o worktree aloca a partir da porta seguinte à 5173", () => {
    expect(WORKTREE_FRONTEND_ALLOCATION_START).toBe(WORKTREE_FRONTEND_PORT_START + 1);
  });
});

describe("isWorktreeFrontendPort", () => {
  it("aceita as bordas da janela", () => {
    expect(isWorktreeFrontendPort(WORKTREE_FRONTEND_PORT_START)).toBe(true);
    expect(isWorktreeFrontendPort(WORKTREE_FRONTEND_PORT_END)).toBe(true);
  });

  it("recusa fora da janela e o que não é inteiro", () => {
    expect(isWorktreeFrontendPort(WORKTREE_FRONTEND_PORT_START - 1)).toBe(false);
    expect(isWorktreeFrontendPort(WORKTREE_FRONTEND_PORT_END + 1)).toBe(false);
    expect(isWorktreeFrontendPort(5173.5)).toBe(false);
    expect(isWorktreeFrontendPort("5173")).toBe(false);
    expect(isWorktreeFrontendPort(Number.NaN)).toBe(false);
  });
});

describe("isWorktreeConvexPort", () => {
  // Só a cloud é reservada; a site é sempre a seguinte. Reserva ímpar
  // atravessaria o par do vizinho.
  it("só aceita offset par a partir do início da janela", () => {
    expect(isWorktreeConvexPort(WORKTREE_CONVEX_PORT_START)).toBe(true);
    expect(isWorktreeConvexPort(WORKTREE_CONVEX_PORT_START + 1)).toBe(false);
    expect(isWorktreeConvexPort(WORKTREE_CONVEX_PORT_START + 2)).toBe(true);
  });

  // A última reserva válida precisa da porta site dentro da janela também.
  it("deixa espaço para a porta site na borda de cima", () => {
    expect(isWorktreeConvexPort(WORKTREE_CONVEX_PORT_END)).toBe(false);
    expect(worktreeConvexPorts(WORKTREE_CONVEX_PORT_END - 2).site).toBeLessThanOrEqual(
      WORKTREE_CONVEX_PORT_END,
    );
  });

  it("recusa abaixo da janela", () => {
    expect(isWorktreeConvexPort(WORKTREE_CONVEX_PORT_START - 2)).toBe(false);
  });
});

describe("worktreeConvexPorts", () => {
  it("a site é sempre a cloud mais um", () => {
    expect(worktreeConvexPorts(3210)).toEqual({ cloud: 3210, site: 3211 });
  });
});

describe("isLocalWorktreeSiteUrl", () => {
  it("aceita localhost em porta da janela", () => {
    expect(isLocalWorktreeSiteUrl("http://localhost:5174")).toBe(true);
  });

  it("recusa host, esquema e porta de fora", () => {
    expect(isLocalWorktreeSiteUrl("https://localhost:5174")).toBe(false);
    expect(isLocalWorktreeSiteUrl("http://127.0.0.1:5174")).toBe(false);
    expect(isLocalWorktreeSiteUrl("http://freecorpsnfe.app")).toBe(false);
    expect(isLocalWorktreeSiteUrl("http://localhost:9999")).toBe(false);
  });

  // Porta vazia coage para 0, que está fora da janela — sem esta trava um
  // `http://localhost` sem porta passaria por URL de worktree.
  it("recusa URL sem porta", () => {
    expect(isLocalWorktreeSiteUrl("http://localhost")).toBe(false);
  });

  // A URL precisa coincidir com a origem reservada.
  it("recusa caminho, query, hash e credencial embutida", () => {
    expect(isLocalWorktreeSiteUrl("http://localhost:5174/app")).toBe(false);
    expect(isLocalWorktreeSiteUrl("http://localhost:5174/?a=1")).toBe(false);
    expect(isLocalWorktreeSiteUrl("http://localhost:5174/#x")).toBe(false);
    expect(isLocalWorktreeSiteUrl("http://u:p@localhost:5174")).toBe(false);
  });

  it("recusa o que não é string e lixo", () => {
    expect(isLocalWorktreeSiteUrl(undefined)).toBe(false);
    expect(isLocalWorktreeSiteUrl(5174)).toBe(false);
    expect(isLocalWorktreeSiteUrl("nem url")).toBe(false);
  });

  it("aceita o que o worktreeSiteUrl produz", () => {
    expect(isLocalWorktreeSiteUrl(worktreeSiteUrl(5180))).toBe(true);
  });
});
