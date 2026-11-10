# Operação, auditoria e suporte

Implementação da observabilidade, B09/F08, sobre as entregas gestão de operações, entrega de webhooks e captura NF-e.
A interface fica em `/app/:organizationSlug/operations`. Proprietários e
administradores da organização consultam a auditoria e configuram monitores.
O servidor confirma identidade e associação ativa em cada chamada. Operadores,
desenvolvedores, viewers e chaves de integração não recebem acesso à auditoria
geral. Ações fiscais continuam nos controles autorizados dos respectivos domínios.

## Referências e conteúdo permitido

O wrapper REST gera `requestId` antes da validação e substitui qualquer valor
recebido em `X-Request-Id`. Resposta JSON e header usam a mesma referência.
Os registros HTTP contêm nome da rota do contrato, status e duração; nunca
URL completa, corpo, cookie, API key ou mensagem de exceção.

Uma chave válida vincula a ocorrência ao seu projeto. Referências de operações
em respostas autorizadas são conferidas no banco antes da associação. Upload e download privados registram status e duração sem ler o corpo na
instrumentação. A conclusão autorizada grava a referência na auditoria do
escopo do ticket. Erros sem escopo autorizado ficam somente nos logs. Falhas
de autenticação não geram auditoria persistida. Chaves inválidas identificadas
na admissão REST recebem 401 antes da instrumentação por chamada.
Se a gravação da telemetria falhar após um comando, a resposta do comando é
preservada e o log registra `telemetry_unavailable` com a referência.

