/**
 * Leitura da lista de esquemas XML do Portal Nacional da NF-e e comparação com o levantamento
 * versionado em packages/fiscal-nfe/schemas/portal-survey.json. Sem rede nem disco: o chamador
 * entrega o HTML e os arquivos já lidos.
 */

const OFFICIAL = "VERSÕES OFICIAIS";
const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (text) =>
  text.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (match, name) =>
    name[0] === "#"
      ? String.fromCodePoint(
          name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1)),
        )
      : (entities[name.toLowerCase()] ?? match),
  );
const clean = (text) =>
  decode(text.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

/**
 * Entradas da seção "VERSÕES OFICIAIS (em uso)", na ordem do portal. O portal publica o `+`
 * dos códigos como espaço no href; um código base64 nunca tem espaço, então ele volta a `+`.
 */
export function parseOfficialList(html) {
  const sections = [...html.matchAll(/<p class="tituloSessao">([\s\S]*?)<\/p>/g)];
  const start = sections.findIndex((match) => clean(match[1]).startsWith(OFFICIAL));
  if (start < 0) throw new Error("PORTAL_SECTION_NOT_FOUND");
  const from = sections[start].index + sections[start][0].length;
  const to = sections[start + 1]?.index ?? html.length;
  const entries = [
    ...html
      .slice(from, to)
      .matchAll(/<a[^>]*href="exibirArquivo\.aspx\?conteudo=([^"]+)"[^>]*>([\s\S]*?)<\/a>/g),
  ].map(([, code, title]) => ({ code: decode(code).replaceAll(" ", "+"), title: clean(title) }));
  if (!entries.length) throw new Error("PORTAL_SECTION_EMPTY");
  return entries;
}

/** Código `conteudo` de uma URL de download do portal, como o manifesto a grava. */
export function portalCode(url) {
  const code = new URL(url).searchParams.get("conteudo");
  if (!code) throw new Error("PORTAL_URL_WITHOUT_CODE");
  return code;
}

/**
 * Diferenças entre a lista atual e o levantamento, e entre o levantamento e o manifesto.
 * Lista vazia: nada mudou desde o levantamento.
 */
export function compareSurvey(entries, survey, manifest) {
  const findings = [];
  const surveyed = new Map(survey.entries.map((entry) => [entry.code, entry]));
  const current = new Map(entries.map((entry) => [entry.code, entry]));
  for (const entry of entries) {
    const known = surveyed.get(entry.code);
    if (!known) findings.push({ kind: "new", code: entry.code, title: entry.title });
    else if (known.title !== entry.title)
      findings.push({ kind: "renamed", code: entry.code, before: known.title, title: entry.title });
  }
  for (const entry of survey.entries)
    if (!current.has(entry.code))
      findings.push({ kind: "withdrawn", code: entry.code, title: entry.title });
  for (const source of manifest.sources) {
    const code = portalCode(source.source);
    const entry = surveyed.get(code);
    if (!entry || entry.package !== source.id)
      findings.push({ kind: "unsurveyed-pin", code, package: source.id });
    else if (!current.has(code)) findings.push({ kind: "pin-withdrawn", code, package: source.id });
  }
  return findings;
}

const messages = {
  new: (f) => `Pacote novo no portal: ${f.title} (conteudo=${f.code})`,
  renamed: (f) => `Título mudou (conteudo=${f.code}): "${f.before}" -> "${f.title}"`,
  withdrawn: (f) => `Saiu da lista oficial: ${f.title} (conteudo=${f.code})`,
  "unsurveyed-pin": (f) =>
    `Pacote fixado ${f.package} sem decisão no levantamento (conteudo=${f.code})`,
  "pin-withdrawn": (f) => `Pacote fixado ${f.package} saiu da lista oficial (conteudo=${f.code})`,
  "hash-changed": (f) =>
    `Arquivo do portal mudou para ${f.package}: SHA-256 ${f.actual}, fixado ${f.expected}`,
};
export const describeFinding = (finding) => messages[finding.kind](finding);
