# Distribuição de NF-e

O aceite técnico consolidado cobre transporte
controlado, coordenação e recuperação. A #50 fez uma
consulta fiscal real em 05/10/2026, em homologação,
e duas em produção em 20/10/2026, todas sem
documentos. A rodada de 22/10/2026, em
produção e com outra empresa, capturou 100 envelopes e retomou do checkpoint
persistido, com avanço real do NSU. A NF-e indicada pela empresa estava além
do último NSU dessa rodada. Na mesma noite, a
captura no site leu a fila da
mesma empresa até o NSU 2551 e trouxe essa nota só como resumo, no NSU 2527.
A chave confere com a indicada, e o mantenedor aceitou essa conferência em
26/10/2026 no lugar de uma nova rodada.

A captura usa empresa declarada, projeto concedido (na API) e certificado A1
ativo. Em `sandbox`, o site não consulta a fonte: a consulta termina com
`FISCAL_TRANSPORT_DISABLED`. Em `production`, o site lê a distribuição real
só para a empresa que ligou a captura fiscal
([liberação fiscal no site](#liberação-fiscal-no-site), ADR 0007). O painel
da empresa oferece ativação, pausa, retomada e sincronização nos dois
ambientes, sem projeto ([ADR 0005](../adr/0005-console-sem-projeto.md)):
pessoas com acesso à empresa veem a captura dela qualquer que seja o projeto dono, e
controlam só a do projeto do console (escrita para owner/admin/operator;
transferência só para gestores); a captura ativada por uma integração responde
`INTEGRATION_RECORD` no console e é gerida pela API dela. Captura
ativada no painel pertence ao projeto do console, e a chave de uma integração
não a enxerga nem ativa outra para o mesmo CNPJ (`STREAM_CONFLICT`); os
documentos capturados continuam disponíveis a chaves com `documents:read`. A API oferece `GET /v1/connections/nfe?companyId=…` e
`POST /v1/connections/nfe` com `companyId`, `action` e, exceto na ativação,
`expectedVersion`. Consulta exige `connections:read`; comandos exigem
`connections:write`, ambiente e empresa concedidos. Não há entrada de NSU na
API. A única ação que move o checkpoint sem um documento recebido é "Aceitar a
perda e continuar", só no console, só para o Proprietário e com motivo, também
numa captura de integração (#442);
é a única escrita do console nela
([lacunas](#lacunas-e-histórico-limitado-419)).

## Fonte e cobertura

Conferência em 23/09/2026: [NT 2014.002 v1.40, julho de 2026](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=uWO2d%2FgTuWg%3D),
SHA-256 `156dcb170e205c076a6da86aedf56a04afcec3aef8e373dd7fbf7ccb068da029`.
O [pacote de distribuição 1.04](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=IzuP2y0G6hk%3D)
foi baixado novamente e conserva o SHA-256
`9bd6d478dd04770016783a914111f3e2cc794c6a2f2b62ac7243fb101c138740` do
manifesto em `packages/fiscal-nfe/schemas/manifest.json`. Os layouts de
requisição/resposta são 1.01; a versão do pacote não é a versão do XML.

As relações oficiais de [homologação](https://hom.nfe.fazenda.gov.br/portal/webServices.aspx)
e [produção](https://www.nfe.fazenda.gov.br/portal/webServices.aspx) fixam
`hom1.nfe.fazenda.gov.br` e `www1.nfe.fazenda.gov.br`, respectivamente,
no caminho `/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx`. O transporte envia
SOAP por POST com mTLS, valida host/cadeia, recusa redirect e IP privado e
limita tempo e resposta. Destinos não vêm do usuário.

A identidade de consumo é CNPJ completo de 14 posições + ambiente + serviço,
mesmo quando a fonte autentica pela raiz do CNPJ. O cofre conserva a política
da proteção de certificados: certificado da mesma empresa cadastrada. Existe um único responsável
interno pelo stream, inclusive entre organizações e projetos. Isso não impede
outro software de consultar o CNPJ diretamente. Bloqueio 656 evidencia
conflito de consumo, sem provar quem o causou.

A fonte fornece resumos, NF-e processada e eventos de interesse do ator,
sem garantir XML completo ou todo o histórico. A disponibilidade retroativa
é limitada a 90 dias; a geração de NSU começa conforme a utilização e pode
ser suspensa após 60 dias sem consulta. Manifestação automática está desligada.
NFC-e, NFS-e e CT-e não são adicionados por este conector.

Um evento capturado (`procEventoNFe` ou `resEvento`) entra no histórico da NF-e
quando o tipo é aceito: cancelamento, CC-e, as quatro manifestações e, desde
26/10/2026, os eventos do fornecedor da Reforma Tributária 112110 a 112150 e a
Vinculação Pagamento 110300 do emitente. Não há fonte oficial que diga se a
distribuição entrega o 110300 ao destinatário; a captura o aceita se ele
chegar. Os
outros tipos ficam com `XML_EVENT_UNSUPPORTED`, com o envelope preservado e
fora do documento. A lista, os motivos e o levantamento do portal estão em
[NFE-SCHEMAS.md](NFE-SCHEMAS.md#eventos-aceitos). O recibo da rodada real
guarda o schema de cada envelope, não o tipo do evento; contar os tipos
recebidos é o que define o próximo evento a aceitar.

## Fronteira do pacote

`@freecorps/fiscal-nfe` exporta o submódulo Node `distribution`: montagem,
interpretação e `distribute` com transporte e credencial opaca injetados.
Reutiliza XML protegido, XSD e corpus da validação XML. Não lê Convex, cofre, relógio,
ambiente global ou cursor persistido; não agenda nem autoriza. Repetir as
mesmas entradas produz o mesmo resultado. Um serviço NF-e não exigiu criar
ou renomear pacote. `ci:boundaries` impede dependências da plataforma nos
pacotes independentes; `xml:prove` instala tarballs fora do monorepo e testa
distribuição sem conta SaaS.

Limites: resposta 2 MiB, até 50 envelopes, 2 MiB por envelope expandido,
16 MiB expandidos por resposta e razão de expansão 200. Base64, gzip,
namespace, ambiente, ordem e NSU são conferidos; DTD/entidades são recusadas.
O XSD fixado exige `ultNSU`/`maxNSU`, inclusive em rejeições: resposta que
omita esses campos fica em atenção sem inferir cursor.

## Coordenação e recuperação

`captureStreams` guarda titularidade, versão, checkpoint, cursor conhecido da
fonte e próxima consulta. `operations` fornece lease, fencing, autorização e
retomada; `captureBatches` guarda bruto/hash e `captureEnvelopes` guarda
NSU/schema/hash/artefato. Depois de todos os envelopes persistidos, a
transação de checkpoint agenda processamento documental e registra auditoria.
Resumo, XML e evento conservam bytes e origem `distribution-xml`.
Deduplicação e webhooks reutilizam consulta de documentos e entrega de webhooks.

Antes do IO, reserva-se uma hora no stream. Respostas 137/656, indisponibilidade
e resultado desconhecido mantêm a janela. Uma resposta 138 sequencial com
`ultNSU < maxNSU` permite próxima consulta após um segundo; fim da fila exige
uma hora; uma resposta `consNSU` 137/138 de uma recuperação libera a próxima
após um segundo, dentro do orçamento de `consNSU` por hora (#419). Sync,
pausa/retomada e retry genérico não limpam essa janela, que o
worker confere novamente, inclusive após troca de certificado.

**Espera não é falha** (#421). Quando nada foi enviado e a fonte, ou um gate
antes dela, pede para voltar depois (a janela da fonte, o teto por hora do
site, a parada geral da Freecorps), o worker responde `wait` com o instante
permitido. A operação fica em `retry_wait` (ou `reconciling`, se já estava
incerta) com `SOURCE_COOLDOWN`, sem linha em `operationalFailures`, sem gastar
recuperação e devolvendo a tentativa que o `claim` contou: nenhuma espera,
por mais longa ou repetida, esgota a operação. A tentativa continua no
histórico com o código.

**Recusa antes do envio** (#421). `certificateUse.authorizeTransport` decide e
audita a abertura do cofre e, se recusa, diz por quê. `transportWithCertificate`
lança `RefusedBeforeSend` só antes de decifrar o A1 e de fazer a requisição,
a única chamada de rede: esse erro prova que nada saiu, e qualquer outro erro
continua incerto. Com ele, `captureProcessing.refusedBeforeSend` desfaz, no
site, o que o `prepare` reservou para a tentativa (janela e última tentativa
voltam ao que eram; a cota cobrada na chave da própria tentativa é estornada,
e a de uma consulta incerta anterior, que pode ter chegado à fonte, fica) e,
na mesma transação, faz a operação esperar (teto por hora, parada geral, A1
renovado desde o `claim`, que a próxima tentativa fixa) ou a pausa com o
código (`ACCESS_REVOKED`, `CERTIFICATE_UNAVAILABLE`, `CAPTURE_FISCAL_DENIED`,
`FISCAL_TRANSPORT_DISABLED`, `FISCAL_PROOF_DENIED`), sem torná-la incerta. Não
há consulta de reconciliação. A prova da #50 mantém a janela conservadora.

| Situação                                                               | Comportamento                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Lease antiga ou acesso/certificado revogado                            | Recusa persistência/checkpoint; operação para (em produção no site, com atenção)                |
| Recusa do cofre antes do envio                                         | Espera ou pausa com o código, sem incerteza nem reconciliação; janela e cota devolvidas no site |
| Crash após IO antes do bruto                                           | Resultado incerto; após a janela consulta `consNSU` do próximo NSU                              |
| Crash com bruto persistido                                             | Reinterpreta o mesmo hash sem nova consulta                                                     |
| Crash entre envelopes                                                  | Retoma por posição e deduplica stream/NSU/hash                                                  |
| Crash após checkpoint                                                  | Recibos impedem republicação lógica                                                             |
| Lacuna após checkpoint conhecido                                       | Persiste lote, avança só prefixo contínuo e recupera NSU faltante em lote (até 6 `consNSU`/h)   |
| `consNSU` 137 numa lacuna                                              | Localiza o limite do trecho perdido; atenção até o Proprietário aceitar a perda                 |
| Primeira consulta com histórico limitado                               | Começa no primeiro NSU disponível e informa `HISTORY_LIMITED`                                   |
| NSU repetido sem progresso ou cursor regressivo                        | Atenção; cursor e janela preservados                                                            |
| Mesmo NSU com conteúdo diferente                                       | Atenção por integridade; bruto e original anterior preservados                                  |
| 656                                                                    | Atenção; checkpoint, cursor e modo preservados; espera uma hora                                 |
| 589 em `consNSU`, `ultNSU = maxNSU = checkpoint`, sem lacuna conhecida | Atenção com rejeição preservada; retomada após a janela usa `distNSU` no mesmo checkpoint       |
| `consNSU` ausente/incompatível                                         | Atenção; não pula documento indisponível                                                        |
| 108/109                                                                | Nova operação depois de pelo menos uma hora                                                     |
| Bruto ausente/adulterado ou XML inválido                               | Atenção operacional; retomar não descarta lote nem contorna erro                                |

A recuperação encadeia `consNSU`, um segundo entre eles, até 6 por hora por
stream (3 no dia seguinte a um 656), abaixo do limite de 20/h ([lacunas](#lacunas-e-histórico-limitado-419));
antes da #419 era um por hora. Se o cursor remoto é conhecido, recupera até
alcançá-lo antes de voltar a `distNSU`. Se a resposta perdida deixou esse cursor desconhecido, um documento
recuperado não basta para inferi-lo: sinaliza `SOURCE_CURSOR_UNKNOWN`.
Retomada explícita após a janela consulta a fonte e trata eventual 656 pelo
mesmo fluxo. Nunca copia o cursor remoto para o checkpoint local sem envelopes.

**656 e `ultNSU`** (#421). A NT 2014.002 v1.40 (§3.11.4.1, "Observação",
conferida em 23/10/2026 com o mesmo SHA-256 acima) diz que, numa consulta
`distNSU` rejeitada com 656, `ultNSU` traz "o número da última consulta
realizada para o CNPJ de 14 dígitos", para quem não conhece o próprio
`ultNSU` retomar dali. É a posição da última consulta ao CNPJ, que pode ser
de outro sistema do mesmo ator, e não um limite do que este stream recebeu
nem de uma lacuna nele. Por isso o 656 não muda `sourceCursor`, modo nem
checkpoint: tomá-lo como cursor transformava o resto da fila numa recuperação
`consNSU` de um NSU por hora, e pular o checkpoint até ele perderia
documentos. O valor fica no lote para diagnóstico; o stream só respeita a
hora que a NT manda esperar ("Se retomar a consulta antes de completar 1
(uma) hora, o tempo é zerado"). A retomada lê a fila com `distNSU` a partir
do checkpoint. Se outro sistema consome o mesmo CNPJ, a NT pede que todos
sigam a mesma sequência; um novo 656 depois da retomada aponta esse conflito,
que a empresa precisa resolver.

Um resultado incerto não prova que exista o NSU seguinte. Se a consulta pontual
recebe 589 e a fonte confirma `ultNSU = maxNSU = checkpoint`, sem cursor remoto
anterior acima do checkpoint, a próxima retomada usa distribuição normal. O
registro continua em atenção com `SOURCE_589` e espera pelo menos uma hora;
não há nova consulta automática, avanço do cursor nem descarte de documentos.
Resposta regressiva, limite incompatível ou lacuna conhecida mantém a recuperação.
A retomada também reconhece esse limite em um lote 589 já confirmado por uma
versão anterior, sem consultar novamente o NSU inexistente nem alterar a janela.

Falha de integridade exige investigação dos hashes, storage e versão do
parser, seguida de correção/restauração comprovada. Não há comando para
abandonar evidência, apagar histórico ou editar cursor. Repetir retomadas
enquanto a causa persiste não libera a captura. A exceção, desde a #419, é
uma só e controlada: aceitar a perda do trecho de uma lacuna que a fonte
respondeu não ter mais (abaixo). Ela não apaga nada, não vale para
integridade e fica registrada com a pessoa, o intervalo e o motivo.

### Lacunas e histórico limitado (#419)

Conferido na NT 2014.002 v1.40 (mesmo SHA-256 acima) em 23/10/2026:

- §3 e §3.5: os documentos ficam disponíveis "por até 90 dias após sua
  recepção pelo Ambiente Nacional"; o NSU segue a "ordem cronológica de
  recepção"; um `distNSU` abaixo do primeiro NSU disponível devolve a partir
  do mais antigo ainda disponível. Uma captura parada mais de 90 dias, ao
  voltar, recebe NSU acima de `checkpoint+1`: a lacuna é o que saiu da fonte.
- §3.6: o `consNSU` serve para "consultar pontualmente os NSU identificados
  como faltantes"; o 137 indica "que o Ambiente Nacional não gerou o NSU e o
  interessado deve desconsiderá-lo", e depois de 90 dias "não será possível
  recuperar a NF-e".
- §3.11.4.2: `consNSU` e `consChNFe` somados têm limite de "20 consultas por
  hora"; acima disso, 656 e bloqueio de uma hora. A espera de uma hora da NT
  vale depois de um 137 ou do fim da fila em `distNSU` (§3.5, §3.11.4.1) e
  depois de um 656. Nada na NT espaça um `consNSU` do seguinte.

O que obrigava uma hora entre dois `consNSU` era só o código: o `prepare`
reserva uma hora antes de qualquer consulta (pior caso de resposta perdida) e
o checkpoint mantinha essa janela para toda resposta que não fosse `distNSU`
138, como a ADR 0007, §4 escrevia ("no máximo uma consulta por hora").

**Recuperação em lote** (`lib/captureGap.ts`). Uma resposta `distNSU` com
lacuna grava em `captureStreams.recovery` quando ela apareceu, a última
consulta respondida antes (o período sem consulta) e se a fila ainda estava
pendente. A primeira consulta pontual sai um segundo depois, e as seguintes
também, até 6 `consNSU` em qualquer hora deslizante (`RECOVERY_HOURLY_LIMIT`,
um terço do limite da NT). Toda reserva de `consNSU` conta
(`reconciliation_started`), respondida ou não. Esgotado o orçamento, o
`prepare` adia até o mais antigo sair da hora (`wait`, sem tentativa gasta),
qualquer que seja a origem da consulta.

O teto parte do que a NT e o Portal dizem, conferidos em 23/10/2026:

- §3.11.4.2 (e o aviso do Portal NF-e de 04/03/2022, "Atualização das Regras
  de Uso Indevido do Web Service NFeDistribuicaoDFe", com o mesmo texto):
  "Será permitido um número limitado de consultas por chave de acesso ou NSU
  em um período de 1hora", e acima disso "656 - Consumo indevido -
  ultrapassou o limite de 20 consultas por hora. Nesse caso, o CNPJ é
  bloqueado por 1 hora". O limite soma `consNSU` e `consChNFe`; `distNSU`
  tem regras próprias (§3.11.4.1: hora depois do 137 ou de `ultNSU = maxNSU`,
  e sequência pelo `ultNSU`) e não entra nele. O stream não faz `consChNFe`.
- Âmbito: a NT diz que o bloqueio é do **CNPJ**; não diz se a contagem é por
  CNPJ de 14 dígitos, pela raiz que o certificado autentica (§3) ou pelo ator.
  A leitura segura é a mais larga: todos os sistemas do mesmo CNPJ (ERP,
  contador) somam a mesma cota, e o bloqueio para todos.
- Janela: "em um período de 1hora", sem dizer se é hora cheia ou deslizante.
  O stream conta numa hora deslizante, que nunca põe mais de 6 em nenhuma
  hora do relógio.
- Ritmo recomendado: nem a NT nem os avisos do Portal (o de 25/02/2022
  suspendeu `consNSU` e `consChNFe` por "excesso de utilização indevida")
  recomendam um. Para baixar tudo, a NT manda usar `distNSU` (§3.11.4.2).
  O 656, em qualquer consulta, pede uma hora, e retomar antes "zera" a
  contagem (§3.11.4.2, "Observação").

Por isso 6, um terço de 20: sobram 14 por hora para os outros sistemas da
empresa. **Recuo depois de um 656**: qualquer 656 do stream grava
`recovery_backoff` em `captureAudit`, além da hora que o 656 já impõe; nas
24 h seguintes o teto cai à metade, 3 por hora (`RECOVERY_BACKOFF_LIMIT`,
mínimo de 1). Um 656 indica que alguém mais gasta a cota do CNPJ.

Em números: uma lacuna recuperável de 13 NSU leva pouco mais de 2 h (6 + 6 +
1); uma de 50, cerca de 8 h; a 3 por hora, depois de um 656, o dobro. Uma
lacuna de 90 dias que a fonte já não tem resolve o limite com 2 consultas
(base e topo) e espera só a decisão da empresa. Uma mista com 2.000 NSU acha o
limite em cerca de 13 consultas, pouco mais de 2 h, e depois recupera o resto
a 6 por hora. O teto do site
(`SITE_CAPTURE_HOURLY_LIMIT`) e a parada geral continuam valendo antes dele.
Os NSU acima da lacuna que o lote já trouxe entram em sequência sem nova
consulta assim que o checkpoint os alcança. Fechada a lacuna, a captura volta
a `distNSU` no cursor: logo, se a fila estava pendente; senão, depois da
espera de fim de fila contada de quando a lacuna apareceu.

**Trecho perdido.** Um `consNSU` 137 dentro da lacuna não para a captura. Os
NSU mais antigos saem primeiro (§3.5), então a parte perdida é o começo da
lacuna. A recuperação procura onde ela termina: pergunta o topo da lacuna
(o caso comum, uma captura parada mais de 90 dias, se resolve com duas
consultas) e, se o topo ainda existe, divide o intervalo ao meio até achar o
limite; os NSU achados no caminho ficam guardados. Achado o limite, o stream
fica em atenção com `RECONCILIATION_UNAVAILABLE`, com
`connection.attention_required`, e o console mostra o período sem consulta e
o trecho perdido. Cada NSU é um registro da fila (resumo, NF-e ou evento), e
o 137 também cobre NSU nunca gerado, então o console fala em "até N notas ou
eventos", com a referência NSU. Essas notas e eventos não entram em Produção:
no site a importação de XML fica no Sandbox (ADR 0007, §3). Se algum NSU abaixo do limite ainda existisse (um documento
recebido há muito tempo com NSU novo), ele entraria no trecho; a NT não
oferece como distinguir sem consultar cada NSU.

**"Aceitar a perda e continuar"** (`captures.acceptGap`). Só no console, só o
Proprietário (decisão do dono em 26/10/2026,
[ADR 0008](../adr/0008-perda-fiscal-em-captura-de-integracao.md#decisões-do-dono-em-26102026);
o servidor confere o papel, e Administrador, Desenvolvedor, Operador, Leitura,
login sem membership e outra organização recebem `ACCESS_DENIED`), só com um
motivo escrito e só com o limite localizado (`GAP_NOT_ACCEPTABLE`). O motivo
perde os espaços das pontas e precisa ter de 1 a 500 caracteres, sem
caracteres de controle além de quebra de linha e tabulação; fora disso,
`GAP_REASON_INVALID`, sem efeito. A confirmação repete o intervalo que o diálogo
mostrou (`from`, `to`) e a versão do stream que ele leu: outro intervalo dá
`GAP_CONFIRMATION_MISMATCH`, e retomar, pausar, desativar ou outra aceitação
no meio dão `OPERATION_CONFLICT`. O checkpoint vai para o último NSU perdido,
os NSU já recuperados acima entram em sequência sob a nova consulta, que roda
com o acesso de quem aceitou, e o stream segue: `consNSU` enquanto faltar
algo acima, `distNSU` no cursor depois. A perda fica em `captureAudit` como
`history_limited`, com o intervalo, a pessoa (`member:<id>`), a versão
confirmada, o motivo (`lost.reason`) e a hora; o console a mostra depois, com
o nome, a data e o motivo. O log operacional registra `capture.history_limited`
com a pessoa, sem o motivo: ele só guarda campos de domínio, nunca texto livre.
Repetir a mesma confirmação devolve o stream como está, sem segundo efeito,
mesmo com outro motivo; vale o da primeira.

A API e o SDK não expõem a ação nem as lacunas: aceitar perda fiscal é
decisão de uma pessoa com papel, auditável a ela, e uma chave de API não tem
nem uma coisa nem outra; expor a ação deixaria uma integração pular perdas
sozinha. `GET /v1/connections/nfe` mostra `attention` com
`RECONCILIATION_UNAVAILABLE` e, depois da aceitação, o checkpoint novo e
`HISTORY_LIMITED` até a próxima resposta. O intervalo aceito chega à
integração só pelo evento `connection.history_limited` (abaixo).

**Captura de integração (#442).** Antes, uma captura ativada por chave nesse
estado não tinha saída: retomar pela API pergunta de novo o primeiro NSU da
lacuna, recebe o mesmo 137 e volta à atenção, e o console recusava a ação com
`INTEGRATION_RECORD`. Agora o Proprietário aceita a perda no console, com
motivo, pela mesma regra da captura do console, e a captura continua sendo da integração: a consulta
seguinte continua a operação parada (`continueOperation`) no projeto, com a
chave e sob os webhooks da integração, com o A1 atual da empresa, como a
retomada automática de `resumeEligible`. O console não ganha pausar, retomar
nem transferir essa captura (`INTEGRATION_RECORD` continua). Antes de gravar,
a ação confere a origem da operação parada (`executionAllowed`): chave
revogada ou vencida, projeto desativado ou concessão sem `connections:write`
ou sem o ambiente dão `INTEGRATION_ACCESS_REVOKED`, e nada muda; a integração
retoma com uma chave válida e a perda volta a poder ser aceita. É a segunda
exceção à [ADR 0005](../adr/0005-console-sem-projeto.md#situação-em-26102026),
§1 ("lidos mas não alterados pelo console"), depois de cancelar NFS-e,
aceita pelo dono em 26/10/2026 com a
[ADR 0008](../adr/0008-perda-fiscal-em-captura-de-integracao.md).

**Evento `connection.history_limited` (#442).** A mesma transação que grava
a perda numa captura de integração emite, pela outbox, um evento para os
destinos do projeto dono do stream que o assinaram (`connections:read`, além
de `webhooks:manage`), com a assinatura, a retentativa e o reenvio de
qualquer webhook. `resource` é o stream, com a versão que a aceitação lhe
deu; a chave lógica é o stream mais essa versão. É o único evento com
`data`: o intervalo perdido e o papel de quem decidiu,
`{ "lost": { "from": "000000000000002", "to": "000000000000040" }, "decidedBy": "owner" }`.
O motivo e a pessoa ficam no console: o motivo é texto livre, que pode citar
terceiros, e o webhook sai para o sistema de outra empresa; o id da
membership não serve à integração. Repetir a confirmação devolve o stream
sem novo evento; uma aceitação recusada não emite nada. A captura do console
não emite: o projeto do console não tem webhooks. O porquê de cada campo
está na [ADR 0008](../adr/0008-perda-fiscal-em-captura-de-integracao.md#evento-da-perda-aceita).

**Streams antigos em `consNSU` por um 656.** Antes da #421, um 656 punha o
`ultNSU` dele como cursor e o stream em `consNSU`. O `prepare` reconhece esse
cursor (nenhum envelope acima do checkpoint, cursor igual ao `ultNSU` de um
656 do stream e de nenhuma resposta `distNSU`, sem `recovery`) e volta a
`distNSU` a partir do checkpoint, 50 por consulta, com a auditoria
`blocked_cursor_cleared`. Uma consulta incerta é reconciliada antes, como
sempre.

## Transferência e ambiente

Segunda ativação de outro responsável retorna `STREAM_CONFLICT`, sem
identidade do titular. Um gestor atual pode pausar e gerar código de
transferência, exibido uma vez e guardado como hash por 15 minutos. Outro
gestor da empresa com mesmo CNPJ e certificado válido recebe o stream
pausado. Checkpoint, cursor, janela e o fim da fila na fonte
(`sourceMaxNsu`) permanecem, porque descrevem o mesmo CNPJ na fonte;
documentos/lotes antigos continuam privados da organização anterior. Chaves
não transferem. IO incerto e lote não concluído impedem liberação. Pausa não
desfaz consulta enviada. Código errado ou vencido, com o stream de outra
organização, também dá `STREAM_CONFLICT`. Um código sem stream de outra
organização para receber (nenhum stream do CNPJ no ambiente, ou o stream já
é desta empresa) dá `TRANSFER_NOT_FOUND` (#461), também para o código vazio:
a ativação com código não cria, não retoma nem devolve stream, e não grava
auditoria nem operação. Só a ativação sem código liga a captura. Essa recusa
é do console (`captures.activate`); a API REST não recebe código de
transferência.

Na aba Captura da empresa, cada parte fica num cartão (#432). Com a captura
fiscal oferecida pelo deployment ou já usada pela empresa, "Captura fiscal
(Produção)" vem primeiro e o Sandbox vira o bloco recolhido "Captura de teste
(Sandbox)", com a situação no resumo; sem ela, o Sandbox é o único cartão,
aberto. O painel de cada captura tem quatro grupos: **Situação**, com o selo e
o motivo numa linha e, em atenção, o motivo e "O que fazer: …" logo abaixo do
selo, junto das ações; **Agenda**, com a última consulta num valor só ("22/10
14:03 (respondida)", "(não respondida)" ou "(em andamento)") e a próxima
consulta automática, que diz "Nenhuma: …" quando a captura está pausada ou em
atenção; **Volume**, com "Documentos recebidos da fonte" e a "Fila na fonte"
("Em dia" ou "Ainda há documentos para receber"); e **Certificado**, com a
validade e o link para a aba Certificado. Recolhidos em "Detalhes técnicos
(para o suporte)" ficam os NSU, o código e o id da operação, com botão de
copiar; um valor ausente aparece em palavras ("Nenhum", "não informado"). O
texto de cada código vem de `apps/console/src/capture-messages.ts`: motivo e o
que fazer, sem cursor, stream ou NSU, para todo código que o servidor deixa
numa captura e para as recusas das ações. Cada código também diz o que
resolve a causa (`CaptureAction`), e é isso que escolhe a ação principal:
"Retomar captura" é o botão principal quando retomar faz a captura seguir;
quando a causa está com a Freecorps, no plano ou num ambiente sem fonte, o
servidor aceitaria retomar mas a captura pararia de novo, e o botão fica
secundário; sem um A1 utilizável, que o servidor recusaria, o painel leva a
"Ver certificado"; e no bloqueio de uma hora da Receita (656) o botão espera o
horário, com o motivo ao lado. Uma só região `role="status"` na
página anuncia a mudança de situação de uma das capturas (o selo e, em
atenção, o motivo), e não cada atualização do stream. Pausar,
transferir e desativar a captura fiscal pedem confirmação, e o console só muda
de estado depois da resposta do servidor; uma recusa fica no diálogo. Pausada,
a captura diz que as consultas automáticas pararam e que nenhum documento novo
chega, e a próxima consulta aparece como "Nenhuma". Transferir ("Transferir esta
captura para outra organização") e receber ("Recebendo uma captura de outra
organização?") ficam recolhidos, só para gestores. Com a captura já pausada,
transferir só gera o código ("Autorizar transferência"), sem prometer pausar.
A recusa de "Receber transferência" fica junto do botão, com o foco; para
`TRANSFER_NOT_FOUND` ela pede conferir o código com a organização de origem
ou, sem transferência, usar "Iniciar captura fiscal" (Produção) ou "Ativar
captura no sandbox".
A captura recebida (código `TRANSFERRED`) diz que falta retomá-la. Sem stream e
com a captura fiscal desativada, o painel de Produção aponta para reativá-la
acima, e a nota sobre sincronizar e pausar só aparece quando há uma captura.
`connection.attention_required` nasce junto da transição para atenção e
contém somente referência/versionamento do recurso.

**Ligações e últimas consultas (#433).** O grupo Volume leva ao que a captura
recebeu: "Ver documentos em Produção" (ou "no Sandbox"), que abre
`/documents?company=…&env=…`, e, quando há, "Ver notas só com resumo (N)",
que abre a mesma lista com `completeness=summary`. A contagem vem de
`documents.summaryCount`, com o acesso da lista, contada até 100 ("100+"
acima disso). Abaixo dos três grupos, "Últimas consultas" mostra até 10
consultas, da mais recente para a mais antiga, com hora, resultado e
documentos recebidos, e lembra que cada consulta enviada conta no limite de
consultas do plano (com link para Uso e limites para quem administra). No
Gratuito, em Produção, as consultas não contam: o texto diz que cada nota nova
recebida conta no limite de notas do plano (`captures.get`, `countsNotes`). A
query `captures.history` tem o acesso de `captures.get`: lê as 200 linhas mais
recentes de `captureAudit` do stream, só as da organização atual (uma captura
recebida por transferência não mostra as consultas da organização de origem),
e cada consulta começa numa linha `query_started` ou `reconciliation_started`.
O resultado vem do lote que guardou a resposta (`checkpoint_committed`):
"Respondida" com os documentos do lote (138 ou 137), "Bloqueada por uma hora"
(656), "Receita fora do ar" (108 e 109) ou "Recusada (código N)"; sem lote,
"Não enviada" quando o cofre recusou antes da requisição (`query_refused`),
"Não concluída" com o motivo do código que parou a captura, "Em andamento"
para a mais recente ainda sem resposta e "Sem resposta" para as outras. Os
textos vêm de `capture-messages.ts` (`queryOutcome`), sem NSU, lote ou stream;
uma consulta de recuperação diz "Busca de um registro que faltou". É uma
assinatura Convex: a tabela muda quando o servidor grava a consulta.

**Selo da captura fiscal (#433).** A lista de empresas e o cabeçalho de cada
empresa mostram a situação da captura fiscal (Produção) com as palavras e o
tom do painel (`captureSituation` em `capture-messages.ts`): "Captura fiscal
ativa", "pausada", "precisa de atenção", "parada pela Freecorps" ou "não
iniciada" (liberada e sem stream). Sem liberação, ou depois de desativada, não
há selo; a lista ganha a coluna "Captura fiscal" só quando alguma empresa da
página tem um. O valor vem de `companies.list` e `companies.get`
(`fiscalCapture`, `fiscalCaptureOf` em `lib/captureCore.ts`), no mesmo escopo
de acesso dessas leituras e só para os papéis que leem a captura (o
Desenvolvedor recebe `null`). A situação é a de `captureView`: em atenção
também quando o stream segue ativo com a operação parada. Cada empresa custa
uma leitura sem a captura fiscal e três com ela (liberação, stream e
operação), mais a parada geral no site, dentro da página de até 50 empresas;
a medição está em `tests/platform.companiesList.benchmark.test.ts`.

O padrão continua `FISCAL_ENV=disabled`. Para a prova autorizada da validação fiscal real,
preparar deployment com `FISCAL_ENV=homologation`,
`FNFE_CAPTURE_TRANSPORT=sefaz` e `PRODUCT_ENV=sandbox`. A autenticação aceita
somente essa combinação explícita; `/health` informa o valor efetivo.

Produção fiscal existe só no alvo dedicado da #50 marcado com
`FNFE_PROOF_FISCAL_ENV=production`, para ler a distribuição de NF-e já
recebidas. Nesse alvo, `PRODUCT_ENV=production` desde a publicação, para que
stream, operações e documentos fiquem no ambiente `production` e a consulta
use `www1` com `tpAmb=1`. O transporte só abre com
`FISCAL_ENV=production` e uma política cujo `fiscalEnvironment` também seja
`production`. A marca fora de `APP_ENV=validation`, a política de
homologação no alvo de produção e o inverso são recusados. Emissão NFS-e
continua presa ao sandbox pela política do cofre, e não há comando de
manifestação. A instalação hospedada continua com `FISCAL_ENV=disabled`;
ela captura em produção só para as empresas da
[liberação fiscal no site](#liberação-fiscal-no-site), por uma política
própria.

`testing/captureProof` só opera em development/loopback com fiscal disabled;
não é rota pública. `allowNow` exige fixture local e altera somente o relógio
do stream sintético para a prova. Homologação/remoto são recusados.

Matriz, recibos e limitações.

## Liberação fiscal no site

A [ADR 0007](../adr/0007-captura-fiscal-no-site.md) abre `production` no site
hospedado, empresa por empresa, e a emenda de 22/10/2026 deixa a própria
empresa ligar.

**Transporte real no site** (`lib/siteCapture.ts`, fase 4). Um stream de
`production` de empresa liberada consulta `www1` com `tpAmb=1` sem a política
da #50. `FISCAL_ENV` continua `disabled` no site: ele nomeia o modo fiscal do
deployment inteiro da prova da #50, e a divergência prevista na ADR para
`requirePlatformEnvironment` não foi necessária. O site usa duas chaves
próprias, e nenhuma abre nada sem empresa liberada:

- `FNFE_CAPTURE_FISCAL=enabled`: empresas podem ligar a captura;
- `FNFE_CAPTURE_TRANSPORT=sefaz`: o adaptador real responde por elas.

`/health` informa `captureFiscal: "enabled"` só com as duas. Cada consulta é
autorizada de novo em `captureProcessing.prepare`, antes de reservar janela
ou cota, e em `certificateUse.authorize`, antes de abrir o cofre: empresa
declarada de organização aberta, liberação ativa, stream da própria empresa
em `production` e A1 da própria empresa válido. Sem a chave de transporte, a
operação pausa com `FISCAL_TRANSPORT_DISABLED`; sem a liberação ou o A1, com
`CAPTURE_FISCAL_DENIED`, sem gastar a janela. Antes disso, cada tentativa
fixa no `claim` o A1 ativo da empresa naquele momento; sem um A1 próprio
utilizável, ela já pausa ali com `CERTIFICATE_UNAVAILABLE` (veja
[continuidade](#continuidade-da-captura-em-produção)). O cofre audita essas
consultas como `capture-production`, separado do orçamento `transport` da
#50, com teto de 120 consultas autorizadas por empresa em qualquer hora; no
teto, a consulta é adiada para o fim da janela, sem cota nem janela gastas,
seja no `prepare` ou, se o teto foi atingido depois dele, no cofre
([recusa antes do envio](#coordenação-e-recuperação)). Uma recusa do cofre
depois do `prepare` pausa ou adia sem incerteza e devolve janela e cota.
Streams de `sandbox` no site continuam sem transporte fiscal.

**Agenda no site.** A próxima consulta é agendada pelo próprio stream, sem
cron. Com fila pendente (`ultNSU < maxNSU`), um segundo; no fim da fila
(137 sem lacuna, ou 138 que alcançou o máximo), o intervalo mínimo da
empresa, de 1 a 24 horas; 108/109 e 656 mantêm a janela de uma hora, e a
recuperação por `consNSU` anda um segundo por NSU, até 6 por hora (3 no
dia seguinte a um 656)
([lacunas](#lacunas-e-histórico-limitado-419)). Um 656 deixa o stream em atenção, avisa por
`connection.attention_required`, conta como falha da fonte nos monitores e
não tenta de novo; checkpoint, cursor e modo ficam como estavam
([656 e `ultNSU`](#coordenação-e-recuperação)), e a retomada é recusada com
`SOURCE_COOLDOWN` até a janela vencer; pela API, 409 com `nextAllowedAt` no
corpo do erro. Uma retomada de outro motivo dentro da
janela espera por ela (`wait`), sem falha nem tentativa gasta. O monitor de
cursor de `production` usa como limiar pelo menos o intervalo mínimo da
empresa mais uma hora ([OBSERVABILITY.md](OBSERVABILITY.md#monitores-e-alertas)). Desligar a captura no console ou a emergência da Freecorps pausam
o stream de produção e a operação na hora, com `CAPTURE_RELEASE_WITHDRAWN`;
uma consulta já enviada fica incerta para a reconciliação. Cada consulta
exige plano vigente com cotas finitas de capturas (ou de notas, no Gratuito) e
bytes, inclusive no piloto gratuito. Sem ele, novas consultas param com
`PLAN_REQUIRED`; plano fora da vigência usa `PLAN_INACTIVE`. Cada consulta
admitida consome a cota de capturas do plano no saldo de `production`, separado
do saldo do sandbox desde a #429 ([USAGE.md](USAGE.md#ambientes)); ao esgotar,
a captura entra em atenção e volta sozinha quando a cota voltar. No Gratuito,
em Produção, as consultas não contam e vale a cota de 100 notas novas por mês
([USAGE.md](USAGE.md#cota-de-notas-do-gratuito)): com ela atingida, a captura
entra em atenção com `QUOTA_EXCEEDED`, o console e o Início dizem que foi o
limite de notas (`notesQuota`), e ela volta sozinha no mês seguinte. Consumo do
sandbox não a pausa. O site recusa
`FNFE_FISCAL_PROOF` e qualquer `FNFE_CAPTURE_TRANSPORT` diferente de vazio,
`disabled` ou `sefaz`; a produção fiscal da NFS-e recusa
`FNFE_CAPTURE_FISCAL`.

**Estado.** `captureReleases` guarda, por empresa, se está liberada, se já
foi liberada alguma vez, o bloqueio da Freecorps, o intervalo mínimo entre
consultas no fim da fila (1 a 24 horas) e a versão. `captureReleaseEvents`
guarda o histórico: a pessoa e a versão dos termos nas mudanças do console,
mais o SHA-256 do texto aceito desde a #428 (`termsSha256`); os logins, o run e
a tentativa nas da Freecorps. Retenção em
[RETENTION.md](RETENTION.md#histórico-da-liberação-da-captura-fiscal).

**Efeito** (`lib/environmentAccess.ts` e `lib/fiscalCaptureRelease.ts`):

| Estado da empresa                                | `production` no site                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Nunca liberada (mesmo se bloqueada)              | Não existe                                                                                                                           |
| Liberada                                         | Captura, documentos, exportações, webhooks e monitores                                                                               |
| Desligada, retirada ou sem a chave do deployment | Só leitura: empresa, documentos, exportação e consulta da captura; o que já foi recebido ainda vira documento; nada novo é capturado |

Importação, emissão, cadastro, referências, certificados e alteração da
empresa nunca rodam em `production` no site. Empresa de demonstração nunca é
liberada.

**Ligar e desligar (empresa).** No console, no cartão "Captura fiscal
(Produção)" da aba Captura, o Proprietário ou Administrador com acesso à
empresa ativa ou desativa. `captureRelease.enable` exige:

- `FNFE_CAPTURE_FISCAL=enabled` no deployment (`CAPTURE_RELEASE_UNAVAILABLE`);
- empresa declarada, de organização fora de encerramento;
- A1 ativo da própria empresa, com o mesmo CNPJ e dentro da validade
  (`CAPTURE_RELEASE_CERTIFICATE_REQUIRED`);
- o aceite da versão atual dos termos (`CAPTURE_TERMS_VERSION`,
  `CAPTURE_RELEASE_TERMS_REQUIRED`) e o intervalo mínimo. O texto de cada
  versão fica em [`docs/termos/arquivo/`](../termos/README.md), com o SHA-256
  em `CAPTURE_TERMS_ARCHIVE`; o console mostra esse arquivo, e um teste falha
  se texto e hash divergirem;
- nenhum bloqueio da Freecorps (`CAPTURE_RELEASE_BLOCKED`).

Ligar **revoga as chaves de API de produção** que alcançam a empresa: uma
chave criada antes não passa a funcionar sozinha. A integração emite chaves
novas depois. Operador e Leitura veem a situação, sem ligar nem desligar.
`captureRelease.status` informa a situação ao console, inclusive
`acceptedTerms`, o aceite da liberação em vigor: versão, horário e, só para
Proprietário e Administrador, o nome de quem aceitou (`null` quando desligada,
retirada ou cortada). A linha "Captura fiscal ativa" diz "Termos de 22/10/2026
aceitos por <nome> em <data e hora>" e leva a `/termos/captura-fiscal/<versão>`,
página do console que exige login e mostra o texto arquivado, a situação, a
versão e o hash; "Voltar" devolve à aba de origem ([termos](../termos/README.md#o-que-o-servidor-registra-no-aceite)).

**Intervalo sem desativar (#432).** Ligada, a captura fiscal vira a linha
"Captura fiscal ativa · intervalo mínimo 1 h", com "Alterar intervalo" e
"Desativar". `captureRelease.updateInterval` muda o intervalo de uma
liberação que vale, com as regras de `disable` (Proprietário ou
Administrador, `SCOPE_DENIED` para os outros papéis, e o mesmo limite de 10
mudanças por minuto da organização, `RATE_LIMITED`) e as de `enable` que
cabem: 1 a 24 horas inteiras (`CAPTURE_RELEASE_INTERVAL_INVALID`), a chave do
deployment (`CAPTURE_RELEASE_UNAVAILABLE`), organização fora de encerramento
(`ORGANIZATION_CLOSED`), sem bloqueio da Freecorps
(`CAPTURE_RELEASE_BLOCKED`) e liberada (`CAPTURE_RELEASE_NOT_RELEASED`). O
mesmo valor não grava nada. A mudança é um evento próprio do histórico
(`console_interval`, com a pessoa) e da auditoria
(`capture.fiscal_interval_changed`), e a liberação **mantém a versão**: as
consultas já agendadas fixam essa versão (`releaseAccessVersion`), e uma
versão nova as cortaria como uma retirada. Nenhuma consulta é antecipada:
um intervalo menor vale a partir do próximo fim de fila; um maior adia a
próxima consulta automática de um stream ativo que já está no fim da fila
(`distNSU`, sem recuperação nem consulta sem resposta, checkpoint no
`maxNSU` da última resposta 137/138, gravado no stream como `sourceMaxNsu`)
para a última consulta respondida mais o novo intervalo, com a
linha `interval_postponed` na auditoria do stream. A operação agendada
acorda no horário antigo, encontra a janela à frente e espera, sem gastar
tentativa. Fila pendente, recuperação e janelas da fonte (656, teto por
hora) mantêm os próprios horários. Um stream de antes do campo não é adiado
até a próxima resposta 137/138.

**Novos termos para quem já liberou (#428).** Uma versão nova dos termos
vale de imediato para novas ativações. A empresa liberada sob uma versão
anterior tem `CAPTURE_TERMS_REACCEPT_DAYS` (30) dias, contados da data da
versão nova (`since`, meia-noite de Brasília), para aceitá-la
(`termsStanding`). Até o prazo, nada muda; o console mostra "Novos termos
da captura fiscal" com a data-limite. Passado o prazo, o gate
(`lib/siteCapture.ts`) **adia** cada consulta como na parada geral, depois
das recusas da própria empresa: código `CAPTURE_TERMS_PENDING`, nova
checagem em uma hora, linha `terms_deferred` na auditoria, sem cota, janela,
tentativa, atenção ou webhook. A liberação, as chaves de produção e a
leitura continuam; o painel e `GET /v1/connections/nfe` mostram o stream
`active` com `CAPTURE_TERMS_PENDING`, e o selo da empresa diz "Captura
fiscal aguardando novos termos". `captureRelease.acceptTerms` grava o
aceite com as regras de `updateInterval` mais a versão atual
(`CAPTURE_RELEASE_TERMS_REQUIRED`); repetir é recusado com
`CAPTURE_TERMS_ALREADY_ACCEPTED`. O aceite é o evento `console_terms`, com a
pessoa, a versão e o SHA-256, e mantém a versão da liberação, como o
intervalo: as consultas da fila seguem e voltam a consultar na próxima
checagem, em até uma hora. `acceptedTerms` passa a mostrar esse aceite
(`termsEventId`). Ativar de novo depois de desativar parte do aceite novo.

Depois de ligar, o mesmo cartão diz "Falta um passo: Iniciar captura fiscal"
e o foco vai a esse botão. Ligar libera; a consulta começa quando quem opera
documentos (Operador, Administrador ou Proprietário) clica em "Iniciar
captura fiscal", que ativa o stream de `production` da empresa. O console não
inicia sozinho depois de ligar: iniciar dispara consultas reais à Receita, é
um comando de outro papel (o Operador inicia, só o gestor liga) e uma
integração que já captura o CNPJ não entra em conflito com a liberação. Até a
Receita responder, o painel diz que a primeira consulta está na fila ou em
andamento. Com a captura desligada, o painel fica só para leitura, e ativar
de novo fica recolhido em "Ativar de novo a captura fiscal"; sem stream, o
cartão mostra só a linha "Captura fiscal desativada". Os documentos
capturados ficam em Produção. O console mostra um ambiente por vez, escolhido
no seletor da lateral, que oferece Produção depois que uma empresa da
organização teve a captura liberada ([frontend.md](../desenvolvimento/frontend.md#shell-paleta-e-menu)). Uma nota que chegou só como resumo (`resNFe`)
aparece marcada como "Só resumo, sem itens", em tom informativo: a Receita
pode liberar o XML completo depois que a empresa registra a Ciência da
Operação fora do sistema, e ele pode chegar numa consulta seguinte. O filtro
"Conteúdo: Só resumo, sem itens" (`completeness=summary`) lista só essas
notas. O painel da captura mostra a "Fila na fonte" (o `maxNSU` da última
resposta 137/138, gravado no stream na mesma transação do checkpoint, #494;
a API o expõe como `sourceMaxNsu` em `GET /v1/connections/nfe`) e,
enquanto uma consulta espera a resposta, "Consulta em andamento" em vez da
reserva de 1 h. Rejeições (656, 589, …) e linhas de auditoria sem resposta,
como as da parada geral, não mudam esse valor. Um stream criado antes do campo
fica sem a fila na fonte até a próxima resposta 137/138, sem migração, como
antes da primeira resposta.

A exportação acompanha o ambiente: a nota exporta no ambiente dela (console
e `POST /v1/exports` com chave de produção), e a exportação da organização
oferece Produção a Proprietário e Administrador quando alguma empresa está
liberada ou já esteve (`exports.environments`), já selecionada, com a ajuda
"Produção: documentos reais das empresas com captura fiscal (inclusive as já
desativadas)". Em Produção, o pacote reúne
só as empresas que o ambiente atende; uma retirada mantém a exportação do
que já foi capturado.

As integrações seguem a mesma regra. Em Empresas e acesso, a concessão de
um projeto pode marcar Produção para a empresa liberada
(`projects.offeredEnvironments`). Uma chave nova de produção só inclui
empresas liberadas. Em Webhooks, o campo "Ambiente" aparece para essa
empresa, com os nomes Sandbox e Produção das outras telas. O servidor confere a chave: uma chave nova em Produção
para empresa não liberada recebe `ENVIRONMENT_DENIED`. A concessão pode
marcar Produção, mas sem liberação nenhuma chamada passa. A rotação de uma
chave de produção vale enquanto a empresa ainda tiver leitura. Em Produção, a chave alcança o que a liberação
atende: documentos, captura e webhooks. Importação e emissão ficam de fora.
`GET /v1/capabilities` com essa chave devolve `environment: "production"`,
`models: ["55"]`, sem NFS-e, e só as capacidades que a Produção atende
([SDK.md](../v1.0/SDK.md)).

**Emergência e desbloqueio (Freecorps).** Workflows sem aprovação, para
quem está em `authorizedActors` de `deploy/issuance-gate.json`, a mesma lista
do gate da NFS-e:

- `capture-release-emergency.yml` retira a captura e bloqueia a empresa de
  ligar de novo; os documentos já capturados continuam legíveis e
  exportáveis;
- `capture-release-unblock.yml` desfaz o bloqueio, sem ligar nem desligar
  nada. Ele é recusado para empresa que não está bloqueada
  (`CAPTURE_RELEASE_NOT_BLOCKED`) e mantém a liberação gravada, então nunca
  retira uma captura ativa (#424).

Os dois recebem só o id da empresa no Convex, com a organização opcional
para conferir: os inputs de um run são públicos, e o executor recusa um
CNPJ. `captureRelease:set` ainda resolve um CNPJ no servidor
(`companies.by_cnpj`) e recusa com `CAPTURE_RELEASE_COMPANY_AMBIGUOUS` um
CNPJ presente em mais de uma organização, mas nenhum workflow o envia. O console mostra as
referências da organização e da empresa no cartão "Captura fiscal
(Produção)", no trecho recolhido "Referências para o suporte".

Toda mudança que deixa a empresa sem liberação, no console ou pela
Freecorps, pausa o stream de produção e a operação na mesma transação, com
`CAPTURE_RELEASE_WITHDRAWN`. Quando a liberação estava valendo, o stream
emite ali o último evento, `connection.release_withdrawn`, entregue mesmo
depois da retirada ([evento final](#supervisão-e-alertas-422)).

Repetir a emergência numa empresa já bloqueada é aceito e grava outra linha
no histórico, com o run e o motivo, mas não pausa de novo, não muda a versão
do stream e não emite outro evento. Repetir o desbloqueio é recusado com
`CAPTURE_RELEASE_NOT_BLOCKED`, sem gravar nada. Depois do desbloqueio, o
stream continua pausado com `CAPTURE_RELEASE_WITHDRAWN` até a empresa ativar
de novo no console e alguém retomar a captura; a consulta retomada parte do
checkpoint onde a captura parou, sem pular NSU
([continuidade](#continuidade-da-captura-em-produção)).

**Parada geral (Freecorps, #424).** `capture-fiscal-halt.yml` grava em
`captureFiscalHalts` uma parada do deployment inteiro, sem editar variável.
Ela não libera nem retira empresa e não pede nada ao cliente:

- `certificateUse.authorize` recusa abrir o cofre para qualquer consulta em
  produção do site;
- `captureProcessing.prepare` **adia** a consulta, como no teto por hora:
  depois das recusas da própria empresa (liberação, A1, encerramento), o gate
  (`lib/siteCapture.ts`) devolve `CAPTURE_FISCAL_HALTED` com nova checagem em
  uma hora (`HALT_RECHECK_MS`). O stream continua `active`, `nextAllowedAt`
  passa para a nova checagem, a captura registra `fiscal_halt_deferred`, e
  nem cota nem janela da fonte são gastas. Não há atenção nem
  `connection.attention_required`. A operação espera em `retry_wait` com
  `SOURCE_COOLDOWN`: como toda espera, o adiamento não gasta tentativa nem
  recuperação ([espera não é falha](#coordenação-e-recuperação)), e uma
  parada longa nunca a esgota numa pausa que o cliente teria de retomar. Se
  a parada começa entre o `prepare` e o cofre, o cofre adia do mesmo jeito;
- `GET /v1/connections/nfe` e o console mostram o stream como `state:
"active"` com `code: "CAPTURE_FISCAL_HALTED"`; o console diz "Parada pela
  Freecorps" e que a captura volta sozinha.

`capture-fiscal-resume.yml` desfaz a parada, sem aprovação como o
desbloqueio, e não abre nada sozinho nem reagenda: a próxima checagem de
cada stream consulta, em até uma hora. `/health` informa `captureFiscal:
"halted"` enquanto a parada vale. Os adiamentos não contam como falha da
fonte nos monitores operacionais.

O corte por variável é outra coisa, e o gate o confere antes da parada
geral. Sem `FNFE_CAPTURE_TRANSPORT`, a consulta que chega à vez pausa com
`FISCAL_TRANSPORT_DISABLED`; sem `FNFE_CAPTURE_FISCAL`, a liberação vale
como retirada, Produção deixa de ser servida para a consulta
(`environmentServed`) e a operação pausa com `ACCESS_REVOKED`, seja a
captura do console ou de uma chave. Nos dois casos o stream entra em
atenção, com `connection.attention_required` e alerta, mesmo com a parada
geral valendo. Gravar as variáveis de novo, ou
desfazer a parada, não retoma esses streams: a retomada automática
(`resumeEligible`) não cobre esses códigos, e cada um espera "Retomar
captura" ([runbook](../operacao/captura-fiscal.md#depois-do-corte-por-variável)).
Ao entrar em atenção, o stream grava `freecorpsCut` quando o código veio do
corte (#601): `FISCAL_TRANSPORT_DISABLED` sem uma das duas variáveis, ou
`ACCESS_REVOKED` sem `FNFE_CAPTURE_FISCAL` (`cutByVariable`). Com as duas
variáveis de volta, o console (`captures.get` e o Início) diz que a Freecorps
pausou a captura e que basta retomar, com "Retomar captura" como ação
principal. Numa captura ativada por integração, que o console não retoma, o
cartão e o Início dizem que quem retoma é a integração, com a ação `resume`
em `POST /v1/connections/nfe`; o Início recebe a origem no item pendente
(`origin`, a mesma de `captures.get`) para isso (#607). Enquanto uma das
variáveis falta, ou numa revogação real com as duas presentes, o motivo é o
do código. A marca não entra na conexão REST nem no webhook: a integração continua vendo só o `code`. Uma revogação real durante
o corte também recebe a marca; "Retomar captura" é o que ela pede de todo
modo, e a retomada confere tudo de novo. O mesmo vale para uma revogação real
que aconteça depois que as variáveis voltam, com o stream ainda em atenção
marcada: nada consulta enquanto ele espera, então a marca fica até a
retomada, que confere tudo e para de novo com o código da revogação, já sem
a marca. Quando o worker recusa o transporte (`FISCAL_TRANSPORT_DISABLED`),
ele decide a marca com a mesma leitura das variáveis que gerou o código e a
passa à mutation interna `captureProcessing.failed`, que a aceita só para os
códigos do corte num stream de produção do site. O cofre faz o mesmo quando
recusa o A1 com `ACCESS_REVOKED`: `certificateUse.authorizeTransport` decide a
marca na transação que decidiu o código e ela segue, por funções internas,
até `captureProcessing.refusedBeforeSend`. Regravar as variáveis entre a
recusa e a gravação da atenção não apaga a marca.
Uma consulta já enviada termina e grava a resposta sem o transporte; sem
`FNFE_CAPTURE_FISCAL`, a resposta é descartada como incerta e a retomada
reconcilia primeiro.

O runner (`scripts/capture-release.mjs`) lê do GitHub quem disparou, confere
o `/health` do site e chama `captureRelease:set` ou `captureRelease:setHalt`;
na lista (`capture-release-list.yml`), `captureSupervisor:survey`
([visão interna](#supervisão-e-alertas-422)).
A emergência e a parada geral seguem com aviso quando o `/health` não
confirma o site; o desbloqueio e a retomada recusam
([runbook](../operacao/captura-fiscal.md#health-ruim)). Nada dentro do
Convex prova que a chamada veio do workflow: quem tem a deploy key ou o
painel do deployment consegue chamar a função interna. O controle é
operacional.

**Corte geral.** Sem `FNFE_CAPTURE_FISCAL=enabled` no deployment do site,
nenhuma empresa liga, e toda empresa ligada vale como desligada. Remover
`FNFE_CAPTURE_TRANSPORT` no painel do Convex para as consultas quando o
GitHub estiver fora do ar.

### Continuidade da captura em Produção

Uma captura de produção no site não para em silêncio (#418).

**Toda pausa vira atenção.** Quando a operação de uma captura de produção do
site pausa por qualquer motivo que não seja decisão de alguém (a pausa
pedida no console, `PAUSED_BY_USER`, ou a retirada da liberação,
`CAPTURE_RELEASE_WITHDRAWN`, que deixam o stream pausado), o stream que ela
executa vai para `attention` com o código da pausa e emite um
`connection.attention_required` pela outbox. Vale para `ACCESS_REVOKED`,
`CERTIFICATE_UNAVAILABLE`, `QUOTA_EXCEEDED`, `PLAN_INACTIVE`,
`FISCAL_TRANSPORT_DISABLED`, `CAPTURE_FISCAL_DENIED`, `ATTEMPTS_EXHAUSTED` e
`RECOVERY_BUDGET_EXHAUSTED`, em qualquer etapa
(`claim`, `prepare`, resultado, checkpoint ou publicação). A transição é
única por versão do stream: um dispatch atrasado ou o watchdog da tentativa
pausada não emitem outro evento, e o mesmo código não gera segunda
transição. Só a operação que o stream está executando, e só com o stream
ativo, muda o stream. No sandbox e no alvo da #50 nada muda: o painel já
deriva a atenção da operação pausada. O evento vai aos destinos do projeto
dono do stream, como qualquer `connection.*`: numa captura de integração, os
destinos dela; numa captura iniciada no console, que pertence ao projeto do
console e não tem destinos de webhook, o evento fica registrado na outbox e
o aviso chega pelo painel.

**Quem autoriza as consultas seguintes.** A primeira consulta de uma captura
iniciada no console roda com o acesso de quem clicou em "Iniciar captura
fiscal" (ou "Retomar captura"), como qualquer comando do console. Dali em
diante, as consultas que o stream agenda sozinho, e o processamento dos
documentos delas, rodam sob a **liberação da empresa** (ADR 0007, §4: com a
empresa liberada e o certificado ativo, a captura roda sem ação manual). A
operação guarda `sourceCaptureReleaseId` e a versão da liberação em
`sourceAccessVersion` (`release:<versão>`), e não herda mais
`sourceMembershipId` nem a versão de acesso da pessoa. Assim:

- trocar o papel ou tirar da organização quem iniciou não para a captura;
- desligar a captura no console ou a emergência da Freecorps cortam toda
  consulta na fila, pois a liberação deixa de valer; liberar de novo muda a
  versão e **não** ressuscita a consulta antiga: alguém com acesso inicia ou
  retoma de novo. O processamento do que já foi recebido segue (abaixo);
- o corte geral (`FNFE_CAPTURE_FISCAL`) também corta: a consulta que chegar
  à vez durante o corte pausa em atenção com `ACCESS_REVOKED`. Como a versão
  da liberação não muda, uma consulta ainda agendada quando a variável volta
  segue normalmente;
- projeto do console, encerramento da organização, ambiente servido e
  `siteCaptureDecision` continuam conferidos em cada etapa;
- capturas iniciadas por chave de API (ou conexão Stripe) seguem com a
  própria origem: revogar a chave para a captura dela, agora com atenção.

**O que já foi recebido continua disponível** (#420). O checkpoint só avança
depois que a resposta e cada envelope estão guardados, e cria na mesma
transação uma operação `documents.capture` por envelope; os NSU dela ficam
atrás do checkpoint, e nenhuma consulta seguinte os traz de novo. Por isso o
processamento desses envelopes não é cortado pela retirada no console, pela
emergência da Freecorps nem pelo corte geral (`FNFE_CAPTURE_FISCAL` ou
`FNFE_CAPTURE_TRANSPORT` desligados) nem pela parada geral persistida
(`captureFiscalHalts`, que só fecha `siteCaptureDecision`): a nota aparece em Documentos e na
exportação mesmo que a captura tenha sido desligada logo depois da consulta.
A alternativa, retomar essas operações na próxima liberação, deixaria notas
já recebidas invisíveis por tempo indeterminado, contra o contrato da
retirada.

Essa autorização é só de processamento local:

- a tarefa (`captureProcessingTask`) só lê o XML guardado e publica o
  documento. Ela nasce sem certificado (`continueOperation` com
  `useCertificate = false`), e com certificado deixa de valer como
  processamento; nunca passa por `siteCaptureDecision`,
  `certificateUse.authorize` nem pelo transporte;
- o ambiente é conferido para o propósito `capture-processing`
  (`environmentPurpose`), que a liberação retirada ainda atende, como a
  leitura; uma empresa nunca liberada continua sem produção;
- na origem da liberação, basta que a liberação que recebeu o envelope ainda
  seja a da empresa (mesmo registro, já liberada alguma vez), em qualquer
  versão; para a consulta, nada muda;
- continuam cortando: encerramento da organização, empresa fora da
  organização, projeto inativo ou com outra época, concessão revogada ou de
  outra época, chave revogada (captura de chave), pessoa sem acesso (filhas
  antigas com a pessoa como origem) e liberação expurgada. Sem o original
  guardado, a operação falha sem documento, como em qualquer importação;
- `captureProcessing.checkpoint` cria essa tarefa, e o reprocessamento de
  recusas técnicas (#499, [IMPORTS.md](IMPORTS.md#recusas-técnicas-de-um-leitor-anterior))
  a cria de novo para um original capturado e recusado por um leitor anterior,
  como continuação do pedido de uma pessoa, que fica como origem. O próprio
  pedido (`documents.reprocess_refusals`) é conferido para
  `capture-processing`, então vale com a liberação em vigor e depois de
  retirada, nunca numa empresa que nunca foi liberada;
  `operations.reserve` a recusa com `INVALID_REQUEST`.

As operações que já estavam pausadas com `ACCESS_REVOKED` antes da correção
voltam uma vez por `captures.resumeStoredDocuments`, chamada pelo
[runbook](../operacao/captura-fiscal.md#depois-do-deploy-da-420-documentos-presos).
Ela percorre `captureEnvelopes` em páginas de 50, numa cadeia agendada por ela
mesma, sem cron, e só retenta `documents.capture` de produção pausada com
`ACCESS_REVOKED` cuja origem `executionAllowed` admite agora. Repetir não
mexe numa operação já retomada, e o processamento não duplica documento: uma
versão por operação e o documento pela chave fiscal. O total separa
`resumed` (saiu de `paused`), `refused` (a origem não admite) e
`stillPaused` (retentada, mas pausada de novo, por código, como o orçamento
de recuperação esgotado). `captures.pausedStoredDocuments` lista, só lendo,
as que continuam pausadas, com ids, código e tipo de origem.

**Certificado atual.** Cada tentativa de uma captura de produção do site fixa
no `claim` o A1 ativo da empresa naquele momento, se for da própria empresa
(`ownCertificate`: mesma empresa, mesmo CNPJ, ativo e válido) e utilizável no
cofre. Renovar o A1 entre duas consultas não exige nada: a seguinte usa o
novo. Um A1 de outro CNPJ, vencido ou ausente não passa; a operação pausa com
`CERTIFICATE_UNAVAILABLE` (ou `ACCESS_REVOKED`, se o acesso também caiu).
Dentro de uma mesma tentativa o certificado continua fixo. Se o A1 for
renovado entre o `claim` e o cofre, nada é enviado: a tentativa espera um
segundo (`CERTIFICATE_CHANGED`) e a seguinte fixa o A1 novo; se ele venceu ou
saiu sem substituto, a operação pausa com `CERTIFICATE_UNAVAILABLE`, sem
incerteza. Se o A1 mudar depois da requisição, a resposta é descartada como
incerta e a operação para com `ACCESS_REVOKED`, como antes.

**Retomada automática** (`captureProcessing.resumeEligible`). O servidor
retoma sozinho, sem cron, um stream em atenção por causa que passou:

| Código                    | Quando é conferido de novo                                                |
| ------------------------- | ------------------------------------------------------------------------- |
| `QUOTA_EXCEEDED`          | Início do período de uso seguinte (mês UTC) e a cada novo plano atribuído |
| `PLAN_INACTIVE`           | Início da vigência de um plano futuro e a cada novo plano atribuído       |
| `PLAN_REQUIRED`           | A cada novo plano atribuído com cotas finitas de capturas e bytes         |
| `CERTIFICATE_UNAVAILABLE` | Quando o cofre ativa um certificado da empresa (`certificates.finish`)    |

A conferência é agendada pelo próprio stream para a versão atual dele: se
alguém retomou, pausou ou transferiu nesse meio-tempo, ela não faz nada. Com a
causa ainda presente, a cota volta a esperar o instante seguinte. Ela exige o
A1 próprio atual e o acesso da origem da consulta pausada (a liberação, ou a
pessoa se a pausa foi na primeira consulta); sem isso, fica a atenção para
alguém retomar. A nova consulta continua a pausada, como "Retomar captura":
mesmo checkpoint, reconciliação primeiro se a anterior ficou incerta, e a
janela da fonte preservada. Os demais códigos (`ACCESS_REVOKED`,
`FISCAL_TRANSPORT_DISABLED`, falhas de integridade e de tentativas) esperam
uma pessoa.

### Supervisão e alertas (#422)

Antes da #422, a Freecorps não ficava sabendo quando a captura de um cliente
parava ou pedia atenção: só o webhook do projeto dono do stream e os monitores
que o cliente configurou recebiam isso. A supervisão
(`lib/captureSupervision.ts`, `captureSupervisor.ts`) transforma em **alerta da
Freecorps** cada atenção de um stream de produção do site e o que uma
verificação periódica de cada empresa liberada encontra.

**O que vira alerta.** Cada alerta é uma linha de `captureAlerts`, única por
chave (`key`): repetir a verificação, reentregar a mesma execução ou refazer
a transação não cria outro.

| Tipo          | Quando                                                                                                                                                              | Chave                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `attention`   | O stream de produção entrou em atenção (`captureAttention`), com o código: um 656 é `SOURCE_CONSUMPTION_BLOCKED`; a recusa do gate do site, `CAPTURE_FISCAL_DENIED` | Stream e versão da transição                      |
| `stalled`     | Stream `active` sem operação corrente, com a operação `paused` ou `failed`, `succeeded` sem continuação há mais de 1 h, ou na fila com a vez vencida há mais de 1 h | Stream, versão, operação e estado dela            |
| `quiet`       | 30 e 50 dias sem consulta respondida (`lastSuccessAt`, ou a criação do stream), em qualquer estado, inclusive **pausado** ou em atenção                             | Stream, limite e início do período sem consulta   |
| `gap`         | Lacuna aberta (`recovery`) há 80 dias ou mais desde a última consulta antes dela (`quietSince`): a fonte guarda cada documento por 90 dias                          | Stream e detecção da lacuna                       |
| `certificate` | A1 próprio ativo da empresa a 30 dias e a 7 dias do vencimento; `0` quando vencido ou sem A1 próprio ativo                                                          | Empresa, certificado e limite                     |
| `supervisor`  | A própria verificação falhou ao avaliar a empresa (`SUPERVISION_FAILED`): registro inesperado, erro de leitura ou limite da transação                               | Empresa e primeira geração da sequência de falhas |

Só o limite mais grave de cada tipo é registrado numa verificação: uma
empresa liberada com cinco dias de A1 recebe o alerta de 7 dias, não também o
de 30. Uma consulta respondida inicia outro período sem consulta, que volta a
avisar aos 30 dias. Sandbox e o alvo da #50 não geram alerta: lá não há
liberação.

**Verificação por empresa, sem cron.** A liberação (`captureRelease.enable`)
arma `captureSupervisor.check` para a empresa. Cada execução consome a sua
geração (`captureSupervision.generation`), registra o que encontrou e agenda a
seguinte para dali a 6 horas (`SUPERVISION_INTERVAL`); uma execução atrasada
ou duplicada encontra outra geração e não faz nada. Com a liberação retirada,
a empresa bloqueada, a organização encerrada ou fora do site, a verificação
para sozinha, e só uma nova liberação a arma de novo. O corte por
`FNFE_CAPTURE_FISCAL` e a parada geral não param a verificação: uma captura
parada por eles também chega aos 60 dias. A verificação só lê o stream, a
operação dele e o A1; nunca consulta a fonte, nunca abre o cofre, não muda
stream nem operação e não emite webhook.

**A cadeia não para em silêncio.** A avaliação de cada execução
(`captureSupervisor.evaluate`) roda como subtransação, com limites próprios
de leitura, escrita e agendamento (`EVALUATION_LIMITS`). Se ela lançar, por um
registro inesperado, um erro de leitura ou um limite atingido, só ela é
desfeita: a execução agenda a seguinte do mesmo jeito, grava em
`captureSupervision.failingSince` a geração em que a sequência de falhas
começou e registra uma linha `capture_supervisor_error` (`console.error`, com
ids, geração e a mensagem do erro, com dígitos em forma de CNPJ mascarados) e
um alerta `supervisor`, um por sequência: as execuções seguintes que também
falharem não criam outro, e uma avaliação bem-sucedida encerra a sequência.
Além da liberação, cada transição auditada do stream de produção do site
(`captureAudit`: ativar, pausar, retomar, consultar, atenção, checkpoint)
rearma a verificação quando não há execução agendada, e
`captureSupervisor.survey` arma a que faltar, por exemplo numa empresa
liberada antes da #422. Com a verificação agendada, rearmar só lê.

A ADR 0007 (§4) proíbe cron para as consultas e mantém `FNFE_CRONS=off`; ela
não trata de uma agenda interna que só lê. A verificação segue o mesmo modelo
dos monitores operacionais ([OBSERVABILITY.md](OBSERVABILITY.md#monitores-e-alertas)):
agendamento explícito por registro, com geração, fora de `crons.ts`, que
continua vazio, e que `FNFE_CRONS` não desliga. Só existe com uma empresa
liberada, e liberar exige `FNFE_CAPTURE_FISCAL=enabled`; worktrees, previews e
a validação não têm nada agendado. Uma agenda geral do site continua
dependendo da decisão própria que a ADR pede.

**Sinal para a Freecorps.** Cada alerta gera, na mesma transação, uma linha de
log `capture_alert` em JSON (`console.warn`), com tipo, código, dias, estado do
stream e ids, nunca CNPJ nem nome da empresa, para busca nos logs do Convex.
A métrica é a própria tabela `captureAlerts`: `survey` devolve a contagem dos
últimos 30 dias por `kind` e `code` (`recent`), que separa cada 656
(`SOURCE_CONSUMPTION_BLOCKED`), cada `CAPTURE_FISCAL_DENIED` e cada outra
atenção em Produção. O site não tem log stream declarado
([OBSERVABILITY.md](OBSERVABILITY.md)); com um, a linha `capture_alert` serve
para a mesma contagem fora do Convex.

O destino do alerta é o **e-mail operacional** da Freecorps, enviado uma vez
por alerta pelo Email Sending da conta Cloudflare, o mesmo das contas:

- `FNFE_CAPTURE_ALERT_EMAIL`: de um a cinco endereços, separados por vírgula.
  No site, é só `operacao@nfe.freecorps.com.br`, a
  [caixa de operação](../operacao/operacao-email.md) lida no console;
- `EMAIL_MODE=cloudflare`, `CLOUDFLARE_EMAIL_API_TOKEN` e `ACCOUNT_EMAIL_FROM`,
  já exigidos pelo e-mail das contas;
- só no perfil `installation`; desenvolvimento e validação nunca enviam.

Sem algum deles, o alerta fica `unconfigured`: registrado, no log e na lista.
O envio (`captureSupervisor.deliver`) toma o alerta `pending` uma vez
(`sending`) e termina em `sent`, `failed` (4xx) ou `uncertain` (sem resposta);
nenhum é reenviado sozinho. Um alerta que fica em `sending` é um envio
interrompido no meio e vale como `uncertain`. Com 20 e-mails entregues ao provedor na última
hora, o alerta seguinte fica `suppressed`, para que um evento em massa (o
transporte removido para todas as empresas, por exemplo) não inunde a caixa.
Um alerta `suppressed` não vira e-mail nem depois: ele existe só no log (a
linha `capture_alert` da criação e uma `capture_alert_delivery` com
`suppressed`) e na lista, que traz a contagem dos últimos 30 dias em
`suppressed` e o alerta, com a entrega, entre os 10 mais recentes da empresa.
Não há resumo por e-mail dos suprimidos.
O e-mail traz tipo, código, estado e ids, e aponta a lista e o
[runbook](../operacao/captura-fiscal.md#alertas-da-captura).

**Teste do destino (#463).** `captureSupervisor.sendTestAlert`, pelo workflow
`capture-alert-test.yml` (`scripts/capture-release.mjs alert_test`), manda um
e-mail de teste aos mesmos endereços pela mesma chamada ao provedor. Assim a
chegada prova o destino sem esperar nem provocar o alerta de uma empresa. O
teste não lê nem grava registro, não conta no teto por hora e não é
reenviado: cada tentativa do run manda no máximo um, com o run no assunto. O
run só passa com `delivery: "sent"`; `unconfigured`, `failed` e `uncertain`
o deixam vermelho. O log e o recibo trazem o estado do destino, o número de
endereços e a resposta do provedor, nunca os endereços.

Escolhemos o e-mail por ser o menor mecanismo que chega a uma pessoa sem
segredo novo no Convex: o site já tem o provedor e o remetente. Uma issue do
GitHub pediria um token do GitHub no deployment ou um workflow agendado com a
deploy key do site.

**Visão interna.** `captureSupervisor.survey`, pelo workflow
`capture-release-list.yml` (`scripts/capture-release.mjs list`), lista cada
empresa com registro de liberação (liberada, retirada ou bloqueada), com a
situação do stream, o código, a última consulta respondida, a operação, o
certificado (próprio ou não, vencimento), o intervalo mínimo, a supervisão e
os 10 alertas mais recentes, além das chaves do deployment, da parada geral,
do destino dos alertas, da contagem dos últimos 30 dias e dos alertas
suprimidos no período. A supervisão diz se há verificação agendada (`armed`) e
se as últimas falharam (`failing`). Um registro inesperado de uma empresa não
derruba a lista: o que não pôde ser lido fica vazio e `error` traz o motivo.
São até 100 empresas (`truncated` acima disso). O log do run traz ids e estados; o nome da
empresa fica só no recibo; o CNPJ não sai do Convex. É uma mutation só porque
arma a supervisão que faltar; não muda liberação, stream nem dado do cliente.

**Aviso ao cliente.** O Início do console lista, para quem lê a empresa
(Proprietário, Administrador e, com acesso à empresa, Operador e Leitura), a
"Captura fiscal (Produção)" em atenção e a sem consulta respondida há 30 dias
ou mais, pausada ou não, enquanto a liberação vale. A pendência em atenção
traz o motivo, com as palavras do painel (`code` em `consoleHome.summary`), e
o link abre a aba da captura, onde está o que fazer. As contagens do mês
passam a separar os documentos recebidos em Produção
([frontend](../desenvolvimento/frontend.md#início)).

**Evento final.** Retirar uma liberação que estava valendo, no console ou pela
emergência da Freecorps, emite `connection.release_withdrawn` do stream de
produção, mesmo pausado (a versão do stream avança também nesse caso), com a chave `connection:<stream>:release_withdrawn:<versão
da liberação>`. Ele é emitido antes de a liberação mudar e é o único evento
cuja entrega sobrevive à retirada ([WEBHOOKS.md](WEBHOOKS.md#eventos-e-identidade)).
Vai aos destinos do projeto dono do stream, como qualquer `connection.*`: numa
captura iniciada no console, que não tem destinos, fica só na outbox.
Bloquear uma empresa nunca liberada não emite nada.

**Monitores.** Um monitor de `production` de empresa cuja captura foi
retirada para na avaliação seguinte, e o painel diz por quê
([OBSERVABILITY.md](OBSERVABILITY.md#monitores-e-alertas)).

### Passos humanos

Ligar e desligar no dia a dia: [captura-fiscal.md](../operacao/captura-fiscal.md).

1. Criar no GitHub o environment `capture-fiscal-emergency`, limitado à
   branch `main`.
2. Gerar uma deploy key de produção do deployment do site
   (`deploy/platform-release.json`) e gravá-la como `FNFE_SITE_DEPLOY_KEY`
   nesse environment, nunca no repositório.
3. Gravar `FNFE_CAPTURE_FISCAL=enabled` no deployment do site para que a
   seção apareça no console e as empresas possam ligar.
4. Gravar `FNFE_CAPTURE_TRANSPORT=sefaz` só quando a primeira empresa
   estiver pronta, e conferir `captureFiscal: "enabled"` no `/health`.
5. O corte de emergência de tudo é a parada geral pelo GitHub
   (`capture-fiscal-halt.yml`) ou, sem o GitHub, remover qualquer uma das
   duas no painel do Convex.
6. Ensaiar os workflows numa empresa de ensaio e registrar a evidência,
   pelo [roteiro](../operacao/captura-fiscal.md#ensaio-dos-workflows).
   Pendente.
7. Gravar `FNFE_CAPTURE_ALERT_EMAIL` no deployment do site com o endereço
   operacional da Freecorps, para os
   [alertas](#supervisão-e-alertas-422), e provar a chegada pelo
   [teste do e-mail](../operacao/captura-fiscal.md#testar-o-e-mail-dos-alertas).
   Feito em 28/10/2026: `operacao@nfe.freecorps.com.br`, com o teste do run
   40701209624 recebido na caixa de operação (#463).
8. Depois do primeiro deploy da #422, disparar `capture-release-list.yml` uma
   vez para armar a supervisão das empresas já liberadas e conferir
   `supervised: true` em cada uma. Feito no run 40146214809, de 24/10/2026,
   com as duas empresas liberadas.

## Execução fiscal manual da #50

O operador usa `scripts/fiscal-proof.mjs` fora do CI, em Windows, com uma pasta
privada fora dos checkouts. O runner recusa `CI`, `GITHUB_ACTIONS` e
`RUNNER_NAME`, e nenhum workflow o chama nem recebe a política, o PFX ou a
deploy key; `scripts/fiscal-proof-plan.test.ts` falha se um workflow passar a
mencioná-los. O deployment deve ser `dev`, exclusivo da prova, com referência
`dev/issue-50-fiscal-proof` ou essa referência com um sufixo da rodada, como
`dev/issue-50-fiscal-proof-20261020`. Produção, validação persistente e desenvolvimento
pessoal são recusados pelo nome. Todo comando falha com um código fixo em JSON,
sem payload remoto, e saída não zero.

### Roteiro do operador

1. **Autorização contextual.** O mantenedor registra, em local restrito, quem
   autoriza, quando e a referência do registro; a empresa e o CNPJ; o serviço
   `nfe-distribution`; o ambiente fiscal, `homologation` ou `production`; o
   SHA aprovado; o deployment dedicado; a janela de até três horas; e o
   orçamento de uma ou duas consultas. Em produção, só a leitura da
   distribuição; emissão, cancelamento e manifestação não podem ser
   autorizados por este roteiro. O SHA aprovado deve ser um commit cujo CI
   passou; sem a correção do 589 de 05/10, a retomada repetiria NSU 1. Uma
   rodada em produção exige SHA que contenha a liberação de produção da prova.
2. **Concorrência na fonte.** Antes da janela, confirmar com a empresa que
   nenhum outro software (ERP, contador, outro integrador) consulta a
   distribuição do mesmo CNPJ em homologação. O freecorpsNFE garante um único
   responsável interno, mas não impede consumidor externo; 656 indica conflito
   sem identificar o autor. O site hospedado é outro consumidor: um CNPJ
   liberado no site não entra na rodada
   ([regra](../operacao/captura-fiscal.md#dois-consumidores-do-mesmo-cnpj)). Conferir também se a NT e o pacote de schemas
   fixados acima continuam vigentes.
3. **Deployment dedicado.** Criar um deployment `dev` novo no projeto Convex,
   com a referência acima e sufixo da rodada, e uma deploy key só para ele.
   Não reutilizar o deployment de 05/10, que mantém a referência sem
   sufixo e teve a chave revogada.
4. **Pasta privada** fora de qualquer checkout, com acesso só do usuário
   Windows do operador:
   - `deployment.env` com `CONVEX_DEPLOY_KEY=dev:NOME|...`;
   - o PFX/P12 recebido da empresa, conferido por hash com o original;
   - `password.dpapi`, gerado na própria pasta, sem a senha passar pelo
     histórico do shell:
     `Read-Host -AsSecureString | ConvertFrom-SecureString | Set-Content -NoNewline -Encoding ascii password.dpapi`;
   - `plan.json`, sem valores padrão:

   ```json
   {
     "approvedSha": "SHA_COMPLETO_DE_40_CARACTERES",
     "target": {
       "name": "NOME-DO-DEPLOYMENT-123",
       "type": "dev",
       "reference": "dev/issue-50-fiscal-proof"
     },
     "service": "nfe-distribution",
     "fiscalEnvironment": "homologation",
     "authorization": {
       "approvedBy": "RESPONSAVEL",
       "approvedAt": 0,
       "reference": "REGISTRO_RESTRITO"
     },
     "company": { "cnpj": "CNPJ_COM_14_DIGITOS", "name": "RAZAO_SOCIAL", "address": {} },
     "pfxFile": "certificado.pfx",
     "startsAt": 0,
     "expiresAt": 0,
     "maxRequests": 1
   }
   ```

   `fiscalEnvironment` aceita somente `homologation` ou `production`.
   `approvedAt`, `startsAt` e `expiresAt` são milissegundos UTC; `address`
   segue o contrato de criação de empresa. Campo ausente ou inválido falha
   antes de qualquer rede, por exemplo `PLAN_SHA_REQUIRED`,
   `PLAN_TARGET_SHARED`, `PLAN_FISCAL_ENVIRONMENT_REQUIRED`,
   `PLAN_AUTHORIZATION_REQUIRED` ou `PLAN_WINDOW_REQUIRED`.

5. **Checkout no SHA aprovado**, limpo, com `git switch --detach SHA` e
   `vp install --frozen-lockfile`. `publish`, `provision` e `step` recusam
   outro HEAD (`CHECKOUT_NOT_APPROVED_SHA`) ou árvore suja (`CHECKOUT_DIRTY`),
   exigem autorização vigente (`AUTHORIZATION_INACTIVE`) e usam `run.lock` na
   pasta privada (`PROOF_LOCKED`). Um processo interrompido deixa o lock para
   conferência; removê-lo só depois de `inspect`.
6. **Execução**, nesta ordem, com o caminho absoluto da pasta privada:

   ```powershell
   bun scripts/fiscal-proof.mjs validate-local C:\CAMINHO\PRIVADO
   node scripts/fiscal-proof.mjs publish C:\CAMINHO\PRIVADO
   node scripts/fiscal-proof.mjs provision C:\CAMINHO\PRIVADO
   node scripts/fiscal-proof.mjs step C:\CAMINHO\PRIVADO
   node scripts/fiscal-proof.mjs inspect C:\CAMINHO\PRIVADO
   node scripts/fiscal-proof.mjs receipt C:\CAMINHO\PRIVADO
   node scripts/fiscal-proof.mjs stop C:\CAMINHO\PRIVADO
   ```

   - `validate-local` roda offline, com Bun, o mesmo validador do cofre:
     senha, chave, prazo, finalidade e CNPJ do plano. Recusa certificado que
     expira antes do fim da janela e grava `local-validation.json` com o hash
     do PFX.
   - `publish` grava no alvo, antes do código, `APP_ENV=validation`,
     `PRODUCT_ENV=sandbox` (ou `production` com `FNFE_PROOF_FISCAL_ENV=production`
     no plano de produção), `FISCAL_ENV=disabled`,
     `FNFE_CAPTURE_TRANSPORT=disabled`, `FNFE_CRONS=off`, e-mail e webhooks
     desligados e o `SITE_URL` da validação. Gera `BETTER_AUTH_SECRET` e a
     mestra do cofre só quando ausentes, sem imprimi-los. Um alvo já publicado
     mantém o ambiente fiscal da primeira publicação
     (`TARGET_FISCAL_ENVIRONMENT_MISMATCH`). Publica o SHA aprovado, restaura
     `buildInfo.ts` e confere `/health` (`productEnv` do plano) e zero crons.
   - `provision` e `step` são detalhados abaixo. `step` só roda dentro da
     janela (`FISCAL_WINDOW_CLOSED`), com transporte desligado no início,
     certificado ativo e janela da fonte vencida (`SOURCE_COOLDOWN`).
   - Cada `step` faz no máximo uma consulta e desliga o transporte ao
     terminar. Uma segunda consulta exige novo `step`, janela da fonte vencida
     e orçamento restante. Resultado incerto, reconciliação ou atenção não
     autorizam editar NSU nem antecipar a janela.
   - `pause` desliga o transporte e pausa o stream a qualquer momento, mesmo
     com outro SHA publicado; é o desligamento de emergência.

7. **Recibo sanitizado.** `receipt` grava `public-receipt.json` na pasta
   privada a partir de uma lista fechada de campos: SHA aprovado e publicado,
   alvo, serviço, ambiente fiscal, autorização, janela, chamadas autorizadas,
   estado da operação, `cStat`, modo, NSUs, hash e tamanho do bruto, hashes e
   schemas dos envelopes, checkpoint e estado de desligamento. Não copia CNPJ,
   razão social, IDs, storage, XML, senha, token ou chave; se algum desses
   valores aparecer, falha com `RECEIPT_NOT_SANITIZED`. O operador revisa o
   arquivo, guarda-o com os recibos da #50 pela regra de
   [evidência restrita](../v1.0/EVIDENCE-STORAGE.md#evidência-restrita) e
   escreve o README da rodada com o que foi e o que não foi comprovado. Os
   recibos das rodadas anteriores ficam no repositório arquivado, privado, e
   não estão neste repositório. Sem
   `source.status`, não houve resposta fiscal persistida.
8. **Desligamento e revogação.** `stop` desliga o transporte, pausa a captura e
   revoga o certificado, removendo o envelope do cofre. Gerar `receipt` de novo
   depois de `stop` registra o desligamento efetivo; ele ainda usa a deploy
   key. Em seguida, revogar a deploy key no painel, confirmar que o servidor a
   rejeita e registrar o horário no README.
9. **Dados.** Apagar da pasta privada o PFX e `password.dpapi` depois do
   `stop`; o original fica com a empresa. Manter em acesso restrito
   `plan.json`, `run-state.json`, `local-validation.json`, os recibos
   privados e, se a auditoria exigir, o snapshot exportado do deployment com
   seu SHA-256. XML fiscal e snapshot nunca entram no Git nem no CI. Não
   apagar histórico no deployment; documentos e lotes seguem a
   [retenção operacional](OBSERVABILITY.md) e o [restore](../operacao/restauracao.md).

### Rodada de produção: notas recebidas

A rodada de 05/10, em homologação, recebeu 589 com máximo zero: a fonte não
tinha documentos para o CNPJ. A empresa indicada pelo mantenedor recebe NF-e
em produção, e a fonte só oferece os últimos 90 dias. Por isso a rodada
seguinte usa `fiscalEnvironment: "production"`, só leitura. O roteiro acima
vale inteiro; esta seção acrescenta o que muda.

**Antes de autorizar**, registrar em custódia restrita, fora do Git:

1. CNPJ exato da empresa e pelo menos uma NF-e modelo 55 autorizada nos
   últimos 90 dias com esse CNPJ como destinatário ou em `autXML`, conferida
   pela chave de acesso na consulta pública do portal, sem chamar a
   distribuição. A janela precisa começar antes de essa nota sair dos 90 dias.
2. Certificado A1 da própria empresa, com o mesmo CNPJ do cadastro e validade
   além da janela. O `validate-local` confere isso offline.
3. Quem mais consulta a distribuição desse CNPJ em produção (ERP, contador,
   outro integrador). A consulta não altera o NSU de outro consumidor, mas
   consultas concorrentes podem gerar 656. Pedir a pausa durante a janela ou
   registrar que o risco foi aceito.
4. SHA da `main` que contenha a liberação de produção da prova, com CI verde.
5. Um deployment `dev` novo. Não reaproveitar alvo publicado em homologação,
   pois a marca do ambiente fiscal não muda depois da primeira publicação.
6. Janela de até três horas e `maxRequests: 2`.

**Sequência.** O primeiro `step` consulta `distNSU` desde o checkpoint zero.
Com documentos, a resposta esperada é 138 com envelopes. O checkpoint avança
até o último NSU contínuo persistido. Rodar `inspect` e guardar o recibo
antes de continuar. O segundo `step` só roda depois de `nextAllowedAt`: um
segundo se `ultNSU < maxNSU`, uma hora no fim da fila. Ele parte do
checkpoint persistido, sem NSU informado pelo operador. Uma resposta 138
avança de novo; 137 confirma o fim da fila com o checkpoint preservado.
Se vier 656, 589 ou resultado incerto, parar com `stop`. Não gastar a segunda
consulta para contornar o problema.

**Aceite.** Exige pelo menos um envelope persistido com hash e schema, e o
checkpoint do primeiro passo igual ao maior NSU contínuo desses envelopes. O
`requestNsu` do segundo passo precisa ser igual a esse checkpoint, e o
segundo checkpoint não pode ser menor. Também é preciso registrar se cada
envelope é resumo (`resNFe`), evento ou XML completo (`procNFe`). Sem
manifestação, o XML completo pode não vir; isso vira limite registrado, não
motivo para manifestar.

**Dados.** Os envelopes são documentos fiscais reais da empresa. Ficam no
deployment dedicado e no snapshot restrito, nunca no Git ou no CI. Só o
recibo sanitizado, com NSUs, schemas e hashes, vai para
`docs/v1.0/evidence/50/`. Apagar o deployment depende de decisão do
mantenedor, registrada no README da rodada.

### Comportamento do runner

`provision` usa conta operacional reservada `@validation.invalid`, sem enviar
e-mail, e as funções autenticadas normais para organização, empresa, projeto
e upload no cofre. O código exige checkout limpo e SHA idêntico ao plano e ao
health publicado. A conta tem senha aleatória e tenta encerrar a sessão após cada
comando. Falha no logout gera `SESSION_SIGN_OUT_FAILED`, sem substituir o resultado
original; a sessão pendente exige conferência e revogação pelo operador. Resposta
perdida em criação exige reconciliação; não repetir uma escrita indiscriminadamente.
Para projeto, o servidor reutiliza a mesma organização + referência externa
`issue-50` e recusa divergência de nome ou acesso, sem duplicar o registro.
Um certificado em validação ainda não libera `step`. Senha e acesso da conta
operacional usam DPAPI do usuário Windows, por Windows PowerShell 5.1 sem o
`PSModulePath` do PowerShell 7; não são argumentos do shell.

Quando o ambiente de produto da rodada for `production`, depois de
`provision` e antes de `step`, o operador precisa atribuir à organização um
plano vigente com cotas finitas de capturas e bytes, por `usage:assignPlan`
no deployment conferido. A política da #429 vale também na prova #50; o
runner não concede plano automaticamente. A franquia deve comportar as
consultas autorizadas e a reserva de 18 MiB por consulta. O orçamento fiscal
da rodada continua limitado separadamente a até duas chamadas. A prova
conserva a janela e a reserva em recusas do cofre, conforme o comportamento
próprio desse perfil; não as libere manualmente como se fossem resultado
incerto da fonte.

A captura ativada pelo console pertence ao projeto Console da organização
([ADR 0005](../adr/0005-console-sem-projeto.md)), não ao projeto `issue-50`.
Antes de ligar o transporte, `step` obtém esse projeto pela função interna
`captureProcessing:proofConsoleProject`, só pela deploy key e só em
`APP_ENV=validation`, e o fixa na política.

`step` configura `FISCAL_ENV` com o ambiente do plano e `FNFE_FISCAL_PROOF`,
cujo JSON fixa ambiente fiscal, deployment, SHA,
organização, projeto, empresa, CNPJ, ID/versão/fingerprint do certificado,
janela e limite de até duas chamadas. O servidor confere a política antes
da reserva e novamente antes de abrir o cofre para transporte. A contagem
usa autorizações persistidas em `certificateAudit`, em transação com a
nova autorização. Falha ou timeout consome o limite; alterar a janela não
zera o histórico do certificado. Retry HTTP, manual e agendado usam o mesmo
gate. Desligar transporte impede autorização de uma action antiga.
Actions Node leem o opt-in em `process.env` a cada execução, pois o executor
pode substituir o objeto entre chamadas. Na prova, a reserva conservadora de
uma hora permanece mesmo quando uma tentativa para antes do transporte; não
antecipar essa janela na operação real. Uma recusa do cofre na prova pausa com
`FISCAL_PROOF_DENIED`, sem incerteza nem reconciliação.

Depois de um lote concluído em homologação, a captura pausa, sem agendar a
próxima consulta e sem mudar checkpoint/cooldown. O comando desliga o transporte
ao terminar e pausa trabalho restante. Outra chamada exige `step` explícito,
janela da fonte vencida e orçamento restante. Crashes continuam sujeitos à
reconciliação existente; não editar NSU ou antecipar a janela para provar retry.
O runner encerra a espera quando a operação entra em reconciliação/retentativa
e renova o JWT antes de pausar: o token Convex dura 15 minutos. `pause` desliga
o transporte e pausa o stream sem revogar o certificado nem descartar incerteza.
Desligamento e pausa são tentados independentemente. Em `stop`, a revogação do
certificado também é tentada mesmo se uma etapa anterior falhar. Cada falha gera
um código próprio, sem payload remoto, e saída não zero; o comando não declara
encerramento completo. O diagnóstico original continua preservado.

O transporte extrai chave e cadeia do PFX autenticado somente em memória, usando
o mesmo parser limitado da validação, e cria o contexto TLS nativo a partir
delas. Assim, PFX com cifra legada funciona sem habilitar o provider legado do
OpenSSL nem reduzir validação de host, cadeia ou TLS. Os buffers temporários
são zerados depois da criação do contexto; o cofre preserva o PFX original.

Os recibos privados `fiscal-step-*.json` e `latest-evidence.json` registram SHA,
operação, status da fonte, lote persistido, checkpoint, hashes e número de
autorizações. Não contêm XML, senha ou envelope do certificado, mas contêm a
identidade do stream e IDs; por isso só `public-receipt.json` vai ao
repositório. A consulta interna limita os envelopes a 101, suficientes para o
teto de duas respostas de até 50 envelopes. Um recibo sem status da fonte não
comprova resposta fiscal. Uma resposta vazia comprova somente a consulta
efetivamente realizada; persistência de XML completo e retomada real dependem
do que a fonte devolver.

### Cobertura com transporte controlado

`tests/platform.captures.test.ts` cobre, sem chamada fiscal, os desfechos que
a prova real não deve provocar de propósito: crash antes e depois do bruto,
lease antiga, lote parcial, lacuna, NSU repetido, 589, 656, ativação
concorrente, transferência durante IO incerto e revogação do certificado com
consulta reservada. Também confere que sync, pausa/retomada, retry genérico e
negação da política antes do IO preservam a janela da fonte; que o orçamento é
consumido mesmo em falha; e que SHA, deployment, CNPJ, escopo, certificado,
fingerprint, janela e limite divergentes negam o transporte.
`tests/platform.siteCapture.test.ts` cobre, com o cofre e a requisição mTLS
simulados, o 656 com `ultNSU` acima do checkpoint (cursor e modo intactos),
cada recusa do cofre entre o `prepare` e a requisição (teto por hora, parada
geral, A1 renovado ou vencido, empresa retirada: nenhuma requisição, nenhuma
reconciliação, cota e janela devolvidas), a falha depois do envio, que
continua incerta, a retomada dentro da janela sem falha nem tentativa gasta e
o limiar do monitor de cursor com intervalo de 1 h e de 24 h.
`tests/platform.captureGap.test.ts` (#419) cobre, com uma fonte simulada atrás
do worker, do cofre e da requisição mTLS reais: lacuna recuperável em lote no
orçamento por hora e sob o teto do site, lacuna expirada (137, limite, aceitar
a perda, `distNSU` depois, `history_limited`), lacuna mista, stream parado
antes da #419, stream antigo em `consNSU` por um 656, cada papel na ação
(só o Proprietário aceita), motivo vazio, longo demais ou com caractere de
controle, o motivo na auditoria, idempotência e corrida de versão. O bloco da #442 ativa a captura pela chave
da integração e cobre a falta de saída pela API, a aceitação no console com a
consulta seguinte na chave da integração, cada papel (Administrador recusado),
motivo inválido, login sem membership,
outra organização, chave revogada, concessão sem `connections:write`,
repetição, corrida com retomar e pausar pela API e o console sem pausar,
retomar nem transferir. Cobre também `connection.history_limited`: o corpo
exato, uma entrega só para o destino que assinou, assinada pelo worker e
verificada por `verifyWebhook`, um evento só com repetições, nenhum na
captura do console e nenhum em cada recusa. Esses testes não são evidência
fiscal.
