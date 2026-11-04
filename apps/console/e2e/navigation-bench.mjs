// Benchmark de navegação do console (apps/console), no navegador, contra um backend Convex local.
//
// Mede, com Playwright e Chromium, quanto tempo cada navegação do console leva do gesto da pessoa
// (clique, troca de seleção, "voltar") até a página ficar pronta, e o que aconteceu no caminho:
// se a lateral foi remontada, quantos bytes de JS e pedidos saíram, quantas assinaturas Convex
// foram abertas e fechadas e se algum carregamento de tela cheia (sem a lateral) apareceu.
// O roteiro depende só do que a pessoa vê: URLs, papéis ARIA, nomes acessíveis, títulos e textos.
//
// "Pronta" quer dizer, ao mesmo tempo, por 100 ms seguidos (o instante registrado é o início
// desse intervalo): a URL casa com o destino; o título h1 esperado está visível dentro de `main`
// (ou do documento, sem `main`); e nenhum indicador de carregamento resta na página, ou seja,
// nenhum elemento com aria-busy="true", role="progressbar" ou role="status" com texto
// "Carregando…/Confirmando…/Verificando…/Conferindo…/Buscando…", nem texto visível desse tipo.
// Isso vale com o carregamento fora ou dentro do shell.
//
// Uso (a partir de um worktree da plataforma, com o backend do checkout medido rodando por
// `bun run dev` nesse checkout):
//
//   node apps/console/e2e/navigation-bench.mjs
//   BENCH_ROOT=/caminho/do/outro/worktree node apps/console/e2e/navigation-bench.mjs
//   node apps/console/e2e/navigation-bench.mjs --report a.json [b.json]   (tabela markdown)
//
// Por padrão o script compila o console de BENCH_ROOT em modo produção (vp build, com o
// VITE_CONVEX_URL apontando para um proxy de atraso), serve o build como o Worker serve
// (estáticos + /api/auth encaminhado ao Convex local) e mede atrás de proxies TCP que atrasam
// cada sentido em RTT/2: estáticos, auth, HTTP e WebSocket do Convex. Na primeira execução contra
// um banco, cria pela interface e pelas funções públicas uma conta sintética, uma organização,
// duas empresas e alguns XMLs NF-e sintéticos derivados de public/examples/nfe-demonstracao.xml,
// e guarda o que criou em <BENCH_ROOT>/.browser-results/navigation-bench/fixture.json.
//
// Variáveis de ambiente:
//   BENCH_ROOT       checkout medido (padrão: este). Precisa de worktree da plataforma com o
//                    backend local rodando; o build e o fixture ficam em .browser-results/ dele.
//   BENCH_MODE       "build" (padrão) ou "external" (usa BENCH_BASE_URL, sem build e sem proxies;
//                    serve para um `vp dev` já aberto, mas aí não há latência adicionada).
//   BENCH_BASE_URL   URL do console no modo external, por exemplo http://localhost:5175.
//   BENCH_PROFILES   perfis separados por vírgula: RTT em ms, com sufixo xN para CPU N vezes mais
//                    lenta (CDP). Padrão "0,120". Exemplo: "0,120,120x4".
//   BENCH_RUNS       execuções medidas por perfil (padrão 7); BENCH_WARMUP descartadas (padrão 1).
//   BENCH_SCENARIOS  subconjunto de: cold,tour,hover,companies,documents,brand (padrão: todos).
//   BENCH_OUTPUT     arquivo JSON do resultado (padrão
//                    <BENCH_ROOT>/.browser-results/navigation-bench/result.json).
//   BENCH_NAV_LABEL  nome acessível da navegação da lateral (padrão "Navegação da organização").
//   BENCH_HEADED=1   abre o Chromium visível.
//   BENCH_TRACE=1    imprime, por navegação, a cascata desde o gesto: cada assinatura aberta
//                    (+função), cada resposta recebida (=função) e cada JS baixado, em ms.
//
// O auth local limita get-session e convex/token a 30 pedidos por minuto (janela fixa). Antes de
// cada contexto novo o script espera a janela seguinte se a atual estiver perto do limite; essa
// espera fica fora das medidas. Respostas 429 são contadas no resultado.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem, release, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { startDelayProxy } from "./latency-proxy.mjs";
import { startConsoleServer } from "./console-static-server.mjs";
import { termsAcceptance } from "../../../scripts/lib/organization-terms.mjs";

const selfRoot = fileURLToPath(new URL("../../..", import.meta.url));
const round = (value) => Math.round(value * 10) / 10;

