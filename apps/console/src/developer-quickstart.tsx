import type { IntegrationEnvironment, IntegrationScope } from "@freecorps/contracts";
import type { Organization } from "./organizations";
import { apiOrigin } from "./api-origin";
import { SectionLink } from "./project-sections";
import { CopyButton, scopeLabels } from "./integration-controls";
import { Link } from "@tanstack/react-router";
import { Icon } from "./ui/icons";
import { Callout, Card, DescriptionList, StatusBadge } from "./ui/layout";

interface Props {
  org: Organization;
  project: {
    id: string;
    name: string;
    state: "active" | "disabled";
    deploymentEnvironment: IntegrationEnvironment;
  };
  grants: Array<{
    companyId: string;
    name: string;
    kind: "declared" | "demonstration";
    scopes: readonly string[];
    environments: readonly string[];
  }>;
  /** False while more grant pages can load: absence among the loaded ones proves nothing. */
  complete?: boolean;
}
/**
 * The first call is the public guide's (`apps/docs/content/docs/primeira-chamada.mdx`): import the
 * synthetic NF-e with `examples/quickstart-curl.mjs` and read the result. The script always sends
 * `X-Environment: sandbox` and calls only import, operation and document routes, whose contract
 * scopes are these two; a test checks both against the script and the OpenAPI.
 */
export const quickstartEnvironment = "sandbox" satisfies IntegrationEnvironment;
export const quickstartScopes = [
  "documents:import",
  "documents:read",
] as const satisfies readonly IntegrationScope[];
/**
 * Companies the key can reach in the example: an active grant in Sandbox that holds both scopes.
 * The demonstration company comes first; only its synthetic XML is accepted.
 */
export function quickstartCompanies<
  G extends { kind: string; scopes: readonly string[]; environments: readonly string[] },
>(grants: readonly G[]) {
  return grants
    .filter(
      (g) =>
        g.environments.includes(quickstartEnvironment) &&
        quickstartScopes.every((s) => g.scopes.includes(s)),
    )
    .sort((a, b) => Number(b.kind === "demonstration") - Number(a.kind === "demonstration"));
}
/** Same commands as the guide; the key is read without echo and never written in the text. */
export function powershellExample(origin: string) {
  return `$env:FREECORPS_BASE_URL = '${origin}'
$env:FREECORPS_COMPANY_ID = Read-Host 'ID da empresa'
$chave = Read-Host 'Chave de API' -AsSecureString
$env:FREECORPS_API_KEY = [System.Net.NetworkCredential]::new('', $chave).Password
Remove-Variable chave
$env:FREECORPS_XML = './nfe-demonstracao.xml'
$env:FREECORPS_IDEMPOTENCY_KEY = 'importacao-sintetica-001'`;
}
export function bashExample(origin: string) {
  return `export FREECORPS_BASE_URL='${origin}'
read -r -p 'ID da empresa: ' FREECORPS_COMPANY_ID
read -r -s -p 'Chave de API: ' FREECORPS_API_KEY; echo
export FREECORPS_COMPANY_ID FREECORPS_API_KEY
export FREECORPS_XML='./nfe-demonstracao.xml'
export FREECORPS_IDEMPOTENCY_KEY='importacao-sintetica-001'`;
}
export const runExample = "node quickstart-curl.mjs";
/** The script's steps, in order: each failure starts with one (a test reads the script). */
export const quickstartSteps = [
  "reserva",
  "importação",
  "envio",
  "confirmação",
  "processamento",
  "resultado",
  "documento",
  "itens",
] as const;
export const pollingNote =
  "Essas consultas contam no limite de chamadas por minuto da chave; se ele estourar, o script espera o Retry-After e continua.";
/** The script prints one JSON line; shown here across lines, with the demonstration values. */
export const resultExample = `{
  "importId": "…",
  "operationId": "…",
  "documentId": "…",
  "reused": true,
  "contractVersion": "…",
  "total": "24.69",
  "items": [{ "quantity": "2.0000", "unitPrice": "12.3456789012", "total": "24.69" }],
  "resourceVersion": 2,
  "sha256": "…"
}`;
/**
 * Node verifier for X-Fnfe-Signature, without the SDK. It signs the raw body bytes with the
 * same prefix as the platform; a test runs it against the versioned contract vectors.
 */
