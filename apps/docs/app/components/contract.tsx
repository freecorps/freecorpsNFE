import { createContext, use, type ReactNode } from "react";
import type { ContractData } from "../lib/contract.server.ts";

// MDX components that render the versioned contract. The data comes from the
// page loader (build time) for pages marked `contract: true`; a page that uses
// these components without the flag, or cites an operation missing from the
// OpenAPI, fails the prerender and therefore the build.
const Contract = createContext<ContractData | null>(null);

export function ContractProvider({
  data,
  children,
}: {
  data: ContractData | null;
  children: ReactNode;
}) {
  return <Contract value={data}>{children}</Contract>;
}

function useContract() {
  const data = use(Contract);
  if (!data) throw new Error("Página usa o contrato sem `contract: true` no frontmatter");
  return data;
}

const join = (values: readonly string[]) =>
  values.map((value, index) => (
    <span key={value}>
      {index > 0 ? (index === values.length - 1 ? " e " : ", ") : null}
      <code>{value}</code>
    </span>
  ));

/** Method and path of an operation, by its operationId. */
export function Op({ id }: { id: string }) {
  const found = useContract().operations.find((op) => op.operationId === id);
  if (!found) throw new Error(`Operação ausente no contrato: ${id}`);
  return (
    <code>
      {found.method} {found.path}
    </code>
  );
}

export function Environments() {
  return <>{join(useContract().environments)}</>;
}

export function WebhookEvents() {
  return <>{join(useContract().events)}</>;
}

export function PageRange() {
  const { smallestPage, largestPage } = useContract();
  return (
    <>
      de {smallestPage} a {largestPage}
    </>
  );
}

export function Tolerance() {
  return <>{useContract().toleranceMinutes}</>;
}

export function ContractVersion() {
  return <code>{useContract().version}</code>;
}

export function ErrorCodes() {
  return (
    <div className="contract-table" tabIndex={0} role="region" aria-label="Códigos de erro">
      <table>
        <thead>
          <tr>
            <th>Código</th>
            <th>HTTP</th>
            <th>Significado</th>
          </tr>
        </thead>
        <tbody>
          {useContract().errors.map((error) => (
            <tr key={error.code}>
              <td>
                <code>{error.code}</code>
              </td>
              <td>{error.status}</td>
              <td>{error.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Operations() {
  return (
    <div className="contract-table" tabIndex={0} role="region" aria-label="Operações REST">
      <table>
        <thead>
          <tr>
            <th>Rota</th>
            <th>Operação SDK</th>
            <th>Escopo</th>
            <th>Retry automático</th>
            <th>Página máxima</th>
          </tr>
        </thead>
        <tbody>
          {useContract().operations.map((op) => (
            <tr key={op.operationId}>
              <td>
                <code>
                  {op.method} {op.path}
                </code>
              </td>
              <td>{op.operationId}</td>
              <td>{op.scope}</td>
              <td>{op.retry}</td>
              <td>{op.pageLimit ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
