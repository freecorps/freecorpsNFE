// SPDX-License-Identifier: MIT
/*
MIT License

Copyright (c) 2026 FREECORPS TECNOLOGIA DA INFORMACAO LTDA

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { FreecorpsClient, FreecorpsError } from "@freecorps/sdk";

// NFS-e issuance in the sandbox: the simulated transport answers without validity before the
// tax authority. The key needs `documents:issue` (and `documents:cancel` to cancel), granted to
// a declared company with an NFS-e profile. Never log credentials.
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Defina ${name}`);
  return value;
};
const client = new FreecorpsClient({
  baseUrl: required("FREECORPS_BASE_URL"),
  apiKey: required("FREECORPS_API_KEY"),
  environment: "sandbox",
});
const companyId = required("FREECORPS_COMPANY_ID");
// One key per invoice intent: repeating the call with it never issues a second invoice.
const idempotencyKey = required("FREECORPS_IDEMPOTENCY_KEY");
// FREECORPS_MARKET=export issues an export to a synthetic taker abroad. The DPS XSD requires the
// whole foreign address: postal code, state, street, number and district (the region or "N/A"
// when the address has none).
const exporting = process.env.FREECORPS_MARKET === "export";
const national = {
  kind: "national" as const,
  document: "11444777000161",
  name: "Tomador Sintético Ltda",
  address: {
    municipalityCode: "3550308",
    postalCode: "01001000",
    street: "Praça da Sé",
    number: "100",
    district: "Sé",
  },
};
const foreign = {
  kind: "foreign" as const,
  nifAbsence: 2,
  name: "Synthetic Buyer Inc.",
  address: {
    country: "US",
    city: "New York",
    postalCode: "10001",
    state: "NY",
    street: "Synthetic Avenue",
    number: "100",
    district: "N/A",
  },
};

let issuance;
try {
  issuance = (
    await client.call(
      "createIssuance",
      {
        path: {},
        query: {},
        body: {
          companyId,
          activityCode: required("FREECORPS_ACTIVITY_CODE"),
          competence: new Date().toISOString().slice(0, 7),
          issuerEmail: "fiscal@prestador.example",
          market: exporting ? "export" : "domestic",
          taker: exporting ? foreign : national,
          description: "Serviço sintético de demonstração",
          // Money is decimal text, never a number. An export is in the foreign currency, without
          // ISS rate: the platform converts it by PTAX.
          amount: exporting
            ? { currency: "USD", value: "100.00" }
            : { currency: "BRL", value: "150.00" },
          ...(exporting ? {} : { issRate: "2" }),
          issWithheld: false,
        },
      },
      { idempotencyKey },
    )
  ).data.issuance;
} catch (error) {
  if (error instanceof FreecorpsError)
    throw new Error(`Pedido recusado: ${error.code}${error.field ? ` em ${error.field}` : ""}`);
  throw error;
}

// Accepted is not authorized. Follow the persisted state (or the issuance.* webhooks).
const read = { path: { issuanceId: issuance.id }, query: { companyId }, body: {} };
for (let i = 0; issuance.state === "processing" && i < 30; i++) {
  await delay(2000);
  issuance = (await client.call("getIssuance", read)).data;
}
console.log(
  `Emissão ${issuance.id}: ${issuance.state}${issuance.code ? ` (${issuance.code})` : ""}`,
);
if (issuance.state === "authorized") {
  const nfse = issuance.artifacts.find((artifact) => artifact.kind === "nfse");
  if (nfse) {
    const xml = await client.downloadIssuanceArtifact({
      issuanceId: issuance.id,
      artifactId: nfse.id,
      companyId,
    });
    writeFileSync(`nfse-${issuance.id}.xml`, xml);
  }
}
