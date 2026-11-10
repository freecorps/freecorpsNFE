import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

/**
 * Domínios de platform/convex, de baixo para cima (docs/plataforma/arquitetura-backend.md,
 * "Camadas e organização dos arquivos"). Um módulo é o caminho relativo a platform/convex, sem
 * `.ts`; `*` casa um trecho do nome. Todo módulo cai em exatamente um domínio.
 */
const domains: [name: string, modules: string[]][] = [
  // Perfil do deployment, relógio, erros públicos e endereços.
  [
    "platform",
    [
      "environment",
      "buildInfo",
      "lib/clock",
      "lib/convexDeployment",
      "lib/environmentAccess",
      "lib/fiscalCaptureRelease",
      "lib/fiscalProof",
      "lib/issuanceProduction",
      "lib/publicAddress",
      "lib/publicErrors",
    ],
  ],
  // Auditoria operacional, registros de acesso e sua guarda.
  [
    "audit",
    [
      "accessRecords",
      "telemetryRetention",
      "lib/accessSchema",
      "lib/apiUsageRetention",
      "lib/observabilitySchema",
      "lib/operationSources",
      "lib/operationalAudit",
      "lib/operationalRetention",
      "lib/retentionClasses",
    ],
  ],
  // Estado de custódia: organização quente ou arquivada, origem e linha atual de um registro.
  [
    "custody",
    [
      "lib/coldArchiveCore",
      "lib/coldArchiveCurrent",
      "lib/coldArchiveOrigin",
      "lib/coldArchiveSchema",
      "lib/coldObjects",
      "lib/storageHolders",
    ],
  ],
  [
    "organizations",
    [
      "access",
      "account",
      "auth",
      "auth.config",
      "invitations",
      "mail",
      "organizations",
      "privacyMail*",
      "provision",
      "termsOfUse*",
      "lib/accountMail",
      "lib/authRequest",
      "lib/organization*",
      "lib/privacy*",
      "lib/termsOfUse*",
    ],
  ],
  ["capacity", ["capacity", "lib/capacity*", "lib/purge"]],
  [
    "usage",
    [
      "billing*",
      "plans",
      "usage*",
      "lib/annualTerms",
      "lib/billing*",
      "lib/plan*",
      "lib/quotaPeriod",
      "lib/usage*",
    ],
  ],
  ["companies", ["companies", "consoleCompany", "onboarding", "lib/company*"]],
  ["projects", ["keys", "projects", "lib/apiKeyCrypto", "lib/project*"]],
  ["certificates", ["certificate*", "lib/certificate*"]],
  [
    "operations",
    [
      "operationRest",
      "operationWorker",
      "operations",
      "lib/operationAccess",
      "lib/operationCore",
      "lib/operationValues",
    ],
  ],
  ["webhooks", ["webhook*", "lib/webhook*"]],
  // Importação e documentos formam um grupo: as leituras REST das duas passam pela mesma action
  // Node (`documentContentNode`), e o processamento da importação publica as versões.
  [
    "documents",
    [
      "contentMigration*",
      "contentRead*",
      "danfeWorker",
      "document*",
      "import*",
      "refusalReprocess",
      "unclassifiedMigration",
      "lib/danfeValues",
      "lib/document*",
      "lib/import*",
      "lib/originalStore",
      "lib/unclassifiedArtifacts",
    ],
  ],
  ["capture", ["capture*", "lib/capture*", "lib/siteCapture"]],
  [
    "issuance",
    [
      "issuance*",
      "nfseProfiles",
      "lib/issuanceCore",
      "lib/issuanceDps",
      "lib/issuanceGate",
      "lib/issuanceRules",
      "lib/issuanceSchema",
      "lib/issuanceValues",
      "lib/nfseProfile*",
    ],
  ],
  ["stripe", ["stripe*", "lib/stripe*"]],
  ["references", ["reference*", "lib/reference*"]],
  ["registry", ["registry*", "lib/registry*"]],
  ["exports", ["assistedExport", "export*", "lib/export*"]],
  // Arquivo frio, guarda fiscal e reidratação.
  [
    "archive",
    [
      "archiveNotice",
      "backupInventory",
      "coldArchive*",
      "coldTier*",
      "fiscalGuard",
      "lib/coldArchiveIdMap",
      "lib/coldArchiveReferences",
      "lib/coldArchiveRehydration",
    ],
  ],
  // Encerramento de organização e recuperação da guarda, que atravessam os domínios acima.
  [
    "closure",
    [
      "organizationClosure",
      "retentionRecovery",
      "sandboxClosure",
      "lib/closureSchema",
      "lib/sandboxClosureSchema",
    ],
  ],
  ["monitoring", ["observability", "lib/operationalMetrics"]],
  // Transporte REST comum: telemetria, consumo e admissão de cada pedido.
  ["rest", ["capabilityRest", "rest", "lib/externalHttp", "lib/restAdmission", "lib/restLimits"]],
  ["console", ["consoleHome", "deployment", "lib/consoleTasks"]],
  // Provas locais e de validação.
  ["proofs", ["testing/*", "validation", "xml"]],
  // Composição do app: schema, rotas HTTP, crons e componentes.
  ["app", ["convex.config", "crons", "http", "schema"]],
];

