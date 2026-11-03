# Webhooks da plataforma

Implementação em `platform/convex/webhooks.ts`, `webhookRest.ts`,
`webhookDelivery.ts`, `webhookWorker.ts` e `lib/webhook*`. O console usa a
área Webhooks dentro do projeto.

## Eventos e identidade

O contrato editável está em `packages/contracts/src/webhooks.ts`. O payload
contém apenas `eventId`, `type`, `version`, `occurredAt`, `environment`,
`companyId`, `resource: { type, id, version }` e `synthetic`, mais `data` só
em `connection.history_limited` (abaixo) e `resource.originalId` só num
recurso que voltou do arquivo econômico ([abaixo](#organização-arquivada)). Não contém XML,
dados de destinatários ou credenciais. Consulte o recurso pela API autenticada.

| Evento                    | Momento de criação                                                                                         | Escopo                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `document.received`       | Primeira versão publicada do documento reconhecido, inclusive resumo ou evento recebido antes da nota      | Organização, empresa e ambiente; destinos de projetos com consulta documental concedida |
| `document.updated`        | Publicação que altera o resultado público ou conclusão da projeção que altera a situação fiscal            | Mesmo escopo documental                                                                 |
| `document.event_received` | Primeira evidência fiscal de tipo evento, deduplicada por documento, hash do original e fingerprint fiscal | Mesmo escopo documental                                                                 |
| `import.completed`        | Todos os arquivos originais do lote terminaram com sucesso, falha definitiva ou expiração                  | Somente o projeto da importação                                                         |
| `webhook.test`            | Pedido explícito de teste, idempotente por destino e chave                                                 | Somente o destino solicitado, com `synthetic: true`                                     |

`document.event_received` sai na primeira vez que um evento completo
(`evento` ou `procEventoNFe`, nunca `resEvento`) entra no histórico do
documento, uma vez por hash do original e fingerprint fiscal: importar os
mesmos bytes de novo não o repete. Ele sai também para um evento recusado na
etapa XSD. O webhook chega antes da situação fiscal recalculada: confira o
evento em `fiscalSituation.excluded`, pelo `sha256` da versão do evento,
quando o `summary.projectionState` do documento for `ready`, ou depois do
`document.updated` que a projeção envia ao concluir com a situação alterada.
Enquanto a projeção está `pending`, a API devolve `fiscalSituation: null`.
Um evento que não muda a situação aparece com
`EVENT_DOES_NOT_CHANGE_FISCAL_STATUS`; um recusado no XSD, com
`TECHNICAL_VALIDATION_FAILED`. Um evento 110300 (Vinculação Pagamento) nunca
quer dizer pagamento confirmado
([NFE-SCHEMAS.md](NFE-SCHEMAS.md#vinculação-pagamento-110300)).

Eventos da [emissão NFS-e](ISSUANCE.md#webhooks), com recurso `issuance`
(consulte `GET /v1/issuances/{id}`), restritos ao projeto que pediu a emissão:

| Evento                           | Momento de criação                                                                   | Assinatura exige   |
| -------------------------------- | ------------------------------------------------------------------------------------ | ------------------ |
| `issuance.authorized`            | Checkpoint que grava a emissão como `authorized`, com a NFS-e preservada             | `documents:issue`  |
| `issuance.rejected`              | Rejeição definitiva gravada (`rejected`), do fisco ou local antes do envio           | `documents:issue`  |
| `issuance.cancelled`             | Checkpoint que registra o evento de cancelamento e grava a emissão como `cancelled`  | `documents:cancel` |
| `issuance.cancellation_rejected` | Rejeição do pedido de cancelamento gravada; a nota segue `authorized`, um por pedido | `documents:cancel` |

Cada um nasce na mesma transação da transição persistida e tem chave lógica
por emissão (e por pedido de cancelamento, na rejeição dele): reprocessar o
checkpoint ou reconciliar não cria outro evento. `resource.version` é a
`version` da emissão naquele momento. Emissão aceita (`processing`) não gera
evento; acompanhe pela consulta. O envelope continua só com identificadores.

`connection.attention_required` é emitido pela [captura](CAPTURE.md) quando
o stream entra em atenção. Usa recurso `connection` e fica restrito ao
projeto responsável. Assinatura exige `connections:read`, além de
`webhooks:manage`. Está disponível no painel e no contrato/SDK; não contém
CNPJ, XML, motivo fiscal livre ou informações de outro titular.

`connection.release_withdrawn` (contrato 6.0.0, #422) é o último evento de
uma captura em `production` no site: sai quando a liberação fiscal da empresa
que estava valendo é retirada, no console ou pela emergência da Freecorps,
com o stream já pausado (`CAPTURE_RELEASE_WITHDRAWN`, ou o código que ele já
tinha se estava pausado). Usa recurso `connection`, `resource.version` é a
versão do stream, que avança também quando o stream já estava pausado; a chave lógica é a do stream mais a versão da liberação
retirada, e fica restrito ao projeto dono do stream, como o evento de
atenção. Ele nasce na transação da retirada, antes de a liberação mudar. A
retirada tira de `production` o `webhooks:manage`, e com ele a entrega de
todo outro evento (`ACCESS_REVOKED`); só este continua entregue e retentado
depois dela, para o destino ativo que o assinou, conferido com a leitura que
a retirada mantém (`connections:read`), o `webhooks:manage` da própria
concessão e as mesmas épocas de projeto e concessão (`endpointAllowed`).
Encerrar a organização, revogar a concessão ou desativar o destino continuam
cortando. O corte geral por variável não emite o evento: nenhuma transação
retira a liberação.

`connection.history_limited` (contrato 8.0.0, #442) sai quando o Proprietário
aceita no console a perda de um trecho que a Receita não tem mais, numa
captura ativada por uma integração
([lacunas](CAPTURE.md#lacunas-e-histórico-limitado-419)). Nasce na transação
da aceitação, com recurso `connection`, `resource.version` igual à versão
que a aceitação deu ao stream e chave lógica do stream mais essa versão, e
fica restrito ao projeto dono do stream, como os outros `connection.*`;
assinatura exige `connections:read`. Repetir a confirmação não cria outro
evento, e uma aceitação recusada não cria nenhum. A captura do console não o
emite. É o único evento com `data`, porque o intervalo perdido não aparece
em nenhuma leitura da API e não muda depois:

```json
"data": {
  "lost": { "from": "000000000000002", "to": "000000000000040" },
  "decidedBy": "owner"
}
```

`lost` são os NSU, de 15 dígitos, que a captura não vai entregar;
`decidedBy` é o papel de quem decidiu, sempre `owner`. O motivo escrito no
console e a pessoa não saem: o motivo é texto livre que pode citar terceiros,
e o id da membership não serve à integração
([ADR 0008](../adr/0008-perda-fiscal-em-captura-de-integracao.md#evento-da-perda-aceita)).
`verifyWebhook` recusa com `BODY_INVALID` este evento sem `data` válido e
qualquer outro evento com `data`.

A outbox e as entregas nascem na mesma transação da mudança pública. Cada
evento guarda o JSON serializado, que permanece idêntico nas retentativas.
Documento tem sequência monotônica `publicVersion`, exposta como
`summary.resourceVersion` na consulta. Documentos anteriores começam em zero
até sua primeira mudança notificada. Versão do envelope e versão do recurso
são coisas distintas. Uma importação concluída tem versão 1; reprocessamento
de um arquivo não reabre o lote original. Operação pausada ainda não terminou.

Uma repetição da publicação ou ingestão equivalente não cria outro evento de
documento. Uma nova reserva de importação tem seu próprio evento de conclusão,
mesmo quando contém um documento já conhecido. Alterações técnicas de
indexação sem mudança da situação fiscal não geram `document.updated`.

`eventId` identifica a mudança lógica. `deliveryId` identifica o par evento e
destino. Tentativas são registros distintos, numerados e protegidos pela
geração e lease. Reenvio preserva os dois IDs. A entrega é pelo menos uma vez,
dentro do orçamento e enquanto o destino continua autorizado. Não há garantia
de ordem ou de exatamente uma vez; falhas esgotadas ficam visíveis para ação.

## Assinatura e verificação

Headers, com nomes tratados sem distinção de caixa pelo HTTP:

```text
Content-Type: application/json
X-Fnfe-Webhook-Version: 1
X-Fnfe-Event-Id: <eventId>
X-Fnfe-Delivery-Id: <deliveryId>
X-Fnfe-Resource-Version: <inteiro decimal>
X-Fnfe-Signature: t=<epoch-ms>;k=<versão-segredo>,v1=<hmac-hex>
```

O HMAC-SHA256 assina a concatenação dos bytes UTF-8 do prefixo abaixo com
os bytes originais do corpo, sem parsear ou serializar o JSON novamente:

```text
<timestamp>.<versão-segredo>.<versão-envelope>.<eventId>.<deliveryId>.<versão-recurso>.
```

O segredo é a string UTF-8 completa, incluindo `whsec_`. O timestamp é gerado
a cada tentativa. Os headers identificadores também ficam autenticados. Na
rotação, o header carrega até duas entradas `k=...,v1=...`, separadas por `;`.
Cada uma inclui sua própria versão no prefixo assinado.
O assinador exige uma ou duas chaves ativas, com versões inteiras distintas
de 1 a 999.999.999; conjuntos fora desse contrato são recusados antes do HMAC.

`verifyWebhook({ body, headers, secrets, now, toleranceMs })` recebe
`Uint8Array`, nomes de headers em minúsculas, segredos com versão e
`validUntil` opcional, e relógio do consumidor em milissegundos. Retorna
resultado tipado: sucesso ou `HEADERS_INVALID`, `TIMESTAMP_INVALID`,
`SIGNATURE_INVALID`, `BODY_INVALID`. Não faz rede, consulta Convex nem controla
fila. A comparação criptográfica usa Web Crypto. Node 22.15 com
`--experimental-strip-types` e Node 24 executam o exemplo; a função usa APIs
Web Crypto/TextEncoder, sem dependência de Node no contrato.

A tolerância padrão é 300.000 ms para passado **e** futuro. O consumidor deve
manter o relógio sincronizado. Uma assinatura velha é rejeitada. Uma
retentativa legítima leva timestamp novo e o mesmo evento; depois de verificar
a assinatura, o receptor reconhece o evento e responde 2xx sem repetir o
efeito. Verificação criptográfica não substitui deduplicação.

O exemplo `examples/webhook-receiver.mjs` usa SQLite. Deduplicação, última
versão e o efeito demonstrativo são gravados na mesma transação. O receptor
confirma duplicatas e versões antigas com 204. Para sobreviver a reinício,
forneça um arquivo SQLite persistente; `:memory:` serve apenas ao ensaio.
Efeitos em outros sistemas exigem sua própria transação/outbox ou idempotência.

## Destinos, permissões e segredos

Cada destino pertence a organização, projeto, empresa e ambiente imutáveis.
No site, um destino de `production` só é cadastrado para empresa com a
captura fiscal liberada ([liberação fiscal](CAPTURE.md#liberação-fiscal-no-site)), e
ali só nascem os eventos documentais da NF-e capturada e os `connection.*`:
importação e emissão não rodam em `production` no site.
Cadastro e gestão exigem `webhooks:manage`. Eventos documentais exigem também
`documents:read`; conclusão de importação exige `documents:import`; eventos
de emissão exigem `documents:issue` ou, para cancelamento, `documents:cancel`
(regra única em `webhookEventScope`, usada pelo servidor e pelo console). Um
destino pode assinar todo o catálogo de eventos. Chaves só
operam dentro das próprias concessões. Humanos usam os helpers vigentes da
plataforma, incluindo concessões de empresa e controle do projeto. Login por
si só não autoriza gestão. Viewer e developer sem projeto concedido são negados.
Após redução das concessões, a edição remove da seleção os eventos que não
podem mais ser assinados. Desativar exige gestão do webhook, sem exigir a
permissão de receber os eventos antigos quando a seleção permanece igual.
Qualquer mudança da seleção, mesmo inativa, e toda reativação conferem as
permissões dos eventos solicitados.

Projetos, empresas, ambientes e épocas de concessão são conferidos novamente
antes de cada envio. Revogar e conceder novamente não ressuscita um destino
antigo automaticamente; a edição autorizada atualiza suas concessões. Um envio
já em trânsito não pode ser recolhido depois de uma revogação.

São permitidos até 20 destinos cadastrados por empresa e ambiente. A mesma
transação lê no máximo esse conjunto para distribuir o evento. Listagens de
entregas são paginadas, com até 50 por página. Cadastro, edição, rotação, teste
e reenvio usam o rate limiter existente. Não há contador global por entrega.

Segredos aleatórios de 256 bits aparecem somente na resposta de criação ou
rotação. O banco guarda AES-GCM, com ID do destino e versão como dados
autenticados. `FNFE_WEBHOOK_MASTER_KEY` é uma chave hexadecimal de 32 bytes
do deployment, diferente do segredo de autenticação. O setup gera uma chave
local exclusiva; operações remotas precisam configurar a chave no cofre/env.
Trocar essa chave sem recifrar os registros torna os segredos indisponíveis.

Rotação permite coexistência de zero a 24 horas. Outra rotação é recusada
enquanto houver coexistência. Após o prazo, a chave antiga não assina, e uma
mutation agendada remove seu ciphertext. No receptor, configure também
`validUntil`; conservar um segredo antigo sem prazo amplia sua confiança.
O painel descarta o segredo ao fechar ou trocar de contexto.

## Transporte e recuperação

Cadastro aceita URL HTTPS com nome DNS, porta 443, sem credenciais, query
string ou fragmento. Cadastro valida sintaxe; o resultado da conexão aparece
no teste/histórico. Cada conexão resolve o nome novamente e recusa qualquer
resposta DNS privada, reservada, loopback, link-local ou metadata, em IPv4 e
IPv6. O endereço aprovado é fixado no `lookup` do socket. SNI e validação TLS
permanecem ativos. Não há pool de sockets reutilizados ou redirects seguidos.
O teste sintético percorre exatamente esse transporte.

DNS e requisição compartilham prazo de 15 segundos. Corpo remoto nunca é
persistido: o histórico conserva HTTP, duração e uma mensagem fixa. Isso
evita guardar XML, segredos ou dados pessoais devolvidos por terceiros.

| Resultado                                  | Decisão                                          |
| ------------------------------------------ | ------------------------------------------------ |
| 2xx                                        | Entrega confirmada                               |
| 3xx e 4xx, exceto 429                      | Falha definitiva; corrigir destino e reenviar    |
| 429, 5xx e falha de rede                   | Retry limitado                                   |
| DNS/IP recusado ou assinatura indisponível | Falha visível, sem retry automático              |
| Envio desativado ou concessão revogada     | Pausa visível antes da rede                      |
| Lease vencida ou resposta perdida          | Nova tentativa do mesmo evento, com geração nova |

Cada ciclo permite até seis tentativas, com base de backoff de 5 segundos,
duplicada por tentativa, jitter de até 25% e teto de uma hora.
`Retry-After` aceita segundos ou data HTTP, limitado a 24 horas. Datas futuras
são persistidas e respeitadas antes de enfileirar no Workpool, sem action
dormindo. Lease é de 60 segundos. Resultado tardio de geração antiga ou lease
vencida não altera a entrega atual. Recuperação de fila também tem orçamento.
O Workpool de webhook existente limita a concorrência a quatro actions.

Há até três reenvios manuais, cada um auditado e idempotente pela chave e
geração esperada. Podem reenviar inclusive uma entrega confirmada, avisando
ao operador que o efeito no consumidor precisa ser deduplicado.

`WEBHOOK_MODE=disabled` continua sendo o padrão dos worktrees e da validação.
Habilitar `https` é uma decisão operacional explícita para aquele deployment.
O runner da entrega de webhooks habilita apenas seu banco local sintético, usa receptor
temporário e restaura `disabled` no `finally`. Não altera os gates fiscais.

O aceite funcional consolidado distingue
a entrega comprovada ao receptor HTTPS de teste da ativação no serviço
hospedado. O release registrado na #84 manteve webhooks desativados. Em
07/10/2026, por autorização do mantenedor, o serviço hospedado passou a
`WEBHOOK_MODE=https`, com entrega e reenvio comprovados.
Em 21/10/2026, rotação de segredo e isolamento
foram comprovados no mesmo serviço, pelo Worker público, sem alterar o gate.
O publicador exige `https` nas atualizações (`release`) e `disabled` somente
no `bootstrap`; veja [deploy-producao.md](../operacao/deploy-producao.md). Outras instalações continuam
exigindo decisão operacional e prova de entrega no deployment escolhido.
Um teste com transporte desativado fica pausado com `DELIVERY_DISABLED`;
não comprova entrega. O aceite da #73, sozinho, não habilita um ambiente.

## REST e painel

Todas as rotas exigem `Authorization: Bearer ...` e `X-Environment` igual ao
ambiente da chave (`sandbox` ou `production`); outro valor responde
`ENVIRONMENT_DENIED`. O destino nasce no ambiente da chave.
Erros e respostas carregam `requestId`, com `Cache-Control: no-store`.

| Rota                                                            | Entrada                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `POST /v1/webhook-endpoints`                                    | `{ companyId, name, url, events }`; resposta contém destino e segredo único |
| `GET /v1/webhook-endpoints?companyId=...`                       | Destinos do projeto e empresa, sem segredos                                 |
| `GET /v1/webhook-endpoints/:id`                                 | Metadados do destino autorizado                                             |
| `PATCH /v1/webhook-endpoints/:id`                               | `{ expectedVersion, name, url, events, active }`                            |
| `POST /v1/webhook-endpoints/:id/rotate-secret`                  | `{ expectedVersion, overlapMs }`; segredo único                             |
| `POST /v1/webhook-endpoints/:id/test`                           | `{}` e `Idempotency-Key`, de 8 a 128 caracteres alfanuméricos, `_` ou `-`   |
| `GET /v1/webhook-deliveries?endpointId=...&limit=20&cursor=...` | `{ items, nextCursor }`, com estado, tentativa, duração, próxima data e IDs |
| `POST /v1/webhook-deliveries/:id/retry`                         | `{ expectedGeneration }` e `Idempotency-Key`                                |

Criação usa POST sem retry automático. Edição e rotação usam versão esperada,
portanto uma resposta perdida requer consultar metadados antes de nova ação;
o segredo não pode ser recuperado. Se a resposta do cadastro se perder,
confira os destinos existentes antes de cadastrar outro. `Idempotency-Key`
garante replay apenas nas rotas de teste e reenvio deste módulo; cadastro é
síncrono e não oferece essa garantia. Teste e reenvio mantêm a identidade quando
repetidos. Alterar a URL muda as próximas conexões. A seleção de eventos vale
para novos eventos; entregas existentes preservam o corpo e o destino lógico
escolhido ao criar a outbox. Desativar o destino pausa entregas pendentes.

No console, abra `/app/:organizacao/developer/webhooks/:projeto` e escolha a
empresa. O seletor lista todas as empresas concedidas ao projeto; as que não
têm `webhooks:manage` ou o ambiente escolhido aparecem marcadas e,
selecionadas, explicam o que falta, com link para Empresas e acesso. Sem nenhum
evento assinável, "Novo destino" fica indisponível e o motivo indica os
escopos dos eventos (documentos, emissão ou captura). Desativar um destino
pede confirmação; o segredo de criação ou rotação tem botão Copiar e aviso de
uso único. Para uma empresa com a captura fiscal liberada, o campo "Ambiente"
escolhe Sandbox ou Produção (`?env=`), com os mesmos nomes das outras telas, e
o selo do cartão diz o ambiente dos destinos mostrados.
`?company=...&endpoint=...` preserva o detalhe no reload e no acesso
direto. IDs inválidos ou de outro contexto mostram indisponibilidade. As
queries são assinaturas Convex; o histórico muda quando o servidor persiste
tentativa, backoff, pausa ou confirmação.
O formulário conserva a versão do destino no momento em que a edição começa.
Se outra pessoa alterar o destino, salvar o rascunho antigo retorna conflito;
feche e reabra a edição para trabalhar com os dados atuais.

### Organização arquivada

Com a organização em custódia fria, do congelamento ao fim da reidratação
([ADR 0009, §§2-3](../adr/0009-custodia-fria-de-organizacoes-abertas.md#3-estado-arquivado-e-recusa-de-admissões)),
a chave e o console mantêm três ações: listar os destinos
(`GET /v1/webhook-endpoints?companyId=...`, cobrada em `restReads`),
desligar um destino (`PATCH /v1/webhook-endpoints/:id` com `active: false` e
`name`, `url` e `events` iguais aos atuais) e rotacionar o segredo. Elas
passam por um caminho próprio (`keptWebhookAccess` e `keptEndpointAccess`, em
`lib/webhookAccess.ts`), que confere chave ou membro, projeto ativo, empresa
e a concessão com `webhooks:manage` no ambiente, sem a recusa do arquivo e
sem ler dado fiscal. O `PATCH` que liga o destino ou muda outro campo, a
leitura de um destino (`GET /v1/webhook-endpoints/:id`), o teste, as entregas
e o reenvio respondem `ORGANIZATION_ARCHIVED` (409). As demais rotas da API
continuam recusadas por `companyScopeAccess`, que não perde a recusa: uma
repetição idempotente responde o arquivo antes de ler o registro. Uma chave de
outra organização não alcança esse caminho e recebe `NOT_FOUND`.

A reidratação da organização aberta (ADR 0009, §5) não enfileira eventos:
nada do histórico é entregue de novo, e a integração lê o estado atual pela
API. Os eventos já registrados no outbox continuam com os IDs anteriores.

Depois da reativação, um evento novo de documento, importação ou emissão que
voltou do arquivo traz em `resource.id` o ID atual e em `resource.originalId`
o primeiro ID do recurso (ADR 0009, §6), para o receptor que deduplica pelo ID
reconhecer o recurso que já conhece. Um recurso nunca arquivado e as conexões
de captura, que mantêm o ID, não têm o campo. O envelope continua na versão
`1`: `verifyWebhook` aceita `originalId` ausente ou um texto não vazio e
diferente de `resource.id`, recusa com `BODY_INVALID` um valor vazio ou igual
a `resource.id`, e um verificador anterior ignora o campo.

## Verificar

```powershell
bun run -- vp test run tests/platform.webhooks.test.ts tests/webhookContract.test.ts tests/webhookTransport.test.ts
node --experimental-strip-types scripts/prove-webhook-contract.mjs
node --experimental-strip-types scripts/prove-webhooks.mjs
```

O último comando exige o worktree `--app platform` em execução e Chromium do
Playwright. Defina `FNFE_PROOF_CLOUDFLARED` com o caminho do binário oficial
`cloudflared`, ou coloque-o em `.ci-results/73/cloudflared.exe`. O runner abre
um [Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
somente para o receptor sintético. Não publica o console ou o backend. O
receptor recusa assinaturas inválidas e não serve arquivos locais.

Recibos da entrega e limitações ficam em evidence/73.

Os vetores sintéticos versionados de produtor/consumidor estão em
`packages/contracts/fixtures/webhooks.json`. O runner do receptor também
confere a persistência da deduplicação após reabrir o SQLite. Node 22.15 com
`--experimental-strip-types` foi usado na prova; o receptor de referência
requer `node:sqlite`. O verificador usa somente WebCrypto e UTF-8.

A integração pelo SDK exporta esse mesmo verificador em `@freecorps/freecorpsnfe-sdk/webhooks`, com prova
dos vetores a partir do pacote instalado fora do repositório. O receptor
`examples/sdk-webhook-receiver.mjs` acrescenta consulta documental autenticada
antes de persistir o efeito e guarda o intervalo de `connection.history_limited`. Veja [instalação e quickstart](../v1.0/SDK.md) e
evidências M3-SDK.
