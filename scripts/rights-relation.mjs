// Relation for the `rights` gate (docs/licenses/DISTRIBUTION.md): each file of each
// accepted tarball, its source files at the proven revision, the commits that touched
// them, their authors, origin and the concession that covers them.
// Usage: node scripts/rights-relation.mjs <output.json>, after distribution:prove on a
// clean checkout. Fails on an author or a file without classification.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [output] = process.argv.slice(2);
assert.ok(output, "Informe o arquivo de saída");
const proof = JSON.parse(readFileSync(".ci-results/83/tarballs.json", "utf8"));
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true });
assert.equal(proof.result, "passed");
assert.equal(proof.dirty, false, "A relação exige a prova de um checkout limpo");
assert.equal(git("rev-parse", "HEAD").trim(), proof.codeSha, "Checkout difere da prova");

// People and tools found in the history of the packaged sources. Adding a name here
// is a maintainer decision, recorded with the concession that covers the person. The
// repository is public: each author e-mail is kept only as the SHA-256 of the address in
// lower case, compared with the hash of the commit's author e-mail.
const contributors = [
  {
    id: "wolf-stievano",
    emailSha256: [
      "53c762a7cc7b521a0007dc28a15cc5a4dd3188397c71dd8cf0ccd04b4357d633",
      "90de9e6ad1cc3212ab6d06b26f706b30a426ae5723b502b337f377c47a931c47",
    ],
    role: "Mantenedor da Freecorps",
    concession:
      "Contribuições sob CONTRIBUICOES.md, cedidas à FREECORPS TECNOLOGIA DA INFORMACAO LTDA; aceite registrado pelo próprio mantenedor na #83 em 01/11/2026",
  },
  {
    id: "heitor-stein",
    emailSha256: ["5e3b0a925e95436ae645f4eb0936b7c5476a95949e4a4faa7edbd813a99175ad"],
    role: "Segundo autor humano do projeto",
    concession:
      "Aceite dos termos de CONTRIBUICOES.md declarado pelo mantenedor em 20/10/2026 (DISTRIBUTION.md, Decisões do mantenedor em 20/10/2026)",
  },
];
// Co-authorship trailers of coding assistants: tools operated by the authors above,
// not rights holders. Their output enters through the human author's commit.
const tools = [/<noreply@anthropic\.com>$/];
const emailHash = (email) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
const byEmail = new Map(contributors.flatMap((c) => c.emailSha256.map((h) => [h, c.id])));

const history = new Map();
function sourceHistory(path) {
  if (history.has(path)) return history.get(path);
  assert.ok(existsSync(path), `Fonte ausente: ${path}`);
  const commits = git(
    "log",
    "--follow",
    "--format=%H%x1f%ae%x1f%aI%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1e)",
    proof.codeSha,
    "--",
    path,
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, email, date, trailers] = line.split("\x1f");
      const author = byEmail.get(emailHash(email));
      assert.ok(author, `Autor sem classificação em ${path}: ${email} (${sha})`);
      const coauthors = (trailers ?? "").split("\x1e").filter(Boolean);
      for (const coauthor of coauthors) {
        const email = /<([^>]+)>$/.exec(coauthor)?.[1];
        assert.ok(
          tools.some((t) => t.test(coauthor)) ||
            (email !== undefined && byEmail.has(emailHash(email))),
          `Coautor sem classificação em ${path}: ${coauthor} (${sha})`,
        );
      }
      return { sha, author, date, tools: coauthors.filter((c) => tools.some((t) => t.test(c))) };
    });
  assert.ok(commits.length > 0, `Fonte sem histórico: ${path}`);
  const entry = {
    path,
    blobSha: git("rev-parse", `${proof.codeSha}:${path}`).trim(),
    commits: commits.length,
    firstCommit: commits.at(-1).sha,
    lastCommit: commits[0].sha,
    authors: [...new Set(commits.map((c) => c.author))].sort(),
    assistedCommits: commits.filter((c) => c.tools.length).length,
  };
  history.set(path, entry);
  return entry;
}

