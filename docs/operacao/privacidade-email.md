# E-mail de privacidade

> **Aposentado.** Esta caixa passou para o Ember Mail, com o envio da
> plataforma: veja [E-mail pelo Ember Mail](email.md). O Worker
> `freecorpsnfe-privacy-mail`, as tabelas `privacy*` e a página do console
> saíram do código. O texto abaixo é o registro do que foi feito.

Endereço escolhido pelo mantenedor em 21/10/2026:
`privacidade@nfe.freecorps.com.br`. A caixa é lida e respondida em
`/console/privacidade`. O procedimento de atendimento e os campos do registro
ficam em [RIGHTS](../plataforma/RIGHTS.md).

O fluxo segue o de outro projeto da Freecorps: receber no
Worker, persistir antes de aceitar, entregar ao Convex e atender no console.
Este roteiro trata da caixa de privacidade, com o prazo de D02. O mesmo
Worker atende também as caixas de [segurança](seguranca-email.md), de
[suporte](suporte-email.md) e de [operação](operacao-email.md), com
operadores e conversas separados. Não se
copiam contas, credenciais nem dados daquele projeto.

## Alvos e configuração

- Backend da oferta hospedada: `prod:elated-possum-295`, perfil sandbox.
- Worker de e-mail: `freecorpsnfe-privacy-mail`, configuração separada em
  `deploy/privacy-mail/wrangler.jsonc`. Não serve site nem API REST.
- R2 privado: `freecorpsnfe-privacy-mail`, binding `INBOUND_MAIL`.
- Só o subdomínio `nfe.freecorps.com.br` recebe novos registros de e-mail.
  Não alterar MX, SPF ou rotas do domínio principal.
- O cron de cinco minutos pertence ao Worker de e-mail. Não altera
  `FNFE_CRONS=off`, o transporte fiscal ou os crons do Convex.

Variáveis no deployment Convex:

| Variável                        | Valor ou finalidade                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `FNFE_PRIVACY_OPERATOR_EMAILS`  | E-mails das contas verificadas dos responsáveis, separados por vírgula. Vazia não autoriza ninguém.  |
| `INBOUND_EMAIL_SECRET`          | Segredo compartilhado com o Worker para assinar entregas e manutenção.                               |
| `FNFE_PRIVACY_SEND_MODE`        | `cloudflare` para envio real; ausente desliga respostas. `local` só simula em `APP_ENV=development`. |
| `FNFE_PRIVACY_EMAIL_ACCOUNT_ID` | Conta Cloudflare que habilitou o domínio de envio.                                                   |
| `FNFE_PRIVACY_EMAIL_API_TOKEN`  | Token restrito ao envio de e-mail nessa conta, mantido no cofre.                                     |

O Worker recebe `INBOUND_EMAIL_SECRET` por secret. O endereço do backend
está em `BACKEND_SITE_URL`. Nenhum token vai em `VITE_*`, Git ou recibos.

O mantenedor autorizou o próprio e-mail corporativo em 21/10/2026.
Esse é o único valor aprovado para `FNFE_PRIVACY_OPERATOR_EMAILS` nesta
entrega. O acesso exige uma conta Better Auth com esse e-mail verificado.
O substituto ainda precisa informar o e-mail da própria conta; o nome de
usuário do GitHub não concede acesso.

## Ativação

Preparar e revisar a mudança antes de publicar; seguir os gates de
[produção](deploy-producao.md). A presença dos arquivos não comprova
ativação nem recebimento.

1. Publicar o backend e console aprovados. Configurar os operadores e os
   secrets. Conferir que uma conta cliente não vê a caixa nem consegue
   chamar suas queries, mutations ou downloads.
2. Criar o bucket R2 privado e configurar o secret do Worker. Publicar com
   `bun run deploy:mail`, que passa `deploy/privacy-mail/wrangler.jsonc` ao
   Wrangler; `bun run deploy:mail --dry-run` só empacota.
3. Habilitar Email Sending para `nfe.freecorps.com.br` e conferir os
   registros de autenticação criados para esse subdomínio.