// ---------------------------------------------------------------------------------------------
// Relatório: `--report a.json [b.json]` imprime a tabela; com dois arquivos, a diferença.
// ---------------------------------------------------------------------------------------------
function markdownReport(a, b) {
  const lines = [];
  for (const profile of a.profiles) {
    const other = b?.profiles.find((candidate) => candidate.name === profile.name);
    lines.push(`\n### Perfil ${profile.name}\n`);
    lines.push(
      b
        ? "| Navegação | A mediana | A p90 | B mediana | B p90 | Δ mediana | remonta lateral A/B | tela cheia A/B | assinaturas + A/B |"
        : "| Navegação (ok/n) | mediana (ms) | p90 (ms) | remonta lateral | tela cheia | assinaturas +/− | reassinadas | JS (KB) | pedidos |",
    );
    lines.push(
      b
        ? "|---|---:|---:|---:|---:|---:|---|---|---|"
        : "|---|---:|---:|---|---|---|---:|---:|---:|",
    );
    for (const [step, s] of Object.entries(profile.summary)) {
      const o = other?.summary[step];
      const n = `${s.n - s.failures}/${s.n}`;
      if (b)
        lines.push(
          `| ${step} | ${s.medianMs ?? "–"} | ${s.p90Ms ?? "–"} | ${o?.medianMs ?? "–"} | ${o?.p90Ms ?? "–"} | ${o && s.medianMs !== null && o.medianMs !== null ? round(o.medianMs - s.medianMs) : "–"} | ${s.navRemounts}/${o?.navRemounts ?? "–"} (de ${s.navTracked}) | ${s.fullScreenLoaders}/${o?.fullScreenLoaders ?? "–"} | ${s.medianSubscriptionAdds ?? "–"}/${o?.medianSubscriptionAdds ?? "–"} |`,
        );
      else
        lines.push(
          `| ${step} (${n}) | ${s.medianMs ?? "–"} | ${s.p90Ms ?? "–"} | ${s.navTracked ? `${s.navRemounts}/${s.navTracked}` : "n/a"} | ${s.fullScreenLoaders}/${s.n} | ${s.medianSubscriptionAdds ?? "–"}/${s.medianSubscriptionRemoves ?? "–"} | ${s.medianResubscribed ?? "–"} | ${s.medianJsBytes === null ? "–" : Math.round(s.medianJsBytes / 1024)} | ${s.medianRequests ?? "–"} |`,
        );
    }
  }
  return lines.join("\n");
}
if (process.argv[2] === "--report") {
  const files = process.argv.slice(3);
  assert.ok(files.length >= 1 && files.length <= 2, "Uso: --report a.json [b.json]");
  const [a, b] = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
  console.log(markdownReport(a, b));
  process.exit(0);
}

const env = process.env;
const root = resolve(env.BENCH_ROOT ?? selfRoot);
const mode = env.BENCH_MODE ?? "build";
assert.ok(["build", "external"].includes(mode), "BENCH_MODE deve ser build ou external");
const runs = Number(env.BENCH_RUNS ?? 7);
const warmup = Number(env.BENCH_WARMUP ?? 1);
const navLabel = env.BENCH_NAV_LABEL ?? "Navegação da organização";
const allScenarios = ["cold", "tour", "hover", "companies", "documents", "brand"];
const scenarios = new Set(env.BENCH_SCENARIOS ? env.BENCH_SCENARIOS.split(",") : allScenarios);
const profiles = (env.BENCH_PROFILES ?? "0,120").split(",").map((spec) => {
  const match = /^(\d+)(?:x(\d+))?$/.exec(spec.trim());
  assert.ok(match, `Perfil inválido: ${spec}`);
  const rttMs = Number(match[1]),
    cpu = Number(match[2] ?? 1);
  return { name: `${rttMs}ms${cpu > 1 ? `-cpu${cpu}x` : ""}`, rttMs, cpu };
});
const workDir = join(root, ".browser-results/navigation-bench");
mkdirSync(workDir, { recursive: true });
const output = resolve(env.BENCH_OUTPUT ?? join(workDir, "result.json"));

// Configuração local do checkout medido, lida pelos mesmos helpers do worktree.
const { worktreePaths } = await import(join(root, "scripts/lib/worktree/paths.mjs"));
const { readLocalConfig, localUrls } = await import(
  join(root, "scripts/lib/worktree/deployment.mjs")
);
const { currentLocalSiteUrl } = await import(join(root, "scripts/lib/worktree/env-file.mjs"));
const paths = worktreePaths(root);
assert.equal(paths.app, "platform", "BENCH_ROOT precisa ser um worktree da plataforma");
const { acquireLocalBrowserLock, localBrowserFetch: fetch } =
  await import("../../../scripts/lib/local-browser.mjs");
const releaseBrowserLock = acquireLocalBrowserLock(paths.convexDir, crypto.randomUUID());
process.once("exit", releaseBrowserLock);
const config = readLocalConfig(paths);
assert.ok(config, "Backend local sem configuração: rode `bun run dev` no checkout medido");
const urls = localUrls(config);
const siteUrl = currentLocalSiteUrl(paths);
assert.ok(siteUrl, "Sem VITE_SITE_URL local no checkout medido");
const health = await fetch(`${urls.site}/health`).catch(() => null);
assert.ok(health?.ok, `Backend local fora do ar em ${urls.site}: rode \`bun run dev\` em ${root}`);

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------------------------
// Build de produção, servidor e proxies de atraso.
// ---------------------------------------------------------------------------------------------
const closers = [];
let baseUrl, convexProxy, siteProxy;
if (mode === "build") {
  convexProxy = await startDelayProxy({ target: { host: "127.0.0.1", port: config.ports.cloud } });
  closers.push(() => convexProxy.close());
  const dist = join(workDir, "dist");
  console.log(`build: ${root}/apps/console -> ${dist}`);
  const buildEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("VITE_")),
  );
  Object.assign(buildEnv, {
    VITE_CONVEX_URL: `http://127.0.0.1:${convexProxy.port}`,
    VITE_CONVEX_SITE_URL: urls.site,
    VITE_API_URL: urls.site,
    VITE_SITE_URL: siteUrl,
    VITE_APP_SHA: git("rev-parse", "HEAD"),
    VITE_APP_ENV: "development",
  });
  const built = spawnSync(
    join(root, "node_modules/.bin/vp"),
    ["build", "--outDir", dist, "--emptyOutDir"],
    { cwd: join(root, "apps/console"), env: buildEnv, stdio: ["ignore", "ignore", "inherit"] },
  );
  assert.equal(built.status, 0, "vp build do console falhou");
  const server = await startConsoleServer({
    dist,
    convexSite: urls.site,
    authOrigin: siteUrl,
  });
  closers.push(() => server.close());
  siteProxy = await startDelayProxy({ target: { host: "127.0.0.1", port: server.port } });
  closers.push(() => siteProxy.close());
  baseUrl = `http://127.0.0.1:${siteProxy.port}`;
} else {
  assert.ok(env.BENCH_BASE_URL, "BENCH_MODE=external exige BENCH_BASE_URL");
  baseUrl = env.BENCH_BASE_URL.replace(/\/$/, "");
  if (profiles.some((profile) => profile.rttMs))
    console.warn("modo external: a latência dos perfis não é aplicada (sem proxies)");
}
function setLatency(rttMs) {
  convexProxy?.setDelay(rttMs / 2);
  siteProxy?.setDelay(rttMs / 2);
}

