# Captura fiscal no site: ligar e desligar

A captura fiscal real de NF-e no site (`api.nfe.freecorps.com.br`, deployment
Convex `elated-possum-295`) depende de duas variáveis do deployment. Ela só
lê a distribuição de NF-e: não emite, não cancela e não manifesta. O contrato
está em [CAPTURE.md](../plataforma/CAPTURE.md#liberação-fiscal-no-site) e na
[ADR 0007](../adr/0007-captura-fiscal-no-site.md).

**Ligada em 22/10/2026** pelo mantenedor: `FNFE_CAPTURE_FISCAL=enabled` e
`FNFE_CAPTURE_TRANSPORT=sefaz`. Conferir a qualquer momento em
<https://api.nfe.freecorps.com.br/health>. `captureFiscal` diz:

- `enabled`: as duas variáveis ligadas e nenhuma parada geral;
- `halted`: as duas variáveis ligadas, mas a parada geral do GitHub está
  valendo;
- `disabled`: falta uma das variáveis.

Só o workflow **Fiscal capture** (`capture-fiscal.yml`), disparado por quem
está em `deploy/issuance-gate.json`, muda a situação de uma empresa ou a
parada geral. Ele não pede aprovação. Em **Actions → Fiscal capture → Run
workflow**, escolha a operação em `operation` e preencha só as entradas
dela; uma entrada que a operação não recebe recusa o run com
`INPUT_UNEXPECTED`, antes de qualquer chamada. O padrão é `list`, que não
muda nada.

| Operação             | Faz                                 | Entradas                                        |
| -------------------- | ----------------------------------- | ----------------------------------------------- |
| `list`               | Lista as empresas com liberação     | nenhuma                                         |
| `alert_test`         | Manda um e-mail de teste do alerta  | nenhuma                                         |
| `emergency_withdraw` | Desliga e bloqueia uma empresa      | `company`, `organization_id` opcional, `reason` |
| `unblock`            | Tira o bloqueio de uma empresa      | `company`, `organization_id` opcional, `reason` |
| `halt`               | Para a captura de todas as empresas | `reason`                                        |
| `resume`             | Desfaz a parada geral               | `reason`                                        |

## Desligar tudo agora

Qualquer uma das opções basta. Nenhuma apaga documentos já capturados nem
muda a liberação das empresas, e o que a última consulta já recebeu ainda
aparece em Documentos e na exportação (#420).

1. **GitHub, sem editar variável**: **Actions → Fiscal capture → Run
   workflow**, com `operation` em `halt` e o motivo, sem `company`. Ele grava a parada geral no banco
   do site, e nenhuma empresa consulta a Receita: cada consulta é adiada em
   uma hora, sem gastar cota nem janela, e o cofre recusa abrir. Os streams
   continuam ativos, sem alerta nem webhook para o cliente, e o console
   mostra "Parada pela Freecorps". Segue mesmo com o `/health` ruim, com um
   aviso no run (veja abaixo). Confira `captureFiscal: "halted"` no
   `/health`.
2. **Painel do Convex**, quando o GitHub ou o Actions estiverem fora: abra o
   projeto, escolha o deployment de produção `elated-possum-295`, vá em
   **Settings → Environment Variables**, apague `FNFE_CAPTURE_TRANSPORT` e
   salve. As consultas à Receita param na hora; as empresas continuam
   ativadas no console.
3. **Para desligar também a seção do console**, apague ainda
   `FNFE_CAPTURE_FISCAL`. As empresas ativadas passam a valer como
   desligadas, só com leitura.
4. **Pelo terminal**, com acesso ao projeto:

   ```sh
   cd platform
   bunx convex env remove FNFE_CAPTURE_TRANSPORT --deployment elated-possum-295
   ```

Depois das opções 2 a 4, confira `captureFiscal: "disabled"` no `/health`.

**O corte por variável não é uma pausa limpa.** Cada empresa cuja consulta
chega à vez durante o corte entra em "Captura precisa de atenção": sai o
webhook `connection.attention_required` para os destinos do projeto dono da
captura, a Freecorps recebe um alerta `attention`, e a captura só volta
quando alguém clica em **Retomar captura** ([ligar de novo](#ligar-de-novo)). Por isso, com o GitHub no ar,
use a opção 1. Não apague as variáveis por cima da parada geral: a parada
geral só adia, mas a variável ausente vale primeiro e põe a captura em
atenção do mesmo jeito.

**Consulta já enviada no momento do corte.** Com a parada geral ou sem
`FNFE_CAPTURE_TRANSPORT`, ela termina e grava o que a Receita respondeu. Sem
`FNFE_CAPTURE_FISCAL`, a resposta é descartada como incerta e a captura entra
em atenção com `ACCESS_REVOKED`; depois de **Retomar captura**, a primeira
consulta confere o que a Receita tinha respondido antes de seguir. Nada a
fazer à mão além da retomada.

## Desligar só uma empresa

- **A própria empresa**: Proprietário ou Administrador, na aba Captura da
  empresa, cartão Captura fiscal (Produção) › **Desativar**, e confirmar no
  diálogo. Para consultar menos, sem desligar, **Alterar intervalo** na mesma
  linha.
- **A Freecorps, em emergência**: no GitHub, **Actions → Fiscal capture →
  Run workflow**, com `operation` em `emergency_withdraw`. Em `company`, o id da empresa no
  Convex ([onde achar](#onde-achar-os-ids)); em `organization_id`,
  opcional, o id da organização, para conferir; e o motivo. Os inputs de um
  run são públicos: o CNPJ é recusado, e o motivo não leva nome, CNPJ nem
  dado de cliente. Ele desliga, pausa o stream de produção e impede a
  empresa de religar.
- **Desbloquear**: **Actions → Fiscal capture**, com `operation` em
  `unblock` e as mesmas entradas. Ele só tira o bloqueio: não liga nem desliga a captura, e é
  recusado (`CAPTURE_RELEASE_NOT_BLOCKED`) para empresa que não está
  bloqueada. Depois, a empresa liga de novo no console e alguém com acesso
  clica em **Retomar captura**: a captura não volta sozinha, e a consulta
  retomada parte do NSU onde parou.
- **Repetir** a emergência é seguro: grava outra linha no histórico e não
  mexe de novo no stream nem emite outro webhook. Repetir o desbloqueio é
  recusado, sem gravar nada.

### Onde achar os ids

A emergência e o desbloqueio aceitam só o id da empresa em `company`: os
inputs de um run ficam públicos no repositório, e um CNPJ é recusado com
`INPUT_INVALID` antes de qualquer chamada.

1. Ache o id por um destes caminhos, na ordem:
   - **Pelo cliente.** No console, em Captura de NF-e › Captura fiscal real,
     o trecho recolhido **Referências para o suporte** mostra a **Referência
     da organização** e a **Referência da empresa**, com botão de copiar, a
     qualquer papel que vê a empresa.
   - **Pela lista.** Rode [a lista](#listar-as-empresas-liberadas) e baixe o
     artefato `capture-fiscal-list-<run>-<tentativa>`. O `receipt.json`
     traz, por empresa com liberação, o `organizationId` e o `companyId`. O
     nome está só no `receipt.full.json.age`, cifrado para os custodiantes de
     `deploy/offsite-backup.json`: um custodiante o decifra fora do
     repositório, com `age -d -i <identidade> receipt.full.json.age`, e
     escolhe pelo nome. A lista não traz o CNPJ.
   - **Pelo painel do Convex**, só lendo, no deployment `elated-possum-295`:
     em **Data**, tabela `companies`, filtre `cnpj` pelos 14 dígitos sem
     pontuação. Cada linha mostra o `_id` da empresa e o `organizationId`;
     o nome da organização está na tabela `organizations`, pelo `_id`.
2. Dispare com o id em `company`. Esperado: run verde, com `companyId` e
   `organizationId` no log.

## `/health` ruim

Antes de chamar o Convex, o runner confere que o `/health` do deployment
responde como o site (`installation`, `sandbox`).

- **Emergência e parada geral** seguem mesmo sem essa confirmação, com o
  aviso "Health não confirmado" no run e `health: "unverified"` no recibo. O
  site fora do ar ou mal configurado é justamente quando parar importa; a
  deploy key continua presa ao deployment do plano, e a função do Convex
  recusa um deployment que não seja o site
  (`CAPTURE_RELEASE_DEPLOYMENT_DENIED`). Parar nunca abre nada.
- **Desbloqueio e religar** continuam recusando (`DEPLOYMENT_NOT_SITE`):
  eles deixam algo voltar a rodar e só seguem quando o site responde como
  ele mesmo.

## Ligar de novo

O caminho depende de como a captura foi desligada. Confira antes no
`/health`: `halted` é a parada geral; `disabled` é o corte por variável.

### Depois da parada geral

1. Em Actions, rode **Fiscal capture** com `operation` em `resume` e o
   motivo.
2. Confira `captureFiscal: "enabled"` no `/health`.
   - Run vermelho com `CAPTURE_FISCAL_NOT_HALTED`: não havia parada; nada a
     fazer.
   - Run vermelho com `DEPLOYMENT_NOT_SITE`: o `/health` não confirma o site.
     O religar só segue com o site respondendo como ele mesmo; resolva o
     `/health` primeiro.
   - `/health` em `disabled`: falta uma das variáveis, e o religar não as
     grava. Siga [depois do corte por variável](#depois-do-corte-por-variável).
3. Nada mais. Cada stream consulta na próxima checagem, em até uma hora,
   respeitando a janela da fonte, e nenhum cliente precisa agir. O religar não
   libera nenhuma empresa que estava desativada.

### Depois do corte por variável

1. Grave as duas variáveis no mesmo lugar em que foram apagadas: no painel do
   Convex, `FNFE_CAPTURE_FISCAL` = `enabled` e `FNFE_CAPTURE_TRANSPORT` =
   `sefaz`; ou pelo terminal:

   ```sh
   cd platform
   bunx convex env set FNFE_CAPTURE_FISCAL enabled --deployment elated-possum-295
   bunx convex env set FNFE_CAPTURE_TRANSPORT sefaz --deployment elated-possum-295
   ```

2. Confira `captureFiscal: "enabled"` no `/health`. Se vier `disabled`,
   confira o valor exato das duas, sem espaço nem maiúscula. Se vier
   `halted`, a parada geral também vale: siga antes
   [depois da parada geral](#depois-da-parada-geral) e volte ao passo 3.
3. Rode [a lista](#listar-as-empresas-liberadas). Cada empresa com
   `release: "released"` cai num destes casos:
   - `stream: "active"`: a consulta dela não chegou à vez durante o corte e
     segue sozinha. Nada a fazer.
   - `stream: "attention"` com `code` `FISCAL_TRANSPORT_DISABLED` (faltou
     `FNFE_CAPTURE_TRANSPORT`) ou `ACCESS_REVOKED` (faltou
     `FNFE_CAPTURE_FISCAL`): a consulta chegou à vez durante o corte. Religar
     as variáveis não a retoma, nem o workflow de religar da parada geral, e
     o servidor não confere de novo esses dois códigos sozinho.
4. Cada empresa em atenção retoma por conta própria: alguém com acesso
   (Proprietário, Administrador ou Operador da empresa) abre a aba Captura,
   cartão Captura fiscal (Produção), e clica em **Retomar captura**. A
   Freecorps não tem workflow que retome por ela. Com as duas variáveis de
   volta, o console já diz à empresa que a Freecorps pausou a captura e que
   basta retomar (#601), no cartão e no Início; não é preciso explicar o
   corte a ela. O código continua o mesmo na lista e na API. Se a captura foi
   ativada por integração, quem retoma é a integração, com
   `POST /v1/connections/nfe` e a ação `resume`, e o console diz isso à
   empresa no cartão e no Início (#607). A API não diz que foi o corte, então
   avise a integração.
5. Rode a lista de novo. Esperado: `stream: "active"` e `code` vazio nas
   empresas retomadas. A primeira consulta pede o NSU do checkpoint, sem
   pular nem repetir nada; se a consulta em voo ficou incerta, ela confere
   antes o que a Receita respondeu.

Esse comportamento está em `platform/convex/lib/siteCaptureCutoff.test.ts`,
bloco "corte geral por variável e religar (#425)".

## Captura em atenção

A captura em produção nunca para em silêncio: toda parada que não foi pedida
deixa o painel em "Captura precisa de atenção", com o motivo, e emite
`connection.attention_required` ([continuidade](../plataforma/CAPTURE.md#continuidade-da-captura-em-produção)).
`PLAN_REQUIRED` indica que falta plano atribuído com cotas finitas de capturas
e bytes, inclusive no plano gratuito. O administrador do deployment atribui
o plano pelo procedimento de [consumo](../plataforma/USAGE.md#plano-e-autorização);
a atribuição rearma as capturas pausadas por esse motivo. Não desligue os
gates fiscais nem libere manualmente reservas incertas para contornar a recusa.
Cota esgotada ou plano fora da vigência voltam sozinhos com o novo período ou
o novo plano; a cota conta só o consumo de Produção, e o do sandbox não a
esgota ([ambientes](../plataforma/USAGE.md#ambientes)); falta de A1 válido
volta sozinha quando a empresa ativar um A1 próprio
([renovação do A1](#renovação-do-a1-da-empresa)). Os demais motivos
pedem **Retomar captura** depois de conferir a causa; o trecho de uma lacuna
que saiu da Receita pede a decisão da empresa
([lacuna](#lacuna-na-captura-419)). Uma captura em atenção com `SOURCE_999`
recebeu três erros não catalogados seguidos da Receita: ela já tentou de novo
duas vezes sozinha (#195). Ativa, com o mesmo código, ela ainda está tentando
e não pede nada. Retome; se parar de novo com 999, abra uma
issue com os ids. A parada geral da
Freecorps não é uma parada da captura: ela só adia as consultas e não põe
nenhuma em atenção.

## Listar as empresas liberadas

1. Em Actions, rode **Fiscal capture** (`capture-fiscal.yml`) com
   `operation` em `list`, sem outras entradas. Só quem está em
   `deploy/issuance-gate.json` dispara.
2. No log do passo "Check the run, the authorized person and the inputs,
   then act", a
   primeira linha é o resumo do deployment: `captureFiscal`, `transport`,
   `halted`, o número de empresas e `armed`. Depois vem uma linha por empresa
   que já teve liberação, com `organizationId`, `companyId`, `release`,
   `minIntervalHours`, `stream`, `code`, `operation`, `lastSuccessAt`,
   `recovering`, `certificateDays`, `certificateOwn`, `supervised`,
   `supervisionFailing`, `error` e `lastAlert`.
3. As liberadas são as linhas com `release: "released"`. `withdrawn` é
   desativada; `blocked`, suspensa pela emergência. A lista lê o registro de
   cada empresa: sem `FNFE_CAPTURE_FISCAL`, as liberadas continuam
   `released` aqui, e o resumo traz `captureFiscal: false`.
4. O nome de cada empresa e os 10 alertas mais recentes dela ficam só no
   recibo cifrado (`receipt.full.json.age`) do artefato
   `capture-fiscal-list-<run>-<tentativa>`. O `receipt.json` público traz
   os ids, os estados e o SHA-256 da resposta completa. O CNPJ não aparece
   no log nem nos recibos.

Se o run vier vermelho, o código está no log: `ACTOR_NOT_AUTHORIZED` é quem
disparou fora da lista; `DEPLOYMENT_NOT_SITE`, o `/health` não confirma o
site. A lista recusa com o `/health` ruim; nesse caso, leia direto o painel
do Convex, abaixo.

A lista não consulta a Receita nem muda captura, liberação ou registro de
cliente. A única escrita é armar a verificação de 6 em 6 horas de uma empresa
liberada que ainda não a tenha (`armed` no resumo). Depois do primeiro deploy
da #422, rode-a uma vez e confira `supervised: true` em cada liberada.

**Sem escrita nenhuma, pelo painel do Convex.** No deployment
`elated-possum-295`, em **Data**, abra a tabela `captureReleases` e filtre
`released` igual a `true`. Cada linha traz `companyId`, `organizationId`,
`minIntervalHours` e a versão. O CNPJ e o nome estão na tabela `companies`,
pelo `_id`. Só olhe: não edite linhas.

## Alertas da captura

A Freecorps recebe um alerta de cada atenção de uma captura em produção e do
que a verificação de cada empresa liberada encontra a cada 6 horas
([supervisão](../plataforma/CAPTURE.md#supervisão-e-alertas-422)). Um alerta
chega uma vez, por e-mail em `FNFE_CAPTURE_ALERT_EMAIL` (no site, a
[caixa de operação](email.md#caixas) no Ember Mail, e o
[endereço de plantão](operacao-email.md#aviso-fora-do-console)), e sempre como linha
`capture_alert` no log do Convex do site. O e-mail traz tipo, código e ids da
organização, da empresa e do stream, sem CNPJ. A situação de todas as
empresas está na [lista](#listar-as-empresas-liberadas).

**O que fazer com cada alerta:**

| Alerta        | O que significa                                                        | O que fazer                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attention`   | A captura parou com o código                                           | Veja [captura em atenção](#captura-em-atenção); um 656 (`SOURCE_CONSUMPTION_BLOCKED`) segue [656 e esperas](#656-e-esperas). Fale com a empresa se for dela |
| `stalled`     | Stream ativo, mas a operação não avança: não deveria acontecer         | Investigue pela referência do stream em Operação e suporte da organização e abra uma issue com os ids; não edite o stream                                   |
| `quiet`       | 30 ou 50 dias sem consulta respondida, inclusive com a captura pausada | Avise a empresa: aos 60 dias a Receita pode suspender a geração de NSU do CNPJ. Ela retoma no console ou desliga a captura                                  |
| `gap`         | Lacuna aberta perto dos 90 dias em que a Receita guarda o documento    | Confira a recuperação ([lacuna](#lacuna-na-captura-419)); o que passar dos 90 dias só volta com a decisão da empresa                                        |
| `certificate` | A1 a 30 ou 7 dias do vencimento; `0` é vencido ou sem A1 próprio       | Avise a empresa para enviar o A1 novo; a captura volta sozinha quando um A1 próprio for ativado                                                             |
| `supervisor`  | A verificação da empresa falhou; ela continua agendada                 | Procure `capture_supervisor_error` no log do Convex pelo `companyId` e abra uma issue com a linha; não edite registros. Um alerta por sequência de falhas   |

O resumo da lista traz `recent`, a contagem dos alertas dos últimos 30 dias
por tipo e código. Um e-mail `uncertain` ou `failed` não é reenviado: o alerta
continua na lista. Sem `FNFE_CAPTURE_ALERT_EMAIL`, os alertas ficam
`unconfigured`, só no log e na lista.

**Alertas suprimidos.** Com 20 e-mails de alerta entregues ao provedor na
última hora, os alertas seguintes ficam `suppressed`: nenhum e-mail sai para
eles, nem depois, e não há resumo. Eles ficam só no log do Convex (a linha
`capture_alert` e uma `capture_alert_delivery` com `delivery: "suppressed"`)
e na lista. Quando chegar um e-mail de alerta numa hora agitada, ou a cada
evento em massa, rode a lista: o resumo traz `suppressed`, a contagem dos
últimos 30 dias, e o recibo cifrado traz cada alerta com a entrega, entre os 10 mais
recentes da empresa.

### Testar o e-mail dos alertas

Configuração não prova entrega. Depois de gravar ou trocar
`FNFE_CAPTURE_ALERT_EMAIL`, prove que o e-mail chega sem esperar um alerta
real. Não expire certificado nem provoque consulta à Receita para gerar um.

1. Em Actions, rode **Fiscal capture** (`capture-fiscal.yml`) com
   `operation` em `alert_test`, sem outras entradas. Só quem está em
   `deploy/issuance-gate.json` dispara, e o `/health` precisa confirmar o
   site.
2. No log do passo "Check the run, the authorized person and the inputs,
   then act", a linha de resumo traz `alertDestination`, `recipients`,
   `delivery` e `sentAt`. O recibo fica no artefato
   `capture-fiscal-alert_test-<run>-<tentativa>`. Nenhum dos dois mostra os
   endereços.
3. Na caixa `nfe-operacao` do Ember Mail (ou em cada caixa de `FNFE_CAPTURE_ALERT_EMAIL`), procure o assunto
   `[Freecorps Fiscal] Teste do alerta da captura: run <run>/<tentativa>` e
   anote o horário de chegada.
4. Registre na issue da mudança (a #463 na ativação, a #126 no endereço de
   plantão) o run, o `sentAt`, o horário de chegada em cada caixa e o
   resultado, sem os endereços.
5. Grave o recibo e atualize a entrada `capture-alert` de
   `deploy/receipts.json`, como em [Recibos](recibos.md#registrar-um-recibo).

O run só fica verde com `delivery: "sent"`, que é o aceite do provedor. Se
vier vermelho, o recibo diz por quê:

- `alertDestination: "unconfigured"`: falta ou está malformada uma das
  variáveis da [supervisão](../plataforma/CAPTURE.md#supervisão-e-alertas-422);
  nada saiu;
- `delivery: "failed"`: o provedor recusou (4xx); confira token e remetente;
- `delivery: "uncertain"`: sem resposta legível; o provedor pode ter aceitado.
  Olhe as caixas antes de disparar de novo.

O teste não é um alerta: não aparece na lista, não conta no teto de 20 por
hora e não muda captura, liberação ou registro de cliente. No log do Convex,
ele é a linha `capture_alert_test`, com o run e o número de endereços.

## 656 e esperas

O 656 é a Receita bloqueando por uma hora a distribuição de um CNPJ por
consumo indevido. O bloqueio vale para todos os sistemas que consultam esse
CNPJ, inclusive o ERP e o contador da empresa. Quase sempre a causa é outro
sistema consultando a distribuição do mesmo CNPJ.

**Como ele aparece.**

- E-mail de alerta `attention` com o código `SOURCE_CONSUMPTION_BLOCKED`, e a
  linha `capture_alert` no log do Convex do site.
- Na [lista](#listar-as-empresas-liberadas): `stream: "attention"` e
  `code: "SOURCE_CONSUMPTION_BLOCKED"`.
- No console da empresa: "Captura precisa de atenção", com o motivo "A
  Receita bloqueou por cerca de uma hora as consultas deste CNPJ", e o botão
  **Retomar captura** desabilitado, com "A Receita só aceita uma nova
  consulta deste CNPJ a partir de" e o horário.
- Sai o webhook `connection.attention_required` para os destinos do projeto
  dono da captura.

O que a captura já fez sozinha: parou sem nova tentativa, guardou checkpoint,
cursor e modo como estavam
([656 e `ultNSU`](../plataforma/CAPTURE.md#coordenação-e-recuperação)),
marcou a próxima consulta para uma hora depois da resposta e contou o 656
como falha da fonte nos monitores. Por 24 h, a recuperação de lacunas usa
metade do teto, 3 consultas pontuais por hora (`recovery_backoff` em
`captureAudit`).

**O que fazer.**

1. Espere a hora passar. Até lá, o servidor recusa a retomada com
   `SOURCE_COOLDOWN`, pelo console e pela API. Não edite `nextAllowedAt`
   para antecipar: a hora de espera depois de um 656 é regra da
   [ADR 0007](../adr/0007-captura-fiscal-no-site.md), §4, e consultar antes
   arrisca outro bloqueio para todos os sistemas do CNPJ.
2. Enquanto espera, procure o outro consumidor do CNPJ:
   - **O alvo da #50.** O de 20 e 22/10 foi
     apagado em 26/10/2026. Se houver um alvo novo, abra-o no painel do
     Convex, **Settings → Environment Variables**, e confira
     `FNFE_CAPTURE_TRANSPORT` = `disabled`. Pergunte ao mantenedor
     se há rodada da #50 aberta para esse CNPJ. Se o
     transporte estiver `sefaz` ou houver rodada, o conflito é esse: quem
     tem a pasta privada da rodada roda
     `node scripts/fiscal/fiscal-proof.mjs pause C:\CAMINHO\PRIVADO`, o
     desligamento de emergência da
     [#50](../plataforma/CAPTURE.md#roteiro-do-operador), e registra na
     autorização da rodada que ela quebrou a
     [regra](#dois-consumidores-do-mesmo-cnpj).
   - **Outro stream do site para o mesmo CNPJ** não existe: `STREAM_CONFLICT`
     garante um só por CNPJ no deployment.
   - **Os sistemas da empresa.** Pergunte à empresa se o ERP, o contador ou
     outro integrador consulta a distribuição de NF-e do CNPJ. A Freecorps
     não enxerga esses sistemas, e o 656 não diz quem foi.
3. Depois do horário, quem retoma é a empresa: alguém com acesso clica em
   **Retomar captura**, ou a integração chama `POST /v1/connections/nfe` com
   `resume`. Esperado: `stream: "active"` na lista e, depois da consulta
   seguinte, `lastSuccessAt` com o horário dela.
4. Se o 656 voltar logo depois da retomada, o conflito continua. A captura
   para de novo em atenção, com outro webhook e outra hora de espera. Não
   insista: combine com a empresa desligar o outro consumidor ou aumentar o
   intervalo da captura (**Alterar intervalo**, até 24 h). Se a empresa não
   resolver e o 656 se repetir, a Freecorps pode suspender a captura dela
   pela [emergência](#desligar-só-uma-empresa) até a conversa terminar.

Esse comportamento está em `platform/convex/lib/siteCapture.test.ts`, nos testes
de 656 de "agenda, 656 e retirada".

**Streams de antes da #421.** Até a #421, um 656 com `ultNSU` acima do
checkpoint mudava o stream para recuperação `consNSU`, um NSU por hora, até
esse NSU. Desde a #419 a próxima consulta desses streams reconhece o cursor
do 656 e volta sozinha a `distNSU` a partir do checkpoint (auditoria
`blocked_cursor_cleared` em `captureAudit`). Nada a fazer à mão; não edite
cursor nem modo.

**Esperas não são falhas.** A janela da fonte, o teto de 120 consultas por
hora e a parada geral só adiam a consulta (`SOURCE_COOLDOWN`): não contam
como falha da fonte nos monitores nem esgotam a operação. O monitor de cursor
em Produção só alerta depois do intervalo mínimo da empresa mais uma hora
sem sucesso (com 24 h, a partir de 25 h).

## Renovação do A1 da empresa

A captura consulta a Receita com o A1 da própria empresa: ativo, do mesmo
CNPJ e dentro da validade. Quem renova é a empresa. A Freecorps não recebe
nem envia o A1 de cliente.

**Quando agir.** O alerta `certificate` chega a 30 e a 7 dias do vencimento.
Na [lista](#listar-as-empresas-liberadas), `certificateDays` traz os dias
que faltam no A1 ativo; `null` é empresa sem A1 ativo, e `certificateOwn:
false`, um A1 ativo de outro CNPJ. Avise a empresa no primeiro alerta.

**O que a empresa faz no console.** Proprietário ou Administrador:

1. Abre a empresa, aba **Certificado**, cartão **Enviar certificado A1**.
2. Escolhe o arquivo `.pfx` ou `.p12`, de até 256 KiB, digita a senha e
   clica em **Enviar para validação**.
3. Espera a lista de versões. Esperado: a versão nova passa de "Em
   validação" a "Validado para uso no serviço", e a anterior fica
   "Substituído".
4. Se a versão nova ficar "Rejeitado", a mensagem diz o motivo: senha ou
   arquivo errado, outro CNPJ, vencido ou ainda fora da validade. A versão
   anterior continua ativa, e a captura segue com ela. Envie o arquivo certo.

Não use **Desativar versão** no A1 ativo antes de a versão nova estar
validada: a empresa fica sem A1, e a próxima consulta para em atenção.

**O que acontece com a captura.**

- **Durante o envio e a validação**, nada muda: as consultas usam o A1
  ativo.
- **Depois da validação**, a próxima consulta já usa o A1 novo. O stream não
  muda de versão, não sai webhook nem alerta, e o checkpoint segue de onde
  estava. O log do Convex registra `operation.certificate_current` nessa
  consulta.
- **Se a troca cair no meio de uma consulta**, há dois casos. Antes do envio
  à Receita, a consulta espera um segundo (`CERTIFICATE_CHANGED`) e segue
  com o A1 novo, sem atenção. Com a consulta já enviada, a resposta é
  descartada como incerta, e a captura entra em atenção com `ACCESS_REVOKED`,
  webhook e alerta. Nesse caso, alguém com acesso clica em **Retomar
  captura**; a primeira consulta confere o que a Receita respondeu, já com o
  A1 novo.
- **Se o A1 venceu antes da renovação**, a consulta que chegou à vez parou em
  atenção com `CERTIFICATE_UNAVAILABLE`, com webhook e alerta `attention`;
  a verificação seguinte da empresa manda também o alerta `certificate` com
  `0`. Quando a versão nova fica "Validado para uso no serviço", a captura
  volta sozinha, sem **Retomar captura**, e a consulta respeita a janela da
  fonte.

**Conferir depois.** Rode a lista: `certificateDays` com a validade nova,
`certificateOwn: true` e `stream: "active"`. Se ficar `attention` com
`CERTIFICATE_UNAVAILABLE`, a empresa continua sem A1 próprio válido; com
`ACCESS_REVOKED`, retome como acima.

Esse comportamento está em
`platform/convex/lib/siteCaptureContinuity.test.ts`, bloco "continuidade da
captura em Produção", em `platform/convex/lib/siteCaptureAuthorize.test.ts`
(o A1 trocado entre `prepare` e `authorize`) e em
`platform/convex/certificates.test.ts`.

## Lacuna na captura (#419)

Uma captura que fica sem consultar a Receita por mais de 90 dias volta com
uma lacuna: a Receita só guarda cada registro da fila (uma nota, um resumo
ou um evento, cada um com seu NSU) por 90 dias. A captura busca
sozinha o que ainda existe, até 6 consultas pontuais por hora (3 por hora no
dia seguinte a um 656), e localiza o
trecho que saiu da Receita. Então o painel mostra "Captura precisa de
atenção" com "Parte do histórico não está mais na Receita", o período sem
consulta, até quantas notas ou eventos saíram e a referência na fila (NSU de
a), e o webhook
`connection.attention_required` sai.

- **Quem decide** é só o Proprietário da organização, no console, em
  **Aceitar a perda e continuar**, e precisa escrever o motivo (até 500
  caracteres). A Freecorps não aceita pelo cliente. Administrador, Operador e
  Leitura veem a explicação e "Somente o Proprietário decide aceitar a perda
  e continuar.", sem a ação (decisão do dono em 26/10/2026,
  [ADR 0008](../adr/0008-perda-fiscal-em-captura-de-integracao.md)).
- **O que muda**: a captura volta a ler do primeiro registro que a
  Receita ainda tem. As notas e os eventos do trecho não chegam pela captura
  e não entram em Produção, que guarda só o que a captura recebe da Receita;
  não há outro caminho para trazê-los a Produção. A decisão não pode ser
  desfeita, fica registrada com o nome, a data, o intervalo e o motivo, e
  aparece no painel depois.
- Com o limite confirmado pelo 137, consultar de novo não muda nada, e o
  painel não oferece outra tentativa.
- Uma captura ativada por integração nesse estado também é decidida no
  console, pelo Proprietário, com motivo; a ação não existe na API
  (#442). Depois, a captura continua na integração, com a chave dela, e os
  destinos dela que assinaram `connection.history_limited` recebem o
  intervalo perdido e `decidedBy: "owner"`, sem o motivo nem o nome de quem
  decidiu. Se a integração diz que não recebeu, confira em Webhooks, no
  projeto dela, se o destino assina o evento e o histórico de entregas; o
  reenvio manual repete o mesmo evento. Aceitar de novo não reenvia: a
  repetição devolve a captura como está. Se a integração perdeu o acesso
  (chave revogada ou vencida, concessão mudada), o painel recusa, nada é
  enviado, e ela precisa retomar a captura com uma chave válida antes.
- Sem o limite localizado (captura que entrou em atenção antes da #419), o
  painel pede **Retomar captura**; a recuperação localiza o limite e o
  painel passa a oferecer a ação.

### Empresa piloto: destravar depois do deploy da #419

A empresa piloto da captura está pausada desde 22/10/2026. Nada abaixo foi executado; é o
roteiro depois que a #419 estiver publicada no site.

1. Conferir o `/health` (`captureFiscal: "enabled"`) e o SHA publicado com
   a #419.
2. Pedir ao Proprietário ou Administrador da empresa piloto que abra a aba
   Captura, cartão Captura fiscal (Produção). Se estiver "Captura pausada", clicar
   **Retomar captura**. A captura segue sozinha:
   - sem lacuna, lê a fila com `distNSU`;
   - com lacuna recuperável, busca o que falta e segue;
   - com trecho perdido, para em atenção com a explicação.
3. Se aparecer "Parte do histórico não está mais na Receita", conferir com a
   empresa o período e a quantidade e deixar que o Proprietário dela decida
   **Aceitar a perda e continuar**, com o motivo. Depois, a captura lê a fila a partir do primeiro
   registro disponível.
4. Para acompanhar, só leitura no painel do Convex do site: o
   `captureStreams` de `production` da empresa (`mode`, `checkpoint`,
   `recovery`) e, em `captureAudit`, as linhas `history_limited` e
   `checkpoint_committed`. Não edite cursor, modo nem `recovery`.
5. Se vier 656, seguir [656 e esperas](#656-e-esperas): outro sistema
   consulta o CNPJ.

## Ensaio dos workflows

**Ensaiado em 23/10/2026**, passos 1 e 3 a 7
(evidência). A conferência
visual do console, passos 1, 3 e 7, foi feita no site em 28/10/2026
(evidência). O passo 8 foi dispensado em
26/10/2026: as duas contas do repositório estão em `authorizedActors`, e a
recusa fica provada por teste e pelo ensaio local de 25/10
([ADR 0007](../adr/0007-captura-fiscal-no-site.md#decisões-da-424-em-26102026)).
Repita-o quando uma terceira pessoa tiver escrita no repositório.

O site não tem empresa de ensaio que possa ser liberada, então o ensaio de
23/10 não parou nenhuma captura em andamento. Isso foi ensaiado em
25/10/2026 num Convex local de worktree, com empresa e A1 sintéticos e a
fonte sintética no lugar da Receita: parar uma empresa liberada com a
captura agendada, repetir a parada, desbloquear, repetir o desbloqueio,
liberar de novo e retomar pelo console, e o desbloqueio indevido de uma
empresa liberada (evidência).
As chamadas passam pelas mesmas funções do runner dos workflows, mas o run
do GitHub é sintético; esse ensaio não substitui o do site. Repita o
ensaio depois de mudar os workflows, `scripts/deploy/capture-release.mjs` ou
`scripts/lib/sealed-receipt.mjs`. Os
workflows rodam da `main` e as funções precisam estar no site. Quem dispara
precisa estar em `deploy/issuance-gate.json`.

**Preparação.** Numa organização de ensaio da Freecorps no site, uma
empresa sem certificado, de demonstração ou declarada com um CNPJ que nenhum
cliente use. Nenhuma empresa real entra no ensaio por empresa. Anote, pelo
console, as duas referências.

| Passo | Ação                                                                            | Evidência esperada                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Emergency withdraw com `company` = CNPJ pontuado                                | Run vermelho com `INPUT_INVALID`, antes de qualquer chamada; nada gravado                                                                                                  |
| 2     | Emergency withdraw com `company` = id                                           | Run verde; log com `companyId` da empresa de ensaio e `blocked: true`; recibo `passed`, `health: "verified"` e `sealed.state: "sealed"`; console "Suspensa pela Freecorps" |
| 3     | No console, tentar ativar                                                       | Recusa "A Freecorps suspendeu a captura fiscal desta empresa"                                                                                                              |
| 4     | Unblock com `company` = id e o `organization_id` de outra organização de ensaio | Run vermelho com `NOT_FOUND`; nada gravado                                                                                                                                 |
| 5     | Unblock com `company` = id e `organization_id` dela; depois, de novo            | Run verde, `blocked: false`, versão +1, console "Desativada"; o segundo vermelho com `CAPTURE_RELEASE_NOT_BLOCKED` e versão inalterada                                     |
| 6     | Parada geral e, em seguida, religar                                             | `/health` em `halted` e de volta a `enabled`; console "Parada pela Freecorps" e de volta a "Captura ativa"; nenhum stream em atenção; histórico com as duas linhas         |
| 7     | Disparo por pessoa fora de `authorizedActors`, quando houver quem faça          | Run vermelho com `ACTOR_NOT_AUTHORIZED`; nada gravado                                                                                                                      |

O passo 6 atinge as empresas reais liberadas. Faça-o num momento em que
nenhuma delas tenha consulta prevista nos minutos seguintes (próxima janela
no painel da captura), avise o responsável e religue logo depois. Uma
consulta que cair durante a parada é adiada em uma hora, e a retomada pode
levar esse tempo. A emergência com `/health` ruim não é
ensaiada, porque exigiria quebrar o site; ela está coberta por
`scripts/deploy/capture-release.test.ts`.

**Onde registrar.** Em `docs/v1.0/evidence/424/AAAA-MM-DD/README.md`, por
passo: URL do run, tentativa, SHA, quem disparou, horário, código ou
resultado e versão, mais o nome do artefato e o `sealed.sha256` do
`receipt.json`. Não copie o
CNPJ nem o nome de empresa de cliente. Ao final, apague ou bloqueie as
empresas de ensaio e registre o estado deixado.

## Dois consumidores do mesmo CNPJ

O alvo dedicado da [#50](../plataforma/CAPTURE.md#execução-fiscal-manual-da-50)
e o site são deployments diferentes. O alvo de 20 e 22/10
foi apagado em 26/10/2026; uma rodada nova cria
outro.
`STREAM_CONFLICT` garante um único stream por CNPJ só dentro de um
deployment, então nada impede os dois de consultarem o mesmo CNPJ e somarem
consultas até um 656, que bloqueia a distribuição para todos. O mesmo vale
para um deployment restaurado de backup; por isso ele sobe sem as variáveis
da captura ([restauração](backup.md#recuperação-após-perda-do-host)).

**Regra.** O alvo da #50 não consulta um CNPJ enquanto ele estiver liberado
no site. Isso vale para a empresa piloto desde 22/10/2026. Antes de uma rodada da
#50, confira no painel do Convex do site, só para leitura, que nenhuma
empresa daquele CNPJ (`companies`, campo `cnpj`, em qualquer organização)
tem `released: true` em `captureReleases`. Se tiver, a
rodada não acontece até a empresa desativar ou a Freecorps usar a
emergência, e a primeira consulta da rodada espera a janela de uma hora da
fonte desde a última consulta do site. Registre a conferência na
autorização da rodada.

Uma trava automática exigiria que o runner da #50 lesse o banco do site, com
a deploy key do site, e misturaria os dois alvos que a #50 mantém
separados. Por isso ela não existe; a regra acima é a proteção.

## Depois do deploy da #420: documentos presos

Antes da #420, desligar a captura, a emergência ou o corte geral logo depois
de uma consulta com notas pausava o processamento delas com `ACCESS_REVOKED`.
O XML ficou guardado, mas a nota não aparece em Documentos, e nenhuma
consulta seguinte a traz de novo. Uma vez, depois que o deploy com a #420
estiver no site (`/health` com o SHA da `main` que a contém):

```sh
cd platform
bunx convex run captures:resumeStoredDocuments '{}' --deployment elated-possum-295
```

Ela não consulta a Receita nem abre certificado: só retenta o processamento
de `documents.capture` de produção pausado com `ACCESS_REVOKED`, se a origem
ainda tiver acesso, e continua sozinha, de 50 em 50 envelopes, até o fim. A
resposta é a da primeira página; o total sai no log do deployment
(**Logs**, `captures.resumeStoredDocuments: N resumed, M refused, stillPaused
{...}`). Repetir não faz mal: o que já voltou não é tocado e nenhuma nota é
duplicada. Pode rodar durante a parada geral: ela não corta esse
processamento. Registre a linha do log na issue #420.

- `resumed`: saiu de `paused` e vai virar documento; nada a fazer.
- `refused`: continua cortada de propósito pela origem, com `ACCESS_REVOKED`:
  organização encerrada, empresa fora da organização, projeto ou concessão
  revogados, chave revogada ou, nas filhas criadas antes da #418, a pessoa
  que iniciou a captura sem acesso.
- `stillPaused`: foi retentada, mas pausou de novo, com o código ao lado
  (por exemplo `RECOVERY_BUDGET_EXHAUSTED` ou `ATTEMPTS_EXHAUSTED`). Rodar de
  novo não a pega: o código já não é `ACCESS_REVOKED`.

**Se `refused` ou `stillPaused` vierem acima de zero**, liste essas
operações só lendo, página por página, passando o `continueCursor` da
resposta até `isDone: true`:

```sh
cd platform
bunx convex run captures:pausedStoredDocuments '{}' --deployment elated-possum-295
bunx convex run captures:pausedStoredDocuments '{"cursor":"<continueCursor>"}' --deployment elated-possum-295
```

Cada linha traz só ids, o código e o tipo de origem (`release`,
`membership`, `key`, `stripe`), sem dado fiscal. A query não muda nada.
Não retome à mão nem mude a origem de uma operação: a decisão é do
mantenedor, registrada na issue #420 com a lista. Um
`refused` é corte de acesso e, em regra, fica como está; um `stillPaused` ou
uma filha antiga com `membership` pede uma decisão de código, numa PR, antes
de qualquer escrita no deployment.
