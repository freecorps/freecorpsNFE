import type { Deployment, ProductEnvironment } from "./deployment";
import { StatusBadge } from "./ui/layout";

const sandbox: Deployment = { environment: "sandbox", fiscalProduction: false, confirmed: true };

/**
 * O selo do ambiente, igual na casca e no login. O texto diz o ambiente; a cor só acompanha.
 * Sandbox (atenção): sem validade fiscal, como sempre foi. Produção fiscal (destaque, o tom `info`
 * do sistema, distinto do sandbox): só no deployment marcado para emitir NFS-e, com notas que
 * valem. Produção sem emissão (alvos de captura, como o da #50) e produção ainda não confirmada
 * pelo servidor: neutro, sem afirmar nada sobre validade.
 *
 * No deployment sandbox que guarda também a captura fiscal (ADR 0007, §1), o selo diz o ambiente
 * escolhido na lateral (`chosen`): Produção no tom `info`, a marcação permanente do modo fiscal,
 * ou o Sandbox de sempre. Nunca "Sem validade fiscal" sobre notas reais.
 */
export function EnvironmentStamp({
  label,
  deployment = sandbox,
  chosen,
}: {
  /** Perfil técnico do console, quando há um a mostrar (`deploymentLabel`). */
  label?: string;
  deployment?: Deployment;
  /** O ambiente escolhido no seletor; ausente, o do deployment. */
  chosen?: ProductEnvironment;
}) {
  const profile = label ? ` · ${label}` : "";
  if (deployment.environment === "production" && !deployment.confirmed)
    return <StatusBadge>Produção</StatusBadge>;
  if (deployment.fiscalProduction)
    return (
      <>
        <StatusBadge tone="info">Produção fiscal</StatusBadge>
        <span>Notas com validade fiscal{profile}</span>
      </>
    );
  if (deployment.environment === "production")
    return (
      <>
        <StatusBadge>Produção</StatusBadge>
        <span>Sem emissão de NFS-e{profile}</span>
      </>
    );
  if (chosen === "production" && deployment.confirmed)
    return (
      <>
        <StatusBadge tone="info">Produção</StatusBadge>
        <span>Notas reais da captura fiscal{profile}</span>
      </>
    );
  return (
    <>
      <StatusBadge tone="warning">Sandbox</StatusBadge>
      <span>Sem validade fiscal{profile}</span>
    </>
  );
}
