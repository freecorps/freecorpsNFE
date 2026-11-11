# Piloto acompanhado da #49

## Estado confirmado em 07/10/2026

O mantenedor confirmou que concluiu a revisão humana do painel com teclado,
leitor de tela, zoom e celular, sem problemas. Esse é o aceite humano relatado;
não é uma execução automatizada nem uma nova medição de viewport pelo agente.
O contexto informado inclui Windows/Brave 1.96.61 e iPhone 14/Safari, com
VoiceOver no relato anterior. A versão do iOS e o detalhamento por tela não
foram informados; essa limitação do registro não reabre a revisão confirmada.

O próprio mantenedor executou o quickstart assistido e dispensou a participação
do amigo. Por decisão explícita, o escopo desta rodada passa a ser o piloto
do mantenedor e a melhoria do guia com as dificuldades observadas. Não é
rotulado como piloto externo independente, e não se mantém convite pendente.
A [matriz de aceite](ACCEPTANCE.md) reflete essa decisão; a #49 foi encerrada
em 07/10.

Curl e SDK concluíram; o painel confirmou quatro entregas com HTTP 204 e o
SQLite confirmou quatro eventos, três efeitos e o documento persistido.
O relato de 07/10 contém
evidências, intervenções e limites. A conclusão técnica das pendências
comprovou o reenvio do mesmo evento com HTTP 204 e SQLite inalterado; a versão
1→2 foi atribuída à projeção fiscal, com prova local e eventos hospedados.
O publicador foi ajustado na PR #168 e publicado em `79f2d08`, com HTTPS ativo.

## Histórico da execução

Estado: revisão humana iniciada em 05/10/2026. O mantenedor informou uso do
Brave 1.96.61 e relatou funcionamento normal no primeiro trecho de teclado
e no teste orientado de zoom nativo a 200% do guia público. Também relatou
navegação normal nesse guia em iPhone 14 com Safari e nenhum problema no
teste orientado de VoiceOver. Confirmou também login e navegação pelo teclado
até a seleção de organização no computador. A versão do iOS ainda não foi
informada. O
registro da sessão preserva os
relatos e seu escopo. As demais jornadas do painel, inclusive com leitor de tela,
as larguras CSS prescritas e o piloto externo continuam pendentes. A #49 e o aceite da #51
permanecem abertos. A publicação mudou de SHA durante a sessão; os relatos
foram preservados, com revalidação do candidato pendente.
Ao iniciar o teste dentro do painel, faltava uma organização de teste.
Após a orientação de criação pelo formulário, o mantenedor confirmou que
a organização abriu. No teste orientado de navegação e zoom a 200%, relatou
lista de documentos vazia e nenhum problema até esse ponto. A empresa de
demonstração ainda precisa de confirmação; nenhum documento sintético teve
importação relatada nesta sessão.

O mantenedor informou depois que já importou XMLs em produção sem problemas
e pediu a inspeção desse ambiente. O relato foi registrado separadamente,
sem data ou SHA das importações. Após login no navegador compartilhado,
o agente confirmou sete NFS-e e três lotes existentes: um importado e dois
recusados anteriormente com `XML_NAMESPACE_UNSUPPORTED`. O
recibo sanitizado
identifica essa inspeção somente leitura, no SHA `3b6f705`, e seus limites.

Na preparação anterior, o mantenedor indicou Windows, NVDA e Chrome/Edge e
declarou que seguiria o quickstart pela primeira vez. Em 30/09/2026, adiou o
ensaio para 01/10/2026. As correções técnicas
registram essa preparação, sem resultados humanos naquela data.

Em 05/10/2026, a conferência pública para retomada
confirmou o guia, os downloads e o mesmo SHA no frontend/backend de validação.
Essa conferência foi executada pelo agente, antes do primeiro relato humano.
O mantenedor confirmou que as sessões ainda não haviam ocorrido e se
identificou como participante da revisão. Em seguida, iniciou a etapa de
teclado no Brave. Ao fim desta rodada, informou que pedirá a um amigo para
executar o quickstart. Em 07/10, dispensou esse participante e confirmou
que ele próprio era o executor, conforme o estado atual acima.

Depois, o mantenedor encaminhou um ensaio técnico local do quickstart.
O relatório declara execução automatizada com ajuda e consulta ao código,
sem integrador humano externo. Os recibos e o SQLite confirmam duas entregas
de `import.completed` e um efeito persistido; o receptor não consultou o
documento nesse fluxo. Os tempos de 5 min 38 s desde o guia e 3 min 49 s desde
o cadastro pertencem à automação. O ensaio acrescenta evidência técnica e
obstáculos para #51/#85, mas não encerra o piloto externo.

Em 07/10/2026, o mantenedor encontrou `ENOENT` ao instalar o SDK: faltava
o tarball na pasta do consumidor. O agente entregou o artefato já testado
e conferiu instalação e imports.
Essa intervenção operacional foi registrada, sem atribuir aceite ao piloto.

