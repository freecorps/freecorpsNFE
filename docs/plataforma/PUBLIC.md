# Site e documentação do candidato

A landing em `/` e a documentação em `/docs/` são HTML estático gerado no build
do console. O painel continua em `/console`, `/app` e nas rotas de conta
existentes. `apps/console/src/entry.ts` carrega React, autenticação e Convex
somente nas rotas do painel. A leitura da landing e da documentação não exige
sessão nem JavaScript.

## Fontes e construção

O aviso específico de dados cadastrais está em `/docs/privacidade-cnpj`,
fonte `apps/docs/content/docs/privacidade-cnpj.mdx`. É acessível sem login,
consta da navegação de documentos e do rodapé da landing. Informa consulta
via OpenCNPJ, papéis, campos, retenção e canal de direitos; não substitui a
revisão geral de D06. A publicação acompanha o deploy normal do console.

A landing é escrita como componentes React em `apps/console/src/site/landing/`.
Como o console é uma SPA sem SSR, `render.tsx` transforma esses componentes em
HTML estático com `renderToStaticMarkup`, e o plugin em
`apps/console/site-plugin.ts` injeta o resultado em `index.html`. A landing não
é hidratada.

O login fica a um toque em qualquer largura (#452): no cabeçalho da landing,
"Entrar" fica ao lado de "Criar conta" também no telefone (abaixo de 380 px a
marca perde a palavra "fiscal" para os dois caberem); o rodapé repete
"Entrar"; nos guias, o botão da barra do topo dá lugar, abaixo de 1024 px, a
um item "Entrar" no menu lateral
(antes e depois).

"Criar conta" e "Começar no sandbox" levam a
`/signup?redirect=%2Fconsole%3Ftarefa%3Dimportar` (#510), montado por
`taskEntryHref` em `apps/console/src/console-task.ts`: depois do cadastro e da
verificação (ou direto, com a sessão aberta), o console abre o Início com a
tarefa "Importar XML". O endereço de entrada de cada tarefa
(`importar`, `emitir`, `capturar`, `integrar`) é permanente depois de
publicado e usa só o `?redirect=` que o login já tinha; nunca leva id de
organização ou empresa. `scripts/console/prove-public-site.mjs` aceita as telas do
console também com consulta.

A documentação é um app próprio, `apps/docs`, feito com Fumadocs sobre React
Router 8 em modo framework, com `ssr: false` e prerender de todas as páginas.
A escolha segue o que o Fumadocs suporta no Vite: React Router gera arquivos
estáticos sem servidor, usa o mesmo Vite+ do repositório e mantém as URLs
`/docs/<página>` sem basename. O conteúdo fica em MDX, em
`apps/docs/content/docs/`, com a ordem da navegação em `meta.json`. A
referência da API é gerada de `docs/v1.0/openapi.json` por `fumadocs-openapi`,
uma página por operação em `/docs/api/<operationId>`, sem playground. Cada
página recebe só o trecho do OpenAPI que a operação usa. Título e item da
navegação vêm de `app/lib/operation-titles.ts`, em português, com o
`operationId` em fonte mono sob o título; operação do contrato sem título, ou
título de operação que saiu do contrato, falha a checagem de tipos e o build.
A interface da referência é um chunk à parte, que as páginas de guia não
baixam. A busca é estática:
o build grava `/docs/search.json` e o navegador busca localmente, sem servidor.

Os guias seguem quatro grupos na navegação: Começar (visão geral, primeira
chamada, conceitos, ajuda e condições de acesso), Guias (importação pelo
painel, importação pela API, webhooks, emissão NFS-e no sandbox, captura),
Referência (contrato, referência da API, SDK, agentes de IA) e Produto (instalação, licenças,
privacidade da consulta CNPJ). A página inicial começa pela escolha da tarefa
(#515): importar XML pelo painel, integrar pela API, capturar NF-e ou
experimentar a emissão simulada, com os ambientes separados; a tabela de
cobertura e as regras da API vêm depois. `importar-pelo-painel` é o guia de
quem opera sem chave: pré-requisitos, rótulos reais da tela, resultado
esperado, onde a nota e o original ficam e como recuperar (recusa,
interrupção, duplicidade, cancelamento), sem ensinar reserva e ticket como
tarefa manual; `importar-xml`, "Importar XML pela API", mantém a rota e
descreve o protocolo. Os links de criar conta dos guias usam o endereço de
entrada da tarefa (`taskEntryHref`): `importar` na página inicial e no guia
do painel, `integrar` na primeira chamada; `scripts/console/prove-public-site.mjs`
recusa outra query string nos links para o console. Cada regra tem uma página
dona: limites gerais e erros em `contrato`, assinatura e entrega em
`webhooks`, disponibilidade do XML em `importar-xml`. Rótulos do painel
(botões, abas, menus) entram como `<Ui>Rótulo</Ui>`, desenhados como as
pílulas do próprio painel.

Os guias também saem em Markdown para agentes de IA: `/docs/llms.txt`
(índice), `/docs/llms-full.txt` (todos os guias) e `/docs/<página>.md`.
`includeProcessedMarkdown` do fumadocs-mdx guarda o Markdown de cada página
com os elementos de `markdownElements` (`app/lib/source.ts`) como marcadores,
e `app/lib/markdown.server.ts` os escreve a partir das props, com as tabelas
do contrato lidas do mesmo OpenAPI das páginas HTML. Um elemento novo nos
guias entra nessa lista e ganha um renderizador; elemento listado sem
renderizador falha o build. Links entre guias apontam para o `.md`. O
React Router não tem rota para `<slug>.md`, então o build prerenderiza
`/docs/markdown.json` e `apps/docs/scripts/build.mjs` o separa em arquivos.

`apps/docs/scripts/build.mjs` roda o build do React Router e prepara a saída
para o console: `docs/<página>/index.html` vira `docs/<página>.html`, o mesmo
formato que o Worker e o servidor da instalação própria já resolvem para
`/docs/<página>`. Endereços antigos com `.html` continuam respondendo. O script
termina gravando em `apps/docs/dist/files.json` a lista do que produziu.
Antes do build, ele recusa travessão nos guias MDX, nos textos de
`apps/docs/app` e em `docs/v1.0/openapi.json`, indicando arquivo, linha e
coluna. Na saída, confere páginas, dados e índice de busca, sem regravar o
JavaScript das dependências, que traz esses caracteres como dados.

O build da documentação é a tarefa `ci:docs` do `vite.config.ts` da raiz, uma
etapa própria antes do console. O Vite Task registra o que ela lê, inclusive o
MDX, o OpenAPI de `docs/v1.0` e a CSP de `public/_headers`, e reaproveita a
saída enquanto nada disso muda. `bun run build`, `bun run console:build`,
`ci:console`, o deploy de validação e o build da instalação própria executam
`ci:docs` antes do build do console; uma falha da documentação para ali, sem
compilar nem publicar o console. O plugin do console não compila a
documentação: no início de todo `vite build` ele confere `files.json` e recusa
o build sem ele, e no fim copia para a raiz da saída só os arquivos listados
(`docs/**` e `docs.data`, lido na navegação para `/docs`). Restaurar a saída
do cache não apaga sobras de outro build em `apps/docs/dist`, e a lista as
deixa de fora. A origem pública (`PUBLIC_SITE_ORIGIN`) só entra nessa
composição, e `ci:console` a inclui na chave do cache.

Para editar, `vp run docs:dev` abre o servidor do Fumadocs em
`http://localhost:5180/docs` com recarga a cada mudança no MDX. `vp run
docs:build` gera `apps/docs/dist`, que o servidor de desenvolvimento do
console também serve em `/docs`.

Os guias citam operações reais. `apps/docs/app/lib/contract.server.ts` importa
`docs/v1.0/openapi.json`, gerado de `packages/contracts/src/external.ts`, e os
componentes MDX de `app/components/contract.tsx` desenham a partir dele a
tabela REST, com o limite de página de cada rota, os ambientes, os códigos de
erro, os eventos de webhook, a tolerância da assinatura e a versão do contrato.
`<Op id="..." />` escreve método e caminho de uma operação pelo `operationId`.
Uma página que usa esses componentes declara `contract: true` no frontmatter;
só ela recebe os dados, no loader executado durante o build. Operação citada
que deixe de existir, ou componente sem a declaração, falha a renderização, e o
`entry.server.tsx` do app transforma qualquer erro de renderização em falha do
build. O mapa de erros tem tipo derivado de `publicErrorStatus`: código novo ou
status alterado falha a checagem de tipos até a descrição pública ser revista.
A importação de `external.ts` é só de tipo, para o schema zod não entrar no
build da documentação; o sufixo `.server` mantém o OpenAPI fora do bundle do
navegador. Os downloads vêm do gerador existente de contratos e exemplos. Não
copie o diretório interno de documentação inteiro para o site.

O tema da documentação é o da landing: fundo noturno com neutros esverdeados,
um único acento (fósforo), pílulas nos controles, painéis de 16px e blocos de
código de 12px, só escuro. Os tokens de `landing/landing.css` estão mapeados nas
variáveis `--color-fd-*` do Fumadocs em `apps/docs/app/app.css`, com Geist e
Geist Mono servidas de `apps/console/public/fonts/` (licença OFL ao lado). O
realce de código usa um tema Shiki próprio (`app/lib/code-theme.ts`) que troca
as cores inline por classes. O texto corrido fica um tom abaixo do texto
principal, para que títulos, negrito e links se destaquem; código inline usa o
verde do tema de código; os passos (`<Steps>`) têm marcadores numerados em
fósforo mono. A figura da página inicial da documentação é a
`intake` da landing, sem animação; o CSS dela vem de `landing.css` e de
`figures/intake.css` no build, sem cópia.

### Endereços ausentes, favicon e cache

Os Workers do console (`deploy/selfhost/worker.ts`, publicado por
`releaseWorker` e `issuanceReleaseWorker`, e `apps/console/worker.ts`, da
validação) servem os assets com `not_found_handling: "none"`. Arquivo
existente sai da camada de assets com os headers de `public/_headers`; um
endereço sem arquivo chega ao Worker, e `apps/console/asset-fallback.ts`
decide a resposta:

- navegação (GET ou HEAD, `Accept` que admite HTML, o que inclui `*/*` e
  ausência do header, e último segmento sem extensão ou terminado em
  `.html`) sob `/docs` recebe `/docs/404`, a página de não encontrado da
  documentação, com status 404 e link para `/docs/`;
- outra navegação recebe o `index.html` com status 200, e o roteador do
  console resolve a rota: acesso direto e recarga continuam funcionando. O
  Worker grava `X-Robots-Tag: noindex` nessa resposta, porque os headers vêm
  da regra de `/`, que o opt-in de indexação libera;
- o resto (script, folha, imagem, `.data`, `/favicon.ico` ou pedido de JSON)
  recebe 404 em texto curto, com `Cache-Control: no-store`, sem o HTML da
  landing e sem o cache imutável de `/assets/*`.

Antes, o fallback `single-page-application` da Cloudflare devolvia a landing
com 200 para qualquer endereço ausente, inclusive um chunk em `/assets/` com
cache de um ano (#453). Cada navegação para uma rota do painel agora passa
pelo Worker, que faz duas leituras internas da camada de assets.

`/docs/404` é a rota `docs/404` do app da documentação (`not-found.tsx`),
prerenderizada em `docs/404.html`. O build retira dela os scripts: hidratada
em outro endereço, a rota de guia do React Router tentaria carregar dados que
não existem. Saem também os botões do layout (busca e menu do celular), que
sem JavaScript não fariam nada. A página é HTML estático com os estilos e a
navegação em links, fica fora do sitemap e das exceções de `X-Robots-Tag`, e
a prova do site confere o link de volta e a ausência de script e botão.
Como `docs/404.html` é um arquivo, o próprio `/docs/404` está em
`run_worker_first`, e o Worker responde a ele também com 404.
Capturas em evidence/453.

O ícone usa o símbolo angular da Freecorps em fósforo sobre fundo noite,
conforme [DESIGN.md](../../DESIGN.md#ícone-de-aba). O `index.html` do console
e o layout da documentação declaram os mesmos arquivos por `<link rel="icon">`:
`public/favicon.png`, de 48 × 48 pixels, e `public/favicon.ico`, com versões
de 16, 32 e 48 pixels. A landing, o console e os guias recebem esses arquivos
da raiz do mesmo site.

Cache: `/assets/*` (console) e `/docs/assets/*` (documentação) têm
`public, max-age=31536000, immutable`; o resto fica com o `no-store` da regra
`/*`, inclusive HTML, `docs.data` e os `.data` das páginas, `search.json`,
`llms*.txt`, os `.md`, `landing.css`, `theme.js`, `favicon.png` e `favicon.ico`. Todo nome
em `/docs/assets` traz o hash do conteúdo: os do Vite, os scripts
`inline/<hash>.js` e a folha `inline-<hash>.css` do build da documentação.
`apps/docs/scripts/build.mjs` recusa um arquivo ali sem hash, que ficaria
imutável com conteúdo mutável. Um arquivo ausente nesses diretórios nunca
recebe o cache longo, porque a resposta vem do Worker.

`wrangler dev` sobre o build real e a configuração gerada por `releaseWorker`
reproduz esse roteamento sem publicar; o teste
`scripts/console/asset-fallback.test.ts` cobre as decisões do Worker, a configuração
dos Workers e as regras de cache de `_headers`. O servidor da instalação
própria (`scripts/lib/selfhost-server.mjs`) e o servidor de desenvolvimento
do console usam a mesma regra (`apps/console/page-request.mjs`) e também
respondem `docs/404.html` com status 404 para uma página ausente sob `/docs`,
inclusive com `.html`; sem esse arquivo, o 404 é curto.

### CSP

A documentação roda sob a mesma CSP de `public/_headers`, sem `unsafe-inline`
para script ou estilo:

```text
script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'sha256-vGQdhYJbTuF+M8iCn1IZCHpdkiICocWHDq4qnQF4Rjw='
```

`'wasm-unsafe-eval'` deixa a página compilar WebAssembly. O único módulo é o
leitor do código de barras da consulta pelo DANFE, servido em `/assets/` do
próprio console ([IMPORTS.md](IMPORTS.md#consulta-pelo-danfe-296)). A diretiva
não libera `eval()` nem `new Function()`.

O `entry.server.tsx` espera todo o conteúdo e desliga o envio progressivo de
blocos grandes do React, que deixaria parte da página escondida até um script
inline a revelar; o build e a prova recusam qualquer fragmento adiado.

O React Router escreve scripts inline no HTML prerenderizado (contexto,
dados do loader, restauração de rolagem e o módulo de entrada).
`apps/docs/scripts/build.mjs` move cada um para
`/docs/assets/inline/<hash>.js`, na mesma ordem, e troca os atributos `style`
do HTML por `data-fd-style` e uma folha `/docs/assets/inline-<hash>.css` sem
camada, que vence o Tailwind como o estilo inline venceria. Depois da
hidratação, o React aplica estilos pelo CSSOM, que a CSP permite. O único
`<style>` restante é o bloco fixo da área de rolagem do Radix; o hash dele
está na política, e o build falha se aparecer um bloco cujo hash não esteja
lá. O travamento de rolagem dos diálogos injetaria
um `<style>` com conteúdo variável: o build troca `react-style-singleton` por
um módulo vazio e as mesmas regras ficam em `app.css`. O `connect-src 'self'`
cobre o índice de busca. A política continua única no arquivo, o que o ajuste
de `connect-src` da instalação hospedada exige. A política não libera o beacon
do Web Analytics da Cloudflare, cuja injeção está desligada na zona
([deploy-producao.md](../operacao/deploy-producao.md#web-analytics-da-cloudflare)).

A página inicial anuncia só capacidades demonstradas, com a cobertura aceita
da [tabela de promessas](#promessas-e-evidências) (decisão do responsável em
18/10/2026, #85). Capacidade futura só aparece marcada como "em construção" ou
"previsto", sem números nem prazos. Essa decisão substitui a de 12/10/2026,
pela qual a página descrevia o produto completo, incluindo capacidades ainda em
construção; a versão das PRs #236 e #237 seguia a decisão anterior. O teste em
`tests/publicSite.test.ts` recusa na landing renderizada as promessas
retiradas: outros modelos fora da célula marcada como prevista, contagens de
cobertura nacional, nota autorizada, ambiente `production` e emissão nos
exemplos, captura anunciada a todos, backup e SLA, entre outras.

### Captura fiscal no site (#427)

Em 26/10/2026 o mantenedor aprovou a formulação pública da captura: "captura
fiscal real por empresa, com ativação pelo dono e sem manifestação". Na
landing, a lista "Na nuvem da Freecorps" diz "Captura de NF-e em produção para
a empresa que a ativa" e "Emissão com validade fiscal desligada".

A landing e os guias dizem só o que está provado, em tom factual: a captura
fiscal real de NF-e existe por empresa, em produção; quem administra a empresa
(Proprietário ou Administrador, os papéis que `captureRelease.enable` aceita)
a ativa no console, com o certificado A1 dela e o aceite dos termos; a
plataforma só lê a distribuição e não manifesta; a primeira captura real no
site foi de uma empresa piloto, em 22/10/2026
(evidência), sem nome de cliente.
Não há linguagem de lançamento nem promessa de disponibilidade geral, preço ou
plano. A captura no site segue a [ADR 0007](../adr/0007-captura-fiscal-no-site.md).
O guia da captura segue a decisão de 26/10/2026 da #442: só o Proprietário
aceita a perda de uma lacuna, com motivo, também na captura de integração.

O teste da landing exige os dois itens aprovados, que toda frase que fala de
captura nomeie a empresa, que "produção" só apareça junto da captura, que a
página diga "sem manifestação" e cite a empresa piloto, e recusa "disponível
para todas as empresas", "disponibilidade geral", "lançamento", manifestação
automática e captura de outros modelos. O teste dos guias recusa os textos
retirados ("ainda não capturou", "transporte fiscal desligado", a captura "Em
construção" na tabela da página inicial, a lacuna "em decisão") e confere que
`/docs/captura-nfe` cobre os códigos que a captura em produção mostra e a
decisão do Proprietário sobre a perda. Uma formulação nova muda este
parágrafo, os textos e o teste juntos.

A captura real não muda a emissão: a NFS-e continua só no sandbox, com o gate
de produção desligado e nenhuma nota real emitida
([ISSUANCE.md](ISSUANCE.md)). Landing e guias não dizem que a plataforma
emite em produção nem dão data para a prova em produção restrita (#197) ou
para a primeira nota real (#198); os dois testes recusam essas frases e datas
de novembro ou dezembro de 2026.

A página tem tema escuro único e figuras isométricas no estilo iso-glow (MIT, `LICENSES/iso-glow-MIT.txt`),
uma por módulo em `landing/figures/`, cada uma com o próprio CSS e, quando
reage a clique ou hover, um `.client.ts`. O plugin junta `landing/landing.css`,
`landing/sections/*.css` e `landing/figures/*.css` em `/landing.css`. O HTML
sai aceso no estado final e funciona sem JavaScript. `landing/client.ts`
acrescenta as demos, as interações das figuras e, em desktop com WebGPU, os
shaders do pacote `shaders`, carregados sob demanda, sem telemetria e em meia
resolução. As cenas ficam em `landing/shader-scenes.ts`; o plugin
`apps/console/shaders-plugin.ts` reduz o registro interno do pacote aos efeitos
que elas citam, no build e no `vp dev`, e falha se a versão instalada não for a
revisada (#456, medições em `docs/v1.0/evidence/456/`). O módulo não é pedido
em celular, com economia de dados, poucos recursos ou movimento reduzido.
Antes do shader, o hero mostra `public/landing/hero-field.png`, o
primeiro quadro do mesmo shader. Animações de figura pausam fora da tela e as
seções abaixo da dobra usam `content-visibility: auto`. O mapa de cobertura
usa contornos do Natural Earth (domínio público).
A CSP em `public/_headers` não permite estilo inline, e o teste em
`tests/publicSite.test.ts` recusa na landing atributos `style`, scripts e
travessões.
Toda animação colapsa sob `prefers-reduced-motion`.

O plugin atende desenvolvimento e todos os builds do console, incluindo
instalação própria. A geração não acessa o backend, não lê segredos e não
publica nada. O servidor local da instalação própria também resolve as
páginas da documentação sem extensão.

```powershell
bun run contracts:check --base origin/main
bun run console:build
node scripts/console/prove-public-site.mjs
```

A prova lê os arquivos compilados, sem executar JavaScript, confere em cada
página da landing e da documentação um `h1`, texto no `main`, ausência de
script inline, atributo `style` e travessão, links locais existentes e
nenhum chunk das telas de `apps/console/src/dev/`, como o protótipo e a
referência de componentes. Essas telas só existem no servidor de
desenvolvimento; o build recusa a apresentação fictícia mesmo por URL direta.
As jornadas reais do painel não foram substituídas por demos.

### Ajuda e condições de acesso (#519)

O mantenedor decidiu que o canal geral de ajuda é
`suporte@nfe.freecorps.com.br`, a caixa de
[suporte-email.md](../operacao/suporte-email.md). A página dona das condições
de acesso e do pedido de ajuda é `/docs/ajuda`, fonte
`apps/docs/content/docs/ajuda.mdx`, no grupo Começar: quem chega pela entrada
procura ali o que pode usar antes da primeira tarefa. A página inicial dos
guias a cita numa linha, e o rodapé da landing a lista na coluna Condições,
ao lado de licenças e da privacidade da consulta CNPJ.

A página só repete condições registradas: conta e organização abertas pelo
cadastro; importação e emissão simulada só no sandbox; a captura de NF-e como
único caminho em produção, por empresa, quando a Freecorps a oferece no
ambiente e `owner` ou `admin` a ativa, com consulta, exportação e webhooks dos
documentos capturados e plano atribuído pela Freecorps
([USAGE.md](USAGE.md#ambientes)); termos de uso e política de privacidade
publicados em 01/11/2026, em `/termos` e `/privacidade`, ligados no rodapé
([termos](../termos/README.md)); e o catálogo de planos desligado. Preços,
cotas e o Gratuito permanente foram aprovados em 27/10/2026
([PLATFORM-PLAN-PROPOSAL.md](PLATFORM-PLAN-PROPOSAL.md)), mas não são
ofertados, e a página não os cita: a liberação do catálogo e da oferta
(#549), os meios de pagamento (#556) e os termos (#428) ficam nomeados como
decisão do mantenedor pendente. Em 27/10/2026 o mantenedor decidiu que,
enquanto o catálogo estiver desligado, os pedidos de plano, como o da captura
em produção, vão ao canal geral de ajuda, que vale para todas as
organizações. Os níveis de suporte por plano da proposta (Gratuito com
documentação e comunidade, e-mail a partir do Intermediário) só passam a
valer com a liberação do catálogo (#549). Fora de `ajuda.mdx`, os guias não
citam o endereço: o `PLAN_REQUIRED` de `captura-nfe` e o pedido de mais
capacidade de `contrato#limites` ligam para `/docs/ajuda#pedir-ajuda`. A
primeira resposta segue a decisão de 27/10/2026 em
[suporte-email.md](../operacao/suporte-email.md): "respondemos assim que
possível, sem prazo garantido". Não há SLA. Os limites técnicos não são
repetidos: o dono deles é `contrato#limites`.

O pedido de ajuda leva `code`, `requestId`, `Idempotency-Key` quando houver,
ids devolvidos, ambiente e horário, e pede para não enviar XML, certificado,
senhas, chaves de API, segredos de webhook nem dados fiscais. Privacidade
(`privacidade@`) e segurança (`seguranca@`, [SECURITY.md](../../SECURITY.md))
continuam com finalidade própria, listadas lado a lado com o suporte. As
orientações de erro de `contrato`, `primeira-chamada` e
`importar-pelo-painel` apontam para `/docs/ajuda#pedir-ajuda`; o texto do
painel em `developer-quickstart.tsx` continua igual ao da tabela da primeira
chamada, porque o teste de paridade compara o texto sem os links. O teste
`publica ajuda e condições de acesso só com o que foi decidido` de
`tests/publicSite.test.ts` exige os três endereços e os links de entrada e
recusa preço, prazo de resposta e gratuidade permanente na página. A página
cita o endereço de suporte e entrou na `main` depois do ensaio da caixa em
27/10/2026 (passo 4 de
[suporte-email.md](../operacao/suporte-email.md#estado-em-27102026)).

## Indexação e publicação

Por padrão o candidato conserva `noindex`, `robots.txt` bloqueado e ausência
de sitemap. Para preparar o artefato indexável depois do aceite, o responsável
define `PUBLIC_SITE_ORIGIN` como a origem HTTPS final, sem barra final,
caminho, query, fragmento ou credenciais. Exemplo de build, sem deploy:

```powershell
$env:PUBLIC_SITE_ORIGIN = 'https://fiscal.example'
bun run console:build
Remove-Item Env:PUBLIC_SITE_ORIGIN
```

Isso gera canonical, sitemap e exceções exatas de `X-Robots-Tag` somente
para páginas públicas. Rotas de painel, login e arquivos não entram no sitemap.
O header geral `noindex` continua protegendo da indexação as rotas da SPA.
O fallback da SPA no Worker entrega o HTML inicial da raiz, inclusive o
canonical e meta públicos no opt-in. Nessas respostas o Worker grava
`X-Robots-Tag: noindex`, que prevalece sobre o meta menos restritivo. Ao iniciar, `entry.ts` remove o canonical e
troca o meta para `noindex`. O recibo HTTP registra o HTML antes dessa execução;
não deve ser confundido com o DOM depois de carregar o painel. Hospedagens
alternativas precisam preservar os headers, como faz o servidor de instalação.
Robots não é autorização: dados continuam protegidos pelo backend.
O build de instalação hospedada conserva essas exceções ao ajustar a CSP.

Conferir no destino real redirects de HTML, headers, canonical, sitemap,
assets, acesso direto ao painel e recuperação de conta antes de liberar
indexação. A configuração não dispara deploy nem autoriza tag, npm ou anúncio.
O plano de publicação permanece em [release.md](../operacao/release.md).

## Promessas e evidências

| Mensagem                                             | Evidência ou condição                                                                                                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Importação NF-e 55 sem certificado, XML → itens/JSON | Importação, consulta e quickstart.                                                                                                                                                      |
| SDK e receptor independente                          | Contrato e SDK; no npm desde 01/11/2026 (recibo).                                                                                                                                       |
| Webhooks assinados com retentativas                  | Entrega e negativos e ativação hospedada de 07/10; envio depende da instalação, sem garantia de ordem ou efeito exatamente uma vez.                                                     |
| Captura fiscal de NF-e por empresa, sem manifestação | Rodada de produção da #50 com avanço real do NSU e primeira captura no site, de uma empresa piloto, com recibo de lotes e hashes lido do deployment. Formulação aprovada em 26/10/2026. |
| Instalação própria                                   | Ensaio Docker, integrado pela #115; #82 encerrada em 05/10/2026 no escopo técnico local, sem backup fora do host nem custódia (#51). O repositório é público desde 03/11/2026.          |
| Licenças distintas                                   | [Matriz vigente](../../LICENSING.md), integrada pela #116; #83 conserva bloqueios de distribuição.                                                                                      |
| Contas novas e mesmo endereço                        | Corte concluído. Não há migração dos documentos descartados nem das sessões Clerk.                                                                                                      |

Não anunciar emissão com validade fiscal de nenhum modelo: a emissão NFS-e
aparece apenas como sandbox simulado, sem validade fiscal e com a produção
desligada. Também não anunciar emissão de NF-e ou NFC-e, cálculo tributário,
captura de NFS-e, importação de lotes NFS-e ABRASF (retirada em 02/11/2026,
[IMPORTS.md](IMPORTS.md#lotes-nfs-e-abrasf-retirados)), importação de NFS-e
nacional ou outros leiautes municipais,
outros modelos, XML garantido, histórico ilimitado, SLA, toda a stack como
FOSS, backup como garantia ou tempo de integração medido por piloto externo.
A conexão Stripe, sem evento real do Stripe, aparece só como em construção.
A captura de NF-e segue a formulação da seção [Captura fiscal no
site](#captura-fiscal-no-site-427), sem prometê-la a toda empresa. Exemplos são sintéticos e usam a importação no
sandbox. O nome comercial Freecorps Fiscal foi decidido em 18/10/2026.

Em 22/10/2026 o mantenedor decidiu escrever a documentação em `/docs` para a
1.0, com o repositório público e os pacotes no npm: os guias usavam
`npm install @freecorps/sdk` e apontavam para o GitHub sem a marca de privado.
A landing continuava identificando o GitHub e o SDK como privados até a
publicação, e o teste da landing conservava essa regra. Enquanto repositório e
pacotes não fossem publicados, essas instruções dos guias não funcionavam para
quem não tinha acesso. Essa apresentação foi substituída pela revisão abaixo.

Em 26/10/2026 o mantenedor revisou essa decisão de apresentação (#518). Os
comandos continuam nos guias, mas cada `npm install @freecorps/...`, o
`git clone` e os links para o repositório vêm depois de um `Callout` que diz,
na mesma seção, que o artefato continua privado ou não está no npm e que só
passa a valer quando for publicado pelo fluxo de distribuição próprio
(#83/#267). O caminho que funciona hoje sem acesso é a
[primeira chamada](../../apps/docs/content/docs/primeira-chamada.mdx), com o
XML sintético e `quickstart-curl.mjs` contra a API hospedada. A seção
`#disponibilidade` de `instalacao.mdx` resume o estado por artefato; landing,
SDK, webhooks, licenças e o link do GitHub no menu dos guias dizem o mesmo.
O teste `condiciona nos guias cada instalação, clone e link de artefato privado`
de `tests/publicSite.test.ts` conserva a regra. Os pacotes não estão em nenhum
registry: os comandos não funcionam para ninguém até a publicação. Os avisos
do SDK e dos webhooks apontam, de propósito, para o caminho do tarball que já
existia em `/developer/SDK.md`, gerado de `docs/v1.0/SDK.md`, para quem já
recebeu o tarball. Esta revisão não cria canal novo; o canal geral de ajuda e
acesso foi decidido na #519 ([Ajuda e condições de acesso](#ajuda-e-condições-de-acesso-519)).
Esta revisão é editorial e não autoriza publicar repositório nem pacote.

Consultas anônimas com curl, sem credenciais, em 27/10/2026 às 01:03 UTC
(26/10/2026, 22h03 em Brasília) para os artefatos privados e às 01:45 UTC
(22h45 em Brasília) para o caminho público. Os três arquivos do caminho público
responderam com o próprio tipo (`text/javascript`, `application/xml`,
`text/markdown`), não com o HTML da SPA:

| URL                                                           | Resultado |
| ------------------------------------------------------------- | --------- |
| `https://registry.npmjs.org/@freecorps%2fsdk`                 | 404       |
| `https://registry.npmjs.org/@freecorps%2fcontracts`           | 404       |
| `https://registry.npmjs.org/@freecorps%2ffiscal-core`         | 404       |
| `https://registry.npmjs.org/@freecorps%2ffiscal-nfe`          | 404       |
| `https://github.com/freecorps/freecorpsNFE`                   | 404       |
| `https://api.github.com/repos/freecorps/freecorpsNFE`         | 404       |
| `https://github.com/freecorps/freecorpsNFE/blob/main/LICENSE` | 404       |
| `https://nfe.freecorps.com.br/developer/quickstart-curl.mjs`  | 200       |
| `https://nfe.freecorps.com.br/examples/nfe-demonstracao.xml`  | 200       |
| `https://nfe.freecorps.com.br/developer/SDK.md`               | 200       |

Os textos completos de `LICENSE`, `LICENSING.md`, `NOTICE` e
`CONTRIBUICOES.md` não são servidos pelo site; só as licenças das fontes, em
`/fonts/`, e os avisos de terceiros gerados no build, em `/third-party-notices.txt`
e `/docs/third-party-notices.txt`. Por isso a página de licenças também marca a condição. Quando um
artefato for publicado pelo próprio fluxo, repetir sem autenticação a consulta
e o comando dele e retirar a condição só desse artefato. Publicar um pacote não
libera os outros nem o repositório.

Em 01/11/2026 `@freecorps/sdk`, `@freecorps/fiscal-core`, `@freecorps/fiscal-nfe`
e `@freecorps/fiscal-nfse` 0.1.0 foram publicados no npm (#83,
recibo). Consultas anônimas às 20:27
UTC: os quatro responderam 200 em `https://registry.npmjs.org/@freecorps%2f<nome>`;
`@freecorps/contracts` e o repositório continuaram em 404. Por isso os guias e a
landing deixaram de condicionar os comandos desses pacotes, e o tarball privado
saiu do roteiro do SDK. O teste passou a se chamar
`condiciona nos guias cada clone e link do repositório privado`: conserva o
`Callout` "Repositório ainda privado" e recusa nos guias a frase de que um
pacote ainda não está no npm.

Em 03/11/2026 o código passou ao repositório público
`freecorps/freecorpsNFE`, sem o histórico anterior, que fica num repositório
arquivado e privado (#267, decisão 6 do [registro de 26–29/10](../v1.0/EVIDENCE.md#decisões-do-mantenedor-de-2629102026)).
Consultas anônimas às 19:53 UTC (16h53 em Brasília):
`https://github.com/freecorps/freecorpsNFE`,
`https://api.github.com/repos/freecorps/freecorpsNFE` e
`https://github.com/freecorps/freecorpsNFE/blob/main/LICENSE` responderam
200, e `git clone` sem credencial funcionou; `@freecorps/contracts` continuou
em 404 no npm. Por isso os guias e a landing deixaram de condicionar o
repositório. Os `Callout` "Repositório ainda privado" de `instalacao.mdx` e
`licencas.mdx` saíram, o `git clone` e os links para o GitHub aparecem como
comandos e links que funcionam, e o link do GitHub no menu dos guias, no
rodapé e na seção de infraestrutura da landing não leva mais a marca
"(privado)". O teste passou a se chamar
`apresenta nos guias o repositório público, sem condição de acesso`: recusa
nos guias e na landing a frase de que o repositório é privado, um `Callout`
de acesso privado e a de que um pacote publicado não está no npm, e confere
que o guia de instalação mantém o clone e o link. `@freecorps/contracts`
continua privado no npm; isso é um pacote, não o repositório, e continua fora
dos guias.

## Aceites restantes

A [avaliação por artefato da #83](../licenses/DISTRIBUTION.md) conserva os
bloqueios sem evidência. Um futuro aceite isolado do SDK ou core não libera
XSDs, datasets, imagens ou o repositório integral. Atualizar a disponibilidade
anunciada somente para os artefatos efetivamente aprovados e publicados.

#74 concluída; #82 encerrada no escopo técnico local em 05/10/2026; #83 tem
código integrado, sem presumir encerramento do seu aceite. A #49 foi encerrada no escopo assistido aprovado pelo mantenedor,
com revisão humana e pendências técnicas concluídas;
o participante externo foi dispensado expressamente. #50 conserva prova
fiscal real. Desde 31/10, a [ADR 0011](../adr/0011-entregas-graduais.md)
define aceite na issue de cada entrega; a #51 conserva os registros
históricos. O merge não comprova publicação ou habilitação. A #85 prepara o material e não deve ser fechada automaticamente
por uma PR. [Material de lançamento](../v1.0/LAUNCH.md), com roteiro de demonstração
e checklist de divulgação, [rascunho das notas da versão](../v1.0/RELEASE-NOTES.md) e
evidências desta entrega.
