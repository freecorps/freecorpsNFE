import type { ReactNode } from "react";

export type Column<Row> = {
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  align?: "start" | "end";
  /** A coluna que identifica a linha: no telefone, vira o título do cartão. */
  primary?: boolean;
};

/**
 * Tabela leve dentro de um cartão. No telefone, cada linha vira um cartão com rótulo e valor
 * (CSS); os `role` explícitos preservam a semântica de tabela quando o `display` muda.
 */
export function DataTable<Row>({
  label,
  caption,
  columns,
  rows,
  rowKey,
  empty,
}: {
  /** Nome acessível quando não há legenda visível. */
  label?: string;
  caption?: ReactNode;
  columns: Array<Column<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Mostrado no lugar da tabela quando não há linhas. */
  empty?: ReactNode;
}) {
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <div className="ui-table-card">
      <div className="ui-table-scroll">
        <table className="ui-table" role="table" aria-label={caption ? undefined : label}>
          {caption && <caption>{caption}</caption>}
          <thead role="rowgroup">
            <tr role="row">
              {columns.map((column) => (
                <th key={column.key} role="columnheader" scope="col" data-align={column.align}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((row) => (
              <tr key={rowKey(row)} role="row">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    role="cell"
                    data-label={column.header}
                    data-align={column.align}
                    data-primary={column.primary || undefined}
                  >
                    {/* One box per cell: on the phone the label and the whole value are the
                        two columns, even when the value has a badge and notes. */}
                    <div className="ui-table__value">{column.cell(row)}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
