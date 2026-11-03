# Captura fiscal de NF-e no site hospedado

Data: 22/10/2026 · Status: **Aceita** pelo dono do projeto em 26/10/2026,
com as seis fases cumpridas e a ressalva de governança registrada em
[Aceite de 26/10/2026](#aceite-de-26102026). Proposta pelo mantenedor em
22/10/2026.

O site hospedado (`api.nfe.freecorps.com.br`) é um sandbox: `PRODUCT_ENV`
fixa o ambiente `sandbox` para o deployment inteiro e o perfil `installation`
exige `FISCAL_ENV=disabled`. A leitura real da distribuição de NF-e só existe
no alvo dedicado da #50, operado à mão, com até duas consultas por rodada. A
rodada de 22/10/2026 comprovou
captura e avanço real do NSU em produção. Falta oferecer isso aos clientes
sem um operador da Freecorps em cada consulta.

A captura é só leitura: não emite, não cancela, não manifesta e não gera
evento visível ao emitente. Cada consumidor guarda o próprio NSU, e a fonte
não marca o documento como entregue. Esse é o motivo de esta decisão valer
só para a captura de NF-e e não para a emissão NFS-e.

## Decisão

### 1. Dois ambientes no mesmo deployment

O site hospedado passa a atender `sandbox` e `production` no mesmo
deployment. O ambiente deixa de ser uma constante do deployment e passa a
ser resolvido em cada pedido:

- **API.** Continua vindo da chave: cada concessão já tem ambientes, e uma
  chave de `sandbox` nunca lê nem grava em `production`.
- **Console.** Um seletor "Sandbox" / "Fiscal" escolhe o ambiente que a
  pessoa vê e opera, como os modos de teste e de produção de um gateway de
  pagamento. O modo fiscal tem marcação visual permanente. O seletor só muda
  a visão: nenhum registro troca de ambiente.
- **Servidor.** Toda função que hoje lê `PRODUCT_ENV` recebe o ambiente como
  argumento validado e o confere contra a empresa (§2) antes de ler ou
  gravar. O cliente envia a intenção; o servidor decide.

Documentos, lotes, operações, streams, exportações, webhooks e uso já
carregam `environment`. Um registro de `sandbox` nunca aparece em
`production`, e o inverso também não, inclusive em downloads, respostas
deduplicadas e eventos de webhook.

### 2. Ambiente fiscal só para empresas liberadas

`production` existe para uma empresa só quando ela tem a captura fiscal
liberada. A liberação segue o modelo do gate de produção da NFS-e
([ADR 0004, §8](0004-motor-de-emissao-nfse.md#8-ambientes-e-gates)):

- **Ligar** vem de um workflow do GitHub Actions, disparado por uma pessoa e
  aprovado por outra, diferente dela, num environment protegido com
  _Prevent self-review_. O registro guarda operador, aprovador, motivo, run,
  tentativa e a referência da autorização escrita do responsável legal da
  empresa, mantida fora do Git.
- **Desligar** vem de um workflow de emergência separado, sem aprovação,
  disparado por uma pessoa autorizada. Desligar nunca abre nada.
- **Nenhum membro, chave de API ou função pública** altera a liberação.

A liberação também exige certificado A1 ativo no cofre com o mesmo CNPJ da
empresa ([ADR 0003](0003-cofre-de-certificados-da-plataforma.md)). Empresas
sem liberação continuam só com `sandbox`; o seletor não mostra o modo fiscal
para elas.

O deployment tem ainda um corte geral: com a captura fiscal desligada por
variável de ambiente, nenhuma empresa consulta a fonte. A variável só fecha;
ela sozinha nunca libera uma empresa.

**Emenda de 22/10/2026: liberação pela própria empresa.** Decisão do
mantenedor (registrada em 22/10/2026). Ela substitui a
forma de ligar descrita acima e mantém o efeito, a emergência e o corte:

- **Ligar** é autoatendimento: o Proprietário ou Administrador da organização,
  com acesso à empresa, ativa a captura fiscal no console. O servidor exige
  empresa declarada de organização aberta, A1 ativo da própria empresa com o
  mesmo CNPJ, o aceite da versão atual dos termos, que substitui a
  autorização escrita, e o intervalo mínimo de 1 a 24 horas. O histórico
  guarda a pessoa e a versão dos termos.
- **Desligar** pela empresa também é no console; sobra a leitura do que foi
  capturado.
- **A Freecorps** retira a captura por um workflow de emergência, sem
  aprovação, que também bloqueia a empresa de ligar de novo; outro workflow,
  também sem aprovação, desfaz o bloqueio sem ligar nada. Ambos só para
  quem está na lista de pessoas autorizadas.
- **Chave do deployment.** A captura fiscal só existe no deployment com
  `FNFE_CAPTURE_FISCAL=enabled`. Sem esse valor, nenhuma empresa liga, e as
  ligadas valem como retiradas: é o corte geral, que falha fechado.

Motivo: o plano do GitHub da Freecorps não oferece revisores obrigatórios em
repositório privado, então a aprovação por outra pessoa no run não é
possível; e a liberação manual por empresa não escala. O risco de 656 e de
LGPD passa a ser declarado e aceito pela empresa nos termos, como em
qualquer integração que ela mesma configura.

> Nota de 03/11/2026: o repositório passou a público, e o plano Free oferece
> revisores obrigatórios de environment em repositório público. A decisão
> acima não muda: a empresa liga e desliga a captura no console, sem
> aprovação no run.

### 3. Escopo do ambiente fiscal no site

No site hospedado, `production` cobre:

- captura de NF-e modelo 55 pela distribuição do Ambiente Nacional
  (`www1.nfe.fazenda.gov.br`, `tpAmb=1`);
- consulta, download e exportação dos documentos capturados, pelo console,
  pela API e pelo SDK;
- webhooks desses documentos e da captura.

Continuam fora:

- **Emissão NFS-e real.** Fica no deployment dedicado da ADR 0004, que não
  muda. O site continua recusando `FNFE_ISSUANCE_ENV`.
- **Manifestação do destinatário**, inclusive a ciência da operação. A
  captura entrega o que a fonte oferece sem manifestação; o XML completo que
  não vier fica registrado como limite.
- **Importação manual de XML em `production`.** Fica para decisão posterior,
  porque um XML importado não prova a origem fiscal.
- **Homologação** no site. Ela continua só no alvo dedicado da #50.

### 4. Consulta automática

Com a empresa liberada e o certificado ativo, a captura fiscal roda sem
ação manual, agendada por stream a partir de `nextAllowedAt`. As regras da
[captura](../plataforma/CAPTURE.md#coordenação-e-recuperação) continuam,
sem o limite de duas consultas da prova:

- **Fila pendente** (`ultNSU < maxNSU`): próxima consulta depois de um
  segundo, até alcançar o fim da fila.
- **Fim da fila**: espera de pelo menos uma hora. Cada empresa tem um
  intervalo mínimo, uma hora por padrão, que a liberação pode aumentar até
  24 horas quando a empresa tem outros consumidores da distribuição (ERP,
  contador, outro integrador).
- **656**: a captura para em atenção, gera alerta e não tenta de novo
  sozinha. A retomada é manual, depois de pelo menos uma hora.
- **Recuperação** por `consNSU`: no máximo uma consulta por hora.
- **Resultado incerto, integridade e lacunas** seguem a tabela existente,
  sem editar NSU nem antecipar a janela.

O agendamento é por stream e não liga os crons gerais do site, que
continuam com `FNFE_CRONS=off` até decisão própria.

### 5. O que permanece

- Um único responsável interno por CNPJ, ambiente e serviço, entre
  organizações e projetos (`STREAM_CONFLICT`).
- O alvo dedicado da #50 e o runner manual continuam para provas; a política
  `FNFE_FISCAL_PROOF` não é usada no site.
- Certificados, senhas e chaves ficam no cofre ou no ambiente apropriado,
  fora de código, logs e fixtures.
- Retenção e guarda dos documentos reais seguem
  [RETENTION.md](../plataforma/RETENTION.md).

## Divergências com regras atuais

Esta decisão altera, para a captura de NF-e, regras escritas antes dela. A
mudança de cada documento entra na PR que implementar a parte
correspondente:

- **AGENTS.md, regra 5**: "O perfil hospedado é sandbox, com transporte
  fiscal desativado e crons desligados". Passa a valer para tudo, exceto a
  captura fiscal das empresas liberadas.
- **ADR 0004, emenda de 21/10/2026**: "O sandbox hospedado atende várias
  organizações e não vira produção por configuração". Continua valendo para
  a emissão. Para a captura, o site atende `production` por liberação de
  empresa (§2), e não por configuração do deployment.
- **CAPTURE.md**: "A instalação hospedada continua com
  `FISCAL_ENV=disabled`" e o painel restrito ao sandbox.
- **`requirePlatformEnvironment`**: o perfil `installation` exige
  `FISCAL_ENV=disabled`, e `PRODUCT_ENV` é um valor único do deployment.

## Fases

1. Esta ADR e a evidência de 22/10.
2. Ambiente por pedido no backend, com testes de isolamento entre `sandbox`
   e `production` em cada entrada (console, API, SDK, workers e webhooks).
3. Liberação por empresa: tabela, função interna, workflows de ligar e de
   emergência, corte geral e intervalo mínimo.
4. Transporte real e agendamento no site, com o tratamento do 656 e alertas.
5. Seletor no console e atualização de CAPTURE.md, AGENTS.md, ISSUANCE.md e
   dos runbooks.
6. Primeira empresa liberada, com evidência em produção no site.

## Consequências

- O site passa a guardar documentos fiscais reais de clientes. Vazamento
  entre ambientes vira falha de segurança, e não só de produto; os testes da
  fase 2 são requisito de lançamento.
- A chave de deploy do site, que já existe no GitHub para publicar, passa a
  servir também os workflows de liberação. Valem os mesmos requisitos da
  ADR 0004: environments limitados à branch padrão protegida, revisão
  obrigatória na `main` e `CODEOWNERS` em `.github/workflows`.
- Consultas concorrentes de outros sistemas ao mesmo CNPJ podem gerar 656,
  que bloqueia a distribuição para todos, inclusive para o contador da
  empresa. O intervalo mínimo e a parada sem nova tentativa reduzem esse
  risco, mas não o eliminam.
- Uma empresa sem consulta por 60 dias pode ter a geração de NSU suspensa
  pela fonte; a consulta automática evita isso enquanto a liberação estiver
  ligada.

## Nota de 23/10/2026: a `main` sem proteção e o `CODEOWNERS` sem efeito

Registrada pelo mantenedor na #424. Não muda a decisão; expõe uma
divergência entre ela e o repositório.

As Consequências exigem environments limitados à branch padrão protegida,
revisão obrigatória na `main` e `CODEOWNERS` em `.github/workflows`. A
organização `freecorps` está no plano **Free** do GitHub, e o repositório é
privado. Em 23/10/2026, `gh api repos/freecorps/freecorpsNFE/branches/main/protection`
e `gh api repos/freecorps/freecorpsNFE/rulesets` responderam 403, "Upgrade to
GitHub Pro or make this repository public to enable this feature". Sem
proteção de branch nem ruleset:

- o `CODEOWNERS` só pede a revisão dos donos; não impede o merge sem ela;
- nenhum check do CI é obrigatório: uma PR mescla com o CI vermelho;
- o push na `main` publica o site (`deploy.yml`), inclusive os arquivos que
  abrem o transporte fiscal.

Os revisores obrigatórios dos environments também faltam, como a emenda de
22/10/2026 já registra. Por isso a parada geral da #424 religa por workflow
sem aprovação, como o desbloqueio; a ADR 0004, §8 pediria a aprovação de
outra pessoa.

O que já existe. O `CODEOWNERS` cobre os arquivos que abrem o transporte do
site (`lib/siteCapture.ts`, `lib/fiscalCaptureRelease.ts`,
`lib/environmentAccess.ts`, `captureProcessing.ts`, `captureWorker.ts`,
`captures.ts`, `captureRelease.ts`, `certificateUse.ts`, os workflows e
`deploy/issuance-gate.json`). `scripts/capture-release.test.ts` falha se um
deles sair da lista ou se um caminho da lista deixar de existir. Isso mantém
a lista correta, mas não obriga ninguém a revisar.

Compensação proposta, para decisão dos sócios:

1. **Assinar o GitHub Team** para a organização, com dois membros, e ligar
   na `main` a proteção com revisão obrigatória de code owner e os checks do
   CI. É o que faz valer a revisão que esta ADR e a ADR 0004 pedem para o
   código. Os revisores obrigatórios de environment em repositório privado,
   pela documentação do GitHub, ficam no Enterprise; com o Team, a aprovação
   no run continua indisponível, e a emenda de 22/10/2026 continua valendo.
   Verificação: a chamada de proteção acima passa a responder 200, com
   `required_pull_request_reviews.require_code_owner_reviews: true`.
2. **Enquanto isso, um gate na publicação.** Antes de `deploy-platform.mjs`
   publicar, um passo lista os commits entre o SHA publicado (`/health.sha`)
   e o novo, e, para cada commit que toque um caminho do `CODEOWNERS`, exige
   pela API do GitHub uma PR mesclada com revisão `APPROVED` de um code owner
   que não seja o autor. Sem isso, nada é publicado e o run falha com o
   commit e o caminho. Verificação: o log do `deploy.yml` nomeia PR e
   aprovador de cada commit protegido; testes com dados sintéticos da API. O
   limite é conhecido: o gate roda na versão do workflow que chegou à
   `main`, então um commit sem revisão que altere o próprio gate o desliga.
   Ele reduz o risco, não o elimina; por isso a opção 1 vem primeiro.

Nenhuma das duas foi implementada nesta nota.

> Nota de 03/11/2026: o código passou ao repositório público, e as chamadas
> acima respondem 200. A `main` tem um ruleset, sem bypass, que exige PR, os
> checks `Validate` e `Public scan` e conversas resolvidas, e recusa
> force-push e exclusão. Ele exige 0 aprovações, então o `CODEOWNERS` ainda
> não impede o merge sem revisão. `nfse-production-gate` e
> `nfse-production-release` têm revisores obrigatórios com _Prevent
> self-review_; os environments da captura não têm, e todos aceitam só a
> `main`. O estado conferido está em
> [emissao-nfse.md](../operacao/emissao-nfse.md#proteções-do-github).

## Adendo de 23/10/2026: lacunas, recuperação em lote e perda aceita

Registrado pelo mantenedor na #419. Não reescreve a decisão; muda dois
pontos do §4 e da tabela da captura, pelos motivos abaixo.

**Divergência 1, §4: "Recuperação por `consNSU`: no máximo uma consulta por
hora".** A NT 2014.002 v1.40 limita `consNSU` e `consChNFe` somados a 20
consultas por hora (§3.11.4.2) e só manda esperar uma hora depois de um 137
ou do fim da fila em `distNSU` (§3.5, §3.11.4.1) e depois de um 656. Uma
consulta por hora não vinha da fonte, e uma lacuna de algumas centenas de NSU
levava dias. A recuperação passa a encadear `consNSU` um segundo depois do
outro, até 6 por stream em qualquer hora deslizante, um terço do limite da
NT, porque a NT bloqueia o CNPJ (não só o stream) e os outros sistemas da
empresa somam a mesma cota; a NT não diz se a hora é cheia ou deslizante, e
a deslizante nunca passa de 6 em hora nenhuma do relógio. Depois de um 656
do stream, o teto cai para 3 por hora durante 24 h, registrado em
`captureAudit` como `recovery_backoff`. A NT não recomenda ritmo, e o
`distNSU` não entra nesse limite (§3.11.4.1 tem regras próprias). Ela espera
só quando esse orçamento, o teto do site ou a fonte pedem.

**Divergência 2, §4 e CAPTURE.md: "lacunas seguem a tabela existente, sem
editar NSU", e "não há comando para pular documento nem editar o cursor".**
Uma captura parada mais de 90 dias volta com uma lacuna que a fonte não tem
mais (§3, §3.5 e §3.6: 90 dias desde a recepção; o 137 do `consNSU` é NSU a
desconsiderar). Sem saída, ela ficava presa para sempre. Passa a existir uma
única ação que move o checkpoint sem documento recebido, "Aceitar a perda e
continuar": só no console, só Proprietário ou Administrador, só depois de a
recuperação localizar o limite do trecho perdido, com a confirmação do
intervalo e da versão do stream, e com o registro `history_limited` de quem,
quando e qual intervalo. Ela não vale para integridade, não apaga evidência e
não existe na API: uma perda fiscal é decisão de uma pessoa com papel, não de
uma chave.

O restante do §4 continua: 656 em atenção sem nova tentativa, fim da fila
com o intervalo da empresa, agendamento por stream sem cron. Detalhes em
[CAPTURE.md](../plataforma/CAPTURE.md#lacunas-e-histórico-limitado-419).

### Situação em 26/10/2026

> Dois pontos da Divergência 2 acima mudaram pela
> [ADR 0008](0008-perda-fiscal-em-captura-de-integracao.md), aceita em
> 26/10/2026. "Só Proprietário ou Administrador" passou a ser só o
> Proprietário, com motivo obrigatório gravado no `history_limited`, em toda
> captura. E a ação vale também na captura ativada por uma integração, ainda
> só no console: a captura continua da integração, e ela recebe o evento
> `connection.history_limited`. A ação continua fora da API, pelo mesmo
> motivo. O adendo acima registra a decisão de 23/10/2026 e não foi
> reescrito.

## Aceite de 26/10/2026

Registrado pelo dono do projeto na #430. A decisão acima
não muda; esta seção diz em que estado ela foi aceita.

**As seis fases estão cumpridas.** A fase 6 tem
recibo lido do deployment:
liberação pelo console, quatro consultas `138` do NSU 0 ao 2551, 184
envelopes com hash, 69 documentos e a nota indicada pela empresa conferida
pela chave. A tabela fase a fase, com os PRs, está nesse recibo. Desde
23/10 o site consulta a mesma empresa sozinho, a cada 12 horas, sem 656.

**Ressalvas aceitas com a decisão:**

- **Governança.** As Consequências pedem a `main` protegida, revisão
  obrigatória e `CODEOWNERS` com efeito, e a nota de 23/10/2026 mostra que o
  plano atual do GitHub não oferece nada disso. A decisão foi aceita sem esse
  requisito cumprido. A compensação escolhida em 26/10/2026 está em
  [Decisões da #424](#decisões-da-424-em-26102026). A emenda de 22/10/2026
  continua: os workflows de emergência e de desbloqueio rodam sem aprovação
  no run.
- **Forma do seletor.** O §1 descreve um seletor "Sandbox" / "Fiscal". Até
  02/11/2026, o console teve abas "Sandbox" / "Produção" por tela e um selo
  que seguia a página (#451). Desde então, tem o seletor único do §1, na
  lateral, com o nome "Produção" no lugar de "Fiscal", escolhido pelo dono do
  projeto ([frontend.md](../desenvolvimento/frontend.md#shell-paleta-e-menu)). O comportamento pedido, ver e operar um
  ambiente por vez sem mudar o ambiente de nenhum registro, é o mesmo.
- **Caminhos sem prova real.** O 656, a recuperação de lacuna e o alerta por
  e-mail estão provados com transporte simulado, não em produção no site.

O aceite da #50, que usa a captura no site para a nota de chave conhecida, é
do mesmo dia e está na [matriz de aceite](../v1.0/ACCEPTANCE.md).

## Decisões da #424 em 26/10/2026

Registradas pelo dono do projeto. Fecham as duas pendências
de governança da nota de 23/10/2026.

1. **Compensação: o gate na publicação (opção 2).** O `deploy.yml` não
   publica um commit que toque um caminho do `CODEOWNERS` sem a aprovação de
   outro dono (`scripts/lib/owner-review.mjs`). Vale a aprovação `APPROVED`
   numa PR mesclada na `main`, no último commit dela, por um dono do caminho
   que não seja o autor da PR nem do commit. Vale também o `workflow_dispatch`
   do outro dono, que aprova o SHA inteiro e é a saída para um commit que
   entrou sem PR aprovada. O GitHub Team (opção 1) não foi assinado. O limite
   da opção 2 continua: um commit sem revisão que altere o próprio gate o
   desliga na publicação seguinte, e ele não impede o merge, só a
   publicação. Um workflow alterado também passa a valer no merge, sem
   publicação.
2. **Passo 8 do ensaio, dispensado.** O repositório tem só duas contas, as
   duas em `authorizedActors`. Não há ator real fora da lista para disparar
   os workflows. A recusa `ACTOR_NOT_AUTHORIZED` fica provada pelo teste de
   `scripts/capture-release.test.ts` e pelo
   ensaio local de 25/10. O
   passo volta quando uma terceira pessoa tiver escrita no repositório.

## Nota de 26/10/2026: um dono só no gate da publicação

Registrada por decisão do dono do projeto, no mesmo dia: a aprovação do
`CODEOWNERS` depende só da dele, sem o outro sócio. Vale até ele decidir outra coisa. A decisão 1 acima continua, com
esta mudança:

- O `.github/CODEOWNERS` lista só o dono do projeto; o outro sócio deixa de
  ser dono e aprovador do gate da publicação.
- Os commits são feitos com a identidade Git do dono do projeto, inclusive os
  dos agentes, e o gate exigia um dono que não fosse o autor. Com um dono só,
  nenhuma publicação passaria. Por isso o `workflow_dispatch` do
  `Deploy production` por um dono aprova o SHA inteiro, inclusive os commits
  de que ele é autor: o dispatch explícito é o passo humano de aprovação,
  e só vale quando quem dispara é quem disparou a tentativa, não quem repete
  o run de outra pessoa.
- A aprovação por dispatch quer dizer "um dispatch feito com as credenciais
  do GitHub do dono do projeto", não que ele viu a mudança. Os agentes rodam
  o `gh` com a conta dele, e um dispatch deles valeria como a aprovação dele;
  por isso a skill `manager` proíbe que um agente dispare o
  `Deploy production` ou aprove (`gh pr review --approve`) uma PR que toque
  um caminho do `CODEOWNERS`: a aprovação do agente também valeria como a
  dele. Essa confiança no uso da conta é o que resta da
  revisão por outra pessoa.
- Por PR ou por dispatch, só aprova quem é dono do caminho em cada versão do
  `CODEOWNERS` que o protege, a publicada e a nova. Ninguém se aprova
  pondo-se como dono no próprio commit, e o outro sócio deixa de aprovar já na
  publicação que traz esta troca. Trocar o dono de um caminho numa
  publicação só a bloqueia; a troca se faz em duas, somando antes o novo
  dono. Com o `CODEOWNERS` da revisão publicada ilegível, o gate recusa.
- Um push na `main` continua sem aprovar nada: um commit que toque um caminho
  do `CODEOWNERS` fica na `main` sem ir para a produção até o dispatch do
  dono. A PR aprovada por um dono que não seja o autor continua aceita; com
  um dono só, ela não ocorre.

A mudança tira a segunda pessoa da publicação. A revisão deixa de ser de
outra pessoa e passa a ser o dispatch deliberado do dono, como ele decidiu.
Não muda o gate da emissão NFS-e de produção (ADR 0004, §8), cujos
`authorizedActors` e environment continuam pedindo outra pessoa, nem a
custódia do backup externo.

Limites conhecidos, anteriores a esta nota e não alterados por ela: com a
revisão publicada desconhecida, o gate lê só o `CODEOWNERS` novo e o dispatch
de um dono dele publica sem conferir commit a commit; o
`operation: bootstrap` não passa pelo gate
([#525](https://github.com/freecorps/freecorpsNFE-arquivo/issues/525)); e o
`--operator`, rodado localmente com as credenciais de produção, também não.

Atualização de 26/10/2026
([#525](https://github.com/freecorps/freecorpsNFE-arquivo/issues/525)): o
`operation: bootstrap` deixou de ser um desses limites. O preflight do
`bootstrap` roda o mesmo gate do `release`, com a mesma regra do dispatch, e
o `bootstrap` só vale numa instalação que ainda aguarda a prova de login,
sem o recibo `authBootstrap`. Concluída a instalação, só o `release`
publica. Um novo `bootstrap`, depois de um novo reset, exige antes um novo
registro de instalação no `deploy/`, caminho do `CODEOWNERS`. Com a revisão
publicada desconhecida, como depois de um reset, só o dispatch de um dono
publica. Os dois outros limites continuam: o dispatch de um dono com a
revisão publicada desconhecida e o `--operator`.

## Situação em 26/10/2026: processamento depois da retirada (#420, #499)

Registrada para expor uma divergência, sem reescrever a decisão acima. O §2
diz que, ao desligar, "sobra a leitura do que foi capturado". Duas mudanças
foram além disso em Produção do site:

- A [#420](https://github.com/freecorps/freecorpsNFE-arquivo/issues/420) manteve,
  depois da retirada, o processamento automático dos envelopes que a captura
  já tinha recebido (`capture-processing` em
  `platform/convex/lib/environmentAccess.ts`): sem ele, o que estava atrás do
  checkpoint ficaria escondido para sempre. Nenhuma consulta à fonte, nenhum
  certificado.
- A [#499](https://github.com/freecorps/freecorpsNFE-arquivo/issues/499) acrescenta
  uma ação de pessoa no mesmo propósito: owner, admin ou operator pede no
  console "Reprocessar recusas técnicas" (`documents.reprocess_refusals`),
  que `environmentPurpose` confere como `capture-processing`. Com a liberação
  retirada, uma pessoa ainda pode **iniciar** o reprocessamento dos originais
  já guardados da empresa em Produção, que viram documentos e podem gerar
  `document.event_received`. Continua sem consultar a fonte nem abrir o
  cofre, e nunca vale para uma empresa que nunca foi liberada.

A decisão sobre manter isso, ou restringir o pedido a enquanto a liberação
vale, é do dono do projeto. O comentário de `EnvironmentPurpose` em
`environmentAccess.ts` ainda descreve `capture-processing` como só a
continuação `documents.capture`; o arquivo está no `CODEOWNERS` e não foi
alterado nesta mudança.
