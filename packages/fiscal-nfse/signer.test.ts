import { describe, expect, it } from "vite-plus/test";
import {
  NfseError,
  buildCancelEvent,
  buildDps,
  gunzipB64,
  gzipB64,
  signDps,
  signEvent,
  verifySignature,
  type CancelEventInput,
} from "./src/index";
import { nationalInput, PRESTADOR_CNPJ, signerKeys } from "./tests/inputs";

const PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';

describe("signDps", () => {
  const keys = signerKeys();
  const built = buildDps(nationalInput);
  const signed = signDps(built, keys, "rsa-sha256");

  it("prolog UTF-8 fora do elemento assinado (E1229) sem invalidar a assinatura", () => {
    expect(signed.startsWith(PROLOG)).toBe(true);
    expect(verifySignature(signed, keys.certificatePem)).toBe(true);
  });

  it("assinatura fica depois de </infDPS> e dentro de </DPS>", () => {
    expect(signed.indexOf("</infDPS>")).toBeLessThan(signed.indexOf("<Signature"));
    expect(signed.indexOf("<Signature")).toBeLessThan(signed.indexOf("</DPS>"));
  });

  it("usa RSA-SHA256, C14N, enveloped e Reference com URI do Id", () => {
    expect(signed).toContain("xmldsig-more#rsa-sha256");
    expect(signed).toContain("REC-xml-c14n-20010315");
    expect(signed).toContain("enveloped-signature");
    expect(signed).toContain(`URI="#${built.id}"`);
    expect(signed).toContain("<X509Certificate>");
  });

  it("detecta adulteração do conteúdo assinado", () => {
    const tampered = signed.replace("<vServ>67.60</vServ>", "<vServ>999.00</vServ>");
    expect(tampered).not.toBe(signed);
    expect(verifySignature(tampered, keys.certificatePem)).toBe(false);
  });

  it("recusa duas assinaturas e XML malformado", () => {
    const signature = /<Signature[\s\S]*<\/Signature>/.exec(signed)![0];
    const doubled = signed.replace("</DPS>", `${signature}</DPS>`);
    expect(verifySignature(doubled, keys.certificatePem)).toBe(false);
    expect(verifySignature(signed.slice(0, -3), keys.certificatePem)).toBe(false);
  });

  it("política rsa-sha1 (Campinas) troca os algoritmos e verifica localmente", () => {
    const sha1 = signDps(built, keys, "rsa-sha1");
    expect(sha1).toContain("xmldsig#rsa-sha1");
    expect(sha1).toContain("xmldsig#sha1");
    expect(sha1).not.toContain("rsa-sha256");
    expect(verifySignature(sha1, keys.certificatePem)).toBe(true);
  });

  it("chave inválida vira NfseError sem material de chave na mensagem", () => {
    const secret = "-----BEGIN PRIVATE KEY-----\nSEGREDO\n-----END PRIVATE KEY-----";
    let error: unknown;
    try {
      signDps(built, { privateKeyPem: secret, certificatePem: keys.certificatePem }, "rsa-sha256");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NfseError);
    expect((error as NfseError).code).toBe("SIGNATURE_FAILED");
    expect((error as NfseError).message).not.toContain("SEGREDO");
  });

  it("certificado que não corresponde à chave é recusado antes do envio", () => {
    const other = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    expect(() =>
      signDps(built, { privateKeyPem: keys.privateKeyPem, certificatePem: other }, "rsa-sha256"),
    ).toThrow(NfseError);
  });
});

describe("evento de cancelamento", () => {
  const chave = "3".repeat(50);
  const input: CancelEventInput = {
    tpAmb: 2,
    verAplic: "FiscalNfseTest_1.0",
    dhEvento: "2026-08-29T10:00:00-03:00",
    cnpjAutor: PRESTADOR_CNPJ,
    chNFSe: chave,
    cMotivo: "1",
    xMotivo: "Erro na emissao da nota fiscal",
  };

  it("Id = PRE + chave(50) + 101101", () => {
    const { xml, id } = buildCancelEvent(input);
    expect(id).toBe(`PRE${chave}101101`);
    expect(id).toHaveLength(59);
    expect(xml).toContain(`<infPedReg Id="${id}">`);
  });

  it("ordem normativa de infPedReg e do bloco do evento, versão 1.00, sem prolog", () => {
    const { xml } = buildCancelEvent(input);
    expect(
      xml.startsWith('<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">'),
    ).toBe(true);
    expect(xml).toMatch(
      /<tpAmb>2<\/tpAmb><verAplic>[^<]+<\/verAplic><dhEvento>[^<]+<\/dhEvento><CNPJAutor>11222333000181<\/CNPJAutor><chNFSe>\d{50}<\/chNFSe><e101101>/,
    );
    expect(xml).toContain(
      "<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>Erro na emissao da nota fiscal</xMotivo></e101101>",
    );
    expect(xml).not.toContain("\n");
  });

  it("valida chave, CNPJ, motivo e tamanho de xMotivo", () => {
    expect(() => buildCancelEvent({ ...input, chNFSe: "123" })).toThrow(/50/);
    expect(() => buildCancelEvent({ ...input, cnpjAutor: "11222333000180" })).toThrow(/CNPJ/);
    expect(() => buildCancelEvent({ ...input, xMotivo: "curto" })).toThrow(/15 e 255/);
    expect(() => buildCancelEvent({ ...input, xMotivo: "x".repeat(256) })).toThrow(/15 e 255/);
    expect(() => buildCancelEvent({ ...input, cMotivo: "3" as "1" })).toThrow(/1, 2 ou 9/);
    expect(() => buildCancelEvent({ ...input, tpAmb: 3 as 1 })).toThrow(/tpAmb deve ser 1 ou 2/);
    expect(() => buildCancelEvent({ ...input, verAplic: "  " })).toThrow(/verAplic/);
    for (const invalid of [{ tpAmb: 0 as 1 }, { verAplic: "" }]) {
      let error: unknown;
      try {
        buildCancelEvent({ ...input, ...invalid });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(NfseError);
      expect((error as NfseError).code).toBe("EVENT_FIELD_INVALID");
    }
  });

  it("assina infPedReg e detecta adulteração", () => {
    const keys = signerKeys();
    const signed = signEvent(buildCancelEvent(input), keys, "rsa-sha256");
    expect(signed.startsWith(PROLOG)).toBe(true);
    expect(signed.indexOf("</infPedReg>")).toBeLessThan(signed.indexOf("<Signature"));
    expect(verifySignature(signed, keys.certificatePem)).toBe(true);
    const tampered = signed.replace("<cMotivo>1</cMotivo>", "<cMotivo>2</cMotivo>");
    expect(verifySignature(tampered, keys.certificatePem)).toBe(false);
  });
});

describe("codec", () => {
  it("gzip+base64 faz ida e volta sem perdas", () => {
    const xml = "<DPS>çãé teste 😀</DPS>";
    expect(gunzipB64(gzipB64(xml))).toBe(xml);
  });

  it("base64 ou gzip inválido vira NfseError com código estável", () => {
    for (const input of ["bm9wZQ==", "%%%", ""]) {
      let error: unknown;
      try {
        gunzipB64(input);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(NfseError);
      expect((error as NfseError).code).toBe("XML_DECOMPRESS_INVALID");
    }
  });
});