// ---------------------------------------------------------------------------------------------
// Orçamento do auth local e contagem de 429.
// ---------------------------------------------------------------------------------------------
const authLog = [];
let rateLimited = 0;
function watchAuth(context) {
  context.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/api/auth/")) authLog.push({ path, at: Date.now() });
  });
  context.on("response", (response) => {
    if (response.status() === 429) rateLimited++;
    if (env.BENCH_DEBUG && response.url().includes("/api/auth/"))
      console.log(`    auth ${response.status()} ${new URL(response.url()).pathname}`);
  });
}
/** Espera a próxima janela de 60 s quando a atual já gastou `limit` pedidos de uma rota. */
async function authBudget(limit = 20) {
  const window = Math.floor(Date.now() / 60_000);
  const counts = new Map();
  for (const entry of authLog)
    if (Math.floor(entry.at / 60_000) === window)
      counts.set(entry.path, (counts.get(entry.path) ?? 0) + 1);
  if (Math.max(0, ...counts.values()) < limit) return 0;
  const wait = (window + 1) * 60_000 - Date.now() + 250;
  console.log(`  auth local: aguardando ${Math.round(wait / 1000)}s pela próxima janela`);
  await delay(wait);
  return wait;
}

// ---------------------------------------------------------------------------------------------
// Script injetado: gesto, quadros (lateral/carregamento) e espera da página pronta.
// ---------------------------------------------------------------------------------------------
const loadingPattern =
  "^(Carregando|Confirmando|Verificando|Conferindo|Buscando)\\b[\\s\\S]*(…|\\.\\.\\.)$";