Na mesma preparação, `cloudflared` não foi reconhecido pelo PowerShell.
O agente entregou e verificou o executável portátil.
O mantenedor encaminhou depois o log de conexão QUIC registrada às 13:23:31 UTC.
A entrega HTTPS dessa sessão ainda precisa de comprovação.

Ainda em 07/10, o mantenedor encaminhou saídas de curl e SDK e captura das entregas.
Os exemplos concluíram com os mesmos IDs e hash do XML, e a versão documental
passou de 1 para 2. O SQLite estava vazio; o painel mostrava entregas pausadas,
zero tentativas e envio desativado. Há resultado humano assistido dos exemplos,
mas entrega HTTPS, deduplicação no receptor e piloto externo seguem pendentes.
O mantenedor confirmou `https://nfe.freecorps.com.br`; na conferência posterior,
frontend e backend informaram SHA `5b171b176c9ecbca20f0d9831a59d55b4c2ac543`.
Essa leitura não prova a estabilidade do SHA durante toda a execução anterior.

Após autorização explícita do mantenedor, o agente ativou `WEBHOOK_MODE=https`
no deployment publicado `elated-possum-295`, com
releitura e gates preservados.
O participante confirmou HTTP 204 após reenvio; a leitura local do SQLite
confirmou quatro eventos, três efeitos e o documento na versão 2 persistido.
O recibo do receptor
serviu como base para o reenvio duplicado comprovado posteriormente.
O mantenedor autorizou o merge da PR #168 mantendo o envio ativo. O publicador
passa a exigir `https` nas atualizações e o texto público acompanha essa configuração;
a primeira instalação (`bootstrap`) continua exigindo envio desativado.

## Preparar a sessão

O mantenedor entrega ao participante a URL de teste e o [quickstart público](../plataforma/PUBLIC.md),
acessível em `/docs/`. Para instalação própria, entrega também [instalacao-propria.md](../operacao/instalacao-propria.md).
Nesta rodada, o participante é o mantenedor, por decisão explícita de 07/10.
Registrar esse vínculo e a ajuda recebida. A exigência original de participante
externo foi dispensada pelo mantenedor; não descrever esta sessão como
execução externa independente ou sem ajuda prévia.
O observador anota pedidos de ajuda e intervenções, sem antecipar as instruções.

Antes da sessão, conferir `/build.json` e `/health` e registrar os SHAs completos.
Se divergirem ou mudarem durante a sessão, interromper o aceite e repetir no
candidato identificado. O build local não comprova publicação desse candidato.
No dev local, `/health` pode ter `sha: null` e não há recibo de publicação:
registrar o HEAD e hashes das fontes, mantendo explícito que o ensaio é local.
Usar uma organização de teste exclusiva, empresa de demonstração, sandbox e
XML sintético. Não compartilhar sessão, segredo ou recursos de outro executor.
O operador confere acesso, concessões e transporte do webhook antes do convite.
Se o transporte estiver desativado, registrar essa etapa como não executada.

