// Monta, a partir de um commit, a árvore que vai para o repositório público
// novo (#267, decisão 6 de docs/v1.0/ACCEPTANCE.md) e varre os bytes que
// sairiam. Não publica, não cria repositório e não escreve no checkout.
//
//   node scripts/public-copy/public-tree.mjs --sha <rev> --out <pasta fora do repositório>
//     [--denylist <arquivo>] [--edits <arquivo>]
//
// A seleção é a classificação da auditoria de 25/10
// (docs/v1.0/evidence/83/2026-10-25/README.md, "Inventário do conteúdo
// publicável"): só "entra" e "entra com edição" são copiados. Um caminho que
// nenhuma regra classifica falha a montagem; caminho novo exige decisão.
//
// Saída em <out>: `arvore/` com os arquivos, `manifest.json` (caminho,
// SHA-256 e tamanho de cada arquivo, determinístico) e `varredura.json`
// (achados com caminho, linha e tipo, sem o valor encontrado). Depois da
// montagem, o Gitleaks fixado em `GITLEAKS_VERSION` varre `arvore/` com as
// regras padrão dele, além das regras de scripts/check-secrets.mjs. Sai com 1
// quando há achado ou edição pendente, 2 em erro de uso.
//
// Nomes restritos (clientes, mantenedores e deployments de teste) vêm de
// `--denylist`, um arquivo em custódia com o SHA-256 de cada nome
// normalizado: este script vai para o público e não pode conter os nomes.
// Pelo mesmo motivo, as edições da cópia que trocam esses nomes por papéis
// vêm de `--edits`, outro arquivo em custódia; as que não citam ninguém
// ficam em `edits`, abaixo.
//
// Roda só no repositório privado: precisa do commit da auditoria
// (`AUDIT_SHA`) para comparar os binários e da lista em custódia, que ficam
// fora da árvore pública. Numa cópia do público, sai com 2.
//
// Os arquivos de texto que as edições e os links mudaram passam, antes do
// hash, pelo oxfmt instalado no checkout, com o bloco `fmt` do
// `vite.config.ts`: a cópia precisa passar no `vp fmt --check` do CI dela.
// Os demais saem com os bytes do commit.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { allowlist as secretAllowlist, scan as scanSecrets } from "./check-secrets.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

export const AUDIT_SHA = "bfb2a9407ae6079d5d13348fc065022ce3c218ed";
export const DEFAULT_DENYLIST = "docs/v1.0/evidence/267/nomes-restritos.json";
export const DEFAULT_RESTRICTED_EDITS = "docs/v1.0/evidence/267/edicoes-restritas.json";

/**
 * Classificação da auditoria de 25/10, por prefixo; a primeira regra que
 * casa vale. `docs/historico/` está como "Sai ou edição" na auditoria; o
 * mantenedor decidiu em 28/10 que fica de fora.
 */
export const rules = [
  // Decisão de 28/10: os recibos não vão para o público. Estes testes só
  // conferem recibos (orçamento de docs/v1.0/evidence/, o script de
  // observação da #64 e a rodada hospedada de 05/10); sem eles, não há o que
  // provar.
  ...[
    "scripts/evidence-storage.test.ts",
    "scripts/observe-worktree.test.ts",
    "scripts/summarize-hosted-round.test.ts",
  ].map((path) => ({
    path,
    class: "sai",
    reason: "Teste que só confere recibos, que ficam no repositório privado",
  })),
  // Opção (a) de 03/11/2026: os três recibos que o plano de release exige
  // (deploy/platform-release.json), em cópias sanitizadas; os originais ficam no arquivo.
  // Entradas de teste: medições sintéticas em convex-test que
  // tests/platform.documentFootprint*.test.ts comparam, sem dado real.
  ...[
    "docs/v1.0/evidence/642/document-footprint.json",
    "docs/v1.0/evidence/642/document-footprint-after.json",
  ].map((path) => ({
    path,
    class: "entra",
    reason: "Linha de base sintética que um teste da cópia lê",
  })),
  {
    prefix: "docs/v1.0/evidence/84/publico/",
    class: "entra",
    reason: "Recibos sanitizados do bloco installation do plano de release",
  },
  {
    prefix: "docs/v1.0/evidence/",
    class: "custódia",
    reason: "Recibos operacionais, não documentação do produto",
  },
  {
    prefix: "docs/licenses/pareceres/",
    class: "custódia",
    reason: "Minutas jurídicas em custódia restrita",
  },
  {
    prefix: "docs/historico/",
    class: "sai",
    reason: "Legado aposentado; fica de fora por decisão do mantenedor de 28/10",
  },
  {
    prefix: "docs/operacao/",
    class: "entra com edição",
    reason: "Runbooks; mantenedores citados pelo papel",
  },
  {
    prefix: "docs/v1.0/",
    class: "entra com edição",
    reason: "Matriz e contratos 1.0; mantenedores citados pelo papel",
  },
  ...[
    "apps/console/",
    "apps/docs/",
    "platform/",
    "packages/",
    "tests/",
    "scripts/",
    "deploy/",
    ".github/",
    "examples/",
    "lib/",
    "tooling/",
    "patches/",
    "LICENSES/",
    ".agents/",
    ".claude/",
    ".vite-hooks/",
    "docs/adr/",
    "docs/plataforma/",
    "docs/desenvolvimento/",
    "docs/licenses/",
    "docs/termos/",
  ].map((prefix) => ({ prefix, class: "entra", reason: "Código, referência ou configuração" })),
  ...[
    "docs/ARQUITETURA.md",
    "docs/DEPENDENCIAS.md",
    "docs/README.md",
    "docs/worktrees.md",
    "README.md",
    "AGENTS.md",
    "CLAUDE.md",
    "LICENSE",
    "LICENSING.md",
    "NOTICE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CONTRIBUICOES.md",
    "CHANGELOG.md",
    "DESIGN.md",
    "skills-lock.json",
    "t3.json",
    ".gitattributes",
    ".gitignore",
    "bun.lock",
    "knip.jsonc",
    "package.json",
    "tsconfig.json",
    "tsconfig.platform.json",
    "vite.config.ts",
  ].map((path) => ({ path, class: "entra", reason: "Raiz do repositório" })),
];

export const PUBLIC_CLASSES = new Set(["entra", "entra com edição"]);

export function classify(path) {
  const rule = rules.find((r) => (r.path ? r.path === path : path.startsWith(r.prefix)));
  return rule ? { class: rule.class, rule: rule.path ?? rule.prefix, reason: rule.reason } : null;
}

