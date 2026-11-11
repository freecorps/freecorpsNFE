import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { convexTest } from "convex-test";
import { httpRouter, type HttpRouter, type PublicHttpAction } from "convex/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import schema from "./schema";
import http from "./http";
import { httpAction } from "./_generated/server";
import { refusal } from "./lib/publicErrors";
import { register } from "../test-setup";
import { usePlatformEnvironment } from "../../tests/helpers/platform";
import { modulePath, modules } from "../../tests/helpers/convex-modules";

// Varredura da superfície HTTP do Convex da plataforma: toda rota de
// `http.getRoutes()`, inclusive as do componente de auth, precisa de uma
// classe de credencial abaixo. Cada uma é chamada sem credencial num banco
// vazio e precisa recusar com o status e a forma declarados, sem escrever nada.
// Os testes de cada domínio continuam provando a chamada com credencial.
const SITE = "http://localhost:5199";
const CONVEX_SITE = "http://127.0.0.1:3257";
const FOREIGN = "https://outra-origem.invalid";
usePlatformEnvironment({
  siteUrl: SITE,
  convexSiteUrl: CONVEX_SITE,
  secret: "synthetic-secret-used-only-in-http-surface",
});
beforeEach(() => {
  // Com a cobrança configurada, o webhook dela chega à conferência da assinatura.
  vi.stubEnv("STRIPE_BILLING_SECRET_KEY", "rk_test_synthetic0000");
  vi.stubEnv("STRIPE_BILLING_WEBHOOK_SECRET", "whsec_synthetic_http_surface");
});

/**
 * `chave`: API key (`Authorization: Bearer fnfe_…`); `ticket`: token curto emitido depois da
 * checagem (downloads, upload); `preflight`: OPTIONS de CORS de outra rota; `assinatura`:
 * webhook autenticado pela assinatura do remetente; `público`: responde a qualquer um, sem dado
 * de organização; `sessão`: rotas do Better Auth, autenticadas pelo cookie de sessão.
 */
type Credential = "chave" | "ticket" | "preflight" | "assinatura" | "público" | "sessão";
type Expected = {
  credential: Credential;
  /** Caminho chamado; uma rota de prefixo usa o prefixo seguido de `x` quando não há outro. */
  probe?: string;
  headers?: Record<string, string>;
  status: number;
  /** Corpo exato, sem o `requestId`, que é conferido à parte contra o `X-Request-Id`. */
  body?: unknown;
  /** Cabeçalhos exatos da resposta; `null` exige a ausência. */
  responseHeaders?: Record<string, string | null>;
};

/** Marcador `freecorps-access:` que o handler de cada classe carrega (docs/desenvolvimento/lint.md). */
const expectedMarker: Record<Exclude<Credential, "preflight">, string | null> = {
  chave: null,
  sessão: null,
  ticket: "ticket",
  assinatura: "assinatura",
  público: "sem-tenant",
};

const key = (): Expected => ({
  credential: "chave",
  status: 401,
  body: { error: refusal("INVALID_API_KEY").error },
});
const ticket = (code: string, notFound?: string): Expected => ({
  credential: "ticket",
  status: refusal(code).status,
  body: {
    error: { ...refusal(code).error, ...(notFound ? { message: notFound } : {}) },
  },
});
// Uma origem estranha não recebe permissão de CORS.
const preflight = (status: number): Expected => ({
  credential: "preflight",
  headers: { Origin: FOREIGN, "Access-Control-Request-Method": "POST" },
  status,
  body: "",
  responseHeaders: { "Access-Control-Allow-Origin": null },
});

// Recusa do Better Auth a uma rota que exige sessão.
const unauthorized = { message: "Unauthorized", code: "UNAUTHORIZED" };

