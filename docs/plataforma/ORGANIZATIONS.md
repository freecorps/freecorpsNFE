# Organizações, membros e convites

Organização é o espaço que reúne uma equipe e seus dados privados. Membership
é o vínculo de uma identidade verificada com esse espaço, incluindo o papel
e o estado do acesso. Convite é uma concessão proposta a um e-mail; só o aceite
pela identidade verificada correspondente cria ou reativa o membership.
Uma conta pode participar de várias organizações com papéis diferentes.

A sessão Better Auth dura sete dias e, ao ser consultada após 24 horas desde
a criação ou última renovação, passa a valer por mais sete dias. Fechar o site
e voltar no mesmo navegador preserva o login enquanto a sessão estiver válida
e o armazenamento da origem não tiver sido apagado. Logout, revogação e
recuperação de senha continuam invalidando a sessão no servidor. Sessões
já vencidas exigem novo login; a mudança de prazo não as reativa.

## Matriz do recorte B02/F01

| Operação                                               | Owner | Admin | Developer | Operator | Viewer |
| ------------------------------------------------------ | ----- | ----- | --------- | -------- | ------ |
| Ver contexto próprio e trocar organização              | Sim   | Sim   | Sim       | Sim      | Sim    |
| Ver membros, convites e atividade                      | Sim   | Sim   | Não       | Não      | Não    |
| Alterar nome da organização                            | Sim   | Sim   | Não       | Não      | Não    |
| Convidar/alterar/remover developer, operator ou viewer | Sim   | Sim   | Não       | Não      | Não    |
| Convidar/alterar/remover admin ou owner                | Sim   | Não   | Não       | Não      | Não    |
| Remover ou rebaixar o último owner                     | Não   | Não   | Não       | Não      | Não    |
| Ampliar o próprio papel                                | Não   | Não   | Não       | Não      | Não    |
| Encerrar a organização                                 | Sim   | Não   | Não       | Não      | Não    |
| Aceitar os termos de uso                               | Sim   | Não   | Não       | Não      | Não    |
| Manter ativa no aviso de arquivamento (Gratuito)       | Sim   | Sim   | Não       | Não      | Não    |
| Exportar a organização durante o encerramento          | Sim   | Sim   | Não       | Não      | Não    |