function benchInit({ loadingPattern, navLabel }) {
  const loadingText = new RegExp(loadingPattern, "i");
  const bench = { t0: null, armed: false, frames: [] };
  window.__bench = bench;
  for (const type of ["click", "change", "submit"])
    addEventListener(
      type,
      () => {
        if (bench.armed && bench.t0 === null) bench.t0 = performance.now();
      },
      true,
    );
  const shown = (element) => element.getClientRects().length > 0;
  function loading() {
    for (const element of document.querySelectorAll(
      '[aria-busy="true"], [role="progressbar"], [role="status"]',
    )) {
      if (!shown(element)) continue;
      if (element.getAttribute("aria-busy") === "true") return true;
      if (element.getAttribute("role") === "progressbar") return true;
      if (loadingText.test(element.textContent.trim())) return true;
    }
    const scope = document.querySelector("main") ?? document.body;
    if (!scope) return true;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.trim();
      if (text && loadingText.test(text) && node.parentElement && shown(node.parentElement))
        return true;
    }
    return false;
  }
  function shell() {
    if (document.querySelector('aside, [role="complementary"]')) return true;
    return [...document.querySelectorAll("nav")].some(
      (nav) => nav.getAttribute("aria-label") === navLabel,
    );
  }
  function state() {
    const h1 = (document.querySelector("main") ?? document).querySelector("h1");
    return { loading: loading(), shell: shell(), h1: h1?.textContent.trim() ?? null };
  }
  bench.state = state;
  let last = "";
  function tick() {
    if (document.body) {
      const current = state();
      const key = `${current.loading}|${current.shell}|${current.h1}`;
      if (key !== last) {
        last = key;
        bench.frames.push({ t: performance.now(), ...current });
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  function textMatch(value, spec) {
    return spec.exact ? value === spec.source : new RegExp(spec.source).test(value);
  }
  function ready(spec) {
    if (!new RegExp(spec.url).test(location.pathname + location.search)) return false;
    const scope = document.querySelector("main") ?? document.body;
    if (!scope) return false;
    const heading = [...scope.querySelectorAll("h1")].some(
      (element) => shown(element) && textMatch(element.textContent.trim(), spec.heading),
    );
    if (!heading) return false;
    if (
      spec.text &&
      ![...scope.querySelectorAll("button, a, td, th, li, p, span")].some(
        (element) => shown(element) && textMatch(element.textContent.trim(), spec.text),
      )
    )
      return false;
    return !loading();
  }
  bench.wait = (spec, stableMs, timeoutMs) =>
    new Promise((resolvePromise) => {
      const started = performance.now();
      let since = null;
      function check() {
        const now = performance.now();
        if (ready(spec)) {
          if (since === null) since = now;
          if (now - since >= stableMs)
            return resolvePromise({ ok: true, readyAt: since, t0: bench.t0 });
        } else since = null;
        if (now - started > timeoutMs)
          return resolvePromise({ ok: false, t0: bench.t0, state: state(), url: location.href });
        requestAnimationFrame(check);
      }
      check();
    });
}

// ---------------------------------------------------------------------------------------------
// Assinaturas Convex pelo WebSocket.
// ---------------------------------------------------------------------------------------------
function watchSockets(page) {
  const log = [];
  const paths = new Map();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string" || !payload.includes('"ModifyQuerySet"')) return;
      let message;
      try {
        message = JSON.parse(payload);
      } catch {
        return;
      }
      for (const change of message.modifications ?? []) {
        if (change.type === "Add") paths.set(change.queryId, change.udfPath);
        log.push({
          at: Date.now(),
          type: change.type,
          udfPath: change.udfPath ?? paths.get(change.queryId) ?? null,
        });
      }
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string" || !payload.startsWith('{"type":"Transition"')) return;
      const entry = { at: Date.now(), type: "Transition" };
      if (trace)
        try {
          entry.updated = (JSON.parse(payload).modifications ?? [])
            .filter((change) => change.type === "QueryUpdated" || change.type === "QueryFailed")
            .map((change) => paths.get(change.queryId) ?? String(change.queryId));
        } catch {
          // Mensagem truncada: a contagem continua, sem os nomes.
        }
      log.push(entry);
    });
  });
  return log;
}
function socketSummary(log, from, until) {
  const slice = log.filter((entry) => entry.at >= from && entry.at <= until);
  const adds = slice.filter((entry) => entry.type === "Add");
  const removes = slice.filter((entry) => entry.type === "Remove");
  const removed = new Set(removes.map((entry) => entry.udfPath));
  return {
    adds: adds.length,
    removes: removes.length,
    // Mesma função fechada e reaberta na mesma navegação: remontagem ou argumento novo.
    resubscribed: adds.filter((entry) => removed.has(entry.udfPath)).length,
    transitions: slice.filter((entry) => entry.type === "Transition").length,
    udfPaths: [...new Set(adds.map((entry) => String(entry.udfPath)))].sort((a, b) =>
      a.localeCompare(b),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Medida de uma navegação.
// ---------------------------------------------------------------------------------------------
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (source) => ({ source, exact: true });
const pattern = (source) => ({ source, exact: false });
const settleMs = 300;
const trace = Boolean(env.BENCH_TRACE);
const short = (udfPath) => String(udfPath).replace(/^.*\//, "").replace(/\.js:/, ":");
/** A cascata de uma navegação, em ms desde o gesto (BENCH_TRACE). */
function printTrace(sample, sockets, from, until, resources) {
  const events = [
    ...sockets
      .filter((entry) => entry.at >= from && entry.at <= until)
      .flatMap((entry) =>
        entry.type === "Add"
          ? [[entry.at - from, `+${short(entry.udfPath)}`]]
          : entry.type === "Transition" && entry.updated?.length
            ? [[entry.at - from, `=${entry.updated.map(short).join(",")}`]]
            : [],
      ),
    ...resources.map((entry) => [entry.end, `js ${entry.name} (início ${entry.start})`]),
  ].sort((a, b) => a[0] - b[0]);
  console.log(`    ${sample.ms ?? "–"} ms`);
  for (const [at, text] of events)
    console.log(`      ${String(Math.round(at)).padStart(5)} ${text}`);
}

async function evaluateRetry(page, fn, arg) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(fn, arg);
    } catch (error) {
      if (attempt >= 20 || !/context was destroyed|navigat/i.test(String(error))) throw error;
      await page.waitForLoadState("domcontentloaded");
    }
  }
}
const waitReady = (page, spec) =>
  evaluateRetry(page, ([target, stable]) => window.__bench.wait(target, stable, 30_000), [
    spec,
    100,
  ]);

/** Resumo, no navegador, do que aconteceu entre `t0` e `end` (relógio da página). */
function pageWindow({ t0, end, cold }) {
  const entries = performance
    .getEntriesByType("resource")
    .filter((entry) => entry.startTime >= t0 && entry.startTime <= end);
  const js = entries.filter((entry) => /\.m?js(\?|$)/.test(new URL(entry.name).pathname));
  const frames = window.__bench.frames;
  const before = frames.filter((frame) => frame.t <= t0).at(-1);
  const during = [
    ...(before ? [before] : []),
    ...frames.filter((frame) => frame.t > t0 && frame.t <= end),
  ];
  window.__bench.armed = false;
  return {
    timeOrigin: performance.timeOrigin,
    requests: entries.length + (cold ? 1 : 0),
    jsRequests: js.length,
    jsBytes: js.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
    jsTransferBytes: js.reduce((sum, entry) => sum + entry.transferSize, 0),
    fullScreenLoader: during.some((frame) => frame.loading && !frame.shell),
    shellMissing: during.some((frame) => !frame.shell),
    loaderFrames: during.filter((frame) => frame.loading).length,
    resources: js.map((entry) => ({
      name: new URL(entry.name).pathname.split("/").at(-1),
      start: Math.round(entry.startTime - t0),
      end: Math.round(entry.responseEnd - t0),
    })),
    firstShellAt: cold ? (frames.find((frame) => frame.shell)?.t ?? null) : undefined,
  };
}

async function finish(page, sockets, result, { cold = false, nav = null, main = null } = {}) {
  await delay(settleMs);
  const t0 = result.t0 ?? 0;
  const details = await page.evaluate(pageWindow, {
    t0,
    end: result.ok ? result.readyAt : 1e12,
    cold,
  });
  const from = details.timeOrigin + t0;
  const readyEpoch = result.ok ? details.timeOrigin + result.readyAt : Date.now();
  const sample = {
    ok: result.ok && result.t0 !== null,
    ms: result.ok && result.t0 !== null ? round(result.readyAt - t0) : null,
    navSurvived: nav ? await nav.evaluate((element) => element.isConnected) : null,
    mainSurvived: main ? await main.evaluate((element) => element.isConnected) : null,
    ...details,
    firstShellAt: details.firstShellAt == null ? null : round(details.firstShellAt),
    subscriptions: socketSummary(sockets, from, readyEpoch),
    subscriptionsSettled: socketSummary(sockets, from, readyEpoch + settleMs),
  };
  if (trace) printTrace(sample, sockets, from, readyEpoch, sample.resources);
  delete sample.timeOrigin;
  delete sample.resources;
  if (!cold) delete sample.firstShellAt;
  if (!result.ok) {
    sample.failure = { state: result.state, url: result.url };
    console.warn(`    não ficou pronta: ${JSON.stringify(sample.failure)}`);
  } else if (result.t0 === null) sample.failure = { reason: "gesto não registrado" };
  return sample;
}

/** Mede `action` (um gesto) até `spec`. */
async function measure(page, sockets, spec, action) {
  const nav = await page
    .getByRole("navigation", { name: navLabel, exact: true })
    .elementHandle({ timeout: 1_000 })
    .catch(() => null);
  const main = await page
    .getByRole("main")
    .elementHandle({ timeout: 1_000 })
    .catch(() => null);
  await page.evaluate(() => {
    window.__bench.armed = true;
    window.__bench.t0 = null;
  });
  await action();
  const result = await waitReady(page, spec);
  return finish(page, sockets, result, { nav, main });
}

/** Carga a frio: do início da navegação do documento (t=0) até a página pronta. */
async function coldLoad(page, sockets, url, spec) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const result = await waitReady(page, spec);
  return finish(page, sockets, { ...result, t0: 0 }, { cold: true });
}