/**
 * Arestas para um domínio superior, com o motivo. A chave é `origem -> destino`; uma exceção que
 * deixou de existir também reprova, para a lista não crescer calada.
 */
const upward: Record<string, string> = {
  "lib/planCore -> lib/captureAttention":
    "a troca de plano retoma as capturas que o limite de uso pausou",
  "lib/planCore -> lib/issuanceGate":
    "as ações de operador sobre o termo do plano conferem login e motivo como o gate de emissão (ADR 0004, §8)",
  "lib/operationCore -> lib/captureAttention":
    "uma operação de captura pausada vira atenção do stream; captureAttention fica fora de captureCore para isso",
  "lib/operationCore -> lib/siteCapture":
    "a continuação de uma captura do site herda a liberação da empresa como origem (ADR 0007, §4)",
  "lib/issuanceCore -> lib/stripeAccess":
    "a conexão Stripe é origem de operações de emissão sob a concessão do projeto (ADR 0006)",
  "captureWorker -> testing/captureProof":
    "em desenvolvimento com o fisco desligado, o worker lê o lote sintético da prova local",
};

/**
 * Módulos do topo que `lib/` pode importar: estão na raiz pelo papel no Convex, não por serem
 * funções de domínio.
 */
const topForLib: Record<string, string> = {
  auth: "o componente Better Auth (`authComponent`) fica onde o Convex registra as rotas de sessão",
  buildInfo: "o SHA publicado, que o empacotamento regrava no lugar",
  environment: "o perfil do deployment, lido por toda camada",
  schema: "a reidratação valida as linhas contra o schema das tabelas arquivadas",
};

/** Módulos que referenciam um `*Rest` além de `http.ts`, com o motivo. */
const restCallers: Record<string, string> = {
  documentContentNode:
    "metade Node das leituras REST de documentos e importação: a query do `*Rest` autentica a chave e monta o plano, a action resolve as partes no storage",
  "testing/usageProof": "a prova de leitura limitada chama o mesmo dispatch da rota de documentos",
};

type Edge = { from: string; to: string; kind: "value" | "type" | "internal"; line: number };

/**
 * Lidos da pasta, não por `import.meta.glob` (tests/helpers/convex-sources.ts): o glob fica no
 * cache de transformação do Vitest, que não vê um módulo novo, justamente o que precisa de domínio.
 */
const root = fileURLToPath(new URL(".", import.meta.url));
const modules = new Map(
  readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((path) => path.replaceAll("\\", "/"))
    .filter(
      (path) =>
        path.endsWith(".ts") &&
        !path.endsWith(".test.ts") &&
        !path.endsWith(".d.ts") &&
        !path.startsWith("_generated/"),
    )
    .map((path) => [path.slice(0, -3), readFileSync(root + path, "utf8")] as const),
);
const known = new Set(modules.keys());

/**
 * Imports relativos (inclusive `export ... from` e `import()`) e referências `internal.*` e
 * `api.*` de um módulo. `import type` vira aresta `type`, que não conta para as camadas.
 */
