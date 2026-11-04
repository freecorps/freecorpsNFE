// Entra no console local com a conta de seed-account.mjs e captura cada tela
// principal em cada estado (dados, vazio, carregando, erro), com axe e um
// veredito do que a tela mostrou. Rode com --label antes na base e --label
// depois na mudança; as duas rodadas ficam lado a lado em capturas/<label>/.
//
//   node .agents/skills/verify-console/scripts/capture-screens.mjs --label antes
//     [--screen <id>]... [--state <estado>]...
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { localAuthPacer } from "../../../../apps/console/e2e/local-auth-pacing.mjs";
import { withLocalBrowser } from "../../../../scripts/lib/local-browser.mjs";
import { currentLocalSiteUrl } from "../../../../scripts/lib/worktree/env-file.mjs";
import { worktreePaths } from "../../../../scripts/lib/worktree/paths.mjs";
import {
  captureArgs,
  capturePlan,
  judgeCapture,
  outputDirectory,
  screens,
  states,
} from "./lib.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
let options;
try {
  options = captureArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
if (options.help) {
  console.log(
    "Uso: node .agents/skills/verify-console/scripts/capture-screens.mjs --label <antes|depois>\n" +
      "       [--screen <id>]... [--state <estado>]...\n" +
      `Telas: ${screens.map((screen) => screen.id).join(", ")}. Estados: ${states.join(", ")}.\n` +
      `Grava ${outputDirectory}/capturas/<label>/ (PNG por tela e estado e report.json).`,
  );
  process.exit(0);
}
const accountFile = join(root, outputDirectory, "account.json");
if (!existsSync(accountFile)) {
  console.error("Rode seed-account.mjs antes: falta a conta sintética.");
  process.exit(2);
}
const account = JSON.parse(readFileSync(accountFile, "utf8"));
const require = createRequire(join(root, "apps/console/package.json"));
const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;

await withLocalBrowser(root, "verify-console-capture", async () => {
  const site = currentLocalSiteUrl(worktreePaths(root));
  const output = join(root, outputDirectory, "capturas", options.label);
  // Uma rodada completa recomeça a pasta; com --screen ou --state, só as
  // capturas refeitas são trocadas e as demais continuam no relatório.
  const partial = options.screens.length > 0 || options.states.length > 0;
  const previous =
    partial && existsSync(join(output, "report.json"))
      ? JSON.parse(readFileSync(join(output, "report.json"), "utf8")).captures
      : [];
  if (!partial) rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const report = {
    label: options.label,
    codeSha: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain")),
    site,
    startedAt: new Date().toISOString(),
    result: "running",
    captures: [...previous],
  };
  const browser = await chromium.launch({ headless: true });
  try {
    // Uma entrada pela tela de login para a rodada inteira, no ritmo do auth local.
    // Um só ritmo para todos os contextos: só a primeira requisição espera a janela inicial.
    const pace = localAuthPacer(report);
    const login = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await pace(login);
    const page = await login.newPage();
    await page.goto(`${site}/login`);
    await page.getByLabel("E-mail", { exact: true }).fill(account.email);
    await page.getByLabel("Senha", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Entrar no painel" }).click();
    await page.waitForURL(/\/app(\/|$)/);
    const session = await login.storageState();
    await login.close();

    async function contextFor(state) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        storageState: session,
      });
      await pace(context);
      // Carregando: o Convex conecta, mas nenhuma resposta dele chega à página.
      if (state === "carregando")
        await context.routeWebSocket(/\/api\/[^/]+\/sync/, (ws) => {
          const server = ws.connectToServer();
          ws.onMessage((message) => server.send(message));
          server.onMessage(() => {});
        });
      return context;
    }
    async function observe(target) {
      return target.evaluate(() => {
        const visible = (element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
        };
        const all = (selector) => [...document.querySelectorAll(selector)].filter(visible);
        const headings = all("h1, h2, h3").map((element) => element.textContent.trim());
        const heading = all("h1, h2")[0]?.textContent?.trim() ?? "";
        const text = document.body.innerText;
        return {
          heading,
          busy:
            all('.ui-skeleton, [aria-busy="true"], [role="progressbar"]').length > 0 ||
            /\bCarregando\b/i.test(text),
          alert:
            all('[role="alert"]').some((element) => element.textContent.trim()) ||
            headings.some((title) =>
              /não encontrad|indisponível|inexistente|sem acesso|restrit|não existe/i.test(title),
            ),
        };
      });
    }

    for (const state of states.filter((s) => !options.states.length || options.states.includes(s))) {
      const plan = capturePlan(account, { screens: options.screens, states: [state] });
      const context = await contextFor(state);
      const target = await context.newPage();
      for (const capture of plan) {
        await target.goto(`${site}${capture.path}`);
        if (state === "carregando") await delay(2500);
        else {
          // Estável: título ou alerta visível e nenhum indicador de carregamento por 500 ms.
          // O prazo cobre uma janela inteira do ritmo de autenticação (65 s): cada
          // carregamento completo busca sessão e token de novo.
          const deadline = Date.now() + 100_000;
          let steady = 0;
          while (Date.now() < deadline && steady < 2) {
            const now = await observe(target);
            steady = !now.busy && (now.heading || now.alert) ? steady + 1 : 0;
            await delay(250);
          }
        }
        const observed = await observe(target);
        // Animações paradas: o brilho dos esqueletos não muda a imagem entre rodadas.
        await target.screenshot({
          path: join(output, capture.file),
          fullPage: true,
          animations: "disabled",
        });
        const axe = await new AxeBuilder({ page: target })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        const entry = {
          ...capture,
          observed,
          verdict: judgeCapture(state, observed),
          axeViolations: axe.violations.map((v) => ({ id: v.id, impact: v.impact })),
        };
        report.captures = report.captures.filter(
          (other) => other.screen !== entry.screen || other.state !== entry.state,
        );
        report.captures.push(entry);
        console.log(`${capture.screen} / ${state}: ${entry.verdict}`);
      }
      await context.close();
    }
    report.result = report.captures.every((entry) => !entry.verdict.startsWith("divergente"))
      ? "passed"
      : "failed";
  } finally {
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await browser.close();
  }
  console.log(`Capturas e relatório em ${join(outputDirectory, "capturas", options.label)}`);
  return report.result;
});
