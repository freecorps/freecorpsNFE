import { expect, it } from "vite-plus/test";
import { canPreview, isPrototypeScreen, screenContracts } from "./src/index";
import { normalizeCnpj } from "./src/companies";
import { routes } from "./src/external";
import { integrationScopes, scopesWithoutRestRoute } from "./src/projects";
import { corpus, fixture } from "../../tests/helpers/nfe-corpus";
import { parseNfeModel } from "../fiscal-nfe/src/index";

it("shares the alphanumeric CNPJ contract with the versioned NF-e corpus", () => {
  const parsed = parseNfeModel(fixture("invoice-alphanumeric"), "synthetic");
  expect(parsed.metadata.versions.parser).toBe(corpus.parser);
  if (parsed.document.kind !== "invoice") throw new Error("fixture kind");
  expect(normalizeCnpj(parsed.document.issuer.document)).toBe(parsed.document.issuer.document);
  // Parsing does not produce the normalized document DTO or persisted import metadata.
  expect(parsed.metadata.versions.normalizer).toBeNull();
});
it("hides administration from readers and rejects arbitrary route keys", () => {
  expect(canPreview("documento", "viewer")).toBe(true);
  for (const screen of ["importacao", "empresa", "certificado", "captura"] as const)
    expect(canPreview(screen, "viewer")).toBe(false);
  expect(canPreview("importacao", "developer")).toBe(false);
  expect(canPreview("importacao", "operator")).toBe(true);
  expect(canPreview("captura", "operator")).toBe(true);
  expect(canPreview("documento", "operator")).toBe(true);
  expect(canPreview("certificado", "developer")).toBe(false);
  expect(isPrototypeScreen("__proto__")).toBe(false);
  expect(Object.values(screenContracts).every((c) => /^B\d{2}$/.test(c.owner))).toBe(true);
});
it("marks as planned exactly the integration scopes without a REST route", () => {
  const routed = new Set<string>(Object.values(routes).map((route) => route.scope));
  expect(integrationScopes.filter((scope) => !routed.has(scope))).toEqual([
    ...scopesWithoutRestRoute,
  ]);
});