export const webhookExample = `import { createHmac, timingSafeEqual } from "node:crypto";

// corpo: Buffer com os bytes originais, antes de JSON.parse.
// versao: número da versão do segredo mostrado no destino.
export function assinaturaValida(segredo, versao, headers, corpo, agora = Date.now()) {
  const [t, ...assinaturas] = (headers["x-fnfe-signature"] ?? "").split(";");
  const timestamp = t?.startsWith("t=") ? t.slice(2) : "";
  if (!/^\\d+$/.test(timestamp) || Math.abs(agora - Number(timestamp)) > 300_000) return false;
  const prefixo = [
    timestamp,
    versao,
    headers["x-fnfe-webhook-version"],
    headers["x-fnfe-event-id"],
    headers["x-fnfe-delivery-id"],
    headers["x-fnfe-resource-version"],
    "",
  ].join(".");
  const esperado = createHmac("sha256", segredo).update(prefixo).update(corpo).digest();
  return assinaturas.some((item) => {
    const [k, v1] = item.split(",");
    if (k !== \`k=\${versao}\` || !v1?.startsWith("v1=")) return false;
    const recebido = Buffer.from(v1.slice(3), "hex");
    return recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
  });
}`;
/**
 * `label` names the region; `name` completes "Copiar …". The button sits below the code, not over
 * it: a long line scrolls inside `pre` and nothing covers it at 375 px.
 */
function Code({ label, value, name }: { label: string; value: string; name: string }) {
  return (
    <div className="ui-stack">
      <div className="gestao-code gestao-code--plain">
        <pre tabIndex={0} role="region" aria-label={label}>
          <code>{value}</code>
        </pre>
      </div>
      <div className="ui-actions">
        <CopyButton value={value} label={`Copiar ${name}`} />
      </div>
    </div>
  );
}
/**
 * What the script prints when a step fails and the way out, in the order of the guide's table (a
 * test keeps both equal). The script starts each failure with its step (`reserva: NOT_FOUND`);
 * `…:` stands for any step. Codes from `publicErrorStatus`, messages from the script.
 */
