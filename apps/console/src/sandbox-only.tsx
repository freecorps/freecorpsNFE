import type { ReactNode } from "react";
import { useDeployment } from "./deployment";
import { useProductEnvironment } from "./product-environment";
import { Button } from "./ui/button";
import { Callout, Page, PageHeader } from "./ui/layout";

/**
 * Uma seção que só existe no Sandbox deste deployment (ADR 0007, §1): a importação de XML e a
 * emissão NFS-e. Com Produção escolhida na lateral, a seção diz por quê e oferece a volta ao
 * Sandbox, em vez de mostrar dados de outro ambiente. O deployment da produção fiscal (#50) tem
 * as suas próprias, sem seletor.
 */
export function SandboxOnly({
  title,
  reason,
  children,
}: {
  title: string;
  reason: string;
  children: ReactNode;
}) {
  const deployment = useDeployment();
  const { environment, choose } = useProductEnvironment();
  if (deployment.environment === "production" || environment !== "production") return children;
  return (
    <Page>
      <PageHeader eyebrow={`${title} / Produção`} title={title} />
      <Callout
        tone="info"
        title="Disponível só no Sandbox"
        headingLevel={2}
        actions={<Button onClick={() => choose("sandbox")}>Trocar para o Sandbox</Button>}
      >
        <p>{reason}</p>
      </Callout>
    </Page>
  );
}