// ---------------------------------------------------------------------------------------------
// Dados sintéticos: conta, organização, duas empresas e XMLs NF-e importados.
// ---------------------------------------------------------------------------------------------
async function convexCall(authorization, kind, path, args) {
  const response = await fetch(`${urls.cloud}/api/${kind}`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = await response.json();
  assert.equal(body.status, "success", `${path}: ${body.errorMessage ?? "falhou"}`);
  return body.value;
}
/** O token Convex da sessão, como o próprio console o pede ao carregar. */
async function sessionToken(page, url) {
  const response = page.waitForResponse(
    (r) => r.url().includes("/api/auth/convex/token") && r.status() === 200,
  );
  await page.goto(url);
  const { token } = await (await response).json();
  assert.ok(token, "Sem token Convex da sessão");
  return `Bearer ${token}`;
}
async function login(page, fixture) {
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("E-mail", { exact: true }).fill(fixture.email);
  await page.getByLabel("Senha", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Entrar no painel" }).click();
  try {
    await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000, waitUntil: "commit" });
  } catch (error) {
    const body = (await page.locator("body").innerText()).slice(0, 400);
    throw new Error(`Login não chegou a /app (${page.url()}): ${body}`, { cause: error });
  }
}
/** Variações sintéticas da NF-e de demonstração: outro número, chave e dígito, sem assinatura. */
function nfeVariant(bytes, number) {
  const text = bytes.toString("utf8");
  const oldKey = /Id="NFe([0-9A-Z]{44})"/.exec(text)[1];
  const keyBase = oldKey.slice(0, 25) + String(number).padStart(9, "0") + oldKey.slice(34, 43);
  let sum = 0;
  for (let i = keyBase.length - 1, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1)
    sum += (keyBase.charCodeAt(i) - 48) * weight;
  const digit = String(sum % 11 < 2 ? 0 : 11 - (sum % 11));
  return Buffer.from(
    text
      .replace(/<Signature\b[\s\S]*?<\/Signature>/g, "")
      .replaceAll(oldKey, keyBase + digit)
      .replace(/<nNF>\d+<\/nNF>/, `<nNF>${number}</nNF>`)
      .replace(/<cDV>\d<\/cDV>/, `<cDV>${digit}</cDV>`),
  );
}
async function createFixture(browser) {
  console.log("dados: criando conta, organização, empresas e documentos sintéticos");
  const admin = `Convex ${config.adminKey}`;
  const fixture = {
    email: `navegacao-${crypto.randomUUID()}@development.invalid`,
    password: `synthetic-${crypto.randomUUID()}`,
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  watchAuth(context);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${baseUrl}/signup`);
  await page.getByLabel("Seu nome").fill("Pessoa do benchmark");
  await page.getByLabel("E-mail", { exact: true }).fill(fixture.email);
  await page.getByLabel("Senha", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await page.getByText("Se ainda não houver uma conta com este e-mail", { exact: false }).waitFor();
  const mail = await convexCall(admin, "query", "mail:inbox", { email: fixture.email });
  await page.goto(`${baseUrl}/verify-email`);
  await page.getByLabel("E-mail", { exact: true }).fill(fixture.email);
  await page
    .getByLabel("Código de oito dígitos")
    .fill(mail.find((message) => message.type === "email-verification").otp);
  await page.getByRole("button", { name: "Verificar e-mail", exact: true }).click();
  await page.getByText("E-mail verificado.", { exact: false }).waitFor();
  await login(page, fixture);
  const user = await sessionToken(page, `${baseUrl}/app`);
  const org = await convexCall(user, "mutation", "organizations:create", {
    name: "Benchmark de navegação",
    slug: `navegacao-${crypto.randomUUID().slice(0, 8)}`,
    ...(await termsAcceptance((path, args) => convexCall(user, "query", path, args))),
  });
  const { companyId } = await convexCall(user, "mutation", "onboarding:start", {
    organizationId: org.organizationId,
    mode: "demonstration",
    expectedVersion: 0,
  });
  const second = await convexCall(user, "mutation", "companies:create", {
    organizationId: org.organizationId,
    cnpj: "11222333000181",
    name: "Serviços sintéticos do benchmark",
    address: {
      street: "Rua sintética",
      number: "1",
      complement: "",
      district: "Centro",
      city: "Cidade sintética",
      state: "SP",
      postalCode: "00000000",
    },
  });
  const { projectId } = await convexCall(user, "mutation", "projects:create", {
    organizationId: org.organizationId,
    name: "Importação do benchmark",
    externalReference: crypto.randomUUID(),
  });
  await convexCall(user, "mutation", "projects:grantCompany", {
    organizationId: org.organizationId,
    projectId,
    companyId,
    scopes: ["documents:import", "documents:read"],
    environments: ["sandbox"],
    expectedVersion: 0,
  });
  const key = await convexCall(user, "action", "keys:create", {
    organizationId: org.organizationId,
    projectId,
    name: "Benchmark",
    scopes: ["documents:import", "documents:read"],
    environment: "sandbox",
    companyIds: [companyId],
    expiresAt: Date.now() + 3_600_000,
  });
  async function rest(path, method = "GET", body) {
    const response = await fetch(`${urls.site}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key.secretOnce}`,
        "X-Environment": "sandbox",
        "Idempotency-Key": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const data = await response.json();
    assert.ok([200, 202].includes(response.status), `${path}: ${JSON.stringify(data.error)}`);
    return data.data;
  }
  const demo = readFileSync(join(root, "apps/console/public/examples/nfe-demonstracao.xml"));
  const files = Array.from({ length: 8 }, (_, index) => ({
    name: `benchmark-${101 + index}.xml`,
    bytes: nfeVariant(demo, 101 + index),
  }));
  const reserved = await rest("/v1/imports", "POST", {
    companyId,
    files: files.map((file) => ({
      name: file.name,
      size: file.bytes.length,
      sha256: hash(file.bytes),
    })),
  });
  for (const [index, file] of files.entries()) {
    const path = `/v1/imports/${reserved.importId}/files/${reserved.fileIds[index]}`;
    const ticket = await rest(`${path}/upload`, "POST");
    const uploaded = await fetch(ticket.url, {
      method: "POST",
      headers: { "X-Upload-Token": ticket.token },
      body: file.bytes,
    });
    assert.equal(uploaded.status, 200, await uploaded.text());
    await rest(`${path}/confirm`, "POST");
  }
  let settled;
  for (let attempt = 0; attempt < 120; attempt++) {
    settled = await rest(`/v1/imports/${reserved.importId}`);
    if (settled.files.every((file) => ["succeeded", "failed", "paused"].includes(file.state)))
      break;
    await delay(1000);
  }
  const imported = settled.files.filter((file) => file.state === "succeeded").length;
  assert.ok(imported >= 2, `Só ${imported} XMLs sintéticos foram importados`);
  const companies = await convexCall(
    await sessionToken(page, `${baseUrl}/app`),
    "query",
    "companies:list",
    {
      organizationId: org.organizationId,
      contextKey: "navigation-bench",
      paginationOpts: { numItems: 20, cursor: null },
    },
  );
  await context.close();
  Object.assign(fixture, {
    backend: config.deploymentName,
    organizationId: org.organizationId,
    slug: org.slug,
    documentsCompanyId: companyId,
    secondCompanyId: second.companyId,
    companies: companies.page.map((row) => ({ id: row.id, name: row.name })),
    importedDocuments: imported,
  });
  return fixture;
}

// ---------------------------------------------------------------------------------------------
// Cenários.
// ---------------------------------------------------------------------------------------------
let fixture, storageState, loggedAt;
const fixtureFile = join(workDir, "fixture.json");
const authWaits = { ms: 0 };
let browser;

async function freshPage(profile) {
  authWaits.ms += await authBudget();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    storageState,
  });
  watchAuth(context);
  await context.addInitScript(benchInit, { loadingPattern, navLabel });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const sockets = watchSockets(page);
  if (profile.cpu > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  }
  return { context, page, sockets };
}

function specs() {
  const org = `/app/${escape(fixture.slug)}`;
  const page = (path, heading) => ({
    url: `^${org}${path}/?(\\?.*)?$`,
    heading: exact(heading),
  });
  return {
    org,
    home: page("", "Início"),
    tour: [
      ["Empresas", page("/companies", "Empresas")],
      ["Documentos", page("/documents", "Documentos fiscais")],
      ["Emissão NFS-e", page("/issuances", "Emissão de NFS-e")],
      ["Operação e suporte", page("/operations", "Operação e suporte")],
      ["Uso e limites", page("/usage", "Uso e limites")],
      ["Início", page("", "Início")],
    ],
    organizations: { url: "^/app/?(\\?.*)?$", heading: exact("Organizações") },
  };
}
const sidebarLink = (page, name) =>
  page
    .getByRole("navigation", { name: navLabel, exact: true })
    .getByRole("link", { name, exact: true });

async function runTour(page, sockets, { hover = false } = {}) {
  const steps = {};
  for (const [label, spec] of specs().tour) {
    const link = sidebarLink(page, label);
    if (hover) {
      await link.hover();
      await delay(200);
    }
    steps[label] = await measure(page, sockets, spec, () => link.click());
  }
  return steps;
}

async function scenarioRun(profile) {
  const s = specs();
  const home = `${baseUrl}/app/${fixture.slug}`;
  const result = {};
  // A: carga a frio, volta pela lateral (primeira visita) e revisita, no mesmo contexto.
  if (scenarios.has("cold") || scenarios.has("tour")) {
    const { context, page, sockets } = await freshPage(profile);
    result.cold = await coldLoad(page, sockets, home, s.home);
    if (scenarios.has("tour")) {
      result.tourFirst = await runTour(page, sockets);
      result.tourRevisit = await runTour(page, sockets);
    }
    await context.close();
  }
  // B: passar o mouse 200 ms antes de clicar, cada página pela primeira vez no contexto.
  if (scenarios.has("hover")) {
    const { context, page, sockets } = await freshPage(profile);
    await coldLoad(page, sockets, home, s.home);
    result.hoverFirst = await runTour(page, sockets, { hover: true });
    await context.close();
  }
  // C: empresas, documentos e a marca, num contexto novo.
  if (scenarios.has("companies") || scenarios.has("documents") || scenarios.has("brand")) {
    const { context, page, sockets } = await freshPage(profile);
    await coldLoad(page, sockets, home, s.home);
    if (scenarios.has("companies")) {
      const list = s.tour[0][1];
      const company = fixture.companies.find((row) => row.id === fixture.documentsCompanyId);
      result.companies = {};
      result.companies["lateral → lista"] = await measure(page, sockets, list, () =>
        sidebarLink(page, "Empresas").click(),
      );
      result.companies["lista → empresa"] = await measure(
        page,
        sockets,
        {
          url: `^${s.org}/companies/${escape(company.id)}/?(\\?.*)?$`,
          heading: exact(company.name),
        },
        () =>
          page
            .getByRole("main")
            .getByRole("link", { name: company.name, exact: true })
            .first()
            .click(),
      );
      result.companies["voltar → lista"] = await measure(page, sockets, list, () =>
        page.evaluate(() => {
          window.__bench.t0 = performance.now();
          history.back();
        }),
      );
    }
    if (scenarios.has("documents")) {
      const company = fixture.documentsCompanyId;
      const list = {
        url: `^${s.org}/documents\\?(?!.*document=).*company=${escape(company)}`,
        heading: exact("Documentos fiscais"),
        text: pattern("^NF-e \\d+$"),
      };
      result.documents = {};
      result.documents["lateral → documentos"] = await measure(page, sockets, s.tour[1][1], () =>
        sidebarLink(page, "Documentos").click(),
      );
      result.documents["escolher empresa"] = await measure(page, sockets, list, () =>
        page.getByLabel("Empresa dos documentos").selectOption(company),
      );
      await page.getByLabel("Origem", { exact: true }).selectOption("imported-xml");
      result.documents["aplicar filtro"] = await measure(
        page,
        sockets,
        { ...list, url: `${list.url}.*` },
        () => page.getByRole("button", { name: "Aplicar filtros", exact: true }).click(),
      );
      result.documents["abrir documento"] = await measure(
        page,
        sockets,
        { url: `^${s.org}/documents\\?.*document=`, heading: pattern("^NF-e \\d+$") },
        () =>
          page
            .getByRole("main")
            .getByRole("button", { name: /^NF-e \d+$/ })
            .first()
            .click(),
      );
      result.documents["voltar à lista"] = await measure(page, sockets, list, () =>
        page.getByRole("button", { name: "Voltar à lista de documentos", exact: true }).click(),
      );
    }
    if (scenarios.has("brand")) {
      await page.goto(`${baseUrl}/app`);
      await waitReady(page, s.organizations);
      const brand = page.getByRole("link", { name: /^Freecorps Fiscal/ }).first();
      result.brand = (await brand.count())
        ? await measure(page, sockets, s.home, () => brand.click())
        : { ok: false, ms: null, failure: { reason: "link da marca ausente em /app" } };
    }
    await context.close();
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Estatística.
// ---------------------------------------------------------------------------------------------
function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
function summarize(samples) {
  const ok = samples.filter((sample) => sample.ok && sample.ms !== null);
  const median = (key) => quantile(ok.map(key), 0.5);
  return {
    n: samples.length,
    failures: samples.length - ok.length,
    medianMs: median((sample) => sample.ms),
    p90Ms: quantile(
      ok.map((sample) => sample.ms),
      0.9,
    ),
    navTracked: samples.filter((sample) => sample.navSurvived != null).length,
    navRemounts: samples.filter((sample) => sample.navSurvived === false).length,
    mainRemounts: samples.filter((sample) => sample.mainSurvived === false).length,
    fullScreenLoaders: samples.filter((sample) => sample.fullScreenLoader).length,
    shellMissing: samples.filter((sample) => sample.shellMissing).length,
    medianRequests: median((sample) => sample.requests),
    medianJsBytes: median((sample) => sample.jsBytes),
    medianSubscriptionAdds: median((sample) => sample.subscriptions.adds),
    medianSubscriptionRemoves: median((sample) => sample.subscriptions.removes),
    medianResubscribed: median((sample) => sample.subscriptions.resubscribed),
    medianTransitions: median((sample) => sample.subscriptions.transitions),
  };
}
/** Achata { cenário: amostra | { passo: amostra } } em linhas "cenário / passo". */
function steps(run) {
  const rows = [];
  for (const [scenario, value] of Object.entries(run)) {
    if ("ok" in value) rows.push([scenario, value]);
    else
      for (const [step, sample] of Object.entries(value))
        rows.push([`${scenario} / ${step}`, sample]);
  }
  return rows;
}
function aggregate(runResults) {
  const byStep = new Map();
  for (const run of runResults)
    for (const [step, sample] of steps(run))
      byStep.set(step, [...(byStep.get(step) ?? []), sample]);
  return Object.fromEntries([...byStep].map(([step, samples]) => [step, summarize(samples)]));
}

// ---------------------------------------------------------------------------------------------
// Execução.
// ---------------------------------------------------------------------------------------------
async function signIn() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  watchAuth(context);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await login(page, fixture);
  await page.waitForURL(new RegExp(`/app/${escape(fixture.slug)}`), { timeout: 30_000 });
  // Deixa o console lembrar a organização, como numa sessão real.
  await page.getByRole("heading", { level: 1, name: "Início", exact: true }).waitFor();
  storageState = await context.storageState();
  loggedAt = Date.now();
  await context.close();
}
try {
  browser = await chromium.launch({ headless: !env.BENCH_HEADED });
  closers.unshift(() => browser.close());
  const report = {
    meta: {
      tool: "apps/console/e2e/navigation-bench.mjs",
      toolSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: selfRoot,
        encoding: "utf8",
      }).trim(),
      commit: git("rev-parse", "HEAD"),
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      dirty: Boolean(git("status", "--porcelain")),
      date: new Date().toISOString(),
      machine: {
        platform: `${platform()} ${release()} ${arch()}`,
        cpu: cpus()[0]?.model ?? null,
        cores: cpus().length,
        memoryGb: Math.round(totalmem() / 2 ** 30),
        node: process.version,
        chromium: browser.version(),
      },
      mode:
        mode === "build"
          ? "build de produção (vp build) servido localmente, /api/auth encaminhado como no Worker"
          : `external: ${baseUrl}`,
      backend: "Convex local anônimo do checkout medido",
      latency:
        mode === "build"
          ? "proxy TCP com RTT/2 em cada sentido para estáticos, /api/auth e Convex (HTTP e WebSocket)"
          : "nenhuma adicionada",
      viewport: "1440x1000",
      runs,
      warmup,
      navLabel,
      readiness:
        "URL + h1 esperado visível em main + sem aria-busy/progressbar/status nem texto de carregamento, estável por 100 ms",
      p90: "nearest-rank (com N=7, o p90 é o maior valor)",
    },
    profiles: [],
  };
  if (existsSync(fixtureFile)) {
    fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
    if (fixture.backend !== config.deploymentName) fixture = null;
  }
  if (fixture) {
    try {
      await signIn();
    } catch {
      console.log("dados: o fixture salvo não entra mais; criando outro");
      fixture = null;
    }
  }
  if (!fixture) {
    fixture = await createFixture(browser);
    writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`);
    await signIn();
  }
  report.meta.dataset = {
    organizations: 1,
    companies: fixture.companies.length,
    importedDocuments: fixture.importedDocuments,
  };
  {
    const { context, page } = await freshPage({ cpu: 1 });
    await page.goto(`${baseUrl}/app/${fixture.slug}`);
    const nav = page.getByRole("navigation", { name: navLabel, exact: true });
    await nav.waitFor();
    report.meta.sidebarLinks = (await nav.getByRole("link").allInnerTexts()).map((text) =>
      text.trim(),
    );
    await context.close();
  }
  for (const profile of profiles) {
    console.log(`perfil ${profile.name}`);
    setLatency(profile.rttMs);
    const runResults = [];
    for (let run = 0; run < warmup + runs; run++) {
      if (Date.now() - loggedAt > 40 * 60_000) await signIn();
      console.log(`  ${run < warmup ? `aquecimento ${run + 1}` : `execução ${run - warmup + 1}`}`);
      const result = await scenarioRun(profile);
      if (run >= warmup) runResults.push(result);
    }
    report.profiles.push({
      name: profile.name,
      rttMs: mode === "build" ? profile.rttMs : null,
      cpuThrottle: profile.cpu,
      summary: aggregate(runResults),
      runs: runResults,
    });
  }
  report.meta.authRateLimited = rateLimited;
  report.meta.authWaitMs = authWaits.ms;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(markdownReport(report));
  console.log(`\nresultado: ${output}`);
} finally {
  for (const close of closers) await close().catch(() => {});
}
