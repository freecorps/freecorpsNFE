// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentStamp } from "./environment-stamp";
import type { Deployment, ProductEnvironment } from "./deployment";
import { resolveEnvironment } from "./product-environment";

afterEach(cleanup);

const sandbox: Deployment = { environment: "sandbox", fiscalProduction: false, confirmed: true };
const text = (chosen?: ProductEnvironment, deployment = sandbox) =>
  render(
    <p>
      <EnvironmentStamp label="Local" deployment={deployment} chosen={chosen} />
    </p>,
  ).container.textContent;

describe("selo do ambiente escolhido na lateral (ADR 0007, §1)", () => {
  it("nunca diz Sem validade fiscal sobre Produção", () => {
    expect(text()).toBe("SandboxEmissão sem validade fiscal · Local");
    expect(text("sandbox")).toBe("SandboxEmissão sem validade fiscal · Local");
    expect(text("production")).toBe("ProduçãoNotas reais da captura fiscal · Local");
  });
  it("Produção leva o tom do modo fiscal; o Sandbox mantém o seu", () => {
    render(<EnvironmentStamp label="Local" deployment={sandbox} chosen="production" />);
    expect(screen.getByText("Produção").className).toContain("ui-badge--info");
    cleanup();
    render(<EnvironmentStamp label="Local" deployment={sandbox} />);
    expect(screen.getByText("Sandbox").className).toContain("ui-badge--warning");
  });
  it("não muda o selo dos deployments de produção nem antes de o servidor confirmar", () => {
    expect(
      text("sandbox", { environment: "production", fiscalProduction: true, confirmed: true }),
    ).toBe("Produção fiscalNotas com validade fiscal · Local");
    expect(
      text("sandbox", { environment: "production", fiscalProduction: false, confirmed: true }),
    ).toBe("ProduçãoSem emissão de NFS-e · Local");
    // The build's hint is a sandbox until the server answers: the choice waits for it.
    expect(text("production", { ...sandbox, confirmed: false })).toBe(
      "SandboxEmissão sem validade fiscal · Local",
    );
  });
});

describe("selo sem rótulo de perfil (installation, #517)", () => {
  const bare = (deployment: Deployment, chosen?: ProductEnvironment) =>
    render(
      <p>
        <EnvironmentStamp deployment={deployment} chosen={chosen} />
      </p>,
    ).container.textContent;
  it("mostra só o que vem do deployment, sem separador sobrando", () => {
    expect(bare(sandbox)).toBe("SandboxEmissão sem validade fiscal");
    expect(bare(sandbox, "production")).toBe("ProduçãoNotas reais da captura fiscal");
    expect(bare({ environment: "production", fiscalProduction: false, confirmed: true })).toBe(
      "ProduçãoSem emissão de NFS-e",
    );
    expect(bare({ environment: "production", fiscalProduction: true, confirmed: true })).toBe(
      "Produção fiscalNotas com validade fiscal",
    );
  });
});

describe("ambiente resolvido contra o que o servidor oferece", () => {
  it("começa no Sandbox e só vai a Produção escolhida e oferecida", () => {
    const sandboxOnly = ["sandbox"] as const;
    const both = ["sandbox", "production"] as const;
    expect(resolveEnvironment({ deployment: "sandbox", offered: both, chosen: null })).toBe(
      "sandbox",
    );
    expect(resolveEnvironment({ deployment: "sandbox", offered: both, chosen: "production" })).toBe(
      "production",
    );
    // An organization that lost Produção goes back to the Sandbox.
    expect(
      resolveEnvironment({ deployment: "sandbox", offered: sandboxOnly, chosen: "production" }),
    ).toBe("sandbox");
    // While the offer is on its way, the choice stays; the server checks it again.
    expect(resolveEnvironment({ deployment: "sandbox", offered: null, chosen: "production" })).toBe(
      "production",
    );
  });
  it("o deployment da produção fiscal só serve Produção", () => {
    expect(resolveEnvironment({ deployment: "production", offered: null, chosen: "sandbox" })).toBe(
      "production",
    );
  });
});