export const quickstartFailures: ReadonlyArray<{ message: string; when?: string; fix: string }> = [
  {
    message: "Defina FREECORPS_…",
    fix: "Falta uma variável. Repita o bloco de variáveis no mesmo terminal.",
  },
  {
    message: "TypeError: Invalid URL",
    fix: "A URL da API está incompleta, sem https://. Use a URL mostrada na aba Primeira chamada.",
  },
  {
    message: "Origem inválida",
    fix: "A URL tem /v1 ou outro caminho, ou não usa HTTPS. Use a URL da API mostrada na aba Primeira chamada.",
  },
  {
    message: "…: INVALID_API_KEY",
    fix: "HTTP 401. A chave está errada, revogada ou vencida, ou o projeto foi desativado. Reativar o projeto não revalida as chaves antigas: gere uma nova chave.",
  },
  {
    message: "…: ENVIRONMENT_DENIED",
    fix: "HTTP 403. A chave não é de Sandbox. Gere uma chave Sandbox.",
  },
  {
    message: "…: SCOPE_DENIED",
    fix: "HTTP 403. Falta à chave documents:import ou documents:read: gere uma nova chave com os dois. Na reserva, também pode ser o plano fora da vigência; veja Uso e limites.",
  },
  {
    message: "reserva: NOT_FOUND",
    fix: "HTTP 404. Primeiro, confira em Empresas e acesso se a empresa tem acesso em Sandbox com documents:import e documents:read, e copie o ID na aba Primeira chamada. Se a empresa foi removida e concedida de novo depois que a chave foi gerada, gere uma nova chave. Se esta chave de idempotência já foi usada com outra empresa, troque FREECORPS_IDEMPOTENCY_KEY.",
  },
  {
    message: "reserva: IDEMPOTENCY_CONFLICT",
    fix: "HTTP 409. A mesma chave de idempotência já foi usada neste projeto com outra empresa ou outro XML. Troque FREECORPS_IDEMPOTENCY_KEY, por exemplo para importacao-sintetica-002.",
  },
  {
    message: "…: NOT_FOUND",
    when: "depois da reserva",
    fix: "HTTP 404. O acesso mudou durante a execução. Confira em Empresas e acesso se a empresa ainda tem acesso em Sandbox com os dois escopos: sem documents:read, a importação termina e a leitura do documento falha. Se a empresa foi removida e concedida de novo, gere uma nova chave. Com o acesso de volta, rode de novo com a mesma chave de idempotência.",
  },
  {
    message: "envio: Origem de upload inesperada",
    fix: "O endereço de envio do XML não é o de FREECORPS_BASE_URL. Use a URL da API mostrada na aba Primeira chamada, sem outro nome para o mesmo servidor.",
  },
  {
    message: "…: UPLOAD_EXPIRED",
    fix: "HTTP 409. A reserva venceu antes do envio. Troque FREECORPS_IDEMPOTENCY_KEY, por exemplo para importacao-sintetica-002, e rode de novo.",
  },
  {
    message: "processamento: Operação queued, running, retry_wait ou reconciling",
    fix: "O processamento passou de 2 minutos e continua no servidor. Rode o script de novo com a mesma chave de idempotência: ele retoma a mesma importação, sem reenviar o XML.",
  },
  {
    message: "processamento: Operação failed ou paused (código)",
    fix: "O processamento parou e não avança sozinho. O código entre parênteses diz o motivo; ACCESS_REVOKED, por exemplo, é acesso retirado durante o processamento. Repetir mostra o mesmo estado; procure o suporte informando o código e a chave de idempotência.",
  },
  {
    message: "reserva: Identidade mudou",
    fix: "As duas reservas com a mesma chave de idempotência devolveram importações diferentes, o que não deveria acontecer. Não repita; procure o suporte informando a chave de idempotência.",
  },
  {
    message: "resultado: sem documento",
    fix: "O processamento terminou sem documento e sem código de diagnóstico. Procure o suporte informando a chave de idempotência.",
  },
  {
    message: "resultado: COMPANY_MISMATCH",
    fix: "O XML não é da empresa escolhida: o original foi guardado, sem virar documento. Use a empresa de demonstração e troque FREECORPS_IDEMPOTENCY_KEY, porque a chave usada ficou presa à outra empresa. Os outros resultados estão no guia Importar XML pela API.",
  },
  {
    message: "…: curl falhou",
    fix: "O curl não está instalado, a conexão TLS falhou, a resposta não chegou em 30 segundos ou a rede caiu. Confira com curl --version (no Windows, curl.exe --version) e a rede; depois rode de novo com a mesma chave de idempotência: o script consulta a importação antes de reenviar.",
  },
  {
    message: "…: resposta sem JSON",
    fix: "A URL não é a da API, ou um proxy respondeu no lugar dela. Confira a URL e rode de novo com a mesma chave de idempotência.",
  },
  {
    message: "…: RATE_LIMITED",
    fix: "HTTP 429. A chave passou de 60 chamadas por minuto, contando as do próprio script e as de qualquer programa com a mesma chave; ou a organização passou de 120 por minuto, somando todas as chaves; ou, na reserva, acabou a cota do plano. Na espera do processamento, o script aguarda o Retry-After e tenta de novo sozinho. Nas outras etapas, espere um minuto e rode de novo com a mesma chave de idempotência; se repetir, veja Uso e limites.",
  },
];
export function DeveloperQuickstart({ org, project, grants, complete = true }: Props) {
  const origin = apiOrigin();
  const companies = quickstartCompanies(grants);
  const hasDemonstration = companies.some((c) => c.kind === "demonstration");
  const scopeNames = quickstartScopes.map((s) => scopeLabels[s]).join(" e ");
  const demonstrationPath = (
    <>
      Em{" "}
      <Link
        className="ui-link"
        to="/app/$organizationSlug/onboarding"
        params={{ organizationSlug: org.slug }}
      >
        Primeiros passos
      </Link>
      , Proprietário ou Administrador usa Explorar demonstração; depois, conceda a empresa criada em{" "}
      <SectionLink org={org} projectId={project.id} section="projects">
        Empresas e acesso
      </SectionLink>{" "}
      com {scopeNames}, em Sandbox.
    </>
  );
  const scopes = quickstartScopes.map((s, i) => (
    <span key={s}>
      {i ? " e " : ""}
      <strong>{scopeLabels[s]}</strong> (<code>{s}</code>)
    </span>
  ));
  return (
    <Card
      title="Importar e consultar a NF-e de demonstração"
      description={
        <>
          O roteiro do guia{" "}
          <a className="ui-link" href="/docs/primeira-chamada">
            Primeira chamada
          </a>
          , em Sandbox. A nota é sintética e nenhuma chamada transmite nada ao fisco.
        </>
      }
    >
      <div className="gestao-stack gestao-quickstart">
        {project.state !== "active" ? (
          <Callout tone="warning">
            Este projeto está desativado: as chaves dele são recusadas. Reative o projeto em{" "}
            <SectionLink org={org} projectId={project.id} section="projects">
              Empresas e acesso
            </SectionLink>{" "}
            e gere uma nova chave: reativar não revalida as chaves antigas.
          </Callout>
        ) : null}
        {project.deploymentEnvironment === quickstartEnvironment ? null : (
          <Callout tone="warning">
            O exemplo só roda em Sandbox, e esta plataforma atende Produção: o script envia{" "}
            <code>X-Environment: sandbox</code> e a empresa de demonstração só existe em Sandbox.
            Faça a primeira chamada numa plataforma Sandbox, como o serviço hospedado.
          </Callout>
        )}
        <DescriptionList
          items={[
            {
              term: "Ambiente",
              value: (
                <>
                  Sandbox. Toda chamada autenticada leva <code>X-Environment: sandbox</code>.
                </>
              ),
            },
            {
              term: "URL da API",
              value: (
                <div className="ui-stack">
                  <span className="gestao-reference">
                    <code>{origin}</code>
                    <CopyButton value={origin} label="Copiar URL da API" iconOnly />
                  </span>
                  <p className="gestao-help">Sem /v1. A URL do painel é outra.</p>
                </div>
              ),
            },
            {
              term: "Escopos da chave",
              value: (
                <>{scopes}. Nenhum outro: o exemplo não lista empresas nem cadastra webhook.</>
              ),
            },
            {
              term: companies.length > 1 ? "Empresas autorizadas" : "Empresa autorizada",
              value: companies.length ? (
                <div className="ui-stack">
                  <ul className="gestao-list">
                    {companies.map((c) => (
                      <li key={c.companyId}>
                        <span className="gestao-row__title">
                          <strong>{c.name}</strong>
                          {c.kind === "demonstration" ? (
                            <StatusBadge tone="info">Demonstração</StatusBadge>
                          ) : null}
                        </span>
                        <span className="gestao-reference">
                          <code>{c.companyId}</code>
                          <CopyButton
                            value={c.companyId}
                            label={`Copiar ID de ${c.name}`}
                            iconOnly
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                  {hasDemonstration ? (
                    <p className="gestao-help">
                      Use a empresa marcada como Demonstração: o XML de exemplo é dela, e com outra
                      empresa a importação termina sem documento.
                    </p>
                  ) : complete ? (
                    <Callout tone="warning">
                      Nenhuma destas é a empresa de demonstração, e o XML de exemplo só vale para
                      ela. {demonstrationPath}
                    </Callout>
                  ) : (
                    <Callout tone="info">
                      A empresa de demonstração não está entre as empresas carregadas até agora, e o
                      XML de exemplo só vale para ela. Use Carregar mais, abaixo; se ela não
                      aparecer: {demonstrationPath}
                    </Callout>
                  )}
                </div>
              ) : complete ? (
                <Callout tone="warning">
                  Nenhuma empresa deste projeto tem acesso em Sandbox com {scopeNames}.{" "}
                  {demonstrationPath}
                </Callout>
              ) : (
                <Callout tone="info">
                  Nenhuma das empresas carregadas até agora tem acesso em Sandbox com {scopeNames}.
                  Use Carregar mais, abaixo; se nenhuma aparecer: {demonstrationPath}
                </Callout>
              ),
            },
          ]}
        />
        <ol className="gestao-steps">
          <li>
            <div>
              <h3>Gere a chave</h3>
              <p>
                Em{" "}
                <SectionLink org={org} projectId={project.id} section="keys">
                  Chaves de API
                </SectionLink>
                , gere uma chave Sandbox com a empresa e os dois escopos acima. O segredo aparece
                uma vez só: guarde-o num gerenciador de senhas, nunca no código.
              </p>
            </div>
          </li>
          <li>
            <div>
              <h3>Baixe os arquivos</h3>
              <p>
                Numa pasta nova, salve{" "}
                <a className="ui-link" href="/examples/nfe-demonstracao.xml" download>
                  nfe-demonstracao.xml
                </a>{" "}
                e{" "}
                <a className="ui-link" href="/developer/quickstart-curl.mjs" download>
                  quickstart-curl.mjs
                </a>
                . O segundo é um script Node (22.23.4 ou mais recente) que executa curl em cada
                chamada e entrega a chave ao curl pela entrada padrão, fora da linha de comando.
              </p>
            </div>
          </li>
          <li>
            <div>
              <h3>Defina as variáveis</h3>
              <p>
                No terminal, dentro da pasta. O ID da empresa e a chave são pedidos na hora, a chave
                sem eco.
              </p>
              <Code
                label="Variáveis no PowerShell"
                name="variáveis do PowerShell"
                value={powershellExample(origin)}
              />
              <details className="gestao-details">
                <summary>
                  Alternativa em Bash
                  <Icon name="chevronDown" />
                </summary>
                <div className="ui-stack">
                  <p className="gestao-help">
                    Para Bash. No zsh, o <code>read</code> aceita outras opções: rode{" "}
                    <code>bash</code> antes de colar.
                  </p>
                  <Code
                    label="Variáveis no Bash"
                    name="variáveis do Bash"
                    value={bashExample(origin)}
                  />
                </div>
              </details>
            </div>
          </li>
          <li>
            <div>
              <h3>Importe e consulte</h3>
              <Code label="Comando de importação" name="comando de importação" value={runExample} />
              <p>
                O script reserva a importação, envia o XML, confirma e consulta o documento e os
                itens. Enquanto o processamento roda, ele consulta a operação uma vez por segundo e
                não imprime nada, por até 2 minutos. No fim, imprime uma linha JSON:
              </p>
              <p className="gestao-help">{pollingNote}</p>
              <div className="gestao-code gestao-code--plain">
                <pre tabIndex={0} role="region" aria-label="Resultado">
                  <code>{resultExample}</code>
                </pre>
              </div>
              <p>
                Rodar de novo com a mesma chave de idempotência devolve a mesma importação e o mesmo
                documento, sem criar outro. A nota aparece em{" "}
                {companies[0] ? (
                  <Link
                    className="ui-link"
                    to="/app/$organizationSlug/documents"
                    params={{ organizationSlug: org.slug }}
                    search={{ company: companies[0].companyId, env: quickstartEnvironment }}
                  >
                    Documentos
                  </Link>
                ) : (
                  "Documentos"
                )}{" "}
                da empresa, em Sandbox, com os itens e o XML original.
              </p>
              <details className="gestao-details">
                <summary>
                  Se algo falhar
                  <Icon name="chevronDown" />
                </summary>
                <div className="ui-stack">
                  <p className="gestao-help">
                    A mensagem começa pela etapa em que o script parou:{" "}
                    {quickstartSteps.map((step, i) => (
                      <span key={step}>
                        {i === 0 ? "" : i === quickstartSteps.length - 1 ? " ou " : ", "}
                        <code>{step}</code>
                      </span>
                    ))}
                    . Um erro da API traz depois o código e o <code>requestId</code>; guarde os dois
                    para o suporte, nunca a chave. As mensagens do próprio script (Origem inválida,
                    curl falhou, resposta sem JSON) não têm <code>requestId</code>. Na lista,{" "}
                    <code>…:</code> vale para qualquer etapa.
                  </p>
                  <DescriptionList
                    items={quickstartFailures.map((f) => ({
                      key: `${f.message} ${f.when ?? ""}`,
                      term: (
                        <>
                          <code>{f.message}</code>
                          {f.when ? ` ${f.when}` : null}
                        </>
                      ),
                      value: f.fix,
                    }))}
                  />
                </div>
              </details>
            </div>
          </li>
        </ol>
        <section className="ui-stack" aria-labelledby="quickstart-webhook">
          <h3 id="quickstart-webhook" className="gestao-heading">
            Próximo passo: receber um webhook
          </h3>
          <p className="gestao-help">
            Em{" "}
            <SectionLink org={org} projectId={project.id} section="webhooks">
              Webhooks
            </SectionLink>
            , cadastre uma URL HTTPS pública e use “Enviar teste sintético”. Esse passo pede também
            o escopo <code>webhooks:manage</code> no acesso da empresa. Verifique a assinatura com
            os bytes originais do corpo, responda 2xx e ignore um <code>eventId</code> já
            processado. O receptor completo está em{" "}
            <a className="ui-link" href="/docs/webhooks">
              Receber webhooks
            </a>
            .
          </p>
          <details className="gestao-details">
            <summary>
              Verificação da assinatura em Node.js
              <Icon name="chevronDown" />
            </summary>
            <div>
              <Code
                label="Verificação em Node.js"
                name="verificação em Node.js"
                value={webhookExample}
              />
            </div>
          </details>
        </section>
        <p className="gestao-help">
          As demais rotas estão na{" "}
          <a className="ui-link" href="/developer/openapi.json" download>
            especificação OpenAPI
          </a>{" "}
          e no guia do{" "}
          <a className="ui-link" href="/docs/sdk">
            SDK TypeScript
          </a>
          .
        </p>
      </div>
    </Card>
  );
}