/** Expressão que casa `text` literalmente. */
export const literal = (text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const historicoOut = "Legado fora da cópia pública (decisão de 28/10)";
const evidenceOut = "Recibos fora da cópia pública (decisão de 28/10)";

/**
 * Edições aplicadas só à cópia pública: `count` é o número exato de
 * ocorrências esperadas; outro número falha, para a edição não ficar
 * obsoleta em silêncio. As edições de dados reais foram feitas na própria
 * árvore deste repositório; a lista fica para o que só a cópia pública muda
 * e não cita ninguém. As que trocam nomes restritos ficam em custódia
 * (`--edits`). Links Markdown para caminhos excluídos viram texto em
 * `unlinkExcluded`, sem entrada aqui.
 */
export const edits = [
  {
    path: "AGENTS.md",
    find: literal(
      "existem só como histórico: a [transição](docs/historico/transicao-legado.md),\n`docs/historico/legado/API.md` e `docs/historico/legado/RUNBOOKS.md` descrevem\no que ele fazia, e o código fica no histórico do Git. Não os use como contrato\nda plataforma.",
    ),
    replace:
      "não fazem parte deste repositório; a documentação e o código deles ficam\nno repositório privado da Freecorps e não são contrato da plataforma.",
    count: 1,
    reason: historicoOut,
  },
  {
    path: "AGENTS.md",
    find: literal(
      " `docs/historico/` guarda\n  planos, transição e legado e não descreve o estado atual.",
    ),
    replace: "",
    count: 1,
    reason: historicoOut,
  },
  {
    path: "README.md",
    find: literal("ficam só no histórico do Git e em `docs/historico/`."),
    replace: "não fazem parte deste repositório.",
    count: 1,
    reason: historicoOut,
  },
  {
    path: "README.md",
    find: literal(
      "\nO contrato antigo em `docs/historico/legado/API.md` descreve só o serviço aposentado.",
    ),
    replace: "",
    count: 1,
    reason: historicoOut,
  },
  {
    path: "README.md",
    find: literal(
      "(docs/v1.0/ACCEPTANCE.md),\n  [evidências](docs/v1.0/EVIDENCE.md) e [plano da 1.0](docs/historico/planejamento-v1/plano.md).",
    ),
    replace: "(docs/v1.0/ACCEPTANCE.md) e\n  [evidências](docs/v1.0/EVIDENCE.md).",
    count: 1,
    reason: historicoOut,
  },
  {
    path: "README.md",
    find: literal(
      "- Legado: [arquitetura original](docs/historico/arquitetura-legado.md),\n  [API](docs/historico/legado/API.md) e [runbooks](docs/historico/legado/RUNBOOKS.md).\n",
    ),
    replace: "",
    count: 1,
    reason: historicoOut,
  },
  {
    path: "docs/README.md",
    find: /\n\| \[`historico\/`\]\(historico\/\) +\|[^\n]*\|/,
    replace: "",
    count: 1,
    reason: historicoOut,
  },
  {
    path: "docs/README.md",
    find: /Nada aqui é instrução vigente\.[\s\S]*?fontes que embasaram o motor legado\./,
    replace:
      "O planejamento da 1.0, a transição do serviço anterior e a documentação do\nbackoffice Clerk e do motor de emissão legado, retirados na #345, ficam no\nrepositório privado da Freecorps e não fazem parte desta cópia.",
    count: 1,
    reason: historicoOut,
  },
  {
    path: ".agents/skills/EXTERNAS.md",
    find: literal("existentes;\n  `docs/historico/legado/API.md` vale só para o legado."),
    replace: "existentes.",
    count: 1,
    reason: historicoOut,
  },
  {
    path: "docs/desenvolvimento/ci.md",
    find: literal(
      " Um apontamento que cite\n`docs/historico/legado/API.md` trata do serviço legado e não se aplica à\nplataforma.",
    ),
    replace: "",
    count: 1,
    reason: historicoOut,
  },
  {
    path: "docs/plataforma/ISSUANCE.md",
    find: literal("29/08/2026\n(`docs/historico/PESQUISA-FISCAL.md`), que"),
    replace: "29/08/2026, que",
    count: 1,
    reason: historicoOut,
  },
  {
    path: "DESIGN.md",
    find: literal("seção 7 de `docs/historico/planejamento-v1/plano.md`)"),
    replace: "seção 7 do plano da 1.0)",
    count: 1,
    reason: historicoOut,
  },
  ...["docs/v1.0/SDK.md", "apps/console/public/developer/SDK.md"].map((path) => ({
    path,
    find: literal(" O serviço legado tem\ncontrato próprio em `docs/historico/legado/API.md`."),
    replace: "",
    count: 1,
    reason: historicoOut,
  })),
  {
    path: "packages/fiscal-nfse/src/danfse.ts",
    find: literal(", ver docs/historico/PESQUISA-FISCAL.md)"),
    replace: ")",
    count: 1,
    reason: historicoOut,
  },
  {
    path: "tests/fixtureCorpus.test.ts",
    find: literal(
      "    for (const file of module.evidence)\n      expect(existsSync(new URL(`../${file}`, import.meta.url))).toBe(true);",
    ),
    replace:
      '    // Cópia pública: os recibos (docs/v1.0/evidence/) ficam no repositório privado.\n    for (const file of module.evidence.filter((f) => !f.startsWith("docs/v1.0/evidence/")))\n      expect(existsSync(new URL(`../${file}`, import.meta.url))).toBe(true);',
    count: 1,
    reason: evidenceOut,
  },
  {
    path: "scripts/deploy/platform-release.test.ts",
    find: literal(
      'import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";',
    ),
    replace:
      'import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";',
    count: 1,
    reason: evidenceOut,
  },
  {
    path: "scripts/deploy/platform-release.test.ts",
    find: literal(
      '  const live = JSON.parse(readFileSync(join(repository, "deploy/platform-release.json"), "utf8"));\n',
    ),
    replace:
      '  // Cópia pública: os recibos do corte que o plano cita ficam no repositório privado.\n  if (!existsSync(join(repository, "docs/v1.0/evidence")))\n    return context.skip("recibos do corte fora da cópia pública");\n  const live = JSON.parse(readFileSync(join(repository, "deploy/platform-release.json"), "utf8"));\n',
    count: 1,
    reason: evidenceOut,
  },
  // Instruções que mandam executar ou gravar um arquivo de docs/v1.0/evidence/:
  // na cópia, dizem onde ele fica.
  {
    path: "docs/plataforma/PLATFORM-COSTS.md",
    find: literal(
      "Execute `node docs/v1.0/evidence/429/costs/model.mjs`. O script é local, não\nconsulta serviços",
    ),
    replace:
      "O modelo (`docs/v1.0/evidence/429/costs/model.mjs`) fica nos recibos do\nrepositório privado da Freecorps e não acompanha esta cópia. O script é\nlocal, não consulta serviços",
    count: 1,
    reason: evidenceOut,
  },
  {
    path: "docs/plataforma/PLATFORM-COSTS.md",
    find: literal(
      "Execute `node docs/v1.0/evidence/429/costs/paid-plans.mjs` com Node 22.18 ou\nmais recente e dependências locais instaladas.",
    ),
    replace:
      "O script `docs/v1.0/evidence/429/costs/paid-plans.mjs`, que roda com Node\n22.18 ou mais recente e as dependências locais instaladas, fica nos recibos\ndo repositório privado da Freecorps e não acompanha esta cópia.",
    count: 1,
    reason: evidenceOut,
  },
  {
    path: "docs/plataforma/CAPTURE.md",
    find: literal(
      "copia para `docs/v1.0/evidence/50/AAAA-MM-DD/receipt.json` e\n   escreve o README da rodada",
    ),
    replace:
      "copia para os recibos da #50, no repositório privado da\n   Freecorps, e escreve o README da rodada",
    count: 1,
    reason: evidenceOut,
  },
];

/**
 * Lê as edições em custódia: `{ schema: 1, edits: [{ path, find, replace,
 * count, reason }] }`, com `find` e `replace` literais. Ficam fora da árvore
 * pública porque citam os nomes que trocam.
 */
export function loadRestrictedEdits(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (data.schema !== 1 || !Array.isArray(data.edits))
    throw new Error(`${file}: lista de edições restritas inválida`);
  return data.edits.map((e, i) => {
    const valid =
      typeof e?.path === "string" &&
      typeof e.find === "string" &&
      e.find.length > 0 &&
      typeof e.replace === "string" &&
      Number.isInteger(e.count) &&
      e.count >= 1 &&
      typeof e.reason === "string";
    if (!valid) throw new Error(`${file}: edição ${i} da lista de edições restritas inválida`);
    // Função, para `$&` e afins no texto novo valerem como texto.
    return {
      path: e.path,
      find: literal(e.find),
      replace: () => e.replace,
      count: e.count,
      reason: e.reason,
    };
  });
}

/** Aplica `edits` ao texto de `path`; devolve o texto, as divergências e as trocas. */
export function applyEdits(path, text, list = edits) {
  const problems = [];
  let out = text;
  let applied = 0;
  for (const edit of list.filter((e) => e.path === path)) {
    // Conserva as flags da edição (`i`, `m`, `s`, `u`…) e conta todas.
    const find = new RegExp(edit.find.source, `${edit.find.flags.replace(/[gy]/g, "")}g`);
    const found = out.match(find)?.length ?? 0;
    if (found !== edit.count) {
      problems.push({ path, reason: edit.reason, expected: edit.count, found });
      continue;
    }
    out = out.replace(find, edit.replace);
    applied += found;
  }
  return { text: out, problems, applied };
}

// ---------------------------------------------------------------------------
// Identificadores fiscais

const digitsOf = (value) => value.replace(/\D/g, "");

/** CNPJ sem máscara, em maiúsculas: numérico ou alfanumérico (IN RFB 2.229/2024). */
const cnpjOf = (value) => value.replace(/[./-]/g, "").toUpperCase();

/**
 * CNPJ numérico ou alfanumérico: 12 caracteres `[0-9A-Z]` e dois DVs
 * numéricos, módulo 11 com pesos 2..9; cada caractere vale o código ASCII
 * menos 48, o que dá o mesmo cálculo de sempre para os dígitos.
 */
export function validCnpj(value) {
  const d = cnpjOf(value);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (base) => {
    let sum = 0;
    let weight = base.length - 7;
    for (const c of base) {
      sum += (c.charCodeAt(0) - 48) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = dv(d.slice(0, 12));
  return first === Number(d[12]) && dv(d.slice(0, 13)) === Number(d[13]);
}

export function validCpf(value) {
  const d = digitsOf(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

/** Chave de acesso sem separadores, em maiúsculas. */
const accessKeyOf = (value) => value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();

/**
 * Chave de acesso NF-e/NFC-e/CT-e: 44 posições, numérica ou com o emitente
 * de CNPJ alfanumérico nas posições 7 a 18; DV módulo 11 com pesos 2..9,
 * cada caractere valendo o código ASCII menos 48, como no CNPJ.
 */
export function validAccessKey(value) {
  const d = accessKeyOf(value);
  if (!/^\d{6}[0-9A-Z]{12}\d{26}$/.test(d)) return false;
  let sum = 0;
  let weight = 2;
  for (let i = 42; i >= 0; i--) {
    sum += (d.charCodeAt(i) - 48) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  return (rest < 2 ? 0 : 11 - rest) === Number(d[43]);
}

/**
 * CNPJ e CPF que a auditoria de 25/10 classificou como sintéticos, valores
 * de teste públicos ou da própria Freecorps. Qualquer outro válido é achado.
 */
export const knownCnpjs = new Set([
  "11222333000181",
  "11444777000161",
  "12345678000195",
  "11111111000191",
  "00000000000191",
  "63113119000190",
  // Alfanuméricos: o exemplo oficial da Receita (12.ABC.345/01DE-35) e o CNPJ
  // público que a prova do provedor consulta (scripts/fiscal/prove-registry-provider.mjs).
  "12ABC34501DE35",
  // O CPF de exemplo 001.234.567-97 depois de três zeros, que também é CNPJ válido:
  // o caso "CNPJ ou CPF" dos testes da chave de acesso.
  "00000123456797",
  "00000000E08G12",
]);
// Os dois últimos: os CPFs de exemplo que os testes da chave de acesso usam como
// emitente, depois de três zeros (packages/fiscal-core, console).
export const knownCpfs = new Set(["52998224725", "11144477735", "00123456797", "12345678909"]);

// ---------------------------------------------------------------------------
// E-mails, caminhos e deployments

/**
 * TLDs reservados (RFC 2606/6761), `example.com/.net/.org` e os marcadores
 * de formato que o console mostra (`nome@empresa.com.br`). `.local` não
 * aparece em e-mail do projeto e fica de fora.
 */
const exampleDomain =
  /(?:^|\.)(?:test|example|invalid|localhost)$|(?:^|\.)example\.(?:com|net|org)$|^empresa\.com(?:\.br)?$/;
/** Endereços de função da Freecorps; outro local-part é de uma pessoa. */
export const freecorpsRoles = new Set([
  "privacidade",
  "seguranca",
  "security",
  "contato",
  "suporte",
  "support",
  "noreply",
  "no-reply",
  "nao-responda",
  "naoresponda",
  "dpo",
  "fiscal",
  "operacao",
  "billing",
  "financeiro",
  "juridico",
  "ola",
  "acesso",
]);
const freecorpsDomain = /(?:^|\.)freecorps\.com\.br$/;
/** Versão depois do `@` de um pacote: números, pré-lançamento opcional e o `.patch` do Bun. */
const version = /^\d+(?:\.\d+)+(?:-[0-9a-z]+(?:\.[0-9a-z]+)*)?(?:\.patch)?$/;
/** Domínios técnicos que não identificam pessoa (noreply de commits e do GitHub). */
const technicalAddress =
  /^(?:noreply@anthropic\.com|[^@]+@users\.noreply\.github\.com|git@github\.com)$/;
/** Avisos de licença precisam do e-mail dos autores: ficam como estão. */
const licenseNotice =
  /(?:^|\/)(?:LICEN[CS]E[^/]*|NOTICE[^/]*|THIRD_PARTY[^/]*|COPYING[^/]*)$|^LICENSES\/|^docs\/licenses\/texts\/|^\.agents\/skills\/licencas\/|^docs\/licenses\/dependencies\.json$/;

/** Nomes de usuário genéricos em caminhos de exemplo, runners e contêineres. */
const genericUsers = new Set([
  "public",
  "default",
  "runner",
  "runneradmin",
  "user",
  "usuario",
  "you",
  "voce",
  "me",
  "dev",
  "nome",
  "name",
  "username",
  "node",
  "ubuntu",
  "app",
  "bun",
  "foo",
  "alice",
  "bob",
  "x",
  "fulano",
  "seu-usuario",
  "seunome",
  "operator",
  "operador",
]);

/** Deployments que a auditoria aceitou expor: produção e validação, já no CSP. */
export const publicDeployments = new Set(["elated-possum-295", "modest-seal-118"]);
/**
 * Nomes fictícios dos testes e o exemplo da documentação da Convex. Os
 * deployments de teste reais vêm da lista em custódia, como `deployment-teste`.
 */
export const syntheticDeployments = new Set([
  "brave-otter-123",
  "brave-otter-1234",
  "synthetic-fiscal-123",
  "synthetic-target-123",
  "other-target-123",
  "other-deployment-1",
  "outro-alvo-1",
  "happy-animal-123",
  "basic-anteater-667",
  // Os do teste da prova de leitura hospedada (scripts/proofs/hosted-read-proof.test.ts).
  "happy-otter-123",
  "other-otter-9",
  "a-b-1",
]);

/**
 * Achados conhecidos que não são dado real, um por arquivo e tipo, com o
 * número exato de ocorrências, como em scripts/public-copy/check-secrets.mjs: uma a mais
 * bloqueia o grupo inteiro; uma a menos marca a exceção como obsoleta.
 */
export const findingAllowlist = [
  ...[
    "e110001",
    "e112110",
    "e112120",
    "e112130",
    "e112140",
    "e112150",
    "e211110",
    "e211124",
    "e211128",
    "e211130",
    "e211140",
    "e211150",
    "e212110",
    "e212120",
    "e412120",
    "e412130",
  ].map((event) => ({
    path: `packages/fiscal-nfe/schemas/rtc-events-1.40/${event}_v1.00.xsd`,
    kind: "email-externo",
    count: 1,
    reason: "Endereço institucional da PROCERGS no cabeçalho do XSD oficial, copiado sem edição",
  })),
  {
    path: "packages/fiscal-nfe/src/schemas.json",
    kind: "email-externo",
    count: 16,
    reason: "Os mesmos XSDs oficiais embutidos no pacote",
  },
  {
    path: ".agents/skills/break-ui/CATALOG.md",
    kind: "email-externo",
    count: 2,
    reason: "Endereços fictícios do catálogo de entradas hostis",
  },
  {
    path: ".agents/skills/break-ui/SKILL.md",
    kind: "email-externo",
    count: 1,
    reason: "Persona fictícia da skill",
  },
  {
    path: ".agents/skills/domain-modeling/CONTEXT-FORMAT.md",
    kind: "link-quebrado",
    count: 3,
    reason: "Links do CONTEXT-MAP.md de exemplo, dentro de bloco de código",
  },
  {
    path: ".agents/skills/vercel-react-best-practices/AGENTS.md",
    kind: "link-quebrado",
    count: 3,
    reason: "Regras da skill de terceiros que só vêm compiladas neste arquivo",
  },
  {
    path: "scripts/fiscal/prove-certificates-hosted.ts",
    kind: "email-externo",
    count: 1,
    reason: "Destino SSH do túnel público pinggy, não é e-mail",
  },
  {
    path: "scripts/public-copy/public-identifiers.test.ts",
    kind: "cnpj-nao-sintetico",
    count: 3,
    reason: "CNPJ fictício que o próprio teste usa para provar a detecção",
  },
  {
    path: "scripts/public-copy/public-identifiers.test.ts",
    kind: "chave-de-acesso",
    count: 1,
    reason: "Chave fictícia que o próprio teste usa para provar a detecção",
  },
  {
    path: "docs/v1.0/evidence/84/publico/legacy-reset.json",
    kind: "cpf-nao-sintetico",
    count: 1,
    reason: "Id de 11 dígitos do run do CI (ciRun) que por acaso tem DV de CPF",
  },
  // Decisão 1 de 28/10: o login fica onde o processo exige uma pessoa nomeada
  // e o código o lê; no resto da cópia, o mantenedor é citado pelo papel.
  ...[
    [".github/CODEOWNERS", 62, "Dono dos caminhos que o GitHub pede para revisar"],
    [
      "deploy/issuance-gate.json",
      2,
      "Quem pode disparar os workflows de emergência do gate fiscal",
    ],
    ["scripts/deploy/issuance-gate.test.ts", 2, "Teste que confere o dono no CODEOWNERS real"],
    [
      "scripts/deploy/issuance-release.test.ts",
      19,
      "Teste do gate fiscal com a lista real de autorizados",
    ],
    [
      "scripts/deploy/capture-release.test.ts",
      2,
      "Teste do corte da captura com a lista real de autorizados",
    ],
    ["deploy/offsite-backup.json", 2, "Custodiantes do backup externo D04, duas pessoas distintas"],
    // Só a asserção sobre os custodiantes de deploy/offsite-backup.json; o
    // plano sintético usa nomes fictícios.
    ["scripts/backup/offsite-backup.test.ts", 2, "Teste do plano de backup com os custodiantes reais"],
    [".github/workflows/offsite-backup.yml", 2, "Pessoa a quem o alerta do backup é atribuído"],
    // A LGPD (art. 41, §1º) exige divulgar a identidade do encarregado.
    [
      "docs/termos/arquivo/politica-de-privacidade-2026-11-01.md",
      1,
      "Encarregado identificado na política de privacidade publicada",
    ],
    ["apps/console/src/privacy-policy.test.tsx", 1, "Teste que confere o encarregado na política"],
    [
      "scripts/licenses/rights-relation.mjs",
      2,
      "Relação do gate rights: identifica os titulares dos direitos",
    ],
  ].map(([path, count, reason]) => ({ path, kind: "mantenedor", count, reason })),
];

// ---------------------------------------------------------------------------
// Gitleaks sobre a árvore montada (#267)

/** A versão que a varredura aceita: outra pode mudar as regras e o resultado. */
export const GITLEAKS_VERSION = "8.21.2";

/**
 * Achados do Gitleaks que não são segredo, por arquivo e regra, com o número
 * exato de ocorrências, como `findingAllowlist`.
 */
export const gitleaksAllowlist = [
  ["packages/contracts/published.json", "generic-api-key", 1, "SHA-256 do OpenAPI publicado"],
  ["packages/fiscal-nfse/signer.test.ts", "private-key", 1, "PEM de mentira do teste de erro"],
  [
    "platform/convex/testing/coldArchiveProof.ts",
    "generic-api-key",
    1,
    "Chave de objeto sintética da prova da camada fria",
  ],
  ["scripts/billing/usage-migration-status.test.ts", "generic-api-key", 1, "Texto fixo do teste"],
  [
    "tests/fixtures/nfe/4.00/synthetic-signing-key.pem",
    "private-key",
    1,
    "Chave sintética da fixture de assinatura NF-e, gerada para os testes",
  ],
  ["tests/platform.billing.test.ts", "stripe-access-token", 3, "rk_test/rk_live sintéticos"],
  ["tests/platform.captureGap.test.ts", "generic-api-key", 1, "Segredo de webhook sintético"],
  ["tests/platform.issuanceRest.test.ts", "generic-api-key", 1, "Chave de idempotência do teste"],
  ["tests/sdk.test.ts", "generic-api-key", 1, "SHA-256 do OpenAPI publicado"],
].map(([path, rule, count, reason]) => ({ path, rule, count, reason }));

/**
 * Lê o relatório JSON do Gitleaks: caminho relativo a `dir`, linha e regra,
 * nunca o valor (`Secret`, `Match`).
 */
export function parseGitleaks(report, dir) {
  if (!Array.isArray(report)) throw new Error("relatório do Gitleaks inválido");
  const base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return report.map((leak) => {
    const file = String(leak.File ?? "").replace(/\\/g, "/");
    const path = file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file;
    return { path, line: Number(leak.StartLine) || 1, rule: String(leak.RuleID ?? "desconhecida") };
  });
}

/**
 * Junta os achados do Gitleaks ao relatório: o que passa da exceção bloqueia
 * como `segredo-gitleaks`, e uma exceção que sobra fica obsoleta.
 */
export function applyGitleaks(report, leaks, allow = gitleaksAllowlist) {
  const groups = new Map();
  for (const leak of leaks) {
    const key = `${leak.path}\0${leak.rule}`;
    groups.set(key, [...(groups.get(key) ?? []), leak]);
  }
  const entry = (key) => allow.find((a) => `${a.path}\0${a.rule}` === key);
  const open = [...groups].flatMap(([key, found]) =>
    found.length > (entry(key)?.count ?? 0) ? found : [],
  );
  const stale = allow.filter((a) => (groups.get(`${a.path}\0${a.rule}`)?.length ?? 0) < a.count);
  for (const leak of open)
    report.findings.items.push({
      path: leak.path,
      line: leak.line,
      kind: "segredo-gitleaks",
      rule: leak.rule,
    });
  if (open.length) report.findings.byKind["segredo-gitleaks"] = open.length;
  report.findings.allowed += leaks.length - open.length;
  report.findings.staleAllowlist.push(
    ...stale.map(({ path, rule, count }) => ({ path, kind: "segredo-gitleaks", rule, count })),
  );
  report.gitleaks = { version: GITLEAKS_VERSION, findings: leaks.length, open: open.length };
  if (open.length || stale.length) report.status = "bloqueada";
  return report;
}

/** Separa os achados cobertos por `allow` e as exceções obsoletas. */
export function applyAllowlist(findings, allow = findingAllowlist) {
  const groups = new Map();
  for (const f of findings) {
    const key = `${f.path}\0${f.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const entry = (key) => allow.find((a) => `${a.path}\0${a.kind}` === key);
  return {
    open: [...groups].flatMap(([key, found]) =>
      found.length > (entry(key)?.count ?? 0) ? found : [],
    ),
    allowed: [...groups].reduce(
      (n, [key, found]) => n + (found.length <= (entry(key)?.count ?? 0) ? found.length : 0),
      0,
    ),
    stale: allow.filter((a) => (groups.get(`${a.path}\0${a.kind}`)?.length ?? 0) < a.count),
  };
}

// ---------------------------------------------------------------------------
// Nomes restritos

export const normalize = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Palavras do nome normalizado; um nome sem letra nem dígito não tem como ser achado. */
const nameWords = (name) => {
  const words = normalize(name).match(/[a-z0-9]+/g);
  if (!words) throw new Error(`nome restrito sem letra nem dígito: ${JSON.stringify(name)}`);
  return words;
};

export const nameHash = (name) =>
  createHash("sha256").update(nameWords(name).join(" ")).digest("hex");

// `produto-freecorps`: outros produtos da Freecorps, citados como app consumidor ou
// projeto de origem na cópia (decisão 6, revista em 03/11/2026).
const denyKinds = new Set(["cliente", "mantenedor", "deployment-teste", "produto-freecorps"]);

/** Lê a lista em custódia: `{ entries: [{ kind, sha256, words, length }] }`. */
export function loadDenylist(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (data.schema !== 1 || !Array.isArray(data.entries))
    throw new Error(`${file}: lista de nomes restritos inválida`);
  data.entries.forEach((e, i) => {
    const valid =
      denyKinds.has(e?.kind) &&
      /^[0-9a-f]{64}$/.test(e.sha256) &&
      Number.isInteger(e.words) &&
      e.words >= 1 &&
      Number.isInteger(e.length) &&
      e.length >= 1;
    if (!valid) throw new Error(`${file}: entrada ${i} da lista de nomes restritos inválida`);
  });
  return data.entries;
}

/** Entrada da lista para um nome; usado para montar a lista em custódia. */
export function denyEntry(kind, name) {
  const words = nameWords(name);
  return { kind, sha256: nameHash(name), words: words.length, length: words.join(" ").length };
}

function nameMatcher(entries) {
  const byShape = new Map();
  for (const e of entries) {
    const key = `${e.words}:${e.length}`;
    if (!byShape.has(key)) byShape.set(key, new Map());
    byShape.get(key).set(e.sha256, e.kind);
  }
  const maxWords = Math.max(0, ...entries.map((e) => e.words));
  // Um achado por posição, o do nome mais longo: com o nome completo e o
  // primeiro nome na lista, o completo conta uma vez só, e as palavras que ele
  // cobre não contam de novo.
  return (tokens) => {
    const found = [];
    for (let i = 0; i < tokens.length; i++) {
      let joined = "";
      let best = null;
      for (let n = 1; n <= maxWords && i + n <= tokens.length; n++) {
        joined = n === 1 ? tokens[i].text : `${joined} ${tokens[i + n - 1].text}`;
        const shape = byShape.get(`${n}:${joined.length}`);
        if (!shape) continue;
        const kind = shape.get(createHash("sha256").update(joined).digest("hex"));
        if (kind) best = { index: tokens[i].index, kind, words: n };
      }
      if (best) {
        found.push({ index: best.index, kind: best.kind });
        i += best.words - 1;
      }
    }
    return found;
  };
}

// ---------------------------------------------------------------------------
// Varredura de um arquivo

const lineAt = (text) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
};

/**
 * Tipos de achado. `bloqueia` impede publicar até a correção; `decisão`
 * depende do mantenedor; `aviso` só informa (não muda o status);
 * `dispensa` é o que a varredura reconhece e deixa passar, contado por
 * arquivo em `findings.waived`.
 */
export const findingKinds = {
  segredo: "bloqueia",
  "segredo-gitleaks": "bloqueia",
  "cnpj-nao-sintetico": "bloqueia",
  "cpf-nao-sintetico": "bloqueia",
  "chave-de-acesso": "bloqueia",
  "email-externo": "bloqueia",
  "caminho-local": "bloqueia",
  cliente: "bloqueia",
  mantenedor: "decisão",
  "email-pessoal-freecorps": "decisão",
  "deployment-teste": "decisão",
  "produto-freecorps": "bloqueia",
  "deployment-desconhecido": "bloqueia",
  "link-simbolico-invalido": "bloqueia",
  "link-quebrado": "bloqueia",
  "link-excluido": "aviso",
  "referencia-excluida": "aviso",
  "repositorio-privado": "aviso",
  "email-licenca": "dispensa",
  "email-funcao-freecorps": "dispensa",
};

// Vale também depois de `/`, `-` e `.` (caminho, URL, identificador): o DV
// filtra as sequências que só parecem CNPJ.
const cnpjPattern = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g;
// Alfanumérico (a partir de julho de 2026): ao menos uma letra na raiz ou na
// ordem, em maiúsculas ou minúsculas.
const cnpjAlnumPattern =
  /(?<![0-9A-Za-z])(?=[0-9A-Za-z./]{0,14}[A-Za-z])[0-9A-Za-z]{2}\.?[0-9A-Za-z]{3}\.?[0-9A-Za-z]{3}\/?[0-9A-Za-z]{4}-?\d{2}(?![0-9A-Za-z])/g;
const cpfPattern = /(?<![\d.])\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
// Sem máscara: 11 dígitos isolados, fora de hash, identificador, caminho ou
// número maior (CNPJ, chave de acesso, timestamp); o DV filtra o resto.
const cpfDigitsPattern = /(?<![0-9A-Za-z./_-])\d{11}(?![0-9A-Za-z_])/g;
// Chave contínua (também depois de `NFe`, no `Id` do XML) ou em 11 grupos de
// 4 separados por espaço, ponto ou hífen; o emitente pode ter letras.
const accessKeyPattern =
  /(?<!\d)\d{6}[0-9A-Za-z]{12}\d{26}(?!\d)|(?<![0-9A-Za-z])[0-9A-Za-z]{4}([ .-])(?:[0-9A-Za-z]{4}\1){9}[0-9A-Za-z]{4}(?![0-9A-Za-z])/g;
const emailPattern = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// Windows (`C:\Users`, `c:/users`, `file:///c%3A/Users`), Git Bash (`/c/Users`),
// WSL (`/mnt/c/Users`), macOS (`/Users`) e Linux (`/home`, `/var/home`).
const localPathPattern =
  /(?:\b[A-Za-z](?::|%3[Aa])[\\/]{1,2}[Uu][Ss][Ee][Rr][Ss][\\/]{1,2}|(?<![\w.])\/(?:mnt\/)?[A-Za-z]\/[Uu][Ss][Ee][Rr][Ss]\/|(?<![\w.])\/(?:var\/)?(?:Users|home)\/)([A-Za-z0-9._-]+)/g;
// O nome vem antes da região opcional: `<nome>.<região>.convex.cloud`, em
// qualquer caixa.
const convexHostPattern =
  /\b([a-z]+-[a-z]+-\d{1,4})(?:\.[a-z]{2}-[a-z]+-\d)?\.convex\.(?:cloud|site)\b/gi;
const convexRegion = /^(?:us|eu|ap|sa|ca|me|af)-[a-z]+-\d$/;
// `CONVEX_DEPLOYMENT` e o prefixo das chaves de deploy: `dev:<nome>`, `prod:<nome>`.
const convexDeploymentPattern = /\b(?:dev|prod|preview):([a-z]+-[a-z]+-\d{1,4})\b/g;
const privateRepoPattern = /github\.com\/freecorps\/freecorpsNFE\b/gi;
const markdownLinkPattern = /\]\((?!https?:|mailto:|#)([^)\s]+)\)/g;
// O link inteiro, com o texto (que pode quebrar linha) e o `!` de imagem.
const markdownFullLinkPattern =
  /!?\[((?:[^[\]]|\[[^[\]]*\])*)\]\((?!https?:|mailto:|#)([^)\s]+)\)/g;

/** Caminho no repositório do alvo relativo de um link Markdown, ou `null`. */
function linkTarget(path, href) {
  let target;
  try {
    target = decodeURI(href.split("#")[0]).replace(/^<|>$/g, "");
  } catch {
    return null;
  }
  if (!target || target.startsWith("/")) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target)).replace(/\/$/, "");
  return resolved.startsWith("..") ? null : resolved;
}

/** Se o alvo relativo de um link Markdown existe no repositório e ficou fora da árvore. */
function excludedTarget(path, href, context) {
  const resolved = linkTarget(path, href);
  return Boolean(resolved && context.known?.(resolved) && !context.included(resolved));
}

/** Se o alvo relativo de um link Markdown não existe no commit montado. */
function missingTarget(path, href, context) {
  const resolved = linkTarget(path, href);
  return Boolean(resolved && context.known && !context.known(resolved));
}

/**
 * Na cópia pública, link Markdown para um caminho que ficou de fora (recibos,
 * `docs/historico/`) vira só o texto do link (decisões 3 e 4 de 28/10).
 */
export function unlinkExcluded(path, text, context) {
  let count = 0;
  const out = text.replace(markdownFullLinkPattern, (all, label, href) => {
    if (!excludedTarget(path, href, context)) return all;
    count++;
    return label;
  });
  return { text: out, count };
}

/**
 * Achados em um arquivo de texto: `{ path, line, kind }`, nunca o valor.
 * `context.included(path)` diz se um caminho do repositório está na árvore
 * pública; `context.excludedPrefixes` lista os prefixos que ficaram de fora.
 */
export function scanText(path, text, context = {}) {
  const findings = [];
  const line = lineAt(text);
  const add = (index, kind) => findings.push({ path, line: line(index), kind });

  for (const pattern of [cnpjPattern, cnpjAlnumPattern])
    for (const m of text.matchAll(pattern)) {
      const d = cnpjOf(m[0]);
      if (validCnpj(d) && !knownCnpjs.has(d)) add(m.index, "cnpj-nao-sintetico");
    }
  for (const pattern of [cpfPattern, cpfDigitsPattern])
    for (const m of text.matchAll(pattern)) {
      const d = digitsOf(m[0]);
      if (validCpf(d) && !knownCpfs.has(d)) add(m.index, "cpf-nao-sintetico");
    }
  for (const m of text.matchAll(accessKeyPattern)) {
    const d = accessKeyOf(m[0]);
    // O emitente vai nas posições 7 a 20: CNPJ, ou CPF com três zeros à
    // esquerda. Emitente inválido (zeros, por exemplo) é marcador de teste.
    const issuer = d.slice(6, 20);
    const real =
      !knownCnpjs.has(issuer) &&
      (validCnpj(issuer) ||
        (issuer.startsWith("000") && validCpf(issuer.slice(3)) && !knownCpfs.has(issuer.slice(3))));
    if (validAccessKey(d) && real) add(m.index, "chave-de-acesso");
  }
  const license = licenseNotice.test(path);
  for (const m of text.matchAll(emailPattern)) {
    const address = m[0].toLowerCase().replace(/\.+$/, "");
    const [local, domain] = address.split("@");
    if (technicalAddress.test(address) || exampleDomain.test(domain)) continue;
    // `pacote@1.2.3`, `pacote@1.0.0-next.29`, o patch `pacote@1.2.3.patch` e
    // `@escopo/pacote@arquivo.ts` não são e-mail; um domínio como `1a.com.br` é.
    if (version.test(domain) || /^[a-z0-9-]+\.(?:js|ts|mjs|json|md|tsx)$/.test(domain)) continue;
    if (license) add(m.index, "email-licenca");
    else if (!freecorpsDomain.test(domain)) add(m.index, "email-externo");
    else if (freecorpsRoles.has(local.split("+")[0])) add(m.index, "email-funcao-freecorps");
    else add(m.index, "email-pessoal-freecorps");
  }
  for (const m of text.matchAll(localPathPattern)) {
    if (!genericUsers.has(m[1].toLowerCase()) && !/^[$%<{.]/.test(m[1]))
      add(m.index, "caminho-local");
  }
  // Um deployment da lista em custódia já é achado como `deployment-teste`.
  const restricted = new Set(
    (context.denylist ?? []).filter((e) => e.kind === "deployment-teste").map((e) => e.sha256),
  );
  for (const pattern of [convexHostPattern, convexDeploymentPattern])
    for (const m of text.matchAll(pattern)) {
      const name = m[1].toLowerCase();
      // Só a região, sem nome antes (`${NOME}.eu-west-1.convex.cloud`): não há deployment.
      if (convexRegion.test(name)) continue;
      if (
        !publicDeployments.has(name) &&
        !syntheticDeployments.has(name) &&
        !restricted.has(nameHash(name))
      )
        add(m.index, "deployment-desconhecido");
    }
  for (const m of text.matchAll(privateRepoPattern)) add(m.index, "repositorio-privado");

  if (context.denylist?.length) {
    const normalized = normalize(text);
    const tokens = [...normalized.matchAll(/[a-z0-9]+/g)].map((t) => ({
      text: t[0],
      index: t.index,
    }));
    const nline = lineAt(normalized);
    for (const { index, kind } of nameMatcher(context.denylist)(tokens))
      findings.push({ path, line: nline(index), kind });
  }

  if (context.included) {
    if (/\.mdx?$/.test(path)) {
      for (const m of text.matchAll(markdownLinkPattern)) {
        if (excludedTarget(path, m[1], context)) add(m.index, "link-excluido");
        else if (missingTarget(path, m[1], context)) add(m.index, "link-quebrado");
      }
    } else {
      for (const prefix of context.excludedPrefixes ?? []) {
        let at = text.indexOf(prefix);
        while (at !== -1) {
          add(at, "referencia-excluida");
          at = text.indexOf(prefix, at + prefix.length);
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Montagem

const isBinary = (bytes) => bytes.subarray(0, 8000).includes(0);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Lê `git ls-tree -r` de um commit: `{ mode, object, path }`. */
export function listTree(root, rev) {
  return execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", rev], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 1 << 28,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [meta, path] = entry.split("\t");
      const [mode, type, object] = meta.split(" ");
      return { mode, type, object, path };
    });
}

/** Conteúdo dos blobs por `git cat-file --batch`, numa chamada só. */
export function readBlobs(root, objects) {
  if (!objects.length) return new Map();
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: `${objects.join("\n")}\n`,
    maxBuffer: 1 << 30,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git cat-file: ${result.stderr.toString()}`);
  const out = result.stdout;
  const blobs = new Map();
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(10, at);
    const [object, , size] = out.subarray(at, end).toString("utf8").split(" ");
    const start = end + 1;
    blobs.set(object, out.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return blobs;
}

/**
 * Monta a seleção a partir das entradas do `ls-tree` e de um leitor de
 * blobs. Não escreve nada: devolve arquivos, manifesto e varredura.
 */
export function build({
  sha,
  entries,
  read,
  denylist = /** @type {ReturnType<typeof denyEntry>[]} */ ([]),
  auditedObjects = new Set(),
  editList = edits,
  allow = findingAllowlist,
  secretAllow = secretAllowlist,
  format = /** @type {((texts: Map<string, string>) => Map<string, string>) | null} */ (null),
  classifyPath = classify,
}) {
  const unclassified = [];
  const excluded = new Map();
  const counts = {};
  const selected = [];
  const symlinks = [];
  for (const entry of entries) {
    const c = classifyPath(entry.path);
    if (!c) {
      unclassified.push(entry.path);
      continue;
    }
    counts[c.class] = (counts[c.class] ?? 0) + 1;
    if (!PUBLIC_CLASSES.has(c.class)) {
      const key = `${c.rule}\0${c.class}\0${c.reason}`;
      excluded.set(key, (excluded.get(key) ?? 0) + 1);
      continue;
    }
    if (entry.mode === "160000") {
      unclassified.push(`${entry.path} (submódulo)`);
      continue;
    }
    if (entry.mode === "120000") symlinks.push({ ...entry, class: c.class });
    else selected.push({ ...entry, class: c.class });
  }

  const includedPaths = new Set([...selected, ...symlinks].map((e) => e.path));
  const allPaths = new Set(entries.map((e) => e.path));
  const dirs = new Set();
  for (const p of allPaths)
    for (let d = posix.dirname(p); d !== "."; d = posix.dirname(d)) dirs.add(d);
  const includedDirs = new Set();
  for (const p of includedPaths)
    for (let d = posix.dirname(p); d !== "."; d = posix.dirname(d)) includedDirs.add(d);
  const context = {
    denylist,
    known: (p) => allPaths.has(p) || dirs.has(p),
    included: (p) => includedPaths.has(p) || includedDirs.has(p),
    excludedPrefixes: [
      ...new Set(
        rules.filter((r) => r.prefix && !PUBLIC_CLASSES.has(r.class)).map((r) => r.prefix),
      ),
    ],
  };

  const files = [];
  const findings = [];
  const editProblems = [];
  const binaries = [];
  const textBytes = new Map();
  const transforms = { edits: 0, unlinked: 0, unlinkedFiles: 0, formatted: 0 };
  const texts = new Map();
  const changed = new Map();
  for (const entry of selected.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const bytes = read(entry.object);
    if (isBinary(bytes)) continue;
    const original = bytes.toString("utf8");
    const edited = applyEdits(entry.path, original, editList);
    editProblems.push(...edited.problems);
    transforms.edits += edited.applied;
    let text = edited.text;
    if (/\.mdx?$/.test(entry.path)) {
      const unlinked = unlinkExcluded(entry.path, text, context);
      text = unlinked.text;
      transforms.unlinked += unlinked.count;
      if (unlinked.count) transforms.unlinkedFiles++;
    }
    texts.set(entry.path, text);
    if (text !== original) changed.set(entry.path, text);
  }
  // Só o que a montagem mudou passa pelo formatador, antes do hash: uma troca
  // que muda a largura de uma tabela reprovaria `vp fmt --check` na cópia.
  if (format && changed.size)
    for (const [path, text] of format(changed)) {
      if (text === texts.get(path)) continue;
      texts.set(path, text);
      transforms.formatted++;
    }

  for (const entry of selected) {
    let bytes = read(entry.object);
    if (texts.has(entry.path)) {
      const text = texts.get(entry.path);
      if (text !== bytes.toString("utf8")) bytes = Buffer.from(text, "utf8");
      findings.push(...scanText(entry.path, text, context));
      textBytes.set(entry.path, bytes);
    } else {
      binaries.push({ path: entry.path, audited: auditedObjects.has(entry.object) });
    }
    files.push({
      path: entry.path,
      class: entry.class,
      bytes,
      sha256: sha256(bytes),
      size: bytes.length,
    });
  }
  for (const edit of editList)
    if (!includedPaths.has(edit.path))
      editProblems.push({ path: edit.path, reason: edit.reason, expected: edit.count, found: 0 });

  // As exceções de check-secrets.mjs valem para os arquivos que entram; uma
  // delas sem a ocorrência que descreve é obsoleta e bloqueia, como lá.
  const secrets = scanSecrets([...textBytes.keys()], (p) => textBytes.get(p) ?? null, {
    allow: secretAllow.filter((a) => includedPaths.has(a.path)),
  });
  for (const f of secrets.blocked) findings.push({ path: f.path, line: f.line, kind: "segredo" });

  // Link simbólico só entra apontando, por caminho relativo, para algo que
  // também entra. Absoluto, fora da raiz, quebrado ou para a custódia bloqueia.
  for (const link of symlinks) {
    const target = read(link.object).toString("utf8");
    link.target = target;
    findings.push(...scanText(link.path, target, { denylist }));
    const absolute = /^(?:[/\\]|[A-Za-z]:)/.test(target);
    const resolved = posix.normalize(
      posix.join(posix.dirname(link.path), target.replaceAll("\\", "/")),
    );
    if (absolute || resolved === ".." || resolved.startsWith("../") || !context.included(resolved))
      findings.push({ path: link.path, line: 1, kind: "link-simbolico-invalido" });
  }

  const manifestFiles = files.map(({ path, class: c, sha256: h, size }) => ({
    path,
    class: c,
    sha256: h,
    size,
  }));
  const manifest = {
    schema: 1,
    sourceSha: sha,
    files: manifestFiles,
    symlinks: symlinks
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map(({ path, target }) => ({ path, target })),
  };
  manifest.treeSha256 = sha256(
    Buffer.from(
      manifestFiles.map((f) => `${f.sha256}  ${f.path}\n`).join("") +
        manifest.symlinks.map((s) => `link  ${s.path} -> ${s.target}\n`).join(""),
    ),
  );

  findings.sort((a, b) =>
    a.path === b.path ? a.line - b.line || (a.kind < b.kind ? -1 : 1) : a.path < b.path ? -1 : 1,
  );
  const waived = {};
  for (const f of findings.filter((f) => findingKinds[f.kind] === "dispensa")) {
    waived[f.kind] ??= {};
    waived[f.kind][f.path] = (waived[f.kind][f.path] ?? 0) + 1;
  }
  // Sem a lista de nomes restritos (PR de fork, hook pre-push), os nomes não
  // são procurados: as exceções deles não têm como ser julgadas obsoletas.
  const { open, allowed, stale } = applyAllowlist(
    findings.filter((f) => findingKinds[f.kind] !== "dispensa"),
    denylist.length ? allow : allow.filter((a) => !denyKinds.has(a.kind)),
  );
  const staleAllowlist = [
    ...stale.map(({ path, kind, count }) => ({ path, kind, count })),
    ...secrets.stale.map(({ path, rule, count }) => ({ path, kind: "segredo", rule, count })),
  ];
  const byKind = {};
  for (const f of open) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  const blocking = open.filter((f) => ["bloqueia", "decisão"].includes(findingKinds[f.kind]));
  const report = {
    schema: 1,
    sourceSha: sha,
    treeSha256: manifest.treeSha256,
    status:
      unclassified.length || editProblems.length || blocking.length || staleAllowlist.length
        ? "bloqueada"
        : "pronta para revisão",
    counts,
    included: {
      files: files.length,
      symlinks: symlinks.length,
      bytes: files.reduce((s, f) => s + f.size, 0),
    },
    excluded: [...excluded]
      .map(([key, files]) => {
        const [rule, c, reason] = key.split("\0");
        return { rule, class: c, reason, files };
      })
      .sort((a, b) => (a.rule < b.rule ? -1 : 1)),
    unclassified,
    editProblems,
    denylist: { entries: denylist.length },
    transforms,
    findings: {
      byKind,
      allowed,
      staleAllowlist,
      waived,
      items: open,
    },
    binaries: {
      total: binaries.length,
      notAudited: binaries.filter((b) => !b.audited).map((b) => b.path),
    },
  };
  return { files, manifest, report };
}

const STAGE_CONFIG = [".oxfmtrc.json", ".editorconfig"];

/** Versão do oxfmt que um `bun.lock` fixa, ou `null` se ele não fixa nenhuma. */
export function lockedOxfmtVersion(lockText) {
  return /^\s*"oxfmt": \["oxfmt@([^"]+)"/m.exec(lockText)?.[1] ?? null;
}

/** Bloco `fmt` de um `vite.config.ts`, carregado como o Vite+ carrega. */
export async function loadFmtConfig(root) {
  process.env.VP_RESOLVING_CONFIG_METADATA ??= "1";
  const require = createRequire(join(root, "package.json"));
  const vite = await import(pathToFileURL(require.resolve("vite")).href);
  const loaded = await vite.loadConfigFromFile(
    { command: "build", mode: "production" },
    join(root, "vite.config.ts"),
    root,
    "silent",
  );
  return loaded?.config.fmt ?? {};
}

/**
 * Formatador da cópia: o oxfmt fixado no checkout (dependência do `vite-plus`
 * pelo `bun.lock`, que também vai na cópia), com o bloco `fmt` do
 * `vite.config.ts` como `.oxfmtrc.json` numa pasta temporária. Formata os
 * textos de uma vez; o que o `ignorePatterns` exclui e os tipos que o oxfmt
 * não lê voltam como estavam, como no `vp fmt` da cópia.
 *
 * Com `-c`, o oxfmt 0.68.0 não procura outra configuração e só lê arquivos de
 * ignore da pasta de trabalho, mas sobe pelas pastas acima atrás de
 * `.editorconfig`. A pasta temporária fica no perfil do usuário no Windows, e
 * um `~/.editorconfig` mudaria a cópia; o `root = true` encerra a busca nela.
 */
export function oxfmtFormatter(root, fmtConfig) {
  const vitePlus = createRequire(
    createRequire(join(root, "package.json")).resolve("vite-plus/package.json"),
  );
  const pkg = dirname(dirname(vitePlus.resolve("oxfmt")));
  const bin = join(pkg, "bin", "oxfmt");
  /** @param {Map<string, string>} texts */
  const format = (texts) => {
    for (const path of STAGE_CONFIG)
      if (texts.has(path))
        throw new Error(`oxfmt: ${path} colide com a configuração da formatação`);
    const stage = mkdtempSync(join(tmpdir(), "public-tree-fmt-"));
    try {
      writeFileSync(join(stage, ".oxfmtrc.json"), JSON.stringify(fmtConfig));
      writeFileSync(join(stage, ".editorconfig"), "root = true\n");
      for (const [path, text] of texts) {
        const target = join(stage, ...path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
      }
      const result = spawnSync(
        process.execPath,
        [bin, "--write", "--no-error-on-unmatched-pattern", "-c", ".oxfmtrc.json", ...texts.keys()],
        { cwd: stage, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26 },
      );
      if (result.status !== 0) throw new Error(`oxfmt: ${result.stderr || result.stdout}`);
      return new Map(
        [...texts.keys()].map((path) => [
          path,
          readFileSync(join(stage, ...path.split("/")), "utf8"),
        ]),
      );
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  };
  format.bin = bin;
  format.version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
  return format;
}

function writeOutput(out, { files, manifest, report }) {
  for (const file of files) {
    const target = join(out, "arvore", ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, "varredura.json"), `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--checkout" || flag === "--sem-gitleaks") {
      args[flag === "--checkout" ? "checkout" : "semGitleaks"] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!["--sha", "--out", "--denylist", "--edits", "--gitleaks"].includes(flag) || !value)
      return null;
    args[flag.slice(2)] = value;
    i++;
  }
  return args.sha && args.out ? args : null;
}

const usage = `uso: node scripts/public-copy/public-tree.mjs --sha <rev> --out <pasta fora do repositório> [--denylist <arquivo>] [--edits <arquivo>] [--gitleaks <binário>]
     node scripts/public-copy/public-tree.mjs --checkout --sha <rev> --out <pasta> [--denylist <arquivo>] [--gitleaks <binário> | --sem-gitleaks]

O Gitleaks ${GITLEAKS_VERSION} varre a cópia montada: --gitleaks, GITLEAKS_BIN ou
gitleaks no PATH. Roda só no repositório privado, salvo com --checkout: precisa do commit
da auditoria de 25/10 (${AUDIT_SHA.slice(0, 7)}), da lista de nomes restritos
(${DEFAULT_DENYLIST}) e das edições que trocam esses nomes
(${DEFAULT_RESTRICTED_EDITS}), em custódia, que não vão para o público.

Com --checkout, varre o repositório público: tudo o que está versionado no commit
é público, sem seleção nem edição; a lista de nomes restritos vem de --denylist
(no CI, do secret FNFE_PUBLIC_DENYLIST) e, sem ela, os nomes não são conferidos.

--sem-gitleaks pula o Gitleaks e avisa: as demais regras continuam. Serve ao hook
pre-push de uma máquina sem o Gitleaks fixado; o CI não usa.`;

/** No repositório público, tudo o que está versionado é público. */
export const checkoutClass = () => ({
  class: "entra",
  rule: "checkout",
  reason: "Repositório público: tudo o que está versionado é público",
});

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = repoRoot;
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(usage);
    process.exit(2);
  }
  const out = resolve(args.out);
  const rel = relative(root, out);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    console.error(`public-tree: ${out} está dentro do repositório; use uma pasta fora dele`);
    process.exit(2);
  }
  if (existsSync(out) && !statSync(out).isDirectory()) {
    console.error(`public-tree: ${out} existe e não é uma pasta`);
    process.exit(2);
  }
  if (existsSync(out) && readdirSync(out).length) {
    console.error(`public-tree: ${out} não está vazia`);
    process.exit(2);
  }
  const sha = execFileSync("git", ["rev-parse", "--verify", `${args.sha}^{commit}`], {
    cwd: root,
    windowsHide: true,
  })
    .toString()
    .trim();
  const checkout = args.checkout === true;
  if (checkout && args.edits) {
    console.error(`public-tree: --checkout não aplica edições\n\n${usage}`);
    process.exit(2);
  }
  let denylist = [];
  let restrictedEdits = [];
  const denylistFile = args.denylist
    ? resolve(root, args.denylist)
    : checkout
      ? null
      : resolve(root, DEFAULT_DENYLIST);
  if (denylistFile && !existsSync(denylistFile)) {
    console.error(`public-tree: lista de nomes restritos ausente em ${denylistFile}\n\n${usage}`);
    process.exit(2);
  }
  if (!checkout) {
    const editsFile = resolve(root, args.edits ?? DEFAULT_RESTRICTED_EDITS);
    if (!existsSync(editsFile)) {
      console.error(`public-tree: edições restritas ausentes em ${editsFile}\n\n${usage}`);
      process.exit(2);
    }
    const audit = spawnSync("git", ["cat-file", "-e", `${AUDIT_SHA}^{commit}`], {
      cwd: root,
      windowsHide: true,
    });
    if (audit.status !== 0) {
      console.error(`public-tree: commit da auditoria ${AUDIT_SHA} ausente\n\n${usage}`);
      process.exit(2);
    }
    try {
      restrictedEdits = loadRestrictedEdits(editsFile);
    } catch (error) {
      console.error(`public-tree: ${error.message}`);
      process.exit(2);
    }
  }
  try {
    if (denylistFile) denylist = loadDenylist(denylistFile);
  } catch (error) {
    console.error(`public-tree: ${error.message}`);
    process.exit(2);
  }
  if (checkout && !denylistFile)
    console.log(
      "::warning title=Nomes restritos não conferidos::Sem --denylist (secret FNFE_PUBLIC_DENYLIST); a varredura segue sem os nomes.",
    );
  const classifyPath = checkout ? checkoutClass : classify;
  const entries = listTree(root, sha);
  const selectedObjects = entries
    .filter((e) => PUBLIC_CLASSES.has(classifyPath(e.path)?.class) && e.mode !== "160000")
    .map((e) => e.object);
  const blobs = readBlobs(root, [...new Set(selectedObjects)]);
  const auditedObjects = checkout
    ? new Set()
    : new Set(listTree(root, AUDIT_SHA).map((e) => e.object));
  let format = null;
  if (!checkout) {
    // O formatador lê o vite.config.ts do checkout; ele precisa ser o que vai na cópia.
    const config = entries.find((e) => e.path === "vite.config.ts");
    if (!config || !readFileSync(join(root, "vite.config.ts")).equals(blobs.get(config.object))) {
      console.error(
        `public-tree: o vite.config.ts do checkout difere do de ${sha.slice(0, 7)}; o formatador da cópia lê o do checkout`,
      );
      process.exit(2);
    }
    format = oxfmtFormatter(root, await loadFmtConfig(root));
    // A cópia leva o bun.lock do commit; quem a formata precisa ser o oxfmt que ele fixa.
    const lock = entries.find((e) => e.path === "bun.lock");
    const locked =
      lock && lockedOxfmtVersion(readBlobs(root, [lock.object]).get(lock.object).toString());
    if (locked !== format.version) {
      console.error(
        `public-tree: o oxfmt instalado é ${format.version}, e o bun.lock de ${sha.slice(0, 7)} fixa ${locked ?? "nenhum"}; rode vp install --frozen-lockfile`,
      );
      process.exit(2);
    }
  }
  if (args.semGitleaks && args.gitleaks) {
    console.error(`public-tree: --sem-gitleaks não combina com --gitleaks

${usage}`);
    process.exit(2);
  }
  // Antes da montagem, para não montar uma cópia que não dá para varrer.
  const gitleaks = args.semGitleaks
    ? null
    : (args.gitleaks ?? process.env.GITLEAKS_BIN ?? "gitleaks");
  const leaksVersion =
    gitleaks && spawnSync(gitleaks, ["version"], { encoding: "utf8", windowsHide: true });
  const foundVersion = leaksVersion?.stdout?.trim().replace(/^v/, "");
  if (gitleaks && (leaksVersion.status !== 0 || foundVersion !== GITLEAKS_VERSION)) {
    console.error(
      `public-tree: Gitleaks ${GITLEAKS_VERSION} ausente (${foundVersion || "não encontrado"} em ${gitleaks})\n\n${usage}`,
    );
    process.exit(2);
  }
  const result = build({
    sha,
    entries,
    read: (object) => blobs.get(object),
    denylist,
    auditedObjects,
    editList: checkout ? [] : [...edits, ...restrictedEdits],
    format,
    classifyPath,
  });
  result.report.mode = checkout ? "checkout" : "cópia";
  if (format) result.report.formatter = { tool: "oxfmt", version: format.version };
  mkdirSync(out, { recursive: true });
  writeOutput(out, result);
  const tree = join(out, "arvore");
  if (gitleaks) {
    const leaksFile = join(out, "gitleaks.json");
    const scan = spawnSync(
      gitleaks,
      [
        "dir",
        tree,
        "--no-banner",
        "--redact",
        "--report-format",
        "json",
        "--report-path",
        leaksFile,
        "--exit-code",
        "0",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (scan.status !== 0 || !existsSync(leaksFile)) {
      console.error("public-tree: o Gitleaks não terminou a varredura da cópia");
      process.exit(2);
    }
    const leaks = parseGitleaks(JSON.parse(readFileSync(leaksFile, "utf8")), tree);
    // O relatório do Gitleaks traz trechos redigidos; a varredura guarda só caminho, linha e regra.
    rmSync(leaksFile, { force: true });
    applyGitleaks(result.report, leaks);
  } else {
    result.report.gitleaks = { version: GITLEAKS_VERSION, skipped: true };
    console.log(
      `::warning title=Gitleaks pulado::--sem-gitleaks: a varredura seguiu sem o Gitleaks ${GITLEAKS_VERSION}; o Public scan do CI o roda.`,
    );
  }
  writeFileSync(join(out, "varredura.json"), `${JSON.stringify(result.report, null, 2)}\n`);
  const { report } = result;
  console.log(
    `public-tree: ${sha}, ${report.included.files} arquivos e ${report.included.symlinks} links`,
  );
  console.log(`public-tree: manifesto ${report.treeSha256}`);
  console.log(
    `public-tree: ${report.transforms.edits} trocas por edição; ${report.transforms.unlinked} links para fora viraram texto em ${report.transforms.unlinkedFiles} arquivos`,
  );
  if (format)
    console.log(
      `public-tree: oxfmt ${format.version} reformatou ${report.transforms.formatted} dos arquivos alterados`,
    );
  for (const [kind, n] of Object.entries(report.findings.byKind).sort(([a], [b]) =>
    a < b ? -1 : 1,
  ))
    console.log(`  ${kind} (${findingKinds[kind]}): ${n}`);
  for (const p of report.unclassified) console.error(`  sem classificação: ${p}`);
  for (const p of report.findings.staleAllowlist)
    console.error(
      `  exceção obsoleta: ${p.path} ${p.kind}${p.rule ? ` ${p.rule}` : ""} (${p.count})`,
    );
  for (const p of report.editProblems)
    console.error(
      `  edição pendente: ${p.path}: ${p.reason} (esperado ${p.expected}, achado ${p.found})`,
    );
  console.log(`public-tree: ${report.status}; detalhes em ${join(out, "varredura.json")}`);
  process.exit(report.status === "bloqueada" ? 1 : 0);
}
