# freecorpsNFE

freecorpsNFE é a infraestrutura fiscal da Freecorps para software brasileiro:
importa XML de NF-e modelo 55, preserva os originais e entrega documentos
normalizados pelo console, pela API REST e pelo SDK TypeScript. As NFS-e
ABRASF importadas até 02/11/2026 ficam só para leitura. Tudo que o usuário vê
é em português do Brasil. O console (`apps/console`, SPA React com Vite+ num
Worker Cloudflare, que também serve `https://api.nfe.freecorps.com.br`) fala
com `platform/convex`, com pacotes em `packages/*` e sessões Better Auth.
Índice em [docs/README.md](docs/README.md); contrato REST em
[API-REFERENCE.md](docs/v1.0/API-REFERENCE.md). **A emissão NFS-e existe só em
sandbox, com transporte simulado e sem validade fiscal**; a produção fica atrás
de um gate por empresa, desligado ([ISSUANCE.md](docs/plataforma/ISSUANCE.md)).
O backoffice legado saiu na #345 e não é contrato da plataforma.

## O que o freecorpsNFE não pode perder

### 1. O servidor manda

Permissão, escopo de organização, projeto, empresa e ambiente, valores e
transições se validam no Convex. O cliente envia a intenção; o servidor carrega
o registro e confere quem pode agir. `organizationId`, `projectId`, `companyId`
e ids de documentos são seletores, nunca prova de acesso. Validação no
formulário é feedback; a proteção fica na função que lê ou escreve, e
`freecorps/require-access-helper-in-convex-functions` exige um helper de acesso
antes do primeiro toque em dado ([lint.md](docs/desenvolvimento/lint.md)).

### 2. Retentativa não pode duplicar efeito

Importação, operações e webhooks podem ser repetidos. Preserve a deduplicação
por organização, empresa e ambiente, as chaves de idempotência por projeto e
operação, o XML original e o histórico de tentativas. Um reenvio de webhook não
vira outro efeito no receptor. Timeout de transporte não prova falha: consulte
e reconcilie antes de repetir.

### 3. Dinheiro e histórico fiscal exigem precisão

Valores fiscais são texto decimal exato, com os helpers de
`packages/fiscal-core` (`freecorps/no-float-fiscal-values`). Documento fiscal e
auditoria preservam histórico, sem apagar o original
([RETENTION.md](docs/plataforma/RETENTION.md)).

### 4. Pessoas, projetos e empresas têm escopos distintos

