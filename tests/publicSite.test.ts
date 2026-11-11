import { describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type FC } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { landing } from "../apps/console/src/site/render.tsx";
import { taskEntryHref } from "../apps/console/src/console-task.ts";
import { safeRedirect } from "../apps/console/src/session-handoff.ts";
import { developerPlugin, developerSources } from "../apps/console/developer-plugin.ts";
import { landingStyles, publicSitePlugin, publication } from "../apps/console/site-plugin.ts";
import { ContractProvider, ErrorCodes, Operations } from "../apps/docs/app/components/contract.tsx";
import { contractData } from "../apps/docs/app/lib/contract.server.ts";
import { baseOptions } from "../apps/docs/app/lib/layout.tsx";
import { apiSlug } from "../apps/docs/app/lib/openapi.ts";
import { publicErrorStatus } from "../packages/contracts/src/external.ts";
import { webhookEvents } from "../packages/contracts/src/webhooks.ts";
// The project already uses jsdom at runtime; this test needs only its document surface.
const { JSDOM }: { JSDOM: new (html: string) => { window: { document: Document } } } =
  createRequire(import.meta.url)("jsdom");
const parse = (html: string) => new JSDOM(html).window.document;

const api = JSON.parse(readFileSync("docs/v1.0/openapi.json", "utf8"));
const apiPages = new Set(
  Object.values(api.paths).flatMap((methods) =>
    Object.values(methods as Record<string, { operationId: string }>).map((op) =>
      apiSlug(op.operationId),
    ),
  ),
);
const content = "apps/docs/content/docs";
const guides = Object.fromEntries(
  readdirSync(content)
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => [file.replace(/\.mdx$/, ""), readFileSync(join(content, file), "utf8")]),
);
// The capture is real, the NFS-e issuance is not (ISSUANCE.md): sandbox only, production gate off,
// no real note issued. Neither the landing nor the guides say it issues in production, nor date
// the restricted-production proof (#197) or the first real note (#198).
const issuanceClaims = [
  /emit(e|imos|ir)( a)? (NFS-e|NF-e|notas?)( reais)? em produção/i,
  /emissão (de NFS-e |real |fiscal )?em produção (?!está desligada)/i,
  /(NFS-e|nota) (real|com validade fiscal) (emitida|autorizada)/i,
  /primeira nota real/i,
  /\b\d{1,2}\/(11|12)\/2026\b|(novembro|dezembro) de 2026/i,
];
// The repository is public since 03/11/2026 (#267). Neither the landing nor the guides call it
// private or condition access to it; "privado" next to a package (`@freecorps/contracts`) is not
// about the repository.
const repositoryPrivate =
  /reposit[oó]rio[^.\n]{0,40}\bprivad|\bprivad[^.\n]{0,40}reposit[oó]rio|GitHub \(privado\)|404 sem acesso/i;
const contract = (component: FC) =>
  parse(
    renderToStaticMarkup(
      createElement(ContractProvider, {
        data: contractData(),
        children: createElement(component),
      }),
    ),
  );

// A stand-in for apps/docs/dist: the plugin copies whatever the docs build
// produced, so these tests do not need the docs build.
function docsFixture() {
  const dir = mkdtempSync(join(tmpdir(), "docs-"));
  mkdirSync(join(dir, "docs/assets"), { recursive: true });
  const page = (title: string) =>
    `<!doctype html><html lang="pt-BR"><head><meta name="robots" content="noindex, nofollow, noarchive"/><title>${title}</title></head><body><main><h1>${title}</h1></main></body></html>`;
  writeFileSync(join(dir, "docs/index.html"), page("Início"));
  writeFileSync(join(dir, "docs/contrato.html"), page("Contrato"));
  writeFileSync(join(dir, "docs/404.html"), page("Página não encontrada"));
  writeFileSync(join(dir, "docs/assets/app.js"), "export {};");
  writeFileSync(join(dir, "docs.data"), "[]");
  // Left by another build and absent from this one's list: never shipped.
  writeFileSync(join(dir, "docs/removida.html"), page("Removida"));
  writeFileSync(
    join(dir, "files.json"),
    JSON.stringify([
      "docs.data",
      "docs/404.html",
      "docs/assets/app.js",
      "docs/contrato.html",
      "docs/index.html",
    ]),
  );
  return dir;
}

