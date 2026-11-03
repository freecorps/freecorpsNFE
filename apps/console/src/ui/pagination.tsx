import type { ReactNode } from "react";
import { Button } from "./button";

export type PageCursor = { current: string | null; previous: Array<string | null> };
export const firstPage: PageCursor = { current: null, previous: [] };

/** Above this many pages, the middle ones fold into an ellipsis. */
const SHOWN_PAGES = 7;

/**
 * Anterior/próxima sobre uma consulta paginada por cursor: o único padrão de paginação das
 * listas do console. Quem chama guarda o cursor, para que trocar o filtro volte à primeira
 * página. Sem página anterior nem próxima, não aparece.
 *
 * O cursor só conhece as páginas já percorridas: elas viram números, e qualquer uma volta num
 * clique (a primeira inclusive). As páginas adiante só existem depois de pedidas ao servidor.
 * `sticky` prende a barra ao pé da janela enquanto a lista rola; `children` fica à direita
 * (por exemplo, a escolha de quantos itens por página).
 */
export function CursorPager({
  label,
  cursor,
  nextCursor,
  onChange,
  sticky,
  children,
}: {
  label: string;
  cursor: PageCursor;
  nextCursor: string | null;
  onChange: (cursor: PageCursor) => void;
  sticky?: boolean;
  children?: ReactNode;
}) {
  if (!cursor.previous.length && !nextCursor) return null;
  const current = cursor.previous.length + 1;
  // Page n (1-based) starts at previous[n - 1]; the current one is `cursor.current`.
  const goTo = (page: number) =>
    onChange({
      current: cursor.previous[page - 1] ?? null,
      previous: cursor.previous.slice(0, page - 1),
    });
  const pages: Array<number | "gap"> =
    current <= SHOWN_PAGES
      ? Array.from({ length: current }, (_, index) => index + 1)
      : [
          1,
          "gap",
          ...Array.from(
            { length: SHOWN_PAGES - 2 },
            (_, index) => current - (SHOWN_PAGES - 3) + index,
          ),
        ];
  return (
    <nav
      aria-label={label}
      className={sticky ? "ui-pagination ui-pagination--sticky" : "ui-pagination"}
    >
      <Button
        size="sm"
        icon="arrowLeft"
        aria-label="Página anterior"
        disabled={!cursor.previous.length}
        onClick={() =>
          onChange({
            current: cursor.previous.at(-1) ?? null,
            previous: cursor.previous.slice(0, -1),
          })
        }
      >
        {/* On the phone the word "página" leaves only the eye; the name stays whole. */}
        <span className="ui-pagination__long">Página anterior</span>
        <span className="ui-pagination__short">Anterior</span>
      </Button>
      <ol className="ui-pagination__pages">
        {pages.map((page, index) =>
          page === "gap" ? (
            <li key={`gap-${index}`} className="ui-pagination__gap" aria-hidden="true">
              …
            </li>
          ) : (
            <li key={page}>
              {page === current ? (
                <span className="ui-pagination__page" aria-current="page">
                  <span className="ui-visually-hidden">Página </span>
                  {page}
                </span>
              ) : (
                <button
                  type="button"
                  className="ui-pagination__page"
                  aria-label={`Ir para a página ${page}`}
                  onClick={() => goTo(page)}
                >
                  {page}
                </button>
              )}
            </li>
          ),
        )}
        {nextCursor ? (
          <li className="ui-pagination__gap" aria-hidden="true">
            …
          </li>
        ) : null}
      </ol>
      <Button
        size="sm"
        aria-label="Próxima página"
        disabled={!nextCursor}
        onClick={() =>
          onChange({ current: nextCursor, previous: [...cursor.previous, cursor.current] })
        }
      >
        <span className="ui-pagination__long">Próxima página</span>
        <span className="ui-pagination__short">Próxima</span>
      </Button>
      {children ? <div className="ui-pagination__extra">{children}</div> : null}
    </nav>
  );
}
