import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  type AnyRouter,
} from "@tanstack/react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { utils, type LocatorSelectors } from "vite-plus/test/browser";
import { OrganizationQueryCache } from "../src/convex-query";
// Os estilos do console na ordem de src/main.tsx: o teste vê o layout, a visibilidade e o foco
// que a pessoa vê. As fontes ficam de fora; o navegador desenha com a fonte de reserva.
import "../src/ui/tokens.css";
import "../src/ui/ui.css";
import "../src/gestao.css";
import "../src/fiscal.css";
import "../src/companies.css";

/**
 * Testes de componente do console no navegador (`*.browser.test.tsx`, projeto `console-browser`):
 * `render` monta a tela sob o router de verdade, numa história em memória, e sob o provider do
 * Convex com um cliente simulado (`FakeConvex`), com o cache de consultas real por cima. Devolve
 * um `AsyncDisposable`: com `await using`, a tela desmonta ao fim do bloco mesmo quando o teste
 * falha, e nada fica na página do teste seguinte (lint `freecorps/require-disposable-render`).
 *
 * ```tsx
 * await using screen = await render(<Captures org={org} companyId={id} />);
 * await screen.getByRole("button", { name: "Iniciar captura fiscal" }).click();
 * ```
 */

type Args = Record<string, unknown>;
type Answer = { name: string; match: Args | undefined; value: unknown };
type Call = { kind: "query" | "mutation" | "action"; name: string; args: Args };
type Handler = (args: Args) => unknown;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * O servidor Convex do teste. Uma consulta sem resposta fica carregando (`undefined`), como na
 * primeira assinatura. `answer` responde, e a tela recebe a resposta pela assinatura, como receberia
 * do servidor; uma resposta `Error` vira o erro da consulta. Mutations e actions ficam em `calls`
 * e respondem pelo `handle` da função, ou com `null`.
 */
export class FakeConvex {
  /** Cada assinatura que a tela abriu, na ordem: nome da função e argumentos. */
  readonly subscriptions: Array<{ name: string; args: Args }> = [];
  /** Cada chamada avulsa (`convex.query`), mutation e action, na ordem. */
  readonly calls: Call[] = [];
  #answers: Answer[] = [];
  #handlers = new Map<string, Handler>();
  #listeners = new Set<() => void>();

  /**
   * Responde `query` com `value`. Com `match`, só às assinaturas cujos argumentos têm esses
   * valores (o ambiente, por exemplo); a resposta mais recente que serve vence.
   */
  answer(query: FunctionReference<"query">, value: unknown, match?: Args) {
    const name = getFunctionName(query);
    this.#answers = [
      ...this.#answers.filter((answer) => answer.name !== name || !same(answer.match, match)),
      { name, match, value },
    ];
    for (const listener of this.#listeners) listener();
  }

  /** Responde a mutation ou action `fn` com o que `handler` devolve (ou rejeita). */
  handle(fn: FunctionReference<"mutation" | "action">, handler: Handler) {
    this.#handlers.set(getFunctionName(fn), handler);
  }

  #result(name: string, args: Args) {
    const answer = this.#answers.findLast(
      (candidate) =>
        candidate.name === name &&
        Object.entries(candidate.match ?? {}).every(([key, value]) => same(args[key], value)),
    );
    return answer?.value;
  }

  async #call(kind: Call["kind"], fn: FunctionReference<"mutation" | "action">, args: Args = {}) {
    const name = getFunctionName(fn);
    this.calls.push({ kind, name, args });
    const handler = this.#handlers.get(name);
    return handler ? await handler(args) : null;
  }

  // O que `convex/react` e o cache de `convex-helpers` usam do `ConvexReactClient`.
  watchQuery(query: FunctionReference<"query">, args: Args = {}) {
    const name = getFunctionName(query);
    this.subscriptions.push({ name, args });
    return {
      onUpdate: (callback: () => void) => {
        const listener = () => callback();
        this.#listeners.add(listener);
        return () => void this.#listeners.delete(listener);
      },
      localQueryResult: () => {
        const value = this.#result(name, args);
        if (value instanceof Error) throw value;
        return value;
      },
      journal: () => undefined,
    };
  }
  watchPaginatedQuery(query: FunctionReference<"query">): never {
    throw new Error(`FakeConvex não responde consultas paginadas (${getFunctionName(query)})`);
  }
  async query(query: FunctionReference<"query">, args: Args = {}) {
    const name = getFunctionName(query);
    this.calls.push({ kind: "query", name, args });
    const value = this.#result(name, args);
    if (value instanceof Error) throw value;
    return value;
  }
  mutation(fn: FunctionReference<"mutation">, args?: Args) {
    return this.#call("mutation", fn, args);
  }
  action(fn: FunctionReference<"action">, args?: Args) {
    return this.#call("action", fn, args);
  }
  prewarmQuery() {}
  connectionState() {
    return { isWebSocketConnected: true, hasInflightRequests: false, connectionCount: 1 };
  }
  subscribeToConnectionState() {
    return () => undefined;
  }
}

export interface Rendered extends LocatorSelectors, AsyncDisposable {
  /** O elemento em que a tela foi montada; os seletores procuram só dentro dele. */
  readonly container: HTMLElement;
  readonly convex: FakeConvex;
  /** O router da tela: `router.state.location` diz para onde ela navegou. */
  readonly router: AnyRouter;
}

/**
 * A montagem e a desmontagem passam por `act`, que entrega o primeiro desenho e os efeitos antes
 * de devolver. Fora delas, o teste espera o que a tela mostra (`expect.element`, `expect.poll`):
 * no navegador, cliques e respostas do servidor chegam como chegariam à pessoa.
 */
async function acting(work: () => void) {
  const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = scope.IS_REACT_ACT_ENVIRONMENT;
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => work());
  } finally {
    scope.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

export async function render(
  ui: ReactNode,
  {
    convex = new FakeConvex(),
    path = "/",
  }: {
    /** O servidor simulado; crie antes para responder já no primeiro desenho. */
    convex?: FakeConvex;
    /** O endereço inicial, com a consulta (`/app/equipe?tarefa=importar`). */
    path?: string;
  } = {},
): Promise<Rendered> {
  // Toda rota cai na raiz, que desenha a tela; nenhuma página de "não encontrado".
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui, notFoundComponent: () => null }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await acting(() =>
    root.render(
      <ConvexProvider client={convex as unknown as ConvexReactClient}>
        <OrganizationQueryCache>
          <RouterProvider router={router as never} />
        </OrganizationQueryCache>
      </ConvexProvider>,
    ),
  );
  return {
    ...utils.getElementLocatorSelectors(container),
    container,
    convex,
    router,
    async [Symbol.asyncDispose]() {
      await acting(() => root.unmount());
      container.remove();
    },
  };
}