O [limitador REST](USAGE.md#proteção-das-requisições-rest) atua antes do domínio
e da instrumentação. Recusas não geram log/recibo por chamada. Um diagnóstico
`http.rateLimited` por organização por minuto, no máximo, conserva requestId,
ator e status 429 sem corpo, URL ou segredo. A amostragem não mede o total de
recusas. Transferências por ticket auditam o escopo do ticket; um header Bearer
adicional não produz auditoria de chave. O download de um original pelo
console grava `http.documentDownload` com o artefato como alvo; o do DANFE
(#402), pela REST ou pelo console, grava `http.danfeDownload` com o documento
como alvo e a chave (`key:<id>`) ou o membro como ator, só quando o PDF lido
ainda é o atual.

Operações, certificados, captura, organizações, empresas, projetos, eventos e
tentativas de webhook alimentam `operationalAudit` na mesma transação da
auditoria do domínio. `operationId` identifica a execução lógica; `eventId`
identifica o evento público. Uma tentativa de webhook não cria outro evento.
A correlação opcional da outbox confere até 20 operações. Uma referência
inexistente ou fora do escopo é ignorada, sem cancelar a alteração do domínio
nem vincular dados de outro cliente. Se nenhum vínculo for válido, o evento
conserva auditoria sem operationId e com código CORRELATION_INCOMPLETE. O log
de diagnóstico contém apenas o eventId, sem a referência inválida.
As auditorias anteriores continuam armazenadas nos módulos de origem. A
consulta unificada começa nesta versão; não há backfill implícito.

A busca aceita requestId, operationId, eventId ou alvo, sempre dentro da
organização atual. Cada índice retorna no máximo 25 ou 50 registros; a resposta
consolidada limita-se a 100. A auditoria aceita ator, ação e intervalo de até
366 dias, com páginas de até 50, teto de 100 linhas lidas e 1 MiB por consulta.
Referências são copiadas por ação explícita. A consulta de operação usada
pelo suporte omite `result`; XML e documentos não são anexados nem carregados
automaticamente. Para investigar um histórico maior, use a auditoria paginada.

### Investigação por link e leitura da trilha no console

A investigação abre pela URL `/app/:organizationSlug/operations?ref=<referência>`,
com requestId, operationId, eventId ou alvo. Outras telas podem linkar para
ela; o parâmetro é só um seletor, e a mesma query `investigate` confere o
gestor e a organização. Buscar pelo formulário grava o `ref` na URL, e
"Limpar investigação" o remove. Cada registro da trilha, alerta e resultado
tem "Investigar esta referência".

Ações e códigos aparecem em pt-BR pelo mapa central de
`apps/console/src/operation-labels.ts`; uma ação sem tradução aparece pelo
código, sem sumir. O código bruto, o ator e a referência continuam em
"Detalhes técnicos" de cada registro. Registros iguais seguidos da mesma
operação ou alvo (mesma ação, ator, código e status) aparecem agrupados, com a
contagem e o intervalo; eventos de outras operações no meio não separam o
grupo, e uma etapa diferente da mesma operação separa.

Nomes vêm de `observability.names`, query de gestor que recebe até 100
atores, empresas e projetos e devolve só os que pertencem à organização
pedida: membro (`membership:`, `member:`, id puro), usuário (`user:`, pela
associação na organização) e chave (`key:`). Referência de outra organização
ou inexistente fica fora da resposta, e a tela usa um rótulo genérico ("Membro
da organização", "Chave de API", "Sistema (automático)"). O isolamento está
em `platform/convex/observability.test.ts`. Monitores mostram empresa, projeto
e responsável pelo nome; os ids ficam em "Referências para suporte".

## Monitores e alertas

Cada monitor pertence a organização, projeto, empresa e ambiente. Até 20
escopos por organização; responsável deve ser owner/admin ativo da mesma
organização. Configuração usa geração esperada para recusar edição concorrente.
Monitores pausados podem ser removidos por owner/admin, liberando a cota;
a auditoria e as notificações anteriores conservam seu prazo de retenção.
Somente um monitor existe para a mesma combinação de projeto/empresa/ambiente.

A ativação agenda uma avaliação imediata e, depois, uma por minuto. A geração
consumida impede que uma chamada repetida crie uma segunda cadeia. Pausar cancela
o próximo agendamento. Revogar o responsável, projeto ou concessão desativa o
monitor, e o painel diz por quê (#422): a avaliação grava em `stopped` o
código e a hora, `CAPTURE_RELEASE_WITHDRAWN` quando um monitor de `production`
parou porque a captura fiscal da empresa foi retirada (no console, pela
emergência ou pelo corte `FNFE_CAPTURE_FISCAL`) e `ACCESS_REVOKED` nas demais
perdas de acesso. O monitor não volta sozinho; salvar a configuração de novo
limpa o aviso, e em `production` isso exige a captura liberada outra vez.
Crons da plataforma continuam vazios; agendamentos explícitos de um
monitor ativo são trabalho persistido e retomam quando o backend local reinicia.

| Sinal       | Medição                                                                                                        | Limiar inicial | Responsável funcional      |
| ----------- | -------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------- |
| Fila        | Maior atraso sobre a próxima tentativa de queued/retry_wait/reconciling                                        | 5 minutos      | Backend/operação           |
| Lease       | Operações running com lease vencida                                                                            | 1              | Backend/operação           |
| Cursor      | Tempo desde último sucesso, ou ativação quando ainda não houve sucesso                                         | 120 minutos    | Backend/fiscal             |
| Fonte       | Tentativas encerradas com falha na última hora, por NF-e, OpenCNPJ, emissão NFS-e, processamento XML ou outros | 3 por fonte    | Backend/integrações        |
| Webhook     | Idade da entrega pendente mais antiga, inclusive failed/paused                                                 | 15 minutos     | Integrações/app consumidor |
| Certificado | Tempo até expiração do certificado ativo                                                                       | 30 dias        | Administrador da empresa   |

O monitor lê o registro mais antigo pelos índices, até limiar mais um para
leases e falhas por fonte, com teto de 101, e o limite existente de destinos
de webhook. As fontes vêm de uma lista só, `OPERATION_SOURCES` em
`platform/convex/lib/operationSources.ts`, que valida a gravação em
`operationalFailures` e define as fontes lidas. Nos limiares iniciais são até
2 leases e 4 falhas por fonte. Contagens truncadas aparecem como limite
inferior. Observação incompleta ou ausente não comprova recuperação.
Cursor sem captura e certificado sem versão ativa aparecem como sem medição.
Esperas antes do envio (janela da fonte, teto por hora, parada geral) não são
falhas da fonte ([CAPTURE.md](CAPTURE.md#coordenação-e-recuperação)).
Em `production` de empresa com captura fiscal liberada, o cursor é avaliado
com pelo menos o intervalo mínimo da liberação (1 a 24 h) mais uma hora: no
fim da fila a captura espera esse intervalo entre dois sucessos, e a hora a
mais é a mesma folga que os 120 minutos dão sobre o intervalo padrão de uma
hora, o bastante para o agendamento e uma janela perdida (108/109 ou o teto
por hora) antes do alerta. Um 999 da Receita (#195) espera o intervalo
inteiro antes de repetir a consulta, então numa empresa com intervalo de 2 h
ou mais o cursor alerta já no primeiro 999: é o aviso de que a captura está
sem resposta, mesmo com ela ainda tentando. Um limiar configurado maior
continua valendo; o alerta registra o limiar efetivo.
O limiar de quantidade não pode superar 100, para que a contagem limitada seja
suficiente para decidir abertura. Tempo e certificado usam milissegundos no
backend; o formulário apresenta minutos/dias.

Alertas conservam uma ocorrência atual por monitor/sinal e registram mudanças
de estado na auditoria. A preferência controla notificações no painel. O canal
desta entrega é o produto; não há envio automático de e-mail ao cliente. Os
alertas da Freecorps sobre a captura no site são outro canal, com e-mail
operacional próprio ([supervisão](CAPTURE.md#supervisão-e-alertas-422)). O alerta continua
visível com notificações desativadas. A reabertura tem intervalo mínimo de uma
hora para nova notificação; a configuração não altera a fila fiscal.

## Runbooks

1. Fila/lease: copie a referência, abra a investigação e confira estado, código
   e incerteza. Pause pelo controle da operação. Retomada usa geração, orçamento
   e permissões existentes. Se houver efeito externo incerto, reconcilie; não
   substitua documento, número ou chave de idempotência.
2. Cursor/fonte: abra a empresa e confira captura, certificado e próxima janela.
   Pausar/retomar preserva checkpoint e cooldown. Não editar NSU nem assumir que
   ausência de resposta significa ausência de efeito no fisco.
3. Webhook: abra projeto e destino, confira código e tentativa. Corrija a
   configuração autorizada e use o reenvio existente. O consumidor deduplica
   pelo evento; uma nova tentativa não promete entrega exatamente uma vez.
4. Certificado: abra a empresa, envie versão sintética no ensaio ou a versão
   autorizada no ambiente próprio, aguarde validação e confira versão ativa.
   Não compartilhar PFX, senha ou XML para identificar o incidente.
5. Autenticação: verificar avisos de consulta sem índice e leitura da limpeza
   `rateLimit.lastRequest`. O patch da versão 0.12.5 acrescenta esse índice,
   preservando o índice por chave, limites, contadores e janelas existentes.
6. Publicação com defeito: não tem monitor próprio. Reverta pelo procedimento
   de [Reverter uma publicação](../operacao/deploy-producao.md#reverter-uma-publicação):
   o revert entra por PR, mantém o schema do Convex que a produção já usa e
   não desfaz dados gravados nem efeitos externos.

Após a ação, aguarde nova avaliação. O alerta só recupera com observação abaixo
do limiar. Registre responsável, referência e resultado no acompanhamento.
O ensaio local, comandos, massa e limites estão em evidence/80.
O ensaio hospedado conjunto cobre 20 monitores,
deduplicação, controle de operação incerta e recuperação dos seis sinais após
reparo simulado. Não comprova transporte fiscal, rotação real de PFX ou entrega
de webhook. O orçamento proposto é US$ 20/mês por organização com 20 monitores
nos limiares iniciais, antes de franquias, para chamadas e IO das avaliações.
Limiar 100 conserva a leitura anterior; reservar até US$ 80/mês nesse cenário.
Reavaliar ao mudar frequência, volume de destinos ou preços do provedor.

A rodada de 05/10, no SHA `4192e63`,
repetiu os oito cenários operacionais e a capacidade de 20 monitores. Na janela
completa, 27 avaliações terminaram sem erro, com p95 de execução de 236 ms;
o monitor mais antigo tinha sido conferido havia 18,3 segundos, dentro da meta
de 90 segundos. O custo marginal projetado foi US$ 14,88/mês para chamadas e
IO das avaliações, abaixo do orçamento de US$ 20. A rodada leu quatro fontes;
desde a #111 o monitor lê cinco, uma consulta de índice a mais por avaliação,
ainda não medida no hospedado. A rodada também ensaiou pausa
de cursor com preservação de checkpoint/cooldown, recusa de retomada com
certificado apenas de metadados e retry idempotente de webhook com transporte
desativado. Recuperação de fonte e certificado permaneceu simulada.

O aceite técnico consolidado em 06/10
considera esses ensaios atendidos. Os prazos operacionais foram aprovados em
06/10, com o mantenedor responsável por operação e fiscal/privacidade.
O próximo trabalho da #80 é implementar e comprovar as decisões. Os ensaios
de monitores e expurgo no banco ativo permanecem aceitos. O expurgo após
restauração exige a prova específica descrita no
[registro de retenção aprovado para implementação](RETENTION.md#proposta-operacional-de-06102026).

## Retenção e revisão antes da operação pública

A [revisão da política pública](RETENTION.md) reúne os prazos conferidos no
código, os responsáveis e as decisões que faltam para o aceite. Distingue
expiração de cache, expurgo do banco vivo e conservação em backups.

Estes são prazos técnicos do ambiente de validação, não uma declaração de
prazo legal de guarda fiscal. A revisão do serviço hospedado cabe ao mantenedor,
operação e responsável fiscal/privacidade, acompanhada na avaliação de prontidão antes do piloto
público. Deve cobrir finalidade, contratos, jurisdição, atendimento a direitos,
backup, restauração e custódia de certificados. Aprovação dessa revisão
não é inferida de teste, merge ou publicação.

O inventário por classe, os responsáveis e as evidências ainda necessárias
estão em [RETENTION.md](RETENTION.md). Inclui os metadados de limitação de
requisições, que não têm TTL e cujo reset altera o saldo disponível.

| Classe                                              | Política desta implementação                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Rastros HTTP persistidos                            | 30 dias, somente campos permitidos                                                    |
| Recibos REST de empresas                            | 30 dias completos; compactação em totais por projeto/ambiente/rota, conforme USAGE.md |
| Notificações no painel                              | 30 dias                                                                               |
| Amostras de falha por fonte                         | 7 dias; janela de alerta de uma hora                                                  |
| Projeção de auditoria operacional                   | 365 dias; auditorias originais preservadas                                            |
| Registros de acesso do console e da API REST        | 184 dias em `accessRecords`, conforme RETENTION.md                                    |
| Logs do runtime Convex                              | Retenção do provedor; revisar configuração e eventual exportação antes do público     |
| Cache cadastral                                     | Mantém expurgo e prazo definidos em REGISTRY.md                                       |
| Tentativas de operação/webhook e auditoria original | Conservadas; após o encerramento, guarda fiscal e expurgo conforme RETENTION.md       |
| XML, lotes brutos, versões e identidade fiscal      | Conservados; após o encerramento, guarda fiscal e expurgo conforme RETENTION.md       |
| PFX/senhas                                          | Ciclo de vida do cofre em CERTIFICATES.md; nunca copiados para telemetria             |

O primeiro registro arma a próxima expiração por organização. A limpeza usa
índices organização+expiresAt, remove até 50 itens por classe e continua em outra
transação se necessário. Sem dados pendentes, não mantém tarefa recorrente.
Esse expurgo não altera documentos, tentativas, idempotência, cursor nem eventos
da outbox. Recibos REST usam o índice organização+dia+partição, em lotes de 50,
com agregação e exclusão na mesma transação. O backfill de agendamentos para
registros antigos está em [USAGE.md](USAGE.md#ativação-para-os-recibos-existentes).

## Logs dos provedores, D03

D03, aprovada em 06/10, usa a retenção nativa de cada provedor no piloto, sem
criar destino novo de exportação contínua. Cópias pontuais para diagnóstico
ficam em acesso restrito por até 30 dias, salvo incidente com exceção e data
de revisão registradas. A [decisão](RETENTION.md#proposta-operacional-de-06102026)
exige inventariar os destinos já existentes antes de vigorar. Esta seção diz o
que a aplicação escreve, onde pode chegar e o que conferir; nenhuma
configuração dos provedores foi consultada para escrevê-la.

### O que a aplicação escreve

O backend escreve linhas JSON com ids internos, rota, estado e duração:
`http`, `operational` (os campos de `auditFields`), `organization.purged`,
`access_record_unavailable`, `telemetry_unavailable` e
`telemetry_correlation_incomplete`, `capture_alert` e `capture_alert_delivery`
(alertas da captura no site e o envio do e-mail deles,
[#422](CAPTURE.md#supervisão-e-alertas-422)), além dos avisos
`ACCESS_RECORD_UNAVAILABLE` e `ACCOUNT_EMAIL_UNAVAILABLE`. Nenhuma delas leva corpo, headers, XML, IP,
e-mail, API key ou PFX. Isso vale para o que o código escreve; os provedores
acrescentam metadados próprios, como URL, IP do cliente e user agent nos logs
de invocação do Worker, e erros não tratados do runtime podem trazer stack.

### Destinos a conferir

| Destino                                                              | O que pode conter                                                 | No repositório                                                                       | Conferir na instalação                                                                                             |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Logs de funções do Convex, `prod:elated-possum-295`                  | Linhas acima, nomes de funções, erros                             | Nada configura retenção                                                              | Histórico do painel, membros do time com acesso, plano                                                             |
| Log streams do Convex                                                | Cópia contínua dos logs de funções                                | Nenhum declarado                                                                     | Que não exista integração em Settings; se existir, destino, região, retenção e acesso                              |
| Workers Logs do `freecorpsnfe-backoffice`                            | Invocações com URL, IP do cliente, status e `console.*` do Worker | `releaseWorker` em `scripts/lib/platform-release.mjs` não declara `observability`    | Se está habilitado no painel, plano (três dias no Free, sete no Paid, conforme a documentação consultada em 06/10) |
| Logpush e Tail Workers da conta e da zona `freecorps.com.br`         | Requisições HTTP com IP, URL e user agent                         | Sem `logpush` nem `tail_consumers` na configuração versionada                        | Jobs de Logpush da conta e da zona, Tail Workers ligados ao Worker                                                 |
| Logs HTTP da zona `freecorps.com.br` (Observability → Logs)          | Requisições com IP de origem, host, path e status                 | Nada configura                                                                       | Prazo do histórico no painel                                                                                       |
| Cloudflare Email Sending                                             | Destinatário, remetente e status de cada e-mail de conta          | Token e remetente fora do repositório, conforme [e-mail de contas](ACCOUNT-EMAIL.md) | Retenção e acesso ao histórico de envio no painel                                                                  |
| GitHub Actions: logs e artefatos                                     | Saída de CI, publicação e backup; recibos sanitizados             | `retention-days` de 14 ou 30 nos artefatos dos workflows                             | Retenção de logs do repositório (Settings → Actions) e quem lê os logs dos workflows de publicação e backup        |
| Runners antigos: Blacksmith (até 09/11/2026) e VPS `freecorps-linux` | Diretório de trabalho e logs do agente de runner                  | Nenhum job atual usa esses runners                                                   | Limpeza do diretório de trabalho e rotação dos logs do agente no VPS                                               |
| Cópias de diagnóstico                                                | Trechos de log exportados por uma pessoa                          | Nenhuma                                                                              | Registro no registro restrito com data de descarte em até 30 dias                                                  |

O backup externo de D04 e a exportação de clientes têm retenção própria em
[Backup externo](../operacao/backup.md) e [Exportação](EXPORTS.md); não são logs.

### Como conferir e registrar

1. Conferir o alvo pelo [plano de publicação](../../deploy/platform-release.json)
   e por [deploy-producao.md](../operacao/deploy-producao.md). Só leitura: não habilitar, desabilitar nem
   alterar destinos durante o inventário.
2. Para cada linha da tabela, anotar se o destino existe, plano, região,
   retenção efetiva, quem tem acesso e como o dado sai ao fim do prazo.
   Captura de tela só sem token, IP ou e-mail visível.
3. Destino que guarde por mais tempo que o aprovado, ou exportação contínua
   não prevista, vira decisão do responsável: desligar, reduzir ou registrar
   exceção com motivo e data de revisão.
4. Guardar o recibo sanitizado em `docs/v1.0/evidence/d03-provider-logs/`,
   com data, alvo e quem conferiu, e citar a conclusão em
   [Retenção](RETENTION.md). Os registros de acesso do Marco Civil ficam em
   `accessRecords` por 184 dias e não dependem desses logs.
5. Repetir a conferência quando mudar plano, Worker, deployment ou destino de
   log, e antes de publicar a política de D06.

Cópias de diagnóstico: exportar só o trecho necessário, guardar em local
restrito, registrar a referência e a data de descarte no registro restrito de
[atendimento a direitos](RETENTION.md#canal-de-atendimento-d02) e apagar em até
30 dias. Um incidente que precise de mais tempo registra a exceção e a data de
revisão no mesmo lugar.
