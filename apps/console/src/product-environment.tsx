import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { Deployment, ProductEnvironment } from "./deployment";

/**
 * O ambiente que o console inteiro mostra e opera (ADR 0007, §1): um seletor "Sandbox" /
 * "Produção" na lateral, como os modos de teste e de produção de um gateway de pagamento. Só muda
 * a visão; nenhum registro troca de ambiente, e toda função confere o ambiente contra a empresa
 * de novo.
 *
 * - O deployment da produção fiscal (#50) só serve Produção, sem seletor.
 * - No deployment sandbox, Produção aparece para uma organização com alguma empresa que já teve a
 *   captura fiscal liberada (`deployment.environments`). Sem ela, o Sandbox, sem seletor.
 * - A escolha vale por organização nesta aba do navegador (`sessionStorage`): outra aba, ou o
 *   console reaberto, começa no Sandbox. Ninguém abre o console já em Produção sem ter escolhido.
 */
export type ProductEnvironmentValue = {
  environment: ProductEnvironment;
  /** Os ambientes que o seletor oferece; `null` enquanto o servidor não respondeu. */
  offered: readonly ProductEnvironment[] | null;
  choose: (environment: ProductEnvironment) => void;
};

const fallback: ProductEnvironmentValue = {
  environment: "sandbox",
  offered: null,
  choose: () => undefined,
};
const ProductEnvironmentContext = createContext<ProductEnvironmentValue>(fallback);

/** Só ids opacos na chave e o nome do ambiente no valor, como a escolha de empresa. */
const storageKey = (organizationId: string) => `fnfe:console-env:${organizationId}`;
function stored(organizationId: string | undefined): ProductEnvironment | null {
  if (!organizationId) return null;
  try {
    const value = sessionStorage.getItem(storageKey(organizationId));
    return value === "production" || value === "sandbox" ? value : null;
  } catch {
    return null;
  }
}
function store(organizationId: string, environment: ProductEnvironment) {
  try {
    sessionStorage.setItem(storageKey(organizationId), environment);
  } catch {
    // Sem armazenamento, a escolha dura enquanto a página fica aberta.
  }
}

/**
 * The choice, resolved against what the server offers. While the offer is on its way, a stored
 * Produção stays chosen: the screens wait for the company anyway, and the server refuses an
 * environment the company does not serve. Once the offer arrives without Produção, the Sandbox.
 */
export function resolveEnvironment({
  deployment,
  offered,
  chosen,
}: {
  deployment: ProductEnvironment;
  offered: readonly ProductEnvironment[] | null | undefined;
  chosen: ProductEnvironment | null;
}): ProductEnvironment {
  if (deployment === "production") return "production";
  if (!chosen) return "sandbox";
  if (!offered) return chosen;
  return offered.includes(chosen) ? chosen : "sandbox";
}

export function ProductEnvironmentProvider({
  organizationId,
  deployment,
  enabled,
  children,
}: {
  organizationId: Id<"organizations"> | undefined;
  deployment: Deployment;
  /** Falso enquanto a sessão é conferida: nada é perguntado ao servidor. */
  enabled: boolean;
  children: ReactNode;
}) {
  const sandboxDeployment = deployment.confirmed && deployment.environment === "sandbox";
  const answer = useQuery(
    api.deployment.environments,
    enabled && organizationId && sandboxDeployment ? { organizationId } : "skip",
  );
  // Keyed by organization: another organization reads its own choice.
  const [choices, setChoices] = useState<Record<string, ProductEnvironment>>({});
  const chosen = organizationId ? (choices[organizationId] ?? stored(organizationId)) : null;
  const offered: readonly ProductEnvironment[] | null = !organizationId
    ? [deployment.environment]
    : deployment.environment === "production"
      ? ["production"]
      : (answer ?? null);
  const environment = resolveEnvironment({
    deployment: deployment.environment,
    offered,
    chosen,
  });
  const choose = useCallback(
    (next: ProductEnvironment) => {
      if (!organizationId) return;
      store(organizationId, next);
      setChoices((current) => ({ ...current, [organizationId]: next }));
    },
    [organizationId],
  );
  const value = useMemo(
    () => ({ environment, offered, choose }),
    // `offered` is a fresh array only when the answer changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [environment, offered?.join(","), choose],
  );
  return (
    <ProductEnvironmentContext.Provider value={value}>
      {children}
    </ProductEnvironmentContext.Provider>
  );
}

/** O ambiente escolhido na lateral; fora da casca, o Sandbox. */
export const useProductEnvironment = () => useContext(ProductEnvironmentContext);

/** Um ambiente fixo, sem servidor: os testes e a referência de componentes. */
export function FixedProductEnvironment({
  environment,
  offered = ["sandbox", "production"],
  onChoose = () => undefined,
  children,
}: {
  environment: ProductEnvironment;
  offered?: readonly ProductEnvironment[];
  onChoose?: (environment: ProductEnvironment) => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ environment, offered, choose: onChoose }),
    [environment, offered, onChoose],
  );
  return (
    <ProductEnvironmentContext.Provider value={value}>
      {children}
    </ProductEnvironmentContext.Provider>
  );
}