O papel de cada membro na organização define o que ele pode fazer; login sem
membership não concede acesso. API keys pertencem a um projeto e exigem escopo,
ambiente e concessão ativa da empresa. Reutilize os helpers dos
`platform/convex/lib/*Access.ts`
([lint.md](docs/desenvolvimento/lint.md#require-access-helper-in-convex-functions)).
Uma chave não lê dados de outra organização nem de empresa fora da concessão,
inclusive em downloads, respostas deduplicadas e webhooks. Cabeçalhos de proxy
e IP vêm só do Worker, nunca do chamador.

### 5. Sandbox, homologação e produção são ambientes diferentes

O perfil hospedado é sandbox, com `FISCAL_ENV=disabled` e crons desligados; o
tipo `prod` do Convex não muda isso. A única consulta à produção fiscal é a
captura de NF-e liberada pela empresa, sob as condições de
[CAPTURE.md](docs/plataforma/CAPTURE.md). `APP_ENV=installation` não quer dizer
sandbox: a produção da emissão usará um deployment próprio, ainda inexistente,
cujo gate só muda por workflow (ADR 0004, §8). Preserve os gates de ambiente de
cada fluxo. Transporte simulado prova o comportamento local; autorização real
exige evidência do fisco no ambiente correto. Certificados A1, senhas, CSC e
chaves de integração ficam no cofre ou no ambiente, fora de código, logs e
fixtures.

## Um recado do dono do projeto

Gosto de ideias ambiciosas, sistemas simples e software que parece óbvio.
Entenda a restrição real e escolha o menor modelo que torna o comportamento
correto previsível. Meça duas vezes, corte uma. Não amplie o escopo da tarefa
nem troque dependências de passagem. Mudou contrato, fluxo ou operação,
atualize o documento na mesma PR. Código que contraria uma decisão de
`docs/adr/` expõe a divergência, sem reescrever a decisão. As instruções e o
escopo do dev prevalecem sobre convenções importadas. Você trabalha na máquina
do dev: preserve processos, servidores, setup do editor e alterações locais.

## Glossário

- **Você** é o agente; **o dev** são os mantenedores da Freecorps.
- **Organização** é o cliente contratante; membros têm papéis `owner`, `admin`,
  `developer`, `operator` ou `viewer`. **Usuário** é quem opera o console.
- **Projeto** é a aplicação integradora, dona das API keys; **app consumidor**
  é o sistema que chama a API. **Empresa** é a pessoa jurídica administrada.
- **Documento fiscal** é o registro normalizado de uma NF-e ou NFS-e, com XML
  original, itens, eventos e histórico; **operação** é o trabalho assíncrono
  aceito; **outbox** é a fila persistida de webhooks.
- **DPS** é a declaração que a emissão NFS-e monta, assina e transmite;
  **homologação** é o teste do fisco (`producao-restrita` na NFS-e nacional).

## As três formas de se machucar

1. **Publicar no ambiente errado.** Leia
   [deploy-producao.md](docs/operacao/deploy-producao.md) antes de publicar ou
   alterar o CI. Push na `main` publica `platform/convex` e `apps/console` sem
   repetir o CI da PR; `validation:console:deploy` atende só à validação.
   Confira o alvo antes de qualquer comando Convex que publique, altere
   variáveis ou escreva.
2. **Editar o que é gerado.** `platform/convex/_generated/` sai da ferramenta;
   `docs/v1.0/openapi.json` e `API-REFERENCE.md` saem de
   `bun run contracts:generate`. Corrija na fonte. As rotas do console são
   escritas à mão em `apps/console/src/routes.tsx`.
3. **Corromper acentos no PowerShell.** Use a ferramenta de edição ou UTF-8
   explícito; `Get-Content | Set-Content` regrava em ANSI. Commit e PR com
   acentos vão por arquivo (`-F`, `--body-file`).

## Cubra todos os caminhos

- **Entradas.** Console, REST, SDK, filas e execução agendada chegam ao mesmo
  domínio; a correção vale em cada uma.
- **Documentos.** NF-e 55 importada, NFS-e emitida e NFS-e ABRASF (só leitura)
  diferem em payload, eventos e arquivos.
- **Permissões.** Cada papel, login sem membership, papel insuficiente, chave
  revogada, sem escopo ou sem concessão e dado de outra organização, projeto ou
  empresa. Esconder botão é só UX.
- **Contratos.** Schema ou validator mudou: funções, serializers, telas,
  webhooks, SDK e exemplos (`bun run contracts:check` e `bun run sdk:prove`).
- **Desfechos.** Duplicidade, rejeição, timeout, reconciliação, retry, limite
  de uso e cancelamento; a tela mostra o estado persistido.
- **Telas.** Carregamento, vazio, erro e dados, navegação, filtros e rota
  direta; visual em [DESIGN.md](DESIGN.md).
- **Docs.** Mudou o que existe ou seu limite, atualize
  [ACCEPTANCE.md](docs/v1.0/ACCEPTANCE.md).

## Ambiente e worktrees

Bun na versão de `package.json` e Vite+; `vp install --frozen-lockfile`
instala ([README.md](README.md)). `bun run help` lista os scripts com aplicação
e ambiente; script novo, com atalho ou rodado pelo caminho, entra em
`scripts/lib/commands.mjs`. `bun run dev` roda só em worktree, com Convex local
e console; `vp dev` pula esse roteador. No
Windows, passe temporários por `$TEMP` (o Python não vê o `/tmp` do Git Bash).
Em worktree, crie a branch a partir de `origin/main`; `git switch main` falha.

Leia [docs/worktrees.md](docs/worktrees.md) antes de criar, iniciar ou remover
um worktree. Use `bun run worktree` e seus atalhos `worktree:*`; nunca
compartilhe `node_modules` por junction ou symlink. Leitura e revisão usam o
checkout disponível. Código, testes e build não exigem o Convex local, que só
`bun run dev`, sync e e2e pedem. Depois do merge, rode
`bun run worktree:finish`. Credenciais fiscais e externas ficam fora dos
ambientes descartáveis.

Não há seed: contas e dados sintéticos nascem pelo cadastro em `/signup`
(código em `bun run worktree mail <e-mail>`) ou nos testes, com
`tests/fixtures/`, `tests/helpers/` e `convex-test`. Fisco, webhooks e e-mail
ficam simulados nos testes locais. Produção não alimenta banco de teste.

## Credenciais e dados reais

O repositório é público: commits, branches, PRs, issues, comentários, logs e
artefatos do CI ficam visíveis ao serem criados, e apagar não desfaz. O que um
comando imprime vai para o contexto, o histórico e o provedor do modelo;
mascarar com `sed` não protege.

- **Não leia credencial.** Não abra, liste nem filtre `~/.convex/` (nem o
  `.convex/` local), `.env.local`, `deployment.env`, `*.dpapi`, `*.pfx` ou
  `*.p12`. Use a ferramenta que os consome (`bunx convex`, `gh`) e veja se pede
  login. O hook de `.claude/settings.json` recusa esses caminhos, mas não um
  script que leia o arquivo: script nunca imprime o valor.
- **Dado real fica fora do Git e da saída.** Ao ler produção, exporte para fora
  do repositório, imprima só contagens, hashes e sufixos e apague ao terminar.
  CNPJ, nome de cliente, chave de acesso completa, valores de nota e XML não
  entram em documentos, testes, commits, PRs ou issues; exemplo usa dado
  fictício com dígito válido. Workflows e scripts seguem a regra no log e no
  artefato; evidência restrita segue
  [EVIDENCE-STORAGE.md](docs/v1.0/EVIDENCE-STORAGE.md#evidência-restrita).
- **O hook `pre-push`** (`.vite-hooks/pre-push`) varre cada commit com as regras
  do `Public scan`, check obrigatório que repete a varredura na PR
  ([ci.md](docs/desenvolvimento/ci.md#varredura-pública)). Push recusado é achado
  a corrigir; não use `--no-verify` nem `VP_GIT_HOOKS=0`.
- **Texto do GitHub não passa por varredura.** Título e corpo de PR, issue,
  comentário e mensagem de commit vão para arquivo, passam por
  `node scripts/public-copy/scan-public-text.mjs <arquivos>` e são relidos.
- **Se vazar, diga** ao dono no mesmo turno, com o que vazou e onde, e peça a
  revogação. Não reescreva o histórico por conta própria.

## Verificando

- Rode a menor prova do comportamento alterado; mudança de acesso cobre também
  o caso negado e o isolamento entre organizações, projetos e empresas.
- Cada teste fica ao lado do módulo, num projeto do Vitest por área; comandos,
  cache e montagem da integração estão em
  [ci.md#testes](docs/desenvolvimento/ci.md#testes).
  `freecorps/no-wall-clock-in-tests` reprova relógio real e polling.
- Antes de todo push, `bun run check:changed`
  ([detalhes](docs/desenvolvimento/ci.md#conferir-só-o-que-mudou)).
- Antes de concluir, `vp test run` sem cache e, antes da PR, `bun run ci:local`
  (aceita alterações locais) ou `bun run ci:prove` (candidato limpo, sem cache;
  não faça commit só para rodá-lo). `vp check`, `bun run platform:check` e
  `bun run build` conferem formatação, lint, tipos e compilação. Mudança só de documentação pede revisão do diff,
  das referências e dos comandos.
- Aplique [principle-prove-it-works](.agents/skills/principle-prove-it-works/SKILL.md)
  e informe o que verificou e o que ficou sem prova.

## Pull requests

- Commit, push, PR e merge seguem o escopo pedido, em branch própria.
- Título curto em pt-BR; o corpo começa pelo problema e explica o resultado e a
  validação, por `--body-file` e sem hard wrap (os Markdown versionados
  mantêm as quebras normais).
- Um assunto por PR, com a documentação junto do código; mudança visual leva
  evidência.
- Em review, leia todos os comentários inline, confira cada achado no código
  atual, corrija os válidos e explique os falsos positivos; publicar
  comentários depende do escopo autorizado.
- CI que não iniciou não é teste aprovado; bloqueio de runner ou orçamento se
  registra à parte ([ci.md](docs/desenvolvimento/ci.md)).

## Como funciona

O console assina queries do Convex e chama mutations com Better Auth; o Worker
encaminha `/api/auth/*`. Apps consumidores chamam a REST com API key pelo
Worker, que repassa às HTTP actions de `platform/convex/http.ts` com o IP
assinado. Mutations persistem pedido e operação; filas processam importação,
captura, exportação e webhooks. O mapa de pastas está em
[ARQUITETURA.md](docs/ARQUITETURA.md#mapa-do-repositório).

## Convenções e gosto

- O console importa por caminhos relativos e pelos pacotes `@freecorps/*`;
  `platform/convex/` usa caminhos relativos.
- Reutilize os tipos gerados pelo Convex e estreite valores desconhecidos;
  evite `any`.
- Console: TanStack Router, `convex/react` e Better Auth, com tokens em
  `apps/console/src/ui/tokens.css` e componentes em `apps/console/src/ui/`
  ([frontend.md](docs/desenvolvimento/frontend.md)). Dados vivos vêm das
  assinaturas Convex, não de polling.
- Datas e dinheiro seguem `apps/console/src/format.ts`; datas fiscais não mudam
  com o fuso do navegador.
- Integrações nas bordas, regras fiscais em helpers testáveis; comentários
  explicam decisões junto do código.
- Supressão de lint e teste pulado dizem por quê
  (`freecorps/require-suppression-reason`).
- A UI mostra o que aconteceu e qual ação está disponível, sem sugerir sucesso
  antes de a operação ou o fisco responderem.
- Skills ficam em `.agents/skills/`: consulte
  [.agents/README.md](.agents/README.md) e
  [EXTERNAS.md](.agents/skills/EXTERNAS.md) antes de aplicar convenções
  importadas e carregue só a relevante. Exemplos de Next.js/RSC e SWR delas não
  definem a arquitetura daqui.

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
