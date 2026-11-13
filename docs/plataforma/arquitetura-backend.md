# Arquitetura do backend

Este documento aprofunda as responsabilidades e as fronteiras do backend da
plataforma (`platform/convex` e `packages/*`). A visão geral do produto, da
borda e do fluxo de uma requisição está em [ARQUITETURA.md](../ARQUITETURA.md);
cada domínio tem seu contrato nesta pasta.

Cada regra estrutural daqui cita o teste ou a regra de lint que a prova
(`prova:`) ou se declara convenção, sem verificação; a forma da marca está em
[Regra com prova citada](../README.md#regra-com-prova-citada).

## Camadas e organização dos arquivos

O backend é um monólito modular em Convex. Funções públicas existem apenas
para operações autenticadas do console (sessão Better Auth) e para as rotas
REST registradas em `platform/convex/http.ts` (prova:
`platform/convex/publicSurface.test.ts` › "refuses a direct call without
session to every public function with forged IDs"; prova:
`platform/convex/httpSurface.test.ts` › "gives every HTTP route a credential
class and refuses each one without credential"). Actions fazem o I/O externo;
o Convex não lhes dá `ctx.db`, e elas leem ou efetivam estado por queries e
mutations internas. Toda função tem validators, e resultados públicos usam
DTOs que não expõem segredos, campos administrativos nem IDs internos de
storage (convenção, sem verificação). A projeção pública de documentos tem
teste próprio (prova: `packages/contracts/documents.test.ts` › "public
projection preserves specific NF-e fields and exact decimals without internal
fields").

Cada domínio segue o mesmo arranjo de arquivos:

| Arquivo                  | Responsabilidade                                                      |
| ------------------------ | --------------------------------------------------------------------- |
| `<domínio>.ts`           | Queries e mutations do console e funções internas do domínio          |
| `<domínio>Rest.ts`       | Rotas REST do domínio, montadas sobre o transporte comum              |
| `<domínio>Worker.ts`     | Execução assíncrona em fila (Workpool) e actions Node                 |
| `lib/<domínio>Schema.ts` | Tabelas e índices, reunidos em `schema.ts`                            |
| `lib/<domínio>Values.ts` | Validators e tipos compartilhados pelas funções                       |
| `lib/<domínio>Rules.ts`  | Regras puras e testáveis, sem acesso ao banco                         |
| `lib/<domínio>Core.ts`   | Regras do domínio que leem ou gravam com o `ctx` de quem chama        |
| `lib/<domínio>Access.ts` | Autorização do domínio sobre organização, projeto, empresa e ambiente |

A divisão em arquivos é convenção, sem verificação. O que a tabela diz de
`*Schema`, `*Values`, `*Rules` e `*Rest` é verificado: os três primeiros não
tocam o banco (prova: `platform/convex/moduleLayers.test.ts` › "lib/\*Schema,
\*Values e \*Rules não tocam o banco"), e só `http.ts` monta os `*Rest.ts`
(prova: `platform/convex/moduleLayers.test.ts` › "só http.ts referencia os
módulos \*Rest").

`lib/organizationAccess.ts` (sessão e membership) e `lib/projectAccess.ts`
(projeto e concessão) são a base das checagens dos demais `*Access.ts`
(convenção, sem verificação). Regras de autorização e de estado ficam na
função que lê ou escreve; validação no formulário ou no contrato REST é só
feedback. Função pública que toca em dado antes de uma checagem reprova no
lint (prova:
[`freecorps/require-access-helper-in-convex-functions`](../desenvolvimento/lint.md#require-access-helper-in-convex-functions)),
e export de `*Access.ts` sem classificação reprova no teste do plugin (prova:
`tooling/oxlint-plugin-freecorps/access-helpers.test.ts` › "classifica cada
função exportada dos lib/\*Access.ts como checagem ou utilitário"). O
comportamento negado tem testes: sessão e papel (prova:
`platform/convex/access.test.ts` › "enforces operator, viewer and missing
grant on the server") e cada domínio do console contra o mesmo conjunto de
atores (prova: `platform/convex/consoleAccess.test.ts` › "console sem projeto:
matriz de acesso por domínio").

### Domínios em camadas

`platform/convex/moduleLayers.test.ts` prova as camadas. Ele classifica cada
módulo num domínio de uma lista ordenada, de baixo para cima (plataforma,
auditoria, custódia, organizações, ..., REST, console, provas e a composição
do app em `schema.ts`, `http.ts` e `crons.ts`), e reprova:

- módulo sem domínio, ou em mais de um (prova:
  `platform/convex/moduleLayers.test.ts` › "todo módulo pertence a exatamente
  um domínio");
- referência `internal.*` ou `api.*` por índice, que não aponta para um
  módulo (prova: `platform/convex/moduleLayers.test.ts` › "toda referência
  internal.\* e api.\* aponta para um módulo");
- referência `internal.*` a um domínio acima, ou import de valor para um
  domínio acima entre módulos da mesma altura (`lib/` com `lib/`, topo com
  topo). O topo usa qualquer helper de `lib/`, e um módulo sem banco (sem
  `_generated/server`, direto ou por import) é importável de qualquer domínio
  (prova: `platform/convex/moduleLayers.test.ts` › "nem internal.\* nem import
  da mesma altura sobem de domínio");
- `lib/` importando um módulo do topo fora de `topForLib`, que tem
  `environment`, `buildInfo`, `auth` e `schema` (prova:
  `platform/convex/moduleLayers.test.ts` › "lib/ só importa do topo os módulos
  combinados");
- `*Rest.ts` referenciado fora de `http.ts`, salvo a action Node das leituras
  REST de documentos (`documentContentNode.ts`) e uma prova local (prova:
  `platform/convex/moduleLayers.test.ts` › "só http.ts referencia os módulos
  \*Rest");
- `lib/*Schema.ts`, `*Values.ts` e `*Rules.ts` importando `_generated/server`
  ou um módulo com banco (prova: `platform/convex/moduleLayers.test.ts` ›
  "lib/\*Schema, \*Values e \*Rules não tocam o banco").

Importação e documentos formam um domínio só, porque se chamam nos dois
sentidos. As arestas para cima que o código ainda tem ficam em `upward`, cada
uma com o motivo; uma exceção que some do código também reprova, no mesmo
teste das arestas. Imports só de tipo não contam, como na regra de lint que
proíbe ciclo de imports de valor entre módulos (prova:
[`import/no-cycle`](../desenvolvimento/lint.md#ciclo-de-imports-no-backend)).

## Pacotes e grafo de dependências

O grafo permitido está em `scripts/build/package-boundaries.json`, e o CI o
confere com `bun run ci:boundaries` antes de aprovar (prova:
`scripts/build/package-boundaries.test.ts` › "checks the real workspaces and
connects the blocking command before CI approval"); `ci:local` roda o mesmo
comando. Cada workspace precisa de classificação explícita; um workspace novo
sem classificação é recusado (prova: `scripts/build/package-boundaries.test.ts`
› "discovers new workspaces and rejects absent or stale classifications").

| Pacote                | Tipo       | Depende de                                             |
| --------------------- | ---------- | ------------------------------------------------------ |
| `fiscal-core`         | puro       | nada                                                   |
| `contracts`           | puro       | `fiscal-core`, `zod`                                   |
| `sdk`                 | puro       | `contracts`, `zod`                                     |
| `fiscal-nfe`          | Node       | `fiscal-core` e bibliotecas de XML/assinatura          |
| `fiscal-nfse`         | Node       | `fiscal-core`, XML/assinatura, PDF e QR Code           |
| `fiscal-nfse/pure`    | puro       | `fiscal-core`; único subcaminho que mutations importam |
| `platform`, `apps/*`  | plataforma | pacotes acima                                          |
| `convex-rate-limiter` | plataforma | `convex`; componente instalado por `platform`          |

Nenhum pacote independente importa Convex, Better Auth, Clerk, React ou
Cloudflare (prova: `scripts/build/package-boundaries.test.ts` › "rejects a
direct dependency and passes again after removing it: %s"), nem lê `process`,
variáveis de ambiente ou outro runtime ambiente (prova:
`scripts/build/package-boundaries.test.ts` › "keeps Node packages independent
from ambient configuration: %s").
`convex-rate-limiter` é um componente Convex e por isso fica na classe da
plataforma, sem as restrições dos independentes. Um subcaminho de export pode
estreitar as regras do seu workspace, nunca ampliá-las (prova:
`scripts/build/package-boundaries.test.ts` › "rejects an entry point absent
from exports, without implementation or wider than its workspace").

Convenção, sem verificação: pacotes não guardam estado. Conectores Node
(distribuição em `fiscal-nfe/src/distribution.ts`, transporte ADN em
`fiscal-nfse`) recebem transporte e credencial em tempo de execução e não
armazenam cursor, agendam retry, giram certificados nem decidem permissões. Só o
backend coordena certificados, checkpoints, tentativas e consumo. Os contratos
públicos de `packages/contracts` mapeiam o domínio; o schema do banco não é a
API.

Convenção, sem verificação: `fiscal-core` contém só conceitos compartilhados
comprovados, como a identificação fiscal e o decimal exato em texto. Cada modelo
fiscal tem seu pacote (`fiscal-nfe` para NF-e 55, `fiscal-nfse` para emissão
NFS-e); a importação de lotes NFS-e ABRASF foi retirada em 02/11/2026. Não se
cria representação universal de documentos nem pacote vazio antecipadamente; uma
extração nova exige consumo ou responsabilidade demonstrados.

## Modelo de dados

O schema é a fonte das tabelas e dos índices, e este documento não as
repete. `platform/convex/schema.ts` reúne as tabelas dos domínios que têm
`platform/convex/lib/<domínio>Schema.ts` e declara ele mesmo as de
organizações e contas, empresas, projetos, operações, termos de uso e
validação.

Invariantes do modelo:

- Todo registro privado carrega a organização e, quando aplicável, projeto,
  empresa e ambiente. Identidades externas são strings estáveis, independentes
  de `_id` (convenção, sem verificação). O isolamento que isso permite tem
  prova: `platform/convex/publicSurface.test.ts` › "keeps every public
  function inside the caller's organization and company grants".
- Índices nomeiam todos os campos, conforme as guidelines do Convex.
  Indexação não impõe unicidade: a leitura de reserva e a escrita ocorrem na
  mesma mutation, com teste de concorrência em cada reserva (convenção, sem
  verificação).
- Itens, eventos, tentativas e membros ficam em tabelas próprias; arrays não
  crescem sem limite dentro de um documento (convenção, sem verificação).
- O mesmo CNPJ pode existir em organizações diferentes, com autorização
  independente; isso não compartilha documentos entre clientes (prova:
  `platform/convex/companies.test.ts` › "the same CNPJ belongs independently
  to two organizations and forged IDs never cross them").
- Na captura, `captureStreams` tem um único stream por identidade fiscal
  efetiva, ambiente e serviço, no índice `by_identity_environment_service`
  (prova: `platform/convex/captures.test.ts` › "isolates the fiscal identity
  globally and deduplicates concurrent manual activation"); a titularidade e a
  transferência estão em [CAPTURE.md](CAPTURE.md).
- A guarda de cada classe de dado, inclusive `accessRecords`, está em
  [RETENTION.md](RETENTION.md).

## Identidade, autorização e ambiente

Better Auth é a fonte única de sessões humanas, com o componente Convex e e-mail
OTP. Os plugins `organization` e `apiKey` do Better Auth não estão instalados:
organizações, memberships, convites e API keys pertencem ao domínio do produto,
e `validationAccess` não concede membership (convenção, sem verificação).
Organização, projeto e empresa são autorizados pelos helpers de domínio, sem
confiar no `organizationId` enviado pelo cliente (prova:
`platform/convex/publicSurface.test.ts` › "keeps every public function inside
the caller's organization and company grants").

Os papéis e suas permissões estão em [ORGANIZATIONS.md](ORGANIZATIONS.md). Os
escopos de API key estão em `packages/contracts/src/projects.ts`
(`integrationScopes`) e o contrato de concessão em [PROJECTS.md](PROJECTS.md).
Membros não ampliam as próprias concessões: `grantableScopes` limita o que cada
papel delega (`developer` concede só leituras e `webhooks:manage`), e uma chave
tem a interseção dos seus escopos com as empresas e ambientes concedidos ao
projeto (prova: `platform/convex/keys.test.ts` › "a developer only delegates
granted companies and role scopes, not another developer's project"). Uma API
key não representa a sessão de um membro, e cookies de autenticação e headers
secretos nunca entram na telemetria (convenção, sem verificação).

Cada deployment roda sob um perfil da plataforma (`APP_ENV`): `development`
(stack local em loopback), `validation` (deployment controlado de validação) ou
`installation` (instalação hospedada). `requirePlatformEnvironment`, em
`platform/convex/environment.ts`, confere as variáveis do perfil e recusa
qualquer outra combinação (prova: `platform/convex/validation.test.ts` ›
"rejects mutations before writing when %s is misconfigured"; prova:
`platform/convex/installation.test.ts` › "refuses unsafe installation setting
%s=%s"; prova: `platform/convex/captures.test.ts` › "fiscal production exists
only on the marked validation target, with production data"). O perfil não
escolhe o ambiente do produto nem o transporte fiscal. As variáveis do perfil
fiscal e da emissão NFS-e (`FNFE_PROOF_FISCAL_ENV`, `FNFE_ISSUANCE_ENV`,
`FNFE_NFSE_*` e `CONVEX_CLOUD_URL` nos gates) são lidas só ali: a emissão e o
cofre usam os campos do perfil validado (`fiscalTarget`, `issuanceEnv`,
`restrictedCompanies`, `productionCompanies`, `deploymentUrl`) (prova:
`platform/convex/environmentIsolation.test.ts` › "leaves the issuance gates to
the validated profile, with no variable read of their own"). O console também
os usa, e uma combinação parcial é recusada em vez de passar por uma leitura solta
(convenção, sem verificação). A captura e as rotinas ainda leem parte das
variáveis direto ([#130](https://github.com/freecorps/freecorpsNFE/issues/130)).

Há dois eixos de ambiente, e toda operação conhece ambos:

- Ambiente do produto: `sandbox` ou `production` (`integrationEnvironments`),
  parte do escopo de chaves, empresas e documentos. Ele é resolvido por pedido
  ([ADR 0007](../adr/0007-captura-fiscal-no-site.md)): a chave ou a operação diz
  o ambiente, e `environmentServed`, em
  `platform/convex/lib/environmentAccess.ts`, decide se o deployment o atende
  para aquela empresa e escopo. O ambiente base do deployment
  (`baseEnvironment`, o `PRODUCT_ENV`) é sempre atendido; empresa de
  demonstração, só em `sandbox` (prova:
  `platform/convex/environmentIsolation.test.ts` › "serves only sandbox on a
  sandbox deployment while no company is released"; prova:
  `platform/convex/environmentIsolation.test.ts` › "opens production for a
  released company only for the capture and its documents"). Um deployment de base
  `production` (#50, produção fiscal da NFS-e) não atende outro (prova:
  `platform/convex/environmentIsolation.test.ts` › "keeps a production
  deployment fixed: production only, never per company"). Um de base `sandbox`
  atende `production` só para empresa com captura fiscal liberada
  (`platform/convex/lib/fiscalCaptureRelease.ts`) e só para captura, documentos,
  webhooks e monitores; importação, emissão, cadastro, referências e
  certificados nunca (prova: `platform/convex/environmentIsolation.test.ts` ›
  "opens production for a released company only for the capture and its
  documents"). Depois de retirada a liberação, sobra só a leitura do que foi
  capturado (prova: `platform/convex/environmentIsolation.test.ts` › "keeps only
  reading, and processing what was received, after the release is withdrawn or
  cut"; [CAPTURE.md](CAPTURE.md#liberação-fiscal-no-site)). As verificações de
  acesso não leem `PRODUCT_ENV` (prova:
  `platform/convex/environmentIsolation.test.ts` › "reads PRODUCT_ENV only in
  the deployment gates, never in an access check").
- Ambiente fiscal: `FISCAL_ENV`, `disabled` por padrão. Transporte real é
  opt-in explícito por deployment, em `platform/convex/environment.ts` (prova:
  `platform/convex/captures.test.ts` › "homologation requires explicit
  transport opt-in and rejects local synthetic mutation there"); na emissão, o
  modo de transporte é `simulated`, `producao-restrita` ou `producao`, com o
  gate por empresa descrito em [ISSUANCE.md](ISSUANCE.md).

O usuário não escolhe endpoint fiscal arbitrário (convenção, sem verificação).
Crons ficam desligados nos ambientes de validação e locais (`FNFE_CRONS=off`)
(prova: `platform/convex/validation.test.ts` › "registers no jobs even if a
cron environment variable is accidentally enabled").

## Contrato REST

As rotas e os schemas estão em [API-REFERENCE.md](../v1.0/API-REFERENCE.md) e
[openapi.json](../v1.0/openapi.json), gerados de `packages/contracts`. Regras
comuns da implementação:

- As rotas JSON (`*Rest.ts`) usam `jsonRoute` de
  `platform/convex/lib/externalHttp.ts` (convenção, sem verificação). O
  transporte confere o formato da chave (prova:
  `platform/convex/restTransport.test.ts` › "recusa chave ausente ou
  malformada antes de ler o corpo"), lê o corpo uma vez dentro do limite da
  rota (16 KiB; webhooks 8 KiB e reprocessamento 1 KiB respondem `413`),
  recusa UTF-8 ou JSON inválido (prova: `platform/convex/restTransport.test.ts`
  › "limita o corpo JSON por rota e recusa UTF-8 inválido e JSON malformado"),
  valida a entrada pelo contrato e entrega ao domínio a rota e a entrada
  interpretadas (prova: `platform/convex/restTransport.test.ts` › "o domínio
  recebe a entrada interpretada e nomeia o que não encontrou"). O domínio
  continua validando autorização, escopo e estado na própria transação. O
  resultado é conferido contra a saída e o status do contrato antes da
  serialização (prova: `platform/convex/restTransport.test.ts` › "valida o
  resultado estruturado contra o contrato antes de serializar"), e as
  referências de operação e evento da telemetria vêm desse resultado, sem
  reler a resposta. Upload, downloads binários e o webhook do Stripe, que
  assina o corpo bruto, mantêm transportes próprios.
- Erros têm `requestId` e `error` com `code`, `message` e `retryable`; sem
  stack trace nem `200` com erro disfarçado. Códigos, status, campos seguros
  (como `field`) e mensagens públicas saem de
  `platform/convex/lib/publicErrors.ts`; cada rota informa só o texto de
  `NOT_FOUND` do seu domínio. Código fora do contrato vira `UNAVAILABLE`, sem
  copiar texto do erro interno (prova: `platform/convex/restTransport.test.ts`
  › "mapeia erros de domínio para o vocabulário público sem copiar texto
  livre"). Os status em uso são `400`, `401`, `403`, `404` (inexistente ou não
  visível), `409` (conflito ou idempotência divergente), `413`, `429` e `503`.
- `Idempotency-Key` é obrigatória em pedidos assíncronos com efeito
  (convenção, sem verificação; cada rota a declara no contrato). A
  identidade é organização + projeto + operação lógica + chave, com hash do
  pedido: o mesmo pedido devolve o mesmo recurso, um pedido diferente devolve
  `409` (prova: `platform/convex/operations.test.ts` › "reserva equivalente
  recupera a mesma operação; conteúdo divergente retorna conflito 409"). A
  reserva acontece antes do agendamento e dura 7 dias, em
  `lib/operationCore.ts` (convenção, sem verificação); a deduplicação
  documental é independente.
- Paginação por cursor opaco, vinculado a filtros e escopo (prova:
  `platform/convex/documents.test.ts` › "bounded filters and cursors reject
  changed context and malformed input"), com desempate estável (convenção, sem
  verificação). O limite de página é
  definido por rota no contrato (em geral até 50). Uma lista vazia pode ter
  próxima página.
- Valores fiscais são decimais em texto canônico com escala documentada
  (prova: `packages/fiscal-core/index.test.ts` › "preserves declared scale and
  leading zeros across JSON") e sem perda de precisão (prova:
  `packages/fiscal-core/index.test.ts` › "refuses precision loss, forged
  decimals and unbounded exponents"); inteiros ficam na faixa segura
  (convenção, sem verificação). Nenhum cálculo os converte em número
  (prova:
  [`freecorps/no-float-fiscal-values`](../desenvolvimento/lint.md#no-float-fiscal-values)).
  Ver [fiscal-core](../../packages/fiscal-core/README.md).
- `parserVersion`, `schemaVersion`, `normalizerVersion`, `importedAt`, hash do
  artefato e datas da fonte são metadados distintos; DTOs expõem só os
  pertinentes ao consumidor autorizado (convenção, sem verificação).
- A evolução dentro de v1 é aditiva; mudança incompatível exige nova versão ou
  janela de migração publicada (convenção, sem verificação). O SDK não expõe
  tipos do banco ou do Convex (prova: `scripts/build/package-boundaries.test.ts`
  › "checks the real workspaces and connects the blocking command before CI
  approval").

### Identidades que não se substituem

| Identidade  | Chave e finalidade                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Solicitação | Organização + projeto + operação lógica + `Idempotency-Key`, com hash do pedido; recupera a intenção ou recusa com `409` |
| Documento   | Organização + empresa + ambiente + modelo + chave de acesso; pedidos diferentes podem apontar para a mesma nota          |
| Artefato    | SHA-256 dos bytes originais; distingue XMLs da mesma nota, conservando origem e conflito                                 |

As identidades da tabela são convenção, sem verificação, salvo a da
solicitação, provada acima. O hash não concede acesso nem deduplica entre
clientes (convenção, sem verificação). Um resumo que evolui para XML completo
mantém a identidade documental (prova: `platform/convex/documents.test.ts` ›
"summary then full XML and repeated/out-of-order events preserve a
reconstructible situation").

## Trabalho assíncrono e recuperação

A mutation grava a operação e agenda a execução na mesma transação (prova:
`platform/convex/operations.test.ts` › "falha da transação desfaz reserva,
operação e agendamento juntos"); Workpool limita a concorrência por domínio.
A operação tem `generation` e lease (`leaseUntil`): o resultado de uma
execução antiga não sobrescreve o de uma nova (prova:
`platform/convex/operations.test.ts` › "callback perdido é recuperado;
callback duplicado não rouba lease vigente"; prova:
`platform/convex/operations.test.ts` › "lease vencida rejeita resposta mesmo
antes de recuperar a geração"). Claim, lease, `generation`, estágio e
resultado só se escrevem em `operations.ts` e `lib/operationCore.ts` (prova:
`platform/convex/operationWrites.test.ts` › "só o núcleo do protocolo escreve
em operations"). O ciclo, os estados e a recuperação estão em
[OPERATIONS.md](OPERATIONS.md). Regras que valem para todos os workers:

- Distinguir falha transitória, rejeição definitiva e resultado externo
  incerto; só repetir automaticamente o que é comprovadamente idempotente
  (prova: `platform/convex/operations.test.ts` › "resultado incerto sem
  reconciliador pausa e recusa retry manual"; prova:
  `platform/convex/operations.test.ts` › "rejeição definitiva não agenda nova
  tentativa").
- Timeout ou queda entre a chamada externa e a persistência exige
  reconciliação antes de repetir: filas não dão exactly-once para efeitos fora
  do banco (prova: `platform/convex/operations.test.ts` › "falha transitória e
  ausência na reconciliação nunca liberam nova execução"). Na emissão, o
  reconciliador consulta a DPS antes de qualquer reenvio
  ([ISSUANCE.md](ISSUANCE.md)); na captura, o lote bruto e o NSU são
  persistidos antes de avançar o cursor ([CAPTURE.md](CAPTURE.md)).
- Próxima tentativa, backoff e orçamento de tentativas ficam persistidos
  (prova: `platform/convex/operations.test.ts` › "backoff, jitter e janela
  externa persistem; orçamento não reinicia no retry"); nenhuma action dorme
  esperando a fonte (convenção, sem verificação). Varreduras de recuperação
  são indexadas e limitadas por lote (prova:
  `platform/convex/operations.test.ts` › "recuperação lê no máximo um lote
  indexado, sem alterar operações futuras").
- Abortar uma execução impede passos futuros, mas não desfaz efeito fiscal já
  confirmado externamente (prova: `platform/convex/operations.test.ts` ›
  "abandonBeforeEffect volta a ready e pausa antes do efeito, nunca depois da
  resposta"); o retorno público informa essa distinção (convenção, sem
  verificação).
- O outbox de webhooks é gravado na mesma transação da alteração pública
  (prova: `platform/convex/webhooks.test.ts` › "rolls back public changes,
  outbox and scheduled deliveries together"); uma nova tentativa de entrega
  não cria evento lógico novo (prova: `platform/convex/webhooks.test.ts` ›
  "retries a failed attempt with the same event bytes and identity,
  verifiable by the receiver") ([WEBHOOKS.md](WEBHOOKS.md)).

## Documentos fiscais

O XML original é imutável e passa por representações separadas, sem exigir
quatro cópias no banco. O original servido confere com o hash gravado (prova:
`platform/convex/documents.test.ts` › "refuses to serve a hot original whose
stored file no longer matches the recorded hash (#110)"):

```text
XML original imutável
    → parsing → modelo específico do documento
    → normalização versionada
    → mapeamento autorizado → DTO público discriminado por modelo
```

Cada processamento identifica schema, parser e normalizador, com resultados
separados de parsing, XSD, assinatura e evidência fiscal. Reprocessar publica
uma versão completa nova sem alterar o original nem misturar resultados
parciais (prova: `platform/convex/documents.test.ts` › "reprocesses through
HTTP 202 using one operation and keeps old versions and exact items"). A
situação fiscal deriva de evidências preservadas por regra determinística,
reproduzível diante de repetição e ordem diferente (prova:
`platform/convex/documents.test.ts` › "summary then full XML and
repeated/out-of-order events preserve a reconstructible situation"); não há
event sourcing para os cadastros. Contratos em [IMPORTS.md](IMPORTS.md) e
[DOCUMENTS.md](DOCUMENTS.md).

## Certificados

PFX e senha são cifrados com AES-256-GCM por envelope versionado, com contexto
de organização, empresa e versão (prova:
`platform/convex/lib/certificateCrypto.test.ts` › "encrypts both secrets and
authenticates all context fields and every block"); o keyring vem de
`FNFE_PLATFORM_CERT_KEYS`, fora do banco (convenção, sem verificação). O
material só é aberto no runtime de
transporte, a API devolve metadados (validade, fingerprint, estado) e nunca o
segredo (prova: `platform/convex/certificates.test.ts` › "uploads encrypted
material, validates asynchronously and exposes metadata only"), e o uso é
auditado (convenção, sem verificação). A decisão está na
[ADR 0003](../adr/0003-cofre-de-certificados-da-plataforma.md); o contrato e a
rotação, em [CERTIFICATES.md](CERTIFICATES.md); a recuperação das chaves, em
[restauracao.md](../operacao/restauracao.md).

## Testes por camada

O que cada camada precisa cobrir é convenção, sem verificação: a revisão
confere, e [testes.md](../desenvolvimento/testes.md) diz como.

| Camada              | O que precisa estar coberto                                                        |
| ------------------- | ---------------------------------------------------------------------------------- |
| Pacotes puros       | CNPJ/CPF, decimais, schemas, parsing, normalização e hash                          |
| Persistência Convex | Autorização negativa, unicidade concorrente, cursor, claims, idempotência e outbox |
| Contrato HTTP       | Validação, erros, paginação, compatibilidade, revogação e limites                  |
| Transporte          | mTLS, timeout, resposta incerta, bloqueio de hosts e descompressão                 |
| Operação            | Falha em pontos de persistência, restore, rotação e reenvio                        |
| Consumidor          | SDK e curl contra a API de teste                                                   |

Os testes de integração ficam ao lado do módulo, em `platform/convex/`
(convenção, sem verificação), e todo arquivo de teste cai em exatamente um
projeto do Vitest (prova: `tests/ci.testProjects.test.ts` › "assigns every test
file to exactly one project and one report suite"). A escolha dos checks está na
seção "Verificando" do [AGENTS.md](../../AGENTS.md#verificando). Testes com
transporte simulado não comprovam integração fiscal real.
