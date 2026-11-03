import { describe, expect, it } from "vite-plus/test";
import { isNfceQr, readingFrom, type Barcode } from "./danfe-barcode";

// Fictitious keys: only their length, characters and model matter here; the validator checks
// the rest.
const key = "35260911222333000181550010000000691123456787";
const other = "35260911222333000181550010000000701123456780";
const nfce = "35260911222333000181650010000000691123456787";
const bars = (...texts: string[]): Barcode[] => texts.map((text) => ({ format: "Code128", text }));
const qr = (text: string): Barcode => ({ format: "QRCode", text });

describe("o que os códigos lidos da foto significam", () => {
  it("sem código lido, nada", () => {
    expect(readingFrom([])).toEqual({ kind: "none" });
  });

  it("uma chave, a mesma lida mais de uma vez, vai para o campo como foi lida", () => {
    expect(readingFrom(bars(key))).toEqual({ kind: "one", key });
    expect(readingFrom(bars(key, key))).toEqual({ kind: "one", key });
  });

  it("aceita letras, do CNPJ alfanumérico; quem confere as posições é o validador", () => {
    const alphanumeric = "53261212ABC34501DE3555002000001234912345678X";
    expect(readingFrom(bars(alphanumeric))).toEqual({ kind: "one", key: alphanumeric });
  });

  it("chaves diferentes ficam para a pessoa escolher", () => {
    expect(readingFrom(bars(key, other, key))).toEqual({ kind: "many", keys: [key, other] });
  });

  it("ignora, ao lado da chave, o código de 36 posições do DANFE em contingência", () => {
    expect(readingFrom(bars("1".repeat(36), key))).toEqual({ kind: "one", key });
  });

  it.each([
    ["incompleto", [key.slice(0, 43)], [43], false],
    ["longo demais", [key + "1"], [45], false],
    ["de outros tamanhos", ["1".repeat(36), "0123456789", "1".repeat(36)], [10, 36], false],
    ["com espaço", [` ${key}`], [45], false],
    ["com minúscula", [key.slice(0, 43) + "a"], [], true],
    [
      "de 44 com caractere estranho, ao lado de outros",
      ["0123456789", key.slice(0, 43) + "#"],
      [10],
      true,
    ],
  ])("um código %s não é chave e não é corrigido", (_, texts, lengths, malformed) => {
    expect(readingFrom(bars(...texts))).toEqual({ kind: "not_key", lengths, malformed });
  });

  it("o QR code de um cupom NFC-e diz só que é NFC-e", () => {
    const v2 = `https://www.nfce.fazenda.sp.gov.br/qrcode?p=${nfce}|2|1|1|ABCDEF`;
    const v1 = `http://www.fazenda.pr.gov.br/nfce/qrcode?chNFe=${nfce}&nVersao=100&tpAmb=1`;
    expect(readingFrom([qr(v2)])).toEqual({ kind: "nfce" });
    expect(readingFrom([qr(v1)])).toEqual({ kind: "nfce" });
    // A DANFE key beside it wins: the person reads the NF-e.
    expect(readingFrom([qr(v2), ...bars(key)])).toEqual({ kind: "one", key });
  });

  it("outro QR code não é NFC-e nem chave", () => {
    expect(isNfceQr(`https://exemplo.invalid/?p=${key}|2`)).toBe(false);
    expect(isNfceQr(`https://exemplo.invalid/?p=${nfce.slice(0, 43)}`)).toBe(false);
    expect(isNfceQr(nfce)).toBe(false);
    expect(readingFrom([qr("https://exemplo.invalid/pagar")])).toEqual({ kind: "none" });
    expect(readingFrom([qr(key)])).toEqual({ kind: "none" });
  });
});