const routes: Record<string, Expected> = {
  "GET /v1/capabilities": key(),
  "GET /v1/companies": key(),
  "GET /v1/companies/*": key(),
  "GET /v1/connections/nfe": key(),
  "POST /v1/connections/nfe": key(),
  "GET /v1/document-artifacts": key(),
  "GET /v1/document-artifacts/*": key(),
  "GET /v1/documents": key(),
  "GET /v1/documents/*": key(),
  "POST /v1/documents/*": key(),
  "POST /v1/export-parts/*": key(),
  "POST /v1/exports": key(),
  "GET /v1/exports/*": key(),
  "POST /v1/exports/*": key(),
  "POST /v1/imports": key(),
  "GET /v1/imports/*": key(),
  "POST /v1/imports/*": key(),
  "GET /v1/issuances": key(),
  "POST /v1/issuances": key(),
  "GET /v1/issuances/*": key(),
  "POST /v1/issuances/*": key(),
  "GET /v1/operations/*": key(),
  "POST /v1/operations/*": key(),
  "GET /v1/references/*": key(),
  "GET /v1/registry/cnpj/*": key(),
  "POST /v1/registry/cnpj/*": key(),
  "GET /v1/webhook-deliveries": key(),
  "POST /v1/webhook-deliveries/*": key(),
  "GET /v1/webhook-endpoints": key(),
  "POST /v1/webhook-endpoints": key(),
  "GET /v1/webhook-endpoints/*": key(),
  "PATCH /v1/webhook-endpoints/*": key(),
  "POST /v1/webhook-endpoints/*": key(),

  "GET /v1/document-download": ticket("NOT_FOUND", "Documento não encontrado."),
  "GET /v1/export-download": ticket("NOT_FOUND", "Exportação não encontrada."),
  "POST /v1/import-upload": ticket("UPLOAD_EXPIRED"),
  "OPTIONS /v1/document-download": preflight(403),
  "OPTIONS /v1/export-download": preflight(403),
  "OPTIONS /v1/import-upload": preflight(204),
  "OPTIONS /api/auth/*": { ...preflight(204), probe: "/api/auth/get-session" },

  "POST /v1/billing/stripe/events": {
    credential: "assinatura",
    status: 400,
    body: { code: "SIGNATURE_MISSING" },
  },
  // Num banco vazio não há conexão: a recusa vem antes da assinatura, que
  // stripe.test.ts prova com uma conexão cadastrada.
  "POST /v1/stripe/connections/*": {
    credential: "assinatura",
    probe: "/v1/stripe/connections/x/events",
    status: 404,
    body: { code: "NOT_FOUND" },
  },

  "GET /health": {
    credential: "público",
    status: 200,
    body: {
      status: "ok",
      appEnv: "development",
      productEnv: "sandbox",
      fiscalEnv: "disabled",
      issuanceEnv: "disabled",
      captureFiscal: "disabled",
      sha: null,
    },
  },

  "GET /api/auth/*": {
    credential: "sessão",
    probe: "/api/auth/list-sessions",
    status: 401,
    body: unauthorized,
  },
  "POST /api/auth/*": {
    credential: "sessão",
    probe: "/api/auth/revoke-sessions",
    headers: { Origin: SITE },
    status: 401,
    body: unauthorized,
  },
  // Descoberta OIDC do provedor de sessão: redireciona para a do Better Auth.
  "GET /.well-known/openid-configuration": {
    credential: "sessão",
    status: 302,
    body: "",
    responseHeaders: {
      Location: `${CONVEX_SITE}/api/auth/convex/.well-known/openid-configuration`,
    },
  },
};

const httpModule = Object.keys(modules).find((path) => modulePath(path) === "http")!;
const routeKey = (method: string, path: string) => `${method} ${path}`;

/**
 * Marcador do handler: o comentário acima do export que é o handler, num dos módulos que http.ts
 * importa, ou o da rota inline em http.ts. O handler de um componente não tem marcador.
 */
async function handlerMarker(handler: PublicHttpAction, path: string) {
  const marker = (source: string, anchor: string) =>
    new RegExp(`// freecorps-access: (\\S+) — [^\\n]*\\n${anchor}`).exec(source)?.[1] ?? null;
  const routerSource = readModule(httpModule);
  for (const [, imported] of routerSource.matchAll(/from "\.\/([^"]+)"/g)) {
    const file = Object.keys(modules).find((path) => modulePath(path) === imported);
    if (!file) continue;
    for (const [name, value] of Object.entries((await modules[file]!()) as Record<string, unknown>))
      if (value === handler) return marker(readModule(file), `export const ${name}\\b`);
  }
  return marker(routerSource, `http\\.route\\(\\{\\s*path: "${path}"`);
}
function readModule(file: string) {
  return readFileSync(new URL(`./${modulePath(file)}.ts`, import.meta.url), "utf8");
}

/**
 * O que sobrou no banco vazio depois da chamada: tabelas do schema, arquivos e agendamentos. As
 * tabelas dos componentes (auth, limites, filas) ficam fora.
 */
async function writes(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const touched: string[] = [];
    for (const table of Object.keys(schema.tables))
      if (await ctx.db.query(table as keyof typeof schema.tables).first()) touched.push(table);
    for (const table of ["_storage", "_scheduled_functions"] as const)
      if (await ctx.db.system.query(table).first()) touched.push(table);
    return touched;
  });
}

async function probe(router: HttpRouter, path: string, method: string, expected: Expected) {
  const problems: string[] = [];
  const t = convexTest(schema, { ...modules, [httpModule]: async () => ({ default: router }) });
  register(t);
  const body = method === "POST" || method === "PATCH" ? "{}" : undefined;
  const target = expected.probe ?? (path.endsWith("*") ? `${path.slice(0, -1)}x` : path);
  // A sonda precisa cair na rota conferida, não numa vizinha de prefixo mais longo.
  if (router.lookup(target, method as "GET")?.[2] !== path)
    return [`a sonda ${target} não cai nesta rota`];
  let response: Response;
  try {
    response = await t.fetch(target, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...expected.headers },
      ...(body ? { body } : {}),
    });
  } catch (error) {
    return [`lançou ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`];
  }
  if (response.status !== expected.status)
    problems.push(`status ${response.status}, esperado ${expected.status}`);
  const text = await response.text();
  if (expected.body !== undefined) {
    let actual: unknown = text;
    if (typeof expected.body !== "string") {
      try {
        const { requestId, ...rest } = JSON.parse(text) as Record<string, unknown>;
        if (requestId !== (response.headers.get("X-Request-Id") ?? undefined))
          problems.push("requestId diferente do X-Request-Id");
        actual = rest;
      } catch {
        actual = text;
      }
    }
    if (!isDeepStrictEqual(actual, expected.body)) problems.push(`corpo ${text.slice(0, 160)}`);
  }
  for (const [name, value] of Object.entries(expected.responseHeaders ?? {}))
    if (response.headers.get(name) !== value)
      problems.push(`cabeçalho ${name}: ${response.headers.get(name)}`);
  for (const table of await writes(t)) problems.push(`escreveu em ${table}`);
  return problems;
}

