# Validação no navegador

## Preparação dos ensaios locais

As jornadas em `apps/console/e2e/` usam o worktree da plataforma, com Convex
anônimo local e `bun run dev` ativo. Confira `bun run worktree:status --json`;
se o setup ainda estiver em curso, use `bun run worktree:wait --timeout-ms
600000`. O procedimento está em [worktrees](../worktrees.md). O setup não
cria contas; os ensaios criam explicitamente suas contas e dados sintéticos.

Antes de abrir o navegador ou cadastrar a conta, o preflight exige URLs de
loopback e confere o nome e a credencial administrativa do backend por
consulta somente leitura. Uma sonda servida apenas pelo Vite em desenvolvimento
identifica o diretório do frontend por hash e informa os destinos Convex,
autenticação e API. Todos precisam corresponder ao worktree. Um backend
saudável sozinho não comprova que o frontend está pronto. Frontend antigo
sem essa sonda precisa ser reiniciado.

Uma trava `.convex/browser.lock` impede duas jornadas de usarem o mesmo
backend ao mesmo tempo. O benchmark de navegação participa dessa exclusão
no checkout indicado por `BENCH_ROOT`, inclusive nos modos build e external;
`--report` apenas lê resultados e dispensa a trava. A trava é independente
do dev. Se uma execução for interrompida, confira que o runner e seus
processos encerraram antes de remover a trava manualmente. Não há recuperação
automática por idade. Abas externas não participam dessa exclusão.
Depois de iniciar a jornada, o processo mantém a trava até sua saída, mesmo
que o callback já tenha terminado. Falha no preflight libera a trava adquirida
pela tentativa.

Cada jornada protegida grava `.browser-results/runs/<tentativa>/preflight.json`,
com preparação, resultado e duração, mesmo quando falha antes do lançamento
do navegador. Os relatórios de domínio existentes continuam nos caminhos
indicados por cada roteiro. Um recibo `running` ou `incomplete` não é aprovação.
O recibo de preparação não copia credenciais, respostas ou ambiente.

Os onze runners locais usam `withLocalBrowser(root, journey, callback)`, de
`scripts/lib/local-browser.mjs`. Apenas os imports e o cálculo da raiz ficam
fora do callback. Ele abrange a preparação posterior ao preflight, a aquisição
do navegador, contextos e páginas, a jornada, o diagnóstico, o fechamento e a
gravação do relatório de domínio. O callback retorna `report.result`; só o
retorno explícito `passed`, sem erro, aprova. Retorno reprovado ou ausente e
falha de finalização deixam saída não zero, preservando um código não zero
que já esteja definido. Os runners que relançavam erros continuam relançando;
os demais conservam a reprovação pelo código de saída.

`createBrowserFinalization(report)`, em `scripts/lib/browser-finalization.mjs`,
concentra a precedência de erros dos relatórios de domínio. `fail(error)`
registra o primeiro erro antes do diagnóstico; `attempt(step)` tenta uma
etapa independente e reprova o relatório se ela falhar. Cada fechamento,
fingerprint e gravação tem sua própria tentativa, sem repetir efeitos da
jornada. `throwIfFailed()` relança o primeiro erro nos runners que usam
exceção. Assim, falhas de diagnóstico, cleanup ou gravação não substituem
a causa inicial, e uma falha exclusiva de fechamento também reprova.

O helper central tenta concluir o recibo uma única vez, depois do callback,
inclusive se ele lançar uma exceção. Falha ao persistir a conclusão preserva
a exceção original, quando houver. O recibo mantém `phase: preflight` quando
a preparação falha. Depois do preflight, a conclusão usa `phase: finished`.
O hook de saída também encerra uma fase `journey` abandonada: saída zero sem
conclusão produz `incomplete`, nunca `passed`; saída não zero ou erro tardio
rebaixa um resultado aprovado para `failed`. Os hooks não suprimem exceções
do processo nem fazem cleanup assíncrono durante `exit`.

Erros de import estático ocorrem antes desse contrato. Morte forçada pode
deixar trava e recibo incompleto, e disco indisponível pode impedir a gravação
do recibo. Os relatórios de domínio mantêm seus caminhos e formatos, incluindo
os modos `--documents`, `--usage`, `--visual-only` e `--before`. Essas proteções
não substituem uma nova execução das jornadas contra o navegador e o backend.

