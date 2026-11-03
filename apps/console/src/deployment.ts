import { useQuery } from "convex/react";
import { api } from "../../../platform/convex/_generated/api";
import { productEnvironmentHint } from "./environment";

export type ProductEnvironment = "sandbox" | "production";
/** Name of the environment in page titles, as the rest of the console writes it. */
export const environmentNames: Record<ProductEnvironment, string> = {
  sandbox: "Sandbox",
  production: "Produção",
};
/**
 * `confirmed` is false until `deployment.current` answers: `environment` is then only the build's
 * hint, good for the stamp and never for a query with a fiscal scope.
 */
export type Deployment = {
  environment: ProductEnvironment;
  fiscalProduction: boolean;
  confirmed: boolean;
};

const hinted: Deployment = {
  environment: productEnvironmentHint,
  // Fiscal validity waits for the server: a production build may serve a deployment that does
  // not issue (the #50 target), and the stamp never claims notes are valid before it is sure.
  fiscalProduction: false,
  confirmed: false,
};

/**
 * O ambiente que o deployment atende, para o escopo das telas fiscais e o indicador de ambiente.
 * Enquanto o servidor não responde, `confirmed` é falso: o selo usa a dica do build e as telas
 * fiscais esperam, com suas queries em `"skip"`. Depois vale o servidor, que confere o ambiente de
 * novo em toda função. `enabled` falso adia a consulta (a espera da sessão não pergunta nada ao
 * servidor).
 */
export function useDeployment(enabled = true): Deployment {
  const answer = useQuery(api.deployment.current, enabled ? {} : "skip");
  return answer ? { ...answer, confirmed: true } : hinted;
}
