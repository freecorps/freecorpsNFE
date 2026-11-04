# Ambiente persistente de validação

O backend persistente e o painel hospedado compartilham este ambiente.
Este ambiente publica a `main`, somente quando o mantenedor dispara o workflow
`Deploy validation` manualmente. Até 07/10/2026 ele acompanhava a branch
`feat/fiscal-platform-v1`, que parou fora da `main`. Não expira ao fechar um PR
ou remover uma worktree. Seu bootstrap foi publicado em 09/09/2026.

## Identidade e acesso

O arquivo [platform/validation.json](../../platform/validation.json) registra os
metadados usados pelos comandos. Não contém credenciais.

| Uso             | Deployment          | Referência                          | Tipo            | Região          |
| --------------- | ------------------- | ----------------------------------- | --------------- | --------------- |
| Validação 1.0   | `modest-seal-118`   | `dev/fiscal-platform-v1-validation` | dev, não padrão | `aws-us-east-1` |
| Produção da 1.0 | `elated-possum-295` | `production`                        | prod, padrão    | `aws-us-east-1` |

- Time e responsável operacional: `freecorps`.
- Projeto: `freecorpsnfe`, ID `2892159`.
- ID do deployment novo: `5403587`.
- Backend: <https://modest-seal-118.convex.cloud>.
- HTTP: <https://modest-seal-118.convex.site>.
- Saúde pública: <https://modest-seal-118.convex.site/health>.
- [Dashboard de validação](https://dashboard.convex.dev/t/freecorps/freecorpsnfe/modest-seal-118).
- Expiração: criado com `--expiration none`; não é preview temporário.
- Painel: <https://freecorpsnfe-validation.freecorps.workers.dev/login>.
- Versão pública do painel: `/build.json`; o mesmo SHA aparece na faixa superior.

O inventário consultou metadados dos deployments, sem ler dados fiscais ou
credenciais do legado. Antes da criação, a conta estava no Convex Professional,
com 173 deployments de nuvem no time. O limite publicado era 300. A região US
estava disponível. A criação não alterou assinatura, região padrão ou deployment
padrão. Uso e armazenamento continuam consumindo a franquia compartilhada do
time; este ambiente não tem cobrança ou limite de consumo isolados.

Fontes: [múltiplos deployments](https://docs.convex.dev/production/multiple-deployments),
[limites](https://docs.convex.dev/production/state/limits) e
[Management API](https://docs.convex.dev/management-api/overview).
Metadados verificados em 09/09/2026, com CLI Convex 1.45.0.

## Código publicado e isolamento

`platform/` é um workspace Bun que resolve as versões pelo lockfile da raiz.
Seu `convex.json` seleciona somente `platform/convex/`, o único projeto Convex
do repositório desde a aposentadoria do backend legado na #345. Nenhuma função
de emissão, cadastro, certificado, consulta externa ou entrega de e-mail do
legado foi publicada no deployment novo. Isso antecipa a separação de diretórios prevista em B00, sem
concluir os demais itens daquele marco.

A validação persistente criou `validationProbes`, funções internas e `GET /health`. A validação hospedada adiciona
`validationAccess` e o componente Better Auth, com tabelas próprias para usuários,
sessões, contas e chaves de autenticação. As consultas públicas exigem sessão e
concessão de acesso. O cadastro de contas de teste é interno; cadastro público
está desativado. Não há conector fiscal, certificado, webhook ou cron. Storage
pertence ao deployment de validação.

As variáveis abaixo existem no backend e são exigidas pelos comandos e pelas
funções. Ausência ou valor diferente faz a operação falhar. A conferência remota
também recusa variáveis extras, sem imprimir seus valores.

| Variável             | Valor inicial                                                 |
| -------------------- | ------------------------------------------------------------- |
| `APP_ENV`            | `validation`                                                  |
| `PRODUCT_ENV`        | `sandbox`                                                     |
| `FISCAL_ENV`         | `disabled`                                                    |
| `FNFE_CRONS`         | `off`                                                         |
| `EMAIL_MODE`         | `disabled`                                                    |
| `WEBHOOK_MODE`       | `disabled`                                                    |
| `SITE_URL`           | `https://freecorpsnfe-validation.freecorps.workers.dev`       |
| `BETTER_AUTH_SECRET` | Segredo exclusivo, pelo menos 32 caracteres, nunca versionado |

Nesta fase, e-mail e webhooks não são enviados. Ao ampliar B01 e implementar B07,
o PR correspondente deve acrescentar coletor/destino de teste, segredos novos e
testes à allowlist. Não reutilizar usuários Clerk, segredo Better Auth, chaves
de API, chaves de criptografia ou assinatura do legado. Uma variável de ambiente
não torna um conector seguro por si só: cada futura operação externa deve validar
o modo permitido antes do envio. Integração fiscal real é uma entrega separada,
com autorização e evidências na validação fiscal real.

## GitHub e credenciais

O ambiente GitHub `validation` foi criado com política de branches customizada:
somente `feat/fiscal-platform-v1`, sem regras para tags ou branches de PR. Com
a publicação a partir da `main`, essa política precisa permitir somente `main`;
o mantenedor ajusta a regra nas configurações do repositório antes do primeiro
disparo, ou o GitHub recusa o job de publicação.

| Tipo     | Nome                           | Finalidade                               |
| -------- | ------------------------------ | ---------------------------------------- |
| Secret   | `VALIDATION_CONVEX_DEPLOY_KEY` | Chave `dev` restrita a `modest-seal-118` |
| Variable | `VALIDATION_CONVEX_DEPLOYMENT` | `modest-seal-118`                        |
| Variable | `VALIDATION_CONVEX_URL`        | URL cloud acima                          |
| Variable | `VALIDATION_CONVEX_SITE_URL`   | URL HTTP acima                           |
| Variable | `APP_ENV`                      | `validation`                             |
| Variable | `PRODUCT_ENV`                  | `sandbox`                                |
| Variable | `FISCAL_ENV`                   | `disabled`                               |

A chave foi criada como `github-validation-v1`. Não é chave de projeto, preview
ou produção. Ela permite administração do deployment de validação: guardas de
scripts evitam acidentes, mas não substituem a proteção dessa credencial.

O workflow da publicação de validação deve usar `environment: validation`, mapear explicitamente
essas variáveis para o processo e executar `bun run validation:deploy` após o CI.
Ele só aceita `workflow_dispatch` na `main`; um push na `main` publica a produção
pelo `deploy.yml` e nunca escreve na validação.
Usar uma única concorrência `validation-publication`, com
`cancel-in-progress: false`, para frontend e backend do mesmo commit. PRs não
recebem o segredo e não publicam no ambiente compartilhado.

**No bootstrap inicial, a publicação automática ainda não estava configurada.**
Esse recorte entregou o
alvo, a credencial, os guardas e o bootstrap. A publicação de validação conecta o pipeline. Até lá,
o ambiente conserva a última publicação manual das etapas de validação persistente e validação hospedada. A publicação inicial da validação persistente
foi uma operação explícita do mantenedor com `--bootstrap`; não é um segundo
processo contínuo de desenvolvimento.

Rotação: criar outra chave restrita ao mesmo deployment no dashboard, substituir
o secret em `validation`, executar a conferência e revogar a chave anterior.
Não imprimir o valor, registrá-lo em issues ou copiá-lo para `.env.local` de
worktrees. Para manutenção manual, o operador deve usar uma credencial temporária
do mesmo alvo, carregada em `VALIDATION_CONVEX_DEPLOY_KEY`, e revogá-la ao terminar.

## Comandos e prova de persistência

Executar na raiz desta worktree, com Bun 1.4.0 e dependências próprias. A chave
de validação deve estar no ambiente do processo. As variáveis de identificação
do GitHub são opcionais localmente, mas, se fornecidas, precisam coincidir com
o manifesto. Os comandos não usam login pessoal para escolher o destino.

```powershell
bun run validation:check
bun run validation:probe:read
```

`validation:deploy` exige execução no pipeline disparado manualmente na `main`.
A única
exceção de operador é `--bootstrap`, recusada dentro do GitHub Actions. Nenhum
comando recebe flags arbitrárias do Convex, como `--prod`, `--url`, `--preview-create`
ou `--preview-run`. Uma chave genérica `CONVEX_DEPLOY_KEY` ou configuração
self-hosted presente faz o comando falhar. Outros seletores herdados do ambiente
local são removidos; o CLI recebe um arquivo temporário com somente a chave
restrita, apagado ao terminar.

O ensaio abaixo insere a sonda somente se ela não existe, lê seu estado, publica,
confere zero crons e compara o documento inteiro após o deploy. Uma sonda já
existente nunca é sobrescrita. O comando retorna erro se a comparação falhar.

```powershell
# Pipeline manual da main
bun run validation:verify-persistence

# Ensaio inicial explícito do operador, sem outro escritor ativo
bun run validation:verify-persistence --bootstrap
```

O deploy normal não cria sonda, executa seed, importa snapshot ou apaga dados.
Para a prova negativa, os testes executam o comando real com chaves sintéticas
de produção, outro dev, projeto e preview. Ele termina antes de anunciar um alvo
ou iniciar chamadas de rede. Nunca usar uma chave real de produção nesse teste.

```powershell
bun run -- vp test run tests/validationTarget.test.ts tests/platform.validation.test.ts
```

Os [scripts de worktree](../worktrees.md) continuam administrando o banco local
de cada checkout. `bun run dev` não publica este bootstrap na nuvem. Numa
worktree com perfil `platform`, padrão dos worktrees novos, sobe
`platform/convex` e `apps/console` locais. Testes do novo backend usam
`convex-test` com schema e mapa de módulos de `platform/convex/`, sem acesso à
nuvem. Não apontar um servidor de desenvolvimento de uma feature para este
banco compartilhado.

## Retenção, backup e reset

Responsável: mantenedores do time `freecorps`. Conservar a sonda durante M0 para
comparar deploys. Não há expurgo automático neste bootstrap. Fixtures futuras
devem ter retenção explícita no módulo que as criar, sem usar dados de produção.

Fazer um snapshot antes de migrações/reset e semanalmente enquanto houver trabalho
de validação que precise ser preservado. Esta é uma rotina manual, ainda sem
agendamento. Conservar os quatro últimos snapshots e os snapshots associados a
marcos aprovados. O objetivo operacional inicial é perder no máximo uma semana
de dados sintéticos; recuperação dentro de um dia de trabalho ainda precisa ser
ensaiada em B10, portanto não é garantia medida.

O comando inclui file storage, usa o mesmo alvo fixo e exige diretório absoluto.
Antes de criar a pasta ou acessar o backend, resolve symlinks/junctions e recusa
destinos dentro do checkout atual, inclusive pastas ainda inexistentes. Essa
verificação não inventaria outras worktrees: a escolha de uma pasta durável fora
delas continua sendo responsabilidade do operador.
Escolher uma pasta durável, fora de worktrees descartáveis. Não versionar ZIPs ou
anexar seu conteúdo a issues. Copiar backups necessários para armazenamento privado
da equipe, registrar data, SHA-256 e commit que produziu o schema.

```powershell
$env:VALIDATION_BACKUP_DIR = Join-Path $env:USERPROFILE '.freecorpsnfe/validation-backups'
bun run validation:backup
```

Reset não faz parte dos scripts de deploy. Para um reset deliberado:

1. Registrar motivo, alvo, tabelas afetadas e autorização do responsável no registro operacional;
   impedir novas publicações durante a operação.
2. Conferir o dashboard `modest-seal-118` e exportar banco e storage.
3. Verificar que o ZIP abre e contém as tabelas esperadas. A validação persistente verificou o
   backup inicial; isso não substitui um ensaio de restauração.
4. Executar a remoção/importação explicitamente pelo dashboard do alvo conferido.
   Começar pelo menor conjunto de fixtures necessário, sem remover o deployment.
5. Recriar a sonda se ela foi removida, executar saúde/persistência, registrar
   evidências e liberar o escritor do pipeline.

Nenhum reset ou restore foi realizado na validação persistente. Antes de alterações incompatíveis,
B10 deve ensaiar restauração em outro deployment descartável. Não testar restore
em produção nem sobrescrever a validação compartilhada para conferir um ZIP.

## Observabilidade e previews

Consultar `/health` para disponibilidade/configuração. Ele não prova login,
importação ou integração SEFAZ. O dashboard de validação mostra logs, falhas,
histórico de deploy e consumo. Guardar commit, resultado do CI, prova de persistência
e integridade do backup no registro local do marco. Neste bootstrap há zero crons; qualquer job
registrado exige investigar o código publicado antes de continuar.

O time compartilha limites e consumo entre projetos. Rever o custo no dashboard
ao habilitar ações recorrentes. Não há alerta automático ou monitor externo
provisionado no bootstrap. Deployments `dev` podem mostrar detalhes de erros aos
clientes; este ambiente recebe apenas dados sintéticos.

Previews por PR são opcionais e ficam para outra entrega. Se introduzidos,
precisam de chave restrita, `FNFE_CRONS=off` antes do primeiro push, TTL e limpeza
no encerramento do PR. Não substituir o deployment persistente por preview nem
aplicar defaults de preview ao tipo `prod`.

## Evidências

Em 09/09/2026, a comparação na nuvem preservou `_id`, `_creationTime`, `createdAt`
e `nonce` após novo deploy. O SHA-256 da representação JSON comparada foi
`45c9b146d57c2cb911022747d59168b7a7c6c6c799a2d5fb255940634d5663e8`.
O resultado de `_system/frontend/listCronJobs` foi `[]`; `/health` respondeu 200;
uma rota fiscal legada respondeu 404; uma mutation interna sem credencial foi
recusada. O inventário posterior manteve os timestamps de deploy do legado iguais
aos valores lidos antes do provisionamento.

O snapshot inicial foi exportado com file storage. O ZIP abriu sem erros, contém
a sonda esperada e tem 1.520 bytes. SHA-256:
`61f6542858f458d814870ba967c2a697e4e70b507eb85932deae30a997ebc633`.
Ele foi salvo fora da worktree em `.freecorpsnfe/validation-backups` no perfil
local do operador. O storage exportado está vazio.

Os testes automatizados do repositório passaram: 46 arquivos, 613 testes,
incluindo os 27 testes novos de ambiente, persistência e isolamento. Typecheck,
lint e build também passaram. Resultados de CI e o backup inicial são registrados
no registro local de evidências, junto do conteúdo testado e de suas limitações.

## Publicação depois do bootstrap

O [pipeline coordenado da publicação de validação](deploy-validacao.md) substitui as publicações manuais
independentes assim que integrado e configurado. Ele usa o mesmo deployment,
preserva a base, inclui SHA no health e verifica autenticação sintética. Os
comandos `--bootstrap` abaixo documentam o provisionamento inicial; publicações
rotineiras devem usar o único escritor do pipeline.

## Painel e autenticação

`apps/console` é uma SPA React com TanStack Router, empacotada pelo Vite+ e
publicada no Worker de assets `freecorpsnfe-validation`, conta Cloudflare
`ceccd1846b474bb179054a3c2c4a6185`. Não há rota customizada, binding ou reuso do
Worker legado. Os assets usam `not_found_handling: "none"`: um endereço sem
arquivo chega ao Worker, que entrega o `index.html` às rotas internas, a
página de não encontrado da documentação sob `/docs` e 404 sem cache aos
arquivos ausentes ([PUBLIC.md](../plataforma/PUBLIC.md#endereços-ausentes-favicon-e-cache)).
Os headers incluem CSP restrita aos hosts de validação, HTTPS, `no-store`,
proteção contra iframe e `noindex`. Só `/assets/*` e `/docs/assets/*`, onde
os builds do console e da documentação gravam JavaScript, CSS e fontes com o
hash do conteúdo no nome, trocam o `no-store` por
`public, max-age=31536000, immutable` (`! Cache-Control` desliga o header
herdado da regra `/*`); HTML, `landing.css`, `theme.js`, `favicon.png`, `favicon.ico` e as
páginas, dados e índices de `/docs` continuam `no-store`. Assets são públicos; dados exigem autenticação
e autorização no backend. `noindex` não é controle de acesso.

O build fixa as URLs cloud/site em `platform/validation.json`, recusa variáveis
`VITE_*` conflitantes e grava o commit completo em `/build.json`. A publicação
exige checkout limpo, configuração exata do Worker e o pipeline manual da
`main` ou
`--bootstrap` local. Não configurar domínio de produção neste Worker.

```powershell
bun run console:build
node scripts/console/console.mjs package
# Publicação manual inicial, após commit e verificação do backend correspondente:
bun run validation:console:deploy --bootstrap
```

O CI de PR verifica tipos, testes e empacotamento de ambos os aplicativos sem
publicar. Estes comandos não transformam o servidor legado da worktree no
console novo. Para testar autenticação remota, usar a URL de validação; localhost
não faz parte das origens confiáveis. Para desenvolvimento local da nova
plataforma, usar o perfil `platform` dos [scripts de worktree](../worktrees.md).

Better Auth `1.6.33` e `@convex-dev/better-auth` `0.12.5` estão fixados no lockfile.
Um [patch de declarações TypeScript](../../patches/README.md) corrige a inferência
do provider React. Nenhum JavaScript do fornecedor é alterado.

`baseURL` usa `https://modest-seal-118.convex.site`. `trustedOrigins`, CORS e
callbacks relativos aceitam apenas o painel indicado acima. Login usa e-mail e
senha; não há callback OAuth, reset por e-mail ou cadastro público neste marco.
Contas usam `@validation.invalid`, domínio reservado que não entrega mensagens.
O envio de e-mail permanece desativado e não há credencial de provedor.

O plugin oficial `crossDomainClient` transporta a sessão no header
`Better-Auth-Cookie`, com `credentials: omit`, e mantém seu estado em localStorage
da origem do painel. Isso evita depender de cookies de terceiros, mas **não é
uma sessão protegida por cookie HttpOnly no host do painel**. A CSP e a ausência
de scripts externos reduzem a exposição a scripts injetados; não adicionar HTML
arbitrário ou scripts de terceiros ao console. O backend configura cookies
seguros, sessão de sete dias, renovação durante o uso após 24 horas e JWT de 60 segundos.
Cache de cookie de sessão está desativado. As consultas protegidas conferem
também a sessão atual no banco com `safeGetAuthUser`; um JWT ainda válido não
autoriza sessão revogada ou vencida. O rate limit de autenticação persiste no
banco, com limite geral de 30 requisições/minuto e regras explícitas de cinco
tentativas/minuto para `/sign-in/email`, `/change-password` e `/change-email`.
A sexta tentativa inválida de login recebe 429 com `X-Retry-After`, sem bloquear
a consulta de sessão. Alterações devem preservar a verificação de sessão e
concessão no servidor.

## Contas de teste

O responsável cria um conjunto de contas usando a chave temporária de validação
carregada em `VALIDATION_CONVEX_DEPLOY_KEY`, após conferir o alvo:

```powershell
bun run validation:accounts --bootstrap
```

O comando salva senhas aleatórias em
`~/.freecorpsnfe/validation-access/accounts-<identificador>.json`, fora do Git.
É possível escolher outra pasta privada absoluta com `VALIDATION_ACCESS_DIR`;
o comando recusa destinos dentro do checkout, inclusive links. No Windows,
manter as permissões privadas da pasta do usuário; `mode: 0600` sozinho não
substitui ACLs. O arquivo registra quais contas foram criadas caso haja falha
parcial. Não anexar esse arquivo a issue, PR, screenshot ou artefato de CI.
Distribuir cada acesso pelo gerenciador de senhas da equipe ou acesso local ao
arquivo. Não existem senhas fixas em fixtures ou na configuração do frontend.

| Perfil     | Permissão                                       |
| ---------- | ----------------------------------------------- |
| `operator` | Visão geral e diagnóstico de persistência       |
| `viewer`   | Visão geral; diagnóstico recusado pelo servidor |
| `none`     | Login aceito, consulta e painel negados         |

Concessões usam o ID retornado pelo Better Auth deste deployment, nunca um ID
ou perfil fornecido pelo navegador. Ainda não são organizações ou RBAC fiscal
da B02. Concessões podem ser removidas da tabela `validationAccess` no dashboard
de validação; revogar também as sessões do componente ao retirar uma conta.
Não reutilizar estas contas fora deste ambiente. Se uma senha for perdida,
retirar o acesso anterior e gerar um conjunto novo; não publicar reset improvisado.

Para reproduzir a validação manual: entrar como operador, abrir Diagnóstico,
recarregar essa rota, sair e tentar acessá-la novamente. Repetir como leitura e
sem concessão, conferindo também as respostas da API. Verificar login a 390px,
navegação por teclado, mensagens de erro e o SHA da faixa superior. Os testes
`platform.access.test.ts` cobrem papéis, ausência de identidade, revogação,
expiração com identidade ainda autenticada, signup bloqueado e CORS no router.

O [runner progressivo da validação no navegador](../desenvolvimento/navegador.md) usa essas contas em revisão manual e
um viewer no job de publicação da publicação de validação. Registra SHAs, cenários, acessibilidade
e medições. O comando abaixo preserva a prova manual anterior, incluindo a
expiração antecipada opcional; ele é separado do CI:

```powershell
# Carregar o caminho do arquivo privado, nunca colar sua senha no comando.
$env:VALIDATION_ACCESS_FILE = 'C:/caminho/privado/accounts-identificador.json'
node apps/console/e2e/validation.mjs
```

Instalar Chromium com `bunx playwright install chromium` se necessário. O teste
verifica login, consulta, logout, perfis, rotas diretas, headers e layout móvel.
Se `VALIDATION_CONVEX_DEPLOY_KEY` estiver presente, também antecipa a expiração
**somente da sessão sintética criada nessa execução** e confere a recusa com o
JWT anterior. Isso modifica o ambiente compartilhado e exige execução explícita
do operador; o script recusa GitHub Actions. Sem a chave, informa que esse passo
foi omitido. Screenshots ficam em `~/.freecorpsnfe/validation-evidence` e não
incluem o formulário preenchido. Não ativar trace/HAR com credenciais reais.
