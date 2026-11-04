import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";

/**
 * Documentação e evidências não publicam CNPJ nem chave de acesso de cliente
 * (AGENTS.md, "Credenciais e dados reais"). Um CNPJ ou uma chave de NF-e com
 * dígito verificador válido só entra em `docs/`, `apps/docs/` ou nos Markdown
 * da raiz se for um dos fictícios abaixo, ou o da Freecorps; a chave vale pelo
 * CNPJ do emitente que ela carrega. Antes de acrescentar um CNPJ aqui, confirme
 * que ele não é de cliente nem de fornecedor de cliente.
 */
const allowedCnpj = new Set([
  "63113119000190", // Freecorps, titular das licenças
  "11222333000181",
  "11444777000161",
  "00000000000191",
  "12345678000195",
  "11111111000191",
]);

const files = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "docs",
    "apps/docs",
    "*.md",
    "LICENSE",
    "NOTICE",
  ],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(
    (path) => path && existsSync(path) && !/\.(png|jpe?g|gif|webp|webm|mp4|pdf)$/i.test(path),
  );

const cnpjValid = (cnpj: string) => {
  if (/^(\d)\1{13}$/.test(cnpj)) return false;
  const digit = (length: number) => {
    let sum = 0;
    for (
      let index = 0, weight = length - 7;
      index < length;
      index++, weight = weight === 2 ? 9 : weight - 1
    )
      sum += Number(cnpj[index]) * weight;
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return digit(12) === Number(cnpj[12]) && digit(13) === Number(cnpj[13]);
};
const keyValid = (key: string) => {
  let sum = 0;
  for (let index = 42, weight = 2; index >= 0; index--, weight = weight === 9 ? 2 : weight + 1)
    sum += Number(key[index]) * weight;
  const rest = sum % 11;
  return (rest < 2 ? 0 : 11 - rest) === Number(key[43]);
};
const mask = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

export function unknownIdentifiers(text: string) {
  const found: string[] = [];
  for (const [key] of text.matchAll(/(?<!\d)\d{44}(?!\d)/g))
    if (keyValid(key) && !allowedCnpj.has(key.slice(6, 20))) found.push(`chave ${mask(key)}`);
  for (const [, raw] of text.matchAll(
    /(?<![\d./-])(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})(?!\d)/g,
  )) {
    const cnpj = raw.replace(/\D/g, "");
    if (cnpj.length === 14 && cnpjValid(cnpj) && !allowedCnpj.has(cnpj))
      found.push(`CNPJ ${mask(cnpj)}`);
  }
  return found;
}

it("recognizes a real-looking CNPJ and access key, formatted or not", () => {
  // 99.888.777/0001-00 e a chave abaixo são fictícios, com dígitos válidos.
  expect(unknownIdentifiers("emitente 99.888.777/0001-00")).toEqual(["CNPJ 9988…0100"]);
  expect(unknownIdentifiers("CNPJ 99888777000100.")).toEqual(["CNPJ 9988…0100"]);
  expect(unknownIdentifiers("chave 35261099888777000100550010000001231000000010")).toEqual([
    "chave 3526…0010",
  ]);
  expect(unknownIdentifiers("fictício 11.222.333/0001-81 e …0000010")).toEqual([]);
  expect(unknownIdentifiers("NSU 000000000002527, sha 7989b4250d4f035e")).toEqual([]);
});

it("keeps client CNPJs and access keys out of public documentation and evidence", () => {
  const found = files.flatMap((path) =>
    unknownIdentifiers(readFileSync(path, "utf8")).map((item) => `${path}: ${item}`),
  );
  expect(found).toEqual([]);
});