describe("distribuição pública estática", () => {
  it("mantém a raiz candidata noindex e gera meta e canonical somente no opt-in", () => {
    const shell = readFileSync("apps/console/index.html", "utf8");
    const candidate = parse(publicSitePlugin("").transformIndexHtml(shell));
    expect(candidate.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
      "noindex, nofollow, noarchive",
    );
    expect(candidate.querySelector('link[rel="canonical"]')).toBeNull();
    const published = parse(publicSitePlugin("https://fiscal.example").transformIndexHtml(shell));
    expect(published.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
      "index, follow",
    );
    expect(published.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      "https://fiscal.example/",
    );
    expect(published.querySelectorAll("h1")).toHaveLength(1);
  });

  it("oferece a landing legível sem JavaScript, sem estilo inline e com links existentes", () => {
    const html = landing();
    const doc = parse(html);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.querySelector("main")?.textContent?.length).toBeGreaterThan(500);
    expect(doc.querySelector("script")).toBeNull();
    // style-src in public/_headers: inline styles would be blocked by the CSP.
    expect(doc.querySelector("[style]")).toBeNull();
    expect(html).not.toMatch(/[\u2013\u2014]/);
    for (const anchor of doc.querySelectorAll("a[href^='/docs']")) {
      const url = new URL(anchor.getAttribute("href")!, "https://example.test");
      const slug = url.pathname.replace(/^\/docs\/?/, "").replace(/\.html$/, "") || "index";
      expect(slug in guides, url.pathname).toBe(true);
    }
  });

  // #452: the phone layout lost "Entrar". Header, footer and the docs side menu
  // each keep a way to the login; m0.mjs checks the header in a 390px browser.
  it("leva ao login pelo cabeçalho e pelo rodapé da landing e pelo menu dos guias", () => {
    const doc = parse(landing());
    for (const area of ["header", "footer"]) {
      const login = Array.from(doc.querySelectorAll(`${area} a[href='/login']`));
      expect(
        login.map((a) => a.textContent?.trim()),
        area,
      ).toEqual(["Entrar"]);
    }
    expect(doc.querySelector(`header a[href='${taskEntryHref("importar")}']`)?.textContent).toBe(
      "Criar conta",
    );
    const links = baseOptions().links ?? [];
    const login = (on: string) =>
      links.some((link) => "url" in link && link.url === "/login" && link.on === on);
    expect(login("nav")).toBe(true);
    expect(login("menu")).toBe(true);
  });

  // #510: every call to the sandbox enters by the signup and returns, through the login
  // redirect, to the console home with the task "Importar XML"; no bare /signup is left.
  it("leva cada chamada ao sandbox ao cadastro com a tarefa de importar", () => {
    const entry = taskEntryHref("importar");
    expect(entry).toBe("/signup?redirect=%2Fconsole%3Ftarefa%3Dimportar");
    const redirect = new URL(entry, "https://example.test").searchParams.get("redirect");
    expect(safeRedirect(redirect)).toBe("/console?tarefa=importar");
    const doc = parse(landing());
    const signup = Array.from(doc.querySelectorAll("a[href^='/signup']"));
    expect(signup.map((a) => [a.textContent?.trim(), a.getAttribute("href")])).toEqual([
      ["Criar conta", entry],
      ["Começar no sandbox", entry],
      ["Começar no sandbox", entry],
    ]);
  });

  // Since 03/11/2026 plans are sold by card only (docs/plataforma/BILLING.md).
  it("anuncia na landing só o cartão como forma de pagamento", () => {
    const terms = parse(landing()).querySelector(".price-terms")?.textContent ?? "";
    expect(terms).toContain("Cartão pelo Stripe");
    expect(terms).not.toMatch(/Pix/);
  });

  // The landing announces only accepted coverage (docs/plataforma/PUBLIC.md, decision
  // of 18/10/2026). Text, figure labels and code samples all count as claims.
  it("anuncia na landing só a cobertura aceita", () => {
    const doc = parse(landing());
    const read = (root: ParentNode) =>
      [
        root.textContent ?? "",
        ...Array.from(root.querySelectorAll("[aria-label]"), (el) => el.getAttribute("aria-label")),
      ].join("\n");
    // Models outside the offer may only show up in their own bento cell, marked as planned.
    const planned = /\b(NFC-e|CT-e|MDF-e)\b/;
    for (const cell of doc.querySelectorAll(".bento-cell")) {
      if (!planned.test(cell.querySelector("h3")?.textContent ?? "")) continue;
      expect(read(cell), cell.querySelector("h3")?.textContent ?? "").toMatch(/previsto/i);
      cell.remove();
    }
    const text = read(doc.body);
    expect(text).not.toMatch(planned);
    for (const claim of [
      /\d\.\d{3} (prefeituras|municípios|jeitos)/i,
      /\b5\.?570\b/,
      /\b27 (SEFAZ|UFs?|unidades federativas)\b/i,
      /todas? as SEFAZ|todos os estados/i,
      /modelos de documento/i,
      /todo modelo fiscal/i,
      /nota autorizada|NFS-e autorizada|a nota já saiu/i,
      /pronto para a reforma/i,
      /"production"|X-Environment: production/,
      /createIssuance|\/v1\/issuances/,
      /emita a primeira nota/i,
      /produção (liberada|quando)/i,
      /ver no GitHub|o código é seu/i,
      /backup|a cada 12 horas|\bSLA\b/i,
      /sandbox em minutos|sem janela de falha/i,
      /que a SEFAZ autorizou|a qualquer momento/i,
    ])
      expect(text).not.toMatch(claim);
    // Capture (#427, wording approved by the maintainer on 26/10/2026): real, company by company,
    // turned on by the company in the console and without manifestation; never offered as
    // generally available. Every sentence that mentions it names the company, and production
    // appears only for the capture. Figure captions (the intake's "CAPTURA" slot) are drawings.
    const prose = doc.body.cloneNode(true) as HTMLElement;
    for (const svg of prose.querySelectorAll("svg")) svg.remove();
    const sentences = Array.from(prose.querySelectorAll("p, li, dt, dd, h1, h2, h3, figcaption"))
      .filter((el) => el.tagName !== "LI" || !el.querySelector("p, h3"))
      .flatMap((el) => (el.textContent ?? "").split(/(?<=[.:])\s+/));
    const capture = sentences.filter((sentence) => /captur/i.test(sentence));
    expect(capture.length).toBeGreaterThan(0);
    for (const sentence of capture) expect(sentence).toMatch(/empresa/);
    for (const sentence of sentences.filter((s) => /produção/i.test(s)))
      expect(sentence).toMatch(/captur/i);
    expect(text).toMatch(/sem manifestação/);
    expect(text).toMatch(/empresa piloto, em 22\/10\/2026/);
    const cloud = Array.from(
      doc.querySelectorAll("#infra .infra-compare article:first-child li"),
      (li) => li.textContent,
    );
    expect(cloud).toContain("Captura de NF-e em produção para a empresa que a ativa");
    expect(cloud).toContain("Emissão com validade fiscal desligada");
    for (const claim of [
      /(disponível|aberta|liberada) para (todas as empresas|qualquer empresa|todos)/i,
      /disponibilidade geral|já disponível|lançamento|lançad[ao]/i,
      /manifestação automática|manifesta por você|manifestamos/i,
      /captura (de|das?) (NFS-e|NFC-e|CT-e)/i,
      ...issuanceClaims,
    ])
      expect(text).not.toMatch(claim);
    // The SDK is on npm since 01/11/2026 (#83), and the repository is public since 03/11/2026
    // (#267): the landing links it without the private label and never calls it private.
    expect(text).toMatch(/SDK TypeScript, publicado no npm/);
    expect(text).not.toMatch(/tarball privado/);
    expect(text).not.toMatch(repositoryPrivate);
    const repositoryLinks = Array.from(doc.querySelectorAll("a[href^='https://github.com/']"));
    expect(repositoryLinks.length).toBeGreaterThan(0);
    for (const link of repositoryLinks) expect(link.textContent).not.toMatch(/privad/i);
  });

  // The repository is public since 03/11/2026 (PUBLIC.md, #267): the guides link it and show the
  // clone as a working command, with no Callout or phrase saying it is private, and the guides' top
  // bar labels it "GitHub". The packages went to npm on 01/11/2026 (#83): no guide says they are
  // not there. `@freecorps/contracts` stays private on npm; that is a package, not the repository.
  it("apresenta nos guias o repositório público, sem condição de acesso", () => {
    for (const [name, source] of Object.entries(guides)) {
      expect(source, `${name}.mdx diz que um pacote publicado não está no npm`).not.toMatch(
        /ainda não (?:está |estão )?(?:publicad[oa]s? )?no npm/,
      );
      expect(source, `${name}.mdx diz que o repositório é privado`).not.toMatch(repositoryPrivate);
      expect(source, `${name}.mdx condiciona o repositório num Callout`).not.toMatch(
        /<Callout[^>]*title="[^"]*privad/i,
      );
    }
    // The clone and the repository link stay in the installation guide, now unconditioned.
    expect(guides.instalacao).toContain(
      "git clone https://github.com/freecorps/freecorpsNFE.git fiscal",
    );
    expect(guides.instalacao).toContain("](https://github.com/freecorps/freecorpsNFE)");
    expect(guides.licencas).toContain(
      "](https://github.com/freecorps/freecorpsNFE/blob/main/LICENSE)",
    );
    const github = (baseOptions().links ?? []).filter(
      (link) => "url" in link && link.url?.startsWith("https://github.com/"),
    );
    expect(github).toHaveLength(1);
    for (const link of github) {
      expect(link.type ?? "main").toBe("main");
      expect("text" in link && link.text).toBe("GitHub");
    }
    expect(baseOptions().githubUrl).toBeUndefined();
  });

  // #519: the general help channel and the access conditions have one owner page, reached from
  // the docs entry, the landing footer and the error guidance. It repeats only recorded decisions
  // (PUBLIC.md, "Ajuda e condições de acesso"): no price, response time or permanent free use, and
  // privacy and security keep their own addresses.
  it("publica ajuda e condições de acesso só com o que foi decidido", () => {
    const help = guides.ajuda!;
    for (const address of ["suporte", "privacidade", "seguranca"])
      expect(help).toContain(`(mailto:${address}@nfe.freecorps.com.br)`);
    expect(help).toMatch(/`code`[^\n]*`requestId`/);
    // The warning names each item the message must not carry.
    const warning = /<Callout[^>]*title="Não envie dados sensíveis">([\s\S]*?)<\/Callout>/.exec(
      help,
    );
    expect(warning).not.toBeNull();
    for (const item of ["XML", "certificado A1", "senha", "chave de API", "dados fiscais"])
      expect(warning![1], item).toContain(item);
    // The terms of use and the privacy policy are published (#428): the page links the public
    // texts and no longer calls them drafts.
    expect(help).toContain("[termos de uso](/termos)");
    expect(help).toContain("[política de privacidade](/privacidade)");
    expect(help).not.toMatch(/rascunhos, sem vigência/);
    // First response: no deadline (maintainer's decision of 27/10/2026, suporte-email.md).
    expect(help).toContain("Respondemos assim que possível, sem prazo garantido.");
    // While the catalog is off, plan requests go to the help channel (decision of 27/10/2026),
    // and the plan errors elsewhere link to it instead of naming the address.
    expect(help).toMatch(/peça o plano[^.]*\(#pedir-ajuda\)/);
    expect(guides["captura-nfe"]).toMatch(
      /solicitar o plano à Freecorps\]\(\/docs\/ajuda#pedir-ajuda\)/,
    );
    expect(guides.contrato).toMatch(/solicitar um plano\]\(\/docs\/ajuda#pedir-ajuda\)/);
    expect(help).toMatch(/catálogo de planos está desligado/);
    for (const claim of [
      /R\$\s?\d/,
      /\d+\s*(dias? úteis|horas? úteis|dias? corridos)/i,
      /gratuito permanente|grátis para sempre|sem custo para sempre/i,
      /responde(mos)? em até/i,
    ])
      expect(help).not.toMatch(claim);
    // The limits live in the contract; the help page links there instead of copying them.
    expect(help).not.toMatch(/\d+ por minuto/);
    expect(help).toContain("](/docs/contrato#limites)");
    const meta = JSON.parse(readFileSync(join(content, "meta.json"), "utf8")).pages as string[];
    expect(meta.indexOf("ajuda")).toBeGreaterThan(meta.indexOf("---Começar---"));
    expect(meta.indexOf("ajuda")).toBeLessThan(meta.indexOf("---Guias---"));
    expect(guides.index).toContain("](/docs/ajuda)");
    expect(parse(landing()).querySelector("footer a[href='/docs/ajuda']")?.textContent).toBe(
      "Ajuda e condições de acesso",
    );
    for (const guide of ["contrato", "primeira-chamada", "importar-pelo-painel"])
      expect(guides[guide], guide).toContain("](/docs/ajuda#pedir-ajuda)");
    // Only the help page names the support address; the other guides link to it.
    for (const [name, source] of Object.entries(guides))
      if (name !== "ajuda") expect(source, name).not.toContain("suporte@");
  });

  // remark-llms copies MDX text as is, so a formatter's {" "} would leak into the .md and llms files.
  it("escreve os guias sem espaços JSX que vazam para o Markdown", () => {
    for (const [name, source] of Object.entries(guides))
      expect(source, name).not.toContain('{" "}');
  });

  // The guides follow the same capture wording as the landing (PUBLIC.md, #427), and the capture
  // guide covers the codes a production capture shows.
  it("descreve nos guias a captura fiscal real, por empresa e sem disponibilidade geral", () => {
    for (const [name, source] of Object.entries(guides)) {
      for (const claim of [
        /ainda não capturou|transporte fiscal desligado|captura de um documento real ainda/i,
        /^\|\s*Captura[^\n]*\|\s*Em construção\s*\|$/im,
        /(disponível|aberta|liberada) para (todas as empresas|qualquer empresa|todos)/i,
        /disponibilidade geral|já disponível/i,
        /manifesta (por você|automaticamente)|registra a Ciência da Operação por/i,
        ...issuanceClaims,
      ])
        expect(source, name).not.toMatch(claim);
    }
    const guide = guides["captura-nfe"]!;
    expect(guide).toMatch(/empresa piloto, em\s+22\/10\/2026/);
    // Accepting a gap's loss is the owner's, with a reason, for console and integration captures
    // alike (#442, owner's decision of 26/10/2026); it is no longer "in decision".
    expect(guide).not.toMatch(/em decisão/i);
    expect(guide).toMatch(/só o `owner`/);
    expect(guide).toMatch(/motivo/);
    for (const code of [
      "SOURCE_COOLDOWN",
      "CAPTURE_FISCAL_DENIED",
      "CAPTURE_RELEASE_WITHDRAWN",
      "CAPTURE_FISCAL_HALTED",
      "RECONCILIATION_UNAVAILABLE",
      "QUOTA_EXCEEDED",
    ])
      expect(guide, code).toContain(`\`${code}\``);
    expect(guides.index).toMatch(/\[captura de NF-e\]\(\/docs\/captura-nfe\)/);
  });

  it("serve a home com a própria folha de estilo, montada das seções e figuras", () => {
    const shell = readFileSync("apps/console/index.html", "utf8");
    const home = publicSitePlugin("").transformIndexHtml(shell);
    expect(home).toContain('href="/landing.css"');
    expect(home).toContain("data-landing");
    const styles = landingStyles();
    expect(styles).toContain(".landing {");
    expect(styles).toContain("/* figures/plant.css */");
    expect(styles).toContain("/* sections/coverage.css */");
    expect(styles).not.toMatch(/@import/);
  });

  it("deriva todas as operações e escopos do contrato versionado", () => {
    const rows = Array.from(
      contract(Operations).querySelectorAll('[aria-label="Operações REST"] tbody tr'),
      (row) => row.textContent,
    );
    const operations = Object.entries(api.paths).flatMap(([path, methods]) =>
      Object.entries(methods as Record<string, { operationId: string; "x-scope": string }>).map(
        ([method, op]) => ({ path, method, op }),
      ),
    );
    expect(rows).toHaveLength(operations.length);
    for (const { path, method, op } of operations)
      expect(
        rows.some(
          (row) =>
            row?.includes(`${method.toUpperCase()} ${path}`) &&
            row.includes(op.operationId) &&
            row.includes(String(op["x-scope"])),
        ),
      ).toBe(true);
  });

  it("lista códigos de erro, status, ambientes e eventos do contrato", () => {
    const codes: string[] = api.components.schemas.Error.properties.error.properties.code.enum;
    const rows = Array.from(
      contract(ErrorCodes).querySelectorAll('[aria-label="Códigos de erro"] tbody tr'),
      (row) => Array.from(row.querySelectorAll("td"), (cell) => cell.textContent ?? ""),
    );
    expect(rows.map(([code]) => code)).toEqual(codes);
    for (const [code, status, meaning] of rows) {
      expect(status, code).toBe(String(publicErrorStatus[code as keyof typeof publicErrorStatus]));
      expect(meaning?.length, code).toBeGreaterThan(10);
    }
    const data = contractData();
    expect(data.environments).toEqual(expect.arrayContaining(["sandbox", "production"]));
    expect(data.events).toEqual([...webhookEvents]);
    // The contract and webhook pages render these lists through their MDX components.
    for (const component of ["<Environments />", "<ErrorCodes />", "<Operations />"])
      expect(guides.contrato).toContain(component);
    expect(guides.webhooks).toContain("<WebhookEvents />");
  });

  it("cita nos guias apenas operações do contrato e declara as páginas que o leem", () => {
    const ids = new Set(
      Object.values(api.paths).flatMap((methods) =>
        Object.values(methods as Record<string, { operationId: string }>).map(
          (op) => op.operationId,
        ),
      ),
    );
    const components =
      /<(Op|Environments|WebhookEvents|PageRange|Tolerance|ContractVersion|ErrorCodes|Operations)\b/;
    for (const [name, source] of Object.entries(guides)) {
      for (const [, id] of source.matchAll(/<Op id="([^"]+)"/g))
        expect(ids.has(id!), `${name}: ${id}`).toBe(true);
      if (components.test(source)) expect(source, name).toMatch(/^contract: true$/m);
    }
  });

  it("escreve os guias sem travessões e com links internos existentes", () => {
    for (const [name, source] of Object.entries(guides)) {
      expect(source, name).not.toMatch(/[\u2013\u2014]/);
      for (const [, path, hash] of source.matchAll(
        /\]\(\/docs\/?([a-z0-9/-]*)(?:#([a-z0-9-]+))?\)/g,
      )) {
        if (path!.startsWith("api/")) {
          expect(apiPages.has(path!.slice(4)), `${name}: /docs/${path}`).toBe(true);
          continue;
        }
        const target = path || "index";
        expect(target in guides, `${name}: /docs/${path}`).toBe(true);
        if (hash) expect(guides[target], `${name}: #${hash}`).toContain(`[#${hash}]`);
      }
    }
    // Navigation titles, interface strings and the generated API descriptions.
    for (const file of [
      "apps/docs/content/docs/meta.json",
      "apps/docs/app/lib/translations.ts",
      "apps/docs/app/lib/layout.tsx",
      "apps/docs/app/lib/openapi.ts",
      "apps/docs/app/lib/openapi.server.ts",
      "apps/docs/app/lib/contract.server.ts",
      "docs/v1.0/openapi.json",
    ])
      expect(readFileSync(file, "utf8"), file).not.toMatch(/[\u2013\u2014]/);
  });

  it("mantém a CSP sem estilo ou script inline liberados", () => {
    const headers = readFileSync("apps/console/public/_headers", "utf8");
    const policy = /Content-Security-Policy: (.+)/.exec(headers)![1]!;
    // 'wasm-unsafe-eval' lets the console compile its own WebAssembly (the DANFE barcode
    // reader, #296), still only from 'self'; it allows neither eval() nor new Function().
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(policy).toMatch(/style-src 'self'( 'sha256-[A-Za-z0-9+/=]+')*;/);
    expect(policy).not.toContain("unsafe-inline");
    expect(policy.replaceAll("'wasm-unsafe-eval'", "")).not.toContain("unsafe-eval");
  });

  it("copia a documentação compilada e prepara indexação só no opt-in", () => {
    const docs = docsFixture();
    try {
      const emitted: { fileName: string; source: string | Uint8Array }[] = [];
      const emit = (plugin: ReturnType<typeof publicSitePlugin>) => {
        emitted.length = 0;
        plugin.generateBundle.call({
          emitFile: (file: (typeof emitted)[number]) => emitted.push(file),
        });
        return new Map(emitted.map((file) => [file.fileName, String(file.source)]));
      };
      const candidate = emit(publicSitePlugin("", docs));
      expect([...candidate.keys()]).toEqual(
        expect.arrayContaining([
          "docs/index.html",
          "docs/contrato.html",
          "docs/assets/app.js",
          "docs.data",
          "landing.css",
        ]),
      );
      expect(candidate.has("docs/removida.html")).toBe(false);
      expect(candidate.has("files.json")).toBe(false);
      expect(candidate.get("docs/contrato.html")).toContain("noindex");
      expect(candidate.has("sitemap.xml")).toBe(false);

      const published = emit(publicSitePlugin("https://fiscal.example", docs));
      expect(published.get("docs/contrato.html")).toContain(
        '<link rel="canonical" href="https://fiscal.example/docs/contrato">',
      );
      expect(published.get("docs/index.html")).toContain('href="https://fiscal.example/docs/"');
      const sitemap = published.get("sitemap.xml")!;
      expect(sitemap).toContain("https://fiscal.example/docs/contrato");
      expect(sitemap).not.toMatch(/login|console|prototipo|signup|assets/);
      const headers = published.get("_headers")!;
      expect(headers).toContain("/*\n  X-Robots-Tag: noindex");
      expect(headers).toContain("/docs/contrato\n  ! X-Robots-Tag");
      expect(headers).toContain("/docs/contrato.html\n  ! X-Robots-Tag");
      expect(headers).not.toContain("/console\n  !");
      // The not-found page answers missing addresses: never indexable.
      expect(published.get("docs/404.html")).toContain("noindex");
      expect(published.get("docs/404.html")).not.toContain("canonical");
      expect(sitemap).not.toContain("/docs/404");
      expect(headers).not.toContain("/docs/404");
    } finally {
      rmSync(docs, { recursive: true, force: true });
    }
  });

  it("serve no desenvolvimento a página de não encontrado pela regra do Worker", () => {
    const docs = docsFixture();
    try {
      let middleware: (req: unknown, res: unknown, next: () => void) => void = () => {};
      publicSitePlugin("", docs).configureServer({
        middlewares: { use: (handler: typeof middleware) => (middleware = handler) },
      } as unknown as Parameters<ReturnType<typeof publicSitePlugin>["configureServer"]>[0]);
      const get = (url: string, accept = "text/html") => {
        const res = {
          statusCode: 200,
          type: "",
          body: "",
          setHeader(name: string, value: string) {
            if (name === "Content-Type") this.type = value;
          },
          end(body?: string | Buffer) {
            this.body = body ? String(body) : "";
          },
        };
        middleware({ url, headers: { accept } }, res, () => {});
        return res;
      };
      for (const path of ["/docs/inexistente", "/docs/velha.html"]) {
        const res = get(path);
        expect(res.statusCode, path).toBe(404);
        expect(res.body, path).toContain("Página não encontrada");
      }
      for (const [path, accept] of [
        ["/docs/inexistente.data", "*/*"],
        ["/docs/inexistente", "application/json"],
      ]) {
        const res = get(path, accept);
        expect(res.statusCode, path).toBe(404);
        expect(res.type, path).toContain("text/plain");
      }
    } finally {
      rmSync(docs, { recursive: true, force: true });
    }
  });

  it("recusa na lista da documentação caminhos fora da pasta", () => {
    for (const entry of ["../segredo.txt", "docs/../../x", "/etc/passwd", "C:/x", "docs\\x", ""]) {
      const docs = docsFixture();
      try {
        writeFileSync(join(docs, "files.json"), JSON.stringify(["docs/index.html", entry]));
        expect(
          () => publicSitePlugin("", docs).generateBundle.call({ emitFile: () => {} }),
          entry,
        ).toThrow(/Lista de arquivos inválida/);
      } finally {
        rmSync(docs, { recursive: true, force: true });
      }
    }
  });

  it("interrompe o build do console sem a documentação compilada", () => {
    const docs = mkdtempSync(join(tmpdir(), "docs-"));
    try {
      const plugin = publicSitePlugin("", docs);
      plugin.configResolved({ command: "build" });
      expect(() => plugin.buildStart()).toThrow(/Documentação não compilada.*docs:build/);
      plugin.configResolved({ command: "serve" });
      expect(() => plugin.buildStart()).not.toThrow();
    } finally {
      rmSync(docs, { recursive: true, force: true });
    }
  });

  it("recusa origens de publicação com credenciais, caminho, HTTP ou fragmento", () => {
    for (const value of [
      "http://example.test",
      "https://a:b@example.test",
      "https://example.test/path",
      "https://example.test#x",
      "https://example.test/",
    ])
      expect(() => publication(value)).toThrow();
  });
});

// #158: /developer/ is rendered from its sources by the console build; nothing
// under apps/console/public/developer/ is versioned.
describe("arquivos de /developer/", () => {
  const emitted = () => {
    const files: { fileName: string; source: string }[] = [];
    developerPlugin().generateBundle.call({ emitFile: (file) => files.push(file) });
    return new Map(files.map((file) => [file.fileName, file.source]));
  };

  it("gera no build os seis arquivos com os bytes das fontes", () => {
    const files = emitted();
    expect([...files.keys()].sort()).toEqual(
      [
        "SDK.md",
        "nfse-issuance.ts",
        "openapi.json",
        "quickstart-curl.mjs",
        "quickstart.ts",
        "sdk-webhook-receiver.mjs",
      ].map((name) => `developer/${name}`),
    );
    for (const [name, source] of Object.entries(developerSources))
      if (name !== "SDK.md")
        expect(files.get(`developer/${name}`), name).toBe(readFileSync(source, "utf8"));
    // The guide keeps its text; only the links into the repository's docs, which the site does
    // not serve, become labels.
    const guide = readFileSync("docs/v1.0/SDK.md", "utf8");
    const copy = files.get("developer/SDK.md")!;
    expect(guide).toMatch(/\]\(\.\.\//);
    expect(copy).not.toMatch(/\]\(\.\.\//);
    expect(copy).toContain("[OpenAPI](openapi.json)");
    expect(copy).toContain("descritos em DOCUMENTS.md.");
    const lines = guide.split("\n");
    expect(copy.split("\n")).toHaveLength(lines.length);
    for (const line of lines.filter((line) => !line.includes("](../")))
      expect(copy).toContain(line);
  });

  it("cobre todo endereço de /developer/ que o console e os guias citam", () => {
    const sources = [
      ...readdirSync(content).map((file) => join(content, file)),
      "apps/docs/app/lib/markdown.server.ts",
      ...readdirSync("apps/console/src", { recursive: true, encoding: "utf8" })
        .filter((file) => /.tsx?$/.test(file))
        .map((file) => join("apps/console/src", file)),
      "packages/sdk/README.md",
    ];
    const cited = new Set(
      sources.flatMap((file) =>
        [
          ...readFileSync(file, "utf8").matchAll(/\/developer\/([\w.-]+\.(?:json|md|ts|mjs))\b/g),
        ].map((m) => m[1]),
      ),
    );
    expect(cited.size).toBeGreaterThan(0);
    for (const name of cited) expect(Object.keys(developerSources), name).toContain(name);
  });

  it("recusa o build com uma cópia esquecida em public/developer/", () => {
    const leftover = mkdtempSync(join(tmpdir(), "developer-"));
    try {
      expect(() => developerPlugin(undefined, leftover).buildStart()).toThrow(
        /não é mais versionado/,
      );
      rmSync(leftover, { recursive: true });
      expect(() => developerPlugin(undefined, leftover).buildStart()).not.toThrow();
    } finally {
      rmSync(leftover, { recursive: true, force: true });
    }
  });

  it("serve no desenvolvimento só os arquivos gerados", () => {
    let middleware: (req: unknown, res: unknown, next: () => void) => void = () => {};
    developerPlugin().configureServer({
      middlewares: { use: (handler: typeof middleware) => (middleware = handler) },
    } as unknown as Parameters<ReturnType<typeof developerPlugin>["configureServer"]>[0]);
    const get = (url: string, method = "GET") => {
      const res = {
        type: "",
        body: undefined as string | undefined,
        passed: false,
        setHeader(name: string, value: string) {
          if (name === "Content-Type") this.type = value;
        },
        end(body?: string) {
          this.body = body;
        },
      };
      middleware({ url, method }, res, () => (res.passed = true));
      return res;
    };
    const files = emitted();
    const curl = get("/developer/quickstart-curl.mjs?download");
    expect(curl.type).toBe("text/javascript; charset=utf-8");
    expect(curl.body).toBe(files.get("developer/quickstart-curl.mjs"));
    expect(get("/developer/openapi.json").type).toBe("application/json");
    const head = get("/developer/SDK.md", "HEAD");
    expect([head.type, head.body, head.passed]).toEqual([
      "text/markdown; charset=utf-8",
      undefined,
      false,
    ]);
    expect(get("/developer/openapi.json", "POST").passed).toBe(true);
    for (const path of [
      "/developer/",
      "/developer/keys",
      "/developer/..%2Fpackage.json",
      "/developer/toString",
      "/app/org/developer/SDK.md",
    ]) {
      const res = get(path);
      expect(res.passed, path).toBe(true);
      expect(res.body, path).toBeUndefined();
    }
  });
});