O caminho curl exige Node e curl, sem SDK. Para TypeScript e o receptor, o
participante instala `@freecorps/freecorpsnfe-sdk` pelo npm (até 03/11/2026, `@freecorps/sdk`, publicado
em 01/11/2026 na #83);
registrar a versão instalada. O roteiro não depende de clonar o repositório. Senhas
e chaves são digitadas somente nas telas e terminal do participante, sem
gravação desses momentos.

## Observar o quickstart

Iniciar o relógio quando o participante recebe a URL e os pré-requisitos.
Registrar separadamente instalação, leitura, espera e ajuda. A referência de
15 minutos até o primeiro documento consultável não é um resultado presumido.

| Passo                      | Observar e registrar                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Entrar e escolher contexto | Conta verificada, organização, empresa de demonstração e projeto correto.                                        |
| Criar chave                | Concessões e escopos mínimos em sandbox; segredo exibido uma vez.                                                |
| Preparar exemplos          | Downloads na mesma pasta; distinção entre URL do painel e URL HTTP da API.                                       |
| Importar                   | Reserva, upload, confirmação e espera da operação; anotar o tempo até consultar o documento e seus itens.        |
| Repetir                    | Mesma intenção preserva reserva, operação e documento; conflito com conteúdo diferente não aparece como sucesso. |
| Receber evento             | Destino controlado, assinatura conferida e efeito persistido; duplicata não repete o efeito.                     |
| Recuperar erro             | Mensagem compreensível e requestId disponível, sem copiar credenciais ou XML privado para o relato.              |
| Encerrar                   | Revogar chave, desativar destino e encerrar túnel; preservar apenas evidências sanitizadas.                      |

## Revisar acessibilidade e navegação

Alvo: WCAG 2.2 AA. Axe é uma prova automática parcial. O revisor humano registra
nome e versão do navegador, sistema e tecnologia assistiva em cada combinação.
Usar as telas implementadas e os papéis das jornadas de [navegador.md](../desenvolvimento/navegador.md).

| Verificação        | Resultado esperado                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Teclado            | Tab e Shift+Tab percorrem controles em ordem compreensível; Enter ativa links; foco visível e retorno após diálogo; sem armadilha.           |
| Pular navegação    | O link leva o foco ao conteúdo; o próximo Tab segue a jornada, sem repetir todos os menus.                                                   |
| Comandos e tabelas | Blocos roláveis têm nome, foco e rolagem por setas; o usuário consegue ler o fim da linha.                                                   |
| Leitor de tela     | Títulos, rótulos, seleção de contexto, erros e mudanças assíncronas são anunciados e compreendidos.                                          |
| Zoom nativo 200%   | Texto, mensagens, menus e botões continuam utilizáveis; não substituir por CSS zoom ou escala da captura.                                    |
| 360, 768 e 1440 px | Registrar largura CSS efetiva e navegar, incluindo voltar, acesso direto, downloads e formulários; sem perda de ações ou overflow da página. |
| Celular físico     | Registrar aparelho, navegador, orientação e uso de toque; emulação desktop não comprova essa etapa.                                          |
| Movimento reduzido | Ativar no sistema e conferir transições, carregamento e foco nas jornadas.                                                                   |
| Estados            | Conferir carregamento, vazio, erro, dados, sessão expirada e perda de acesso com a página aberta.                                            |

Falha de isolamento/cache ou impedimento crítico de teclado bloqueia o aceite.
Para cada obstáculo, registrar passo mínimo de reprodução, impacto, bug/PR e
reteste no SHA corrigido. Um scan sem violações não apaga achados humanos.

## Medições

No build do candidato, executar `node scripts/console/measure-console-bundle.mjs` após
`bun run console:build`. O recibo soma JS e CSS comprimidos por arquivo com gzip
nível 9, inclusive chunks carregados sob demanda. Se essa soma couber em 250 KiB,
ela dá um limite superior para a entrada. Se exceder, medir o grafo inicial antes
de declarar falha. Fontes, HTML e downloads são separados desse orçamento.

No navegador, medir antes de injetar axe. Registrar rota, hardware, navegador,
largura CSS, cache, perfil de rede/CPU, número de amostras e SHA. Distinguir bytes
do build de transferência HTTP. No laboratório móvel, coletar carregamento,
LCP, CLS e latências das interações identificadas. Não atribuir INP de campo a
uma única interação nem calcular p75 sem amostra. Dados reais de campo dependem
de coleta própria; a sessão local não os fornece.

## Registro a preencher

Copiar para o recibo da sessão, sem marcar antecipadamente itens como aprovados:

```text
Data e duração:
Integrador / observador / revisor de acessibilidade:
URL / SHA frontend / SHA backend / SHA quickstart e tarball:
Organização de teste, identificador sanitizado:
Sistema / aparelho / navegador / leitor de tela / viewport CSS / zoom:
Passo / resultado esperado / observado:
Resultado: aprovado, reprovado ou não executado:
Tempo até primeiro documento / instalação / espera / ajuda:
Obstáculo / impacto / reprodução / bug ou PR:
Reteste: data / SHA / resultado:
Medição: rota / método / cache / rede / CPU / amostras / valores:
Evidência sanitizada / responsável / aceite humano:
```

Conservar falhas e intervenções. Não gravar senha, API key, cookies, PFX ou XML
privado. A política de artefatos temporários de [navegador.md](../desenvolvimento/navegador.md) é de 14 dias;
versionar somente o resumo e os arquivos sanitizados necessários ao aceite.
Para uma nova rodada, registrar o aceite e os obstáculos na issue da
entrega e encaminhar os de comunicação à #85. A #49 conserva o piloto
aceito em 07/10; não é necessário reabri-la para outra entrega.

## Retomar o ambiente local preparado

A worktree `t3code/piloto-integrador-49` foi preparada com perfil `platform`,
Convex local anônimo e banco vazio. Para retomar, executar na raiz dessa
worktree, com Bun 1.4.0:

```powershell
bun run dev
```

Usar o endereço impresso pelo comando. Nesta preparação ele reservou
`http://localhost:5175`, com HTTP do backend em `http://127.0.0.1:3215`.
O guia é `/docs/` e o cadastro é `/signup`. Usar conta fictícia e senha
exclusiva de teste. O coletor local fornece a verificação sem enviar e-mail:

```powershell
bun run worktree mail piloto49@development.invalid
```

O exemplo de endereço é apenas para esta sessão, não uma conta pré-criada.
Não anexar a saída do coletor ao recibo. Sandbox e transporte fiscal
desativado foram conferidos em `/health`; reconferir antes do ensaio.
Webhooks externos e teste num celular físico exigem preparação adicional:
`localhost` no celular não aponta para esta máquina. Não registrar essas
etapas como aprovadas usando apenas o preview desktop.
