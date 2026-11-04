# Quem aceita a perda fiscal numa captura de integração

Data: 25/10/2026 · Status: **Aceita** pelo dono do projeto em 26/10/2026,
com as três decisões registradas em
[Decisões do dono em 26/10/2026](#decisões-do-dono-em-26102026): só o
Proprietário aceita a perda, com motivo; a exceção à ADR 0005, §1 fica
aceita; a integração recebe o evento `connection.history_limited`. Os PRs da
#442 implementam a opção (b) com essas regras.

## Contexto

A #419 (PR #440) criou "Aceitar a perda e continuar": quando a recuperação de
uma lacuna confirma, pelo 137 do `consNSU`, que a Receita não tem mais o
começo da lacuna, o stream fica em atenção com `RECONCILIATION_UNAVAILABLE`
até alguém aceitar a perda do trecho. A ação ficou só no console, só para
Proprietário ou Administrador, e só para a captura do projeto do console. A
razão, registrada no #440 e no adendo de 23/10/2026 da
[ADR 0007](0007-captura-fiscal-no-site.md#adendo-de-23102026-lacunas-recuperação-em-lote-e-perda-aceita):
aceitar uma perda fiscal é decisão de uma pessoa com papel, auditável a ela,
e uma chave de API não tem nem uma coisa nem outra.

Uma captura ativada por integração (`POST /v1/connections/nfe` com a chave do
projeto) que cai nessa lacuna fica sem saída. A reprodução está em
`platform/convex/lib/captureGap.test.ts`, bloco "captura de integração em lacuna
irrecuperável (#442)", e o resultado antes da correção em
evidence/442:

- **API e SDK.** Retomar pela chave pergunta de novo o primeiro NSU da
  lacuna, recebe o mesmo 137 e volta à atenção no mesmo checkpoint. Cada
  retomada gasta uma consulta pontual e não muda nada. Não há ação de aceitar
  a perda, e o `GET` não mostra o trecho perdido.
- **Console.** `captures.acceptGap` responde `INTEGRATION_RECORD`, e o painel
  diz que a decisão cabe a quem administra a integração, sem botão.
- **Transferência.** `captures.release` também responde `INTEGRATION_RECORD`
  e, mesmo para uma captura do console, recusa um stream em `consNSU` ou com
  checkpoint abaixo do cursor da fonte (`RECONCILIATION_REQUIRED`), que é
  exatamente o estado da lacuna. Receber um código na mesma organização e
  empresa dá `TRANSFER_NOT_FOUND` (#461).

A issue cita "API key ou Stripe". Hoje só a chave ativa captura: a conexão
Stripe não tem entrada de captura (`stripe.ts`, `stripeRest.ts`), e
`releaseSourceFor` só troca a origem de uma captura do console.

## Opções

| Critério                       | (a) Ação na API e no SDK                                                                                                                               | (b) Gestor decide no console também na captura de integração                                                                                                                                                                          | (c) Transferir o stream para o console                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quem decide                    | O software da integração, com uma chave de escopo novo. Nenhuma pessoa precisa ver a perda.                                                            | Uma pessoa com papel, a mesma da captura do console. Pela decisão de 26/10/2026, só o Proprietário, com motivo escrito.                                                                                                               | Proprietário ou Administrador, depois de tirar a captura da integração.                                                                                       |
| Auditoria                      | `key:<id>`: um projeto, não uma pessoa.                                                                                                                | `history_limited` com `member:<id>`, intervalo e versão confirmada; `capture.history_limited` no log operacional com o projeto da integração. O console mostra quem e quando.                                                         | Registros de transferência e depois `history_limited` com a pessoa.                                                                                           |
| Risco fiscal                   | Uma integração pode aceitar perdas sozinha, num laço de retentativa, sem que a empresa saiba. A perda continua limitada ao trecho que o 137 confirmou. | O mesmo de hoje no console. A integração não é consultada; ela vê a captura ativa, o checkpoint novo e `HISTORY_LIMITED` até a próxima resposta.                                                                                      | O mesmo de (b) na perda. A integração perde a captura: o `GET` da chave passa a `null` e a ativação dá `STREAM_CONFLICT`, sem volta pela API.                 |
| Console                        | Sem mudança.                                                                                                                                           | Botão e diálogo na captura de integração, só para gestor; o resto continua com a integração.                                                                                                                                          | Ação nova "assumir a captura" e mudança na transferência.                                                                                                     |
| REST, SDK e contratos          | Ação nova em `POST /v1/connections/nfe`, trecho perdido no `GET`, escopo novo nas chaves e concessões, versão do contrato, OpenAPI, SDK e docs.        | Sem mudança.                                                                                                                                                                                                                          | Sem mudança na API; a chave perde o stream.                                                                                                                   |
| Webhooks                       | Talvez um evento da perda aceita.                                                                                                                      | Sem evento novo; `connection.attention_required` continua avisando a entrada em atenção.                                                                                                                                              | Os eventos `connection.*` passam ao projeto do console, que não tem webhooks.                                                                                 |
| Retentativa e idempotência     | Intervalo e `expectedVersion`, como no console.                                                                                                        | Intervalo e versão; repetir a confirmação devolve o stream como está. A próxima consulta continua a da integração, com a chave dela; sem acesso da integração, nada é gravado (`INTEGRATION_ACCESS_REVOKED`).                         | Duas ações em sequência, cada uma com a própria versão.                                                                                                       |
| Conflito com decisões e o #440 | Contraria o #440 e o adendo da ADR 0007 ("não existe na API").                                                                                         | Segue o #440 e o adendo da ADR 0007. Diverge da [ADR 0005](0005-console-sem-projeto.md), §1: "Lotes, operações e capturas de integração [...] são lidos mas não alterados pelo console". Vira a segunda exceção, como cancelar NFS-e. | Diverge da ADR 0005 do mesmo modo e muda o dono do stream; a transferência teria de aceitar um stream em lacuna, que hoje recusa (`RECONCILIATION_REQUIRED`). |

## Decisões do dono em 26/10/2026

1. **Quem aceita.** Só o Proprietário aceita a perda fiscal, com motivo
   obrigatório gravado na auditoria. A regra vale para toda captura, a do
   console e a da integração, para que as duas sigam o mesmo critério: um
   Administrador não aceita a perda em nenhuma delas. O resto da opção (b)
   fica como proposto; a captura de integração continua na integração, com a
   chave, o projeto e os webhooks dela.
2. **Exceção à ADR 0005, §1.** Aceita. Aceitar a perda é a segunda escrita do
   console num registro de integração, depois de cancelar NFS-e. A
   [ADR 0005](0005-console-sem-projeto.md#situação-em-26102026) recebeu uma
   situação datada; pausar, retomar, sincronizar e transferir a captura de
   integração continuam fora do console (`INTEGRATION_RECORD`).
3. **Aviso à integração.** A integração recebe um webhook próprio,
   `connection.history_limited`, quando o Proprietário aceita a perda. A
   decisão olha o longo prazo: a integração não deve depender de consultar o
   `GET` para saber que o histórico ficou limitado. O evento está descrito
   em [Evento da perda aceita](#evento-da-perda-aceita).

O adendo de 23/10/2026 da
[ADR 0007](0007-captura-fiscal-no-site.md#adendo-de-23102026-lacunas-recuperação-em-lote-e-perda-aceita)
dizia "só Proprietário ou Administrador" e "só no console" para a captura do
console. Ele não foi reescrito: recebeu uma situação datada que aponta para
esta ADR.

## Recomendação

A opção (b), com a regra decidida pelo dono. Ela mantém a razão do #440: quem
aceita é uma pessoa com papel, e o registro aponta para ela e para o motivo
que ela escreveu. A captura continua da integração: a consulta
seguinte é uma continuação da operação parada (`continueOperation`), no
projeto, com a chave e sob os webhooks da integração, e o console não ganha
pausar, retomar nem transferir. A integração não precisa mudar nada e a API
não muda. (Pela decisão 3, o contrato ganhou depois só o evento da perda
aceita; a ação continua fora da API.)

A (a) entrega a decisão a quem o #440 disse que não deve tê-la e custa uma
versão de contrato. A (c) resolve uma decisão trocando o dono do stream: a
integração perde a captura e não tem como recuperá-la pela API, e a
transferência teria de aceitar justamente o estado que hoje ela recusa.

O que cabia ao dono decidir, todos decididos em 26/10/2026:

1. ~~Quem pode aceitar a perda de uma captura que uma integração ativou.~~
   Só o Proprietário, com motivo obrigatório, também na captura do console.
2. ~~Se a exceção à ADR 0005, §1 fica aceita.~~ Aceita; a ADR 0005 recebeu
   uma "Situação" datada.
3. ~~Se a integração precisa de um aviso próprio da perda aceita.~~ Sim:
   `connection.history_limited`. Antes dele, ela só via `HISTORY_LIMITED` no
   `GET` até a próxima resposta da fonte.

## Como a opção (b) funciona

- `captures.acceptGap` confere o papel de Proprietário (`requireOwner`;
  Administrador e os outros papéis recebem `ACCESS_DENIED`), o motivo (sem
  espaços nas pontas, de 1 a 500 caracteres, sem caracteres de controle;
  senão `GAP_REASON_INVALID`), acesso de escrita à empresa
  (`captureAccess`), versão, intervalo e operação parada, e não exige mais o
  projeto do console. O motivo fica em `history_limited` (`lost.reason`), ao
  lado da pessoa, do intervalo e da versão. O log operacional não leva texto
  livre e continua só com a ação e a pessoa.
- Na captura de integração, antes de gravar qualquer coisa, a ação monta a
  continuação da operação parada com o A1 atual da empresa
  (`siteCapturePin` no site, o A1 ativo e utilizável fora dele) e confere a
  origem dela (`executionAllowed`): chave revogada ou vencida, projeto
  desativado ou concessão sem `connections:write` ou sem o ambiente dão
  `INTEGRATION_ACCESS_REVOKED`. A empresa precisa então que a integração
  retome com uma chave válida; a perda volta a poder ser aceita.
- Na captura do console, nada muda: a próxima consulta é do projeto do
  console, com a pessoa como origem.
- O console mostra o botão secundário "Aceitar a perda e continuar" só para o
  Proprietário, também na captura de integração, com o nome dela no aviso e
  no diálogo. O diálogo pede o motivo e só confirma com ele. Administrador,
  Operador e Leitura leem "Somente o Proprietário decide aceitar a perda e
  continuar."; na captura de integração, também "sincronizar, pausar,
  retomar e transferir ficam com a integração. Aqui, só o Proprietário aceita
  perdas.", que aparece também depois da perda aceita.
  A lista de perdas aceitas mostra quem, quando e o motivo.
- Na captura de integração, a mesma transação que grava a perda emite
  `connection.history_limited` pela outbox (abaixo). Na captura do console,
  nenhum evento: o projeto do console não tem webhooks.

## Evento da perda aceita

`connection.history_limited` segue os outros `connection.*`: recurso
`connection` (o stream), `resource.version` igual à versão que a aceitação
deu ao stream, só para os destinos do projeto dono do stream que assinaram o
evento, com `connections:read` e `webhooks:manage`. Nasce na transação da
aceitação, pela outbox, com a mesma assinatura, retentativa e reenvio dos
outros eventos. A chave lógica é o stream mais essa versão. Uma repetição da
confirmação devolve o stream como está antes de chegar ao evento, e uma
aceitação recusada (papel, motivo, versão, intervalo,
`INTEGRATION_ACCESS_REVOKED`) desfaz a transação inteira: um evento por
aceitação.

Diferente dos outros eventos, este leva um campo `data`:

```json
{
  "type": "connection.history_limited",
  "resource": { "type": "connection", "id": "<stream>", "version": 7 },
  "data": {
    "lost": { "from": "000000000000002", "to": "000000000000040" },
    "decidedBy": "owner"
  }
}
```

(Os demais campos do envelope não mudam.) Por que dados no envelope, contra
a regra de "só identificadores":

- **O fato não está em nenhum outro lugar da API.** O `GET` mostra o
  checkpoint e `HISTORY_LIMITED` até a próxima resposta, não o intervalo
  perdido, e não há leitura das perdas aceitas para a chave. Com só
  identificadores, a integração receberia o aviso sem saber o que perdeu.
- **O fato não muda.** A regra de reler o recurso existe porque documentos e
  emissões mudam depois do evento e porque a leitura confere de novo a
  autorização. Um intervalo perdido é fixo; a entrega já confere o acesso do
  destino a cada tentativa (`endpointAllowed`).
- **Ampliar o `GET` custaria mais.** As respostas do contrato são estritas:
  um campo novo em `/v1/connections/nfe` faria todo SDK anterior recusar a
  resposta da captura, não só o de quem assina o evento.

O que fica de fora, pela LGPD (art. 6º, III, necessidade) e pelo que os
outros eventos já excluem:

- **O motivo.** É texto livre que o Proprietário escreve para a auditoria da
  própria empresa e pode citar pessoas, contatos ou fornecedores. Um webhook
  sai para o sistema de um terceiro, fica nos logs dele e não pode ser
  recolhido depois de enviado. `connection.attention_required` já não leva
  "motivo fiscal livre"; o log operacional também não guarda texto livre. O
  motivo continua no console, em "Histórico limitado por decisão
  registrada".
- **A pessoa.** O nome, o e-mail e o id da membership identificam alguém e
  não servem à integração, que não tem como resolver um id de membership pela
  API. O papel basta para ela saber que quem decidiu foi uma pessoa da
  organização no console, não a chave dela. `decidedBy` é sempre `owner`
  enquanto a decisão 1 valer; mudar quem decide muda o contrato.

Contrato 8.0.0: o evento amplia o enum de eventos, e o comparador do
contrato exige major para isso, como na 4.0.0 e na 6.0.0. O envelope continua
na versão `1`: `data` é opcional e só aparece neste evento.

Detalhes em [CAPTURE.md](../plataforma/CAPTURE.md#lacunas-e-histórico-limitado-419)
e [WEBHOOKS.md](../plataforma/WEBHOOKS.md).