/** Confere cada rota do roteador contra a tabela e devolve as divergências. */
async function audit(router: HttpRouter, table: Record<string, Expected>) {
  const failures: string[] = [];
  const registered = router.getRoutes();
  const keys = new Set(registered.map(([path, method]) => routeKey(method, path)));
  for (const name of Object.keys(table))
    if (!keys.has(name)) failures.push(`${name}: classe de rota que não existe`);
  for (const [path, method, handler] of registered) {
    const name = routeKey(method, path);
    const expected = table[name];
    if (!expected) {
      failures.push(`${name}: rota sem classe de credencial`);
      continue;
    }
    // O preflight segue a rota que ele abre; os outros, a própria classe.
    const owner =
      expected.credential === "preflight"
        ? registered.find(([p, m]) => p === path && m !== "OPTIONS")
        : undefined;
    const credential =
      expected.credential === "preflight"
        ? owner && table[routeKey(owner[1], owner[0])]?.credential
        : expected.credential;
    if (!credential || credential === "preflight")
      failures.push(`${name}: preflight sem rota a que pertença`);
    else {
      const marker = await handlerMarker(handler, path);
      if (marker !== expectedMarker[credential])
        failures.push(`${name}: marcador ${marker ?? "ausente"}, classe ${expected.credential}`);
    }
    for (const problem of await probe(router, path, method, expected))
      failures.push(`${name}: ${problem}`);
  }
  return failures;
}

it("gives every HTTP route a credential class and refuses each one without credential", async () => {
  // Âncoras: se a enumeração parar de enxergar o roteador ou o auth, o teste falha.
  const keys = http.getRoutes().map(([path, method]) => routeKey(method, path));
  expect(keys).toEqual(
    expect.arrayContaining(["GET /health", "POST /api/auth/*", "GET /v1/documents"]),
  );
  expect(Object.values(routes).filter((route) => route.credential === "chave")).toHaveLength(33);
  expect(await audit(http, routes)).toEqual([]);
});

/** Um roteador com algumas rotas reais e as rotas de teste. */
function routerWith(names: string[], extra: (router: HttpRouter) => void) {
  const router = httpRouter();
  for (const [path, method, handler] of http.getRoutes())
    if (names.includes(routeKey(method, path)))
      router.route(
        path.endsWith("*")
          ? { pathPrefix: path.slice(0, -1), method, handler }
          : { path, method, handler },
      );
  extra(router);
  return router;
}
const subset = (names: string[], extra: Record<string, Expected> = {}) => ({
  ...Object.fromEntries(names.map((name) => [name, routes[name]!])),
  ...extra,
});
const real = ["GET /v1/capabilities", "GET /v1/document-download", "GET /health"];

it("fails a new route that answers 200 without credential", async () => {
  const router = routerWith(real, (r) =>
    r.route({
      path: "/v1/leak",
      method: "GET",
      handler: httpAction(async () => Response.json({ ok: true })),
    }),
  );
  expect(await audit(router, subset(real))).toEqual([
    "GET /v1/leak: rota sem classe de credencial",
  ]);
  // Declarada como rota de chave, ela continua reprovando pela resposta.
  expect(await audit(router, subset(real, { "GET /v1/leak": key() }))).toEqual([
    "GET /v1/leak: status 200, esperado 401",
    'GET /v1/leak: corpo {"ok":true}',
  ]);
});

it("fails a refusal that writes, a stale class and a class that contradicts the marker", async () => {
  const router = routerWith(real, (r) =>
    r.route({
      path: "/v1/leak",
      method: "GET",
      handler: httpAction(async (ctx) => {
        await ctx.storage.store(new Blob(["x"]));
        return Response.json({ error: refusal("INVALID_API_KEY").error }, { status: 401 });
      }),
    }),
  );
  expect(
    await audit(
      router,
      subset(real, {
        "GET /v1/leak": key(),
        "GET /v1/gone": key(),
        "GET /v1/document-download": {
          ...routes["GET /v1/document-download"]!,
          credential: "chave",
        },
      }),
    ),
  ).toEqual([
    "GET /v1/gone: classe de rota que não existe",
    "GET /v1/document-download: marcador ticket, classe chave",
    "GET /v1/leak: escreveu em _storage",
  ]);
});