const own = { origin: "Freecorps", concession: "Autoria dos contribuidores relacionados" };
function classify(pkg, path) {
  const dir = `packages/${pkg}`;
  if (path === "package.json")
    return { ...own, kind: "manifesto gerado", sources: [`${dir}/package.json`] };
  if (path === "THIRD_PARTY_NOTICES.txt")
    return {
      kind: "avisos de terceiros",
      origin: "Textos de licença das dependências de runtime, cada uma com a própria licença",
      concession: "Reprodução exigida pelas próprias licenças; inventário em docs/licenses",
      sources: [`${dir}/THIRD_PARTY_NOTICES.txt`],
    };
  if (/^(?:README\.md|LICENSE|NOTICE|LICENSING\.md)$/.test(path))
    return { ...own, kind: "documentação e licença", sources: [`${dir}/${path}`] };
  if (path === "schemas/manifest.json")
    return { ...own, kind: "manifesto dos XSDs", sources: [`${dir}/schemas/manifest.json`] };
  if (path === "dist/schemas.json") {
    const nfse = pkg === "fiscal-nfse";
    return {
      kind: "XSDs oficiais incorporados",
      origin: nfse ? "Receita Federal, Portal NFS-e" : "Portal Nacional da NF-e; XMLDSig do W3C",
      concession: nfse
        ? "CC BY-ND 3.0, originais intactos; decisão do mantenedor de 20/10/2026"
        : "Especificação técnica oficial, conteúdo inalterado; decisão do mantenedor de 20/10/2026; W3C Software Notice",
      sources: [`${dir}/schemas/manifest.json`, `${dir}/src/schemas.json`],
    };
  }
  if (path === "dist/schema-policy.json")
    return { ...own, kind: "política de schemas", sources: [`${dir}/src/schema-policy.json`] };
  if (pkg === "sdk") {
    if (/^(?:index|webhooks)\.js$/.test(path))
      return {
        ...own,
        kind: "bundle compilado (MIT)",
        sources: Object.keys(
          JSON.parse(readFileSync(".ci-results/74/sdk-metafile.json", "utf8")).inputs,
        ).sort(),
      };
    const declaration = /^types\/(sdk|contracts)\/src\/(.+)\.d\.ts$/.exec(path);
    if (declaration)
      return {
        ...own,
        kind: "declaração compilada (MIT)",
        sources: [`packages/${declaration[1]}/src/${declaration[2]}.ts`],
      };
  }
  const compiled = /^dist\/(.+?)(?:\.d\.ts|\.js)$/.exec(path);
  if (compiled) return { ...own, kind: "compilado", sources: [`${dir}/src/${compiled[1]}.ts`] };
  throw new Error(`Arquivo sem classificação: ${pkg}/${path}`);
}

const artifacts = proof.artifacts
  .filter((artifact) => !artifact.private)
  .map((artifact) => {
    const pkg =
      artifact.name === "@freecorps/freecorpsnfe-sdk"
        ? "sdk"
        : artifact.name.slice("@freecorps/".length);
    return {
      name: artifact.name,
      version: artifact.version,
      tarballSha256: artifact.tarballSha256,
      files: artifact.files.map(({ path, sha256 }) => {
        const relation = classify(pkg, path);
        return { path, sha256, ...relation, sources: relation.sources.map(sourceHistory) };
      }),
    };
  });
const relation = {
  codeSha: proof.codeSha,
  generatedBy: "scripts/rights-relation.mjs",
  titular: "FREECORPS TECNOLOGIA DA INFORMACAO LTDA, CNPJ 63.113.119/0001-90",
  // Emails stay in the generator: the record identifies people by id and commits.
  contributors: contributors.map(({ emailSha256: _hashes, ...person }) => person),
  tools:
    "Assistentes de código (Claude, noreply@anthropic.com) aparecem só como coautoria em commits de autores humanos relacionados; não são titulares",
  artifacts,
};
writeFileSync(output, JSON.stringify(relation, null, 2) + "\n");
const sources = new Set(
  artifacts.flatMap((a) => a.files.flatMap((f) => f.sources.map((s) => s.path))),
);
console.log(
  `Relação de rights: ${artifacts.length} pacotes, ${artifacts.reduce((n, a) => n + a.files.length, 0)} arquivos, ${sources.size} fontes, autores ${[...new Set([...history.values()].flatMap((h) => h.authors))].join(", ")}`,
);
