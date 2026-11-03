import { describe, expect, it } from "vite-plus/test";
import { certificateStatus } from "./company-status";
import { grantBlocker } from "./project-grants";

const metadata = {
  cnpj: "00000000000191",
  subject: "CN=Certificado sintético",
  notAfter: Date.UTC(2027, 0, 15, 12),
  notBefore: Date.UTC(2026, 0, 15, 12),
  fingerprint: "ab",
};
type Cert = Parameters<typeof certificateStatus>[0][number];
const cert = (version: number, state: Cert["state"], withMeta = false): Cert =>
  ({ version, state, metadata: withMeta ? metadata : null }) as Cert;

describe("resumo do certificado na página da empresa", () => {
  it("mostra a versão ativa persistida, mesmo atrás de envios mais novos", () => {
    const status = certificateStatus([cert(3, "rejected"), cert(2, "active", true)], "Exhausted");
    expect(status.tone).toBe("success");
    expect(status.text).toMatch(/^Versão 2 ativa, válida até \d{2}\/\d{2}\/2027$/);
  });
  it("avisa uma nova versão em validação sem esconder a ativa", () => {
    const status = certificateStatus([cert(2, "validating"), cert(1, "active")], "Exhausted");
    expect(status).toEqual({ text: "Versão 1 ativa · versão 2 em validação", tone: "success" });
  });
  it("distingue ausência, carregamento, validação e falta de certificado ativo", () => {
    expect(certificateStatus([], "LoadingFirstPage").text).toBe("Carregando…");
    expect(certificateStatus([], "Exhausted")).toEqual({
      text: "Nenhum certificado enviado",
      tone: "neutral",
    });
    expect(certificateStatus([cert(1, "uploading")], "Exhausted").tone).toBe("warning");
    expect(certificateStatus([cert(2, "revoked"), cert(1, "replaced")], "Exhausted")).toEqual({
      text: "Nenhum certificado ativo (última versão desativada)",
      tone: "danger",
    });
  });
  it("não afirma ausência enquanto há páginas não carregadas", () => {
    expect(certificateStatus([cert(9, "rejected")], "CanLoadMore")).toEqual({
      text: "Nenhum ativo entre os envios recentes",
      tone: "warning",
    });
  });
});

describe("motivo do botão Salvar concessão", () => {
  const ready = {
    projectActive: true,
    companyId: "c1",
    existingLoaded: true,
    scopes: 1,
    environments: 1,
  };
  it("libera o envio quando tudo está preenchido", () => {
    expect(grantBlocker(ready)).toBe("");
  });
  it("explica cada bloqueio na ordem em que a pessoa resolve", () => {
    expect(grantBlocker({ ...ready, projectActive: false, companyId: "" })).toMatch(/Reative/);
    expect(grantBlocker({ ...ready, companyId: "" })).toBe("Escolha uma empresa para continuar.");
    expect(grantBlocker({ ...ready, existingLoaded: false })).toMatch(/Conferindo/);
    expect(grantBlocker({ ...ready, savedValuesMissing: true })).toMatch(/Carregue mais/);
    expect(grantBlocker({ ...ready, scopes: 0 })).toBe("Marque pelo menos um escopo.");
    expect(grantBlocker({ ...ready, environments: 0 })).toBe("Marque pelo menos um ambiente.");
  });
});