Criar uma organização exige conta verificada e concede owner ao criador. O
papel que a pessoa possui em outra organização não interfere nessa criação.
Com uma versão dos [termos de uso](#termos-de-uso) em vigor, o criador também
os aceita no mesmo formulário.
Os papéis operator/viewer de `validationAccess` só autorizam o console de
validação. A navegação do protótipo usa os mesmos cinco nomes, mas continua
sintética e não concede acesso a nenhuma organização persistida.

Projetos, empresas, documentos, chaves e integrações seguem os contratos
próprios, como [COMPANIES.md](COMPANIES.md) e [PROJECTS.md](PROJECTS.md). Os flags de capacidade compartilhados representam o
limite do papel; não substituem concessões por projeto/empresa. Developer
não recebe permissão fiscal adicional. A simulação de importação e captura
usa operator, em conformidade com a
[referência do backend](arquitetura-backend.md#identidade-autorização-e-ambiente).

## Autorização e concorrência

Toda query/mutation pública resolve a identidade e a sessão pelo componente
Better Auth, exige e-mail verificado e consulta o membership ativo. Slug,
organizationId, membershipId, invitationId e papel enviados pelo cliente
nunca substituem essas verificações. Alvos de edição precisam pertencer à
mesma organização autorizada. A lista de memberships de uma pessoa, membros,
convites e atividade é paginada com índices e páginas de até 50 registros.

`ownerCount` e `memberCount` são atualizados na mesma transação que cria,
aceita, remove ou altera um vínculo. O documento da organização participa
da concorrência otimista do Convex: duas remoções/rebaixamentos não podem
reduzir o número de proprietários a zero. Edições de membership exigem a
versão observada, recusando formulários antigos com `MEMBERSHIP_CHANGED`.

Todas as alterações de concessão/remoção e os estados de convite escrevem
`organizationAudit` na transação correspondente. O registro conserva ator,
alvo, ação, papéis anteriores/posteriores quando aplicáveis e horário do
servidor. Nenhum código de convite aparece na auditoria ou nos DTOs de lista.

## Ciclo do convite

1. O gestor informa e-mail e papel e aciona **Enviar convite**. O código só
   chega à pessoa por e-mail: sem e-mail de contas (`accountPolicy`, fora do
   perfil local), `account.capabilities.invitationEmail` é `false` e o console
   não oferece o envio nem "Aceitar convite" nos menus.
2. Uma action gera 32 bytes aleatórios e envia apenas o SHA-256 para uma
   mutation interna. Ela revalida o gestor e reserva `sending`. Existe no
   máximo um convite válido pendente/em envio por organização e e-mail.
3. O adapter existente envia a mensagem. Uma mutation confirma `pending`
   apenas após aceite do destinatário pelo provedor, ou pelo coletor local.
   Resposta ambígua/falha deixa `delivery-failed`, sem autorização de aceite.
   Não há retry automático, cron, webhook ou envio na renderização da página.
4. A mensagem traz o link `/accept-invitation#code=…` e o código de 64
   caracteres. O código vai no fragmento, que o navegador não envia a nenhum
   servidor nem no Referer; o console o lê para a memória na abertura e o tira
   do endereço (um `?code=` de link antigo também é aceito e removido). Sem
   sessão, o console pede o login e volta ao convite (`?redirect=`), com o
   código ainda só em memória; uma recarga o perde e basta abrir o link de
   novo. Quem preferir cola o código num campo de texto visível. A pessoa
   confere organização/papel e confirma. A mutation de consumo revalida
   identidade, e-mail normalizado, prazo de 72 horas, estado pendente,
   concessão do emissor e ausência de encerramento da organização. O código continua de uso único e não é registrado
   em log, URL, `localStorage` ou `sessionStorage`.
5. O aceite e a criação/reativação do membership ocorrem juntos. Uma segunda
   tentativa não consome novamente. Convite nunca sobrescreve membro ativo.

Remoção ou alteração do papel do emissor invalida seus convites ainda abertos
pela versão do membership. Remover um destinatário revoga também os convites
pendentes para seu e-mail; só um novo convite pode restabelecer o acesso.
Revogar um convite na tela de membros pede confirmação, porque o link e o
código deixam de valer na hora. Revogação durante o envio impede que a
confirmação tardia o reative. Se o
processo parar em `sending`, uma nova ação explícita após um minuto substitui
essa reserva; o código anterior passa a revogado.

Limites transacionais: cinco criações de organização/minuto/identidade,
dez convites/minuto/emissor e três/minuto/destinatário. Conferência e aceite
compartilham vinte tentativas/minuto/identidade. Não há limite de organizações
silenciosamente aplicado às listas.

O serviço Cloudflare mantém remetente e destinatários explicitamente
configurados. A gestão de organizações não amplia a allowlist nem habilita envio externo em dev.
No ambiente local, `developmentMail` conserva temporariamente o código para
teste, acessível apenas pela função interna e credencial do operador;
`bun run worktree:mail` mostra também o link do convite. A
retenção do coletor é de dez minutos; o convite no domínio expira em 72 horas.
O adapter não registra payload, código, credenciais ou resposta do provedor.

## Encerramento

Em **Configurações**, o owner encerra a organização digitando
o endereço dela. A mutation `organizationClosure.close` confere o papel e a
confirmação (`CONFIRMATION_MISMATCH`), recusa enquanto houver plano anual em
vigor ou agendado (`ANNUAL_TERM_ACTIVE`; o anual termina pelo suporte,
[BILLING.md](BILLING.md#plano-anual)) e registra
`organization.closure-requested`. Daí em diante, toda função da organização
responde `ORGANIZATION_CLOSED`, exceto o contexto e a exportação da
organização. O console mostra o aviso com as datas e só abre a página de
exportações. Sem owner que consiga entrar, a Freecorps encerra pela função
interna `organizationClosure.closeByOperator`, recusada para organização com
plano não encerrado que não seja `free`, recibo ou pedido de plano aguardando
pagamento, liberação, conexão Stripe ou dado fiscal de produção
([checagens](RETENTION.md#encerramento-implementado-d01)). A Freecorps também
encerra, depois de um aviso de 30 dias, a organização que só teve Sandbox e
ficou 90 dias sem atividade
([organização só com Sandbox](#organização-só-com-sandbox)).

A exportação fica disponível por 30 dias. Depois, cadastro, membros,
convites, certificados, chaves, integrações e a própria organização são
excluídos em até 7 dias; documentos fiscais, operações e registros de cobrança
continuam guardados até 31/12 do quinto ano seguinte ao encerramento, salvo
retenção legal, e então saem. Uma organização que nunca teve dados de
Produção perde os dados fiscais logo depois do expurgo
([organização sem Produção](RETENTION.md#organização-sem-produção-decidido-em-27102026)). Classes, prazos, recuperação após restore e
prova estão em [Retenção](RETENTION.md#encerramento-implementado-d01). Não há
reabertura pelo console.

## Aviso de arquivamento

Uma organização aberta inativa no Gratuito, ou com o período pago terminado
sem renovação, recebe um aviso de 30 dias antes de poder ir para a custódia
fria ([ADR 0009](../adr/0009-custodia-fria-de-organizacoes-abertas.md)). O
aviso só é criado pela Freecorps, pelo executor do
[arquivo econômico](../operacao/arquivo-economico.md#aviso-de-organização-aberta),
que manda um e-mail único aos owners e admins ativos. Passados os 30 dias, o
operador pode congelá-la e arquivá-la; ela volta pela reidratação com IDs
novos. Tudo isso fica atrás de `FNFE_COLD_ARCHIVE`, desligado no hospedado.

- **Console.** `archiveNotice.status`, lida por qualquer membro ativo, devolve
  o aviso pendente ou o run em custódia (`runId`, `state`, `reason`,
  `eligibleAt` e `archivedAt`, só em `archived`) e `canAct` para owners e
  admins; sem aviso nem custódia, `null`. O console mostra o aviso em todas
  as páginas da organização, com a data a partir da qual ela pode ser
  arquivada, em Brasília, o que o arquivamento faz e a perda possível na
  captura de NF-e.
- **Manter ativa.** No Gratuito, owner ou admin escolhe "Manter ativa" no
  aviso (`archiveNotice.keepActive`, com o `runId` do aviso visto). O aviso
  termina, a organização registra atividade e `organization.kept-active`, e
  os 90 dias recomeçam. Outros papéis recebem `ACCESS_DENIED`; outro
  `runId` ou nenhum aviso, `ARCHIVE_NOTICE_NOT_FOUND`; o aviso de plano pago,
  `PLAN_RENEWAL_REQUIRED`; o arquivamento em curso, `ORGANIZATION_ARCHIVING`.
  Repetir depois de encerrado não faz nada.
- **Plano pago.** O aviso aponta Uso e limites, na seção Cobrança. Renovar,
  ou ativar qualquer plano, encerra o aviso na mesma transação.

## Organização arquivada

Do congelamento ao fim da reidratação (run em `frozen`, `sealed`,
`verified`, `deleting`, `archived` ou `restoring`), a organização continua
aberta, mas os dados fiscais e as admissões ficam fora de alcance
([ADR 0009, §§2-3](../adr/0009-custodia-fria-de-organizacoes-abertas.md#2-a-organização-continua-aberta)).
As regras valem para todos os estados, da organização encerrada e da aberta.

Continua permitido, em qualquer desses estados, pelo console:

- revogar chave de API (`keys.revoke`), certificado (`certificates.revoke`)
  e desligar conexão Stripe (`stripe.updateConnection` com `active: false`,
  sem mudar nome nem configuração); a revogação de uma credencial vazada
  nunca é bloqueada pelo arquivo;
- revogar o acesso de um projeto a uma empresa (`projects.revokeCompany`),
  retirar a liberação da captura (`captureRelease.disable`), desligar um
  endpoint de webhook (`webhooks.update` com `active: false` e os outros
  campos iguais) e rotacionar seu segredo (`webhooks.rotate`);
- remover membro e cancelar convite;
- pedir o encerramento (owner). O pedido é aceito; o expurgo espera, e confere
  de novo a cada hora, enquanto o run estiver em `deleting` ou `restoring`;
- ler o que não é fiscal: membros, convites, atividade da organização,
  empresas, membros e atividade da empresa, projetos, chaves, certificados,
  conexões Stripe, liberação da captura, endpoints de webhook, termos de uso,
  plano, cobrança, uso e o estado do arquivo (`archiveNotice.status`);
- contratar, renovar ou mudar de plano só em `archived`: do congelamento à
  remoção e durante a reidratação, a troca recebe `ORGANIZATION_ARCHIVING`
  (`allocateOffer`, `usage:assignPlan` e o início do Checkout e da mudança de
  renovação). Um plano novo numa organização arquivada não retoma a captura.

Toda outra escrita e toda leitura fiscal (Início, documentos, importações,
emissões, operações, exportações, entregas de webhook, diagnóstico) recebem
`ORGANIZATION_ARCHIVED`. "Manter ativa" segue como no aviso:
`ORGANIZATION_ARCHIVED` depois de arquivada e `ORGANIZATION_ARCHIVING`
durante o arquivamento. A reativação e a exportação assistida ainda são
pedidas ao suporte; o console não tem esses botões.

**Reativação.** O operador reidrata a organização aberta arquivada com o
histórico inteiro e IDs novos
([arquivo econômico](../operacao/arquivo-economico.md#reidratação-com-ids-novos)).
Plano pago precisa estar ativo, e o estoque, caber no plano atual. Cada
registro fiscal guarda o primeiro ID e a primeira criação (`originId`,
`originCreationTime`), e o mapa de IDs liga o ID anterior ao novo. As rotas
REST aceitam o ID anterior, de qualquer ciclo, e respondem o recurso atual,
com o `id` novo e o primeiro ID em `originalId`
([SDK](../v1.0/SDK.md#ids-depois-da-reativação)). Um ID anterior de outra
organização nunca resolve e recebe `NOT_FOUND`. A reidratação não entrega de
novo eventos de webhook nem conta consumo mensal; o estoque volta a contar.

O console mostra, em todas as páginas da organização, o estado do arquivo:
"Arquivamento da organização em curso", "Organização arquivada desde" a data
em Brasília (a prova do pacote, `verifiedAt`) ou "Reativação da organização em
curso", com o motivo, o que continua disponível e o caminho de volta, sem
sugerir retomada imediata. Uma página de dados fiscais mostra no lugar do
conteúdo que eles ficam indisponíveis até a reativação.

## Organização só com Sandbox

Uma organização aberta que nunca teve dados de Produção, pelo critério de
`sandboxOnly` do encerramento, em que uma nota recebida, inclusive a recusada
na importação, conta como Produção quando o próprio XML não declara
homologação (#108), não vai para o arquivo: a Freecorps a encerra
(ADR 0009, decisão 2 de 29/10/2026). Depois de 90 dias sem atividade, com a
mesma atividade do aviso de arquivamento do Gratuito e em qualquer plano ou
sem plano, a Freecorps cria um aviso de 30 dias em `sandboxClosureNotices`,
pelo [operador](../operacao/arquivo-economico.md#encerramento-de-organização-só-com-sandbox),
com um e-mail único aos owners e admins ativos, pelo mesmo canal e regras do
aviso de arquivamento. Uma organização com plano pago em vigor, pedido de
plano aguardando pagamento ou assinatura de cartão renovando não recebe aviso.

- **Console.** `sandboxClosure.status`, lida por qualquer membro ativo,
  devolve o aviso pendente (`noticeId`, `closeAt`) e `canAct` para owners e
  admins; sem aviso, `null`. O console mostra, em todas as páginas da
  organização, a data a partir da qual ela será encerrada, em Brasília, que
  ela não tem documento com validade fiscal, que os dados são apagados depois
  do encerramento e que a conta de cada pessoa continua.
- **Manter ativa.** Owner ou admin escolhe "Manter ativa" no aviso
  (`sandboxClosure.keepActive`, com o `noticeId` visto). O aviso termina
  (`kept_active`), a organização registra atividade e
  `organization.kept-active`, e os 90 dias recomeçam. Outros papéis recebem
  `ACCESS_DENIED`; outro `noticeId`, `SANDBOX_CLOSURE_NOTICE_NOT_FOUND`.
  Repetir depois de encerrado não faz nada.
- **Encerramento.** Passado `closeAt`, o operador chama
  `sandboxClosure:close`, que confere de novo, na mesma transação, que a
  organização só tem Sandbox, não tem plano pago em vigor nem encerramento e
  não teve atividade desde o aviso. Se algo mudou, o aviso termina
  `cancelled` e nada é encerrado. Senão, abre o mesmo encerramento do owner
  (`requestedBy` `freecorps:sandbox-inactive`, `organization.closure-requested`
  com o ator `operator:freecorps`), com os 30 dias de exportação e o
  [expurgo antecipado do Sandbox](RETENTION.md#organização-sem-produção-decidido-em-27102026).
  O aviso sai com o expurgo do encerramento.

## Termos de uso

A organização contrata pelos termos de uso, com a cláusula de operadora,
aceitos por um owner no console (#586). Os textos e as versões estão em
[Termos](../termos/README.md#termos-de-uso). A versão em vigor é
`termos-de-uso-2026-11-05` (1.3), que entrou no console em 05/11/2026 (#169) e
substituiu a 1.2, de 04/11/2026 (ADR 0012), a 1.1, de 02/11/2026 (#142), e a
1.0, de 01/11/2026 (#428): as organizações criadas desde então a aceitam na
criação, e as que já existiam têm até 05/12/2026, meia-noite de Brasília,
para aceitar.

- **Criação.** `termsOfUse.current` devolve a versão em vigor ao formulário
  de criação. `organizations.create` recebe a versão que a pessoa leu
  (`termsOfUse`) e grava o aceite na mesma transação; sem ela, ou com outra,
  responde `TERMS_OF_USE_OUTDATED` e não cria nada.
- **Versão nova.** Uma versão entra no console em `since` e passa a valer 30
  dias depois, à meia-noite de Brasília. O contexto da organização
  (`organizations.context`) devolve a versão pendente e a data, e o console
  mostra o aviso a todos os membros. Só o owner lê e aceita no aviso
  (`termsOfUse.accept`); os outros papéis leem o texto e são avisados de quem
  aceita. Aceitar de novo a versão que vale não grava outra linha.
- **Corte.** Passada a data sem aceite, a organização não cria comandos novos:
  `operations.reserve` e a admissão de importação respondem
  `TERMS_OF_USE_REQUIRED`, pelo console, pela API REST (403 `SCOPE_DENIED`),
  pelo SDK e pela conexão Stripe. Continuam a leitura, a exportação, os
  pedidos de titulares, o cancelamento de nota já emitida, a confirmação de
  um upload admitido, a resposta a um pedido repetido e o trabalho já aceito
  (retentativas e continuações, como a captura agendada). O aceite reabre na
  hora.
- **Registro.** `termsOfUse.status` mostra a versão em vigor, o aceite que
  vale e o pendente. O nome de quem aceitou vai só a owners e admins, como a
  lista de membros. Cada aceite grava `organization.terms-accepted` na
  atividade e uma linha em `termsOfUseAcceptances`
  ([guarda](RETENTION.md#aceite-dos-termos-de-uso)).

- **Aviso por e-mail (#594).** A seção 11 promete avisar cada versão nova por
  e-mail aos proprietários e administradores, com 30 dias de antecedência.
  Cada publicação de um perfil com organizações chama a mutation interna
  `termsOfUseNotice.start` depois que a revisão serve: o sandbox hospedado
  (`scripts/deploy/deploy-platform.mjs`, release, revisão sem mudança e bootstrap),
  a produção fiscal da emissão (`scripts/deploy/deploy-issuance-production.mjs`), a
  validação (`scripts/validation/deploy-validation.mjs`) e a instalação própria local
  (`scripts/selfhost.mjs up`). No worktree e na instalação hospedada
  independente, que usa o mesmo perfil `APP_ENV=installation` do sandbox
  hospedado e da produção fiscal, mas que nenhum script publica, o operador
  chama a mesma mutation pela CLI do Convex
  ([instalação própria](../operacao/instalacao-propria.md#convex-cloud-e-servidor-próprio-hospedado)).
  `start` não faz nada sem versão em vigor, com o
  e-mail de contas desligado ou com a varredura da versão já concluída. Senão,
  ela cria a varredura da versão (`termsOfUseNoticeRuns`) ou a retoma do
  cursor, com uma nova geração que encerra a cadeia anterior. A falha dessa
  chamada não reprova a publicação, que já serve: o recibo registra
  `termsOfUseNotice.state: "failed"` (no self-host local, só o log; na
  instalação independente, a saída da CLI), e a próxima
  publicação, ou a mesma chamada pelo operador, retoma. Cada lote (`batch`)
  lê 100 organizações e agenda um `notify` por organização. `notify` confere
  que a versão ainda é a vigente, que a organização existe, não tem
  encerramento e não aceitou a versão, e grava a linha da organização e
  versão em `termsOfUseNotices` (índice `by_organizationId_and_version`)
  antes de agendar o envio: a linha já existente, de uma retentativa, de
  outra cadeia ou de outra publicação, não envia de novo. O envio (`deliver`)
  reserva a linha (`pending` → `sending`), lê os `owner` e `admin` ativos
  pelo índice do papel (`by_organizationId_and_state_and_role`, em páginas,
  sem ler os outros membros) e manda **uma mensagem por destinatário**, em
  texto, com o nome da organização, a versão, a data de vigência e o link
  `/termos/uso/<versão>`; nenhuma mensagem mostra outro endereço, e um bounce
  fica só com o seu. O canal é o do e-mail de contas, com as mesmas regras:
  fora do desenvolvimento, só os endereços de `ACCOUNT_EMAIL_RECIPIENTS`
  recebem (`withheld` conta os outros), e não há reenvio automático. A linha
  termina `sent` quando o provedor aceita todas as mensagens, `partial`
  quando aceita só parte, `unconfirmed` quando nenhuma (recusa, timeout ou
  resposta sem o destinatário), com `recipients` e `confirmed`; fora de
  `sent`, uma linha `terms_of_use_notice_delivery` vai ao log, sem endereço.
  Termina `skipped` sem destinatário possível, com a versão trocada ou com o
  e-mail de contas desligado entre o `notify` e o envio. O estado olha só os
  destinatários autorizados: com `withheld` acima de zero, a linha pode
  terminar `sent` (ou `partial` e `unconfirmed`, conforme o provedor) mesmo
  com proprietários ou administradores fora da allowlist, e `skipped` quando
  todos ficaram fora; `status` lista essas linhas
  ([destinatários barrados](#aviso-dos-termos-linhas-presas)). No perfil de
  desenvolvimento (`APP_ENV=development`), o dos worktrees e da instalação
  própria local de `scripts/selfhost.mjs`, não há allowlist e o coletor
  guarda as mensagens (`mail:inbox`, tipo `terms-of-use`). A instalação
  hospedada independente (`APP_ENV=installation`) segue a regra de fora do
  desenvolvimento: Cloudflare e allowlist, ou nada com `EMAIL_MODE=disabled`.

### Aviso dos termos: linhas presas

Duas situações deixam uma linha sem desfecho. `pending` antigo: o `deliver`
falhou antes de reservar a linha, ou a reserva lançou; nada saiu. `sending`
antigo: a reserva aconteceu e o `finish` não rodou; as mensagens podem ter
saído. Para conferir, rode no deployment do perfil, pela CLI do Convex com o
alvo conferido ([deploy](../operacao/deploy-producao.md)):

```sh
bunx convex run termsOfUseNotice:status '{"before":<epoch em ms de uma hora atrás>}' --deployment <deployment>
```

A resposta traz a varredura (`sweep`), as linhas por estado (`counts`, até
1000 cada; `capped` acima disso) e até 100 linhas `pending` e `sending`
criadas antes de `before` (`stuck`), com `createdAt` e, nas `sending`,
`claimedAt`. Traz também as linhas com destinatários barrados pela allowlist
(`withheld`): quantas são (`count`, até 1000; `capped` acima disso) e até 100
delas (`rows`), em qualquer estado, com `organizationId`, `state`,
`recipients` e `withheld`, das que barraram mais destinatários para as que
barraram menos; além das 100, não há página seguinte. `version` aceita
outra versão; sem ela, vale a vigente.

- **`pending`:** `bunx convex run termsOfUseNotice:resumePending '{}'
  --deployment <deployment>` agenda de novo o envio das linhas `pending` da versão vigente criadas há mais de 60
  minutos (`olderThanMinutes` muda o prazo), até 100 por chamada; repita
  enquanto `resumed` não for zero. Repetir é seguro: só uma reserva da linha
  vence, então um envio original atrasado e o retomado não mandam duas vezes.
- **`sending`:** não há reenvio automático nem comando de reenvio, porque o
  efeito é incerto. O operador confere nos registros do Email Sending da
  conta Cloudflare se saíram mensagens com o assunto do aviso perto de
  `claimedAt`, para os proprietários e administradores ativos da organização
  (`organizationId`); o endereço não fica na linha nem no log. Se saíram, a
  linha fica como está. Se não saíram, ou se não
  dá para saber, o aviso do console continua valendo; o operador decide
  avisar os proprietários pelo suporte, fora da plataforma, e registra a
  decisão na issue da versão. A linha não muda de estado por isso.
- **`partial` e `unconfirmed`:** mesma regra de `sending`, sem reenvio; o log
  `terms_of_use_notice_delivery` diz quantos o provedor confirmou.
- **Destinatários barrados (`withheld`):** os proprietários e administradores
  fora de `ACCOUNT_EMAIL_RECIPIENTS` não recebem o e-mail dessa versão, nem
  depois. A linha é final: nenhuma retentativa, publicação ou
  `resumePending` a envia de novo, e ampliar a allowlist depois não
  reenvia. O aviso do console não depende do e-mail: enquanto a organização
  não aceitar a versão, ele aparece a todos os membros que entram no console,
  e só um owner aceita. A lista em `withheld.rows` diz ao operador quais
  organizações não receberam o e-mail, ou o receberam só em parte; ele decide
  avisá-las por outro meio, pelo suporte, fora da plataforma, e registra a
  decisão na issue da versão. Na validação a
  política de contas (`platform/account-policy.mjs`) exige a allowlist, com 1
  a 10 endereços. Na instalação, `ACCOUNT_EMAIL_RECIPIENTS=*` a tira (#428), e
  ninguém fica em `withheld`
  ([e-mail de contas](ACCOUNT-EMAIL.md#caminho-da-requisição-e-limites)).

## Escopo e evidência

O código usa o Web Crypto do [runtime Convex](https://docs.convex.dev/functions/runtimes)
e preserva o contrato do [envio REST da Cloudflare](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/).
As provas locais, matriz negativa e recibos estão em evidence/66.
Esta entrega não conclui empresas/projetos (gestão de empresas), chaves (gestão de projetos e chaves), todo o marco
M1 nem valida envio externo real de convites. O PR teve base na antiga
`feat/fiscal-platform-v1`; a plataforma hoje é integrada em `main`.
