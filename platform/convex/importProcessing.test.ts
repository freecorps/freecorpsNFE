import { createHash } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { fixture } from "../../tests/helpers/export-fixture";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import { usePlatformEnvironment } from "../../tests/helpers/platform";
import { internal } from "./_generated/api";
import { declaredTpAmb, scannedTpAmb } from "./lib/documentValues";

/**
 * #108: each published version marks its note with the `tpAmb` of its own XML, so the fiscal
 * guard tells a real imported NF-e from a homologação one. The corpus note is synthetic and says
 * homologação; the Produção copy only rewrites that field.
 */
usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3255",
  secret: "synthetic-import-tpamb",
});
const homologation = xmlFixture("invoice-authorized");
const production = new TextEncoder().encode(
  new TextDecoder().decode(homologation).replaceAll("<tpAmb>2</tpAmb>", "<tpAmb>1</tpAmb>"),
);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Fixture = Awaited<ReturnType<typeof fixture>>;
const tpAmb = async (f: Fixture) =>
  (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.documentId)))!.tpAmb;

/** Imports `bytes` again into the fixture's company, through the REST flow. */
async function importAgain(f: Fixture, bytes: Uint8Array, key: string) {
  const json = async (response: Promise<Response>) => (await (await response).json()).data;
  const batch = await json(
    f.request(
      "/v1/imports",
      "POST",
      {
        companyId: f.scope.companyId,
        files: [{ name: "nota.xml", size: bytes.length, sha256: hash(bytes) }],
      },
      key,
    ),
  );
  const file = `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}`;
  const upload = await json(f.request(`${file}/upload`, "POST", undefined, `${key}-upload`));
  await f.t.fetch("/v1/import-upload", {
    method: "POST",
    headers: { "X-Upload-Token": upload.token },
    body: new Uint8Array(bytes),
  });
  const operation = await json(f.request(`${file}/confirm`, "POST", undefined, `${key}-confirm`));
  await f.t.action(internal.operationWorker.run, {
    operationId: operation.operationId,
    generation: 1,
  });
  return (await json(f.request(`/v1/imports/${batch.importId}`))).files[0] as {
    documentId?: string;
  };
}

it("a importação marca a nota com o tpAmb do próprio XML", async () => {
  expect(await tpAmb(await fixture({}, homologation))).toBe("2");
  expect(await tpAmb(await fixture({}, production))).toBe("1");
});

it("a marca de Produção fica mesmo quando outro original da nota diz homologação", async () => {
  const f = await fixture({}, production);
  const again = await importAgain(f, homologation, "tpamb-again-1");
  expect(again.documentId).toBe(f.documentId);
  expect(await tpAmb(f)).toBe("1");
  // The other way round, the original that says Produção marks the note, published or not.
  const g = await fixture({}, homologation);
  expect((await importAgain(g, production, "tpamb-again-2")).documentId).toBe(g.documentId);
  expect(await tpAmb(g)).toBe("1");
});

it("lê o tpAmb da nota, do protocolo e do evento, e nada de um resumo ou de texto ilegível", () => {
  const result = (document: unknown) => JSON.stringify({ document });
  expect(declaredTpAmb(result({ kind: "invoice", environment: "2", protocol: null }))).toBe("2");
  expect(
    declaredTpAmb(result({ kind: "invoice", environment: "2", protocol: { environment: "1" } })),
  ).toBe("1");
  expect(
    declaredTpAmb(result({ kind: "event", environment: "2", receipt: { environment: "1" } })),
  ).toBe("1");
  expect(declaredTpAmb(result({ kind: "summary", key: "x" }))).toBeNull();
  expect(declaredTpAmb(result({ kind: "service-invoice" }))).toBeNull();
  expect(declaredTpAmb("{")).toBeNull();
});

it("lê o tpAmb dos bytes de um arquivo recusado, com prefixo, outra codificação ou sem a marca", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  expect(scannedTpAmb(homologation)).toBe("2");
  expect(scannedTpAmb(production)).toBe("1");
  expect(scannedTpAmb(bytes("<a><tpAmb>2</tpAmb><nfe:tpAmb> 1 </nfe:tpAmb></a>"))).toBe("1");
  const latin1 = '<?xml version="1.0" encoding="ISO-8859-1"?><NFe><tpAmb>2</tpAmb>Ã</NFe>';
  expect(scannedTpAmb(Uint8Array.from(latin1, (c) => c.charCodeAt(0)))).toBe("2");
  expect(scannedTpAmb(bytes("<nota><tpAmb>3</tpAmb></nota>"))).toBeNull();
  expect(scannedTpAmb(bytes("texto"))).toBeNull();
});
