# Frontend do console

Regras em vigor do console em `apps/console/src/`: stack, rotas, contexto,
dados reativos, sessão, sistema visual, estados de tela e testes. A estética
(cor, tipo, luz, movimento e voz) está em [DESIGN.md](../../DESIGN.md); este
documento cobre a implementação do console. O plano F00–F10 que deu origem a
estas regras está preservado em
planejamento-v1/frontend.md e não
descreve o estado atual.

## Stack e propriedade de estado

- SPA React com Vite+, TypeScript estrito e TanStack Router. As consultas usam
  o provider reativo do Convex (`ConvexBetterAuthProvider`); o console não
  instala TanStack Query nem mantém um segundo cache de dados privados.
- Better Auth para sessão. Consultas protegidas esperam o token Convex estar
  pronto, seguindo o estado autenticado da integração.
- CSS próprio, sem Tailwind no console: tokens em `ui/tokens.css`, componentes
  base em `ui/` ([Sistema visual](#sistema-visual)).
- Estado remoto pertence ao backend. Filtros e paginação compartilháveis ficam
  na URL; estado temporário de formulário fica no formulário.
- Não usar duas assinaturas ou caches independentes para o mesmo recurso. Para
  dados vivos, use as assinaturas Convex; polling manual não as substitui.
- Regras de negócio, limites e permissões não são reimplementados só em
  componentes. O backend informa capacidades e erros; a validação antecipada
  orienta, mas a tela sempre trata a rejeição do servidor.
- O painel usa funções Convex autenticadas; o integrador usa REST e SDK. Ambos
  seguem as mesmas permissões e regras de domínio, sem expor mutation interna.
- O código é plano: um arquivo por área em `apps/console/src` (`documents.tsx`,
  `imports.tsx`, `projects.tsx` etc.), sessão em `auth.ts`, formatação em
  `format.ts` e site público em `site/`. Importe por caminhos relativos e pelos
  pacotes `@freecorps/*`.
- A entrada do console se divide por responsabilidade: `main.tsx` só
  inicializa (CSS, tema, link de convite, token antecipado e render);
  `convex-client.ts` cria o cliente Convex; `routes.tsx` compõe a árvore de
  rotas, os loaders de consulta antecipada e o router; `session-layout.tsx`
  tem o quadro raiz, o erro de rota e o layout protegido; `login.tsx` e
  `console-home.tsx` têm o login e as páginas de `/console`. A dependência
  segue em um sentido só: `main.tsx` → `routes.tsx` → layouts e páginas; nenhum
  deles importa `main.tsx` ou `routes.tsx`.

## Rotas e navegação

### Árvore de rotas

As rotas são escritas à mão em `routes.tsx`, numa árvore só; não há árvore
gerada. Todas as páginas autenticadas (`/console/*`, `/app/*`,
`/accept-invitation` e `/account`) ficam sob um layout sem caminho, que confere
a sessão e desenha o shell uma vez; navegar troca apenas a página dentro dele.

| Rota                                                                        | Conteúdo                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `/`                                                                         | Site público                                                            |
| `/login`, `/signup`, `/verify-email`, `/forgot-password`, `/reset-password` | Entrada e recuperação de sessão                                         |
| `/accept-invitation`                                                        | Código do convite e confirmação após autenticação                       |
| `/account`                                                                  | Nome, e-mail e exclusão da conta                                        |
| `/console`                                                                  | Redirecionamento compatível; página própria do acesso de validação M0   |
| `/console/diagnostico`, `/console/componentes`, `/console/prototipo/:tela`  | Ferramentas internas; componentes e protótipo só no desenvolvimento     |
| `/app`                                                                      | Lista de organizações, criação e link para aceitar convite              |
| `/app/:organizationSlug`                                                    | Início da organização, com a tarefa em `?tarefa=`                       |
| `…/settings/members`, `…/settings/organization`                             | Membros e convites; nome, atividade e encerramento                      |
| `…/onboarding`                                                              | Primeiros passos, destino da etapa "Escolher a empresa" da importação   |
| `…/companies` e `…/companies/:companyId`                                    | Empresas; abas de cadastro, fiscal, certificado, CNPJ, captura e acesso |
| `…/documents`                                                               | Lista, filtros, detalhe e versão por parâmetros de busca                |
| `…/imports`                                                                 | Importação de XML                                                       |
| `…/imports/danfe`                                                           | Consulta de NF-e pelo DANFE no portal oficial, sem importar             |
| `…/issuances`                                                               | Emissão NFS-e em sandbox, detalhe por parâmetro de busca                |
| `…/exports`                                                                 | Exportações                                                             |
| `…/references`                                                              | Municípios e NCM                                                        |
| `…/usage`                                                                   | Uso e limites                                                           |
| `…/operations`                                                              | Operação e suporte, investigação por `?ref=`                            |
| `…/developer/:secao` e `…/developer/:secao/:projectId`                      | Integrações: `projects`, `keys`, `webhooks`, `stripe` e `quickstart`    |
| `…/developer/connect` e `…/developer/connect/:projectId`                    | Conectar meu sistema: projeto, concessões e chave em um percurso        |

Prefixo organizacional `/app/:organizationSlug`: o slug serve à navegação; o
backend resolve e valida a identidade. A URL nunca prova autorização. Não
adicione menus vazios para capacidades sem backend.

`/app/$organizationSlug` é o layout da organização (`OrganizationLayout`):
autoriza a organização uma vez por endereço e por conexão e entrega `org` e
`contextKey` à página abaixo. Cada página tem seu chunk, carregado pelo router
(`lazyRouteComponent`) junto com o layout, sem esperar
`organizations.context`. Passar o mouse ou o foco num link baixa o chunk
(`defaultPreload: "intent"`); os dados continuam nas assinaturas Convex. Os
módulos pequenos usados por mais de uma página (controles de `ui/`,
formatação, seletor de empresa, componentes de produto) saem num chunk só,
`console-shared`, definido em `apps/console/vite.config.ts`. Enquanto o código
chega, a página anterior fica por 150 ms e depois dá lugar a "Carregando a
página…" dentro do shell, por pelo menos 300 ms (`defaultPendingMs` e
`defaultPendingMinMs`). "Verificando sua sessão…" aparece só enquanto a sessão
é conferida. Voltar e avançar restauram a rolagem.

### Casa e redirecionamento

O login, a marca e "Voltar ao painel" abrem a última organização usada neste
navegador direto em `/app/<endereço>`: só o endereço público fica em
`localStorage["fnfe:console-organization"]`, o layout o confere no servidor e o
esquece quando ele não abre mais. Sem organização lembrada, vão a `/console`,
que pergunta a `organizations.landing` pela única organização da pessoa. `/app`
é o destino quando não há nenhuma ou há várias sem uma lembrada. Sair esquece a
organização lembrada.

O login volta ao destino de `?redirect=`, preenchido pela tela de sessão com o
endereço aberto, consulta incluída. `safeRedirect` (`session-handoff.ts`) só
aceita caminhos de `/app`, `/console` e `/accept-invitation` formados por
letras, números, `-` e `_` entre barras simples, com consulta restrita a
caracteres seguros e sem caracteres de controle, mesmo codificados; recusa
fragmento, `//`, `\`, `..`, esquemas e codificações de barra. O resto cai na
casa. Com a sessão já aberta, o cadastro vai direto a esse destino, como o
login.

A tarefa escolhida antes da conta (#510) usa o mesmo `?redirect=`:
`taskEntryHref(tarefa)` (`console-task.ts`) monta
`/signup?redirect=%2Fconsole%3Ftarefa%3Dimportar`, e o cadastro, a
verificação e o login devolvem a `/console?tarefa=importar`. `/console` e
`/app` aceitam só uma tarefa conhecida (`taskSearch`; o resto da consulta,
inclusive outro `redirect`, cai); a casa a leva a `/app/<endereço>?tarefa=…`
da organização que `organizations.landing` abre, ou a `/app?tarefa=…`, cuja
lista e cuja criação da primeira organização abrem o Início com ela. O valor
nunca leva id de organização ou empresa: a organização é autorizada pelo
servidor quando o Início carrega. O convite (`?redirect=/accept-invitation`)
continua com prioridade, e os endereços diretos `/app/<endereço>/…` não mudam.

Quando o transporte ainda tem um token que o servidor não reconhece
(`access.session` nulo), a tela oferece "Sair e entrar novamente" em vez de
mandar ao login, que devolveria a pessoa ao mesmo ponto; esse botão encerra o
token e abre o login com o endereço em `?redirect=`. O "Sair" do menu da conta
encerra a sessão e vai à landing (`/`). As duas saídas recarregam a página com
`location.replace`, que fecha todas as assinaturas de uma vez e não deixa o
Voltar reabrir a página protegida.

### Shell, paleta e menu

O console autenticado vive num shell único (`app-shell.tsx`): lateral com o
seletor de organização (nome e papel; troca e "Todas as organizações"), a busca
"Buscar ou ir para…" (⌘K / Ctrl+K), a navegação, o indicador único do ambiente
(com o perfil do build, quando há um, e a versão no título) e, no rodapé,
o menu da conta: tema, "Todas as organizações", "Aceitar convite" e "Sair".
Fora de uma organização, a lateral mostra a marca e os destinos gerais
(Organizações, Aceitar convite e, para operadores da plataforma, Diagnóstico).
"Aceitar convite" sai da lateral, do menu e da paleta quando
`account.capabilities.invitationEmail` é `false`. Pela mesma regra, a página
Organizações (`/app`) tira o botão "Aceitar um convite" e deixa de citar
convites no estado vazio e no cartão de criar organização. A rota
`/accept-invitation` continua aberta para os links de convites já enviados.
As telas não repetem ambiente nem nome da organização. Login, cadastro,
verificação e recuperação usam `auth-layout.tsx`: marca, perfil do build
quando há um, tema e um cartão central, com a versão no rodapé.

O indicador de ambiente (`environment-stamp.tsx`, só no shell do console)
vem do deployment, pela query pública `deployment.current`. O texto diz o
ambiente; a cor do selo só acompanha:

- "Sandbox · Sem validade fiscal", em atenção (`warning`), como sempre foi.
- "Produção fiscal · Notas com validade fiscal", em destaque (`info`), só no
  deployment de produção fiscal da emissão (ADR 0004 §8).
- "Produção · Sem emissão de NFS-e", neutro, num deployment de produção sem
  emissão, como o alvo da #50.
- "Produção", neutro e sem complemento, num build de produção enquanto o
  servidor não respondeu.
- No deployment sandbox que guarda também a captura fiscal (ADR 0007, §1), o
  selo fica abaixo do seletor de ambiente, dois botões "Sandbox" e
  "Produção". O selo diz o ambiente escolhido: "Produção · Notas reais da
  captura fiscal", em destaque (`info`, a marcação permanente do modo
  fiscal), ou o Sandbox de sempre. Com Produção escolhida, a casca inteira
  leva uma faixa `info` no topo (`data-environment` em `.app-shell`). O selo
  só muda depois de `deployment.current` responder. Nunca "Sem validade
  fiscal" sobre notas reais.

O seletor (`product-environment.tsx`) vale para o console inteiro: cada tela
mostra e opera só o ambiente escolhido, e o servidor confere o ambiente contra
a empresa em toda função. Produção aparece para uma organização com alguma
empresa que já teve a captura fiscal liberada (`deployment.environments`) e,
antes disso, só para Proprietário e Administrador enquanto o deployment
oferece a captura fiscal, porque a liberação se faz dentro de Produção; sem
nada disso, o seletor não aparece e tudo é Sandbox. Nenhum formulário escolhe
o ambiente por conta própria: a chave nova, o passo a passo de "Conectar meu
sistema", os webhooks e o pacote de exportação usam o da lateral, e o outro
ambiente exige trocar na lateral, o que leva ao início da seção. O deployment da produção
fiscal (#50) só serve Produção, sem seletor. A escolha vale por organização,
na aba do navegador (`sessionStorage`): outra aba ou o console reaberto
começa no Sandbox. Trocar de ambiente leva ao início da seção aberta
(`sectionRoot`), porque o registro, o filtro e o formulário abertos pertencem
ao ambiente anterior. Importar XML e Emissão NFS-e existem só no Sandbox
deste deployment; em Produção, dizem isso e oferecem a volta
(`sandbox-only.tsx`). Exportações e a auditoria de Operação listam pedidos e
linhas dos dois ambientes, cada um com o seu; o pacote novo é do ambiente
escolhido. O Início conta os dois ambientes.

Enquanto a query não responde, o selo usa o ambiente que o build espera
(`VITE_PRODUCT_ENV=production` só no build do console de produção fiscal; sem
ela, sandbox), para a primeira pintura do sandbox não mudar. A validade fiscal
nunca vem do build. Nenhuma query com escopo fiscal parte da dica: até
`deployment.current` responder (`confirmed` de `useDeployment`), o seletor de
empresa (`company-context.tsx`) mostra o carregamento e não entrega o escopo,
e a pré-carga de Documentos, a lista de Webhooks e o salvar de monitores em
Operação esperam. Depois, o ambiente confirmado dá o escopo das telas fiscais
(`companyScope`), de Operação e de Webhooks, e o título das páginas
("Emissões / Produção", "Documentos / Produção", o selo "Produção" em
Webhooks). No site, Produção existe por empresa, para a captura fiscal
liberada (ADR 0007): as abas de Documentos, o painel da captura, Exportações e
Webhooks dizem o ambiente pelo nome (`environmentNames`); no telefone, onde o
selo fica na gaveta, o título e as abas da página dizem o ambiente. Antes e
depois em
console-ambiente-producao
e 433.

Depois do texto do selo vem o rótulo do perfil técnico do build
(`deploymentLabel` em `environment.ts`, de `VITE_APP_ENV`): "Desenvolvimento
local" no worktree, "Instalação própria local" no servidor de
`scripts/selfhost.mjs up` e "Ambiente de validação" no console de validação,
que compila sem `VITE_APP_ENV`. O perfil `installation` não tem rótulo:
`selfhost.mjs build-hosted` compila com ele tanto o serviço hospedado da
Freecorps quanto a instalação hospedada de um operador, e nada no build
distingue os dois. O rótulo nunca afirma disponibilidade fiscal.

As telas de conta (`auth-layout.tsx`) não mostram o selo nem outro texto
fiscal: antes da sessão não há dado na tela, e a importação em sandbox, a
emissão simulada e a captura fiscal liberada por empresa (ADR 0007) dependem
do deployment e da empresa. O cabeçalho mostra só o rótulo do perfil, quando
há um, com a versão no título. O texto fiscal fica no shell, onde cada página
declara os dados que mostra (`useShownEnvironment`).

O login fala da entrada no painel. Com `account.capabilities.registration`, ele
oferece criar conta, verificar e-mail e recuperar senha, e diz que o cadastro
vale para e-mails autorizados no painel: o hospedado só atende os de
`ACCOUNT_EMAIL_RECIPIENTS` ([ACCOUNT-EMAIL.md](../plataforma/ACCOUNT-EMAIL.md)).
Sem cadastro, o
servidor não envia e-mails de conta, nem convites, e não há troca de senha
pelo administrador: o login e as telas de conta dizem que o painel não aceita
novas contas nem recupera a senha por e-mail e pedem uma conta existente.
Convite só aparece quando a pessoa chega por `/accept-invitation`.
O código do convite só chega à pessoa por e-mail, então, com
`account.capabilities.invitationEmail` em `false`, o cartão "Convidar uma
pessoa" em Membros troca o formulário pelo aviso de que o painel não envia
e-mails de conta e pede que a pessoa solicite a quem administra o painel que
ative esse envio. Enquanto a resposta não chega, o cartão mostra só o
carregamento. A lista de convites continua, com o estado vazio "Nenhum
convite nesta organização.", e o cartão "E-mail de acesso" de Minha conta
deixa de dizer que o endereço recebe os convites. O código da troca de
e-mail também só chega por e-mail: com `account.capabilities.emailChange` em
`false`, esse cartão continua mostrando o e-mail atual, mas tira os
formulários da troca e o texto sobre o código e mostra o aviso "Este painel
não troca o e-mail de acesso.", que pede a quem administra o painel que
ative o envio de e-mails de conta. Enquanto a resposta não chega, o
formulário fica como estava. A visão
de validação do início (`console-home.tsx`) só existe no console de
validação, compilado sem `VITE_APP_ENV`; nos outros perfis, `/console` leva
operadores da plataforma ao trabalho como qualquer conta. Do mesmo modo, a
página Diagnóstico só se chama "Validação" e só declara as integrações fiscais
no console de validação. O registro de persistência também só aparece lá: é
uma sonda da validação, que fora dela só o serviço hospedado cria, uma vez,
na primeira instalação, e os outros builds nem têm; então, fora da validação, a
página mostra apenas a versão do painel.

A paleta de comandos tem os destinos da lateral, as ações "Nova emissão NFS-e"
e "Importar XML" (só para quem opera documentos), as telas gerais e o tema. A
organização chega ao shell por `useShellOrganization`, chamado pelo
`OrganizationContext` depois que o servidor autorizou a organização; navegar
na mesma organização só atualiza o item marcado, e ao trocar ou sair o seletor
e o menu somem junto com o conteúdo.

O menu da organização segue o papel (`organizationDestinations` em
`organization-navigation.tsx`, a mesma lista da paleta): Início; Trabalho
fiscal (Documentos, Emissão NFS-e, Importar XML para quem opera documentos,
Exportações para quem lê documentos); Cadastro (Empresas, Municípios e NCM);
Organização (Projetos e chaves, Membros, Uso e limites, Operação e suporte e
Configurações), conforme as capacidades. O developer não vê o trabalho fiscal,
que lê só pelas integrações ([ADR 0005](../adr/0005-console-sem-projeto.md)).
Esconder o item é orientação: a rota direta mostra a mensagem de papel e o
servidor continua negando. Até 960 px, a lateral vira uma gaveta aberta por
"Abrir menu", com o foco preso enquanto aberta; Esc, tocar fora ou navegar
fecham. O item atual fica marcado, inclusive nas subseções de projetos e, para
Início, em `/onboarding`. A lateral fica ancorada à esquerda, com rolagem
própria quando a altura é pequena.

### Erros de página

Um erro de página fica no lugar da página, com o shell em volta. Só as recusas
de sessão e acesso (`UNAUTHENTICATED`, `EMAIL_UNVERIFIED`, `ACCESS_DENIED`)
mostram "Não foi possível confirmar o acesso" com "Verificar sessão
novamente"; os demais mostram "Não foi possível carregar esta página." com
"Tentar de novo", que refaz a página sem sair dela. Mudar de endereço ou de
sessão esquece o erro (`route-errors.tsx`).

### Início

O Início (`organization-home.tsx`, `consoleHome.summary`) mostra, nas empresas
que o membro acessa: a tarefa escolhida e suas etapas (abaixo); as pendências
(certificado vencido ou vencendo em até 30 dias,
"Captura fiscal (Produção)" em atenção ou sem consulta respondida há 30 dias
ou mais, pausada ou não, enquanto a liberação fiscal vale (#422), com o
motivo da atenção nas palavras do painel da captura (#432), emissões rejeitadas,
em reconciliação ou pausadas no mês, importações com falha), cada uma com link
para o registro (a captura abre `?aba=captura`); e as contagens do mês. Uma
importação com falha é um lote com algum arquivo recusado, com falha ou pausado,
contado uma vez, pela mesma regra da tela de importação (`importFileOutcome`,
#507): processamento concluído com `XML_SCHEMA_UNSUPPORTED` é XML recusado,
não documento importado. Importado, duplicado, com ressalva, não enviado e em
andamento não são pendência; um lote com recusa e outro arquivo em andamento é. Quando
alguma empresa que o membro lê tem Produção, liberada ou retirada, os
documentos recebidos aparecem separados em sandbox e Produção. Não há etapa
de projeto ou concessão. A consulta é limitada a 10 empresas, aos 100 registros
mais recentes de cada uma no mês, em cada ambiente, e às 5 importações mais recentes; ao atingir
um limite, a contagem aparece com "+". No limite, a consulta cabe com folga
nos limites de uma transação Convex
(medição da #285). O mês e o relógio vêm do
navegador. O developer vê só a tarefa de integração, sem dados fiscais.
Cada tela tem título próprio e direto.

A tarefa (#510) é uma lista fechada em `console-task.ts`, com o valor de URL em
português: `importar`, `emitir`, `capturar`, `integrar`. Vale `?tarefa=` na URL
do Início; sem ele, a última escolha deste navegador
(`localStorage["fnfe:console-task:<endereço da organização>"]`); sem ela, o
padrão do papel: `integrar` para o developer, `importar` para os demais. Valor
desconhecido é ignorado, e uma tarefa que chega pela URL passa a ser a lembrada.
Não há questionário: o Início mostra a escolha como grupo de rádios, com o
estado de cada tarefa ("Concluída", "Falta 1 etapa", "Depende de outro papel"
quando tudo o que falta está bloqueado por papel, "Indisponível neste
ambiente"), e trocar grava a escolha (e a URL, quando ela trazia `?tarefa=`). O
mesmo estado aparece como selo ao lado do título da tarefa e de cada etapa,
fora do elemento do título, para que o nome acessível seja só o título. O
developer, que só tem `integrar`, não vê a escolha. É só preferência de tela,
nunca acesso: as etapas vêm do servidor e cada função confere o acesso de novo.
`taskDestinations` dá, por tarefa, o destino da ação principal do cabeçalho:
"Importar XML" (importação da empresa com documento ou de demonstração),
"Nova emissão simulada", "Abrir captura" (`?aba=captura` da empresa) e
"Abrir integrações". Enquanto a tarefa não tem a empresa (etapa `company` não
concluída) ou, na emissão, o perfil NFS-e (etapa `profile`), a ação é a da
próxima etapa (`stepAction`, por exemplo "Abrir os primeiros passos",
"Cadastrar a empresa" ou "Configurar o perfil") ou nenhuma, nunca uma tela que
não teria como concluir. Não há ação para quem não age na tarefa, para a tarefa
indisponível no deployment nem enquanto o resumo carrega. A tarefa mostra cada
etapa: concluída com ✓; o primeiro `todo` como "Próxima etapa", com link para
onde se faz (o primeiro documento da empresa de demonstração vai à importação,
com "Importar o XML de exemplo"; certificado e perfil às abas
`?aba=certificado` e `?aba=fiscal`; autorizar e iniciar a captura, etapas
distintas, ao painel `?aba=captura`; projeto e chave às integrações); bloqueada
dizendo quem pode (papel), que falta empresa liberada ou que a Freecorps
bloqueou a captura (fale com o suporte); aguardando, esmaecida, quando depende
de outra; e a tarefa indisponível no deployment com o motivo. Concluída, a
tarefa diz isso, aponta o passo seguinte (documentos, emissões, captura ou
integrações) e recolhe as etapas em "Ver as etapas". Com mais de 10 empresas,
uma nota diz que as etapas consideram só as 10 primeiras. A emissão aparece
sempre como sandbox simulado, sem validade fiscal, na própria tarefa.

A mesma consulta devolve `tasks`, a prontidão por tarefa, calculada no
servidor e nas mesmas empresas e papéis (`lib/consoleTasks.ts`). Cada tarefa
traz `complete` e `steps`, e cada etapa traz `key`,
`state`, `companyId` e, quando bloqueada ou indisponível, `reason`. `todo` é
o que falta e o membro pode fazer agora; a tela mostra o primeiro `todo`.
`blocked` traz o motivo: `role` (o papel não cumpre a etapa), `no-company` (o
membro não alcança empresa para ela e não pode cadastrar uma), `freecorps` (a
Freecorps bloqueou a liberação da captura da empresa) ou `previous` (uma etapa
anterior de que esta depende não terminou). `unavailable` traz `deployment` (o
deployment não oferece a tarefa). Cada etapa depende das anteriores, exceto
certificado e perfil da emissão, que dependem só da empresa. A tarefa termina
quando todas as etapas terminam, menos `permission`, que diz respeito ao
membro: o viewer vê concluída a tarefa que a organização já cumpriu, com essa
etapa bloqueada por `role`. Emissão e captura escolhem uma empresa
declarada: a pronta primeiro, depois a com menos etapas bloqueadas pela
Freecorps, depois a com menos etapas abertas, e no empate a primeira.

- `import`: empresa alcançada → papel que importa (owner, admin, operator) →
  primeiro documento publicado (`completeness` a partir de 0) no ambiente base
  do deployment (o sandbox, no perfil hospedado); a NFS-e emitida pela
  plataforma, ainda sem versão publicada, e o documento de Produção não contam.
  Traz `demonstrationCompanyId`, só num
  deployment sandbox e quando o membro alcança a empresa de demonstração; fora
  do sandbox, ela não conta para a tarefa. Sem certificado, perfil ou projeto:
  a empresa de demonstração conclui a tarefa com um documento.
- `issue` (emissão sandbox simulada): empresa declarada → papel que emite →
  certificado A1 próprio e válido, só quando o transporte da empresa não é o
  simulador (`transportModeFor`) → perfil NFS-e. Certificado e perfil são de
  owner e admin. Num deployment de ambiente base produção, inclusive o da
  emissão fiscal, a tarefa vem `unavailable` com `deployment`.
- `capture`: empresa declarada → certificado A1 próprio e válido → autorizar
  (liberação da captura, owner e admin; `blocked` com `freecorps` para
  qualquer papel quando a Freecorps bloqueou a empresa) → iniciar (stream de
  Produção da organização que não está pausado; owner, admin e operator).
  Indisponível fora de um deployment sandbox com `FNFE_CAPTURE_FISCAL=enabled`,
  a mesma resposta de `captureRelease.status`. Limites conhecidos: como nessa
  consulta, a organização encerrada não aparece em `authorize` nem em `start`,
  e a parada geral da captura (`captureFiscalHalts`, #424) não aparece em
  `start`. Um stream pausado que uma integração da mesma organização iniciou
  para a empresa deixa `start` em `todo`, mas retomá-lo pelo console é recusado
  com `INTEGRATION_RECORD`; e iniciar é recusado com `STREAM_CONFLICT` quando o
  CNPJ já é capturado por outra organização.
- `integrate`: projeto ativo que o membro administra → chave válida nele;
  bloqueada por papel para operator e viewer, para quem `complete` fica sempre
  `false`, por desenho.

O developer recebe só `integrate`; as outras tarefas vêm `null`.

### Carga a frio

Abrir o console direto num endereço passa pelo HTML compartilhado com a página
pública. Nas páginas do painel, `public/theme.js` marca o documento antes do
corpo e `landing.css` esconde a página pública. Quando o navegador guarda uma
sessão Better Auth (o cookie que o plugin cross-domain mantém em
`localStorage["better-auth_cookie"]`, com `session_token` não vencido;
`session-hint.ts`), o `entry.ts` carrega `session-boot.ts` junto do `main`, e o
token Convex e o `get-session` são pedidos em paralelo enquanto o código baixa.
O `main` espera essas respostas por até 4 s (`earlyAuthWaitMs`) antes do
primeiro render e entrega o token ao provider como `initialToken`. Em `/app`,
o chunk de organizações sai junto do `main`. O cliente Convex abre a conexão
na avaliação do `main` e reutiliza o primeiro token até perto do vencimento
(`initialAuthTokenReuse`).

`access.session`, `account.profile` e, em `/app/<endereço>`,
`organizations.context` são assinados juntos, logo depois do token. A consulta
da organização usa a chave da primeira entrada do layout
(`organization-prewarm.ts`). As respostas só contam depois que o servidor
confirma o token, e o layout só mostra a organização depois da conferência da
sessão. Com sessão guardada, a espera acontece dentro da moldura do shell, sem
conta, organização ou outro dado privado; sem sessão guardada, a espera é em
tela cheia e nada é assinado antes de o transporte confirmar a sessão. A dica
não autoriza nada, e nenhuma resposta de consulta vai para o armazenamento do
navegador. Medida em
console-navegacao.

## Contexto de organização e de empresa

### Entrada de contexto

Cada entrada de contexto usa uma chave de consulta nova (`contextKey`) e exige
a resposta autorizada do servidor. A entrada é o layout da organização: uma por
endereço e por conexão. Trocar de página, seção, empresa, projeto ou filtro na
mesma organização não gera chave nova nem desmonta o layout; cada tela zera por
estado o que depende do parâmetro. Trocar de organização, perder o membership
ou desconectar desmonta formulários e consultas privadas; reconectar exige uma
consulta nova. Alterar a versão do membership desmonta as telas
administrativas.

### Contexto de empresa

As telas fiscais (importação, documentos, emissão NFS-e, municípios e NCM)
usam `company-context.tsx`. A escolha fica na URL (`?company=`) quando a rota a
tem e é lembrada por organização em
`localStorage["fnfe:console-company:<organização>"]`, só o id opaco, nunca
nomes, documentos ou segredos. Com uma única empresa disponível, ela já vem
selecionada: `consoleCompany.sole` responde a única empresa que o membro abre
na mesma ida e volta da lista, com a verificação de acesso (`findCompany`) de
`consoleCompany.context`. Uma empresa lembrada que deixou de ser acessível é
esquecida. `consoleCompany.context` resolve o seletor no servidor e devolve
`canRead`, `canWrite` e `canManage`, que orientam a tela; cada função confere o
acesso de novo. `contextKey` entra nos argumentos sem ser lido, para que cada
contexto abra uma assinatura nova.

As mensagens dizem o que falta: nenhuma empresa liberada (gestor vê os
primeiros passos; os demais, que o acesso é dado por pessoa em Empresas),
empresa da URL sem acesso ("Empresa indisponível") ou papel sem permissão, com
o papel necessário (leitura: Leitura, Operador, Administrador ou Proprietário;
escrita: Operador, Administrador ou Proprietário). Desenvolvedores são
orientados às integrações. Registros criados por uma integração mostram a
origem ("Origem: Console" ou "Integração X", de `recordOrigin`), e a tela não
oferece as escritas que o servidor recusaria (`INTEGRATION_RECORD`);
cancelar NFS-e vale para qualquer origem, e aceitar a perda de uma lacuna da
captura também (#442), só para o Proprietário e com motivo. Mensagens de cota seguem o papel
(`usageAudience`). Importação, consulta e emissão não pedem projeto; a etapa
da empresa conta como feita com a empresa em uso, venha da URL, da memória ou
por ser a única.

Na importação, a empresa de demonstração (`kind: "demonstration"`) oferece a
quem tem `canWrite` "Importar o XML de exemplo": `imports.tsx` busca o XML
sintético público (até 15 s, até 2 MiB e começando como XML) e o entrega ao
mesmo `submit` de um arquivo escolhido, sem atalho no servidor
([IMPORTS.md](../plataforma/IMPORTS.md)). A ação fica desabilitada, com o
motivo, enquanto há um lote aberto ou arquivos escolhidos. Nos primeiros
passos, a etapa do documento de uma demonstração mostra "Ir para a importação
do exemplo", que leva a `imports?company=<id>`, para quem opera documentos.

Documentos lista o ambiente escolhido na lateral. Todo link de dentro da lista
(filtros, página, documento, voltar) leva `env=`; um endereço com o outro
ambiente não troca o console sozinho: diz de qual ambiente é e oferece a
troca. Em Produção, uma empresa que nunca teve a captura fiscal diz que não
tem documentos ali. O servidor confere o ambiente em cada consulta.

Um registro aberto pela URL (`?document=`, `?issuance=`) ocupa a página:
"Voltar à lista" no lugar do título, das etapas e do seletor
(`CompanyContext` com `picker={false}` mantém as verificações), h1 do registro
e seções em h2. Componentes compartilhados de `product-components.tsx`:
`CopyButton` é o único controle de cópia, `CursorPager` o único padrão de
paginação por cursor, `useTicketDownload` o download por ticket com
"Preparando…", limite de tempo, erro por causa e nova tentativa, e `useNow`
libera um botão no horário informado pelo servidor. Evidências em
console-fluxo-dados.

## Dados reativos

### Conteúdo das versões

O conteúdo de uma versão de documento fica num blob que uma query não lê (ADR
0010, B6). O console lê esse conteúdo com `useContent` (`content.ts`), passando
a query de token e a action de `contentRead.ts` e `documentContentNode.ts`. O
token é reativo e muda com o acesso, a versão e a página, e a action roda de
novo a cada mudança. O retorno segue o contrato de `useQuery`: `undefined`
enquanto carrega e erro lançado para o error boundary. Uma resposta já lida fica
em memória pela chave de argumentos e token, até 64 entradas, e não vai para o
armazenamento do navegador. Não leia conteúdo de versão por `useQuery` nem por
polling.

### Cache de consultas

As páginas da organização leem consultas por `convex-query.tsx` (`useQuery` e
`usePaginatedQuery` de `convex-helpers/react/cache`), sob o
`OrganizationQueryCache` que o layout monta dentro da entrada autorizada e da
versão do membership. Uma página que sai deixa suas assinaturas abertas por
60 s (`QUERY_CACHE_EXPIRATION_MS`; no máximo 64 ociosas,
`QUERY_CACHE_MAX_IDLE`); voltar nesse tempo desenha a resposta atual no
primeiro quadro. A assinatura continua viva enquanto espera, então o que volta
é o estado atual do servidor. Uma lista paginada volta à primeira página, já
carregada. O cache é só memória: nada vai para localStorage, sessionStorage
ou IndexedDB. Trocar de organização, perder ou mudar o membership,
desconectar ou sair desmonta o cache e fecha todas as assinaturas na hora.

O shell, a lista de organizações, a conta e `organizations.context` ficam fora
dele, em `convex/react`. Mutations e actions não passam pelo cache; segredos de
API key e de webhook chegam só na resposta da action ou mutation que os gera,
nunca numa consulta, então o cache não guarda segredo. O padrão da auditoria
(últimos 7 dias) anda por hora, para a mesma consulta servir à volta. Prova em
`query-cache.test.tsx`. O fechamento imediato lê o registro interno de
`convex-helpers`; o que ele usa e como conferir uma atualização estão em
[patches/README.md](../../patches/README.md#cache-do-console).

### Consultas antecipadas

O `loader` da rota (na navegação e, com `defaultPreload: "intent"`, ao passar o
mouse ou focar o link) pede as primeiras consultas com `convex.prewarmQuery`
junto com o chunk: lista de empresas e empresa aberta, Uso e limites, panorama
e auditoria de Operação e suporte e, nas telas fiscais, a lista de empresas e
a confirmação da empresa da URL ou lembrada (ou `sole`). O loader só pede
dentro da organização que o layout mostra, com o escopo autorizado e a mesma
`contextKey` (`shownOrganizationScope`, só memória, limpo ao sair, trocar de
organização ou membership e desconectar). Os argumentos saem de
`page-queries.ts`, usado pela página e pelo loader, porque o cliente Convex
distingue assinaturas pelos argumentos serializados, ordem das chaves
incluída. Uma assinatura pedida e não usada fecha em 5 s, fora do cache da
organização. Documentos pede a primeira página da lista (`usePrewarm`)
enquanto o servidor confirma a empresa; uma empresa sem acesso responde só à
confirmação, e a lista nunca aparece para ela. Pedir antes não autoriza nada:
cada consulta confere o acesso no servidor. Prova em `query-cache.test.tsx` e
`navigation.test.tsx`.

## Sessão, convite e formulários de conta

O e-mail do convite traz `/accept-invitation#code=…`. O console lê o
fragmento uma vez, na abertura, para a memória (`session-handoff.ts`) e o tira
do endereço antes de qualquer outra coisa; o fragmento não vai a servidores nem
no Referer. Sem sessão, "Ir para o login" usa `?redirect=/accept-invitation`, e
cadastro e verificação mantêm esse destino. O campo "Código do convite" é de
texto visível, aceita colar com espaços e explica o formato. A pessoa confere
organização e papel antes de confirmar. O código fica só em memória, sem URL,
analytics, localStorage ou sessionStorage, e uma recarga o perde. Revogar
convite e remover membro pedem confirmação em diálogo. A caixa de e-mail local
é ferramenta interna do operador, nunca rota do painel.

Cadastro, verificação, recuperação e login usam `noValidate` com mensagens
pt-BR por campo, `aria-invalid` e foco no primeiro erro. O cadastro continua no
mesmo cartão com o código e entra sozinho depois de verificar; o e-mail passa
entre as telas em memória ou por `?email=`. As mensagens de envio não
confirmam nem negam a existência da conta
([ACCOUNT-EMAIL.md](../plataforma/ACCOUNT-EMAIL.md)). Evidência em
console-fluxo-shell.

## Sistema visual

Superfícies elevadas sobre fundo chapado: conteúdo em cartões que flutuam
pouco (anel de 1 px feito com sombra e sombra curta), botões com brilho
interno no topo que sobem 1 px no hover. Controles de 36 px com ponteiro fino e
44 px em toque ou até 640 px. Evidências e contrastes em
console-design-fundacoes.

**Tokens** (`ui/tokens.css`). Componentes novos usam só estas variáveis;
nenhuma cor solta.

- Cor semântica, em claro e escuro: `--color-bg`, `--color-surface-1`
  (cartões), `--color-surface-2` (áreas sutis), `--color-surface-float`
  (menus, diálogos), `--color-surface-hover`, `--color-surface-selected`,
  `--color-text`, `--color-text-muted`, `--color-primary-text`,
  `--color-border`, `--color-border-subtle`, `--color-border-strong` (borda de
  controle, 3:1), `--color-primary`, `--color-primary-hover`,
  `--color-on-primary`, `--color-focus` e os estados `success`, `warning`,
  `danger` e `info`, cada um com `-bg` e `-dot`; botão de perigo em
  `--color-danger-solid`.
- Elevação em três níveis: `--elevation-0` (só o anel), `--elevation-1`
  (cartão) e `--elevation-2` (flutuante). No escuro, a elevação vem da cor da
  superfície e do anel.
- Raios `--radius-sm` 8, `--radius-md` 12 e `--radius-lg` 16. Espaço
  `--space-1/2/3/4/6/8/12` (4 a 48 px). Geist 400/500/600 em seis tamanhos
  (`--text-xs` 12, `sm` 13, `md` 14, `lg` 16, `xl` 20, `2xl` 28) e Geist Mono
  (`--font-mono`, classe `ui-mono`) para chaves, CNPJ e códigos.
- Um foco: contorno de 2 px em `--color-focus`, afastado 2 px. Movimento de 120
  a 180 ms (`--duration-fast`, `--duration`, `--ease-out`), zerado com
  `prefers-reduced-motion`. A paleta de comandos abre sem animação.
- Breakpoints: 640 px (telefone: uma coluna, tabelas viram cartões), 960 px
  (a lateral vira gaveta) e 1280 px (conteúdo limitado a `--content-width`).

**Tema.** Claro, Escuro ou Sistema, por pessoa neste navegador
(`localStorage["fnfe:console-theme"]`). `public/theme.js` aplica `data-theme` e
`color-scheme` antes da primeira pintura (a CSP `script-src 'self'` não aceita
script inline); `ui/theme.ts` reaplica quando a pessoa troca, quando o sistema
muda em "Sistema" e quando outra aba troca. O escuro usa a noite da landing
([DESIGN.md](../../DESIGN.md#cor)): fundo `#09100d`, lateral `#0c1511`, cartões
`#0f1915`, texto `#e6eee8`, e o fósforo `#d4f36e` como único acento, no botão
principal, no foco e no passo ativo.

**Camadas.** Todo o CSS do console fica na camada `ui`, declarada por
`ui/tokens.css`. O início de `ui/ui.css` traz a base dos elementos sem classe
(`box-sizing`, margens de `body`, `p` e títulos, fonte herdada dos controles,
sublinhado dos links) e a escala densa da área da organização (`.app-content`,
13 px de corpo); os componentes a sobrepõem pela classe. Não há outro
vocabulário de classes: tela nova compõe os componentes de `ui/` e, quando
precisa de arranjo próprio, usa um arquivo de tela com tokens.

**Componentes** (`ui/`, exportados por `ui/index.ts`):
`Button`/`IconButton`/`buttonClass` (primary, secondary, ghost, danger e link;
sm/md/lg; `loading` desabilita e diz o que aguarda), `Card`, `Page`,
`PageHeader` (um h1 por tela), `DescriptionList`, `DataTable` (vira cartões no
telefone, com `role` explícitos), `StatusBadge` (sempre com texto), `Callout`
(info, success, warning, danger; `role` só quando responde a uma ação;
`headingLevel` quando ocupa o lugar de uma seção), `EmptyState`,
`FormField`/`Input`/`Select`/`Textarea`/`Checkbox` (com `controlProps` de
`field.tsx`), `RadioCard` (num `role="radiogroup"` com `ui-choice-group`),
`ConfirmDialog` (foco em "Cancelar", Tab preso, Esc, resto da página `inert`,
foco devolvido), `CopyButton`, `Tabs` (setas, Home e End), `TabNav` (abas como
links de rota, com `aria-current="page"`), `CursorPager`, `DisabledReason`
(motivo ao lado do botão, por `aria-describedby`; uma cópia perto de outro
controle vai com `aria-hidden` e o controle aponta o original), `Skeleton`,
`Disclosure` (`details` nativo, controlável para só consultar ao abrir),
`CodeBlock` (JSON e XML como texto, focável), `Progress`, `Menu` (menu button WAI-ARIA,
`MenuItem`, `MenuRadioItem`, `MenuGroup`) e `CommandPalette`. "Carregar mais"
das assinaturas paginadas é `More` (`load-more.tsx`).

Regras de uso: uma ação primária por área; ações destrutivas pedem
`ConfirmDialog`; estado não
depende só de cor; texto do usuário quebra (`overflow-wrap: anywhere`); números
em `tabular-nums`; nada de hover que mexa layout em toque. A referência interna
fica em `/console/componentes`, só no desenvolvimento, com os dois temas e o
seletor "Dados de exemplo / Pior caso".

Arranjos próprios ficam na camada `ui`, só com tokens: telas de gestão em
`gestao.css` (prefixo `gestao-`), telas fiscais em `fiscal.css` (prefixo
`fiscal-`) e empresas em `companies.css`. Listas com colunas usam `DataTable`
dentro de `Card flush`. Evidências em
console-design-telas-gestao,
console-design-telas-fiscais
e
console-design-telas-cadastro.

## Telas por área

**Empresa.** Abas acessíveis (`role="tablist"`, setas, Home e End), com a aba
na URL (`?aba=fiscal`): Resumo, Fiscal, Certificado, Consulta CNPJ, Captura,
Acesso e Histórico, só as que o papel enxerga; aba desconhecida ou oculta abre
o Resumo. Só o painel ativo é montado. O Resumo traz a "Situação" (consulta
cadastral do cache, certificado, perfil NFS-e e produção fiscal desligada) e o
cadastro em modo leitura; "Editar cadastro" abre o formulário e "Cancelar"
devolve o foco. Na aba Fiscal, o perfil NFS-e abre em resumo, seguido de
"Numeração da DPS". O código IBGE mostra o nome do município e pode ser
preenchido pela busca por nome, filtrada pela UF; sem a tabela, continua
editável. Os formulários usam `noValidate`, mensagem por campo
(`aria-invalid`, `aria-describedby`) e, no cadastro e no perfil, um resumo no
topo que recebe o foco. Ações destrutivas usam `ConfirmDialog`; se o botão
sumiu com a ação, o foco vai ao item anterior. Captura e consulta CNPJ ficam na
página da empresa, sem projeto; "Sincronizar" e "Atualizar consulta" ficam
desabilitados até `nextAllowedAt` e `refreshAfter`, com motivo e horário. Na
captura (#432), cada parte é um cartão do ambiente escolhido: em Produção,
"Captura fiscal (Produção)", com a liberação numa linha de resumo e o
intervalo editável no lugar, onde a captura fiscal também se libera; no
Sandbox, só "Captura de teste (Sandbox)" e, para o gestor de uma empresa que
nunca usou Produção, um aviso com "Trocar para Produção". Nada de Produção se
ativa a partir do Sandbox. O painel tem os grupos Situação, Agenda, Volume e Certificado
(`role="group"`), os textos de cada código vêm de `capture-messages.ts`, com o
que resolve a causa (`CaptureAction`), que decide se "Retomar captura" é o
botão principal, um secundário ou dá lugar a "Ver certificado"; há um botão
principal por tela, e com o editor de intervalo aberto "Salvar intervalo"
toma esse lugar; uma só região `role="status"` anuncia a mudança de situação
(antes e depois). Com a captura fiscal
desligada (desativada, suspensa pela Freecorps ou indisponível no ambiente),
só a linha da liberação explica o motivo e diz que os documentos já
recebidos continuam em Documentos › Produção; a suspensão é um único aviso
em atenção, com o que fazer. O painel abaixo mantém o selo e os dados, sem
aviso próprio (#424). O grupo Volume leva a
Documentos ("Ver documentos em Produção" e, quando há, "Ver notas só com resumo
(N)"), e "Últimas consultas", abaixo dos grupos, mostra até 10 consultas com
hora, resultado e documentos recebidos (`captures.history`); carregando, a
tabela não abre outra região de status. O cabeçalho da empresa e a lista de
Empresas mostram o selo da captura fiscal com as palavras e o tom do painel
(`captureSituation`), vindo de `companies.list` e `companies.get` (#433,
antes e depois). Pausar, transferir e
desativar a captura fiscal pedem `ConfirmDialog`;
as ações raras (transferir, receber uma transferência, detalhes técnicos)
ficam em `Disclosure` no fim; a recusa de uma ação sem diálogo aparece junto dos
botões e recebe o foco (`ActionFailure` de `product-components.tsx`), que a lê
sem um `role="alert"` a mais.
Evidências em console-fluxo-empresa.

**Cadastro de empresa.** Só owner e admin veem "Cadastrar empresa". O
formulário (`company-create.tsx`) começa pelo CNPJ, com "Consultar CNPJ" e
"Preencher manualmente"; os campos de nome e endereço aparecem pelo segundo
botão ou quando a consulta encontra o cadastro. O estado vem ao vivo de
`registry.lookupStatus`, sem polling, e cada um tem seu aviso com a saída
manual: consultando, não encontrado, fonte indisponível (que cobre a
restrição, sem revelá-la), formato não suportado, cota do plano, vencido,
limite de tentativas e resposta perdida. Há um só "Preencher manualmente" por
vez: o do aviso, quando há aviso. A consulta apagada depois de 24 horas faz a
query falhar com `ACCESS_DENIED`, que não se distingue de uma permissão
perdida; um `ErrorBoundary` mostra "Esta consulta não está mais disponível", e
outra falha só oferece nova consulta. Encontrado, o bloco "Dados consultados"
mostra razão social, situação, endereço e "Fonte: OpenCNPJ, consultado em …",
com "Usar nome" e "Usar endereço".

Cada campo mostra o valor consultado, enquanto seu campo está marcado e a
consulta vale, ou o que a pessoa digitou, mesmo vazio; não há terceiro estado.
A consulta marca só os campos sem nada digitado e nunca um endereço que falha
na validação do cadastro, caso em que anuncia que a fonte devolveu endereço
incompleto e desabilita "Usar endereço" com o motivo. Editar um campo marcado
torna o texto editado o valor digitado e o desmarca; desmarcar volta ao
digitado. Editar um subcampo do endereço consultado copia os demais, que ficam
marcados como copiados até a pessoa editá-los. Quando a consulta deixa de valer
(CNPJ trocado, consulta vencida ou apagada, outro resultado numa nova consulta,
nova consulta recusada ou sem resposta, `REGISTRY_CHANGED` ou `ACCESS_DENIED`
ao salvar), os campos marcados voltam ao digitado, com um aviso visível do
motivo e "Consultar novamente"; os subcampos copiados e não editados voltam ao
que a pessoa tinha digitado antes. Assim, texto da fonte nunca é salvo como
`declared` sem ter sido editado. Só letras e dígitos contam como troca de CNPJ:
pontuação não desfaz a consulta. O cadastro envia `registry` com os campos
marcados e a `cacheVersion` revisada. A resposta de uma consulta de outro CNPJ
é ignorada, e uma consulta descartada que volta a ser encontrada não é
anunciada nem revisada de novo. Enter no CNPJ sempre consulta; "Consultar
CNPJ" e "Consultar novamente" levam o foco ao CNPJ antes de o botão ficar
indisponível ou o aviso sair, e o foco num campo da revisão vai ao CNPJ quando
ela sai. Repetir a consulta depois de uma resposta
perdida reusa a chave de idempotência; uma consulta nova, depois de uma
resposta, usa outra. CNPJ já cadastrado mostra o link para a empresa e nenhum
botão de salvar, anunciado pela região de status; quando isso vem do salvar, o
foco vai ao link. Os dados
consultados ficam só no estado do componente, fora da URL e do armazenamento
do navegador. Uma região `role="status"` anuncia cada estado.

**Integrações.** O projeto tem abas próprias (Empresas e acesso, Chaves de API,
Webhooks, Primeira chamada), escopos agrupados por intenção e confirmação modal
para ações destrutivas ([PROJECTS.md](../plataforma/PROJECTS.md#painel-de-integrações)).
"Salvar concessão" indica por que está indisponível, a única empresa vem
pré-selecionada e "Editar acesso" abre a concessão existente. Webhooks ficam
em `…/developer/webhooks/:projeto` ([WEBHOOKS.md](../plataforma/WEBHOOKS.md)).
Evidências em console-ui-empresa-projetos.

**Emissão NFS-e.** O formulário abre com "Para onde a nota vai", explicita a
escolha do NIF do tomador estrangeiro, lê o valor na moeda e mostra junto ao
botão por que o pedido não saiu; o detalhe abre com "Situação" e o índice das
seções ([ISSUANCE.md](../plataforma/ISSUANCE.md#console),
console-ui-emissao).

**Consulta pelo DANFE.** `danfe-lookup.tsx`, aberta por "Consultar pelo DANFE"
nos cabeçalhos de Importar XML e Documentos e pela ação "Consultar NF-e pelo
DANFE" da paleta, para qualquer papel. Sem item próprio no menu: a vista
`danfe` marca Importar XML para quem importa e Documentos para quem só lê; o
link de volta segue a mesma regra (Início para o developer). Só cliente:
confere a chave com `validateAccessKey` de `packages/fiscal-core`, importado
pelo caminho relativo, mostra a chave em grupos de quatro no próprio campo e
uma mensagem por recusa (`aria-invalid`, `aria-describedby`), repetida numa
região `role="status"` a cada conferência, inclusive pelo Enter com o foco já
no campo. Com a chave válida, o título "Lido da chave" recebe o foco, com
"Copiar chave" e o link do portal oficial em nova aba
(`rel="noopener noreferrer"`). A chave não entra na
URL nem no armazenamento do navegador; a rota não tem parâmetros de busca
([IMPORTS.md](../plataforma/IMPORTS.md#consulta-pelo-danfe-296)). "Ler a
chave pela foto" é a área de arrastar de Importar XML (`fiscal-dropzone`) com
`accept="image/*"` e sem `capture`; enquanto lê, o rótulo diz "Lendo a
imagem…", o input fica `aria-disabled` e mantém o foco. O leitor
(`danfe-photo.ts`, com `zxing-wasm` e o `.wasm` em `/assets/`) entra por
`import()` só na primeira imagem; o resultado sai de `danfe-barcode.ts`, e
cada desfecho é anunciado na mesma região de status. Uma chave lida vai ao
campo e passa por "Conferir chave" com o pedido de comparação com a impressa;
várias chaves viram botões para a pessoa escolher, nunca escolhidas pela tela.
Os testes de componente substituem `danfe-photo.ts`; `danfe-photo.test.ts`
roda o leitor de verdade em Node sobre imagens sintéticas.

**Operação, uso e exportações.** Operação e suporte mostra ações em pt-BR,
nomes de ator, empresa e projeto resolvidos pelo servidor, repetições
agrupadas e referências que abrem a investigação; outras telas linkam para
`…/operations?ref=<referência>`
([OBSERVABILITY.md](../plataforma/OBSERVABILITY.md#investigação-por-link-e-leitura-da-trilha-no-console)).
Exportações confirmam exportar e revogar e acompanham o pedido até o download
([EXPORTS.md](../plataforma/EXPORTS.md#console)), com Produção já escolhida
quando a organização a tem; na auditoria, uma linha de Produção diz "Ambiente:
Produção"; a orientação de cota depende
do papel ([USAGE.md](../plataforma/USAGE.md)). Evidência em
console-fluxo-operacao.

## Estados de interface e linguagem

Toda tela de dados trata carregando, vazia, filtrada sem resultado, parcial,
sucesso, erro recuperável, erro definitivo, sem permissão, sessão expirada e
recurso removido ou revogado. Diferencie ausência de documentos de ausência de
acesso, sem revelar dados de outra organização. A consulta permite limpar
filtros mantendo a empresa na URL e distingue lista vazia de busca sem
resultados.

| Situação                      | Apresentação                                  | Ação possível                                     |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------- |
| Filtro sem resultado          | Manter filtros visíveis                       | Limpar filtros                                    |
| Importação aceita             | Mostrar operação persistida e progresso       | Sair e voltar sem perder acompanhamento           |
| XML inválido                  | Identificar arquivo e erro técnico seguro     | Corrigir ou substituir o arquivo                  |
| Schema não suportado          | Informar versão encontrada e cobertura        | Consultar cobertura; baixar original se permitido |
| Apenas resumo disponível      | Mostrar dados recebidos e motivo da limitação | Aguardar ou seguir fluxo autorizado aplicável     |
| Fonte indisponível            | Preservar último resultado com data e estado  | Aguardar próxima tentativa                        |
| Janela de consulta fiscal     | Mostrar próxima consulta permitida            | Aguardar; o botão não contorna o limite           |
| Certificado inválido/expirado | Explicar motivo e impacto                     | Substituir certificado, com permissão             |
| Limite de plano               | Mostrar consumo e operação afetada            | Ajustar plano de forma assistida                  |
| Webhook falhou                | Status, horário, tentativas e erro sanitizado | Corrigir destino, testar ou reenviar              |
| Acesso revogado               | Encerrar acesso ao contexto                   | Selecionar outra organização permitida            |

"Importado", "válido no schema", "assinatura verificada" e "autorizado pelo
fisco" são informações diferentes. Mostre a origem da situação fiscal e a data
observada; não use um único selo verde para as quatro. A UI mostra o que
aconteceu com o documento e a ação disponível, sem sugerir sucesso enquanto a
operação ou o fisco não responderam.

Datas e dinheiro seguem `format.ts`: datas fiscais não mudam com o fuso do
navegador, e valores decimais exatos chegam como texto e não viram `number`
antes de cálculos. CNPJ alfanumérico aceita letras e não usa teclado
exclusivamente numérico.

### Ações assíncronas

Formulários e botões que chamam o servidor usam `useAsyncAction`
(`async-action.ts`): a falha sempre libera o estado ocupado e deixa o motivo
para nova tentativa, e uma resposta que chega depois de a tela sair, de outra
organização entrar (o layout remonta as páginas por organização e versão da
membership) ou de uma execução mais nova não muda a tela. A mensagem de cada
erro e o efeito do sucesso ficam com a tela. Segredo de exibição única passa
por `useSecretOnce`, que o descarta ao fechar, desmontar ou sair da página.
Uma leitura que pode falhar sem derrubar a página fica num `ErrorBoundary` de
`route-errors.tsx`, com o `fallback` da tela e, quando outra consulta deve
esquecer a falha, um `resetKey`.

## Acessibilidade, desempenho e segurança

- Teclado e foco: diálogos prendem e devolvem o foco; abas usam setas, Home e
  End; erros de formulário são associados ao campo; status usa texto além de
  cor; movimento respeita `prefers-reduced-motion`.
- XML, JSON e texto de terceiros são renderizados como texto (`CodeBlock`),
  nunca como HTML executável.
- Redirecionamentos internos passam por `safeRedirect`; a CSP não aceita script
  nem estilo inline.
- Token, senha, API key, código de convite e PFX nunca vão para URL,
  analytics ou armazenamento persistente do navegador. O `localStorage` guarda
  só endereço da organização, id opaco da empresa, tema, a última aba de
  Documentos de cada empresa (`fnfe:console-documents-env:<organização>:<empresa>`,
  ids opacos e o nome do ambiente) e a tarefa do Início de cada organização
  (`fnfe:console-task:<endereço da organização>`, um dos quatro valores).
- Nenhuma lista busca todos os documentos, membros ou entregas para filtrar no
  navegador; a paginação é do servidor (cursor).
- Downloads usam ticket com autorização vigente; trocar de organização
  desmonta o que pertencia à anterior.

Metas de bundle, Web Vitals e WCAG 2.2 AA continuam como alvos do plano
histórico, não como resultados medidos.

## Testes

- Componentes e fluxos: `apps/console/src/*.test.ts(x)`, projeto `console` do
  Vitest (`vp run test:console`), com Testing Library. Cache e consultas
  antecipadas em `query-cache.test.tsx` e `navigation.test.tsx`.
- Jornadas no navegador: `apps/console/e2e/` com Playwright e
  `@axe-core/playwright`; roteiros e recibos em
  [navegador.md](navegador.md).
- Mocks servem para estados; a integração se prova com backend real de teste.