O pacer da fundação já espera 65 segundos no início e compartilha a cadência
entre seus contextos. Ele anuncia as esperas e registra respostas 429 com
rota, fase e `Retry-After` numérico, sem repetir cadastro, OTP ou recuperação
para esconder falha. Feche apenas suas próprias abas de teste concorrentes;
o runner não controla a atividade de abas externas. As chamadas HTTP dos
roteiros têm prazo de 30 segundos, sem reenvio automático de efeitos.

Conclua builds antes do ensaio: alterações nos arquivos podem provocar HMR
durante autenticação. A fundação conserva a cobertura dos protótipos que só
existem em desenvolvimento; não equivale à prova de CSP ou da assinatura
do Worker publicado. Nenhuma dessas provas locais autoriza emissão fiscal.

## Piloto e revisão humana

O [roteiro do piloto](../v1.0/PILOT.md) reúne os pré-requisitos do candidato e do
quickstart, o registro de tempo até o primeiro documento, a revisão humana
de acessibilidade, a navegação móvel e as medições. Participante, revisor,
resultados observados e retestes precisam ser preenchidos durante a sessão.
As correções preparatórias não
substituem esse aceite. A #49 está encerrada no GitHub; o aceite humano
confirmado e a conclusão técnica das pendências
consolidam esta rodada no escopo assistido aprovado pelo mantenedor.

A sessão humana de 05/10/2026
registra os relatos do mantenedor sobre teclado, zoom, iPhone/Safari e
VoiceOver, além da inspeção pelo agente dos documentos existentes em produção.
O registro distingue os dois ambientes, a mudança de SHA durante o bloco
de validação e os resultados históricos de importação. Em 07/10, o mantenedor
confirmou a revisão humana do painel concluída com teclado, leitor de tela,
zoom e celular, sem problemas. O relato atualizado
preserva os limites dos metadados e registra sua decisão de executar o
quickstart pessoalmente e dispensar a participação do amigo. O piloto é
assistido e do mantenedor; não há convite externo pendente nesta rodada.

O quickstart local automatizado
acrescenta integração curl/SDK relatada e entrega HTTPS com recibos e SQLite
conferidos. O registro distingue os tempos de automação, a prova sintética
do SDK e a ausência de execução por integrador humano externo.

Organizações, empresas, projetos, importações e documentos já têm jornadas
implementadas. Os roteiros M0 abaixo descrevem o smoke histórico; não são
um inventário atual de funcionalidades ausentes. Use os registros por jornada
para identificar a versão exercitada, sem transportar seu aceite para um
candidato posterior.

## Transição do legado

A substituição do legado usa banco vazio e contas novas no
Better Auth. Conferir cadastro, verificação, login, acesso negado e logout
no endereço definitivo antes da abertura. O único app consumidor
identificado precisa mostrar a indisponibilidade da emissão antiga.
Os ensaios de cópia anteriores são históricos;
não há mais vínculo Clerk ou importador de histórico nesta entrega.

## Consumo e limite

`node --experimental-strip-types apps/console/e2e/imports.mjs --usage`
executa a jornada de importação real em Convex local e acrescenta assinatura
dos totais, plano assistido, 20 pedidos HTTP concorrentes pela última unidade,
mensagem de bloqueio no formulário, recusa `INTEGRATION_RECORD` ao cancelar
pelo console a reserva da chave, cancelamento pelo console de um lote criado
no console (a unidade liberada volta a ser admitida pela API), vigência vencida,
download com hash preservado, acesso direto, recarga, mobile e axe.
A mudança de plano usa credencial administrativa local; a leitura do painel
usa a sessão humana. Não publica nem contrata plano externo.

## Jornada de captura

O aceite técnico de cofre e captura confere os
recibos históricos das jornadas de certificados e distribuição. A rodada
de 30/09 repete testes técnicos, sem alegar novo ensaio de navegador ou piloto
externo. A #50 permanece em espera; M4 não tem aceite fiscal.

`node --experimental-strip-types apps/console/e2e/captures.mjs` usa Chromium e Convex local com
certificado sintético, fonte controlada e corpus compartilhado. Exercita
ativação, resposta persistida, resumo/XML no documento, API, sync manual,
pausa/retomada, recarga direta e axe/overflow desktop/mobile. A fixture pode
adiantar somente a janela sintética antes da primeira resposta; o teste
confere que os comandos públicos posteriores não a alteram.
Recibos de testes e navegador. Não é prova fiscal real.

## Jornada da tarefa pelo cadastro

