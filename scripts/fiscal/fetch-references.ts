import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalEntries, sha256, parseReferencePayload } from "../../lib/reference-dataset";
import type { ReferenceEntry, ReferenceManifest } from "../../packages/contracts/src/references";
import { municipalitySource, ncmSource } from "../../packages/contracts/src/references";

const output = process.argv[2] ?? ".reference-data";
const sources = {
  municipalities: {
    url: "https://servicodados.ibge.gov.br/api/v1/localidades/municipios",
    termsUrl: "https://servicodados.ibge.gov.br/api/docs/localidades",
    name: "IBGE / API de localidades",
  },
  ncm: {
    url: "https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json",
    termsUrl:
      "https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/download-ncm-nomenclatura-comum-do-mercosul",
    name: "Receita Federal / Siscomex Classif",
  },
};
function brDate(value: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error("Formato de data da fonte mudou.");
  return `${match[3]}-${match[2]}-${match[1]}`;
}
await mkdir(output, { recursive: true });
for (const [dataset, source] of Object.entries(sources)) {
  const response = await fetch(source.url, { signal: AbortSignal.timeout(30000) });
  if (
    new URL(response.url).hostname !== new URL(source.url).hostname ||
    new URL(response.url).protocol !== "https:"
  )
    throw new Error("Fonte redirecionou para outra origem.");
  if (!response.ok) throw new Error(`Fonte ${dataset}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 12_000_000) throw new Error("Fonte excede o limite de tamanho.");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const json: unknown = JSON.parse(raw);
  const retrievedAt = new Date().toISOString(),
    asOf = retrievedAt.slice(0, 10);
  let entries: ReferenceEntry[], sourceVersion: string;
  if (dataset === "municipalities") {
    const rows = municipalitySource.parse(json);
    entries = rows.map((r) => ({
      code: String(r.id),
      description: r.nome,
      state:
        r.microrregiao?.mesorregiao.UF.sigla ??
        r["regiao-imediata"]["regiao-intermediaria"].UF.sigla,
      validFrom: null,
      validTo: null,
    }));
    sourceVersion = `Snapshot coletado em ${asOf}; fonte sem identificador de versão`;
  } else {
    const data = ncmSource.parse(json);
    entries = data.Nomenclaturas.filter((r) => /^\d{4}\.\d{2}\.\d{2}$/.test(r.Codigo)).map((r) => ({
      code: r.Codigo.replaceAll(".", ""),
      description: r.Descricao.trim(),
      state: null,
      validFrom: brDate(r.Data_Inicio),
      validTo: r.Data_Fim === "31/12/9999" ? null : brDate(r.Data_Fim),
    }));
    sourceVersion = data.Data_Ultima_Atualizacao_NCM;
  }
  entries.sort((a, b) => a.code.localeCompare(b.code));
  const contentSha256 = await sha256(canonicalEntries(entries));
  const sourceSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const manifest: ReferenceManifest = {
    dataset: dataset as "municipalities" | "ncm",
    version: `${asOf}-${contentSha256.slice(0, 16)}`,
    source: source.name,
    sourceUrl: source.url,
    sourceVersion,
    retrievedAt,
    asOf,
    // The public NCM download is explicitly a current snapshot, not the historical Classif database.
    coverage: "snapshot",
    count: entries.length,
    sourceSha256,
    contentSha256,
    termsUrl: source.termsUrl,
    redistribution: "review-required",
    terms:
      "Fonte pública oficial para consulta. Acesso público não é licença de redistribuição. Manter payload fora do repositório e dos pacotes até obter permissão de redistribuição e concluir a revisão de licenças. Preservar atribuição e URL da fonte. Não inclui NESH nem cálculo tributário.",
  };
  const payload = JSON.stringify({ manifest, entries }, null, 2) + "\n";
  await parseReferencePayload(payload);
  await writeFile(join(output, `${dataset}.source.json`), bytes);
  await writeFile(join(output, `${dataset}.json`), payload, "utf8");
  await writeFile(
    join(output, `${dataset}.manifest.json`),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  console.log(`${dataset}: ${entries.length} registros, ${manifest.version}`);
}
