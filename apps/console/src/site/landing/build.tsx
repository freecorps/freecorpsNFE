import { city, rack, terminal } from "./figures/index.ts";
import { Arrow, GitHubMark, Iso, repository, sandboxEntry } from "./shell.tsx";

// A tiny build-time highlighter: comments, strings and a handful of keywords.
// The page ships the highlighted HTML; no highlighter runs in the browser.
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function highlight(code: string) {
  return code
    .split("\n")
    .map((line) =>
      escape(line).replace(
        /((?<![:\w])\/\/.*$|^\s*#.*$)|("[^"]*"|`[^`]*`)|\b(import|export|from|const|await|async|function|new|return|if)\b|(\$[A-Z_]+)/g,
        (match, comment, string, keyword, variable) =>
          comment
            ? `<span class="tok-c">${match}</span>`
            : string
              ? `<span class="tok-s">${match}</span>`
              : keyword
                ? `<span class="tok-k">${match}</span>`
                : variable
                  ? `<span class="tok-v">${match}</span>`
                  : match,
      ),
    )
    .join("\n");
}

// Three views of one flow, each kept under 64 columns so it fits the panel
// at desktop widths; phones scroll inside the panel. The flow is the sandbox
// import of examples/quickstart.ts, the path the platform has proven.
const examples = [
  {
    id: "sdk",
    label: "SDK",
    code: `// npm install @freecorps/sdk
import { FreecorpsClient } from "@freecorps/sdk";

const fiscal = new FreecorpsClient({
  baseUrl: "https://api.nfe.freecorps.com.br",
  apiKey: process.env.FREECORPS_API_KEY!,
  environment: "sandbox",
});

// files: nome, tamanho e SHA-256 de cada XML do lote.
const { data } = await fiscal.call(
  "reserveImport",
  { path: {}, query: {}, body: { companyId, files } },
  // Uma chave por lote: repetir nunca reserva outro.
  { idempotencyKey: \`lote-\${lote.id}\` },
);

data.reused; // true quando a chave já tinha sido usada`,
  },
  {
    id: "curl",
    label: "curl",
    code: `curl https://api.nfe.freecorps.com.br/v1/imports \\
  -H "Authorization: Bearer $FREECORPS_API_KEY" \\
  -H "X-Environment: sandbox" \\
  -H "Idempotency-Key: lote-8812" \\
  -H "Content-Type: application/json" \\
  -d @lote.json

# lote.json leva a empresa e o SHA-256 de cada XML:
#   { "companyId": "...", "files": [{ "name": "nota.xml",
#     "size": 4096, "sha256": "9f2c..." }] }

# 200 na primeira vez e em cada repetição:
#   { "data": { "importId": "...", "reused": false, ... } }
#   { "data": { "importId": "...", "reused": true,  ... } }

# Mesma chave com outro conteúdo: 409, nada é reservado.`,
  },
  {
    id: "webhook",
    label: "Webhook",
    code: `import { verifyWebhook } from "@freecorps/sdk/webhooks";

export async function POST(request: Request) {
  // x-fnfe-signature: HMAC-SHA256 sobre os bytes do corpo.
  const checked = await verifyWebhook({
    body: new Uint8Array(await request.arrayBuffer()),
    headers: Object.fromEntries(request.headers),
    secrets,
    now: Date.now(),
  });
  if (!checked.ok) return new Response(null, { status: 400 });

  // Entrega pelo menos uma vez: aplique uma vez por eventId.
  await aplicarUmaVez(checked.event); // "import.completed"
  return new Response(null, { status: 204 });
}`,
  },
];

export function Developers() {
  return (
    <section className="developers" id="desenvolvedores" aria-labelledby="dev-title">
      <div className="section-head">
        <p className="eyebrow">Para quem integra</p>
        <h2 id="dev-title">Repita o pedido. Nada acontece duas vezes.</h2>
        <p>
          Idempotency-Key na reserva, decimal como texto e webhook assinado. O SDK TypeScript,
          publicado no npm, cuida do resto.
        </p>
      </div>
      <div className="dev-console">
        <div className="dev-code" data-tabs="">
          <div className="dev-bar">
            <p className="dev-bar-label">Três exemplos, um fluxo</p>
            <div className="tabs" role="tablist" aria-label="Exemplos de integração">
              {examples.map((example, i) => (
                <button
                  key={example.id}
                  type="button"
                  role="tab"
                  id={`tab-${example.id}`}
                  aria-controls={`code-${example.id}`}
                  aria-selected={i === 0 ? "true" : "false"}
                >
                  {example.label}
                </button>
              ))}
            </div>
          </div>
          <div className="code-stack">
            {examples.map((example) => (
              <div key={example.id} className="code-item">
                <p className="code-title" aria-hidden="true">
                  {example.label}
                </p>
                <pre
                  id={`code-${example.id}`}
                  role="tabpanel"
                  aria-labelledby={`tab-${example.id}`}
                  tabIndex={0}
                >
                  <code dangerouslySetInnerHTML={{ __html: highlight(example.code) }} />
                </pre>
              </div>
            ))}
          </div>
        </div>
        <div className="dev-live" data-replay="">
          <div className="dev-bar">
            <h3 id="replay-title">
              <span className="live-dot" aria-hidden="true" />
              Mesma chave, mesmo lote
            </h3>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Repetir pedido"
              data-replay-button=""
              hidden
            >
              Repetir<span className="wide">pedido</span>
            </button>
          </div>
          <ol className="replay-log" aria-labelledby="replay-title">
            {[1, 2].map((n) => (
              <li key={n} className="replay-exchange" data-replay-again={n === 2 ? "" : undefined}>
                <span className="when" data-replay-count={n === 2 ? "" : undefined}>
                  {`envio ${n}`}
                </span>
                <span className="what">POST /v1/imports</span>
                <span className="sub">Idempotency-Key: lote-8812</span>
                <span className="res">
                  <b>200</b> lote 7Hk2Qm
                </span>
                <span className={n === 2 ? "meta is-hit" : "meta"}>{`reused: ${n === 2}`}</span>
              </li>
            ))}
            <li className="replay-hook">
              <span className="when">webhook</span>
              <span className="what">import.completed</span>
              <span className="meta verified">assinatura ok</span>
              <span className="sub">x-fnfe-signature: t=1791763200;v1,…</span>
            </li>
          </ol>
          <dl className="replay-tally">
            <div>
              <dt>Pedidos</dt>
              <dd data-replay-sent="">2</dd>
            </div>
            <div className="is-hit">
              <dt>Lotes reservados</dt>
              <dd>1</dd>
            </div>
            <div>
              <dt>Webhooks</dt>
              <dd>1</dd>
            </div>
          </dl>
          <p className="sr-only" aria-live="polite" data-replay-status="" />
        </div>
      </div>
    </section>
  );
}

export function Stripe() {
  return (
    <section className="stripe" id="stripe" aria-labelledby="stripe-title">
      <div className="stripe-inner" data-stripe="">
        <p className="eyebrow">Em construção</p>
        <h2 id="stripe-title">Cobrou no Stripe? A nota vem junto, no sandbox.</h2>
        <p>
          A conexão Stripe pede uma NFS-e para cada invoice.paid e, se você quiser, o cancelamento
          no reembolso. Hoje só no sandbox, com transporte simulado e nota sem validade fiscal.
          Nenhum evento real do Stripe passou por ela ainda.
        </p>
        <Iso
          figure={terminal()}
          className="stripe-figure"
          label="Maquininha de cartão ligada por um cabo a um emissor que imprime a nota fiscal."
        />
        <div className="stripe-actions">
          <button type="button" className="btn btn-primary" data-stripe-pay="" hidden>
            Simular pagamento
          </button>
          <ol className="stripe-log" aria-live="polite">
            <li>
              <code>invoice.paid</code> de teste recebido
            </li>
            <li>
              <code>issuance.authorized</code> NFS-e simulada, sem validade fiscal
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}

export function Infrastructure() {
  return (
    <section className="infra" id="infra" aria-labelledby="infra-title">
      <div className="infra-grid">
        <div className="infra-copy">
          <h2 id="infra-title">Código disponível. Repositório público.</h2>
          <p>
            Hoje a plataforma roda na nuvem da Freecorps. A instalação própria com Docker foi
            ensaiada e parte de um clone do repositório, sob a Licença Freecorps 1.0.
          </p>
          <a className="repo-chip" href={repository}>
            <GitHubMark />
            freecorps/freecorpsNFE
            <Arrow />
          </a>
        </div>
        <Iso
          figure={rack()}
          className="infra-figure"
          label="Rack de servidores com luzes acesas ao lado do cofre de certificados."
        />
      </div>
      <div className="infra-compare">
        <article>
          <h3>Na nuvem da Freecorps</h3>
          <ul>
            <li>Sandbox sem certificado</li>
            <li>Importação, consulta e webhooks pela API e pelo SDK</li>
            <li>Captura de NF-e em produção para a empresa que a ativa</li>
            <li>Emissão com validade fiscal desligada</li>
          </ul>
        </article>
        <article>
          <h3>Na sua infraestrutura</h3>
          <ul>
            <li>Ensaio Docker com versões fixadas por digest</li>
            <li>Cofre A1 com AES-256-GCM e chave sua</li>
            <li>Restore ensaiado em volume vazio</li>
          </ul>
        </article>
        <article className="license">
          <h3>Licença de Código Disponível Freecorps 1.0</h3>
          <p className="license-ok">Pode</p>
          <ul>
            <li>Usar internamente, sem limite de documentos</li>
            <li>Estudar, auditar e propor correções</li>
            <li>Contratar quem instale e opere a instância para você</li>
          </ul>
          <p className="license-ask">Pede autorização escrita</p>
          <ul>
            <li>Operar a parte fiscal de clientes ou de outros terceiros</li>
            <li>Oferecer funções fiscais a terceiros, mesmo grátis ou dentro de um ERP</li>
          </ul>
          <p className="license-ask">
            Minuta em revisão jurídica. Não é software livre; o SDK cliente usa MIT.
          </p>
          <a className="link" href="/docs/licencas">
            Ler a licença
            <Arrow />
          </a>
        </article>
      </div>
    </section>
  );
}

const guarantees = [
  {
    title: "Valor fiscal nunca vira float.",
    body: "Decimais trafegam como texto exato, do XML ao JSON. Nenhum centavo se perde em arredondamento.",
    proof: '"total": "1500.00"',
  },
  {
    title: "Retentativa não duplica documento.",
    body: "A mesma chave devolve o mesmo resultado. Conteúdo diferente com a mesma chave é recusado com 409, e o mesmo XML não vira dois documentos.",
    proof: "Idempotency-Key: lote-8812  →  reused: true",
  },
  {
    title: "O XML original fica guardado.",
    body: "O XML importado é preservado byte a byte, com hash SHA-256, e baixado pela API. A guarda segue a política de retenção, sem promessa de histórico ilimitado.",
    proof: "GET /v1/document-artifacts/{id}/original",
  },
  {
    title: "Todo webhook é assinado.",
    body: "HMAC-SHA256 sobre os bytes, tolerância de 5 minutos e rotação de segredo com o antigo e o novo valendo juntos por até 24 horas.",
    proof: "x-fnfe-signature: t=1791763200;v1,…",
  },
];

export function Guarantees() {
  return (
    <section className="guarantees" id="garantias" aria-labelledby="guarantees-title">
      <div className="section-head">
        <h2 id="guarantees-title">O que a gente não negocia.</h2>
      </div>
      <ol className="stack">
        {guarantees.map((item) => (
          <li key={item.title} className="stack-card">
            <h3>{item.title}</h3>
            <p>{item.body}</p>
            <code>{item.proof}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Closing() {
  return (
    <section className="closing" id="comecar" aria-labelledby="closing-title">
      <canvas className="shader" data-shader="closing" aria-hidden="true" />
      <div className="closing-inner">
        <h2 id="closing-title">Importe o primeiro XML hoje.</h2>
        <p>
          O sandbox não pede certificado. A emissão com validade fiscal ainda está em construção.
        </p>
        <a className="btn btn-primary btn-lg" href={sandboxEntry}>
          Começar no sandbox
          <Arrow />
        </a>
      </div>
      <Iso
        figure={city()}
        className="closing-figure"
        label="Um bairro de prédios isométricos com andares acesos."
      />
    </section>
  );
}