4. Na zona `freecorps.com.br`, adicionar apenas `nfe` em
   Email Routing → Settings → Subdomains. Conferir os registros exigidos
   antes de aplicar. Não ativar recebimento no domínio principal.
5. Criar a regra literal de `privacidade@nfe.freecorps.com.br` com
   ação **Send to a Worker**, destino `freecorpsnfe-privacy-mail`.
   Habilitar e conferir o subendereçamento, para que
   `privacidade+t_<token>@nfe.freecorps.com.br` siga a mesma regra.
   Não habilitar catch-all. O Worker recusa qualquer endereço fora das caixas
   de privacidade, de segurança, de suporte e de operação.
6. Ligar `FNFE_PRIVACY_SEND_MODE=cloudflare` só depois de conferir o
   domínio e o token de envio.
7. Executar o ensaio abaixo e registrar somente recibo sanitizado. Publicar
   o canal na política depois do aceite de D06.
8. Na primeira publicação com a coleta de originais sem dono (#341), esperar
   uma manutenção do Worker e liberar a retenção inicial. Em Git Bash, com a
   chave de deploy só na sessão, como nos demais roteiros:

   ```sh
   cd platform
   export CONVEX_DEPLOY_KEY='prod:elated-possum-295|…'   # colar, sem gravar em arquivo
   bunx convex data privacyMaintenance
   bunx convex run privacyMail:releaseHeldOriginals '{"heldFrom": 0}'
   ```

   A primeira leitura deve mostrar `heldFrom: 0`; repetir a leitura depois
   e conferir que `heldFrom` sumiu e `lastRunAt` avança a cada cinco
   minutos. Enquanto a coleta está retida, o Worker registra
   `privacy-mail: coleta de originais retida; conferir privacyMaintenance`
   nos Workers Logs.

Referências do provedor:
[Subdomínios](https://developers.cloudflare.com/email-service/configuration/subdomains/),
[handler de recebimento](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
e [cabeçalhos de resposta](https://developers.cloudflare.com/email-service/reference/headers/).

## Validação local em 21/10/2026

No worktree baseado em `899b93e`, com as alterações desta entrega:

- Suíte sem cache: 183 arquivos, 2.379 testes aprovados e um teste ignorado.
  Os 17 testes da caixa cobrem autorização, revogação, deduplicação,
  assinatura, originais, respostas, falhas e expurgo.
- `vp check`, `platform:check`, build, contratos, licenças e fronteiras
  aprovados. O lint conserva um aviso anterior em
  `docs/v1.0/evidence/67/verify-artifacts.mjs`.
- Empacotamento do Worker conferido com `wrangler deploy --dry-run`.
- No navegador, conta fictícia verificada: recebimento HTTP assinado,
  entrega repetida sem duplicação, download do original com anexo,
  nota interna, resposta simulada, encerramento, reabertura e acesso
  negado depois da revogação. Layout conferido em desktop e celular.

Essas provas não enviaram e-mail externo, não publicaram o Worker e não
alteraram DNS nem o deployment hospedado. O ensaio abaixo continua pendente.

## Ativação hospedada em 21/10/2026

A [PR #331](https://github.com/freecorps/freecorpsNFE-arquivo/pull/331) foi integrada
em `d7e24a05b280650778205b7a03b848cfc3995113`. A
[publicação](https://github.com/freecorps/freecorpsNFE-arquivo/actions/runs/39621304666)
passou no Blacksmith. Console, API e backend responderam com essa revisão.

Foram configurados o bucket privado, o Worker, os secrets, Email Sending e
Email Routing apenas para `nfe.freecorps.com.br`. MX e TXT do domínio
principal foram comparados antes e depois e permaneceram iguais. A regra
literal e o subendereçamento estão habilitados; catch-all permanece desligado.
`FNFE_CRONS=off` e `FISCAL_ENV=disabled` foram conferidos no backend hospedado.

O ensaio sintético confirmou recebimento no Worker e preservação no R2,
mas expôs uma incompatibilidade: o runtime recusa `redirect: "error"` antes
de executar o fetch. A versão `61cc1954-402e-4ade-93fb-d581f2d75cc5` do Worker
usa `manual`; respostas 3xx continuam sendo falhas, sem encaminhar conteúdo
ou assinatura a outro destino. Uma entrega repetida manualmente com a chave
original foi aceita pelo Convex e preservou o anexo sintético.

Às 15:20:57 UTC, o cron da versão corrigida terminou com sucesso. A releitura
do banco confirmou duas mensagens recebidas, com seus originais, na mesma
conversa: a mensagem base com `ensaio.txt` e o retorno enviado ao endereço
com token. A repetição da primeira entrega não criou outra mensagem. A fila
R2 ficou vazia. Isso comprova o percurso SMTP, Worker, recuperação, Convex e
agrupamento; o envio foi feito pela API do provedor para a própria caixa de
teste, sem autenticar uma pessoa no console.
O recibo sanitizado
registra a revisão, a versão do Worker, a releitura e os limites da prova.

`bun run platform:privacy-worker` verifica entrega, manutenção e recusa de
redirecionamentos no workerd local, sem rede externa. A prova usa a data de
compatibilidade `2026-10-13`, máxima do binário instalado; o Worker hospedado
mantém `2026-10-21`. O recibo local fica em
`.browser-results/privacy-worker/report.json`.
Ela também roda sem cache no grafo `validate`, como `ci:privacy-worker`, e
seu recibo acompanha o artefato de validação do GitHub Actions.

A allowlist contém somente o e-mail autorizado acima.

## Conferência de 21/10/2026, 16:40 UTC

- A conta Better Auth do e-mail autorizado foi criada às 16:17 UTC e está
  verificada.
- O responsável enviou, de uma caixa externa, uma mensagem que chegou ao
  console às 16:31 UTC e recebeu notas internas. A mensagem foi para
  `seguranca@`, não para `privacidade@`: ela comprova o login e a leitura, mas
  não o ensaio desta caixa.
- Analytics do Worker `freecorpsnfe-privacy-mail` desde 14:00 UTC: as duas
  exceções vieram da versão `b9ce526f`, a do `redirect: "error"` descrito
  acima. As versões `61cc1954` e `8ed3fea4`, a atual, só têm execuções bem-sucedidas.

## Ensaio pelo console em 21/10/2026, 16:47 UTC

O responsável fez o ensaio em `/console/privacidade` e o deu por concluído.
A releitura do banco confirmou:

- recebimento de uma mensagem externa na caixa `privacy`, com original;
- nota interna e resposta pelo console, aceita pelo provedor
  (`state: accepted`), com `reply_to` no endereço com token. A conversa
  passou a `waiting`;
- uma segunda mensagem do mesmo remetente às 16:48, enviada ao endereço base
  e com outro assunto. Ela abriu outra conversa, como esperado, porque não
  passou pelo endereço com token.

O retorno pelo token na mesma conversa, o anexo e a deduplicação já estavam
comprovados na ativação. O encerramento e a reabertura ficaram aceitos pela
declaração do responsável: a releitura daquele dia não conferiu as notas
"Situação alterada para…" que `privacyMail.setStatus` grava com o `actorId`
de quem agiu.

Em 21/10/2026, o mantenedor indicou o e-mail corporativo do segundo sócio como substituto
em D02. O e-mail foi incluído em `FNFE_PRIVACY_OPERATOR_EMAILS`, a pedido do
mantenedor, que deu a indicação por concluída. Isso não prova o acesso: a
conta ainda não existe, e o substituto só entra na caixa depois de se
cadastrar e verificar o e-mail. Em 28/10/2026, o mantenedor adiou essa
prova para depois da 1.0; o primeiro acesso dele deve ser registrado aqui
quando acontecer.

## Ensaio de recebimento e resposta

Usar mensagem sintética de uma caixa externa controlada, sem dados fiscais.

Anote o horário UTC de cada etapa enquanto a faz, inclusive o envio, a
chegada, a resposta, o retorno, o encerramento e a reabertura. O recibo
registra esses horários. O encerramento e a reabertura deixam uma nota
"Situação alterada para…" com o `actorId` de quem agiu; o envio e a chegada
na caixa externa só ficam nas anotações.

1. Enviar ao endereço base, incluindo um anexo sintético.
2. Entrar com cada responsável e confirmar remetente, assunto, texto e
   download do original com o anexo. O conteúdo não fica visível a clientes.
3. Registrar nota de verificação de identidade, escopo, prazos, decisão e
   execução. A nota deve permanecer somente no console.
4. Responder. Conferir a mensagem na caixa externa e responder de volta pelo
   Reply-To. O retorno deve abrir a mesma conversa e marcá-la como não lida.
5. Repetir uma entrega assinada com a mesma chave e bytes. Ela não cria
   outra conversa ou mensagem.
6. Encerrar e reabrir o pedido; conferir o estado persistido. Guardar data,
   horários, revisão, ambientes e resultados, sem conteúdo nem endereços
   pessoais.
7. Registrar o aceite dos responsáveis e atualizar a lacuna de D02 na matriz.
   Testes locais e envio simulado não substituem esta etapa.

## Primeiro atendimento pelo substituto

Pendência da [#692](https://github.com/freecorps/freecorpsNFE-arquivo/issues/692).
O ensaio do responsável, de 21/10, não prova que o substituto atende sozinho.
Esta prova usa a caixa, o Worker e a allowlist já ativados. Não se cria outra
caixa nem se repete o ensaio do responsável. O mantenedor só envia a mensagem
sintética e confere o resultado depois. Durante o atendimento, não entra no
console nem ajuda o substituto.

### Antes do ensaio

1. O substituto cria a conta em `https://nfe.freecorps.com.br/signup` com
   o e-mail corporativo que está em `FNFE_PRIVACY_OPERATOR_EMAILS` e
   confirma o link de verificação. Outro e-mail, inclusive um alias, não
   abre a caixa.
2. Ele entra e abre `/console/privacidade`. Se aparecer "Acesso restrito",
   o e-mail da conta não coincide com a allowlist ou ainda não foi
   verificado. Corrija isso antes de marcar o horário.
3. O mantenedor confere a conta sem copiar a saída para arquivo. A linha
   precisa mostrar `emailVerified: true`; anote o `_id`, que é o
   `actorId` esperado nas etapas seguintes:

   ```sh
   cd platform
   export CONVEX_DEPLOY_KEY='prod:elated-possum-295|…'   # colar, sem gravar em arquivo
   bunx convex data user --component betterAuth --format jsonl | grep -i '<e-mail do substituto>'
   ```

### Durante o ensaio

Cada pessoa anota o horário UTC de cada etapa enquanto a faz. O envio e a
chegada na caixa externa só ficam nessas anotações.

| Etapa | Quem       | O que fazer                                                                                                                                                                      |
| ----- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Mantenedor | De uma caixa externa controlada, enviar a `privacidade@nfe.freecorps.com.br` um pedido sintético, sem dados fiscais nem pessoais reais, com um anexo `.txt` sintético.           |
| 2     | Substituto | Em "Abertos", localizar a conversa. Conferir remetente, assunto e texto. Baixar o original, extrair o anexo e informar ao mantenedor o SHA-256 dele, sem enviar o arquivo.       |
| 3     | Substituto | Registrar uma nota interna como no procedimento de D02: identidade, escopo, prazos e decisão. É um pedido fictício, então a decisão pode ser "ensaio, sem atendimento real".     |
| 4     | Substituto | Responder por e-mail. A resposta deve aparecer como "Aceita pelo provedor" e a conversa passa a "Aguardando resposta".                                                           |
| 5     | Mantenedor | Na caixa externa, conferir que a resposta chegou e responder pelo Reply-To.                                                                                                      |
| 6     | Substituto | Conferir que o retorno entrou na mesma conversa, como não lida. Encerrar o pedido, conferir em "Encerrados", reabrir e conferir em "Abertos".                                    |
| 7     | Substituto | Abrir `/console/seguranca`, `/console/suporte` e `/console/operacao`. Cada uma deve mostrar "Acesso restrito", salvo se o e-mail dele estiver também na allowlist daquela caixa. |

O ensaio não repete a entrega assinada com a mesma chave. A deduplicação
não depende de quem atende e já foi comprovada na ativação.

### Depois do ensaio

O mantenedor confere, na mesma sessão:

- `bunx convex data privacyThreads --limit 5`: a conversa do ensaio tem
  `mailbox: "privacy"` e `status: "open"` depois da reabertura;
- `bunx convex data privacyMessages --limit 10`: na mesma conversa, duas
  mensagens `received`, uma `reply` com `state: "accepted"` e três `note`:
  a de verificação e as de "Situação alterada para encerrado." e
  "Situação alterada para aberto.". A resposta e as notas têm o `actorId`
  do substituto, anotado antes do ensaio. Nenhuma tem o `actorId` do
  mantenedor;
- o SHA-256 do anexo que o substituto informou na etapa 2 coincide com o
  do arquivo enviado na etapa 1.

O download não deixa registro no banco: o ticket de `privacyDownloads` é de
uso único, apagado ao servir o arquivo e expira em dois minutos. Por isso a
prova do download é o hash, sem copiar o conteúdo.

O recibo sanitizado fica em
`docs/v1.0/evidence/privacy-mail-hosted/substitute.json`, no mesmo formato
de `activation.json`: data, revisão em `build.json`, versão do Worker,
horários UTC de cada etapa, contagens da conversa, `actorIdMatchesSubstitute`,
`attachmentHashMatches`, resultado das outras caixas e limitações. Não grave nele e-mails, nomes,
ids de usuário, assunto, texto, nem o conteúdo do original ou do anexo.

O mantenedor, como responsável por privacidade, aceita a prova depois de
ler o recibo. Na mesma PR, registrar aqui o primeiro atendimento e
atualizar D02 em [PRIVACY-DRAFT](../v1.0/PRIVACY-DRAFT.md),
[ACCEPTANCE](../v1.0/ACCEPTANCE.md) e a lacuna de
[CNPJ-LEGITIMATE-INTEREST](../licenses/CNPJ-LEGITIMATE-INTEREST.md).

## Falha, recuperação e retenção

O original só é aceito depois de persistido no prefixo `pending/` do R2.
O Worker entrega com HMAC sobre horário, chave, envelope e hash dos bytes.
O backend recusa assinaturas alteradas ou fora de cinco minutos, deduplica
pela chave e guarda o original antes de confirmar. As tentativas de parse
pendentes são recuperadas pela manutenção.

Entregas concorrentes com a mesma chave e conteúdo diferente recebem 409;
a cópia que perdeu a disputa é removida do storage. O original é gravado no
storage antes do registro do intake. Se esse registro falha ou a resposta se
perde, o backend responde 503 e, numa só transação, lê o intake pela chave:
se ele existe com esta cópia, a mutation foi confirmada e o original fica;
sem intake, ou com outra cópia registrada por uma entrega concorrente, a
cópia recém-gravada é apagada. O registro recusa uma cópia que já não existe,
então uma confirmação atrasada não deixa intake sem original. A reentrega do
Worker segue o desempate de sempre: 204 para os mesmos bytes e envelope, 409
para outros. O expurgo tolera originais e intakes já ausentes e continua com
os pedidos seguintes.

Se até essa transação falha, a cópia fica sem dono até a coleta. Cada
manutenção agenda a coleta em transação própria, para que uma falha nela não
desfaça o expurgo. A coleta percorre uma página de 100 arquivos de
`_storage` em ordem de criação, com cursor em `privacyMaintenance`, e apaga
os originais criados há mais de uma hora (`ORPHAN_GRACE`) e sem referência
em `privacyIntakes`, `privacyMessages` nem `referenceVersions`. Uma hora
supera a janela de assinatura de cinco minutos somada à duração máxima de
uma action. Contam como originais o tipo privado
`application/vnd.freecorps.privacy-mail+rfc822`, que nenhum outro fluxo pode
usar, e o `message/rfc822` das versões anteriores, só quando criado antes da
linha de controle (`legacyUntil`). Outros tipos não são tocados. Um original
referenciado nunca é apagado pela coleta; ele só sai pelo expurgo de cinco
anos. A primeira passada começa do início do storage e alcança os órfãos
antigos, a cerca de 28.800 arquivos por dia: um storage de 1 milhão de
arquivos leva perto de cinco semanas, sem efeito sobre o atendimento.

A coleta falha fechada. A linha de controle nasce retida (`heldFrom: 0`), e
nada é apagado até a liberação (passo 8 da ativação). O Worker chama a
manutenção a cada cinco minutos, depois de esvaziar a fila; se passam mais de
30 minutos sem coleta (`MAINTENANCE_GAP`), por pausa, fila longa ou restore,
ela grava `heldFrom` com a última execução (`lastRunAt`) e não apaga nada
criado a partir desse instante, inclusive. Um restore não depende desse
sinal: o roteiro de [restauração](restauracao.md#retenção-e-encerramentos-após-o-restore)
retém explicitamente com `holdOriginals` antes de religar o Worker.
Retenções se fundem na mais antiga, e liberar libera todas as fundidas:
conferir todo o intervalo desde `heldFrom` antes de liberar.

Enquanto está retida, a resposta de manutenção traz `x-fnfe-mail-held: 1`,
sem outro conteúdo, e o Worker registra nos Workers Logs
`privacy-mail: coleta de originais retida; conferir privacyMaintenance`.
Para ler o estado (`heldFrom`, `lastRunAt`, `scannedUntil`, `legacyUntil`):

```sh
cd platform
export CONVEX_DEPLOY_KEY='prod:elated-possum-295|…'   # colar, sem gravar em arquivo
bunx convex data privacyMaintenance
```

Para liberar, depois de conferir os originais retidos (procedimento abaixo),
na mesma sessão:

```sh
bunx convex run privacyMail:releaseHeldOriginals '{"heldFrom": <valor lido>}'
```

O valor precisa ser o gravado em `privacyMaintenance`; outro é recusado.

Após dois minutos, a fila pode repetir a entrega. Depois de 24 horas, move
a mensagem para `failed/` e registra alerta sem conteúdo nos Workers Logs.
Os objetos de `failed/` exigem atendimento: conferir o backend e redeliver
com a **chave original** `pending/...`, os mesmos bytes e envelope, usando
assinatura nova. Apagar a cópia apenas após confirmação do backend. Não
aplicar expiração automática que apague mensagens ainda não entregues.

O console mostra somente texto, até 100 mil caracteres. HTML, texto restante
e anexos continuam no original baixável, sem execução no navegador. Não há
validação de DKIM ou identidade do remetente nesta caixa; conferir identidade
pelo procedimento D02. Referências e assunto não unem conversas por si só.

Uma resposta aceita pelo provedor fica registrada como aceita, sem afirmar
leitura ou entrega final. Timeout ou resposta inconclusiva deixa o envio
sem confirmação. Não reenviar antes de consultar o histórico do provedor.
O identificador da resposta impede duplicar o mesmo pedido do console.

Pedidos encerrados são expurgados cinco anos depois, com originais, anexos,
mensagens e notas, conforme D02. Pedidos reabertos deixam de estar vencidos.
A manutenção roda em lotes e também expurga tickets de download expirados.
As cópias externas seguem os 14 dias do backup.

Depois de um restore, manter envio desligado e não executar respostas
pendentes até reconciliar o histórico do provedor: a cópia restaurada pode
ser anterior a um envio já realizado. Reabilitar o Worker recupera o parse
e o expurgo; não é preciso ligar crons no Convex.

Com o Worker desligado, a coleta de órfãos também não roda. Um restore em
destino que já tinha storage pode deixar originais de mensagens recebidas
depois do snapshot sem intake, e o Worker já apagou a cópia do R2. A linha
de controle restaurada traz a última execução do snapshot. Por isso o
roteiro de restauração chama `holdOriginals` com o instante do snapshot
antes de religar o Worker. Antes de liberar, listar com
`bunx convex data _storage` os originais de e-mail criados desde `heldFrom` e
sem referência, baixar os que precisam ser atendidos e reentregá-los com
assinatura nova e chave `pending/...` nova. Só então liberar; os que ficarem
sem dono são apagados nas coletas seguintes.