`node --experimental-strip-types apps/console/e2e/task-entry.mjs` (#510) parte
da landing: "Começar no sandbox" abre o cadastro com
`?redirect=/console?tarefa=importar`, a verificação no mesmo cartão entra
sozinha, `/console` leva a tarefa a `/app?tarefa=importar`, e a primeira
organização abre o Início em `/app/<endereço>?tarefa=importar` com "Importar
XML" escolhida. Com a sessão aberta, "Criar conta" da landing leva direto ao
mesmo Início. Uma conta sintética, uma organização, sem axe.

## Jornada candidata de importação

`node --experimental-strip-types apps/console/e2e/imports.mjs` executa a rota
autenticada de importação no Convex nativo da worktree. Os
recibos da importação XML registram pacote/API/painel, sucesso
parcial, perda de resposta, refresh, retomada da mesma intenção, original
privado e histórico v1/v2. Desde a #508, a resposta perdida depois de o servidor
guardar o XML é confirmada na mesma execução, sem alerta e com um só envio; a
retomada após refresh usa um envio perdido antes do servidor, em que a linha
pede o XML de novo e "Retomar esta importação" o envia uma vez. Axe e capturas cobrem desktop e mobile.
Builds devem terminar antes da jornada para não provocar HMR durante login.
Essa prova local amplia F03; consulta documental completa e aceite humano
permanecem nas etapas de consulta de documentos e validação no navegador. A descrição M0 abaixo é o ponto de partida histórico.

A validação no navegador começou pela fundação M0: login, sessão, concessões
de acesso, diagnóstico e logout. Naquele recorte ainda não havia organizações
ou documentos no console. As jornadas implementadas estão descritas abaixo.
O aceite integral do navegador depende das jornadas M1–M4 e da revisão humana.

## Execução e identidade

`bun run validation:browser` usa Chromium e o backend real de validação.
O alvo é fixo em `scripts/lib/browser-validation.mjs`; não aceita URL de produção,
deployment key, reset de banco ou credenciais fiscais. Cada contexto tem sua
própria sessão. Logout revoga apenas essa sessão; consultas verificam a negação
com o JWT anterior. As contas sintéticas são reaproveitadas, sem alterar concessões.

No workflow da publicação de validação, a etapa de navegador roda depois do smoke de publicação e
dentro do mesmo job e grupo `validation-publication`. O próximo deploy aguarda
essa etapa terminar. Recebe somente e-mail e senha do viewer, sem chaves dos
provedores. PRs continuam sem acesso aos secrets. A guarda exige repositório,
branch, evento, checkout, SHA aprovado e recibo de publicação correspondentes.
Publicação obsoleta registra `obsolete` e não faz login. Falha de navegador deixa
o job vermelho; o recibo de publicação registra o smoke de API já realizado, e o
relatório de navegador registra separadamente o aceite funcional.

No computador do operador:

```powershell
# SHA completo em /build.json, também presente no /health do backend.
$env:VALIDATION_E2E_SHA = '<sha-publicado-de-40-caracteres>'
# Somente o caminho do arquivo privado criado conforme VALIDATION.md.
$env:VALIDATION_ACCESS_FILE = 'C:/caminho/privado/accounts-identificador.json'
node apps/console/node_modules/playwright/cli.js install chromium
bun run validation:browser
```

O arquivo deve conter os três perfis provisionados, com `created: true`, URL
correta e e-mails `@validation.invalid`. O runner registra separadamente o commit
do teste, alterações locais e SHA publicado, conferido antes e depois das jornadas.
Não interpreta código local aprovado como código já publicado.

A conta sem concessão (`none`) é um usuário comum do produto: `/console` a
leva à lista de organizações em `/app`, onde a jornada espera o título
"Organizações". Ela precisa ficar sem nenhuma organização ou com duas ou mais;
com exatamente uma, `/console` abre essa organização em `/app/<slug>` e a
revisão falha esperando a lista. Viewer e operador ficam em `/console`, no
painel M0 ("Acesso confirmado pelo servidor"). No celular, a jornada só abre a
gaveta depois que a página chegou a esse destino: navegar fecha a gaveta.

Entre sessões, há 61 segundos sem respostas de autenticação para respeitar a
janela móvel do rate limit. O navegador vai para uma página vazia após logout,
interrompendo consultas de sessão durante a espera. A revisão completa demora
cerca de seis minutos. O relatório conta códigos HTTP por endpoint conhecido,
sem URLs arbitrárias ou conteúdo das respostas.
Uma recusa de autenticação falha o cenário; o runner não repete senhas ou aumenta
limites. Execuções manuais devem evitar coincidir com outra revisão ou publicação;
se a versão mudar, o resultado não aprova o ambiente.

Para ensaiar exclusivamente uma correção de CSS antes da publicação:

```powershell
$env:VALIDATION_E2E_CANDIDATE_CSS = '1'
bun run validation:browser
Remove-Item Env:VALIDATION_E2E_CANDIDATE_CSS
```

Esse modo acrescenta `apps/console/src/ui/ui.css` à resposta CSS somente dentro
do navegador do teste. O backend e o JavaScript continuam publicados. O relatório
marca `review-candidate-css` e o SHA-256 do CSS; isso não comprova que a correção
está hospedada. CI recusa qualquer override. Para outras mudanças de frontend,
é preciso publicação de validação ou ambiente local completo da plataforma B00.

## Cobertura M0

| Verificação                                                       | Smoke no pipeline | Revisão do operador                                       |
| ----------------------------------------------------------------- | ----------------- | --------------------------------------------------------- |
| SHA UI/API antes e depois                                         | Sim               | Sim                                                       |
| "Entrar" no cabeçalho da landing, por teclado, sem overflow       | Desktop/mobile    | Desktop/mobile                                            |
| Login público, versão, noindex e ausência de overflow             | Desktop/mobile    | Desktop/mobile                                            |
| Teclado no formulário e botão de saída                            | Desktop/mobile    | Desktop/mobile                                            |
| Login, refresh, URL de diagnóstico forjada, logout e JWT revogado | Viewer            | Operador, viewer e sem acesso                             |
| Recusa direta no backend                                          | Anônimo e viewer  | Todos os perfis                                           |
| WCAG 2 A/AA e 2.1 AA com axe                                      | Login e viewer    | Login, perfis e diagnóstico                               |
| Falha de rede ao entrar                                           | Não               | Simulação identificada, sem chamada de autenticação       |
| Expiração antecipada de sessão                                    | Não               | Comando legado explícito da validação hospedada, separado |

Violações de acessibilidade sérias ou críticas bloqueiam o resultado. Achados
menores e verificações inconclusivas aparecem no relatório e exigem revisão.
As jornadas funcionais terminam antes da aplicação dessa barreira para preservar
evidência de acesso mesmo se uma cor estiver incorreta. A automação de teclado
confere controles alcançáveis e ativação; não comprova leitor de tela, qualidade
da ordem de leitura, foco visual em todos os estados ou zoom nativo.

O teste anterior `apps/console/e2e/validation.mjs` continua disponível para a
expiração antecipada da própria sessão, conforme [validacao.md](../operacao/validacao.md).
Ele exige operação manual e credencial de administração separada. Essa prova
não integra o novo smoke e não fica silenciosamente aprovada quando omitida.

## Dataset e isolamento

`apps/console/e2e/dataset.json` versiona o contrato M0 de contas, sem senhas ou
dados fiscais. Não é o seed completo solicitado pela validação no navegador. A revisão usa as contas
privadas provisionadas na validação hospedada; nenhum seed ou limpeza global roda no pipeline.

| Marco | Dataset e testes a acrescentar                                                        | Isolamento obrigatório                                                  |
| ----- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| M1    | Duas organizações, projetos, empresas, membros, troca com cache aquecido e revogação  | Recursos com run ID; seed idempotente só nos próprios registros         |
| M2    | XML completo, resumo, eventos, duplicata, erro, upload interrompido e sucesso parcial | Arquivos sintéticos privados; URL forjada negada pelo backend           |
| M3    | Chaves, revogação, webhook, indisponibilidade de fonte e quickstart                   | Coletor por run, sem destinos de consumidores                           |
| M4    | Certificado sintético e captura simulada                                              | Nenhum PFX real; consulta fiscal real continua na validação fiscal real |

O seed futuro deve retornar IDs e um manifesto de propriedade. Reexecução preserva
recursos dos demais executores. Cleanup aceita apenas IDs desse manifesto e valida
o proprietário no backend. O smoke persistente usa tenant próprio quando B02 existir;
E2E destrutivo fica em deployment/recursos descartáveis, sem chaves em PR de fork.

## Evidências e medições

Cada execução cria `.browser-results/<UUID>/report.json` e `summary.md`.
O relatório contém IDs fixos de cenário, resultado, duração, navegador, versão,
contagens de acessibilidade e medições. Não grava mensagem de exceção, HTML,
seletores, e-mail, senha, JWT, cookie ou corpo de resposta. Em falha, tenta capturar
somente a tela pública de login em contexto novo e sem sessão, mascarando campos.
Essa captura contextual não é a tela autenticada exata que falhou.

Trace, HAR, vídeo e storageState ficam desativados: podem conter credenciais,
XML e PFX. Uma futura captura de sessão exige sanitização comprovada antes de
ativar upload. CI retém os relatórios por 14 dias; arquivos locais são ignorados
pelo Git e devem ser removidos pelo operador após a revisão. Não anexar a pasta
privada de contas nem logs brutos. A política também se aplica a futuras jornadas.

São medidos DOMContentLoaded, load e bytes comprimidos de JS/CSS do host do painel
pela Resource Timing API, antes da injeção de axe. Contextos são novos, sem cache
de navegador, mas a rede e o cache de borda não são controlados. São amostras de
laboratório, não Core Web Vitals de campo, p75, orçamento aprovado ou medição do
bundle inteiro. Revisar metas e adicionar carga/LCP/INP/CLS reproduzíveis em F09.
No modo de CSS candidato, o tamanho inclui a alteração aplicada no navegador.

## Roteiro do mantenedor

URL: <https://freecorpsnfe-validation.freecorps.workers.dev/login>.
Anotar data, navegador, viewport, zoom, papel e SHA completo do `/build.json`.
Usar somente as contas sintéticas da validação hospedada, sem instalação local.

| Passo | Papel                             | Ação                                            | Resultado esperado                                                                                                      |
| ----- | --------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| M0-01 | Anônimo                           | Abrir `/console/diagnostico`                    | Solicitação de login, sem dados                                                                                         |
| M0-02 | Operador                          | Entrar, abrir Diagnóstico e atualizar a página  | Diagnóstico autorizado; persistência preservada                                                                         |
| M0-03 | Viewer                            | Entrar e digitar a URL de diagnóstico           | "Diagnóstico restrito.", sem dados e com a sessão ativa; visão geral continua disponível                                |
| M0-04 | Sem concessão                     | Entrar                                          | Conta autenticada abre Organizações, sem o painel M0; diagnóstico restrito                                              |
| M0-05 | Cada perfil                       | Sair, atualizar e usar Voltar                   | Nenhuma informação protegida reaparece                                                                                  |
| M0-06 | Anônimo                           | Navegar com Tab/Shift+Tab/Enter                 | Foco visível, ordem coerente e nenhum bloqueio                                                                          |
| M0-07 | Operador/viewer                   | Repetir a 390px e zoom nativo 200%              | Texto legível e controles utilizáveis, sem conteúdo cortado                                                             |
| M0-08 | Anônimo e viewer                  | Usar leitor de tela                             | Rótulos, títulos, erro e estado anunciados de forma compreensível                                                       |
| M1    | Membros de organizações distintas | Trocar organização, forjar URL e revogar membro | Negação na UI e backend; provas técnicas em evidence/66–68, repetir no candidato                                        |
| M2    | Importador                        | Importar lote com erro e abrir documentos       | Sucesso parcial e consulta coerentes; provas técnicas em evidence/71–72                                                 |
| M3    | Mantenedor, por decisão de 07/10  | Executar quickstart e registrar ajuda recebida  | Curl/SDK, recepção HTTPS e reenvio duplicado sem novo efeito comprovados. Participante externo dispensado nesta rodada. |
| M4    | Operador de captura               | Exercitar estados simulados                     | Provas técnicas em evidence/77–78; separar da evidência fiscal real                                                     |

Registro local obrigatório para cada jornada ou falha:

```text
Data / revisor / navegador / viewport / zoom:
SHA publicado / run automatizado:
Passo / papel:
Resultado observado:
Aprovado, reprovado ou não executado:
Bug vinculado / evidência sanitizada:
```

Nenhum resultado do implementador substitui o aceite do mantenedor ou a observação
de um integrador externo. Não marcar M1–M4 como aprovados por mock ou teste legado.

Referências: [Playwright e acessibilidade](https://playwright.dev/docs/accessibility-testing),
[capturas e máscaras](https://playwright.dev/docs/screenshots).

## Jornada de projetos e chaves

`node --experimental-strip-types apps/console/e2e/keys.mjs` exige worktree
platform local com dev ativo. Cria contas sintéticas, organizações, empresas,
projetos e chaves. Exercita UI, consulta HTTP real, rotação, revogação,
remoção/reconcessão, troca de organização, histórico e perda de acesso com
a página aberta. Inclui desktop/mobile, axe e conferência do tema.

O fingerprint compara as fontes de `apps/`, `platform/`, `packages/` e
`scripts/` entre o início e o fim; o helper de hash de API keys vive em
`platform/convex/lib/apiKeyCrypto.ts` desde a issue #270 e antes ficava em
`convex/lib/apiKeyCrypto.ts`, coberto à parte. Os recibos anteriores a 13/09/2026 não cobriam esse helper;
essa limitação histórica permanece registrada. A nova execução está na
revalidação da gestão de projetos e chaves.

O runner não grava segredo nem screenshot do formulário que o exibe. Os
recibos conservam status/requestId e contagens; capturas mostram somente
formulários sem segredo e metadados seguros. Estes resultados não substituem
aceite humano nem prova em deployment hospedado. Veja gestão de projetos e chaves.

## Operações B05

A gestão de operações fornece query/mutation humanas e REST de operações, sem nova tela.

A conferência técnica de XML e operações repetiu
corpus, persistência e recuperação; não repetiu jornadas de navegador.
Esses aceites não encerram a importação/consulta nem o piloto desta matriz.
O diagnóstico dos 429 locais permanece na prova de autenticação
antes da rodada extensa.
Sua prova de backend não aprova a jornada do importador
M2 acima. Ao integrar F03/F04, cobrir a operação em andamento, pausa, retomada,
resposta tardia e revogação com página aberta, usando as assinaturas Convex.

## Jornada de referências

`node --experimental-strip-types apps/console/e2e/references.mjs`, com dev local
platform ativo e SDK compilado, verifica importação/publicação de municípios e
NCM, HTTP/SDK, interrupção, paginação entre versões e rollback. Cria identidade
sintética e exercita pesquisa por prefixo, código inexistente, fora de vigência,
rota direta e mobile. Exige coleta prévia com `scripts/fetch-references.ts`.
Recibos e limites em evidence/75.

## Consulta cadastral

`node --experimental-strip-types apps/console/e2e/registry.mjs` exercita nove
cenários no console local: acesso direto, sugestão sem sobrescrita, atualização
com cache, confirmação seletiva, reload, stale, indisponibilidade, ausência e
formato não suportado. Inclui desktop/mobile e axe. Usa cache sintético e não
chama o provedor. Recibos e limites.

### Conferência posterior

A conferência de 30/09/2026 acrescenta inspeção
desktop pelo preview T3, com fonte/versão de municípios e NCM e cadastro CNPJ
sintético confirmado. O recibo DOM está separado das provas históricas de
axe/mobile e da consulta pública real. Não encerra o piloto humano hospedado.

## Instalação própria

O [roteiro de instalação própria](../operacao/instalacao-propria.md) alimenta o piloto de integrador externo:
instalar a partir do zero, verificar conta pelo coletor, criar organização e
empresa de demonstração, conceder projeto/chave, importar/consultar pelo
quickstart, receber evento assinado, atualizar e recuperar em destino vazio.
Registrar tempo e dificuldades sem credenciais do mantenedor.

O ensaio técnico da instalação própria executou essa cadeia por APIs públicas e conferiu
cadastro/login no navegador T3. As capturas e recibos
não substituem a revisão humana e o aceite exigidos para a entrega. O
piloto assistido da #49 foi aceito em 07/10/2026 com dispensa do participante
externo; novas provas seguem o escopo da issue e a
[ADR 0011](../adr/0011-entregas-graduais.md).

## Distribuição

O ensaio hospedado de carga/operação usa REST,
funções públicas com ator sintético e scheduler. Não altera telas nem renova
evidências de login/UX: as jornadas de consumo e suporte anteriores continuam
em `evidence/79` e `evidence/80`. Recuperação real de fonte/certificado/webhook
e revisão pública de retenção permanecem além dessa prova técnica.

A preparação de licenças não altera telas ou jornada fiscal. As provas novas
são inspeção e instalação real dos tarballs em consumidor limpo, descritas em
evidence/83. O piloto externo da validação no navegador continua separado;
a comunicação pública deve seguir a matriz em `LICENSING.md`.