function edgesOf(from: string, text: string): Edge[] {
  const source = ts.createSourceFile(`${from}.ts`, text, ts.ScriptTarget.Latest, true);
  const found: Edge[] = [];
  const line = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const add = (specifier: string, kind: Edge["kind"], node: ts.Node) => {
    if (!specifier.startsWith(".")) return;
    const to = posix.normalize(posix.join(posix.dirname(from), specifier)).replace(/\.ts$/, "");
    found.push({ from, to, kind, line: line(node) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      add(node.moduleSpecifier.text, node.importClause?.isTypeOnly ? "type" : "value", node);
    else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text, node.isTypeOnly ? "type" : "value", node);
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text, "value", node);
    else if (ts.isPropertyAccessExpression(node) && !ts.isPropertyAccessExpression(node.parent)) {
      const path: string[] = [];
      let target: ts.Expression = node;
      while (ts.isPropertyAccessExpression(target)) {
        path.unshift(target.name.text);
        target = target.expression;
      }
      if (ts.isIdentifier(target) && (target.text === "internal" || target.text === "api"))
        for (let size = path.length - 1; size > 0; size--) {
          const to = path.slice(0, size).join("/");
          if (known.has(to)) {
            found.push({ from, to, kind: "internal", line: line(node) });
            break;
          }
        }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const edges = [...modules].flatMap(([name, text]) => edgesOf(name, text));
const local = edges.filter(({ from, to }) => from !== to && known.has(to));

const matches = (name: string, pattern: string) => posix.matchesGlob(name, pattern);
const domainsOf = (name: string) =>
  domains
    .map(([domain, patterns], rank) => ({ domain, rank, patterns }))
    .filter(({ patterns }) => patterns.some((pattern) => matches(name, pattern)));
const rankOf = new Map(
  [...known].map((name) => [name, domainsOf(name)[0]] as const).filter(([, d]) => d),
);

/**
 * Módulo com banco: importa `_generated/server` (os tipos de ctx bastam) ou importa um valor de
 * outro módulo com banco.
 */
const database = new Set(
  edges.filter(({ to }) => to === "_generated/server").map(({ from }) => from),
);
for (let grew = true; grew;) {
  grew = false;
  for (const { from, to, kind } of local)
    if (kind === "value" && database.has(to) && !database.has(from)) {
      database.add(from);
      grew = true;
    }
}

const isLib = (name: string) => name.startsWith("lib/");
const contract = (name: string) => /^lib\/\w+(Schema|Values|Rules)$/.test(name);
const where = ({ from, line }: Edge) => `${from}.ts:${line}`;

describe("camadas de platform/convex", () => {
  it("todo módulo pertence a exatamente um domínio", () => {
    const wrong = [...known]
      .map((name) => [name, domainsOf(name).map(({ domain }) => domain)] as const)
      .filter(([, owners]) => owners.length !== 1)
      .map(([name, owners]) => `${name}: ${owners.length ? owners.join(", ") : "sem domínio"}`);
    expect(wrong, "classifique o módulo em `domains`, em um domínio só").toEqual([]);
    const unused = domains.flatMap(([domain, patterns]) =>
      patterns
        .filter((pattern) => ![...known].some((name) => matches(name, pattern)))
        .map((pattern) => `${domain}: ${pattern}`),
    );
    expect(unused, "padrão de `domains` que não casa nenhum módulo").toEqual([]);
  });

  it("nenhum domínio depende de um domínio acima dele", () => {
    // `internal.*` liga funções e conta sempre. Um import conta entre módulos da mesma
    // altura (lib com lib, topo com topo): o topo pode usar qualquer helper de lib, e um
    // módulo sem banco é importável de qualquer domínio.
    const ordered = local.filter(
      ({ from, to, kind }) =>
        kind === "internal" || (kind === "value" && database.has(to) && isLib(from) === isLib(to)),
    );
    const found: string[] = [];
    const used = new Set<string>();
    for (const edge of ordered) {
      const from = rankOf.get(edge.from);
      const to = rankOf.get(edge.to);
      if (!from || !to || to.rank <= from.rank) continue;
      const key = `${edge.from} -> ${edge.to}`;
      if (key in upward) used.add(key);
      else found.push(`${where(edge)} -> ${edge.to} (${from.domain} -> ${to.domain})`);
    }
    expect(
      [...new Set(found)],
      "mova a regra para o domínio de baixo, ou registre a exceção em `upward` com o motivo",
    ).toEqual([]);
    expect(
      Object.keys(upward).filter((key) => !used.has(key)),
      "exceção de `upward` que não existe mais",
    ).toEqual([]);
  });

  it("lib/ só importa do topo os módulos combinados", () => {
    const imports = local.filter(
      ({ from, to, kind }) => kind === "value" && isLib(from) && !isLib(to),
    );
    expect(
      imports.filter(({ to }) => !(to in topForLib)).map((edge) => `${where(edge)} -> ${edge.to}`),
      "leve o helper para lib/, ou registre o módulo em `topForLib` com o motivo",
    ).toEqual([]);
    expect(
      Object.keys(topForLib).filter((name) => !imports.some(({ to }) => to === name)),
      "módulo de `topForLib` que lib/ não importa mais",
    ).toEqual([]);
  });

  it("só http.ts referencia os módulos *Rest", () => {
    const callers = local.filter(
      ({ from, to, kind }) => kind !== "type" && /(^|\/)\w+Rest$/.test(to) && from !== "http",
    );
    expect(
      callers
        .filter(({ from }) => !(from in restCallers))
        .map((edge) => `${where(edge)} -> ${edge.to}`),
      "a regra compartilhada vai para lib/ ou para o módulo do domínio, não para o `*Rest`",
    ).toEqual([]);
    expect(
      Object.keys(restCallers).filter((name) => !callers.some(({ from }) => from === name)),
      "módulo de `restCallers` que não referencia mais um `*Rest`",
    ).toEqual([]);
  });

  it("lib/*Schema, *Values e *Rules não tocam o banco", () => {
    const leaks = edges
      .filter(
        ({ from, to, kind }) =>
          contract(from) && (to === "_generated/server" || (kind === "value" && database.has(to))),
      )
      .map((edge) => `${where(edge)} -> ${edge.to}`);
    expect(
      leaks,
      "validators e regras puras ficam sem ctx; o acesso ao banco vai para outro módulo",
    ).toEqual([]);
  });
});
