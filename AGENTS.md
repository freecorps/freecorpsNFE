# freecorpsNFE

freecorpsNFE é a infraestrutura fiscal da Freecorps para software brasileiro.
A plataforma 1.0 importa XML de NF-e modelo 55, preserva os originais e
entrega documentos normalizados pelo console, pela API REST e pelo SDK
TypeScript. A importação de lotes NFS-e ABRASF saiu em 02/11/2026; as NFS-e
já importadas ficam só para leitura. Tudo que o usuário vê é em português do
Brasil.

A plataforma vive em `apps/console` e `platform/convex`, com pacotes em
`packages/*` e sessões Better Auth. O console e o site público são uma SPA
React com Vite+ servida por um Worker Cloudflare, que também encaminha a
autenticação. A API pública é `https://api.nfe.freecorps.com.br`, servida pelo
Worker. O índice está em [docs/README.md](docs/README.md) e o
contrato REST em [API-REFERENCE.md](docs/v1.0/API-REFERENCE.md) e
[openapi.json](docs/v1.0/openapi.json). **A emissão NFS-e existe em sandbox,
pela API REST e pelo SDK, com transporte simulado e sem validade fiscal.**
Produção fica atrás de um gate por empresa, desligado, e nenhuma nota real saiu
da plataforma ([ISSUANCE.md](docs/plataforma/ISSUANCE.md)).

A plataforma substituiu o serviço legado no mesmo endereço. O backoffice Clerk
e o motor de emissão NFS-e/NFC-e desse serviço saíram do repositório na #345 e
não fazem parte deste repositório; a documentação e o código deles ficam
no repositório arquivado, privado, e não são contrato da plataforma.

## O que o freecorpsNFE não pode perder

### 1. O servidor manda

Permissão, escopo de organização, projeto, empresa e ambiente, valores e
transições se validam no Convex. O cliente envia a intenção; o servidor carrega
o registro e confere quem pode agir sobre ele. `organizationId`, `projectId`,
`companyId` e ids de documentos são seletores, nunca prova de acesso.
Validação no formulário é feedback; a proteção fica na função que lê ou escreve
os dados: `freecorps/require-access-helper-in-convex-functions` exige um helper
de acesso antes do primeiro toque em dado em toda função pública do Convex
([lint.md](docs/desenvolvimento/lint.md)).

### 2. Retentativa não pode duplicar efeito

Importação, operações e webhooks podem ser repetidos. Preserve a deduplicação
por organização, empresa e ambiente, as chaves de idempotência por projeto e
operação, o XML original e o histórico de tentativas. Um reenvio de webhook
não pode virar outro efeito no receptor. Timeout de transporte não prova
falha: consulte e reconcilie antes de repetir.

### 3. Dinheiro e histórico fiscal exigem precisão

A plataforma trata valores fiscais como texto decimal exato, com os helpers
de `packages/fiscal-core`; não passe por ponto flutuante ao calcular, formatar
ou serializar. `freecorps/no-float-fiscal-values` reprova conversão e
aritmética de número sobre eles ([lint.md](docs/desenvolvimento/lint.md)). Documento fiscal e auditoria preservam histórico, sem apagar o
original. A guarda dos dados está em [RETENTION.md](docs/plataforma/RETENTION.md).

### 4. Pessoas, projetos e empresas têm escopos distintos

