import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { processNfe, deriveFiscalSituation, distribute } from "@freecorps/fiscal-nfe";
import { gzipSync } from "node:zlib";
import { proveExcludedEvents } from "./nfe-situation-proof.mjs";
const base = new URL("./corpus/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", base), "utf8"));
const cases = manifest.cases.map((entry) => {
  const bytes = readFileSync(new URL(entry.path, base));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  const result = processNfe(bytes, { source: "synthetic", evaluatedAt: manifest.evaluatedAt });
  for (const [stage, status] of Object.entries(entry.expected))
    assert.equal(result.checks[stage].status, status, entry.id + ":" + stage);
  for (const [stage, code] of Object.entries(entry.expectedCodes))
    assert.equal(result.checks[stage].code, code, entry.id + ":" + stage);
  return {
    id: entry.id,
    inputSha256: entry.sha256,
    resultSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    result,
  };
});
const evidence = ["invoice-authorized", "event-110111"].map(
  (id) => cases.find((c) => c.id === id).result,
);
const summary = readFileSync(
  new URL(manifest.cases.find((c) => c.id === "summary-authorized").path, base),
);
const distributionRaw = Buffer.from(
  `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>2</tpAmb><verAplic>synthetic</verAplic><cStat>138</cStat><xMotivo>Documentos localizados</xMotivo><dhResp>2026-09-23T12:00:00-03:00</dhResp><ultNSU>000000000000001</ultNSU><maxNSU>000000000000001</maxNSU><loteDistDFeInt><docZip NSU="000000000000001" schema="resNFe_v1.01.xsd">${gzipSync(summary).toString("base64")}</docZip></loteDistDFeInt></retDistDFeInt>`,
);
let calls = 0;
const input = {
  cnpj: "00000000000191",
  environment: "sandbox",
  nsu: "0",
  credential: { synthetic: true },
  transport: async (request, credential) => {
    assert.equal(credential.synthetic, true);
    assert.match(request.body, /<ultNSU>000000000000000<\/ultNSU>/);
    calls++;
    return distributionRaw;
  },
};
const first = await distribute(input),
  second = await distribute(input);
assert.deepEqual(first, second);
assert.equal(calls, 2);
assert.deepEqual(Buffer.from(first.envelopes[0].xml), summary);
console.log(
  JSON.stringify({
    result: "passed",
    runtime: process.version,
    parser: manifest.parser,
    normalizer: manifest.normalizer,
    rule: manifest.rule,
    evaluatedAt: manifest.evaluatedAt,
    cases,
    situation: deriveFiscalSituation(evidence),
    excludedEvents: proveExcludedEvents(cases, deriveFiscalSituation),
    distribution: {
      result: "passed",
      calls,
      stateless: true,
      source: "injected-synthetic",
      inputSha256: createHash("sha256").update(distributionRaw).digest("hex"),
    },
  }),
);