Better Auth autentica as pessoas, e o papel de cada membro na organização
define o que ela pode fazer. Login sem membership não concede acesso. API keys
pertencem a um projeto e exigem escopo, ambiente e concessão ativa da empresa.
Reutilize os helpers de acesso dos `platform/convex/lib/*Access.ts`; quais
deles conferem acesso e como marcar uma exceção estão em
[lint.md](docs/desenvolvimento/lint.md#require-access-helper-in-convex-functions). Uma chave não pode ler
dados de outra organização ou de empresa fora da sua concessão, inclusive em
downloads, respostas deduplicadas e webhooks. Cabeçalhos de proxy e IP vêm
somente do Worker, nunca do chamador.

### 5. Sandbox, homologação e produção são ambientes diferentes

O perfil hospedado é sandbox, com `FISCAL_ENV=disabled` e crons desligados; o
tipo `prod` do Convex não muda isso. A única exceção é a captura de NF-e das
empresas que a liberaram no console (ADR 0007): ela consulta a produção
fiscal só com `FNFE_CAPTURE_FISCAL=enabled` e `FNFE_CAPTURE_TRANSPORT=sefaz`
no deployment e sem a parada geral da #424 (`captureFiscalHalts`), agendada
por stream, nunca por cron. `APP_ENV=installation` não quer dizer, sozinho,
sandbox: a produção fiscal da emissão NFS-e usará o mesmo perfil, num
deployment próprio, nomeado em `deploy/issuance-production.json`, que ainda
não existe (`deployment: null`); a emissão segue só no sandbox, sem nota real.
Preserve os gates de ambiente de cada fluxo. O gate de produção da emissão
só muda nesse deployment, por workflow do GitHub: ligar com aprovação de
outra pessoa, desligar em emergência sem ela (ADR 0004, §8).
Um teste com transporte simulado prova o comportamento local; autorização
real exige evidência do fisco no ambiente correto. Certificados A1, senhas,
CSC e chaves de integração ficam no cofre ou no ambiente apropriado, fora de
código, logs e fixtures.

## Um recado do dono do projeto

Gosto de ideias ambiciosas, sistemas simples e software que parece óbvio.
Entenda a restrição real e escolha o menor modelo que torna o comportamento
correto previsível. Meça duas vezes, corte uma. Evite ampliar o escopo da tarefa
ou trocar dependências de passagem.

Documentação descritiva acompanha o código. Se uma mudança altera o contrato,
o fluxo ou a operação, atualize o documento correspondente na mesma PR.
Quando o código contrariar uma decisão aceita em `docs/adr/`, exponha a
divergência; não reescreva a decisão apenas para justificar a implementação.
As instruções e o escopo autorizado pelo dev prevalecem sobre as convenções
importadas.

Você trabalha na máquina de desenvolvimento do dev. Pode haver servidores e
setup do editor em execução. Preserve processos alheios e alterações locais.

## Um pequeno glossário

- **Você** é o agente que lê este arquivo e altera o projeto.
- **Nós / o dev** somos os mantenedores da Freecorps.
- **Usuário** é a pessoa com conta Better Auth que opera o console.
- **Organização** é o cliente contratante; membros têm papéis `owner`,
  `admin`, `developer`, `operator` ou `viewer`.
- **Projeto** é a aplicação integradora da organização, dona das API keys.
- **Empresa** é a pessoa jurídica cujos documentos a organização administra.
- **App consumidor** é o sistema que chama a API.
- **Documento fiscal** é o registro normalizado de uma NF-e ou NFS-e, com XML
  original, itens, eventos e histórico.
- **Operação** é o trabalho assíncrono aceito pela plataforma, com estado e
  tentativas próprios.
- **Outbox** é a fila persistida de notificações por webhook.
- **DPS** é a Declaração de Prestação de Serviço que a emissão NFS-e monta,
  assina e transmite ao fisco.
- **Homologação** é o ambiente de teste do fisco; na NFS-e nacional, ele
  aparece como `producao-restrita`.

## As três formas de se machucar

1. **Publicar no ambiente errado.** Leia [docs/operacao/deploy-producao.md](docs/operacao/deploy-producao.md)
   antes de publicar ou alterar o CI. Push na `main` publica
   `platform/convex` e `apps/console` sem repetir o CI da PR, por
   `scripts/deploy/deploy-platform.mjs`; bootstrap continua manual.
   `validation:console:deploy` atende só à validação.
   Confira o alvo antes de qualquer comando Convex que publique funções,
   altere variáveis ou execute uma escrita.
2. **Editar o que é gerado.** `platform/convex/_generated/` é saída da
   ferramenta. Corrija schema e funções na fonte e regenere pelo fluxo do ambiente correto. `docs/v1.0/openapi.json`,
   `docs/v1.0/API-REFERENCE.md` e a cópia pública do OpenAPI saem de
   `packages/contracts` por `bun run contracts:generate`. As rotas do console
   são escritas à mão em `apps/console/src/routes.tsx`. Não há árvore de rotas
   gerada neste projeto.
3. **Corromper acentos no PowerShell.** Use a ferramenta de edição ou leitura
   e escrita com UTF-8 explícito. O pipeline `Get-Content | Set-Content` sem
   codificação pode regravar o arquivo inteiro em ANSI no Windows PowerShell.
   Mensagens de commit e corpos de PR com acentos vão por arquivo, usando
   `-F` e `--body-file`.

## Cubra todos os caminhos

Antes de dar uma mudança de comportamento por pronta, confira os caminhos
afetados:

- **Entradas.** Console, API REST, SDK, workers de fila e execução agendada
  podem chegar ao mesmo domínio. A correção precisa valer em cada entrada
  aplicável.
- **Documentos.** A NF-e 55 importada, a NFS-e emitida e a NFS-e ABRASF
  importada antes de 02/11/2026, só para leitura, têm diferenças de payload,
  eventos e arquivos. Uma regra de um modelo não vale automaticamente para o
  outro.
- **Permissões.** Confira cada papel permitido, login sem membership, papel
  insuficiente, chave revogada, sem escopo ou sem concessão e dado de outra
  organização, projeto ou empresa. Esconder botão é apenas UX.
- **Contratos.** Mudou schema ou validator, confira as funções consumidoras,
  serializers, telas, webhooks, SDK e exemplos do contrato: `packages/contracts`
  e `bun run contracts:check`.
- **Desfechos.** Considere duplicidade, rejeição, timeout, reconciliação,
  retry, limite de uso e operação cancelada. O estado mostrado precisa
  refletir o persistido.
- **Telas.** Trate carregamento, vazio, erro e dados. Confira navegação,
  filtros e acesso direto à rota quando forem afetados.
- **Docs.** O [índice](docs/README.md) aponta a referência principal de
  cada domínio, regra e procedimento: arquitetura em `docs/ARQUITETURA.md`,
  contratos em `docs/plataforma/`, regras de desenvolvimento em
  `docs/desenvolvimento/`, procedimentos em `docs/operacao/`, decisões em
  `docs/adr/` e setup no `README.md`. Mudou o que existe ou seu limite,
  atualize [ACCEPTANCE.md](docs/v1.0/ACCEPTANCE.md).
- **Visual.** Cores, tipo, forma, luz e movimento em [DESIGN.md](DESIGN.md).
  Tela ou página nova segue esse documento.

## Ambiente de desenvolvimento

Use Bun na versão fixada em `package.json`, com `bun.lock`, e Vite+ para as
ferramentas do projeto. `vp install --frozen-lockfile` instala as dependências.
Os comandos e pré-requisitos estão no [README.md](README.md).

No Windows, o Python do sistema não enxerga o `/tmp` do Git Bash; passe
arquivos temporários por `$TEMP`. O `main` costuma estar aberto no checkout
principal, então `git switch main` falha em worktree: crie a branch a partir
de `origin/main`.

`bun run help` lista cada script com a aplicação e o ambiente que ele atinge,
a partir de `scripts/lib/commands.mjs`; script novo entra nesse catálogo.
`bun run dev` passa por `scripts/worktree/dev.mjs` e roda só em worktree: inicia Convex
local e console juntos. No checkout principal, ele recusa e aponta
`bun run worktree:create`. `vp dev` chama o comando interno do
Vite+ e pula esse roteador; use o script do projeto.

O setup do worktree gera o `.env.local` do frontend e as variáveis do backend
local. Variáveis do backend ficam no deployment Convex. `VITE_*` entra no
bundle durante o build. O runtime Node das actions não é o runtime que serve
os assets estáticos na Cloudflare.

## Worktrees

Antes de criar, iniciar, semear ou remover um worktree, leia
[docs/worktrees.md](docs/worktrees.md). Cada linha de trabalho concorrente
usa um checkout, banco Convex local, portas, dependências e processos próprios.
Use os scripts `worktree:*` para o ciclo de vida; nunca compartilhe
`node_modules` por junction ou symlink.

Os worktrees preparam só a plataforma; os scripts e a ação de `t3.json` não
pedem `--app`, e `--app legacy` é recusado. Um worktree antigo preparado para o
backoffice legado continua listável e removível, mas setup, dev e sync o
recusam sem apagar o banco em `.convex/local`.
Worktrees criados pelo editor são adotados por `bun run worktree:setup`.
Espere o setup automático terminar antes de repetir setup ou iniciar dev.
O setup é recusado no checkout principal.

Consultas e revisões somente leitura usam o checkout disponível, sem criar branch,
instalar dependências ou iniciar serviços apenas para cumprir um ritual. Para uma
entrega com alterações, siga o ciclo abaixo e o procedimento em `docs/worktrees.md`:

1. **Início.** No worktree que o editor criou, use uma branch própria a partir de
   `origin/main`, preservando a branch da tarefa se ela já existir. Prepare as
   dependências com `vp install --frozen-lockfile` quando necessário.
   `bun run worktree:status --json` informa a operação e o último setup;
   `bun run worktree:wait` aguarda sua conclusão sem repetir a preparação.
   Editar código e rodar testes, typecheck e build não exige o Convex local.
   `bun run worktree:setup` só é necessário para `bun run dev`, sync ou e2e.
2. **Entrega.** Commit, PR e acompanhamento seguem o escopo pedido pelo dev.
3. **Conclusão.** Depois do merge, rode `bun run worktree:finish` no próprio
   worktree. Ele confere que a branch está em `origin/main`, para os processos,
   libera as portas e remove os outros worktrees já integrados. O checkout
   atual sai na conclusão seguinte. Sem merge, o comando recusa e não remove nada.

Para crons, tarefas agendadas ou previews, leia a seção de crons desse mesmo
documento. O setup grava `FNFE_CRONS=off` no deployment local antes de publicar
as funções. Uma variável apenas no terminal não desliga crons do backend,
e desligar crons não cancela tarefas já agendadas. Mantenha certificados
fiscais e credenciais de integrações externas fora dos ambientes descartáveis.

## Dados de teste

Não há seed: `bun run worktree:sync` reaplica funções sem inserir nem apagar
dados. Worktrees não criam contas, organizações, empresas nem API keys
automaticamente. Cadastre uma conta fictícia em `/signup` e leia o código com
`bun run worktree:mail <e-mail>`.

Use fixtures sintéticas de `tests/fixtures/`, helpers de `tests/helpers/` e
`convex-test` para montar o estado necessário. Mantenha chamadas fiscais,
webhooks e e-mails simulados nos testes locais. Produção não é fonte de dados
para preencher um banco de teste.

## Credenciais e dados reais

O repositório é desenvolvido em público. Commits, branches, PRs, issues,
comentários, logs e artefatos do CI ficam visíveis a qualquer pessoa assim
que são criados, e apagar depois não desfaz a exposição.

Tudo o que um comando imprime vai para o contexto do agente, para o
histórico da sessão e para o provedor do modelo. Mascarar com `sed` não é
proteção: um padrão errado imprime o segredo inteiro.

- **Não leia credencial.** Não abra, liste nem filtre `~/.convex/` (nem o
  `.convex/` local), `.env.local`, `deployment.env`, `*.dpapi`, `*.pfx` ou
  `*.p12`. Use a
  ferramenta que os consome (`bunx convex`, `gh`) e, para saber se há acesso,
  rode-a e veja se ela pede login. O hook de `.claude/settings.json` recusa
  esses caminhos; ele não alcança um script que leia o arquivo por conta
  própria, então um script nunca imprime o valor.
- **Dado real fica fora do Git e da saída.** Ao ler produção, mesmo só para
  leitura, exporte para uma pasta temporária fora do repositório, imprima só
  contagens, hashes e sufixos, e apague a exportação ao terminar. Não copie
  CNPJ, nome de cliente, chave de acesso completa, valores de nota nem XML
  para documentos, testes, commits, PRs ou issues. Exemplo de teste usa
  dado fictício, gerado com dígito válido. Workflows e scripts de operação
  seguem a mesma regra no log e no artefato, e evidência restrita segue
  [EVIDENCE-STORAGE.md](docs/v1.0/EVIDENCE-STORAGE.md#evidência-restrita).
- **O que barra o vazamento nos arquivos.** O hook `pre-push`
  (`.vite-hooks/pre-push`, instalado pelo `vp install`) varre cada commit
  enviado com as regras do workflow `Public scan`: credenciais, CNPJ, CPF e
  chave de acesso reais, e-mail externo e caminho local. Push recusado é
  achado a corrigir nos commits ainda não enviados; não use `--no-verify`
  nem `VP_GIT_HOOKS=0` para passar. O `Public scan` repete a varredura no PR
  com o Gitleaks e os nomes restritos e é check obrigatório da `main`
  ([ci.md](docs/desenvolvimento/ci.md#varredura-pública)).
- **O texto do GitHub não passa por varredura.** Título e corpo de PR,
  issue, comentário e mensagem de commit ficam fora do hook e do
  `Public scan`; o secret scanning do GitHub só reconhece tokens de
  provedores. Antes de publicar, grave-os em arquivo, rode
  `node scripts/public-copy/scan-public-text.mjs <arquivos>`, que aplica as mesmas
  regras sem os nomes restritos, e releia: neles vale a mesma regra de dado
  real.
- **Se vazar, diga.** Avise o dono do projeto no mesmo turno, com o que vazou
  e onde, e peça a revogação da credencial. Não reescreva o histórico por
  conta própria.

## Verificando

- Rode a menor prova do comportamento alterado. Backend com mudança de acesso
  precisa cobrir também o caso negado e o isolamento entre organizações,
  projetos e empresas.
- Os testes ficam em projetos do Vitest por área, definidos em
  `scripts/lib/test-projects.mjs` e montados por `vite.config.ts`:
  `platform` (`tests/platform.*`, `tests/sdk.*` e `platform/`), `packages`,
  `console` (`apps/*/src/`), `tooling` (scripts, `tooling/`, worktree, validação e CI),
  `repository` (os três testes que leem a árvore inteira) e `benchmark`. Os
  poucos testes de `tests/` fora desses prefixos são
  nomeados no projeto da área; um arquivo novo sem dono reprova
  `tests/ci.testProjects.test.ts`. Durante o desenvolvimento, rode só a área
  alterada:

  | Comando                 | O que roda                                                 |
  | ----------------------- | ---------------------------------------------------------- |
  | `vp run test:<área>`    | Um projeto; repete o resultado aprovado se nada lido mudou |
  | `bun run platform:test` | `test:platform` e `test:packages`                          |
  | `test` de um workspace  | Só aquele workspace; em `platform/`, a área `platform`     |
  | `bun run test:changed`  | Só os testes alcançados pelas mudanças desde `origin/main` |
  | `vp test run <arquivo>` | Um arquivo, sem cache                                      |
  | `vp test run`           | A suíte toda, sem cache                                    |

  O Vite Task registra cada arquivo que a execução de `test:<área>` leu,
  inclusive fixtures, e só repete o resultado enquanto nenhum deles muda;
  falha nunca é repetida. `test:changed` segue o grafo de imports; mudanças em
  fixtures, configuração, scripts `.mjs`, `deploy/` e workflows rodam a suíte
  toda. Os testes resolvem os pacotes fiscais pelo código-fonte e não exigem
  `packages:build`. Com vários agentes na mesma máquina, `VITEST_MAX_WORKERS=2` (ou
  `50%`) divide os núcleos e `VITEST_TEST_TIMEOUT` amplia o limite por teste.
  A área `platform` roda sem isolamento por arquivo, e os arquivos com
  `vi.mock` vão sozinhos para `platform-isolated`; `--project platform`
  sozinho os deixa de fora. As regras para um teste novo (estado, mocks,
  relógio e bytes grandes) estão em `docs/desenvolvimento/ci.md`, Isolamento;
  `freecorps/no-wall-clock-in-tests` reprova relógio real e polling.

- Antes de concluir, rode a suíte toda sem cache: `vp test run`.
  `bun run ci:local` reproduz o grafo Validate como numa PR, com cache: repete
  as tarefas e áreas de teste cujas entradas não mudaram, aceita alterações
  locais e grava resumo e recibo por tentativa. `bun run ci:prove` exige candidato limpo
  e desliga o cache do grafo; não faça commit só para executar essa prova sem
  que commit faça parte do escopo. Use `vp check`; na plataforma,
  `bun run platform:check` confere os tipos da plataforma, dos testes e das
  ferramentas (`tsconfig.platform.json`) e do console, e `bun run build`
  compila a plataforma e o console. Alterações apenas de documentação
  pedem revisão do diff, referências e comandos descritos.
- Os testes importam de `vite-plus/test`. Cada arquivo de teste pertence a um
  único projeto; `tests/ci.testProjects.test.ts` recusa um arquivo fora de
  todos ou em dois. Um caminho novo de teste entra num único projeto em
  `scripts/lib/test-projects.mjs`, que define também a suíte do relatório do
  CI.
- Integração da plataforma fica em `tests/platform.*.test.ts`, com o schema de
  `platform/convex`, módulos carregados por `import.meta.glob` e componentes
  registrados por `platform/test-setup.ts`. Sessões Better Auth são simuladas
  com `t.withIdentity`.
- Parsing e validação de NF-e têm testes em `packages/fiscal-nfe`
  (`bun run xml:test`), e a montagem e assinatura da DPS NFS-e em
  `packages/fiscal-nfse` (`bun run nfse:test`). Nenhum desses testes comprova autorização ou emissão homologada.
- Antes de concluir, aplique
  [principle-prove-it-works](.agents/skills/principle-prove-it-works/SKILL.md)
  e informe o que verificou e o que permaneceu sem prova.

## Pull requests

- Commit, push, abertura de PR e merge seguem o escopo solicitado pelo dev.
  Trabalhe em branch própria quando for preparar uma entrega.
- Título curto e descritivo em pt-BR. Corpo começa pelo problema e explica
  o resultado, com a validação relevante.
- Use `--body-file` com parágrafos sem hard wrap em textos destinados ao
  GitHub. Preserve as quebras normais nos arquivos Markdown versionados.
- Mantenha um assunto por PR e atualize a documentação do comportamento junto
  com o código. Mudança visual inclui evidência do resultado quando aplicável.
- Ao tratar review, leia todos os comentários inline, confira cada achado no
  código atual e corrija os válidos. Explique os falsos positivos no retorno;
  publicar comentários depende do escopo autorizado.
- CI que não iniciou não é teste aprovado. Registre bloqueios de runner ou
  orçamento separadamente das falhas de código; veja `docs/desenvolvimento/ci.md`.

## Como funciona

O console assina queries do Convex e chama mutations autenticadas por Better
Auth; o Worker encaminha `/api/auth/*` ao backend. Os apps consumidores chamam
a API REST com API key, pelo Worker em `api.nfe.freecorps.com.br`, que repassa
a requisição às HTTP actions de `platform/convex/http.ts` com o IP do cliente
assinado. Mutations persistem o pedido e a operação; workers em filas
processam importação, captura, exportação e webhooks. O resultado atualiza
documentos, auditoria, consumo e notificações. A entrega de webhooks tem fila
e retentativas próprias.

Mapa para navegar:

- `apps/console/src/`: console, rotas em `routes.tsx`, inicialização em
  `main.tsx` e landing em `site/`.
- `apps/docs/`: documentação pública em `/docs` (Fumadocs, MDX em
  `content/docs/`), copiada para o build do console; regras em
  [PUBLIC.md](docs/plataforma/PUBLIC.md).
- `apps/console/worker.ts`, `auth-proxy.ts` e `api-proxy.ts`: Worker e proxies.
- `platform/convex/schema.ts` e `platform/convex/*.ts`: dados, funções, REST
  (`*Rest.ts`) e workers.
- `platform/convex/lib/`: validação, autorização, estados e políticas
  compartilhadas.
- `packages/`: contratos REST, núcleo fiscal, NF-e e SDK.
- `tests/` e `apps/console/e2e/`: testes de domínio, integração, pacotes e
  jornadas no navegador.
- `scripts/<domínio>/`: scripts por domínio, com o teste ao lado; helpers
  compartilhados em `scripts/lib/` e a raiz do repositório por
  `scripts/lib/repo-root.mjs`
  ([organização](docs/desenvolvimento/ci.md#organização-de-scripts)).
- `scripts/lib/worktree/`: ciclo de vida dos ambientes locais.
- `.github/workflows/`: validação e publicação.
- `.agents/skills/`: skills de outro projeto do mantenedor e adaptações de Matt Pocock. Consulte
  [.agents/README.md](.agents/README.md) para o catálogo e
  [.agents/skills/EXTERNAS.md](.agents/skills/EXTERNAS.md) antes de aplicar
  convenções importadas. Carregue só a skill relevante; referências
  `skills/<nome>/SKILL.md` são relativas a `.agents/`.

## Convenções e gosto

- O console importa por caminhos relativos e pelos pacotes `@freecorps/*`.
  Dentro de `platform/convex/`, use caminhos relativos.
- Reutilize os tipos gerados pelo Convex e estreite valores desconhecidos
  antes de usá-los. Evite `any`.
- O console é uma SPA com TanStack Router, `convex/react` e Better Auth, com
  tokens visuais em `apps/console/src/ui/tokens.css` e componentes base em
  `apps/console/src/ui/` (regras em `docs/desenvolvimento/frontend.md`). Para dados
  vivos, use as assinaturas Convex; polling manual não substitui a assinatura.
- Datas e dinheiro do console seguem `apps/console/src/format.ts` e as regras
  do contrato fiscal; datas fiscais não devem mudar com o fuso do navegador.
- Exemplos de Next.js/RSC e SWR das skills não definem a arquitetura daqui.
- Mantenha integrações nas bordas e regras fiscais em helpers testáveis.
  Comentários explicam decisões e acompanham o código que descrevem.
- Supressão de lint e teste pulado dizem por quê:
  `freecorps/require-suppression-reason` exige `-- <motivo>` e
  `// quarantine: #<issue> <motivo>`.
- A UI precisa mostrar o que aconteceu com o documento e qual ação está
  disponível, sem sugerir sucesso enquanto a operação ou o fisco não
  responderam.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`platform/convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data and take
precedence over imported Convex skill examples.

Convex agent skills for common tasks can be installed by running
`cd platform && bunx convex ai-files install`; the root has no Convex project,
so running it there would recreate `convex/_generated/ai/`. Inside `platform/`
it also creates `platform/AGENTS.md`, `platform/CLAUDE.md` and agent skills.

<!-- convex-ai-end -->

As guidelines ficam em `platform/convex/_generated/ai/`, o único projeto Convex
do repositório; `ai-files.state.json` registra a versão instalada.
