# Instalação própria e quickstarts

A plataforma usa `platform/convex` e `apps/console`. A biblioteca XML e o SDK
podem ser instalados separadamente.

O repositório é público desde 03/11/2026, em
https://github.com/freecorps/freecorpsNFE. Plataforma e motor usam a licença Freecorps 1.0; o SDK cliente usa MIT.
`@freecorps/freecorpsnfe-sdk` (antes `@freecorps/sdk`), `@freecorps/fiscal-core`, `@freecorps/fiscal-nfe` e
`@freecorps/fiscal-nfse` estão no npm, publicados a partir de 01/11/2026, com os schemas
incorporados sob as condições de [LICENSING.md](../../LICENSING.md).
Importar XML sintético não comprova autorização fiscal.

## Biblioteca sem Convex

Num projeto consumidor, `npm install @freecorps/fiscal-core @freecorps/fiscal-nfe`
instala as bibliotecas publicadas. Para testar tarballs do código-fonte, em um checkout da `main`, com Bun 1.4.0 e dependências próprias:

```powershell
bun run packages:build
bun run xml:prove
bun run sdk:prove
```

`xml:prove` empacota `fiscal-core` e `fiscal-nfe`, instala em um consumidor
temporário sem Convex e confere o resultado. O recibo em `.ci-results/nfe`
registra os resultados; a saída do comando informa o diretório do consumidor,
onde ficam os tarballs. Copie esses arquivos para outro
diretório e instale os dois com `npm install ./ARQUIVO_CORE.tgz ./ARQUIVO_NFE.tgz`.
Não copie `node_modules`. Exemplo no consumidor:

```js
import { readFileSync } from "node:fs";
import { processNfe } from "@freecorps/fiscal-nfe";
const result = processNfe(readFileSync("./nota-sintetica.xml"));
console.log(JSON.stringify(result));
```

O SDK segue [SDK.md](../v1.0/SDK.md), incluindo instalação pelo npm, curl,
TypeScript e receptor HMAC. O verificador de webhook não requer Convex ou
autenticação humana. As aplicações consumidoras precisam de URL e API key
restrita apenas para acessar o serviço HTTP.

## Servidor próprio local, do zero

Requisitos: Git, Docker com contêineres Linux e Compose, Node 22.23.4+ ou 24.22.1+,
Bun 1.4.0 e acesso à internet para baixar dependências e a imagem. O arquivo
[`versions.json`](../../deploy/selfhost/versions.json) fixa a imagem por digest
e identifica a revisão do servidor. `bun.lock` fixa os pacotes da aplicação.

```powershell
git clone --branch main https://github.com/freecorps/freecorpsNFE.git fiscal
cd fiscal
git rev-parse HEAD
bunx bun@1.4.0 install --frozen-lockfile
node --experimental-strip-types scripts/selfhost.mjs init minha-instalacao 4410 5410
node --experimental-strip-types scripts/selfhost.mjs up minha-instalacao
node --experimental-strip-types scripts/selfhost.mjs serve minha-instalacao
```

O clone não exige conta no GitHub, conta Convex,
Clerk, arquivo `.env.local` do mantenedor ou credenciais da Freecorps. O Bun
fixado pode ser usado por `bunx` sem alterar a instalação global.
Para validar um PR antes de sua integração, faça checkout da revisão do PR
antes de instalar as dependências e iniciar o setup.
Registre o SHA exibido. A antiga branch `feat/fiscal-platform-v1` conserva uma
integração histórica; não é a base atual de instalação.

Abra `http://localhost:5410/signup`. Cadastre uma conta sintética. Em outro
terminal, consulte o código no coletor administrativo:

```powershell
node --experimental-strip-types scripts/selfhost.mjs mail minha-instalacao conta@development.invalid
```

Verifique a conta, entre e crie uma organização. Escolha a empresa de
demonstração, crie um projeto e conceda acesso em sandbox. Gere uma API key
restrita a essa empresa, com `documents:import`, `documents:read` e
`webhooks:manage` se usar o receptor. Siga o [quickstart](../v1.0/SDK.md) com o XML
de `apps/console/public/examples/nfe-demonstracao.xml`.

Depois de publicar as funções, `up` chama `termsOfUseNotice:start`: com uma
versão dos termos de uso em vigor, o aviso de versão nova aos proprietários e
administradores vai ao coletor (`mail`, tipo `terms-of-use`). Uma falha dessa
chamada só aparece no log; o próximo `up` chama de novo, sem repetir avisos.

O setup não cria contas ou dados. Cada nome cria configuração e segredos em
`.selfhost/NOME`, que é ignorado pelo Git, e um volume Docker próprio. As
portas escolhidas devem estar livres; não pare outros servidores para usá-las.
Os listeners ficam em loopback. Não exponha esse perfil à rede: ele usa
`APP_ENV=development`, coletor local e cookies sem a política HTTPS hospedada.

`up` aplica ambiente antes de publicar funções, verifica zero crons e compila
o console. `FNFE_CRONS=off`, `FISCAL_ENV=disabled`, `PRODUCT_ENV=sandbox` e
`WEBHOOK_MODE=disabled` são obrigatórios. Cada início reaplica os gates locais.
O arquivo local recusa variáveis fora da allowlist do perfil; variáveis antigas
de integrações no deployment são removidas antes do push. Os secrets próprios
são preservados. Um gate editado no arquivo volta ao valor local obrigatório.
Desativar crons não cancela tarefas já agendadas. Nunca preencha este banco
com dados ou credenciais de produção.
Em um volume existente, o servidor inicia antes de o CLI reaplicar o ambiente.
Tarefas persistidas podem retomar nesse intervalo. Esses gates não tornam
seguro iniciar um volume de produção neste perfil; o ensaio parte de volumes
vazios e usa somente dados sintéticos.

O wrapper da imagem mantém as portas de loopback iguais dentro e fora do
contêiner. O backend precisa acessar seu próprio endpoint JWKS para validar
sessões. Um simples mapeamento `3411:3211` não satisfaz esse caminho.

Para parar, encerre o terminal do console e execute:

```powershell
node --experimental-strip-types scripts/selfhost.mjs stop minha-instalacao
```

O volume e as configurações permanecem. Não use `docker system prune` para
limpar um ensaio. Remova apenas o projeto e o volume que você conferiu, depois
de decidir explicitamente descartar seus dados. O ciclo dos worktrees continua
em [worktrees.md](../worktrees.md); este servidor Docker não pertence ao banco
anônimo gerenciado por `worktree:dev`.

O nome Docker inclui um hash do checkout. Copiar a configuração secreta para
outro checkout não adota nem sobrescreve o servidor anterior. Use portas fora
da faixa 3210–3609 reservada aos worktrees nativos. Se o DNS local não resolver
o túnel sintético, `FNFE_SELFHOST_DNS=1.1.1.1` antes de `init` configura apenas
o contêiner novo. `FNFE_PROOF_DNS=1.1.1.1` seleciona o resolvedor da sonda HTTPS
do runner. Nenhuma dessas opções altera o DNS do sistema operacional.

## Convex Cloud e servidor próprio hospedado

São duas operações diferentes. No Cloud, o operador cria um deployment dev
próprio e mantém suas credenciais. No servidor próprio, mantém processo,
banco, storage, TLS, capacidade, monitoramento e recuperação. O
[guia oficial](https://docs.convex.dev/self-hosting) descreve a infraestrutura;
o ensaio desta entrega usa SQLite e storage persistidos no volume Docker.
Alta disponibilidade, Postgres, S3 e um domínio público novo não são provas
implícitas desse ensaio local.

Para ambos, configure três origens explícitas: console HTTPS, API Convex e
HTTP actions. O operador prepara um arquivo secreto de seleção do CLI, fora
do Git. No servidor próprio ele contém `CONVEX_SELF_HOSTED_URL` e
`CONVEX_SELF_HOSTED_ADMIN_KEY`; no Cloud, `CONVEX_DEPLOY_KEY` exclusiva do
deployment escolhido. Nunca combine seletores de ambientes diferentes.

O perfil hospedado independente usa `APP_ENV=installation`. Ele exige HTTPS
e proxy assinado e conserva sandbox, fiscal desativado e zero crons.
O perfil `validation` continua fixo no ambiente da Freecorps. Não use
`validation:console:deploy` ou `validation:deploy` para a instalação
do operador.

Prepare `backend.env` privado com:

| Variável                                    | Valor e responsabilidade                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `APP_ENV`                                   | `installation`                                                               |
| `PRODUCT_ENV` / `FISCAL_ENV` / `FNFE_CRONS` | `sandbox` / `disabled` / `off`                                               |
| `SITE_URL`                                  | Origem HTTPS exata do console, sem barra final                               |
| `API_URL`                                   | Origem HTTPS exata da API REST servida pelo Worker                           |
| `WEBHOOK_MODE`                              | `disabled`; `https` somente para destinos controlados                        |
| `BETTER_AUTH_SECRET`                        | Segredo aleatório próprio, mínimo 32 caracteres                              |
| `AUTH_PROXY_MODE`                           | `signed`                                                                     |
| `AUTH_PROXY_SECRET`                         | 32 bytes aleatórios em hexadecimal, iguais no proxy e backend                |
| `FNFE_WEBHOOK_MASTER_KEY`                   | 32 bytes aleatórios em hexadecimal, exclusivos do banco                      |
| `FNFE_PLATFORM_CERT_KEYS`                   | Keyring versionado conforme [CERTIFICATES.md](../plataforma/CERTIFICATES.md) |
| `EMAIL_MODE`                                | `disabled` ou `mail`                                                         |

`CONVEX_SITE_URL` e `CONVEX_CLOUD_URL` são fornecidas pelo deployment. No
servidor próprio, configure as origens públicas no processo do servidor.
Não declare essas variáveis como variáveis da aplicação.

Para habilitar cadastro/verificação/recuperação hospedados, use um
[Ember Mail](https://github.com/freecorps/mail) do operador (código aberto,
MIT, sobre o Cloudflare Email Service da conta dele), com o domínio do
remetente verificado e uma chave `sending_access` desse domínio. Configure
`MAIL_API_URL` (HTTPS), `MAIL_API_KEY`, `ACCOUNT_EMAIL_FROM` e
`ACCOUNT_EMAIL_RECIPIENTS`, de um a dez destinatários autorizados, ou `*`
para escrever a qualquer endereço, com cadastro aberto a quem verificar o
e-mail. O modo desabilitado não conserva credenciais do provedor. Não há SMTP
genérico. Consulte [ACCOUNT-EMAIL.md](../plataforma/ACCOUNT-EMAIL.md)
para respostas uniformes, limites e prova de recebimento real.

Depois de conferir o alvo, na pasta `platform`, usando caminhos absolutos:

```powershell
node ../node_modules/convex/bin/main.js env set --from-file CAMINHO_BACKEND_ENV --force --env-file CAMINHO_SELETOR
node ../node_modules/convex/bin/main.js dev --once --typecheck disable --codegen disable --env-file CAMINHO_SELETOR
```

Compile os pacotes antes do push. O comando `dev --once` aqui usa o seletor
explícito, não cria um ambiente anônimo. Confira `/health`, origens e zero
crons no deployment escolhido depois da publicação.

Copie `deploy/selfhost/hosted.example.json` para um arquivo local e preencha
as quatro origens. `api` deve ser igual a `API_URL`. O build não publica nem
recebe secrets:

```powershell
node --experimental-strip-types scripts/selfhost.mjs build-hosted CAMINHO_CONFIG_PUBLICA
```

Copie `deploy/selfhost/wrangler.example.json` para
`deploy/selfhost/wrangler.local.jsonc`, ignorado pelo Git. Ajuste nome,
conta do operador e as três origens
em `vars`, mantendo a referência ao Worker e ao build. Associe ao Worker o
host do console e o de `API_ORIGIN`. Cadastre `AUTH_PROXY_SECRET` como secret
do Worker. O proxy confere origem e IP da borda, remove cabeçalhos de
encaminhamento fornecidos pelo cliente e assina cada pedido. O backend recusa
autenticação e chamadas REST que contornem o proxy.

Antes de publicar na conta própria, rode o typecheck do Worker e o dry-run:

```powershell
node scripts/build/typecheck.mjs -p deploy/selfhost/tsconfig.json
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config CAMINHO_WRANGLER_LOCAL
```

A publicação remota e o envio real de e-mail exigem alvo e credenciais do
operador. Os testes do perfil hospedado não equivalem a essa publicação.

Nenhum script publica esta instalação, então o aviso de versão nova dos
termos de uso ([Termos](../termos/README.md#aviso-por-e-mail)) não sai
sozinho. Depois de publicar backend, console e Worker, quando o console já
serve a versão nova, chame `termsOfUseNotice:start` no mesmo deployment, na
pasta `platform`:

```powershell
node ../node_modules/convex/bin/main.js run termsOfUseNotice:start --env-file CAMINHO_SELETOR
```

Sem versão em vigor, `start` devolve `none`; com `EMAIL_MODE=disabled`,
`disabled`; nos dois casos, nada é registrado. Com `EMAIL_MODE=mail`, o
aviso sai pelo Ember Mail para os endereços de `ACCOUNT_EMAIL_RECIPIENTS`, ou
para todos com `*`. Com uma lista, os outros proprietários e administradores
contam em `withheld` e não recebem o e-mail dessa versão, nem depois; o aviso do console continua valendo
([linhas do aviso](../plataforma/ORGANIZATIONS.md#aviso-dos-termos-linhas-presas)).
Repetir a chamada é seguro: cada organização recebe o aviso de uma versão no
máximo uma vez. Não há coletor nesta instalação.

## Atualização e recuperação

API keys e segredos de assinatura dos destinos têm rotação pelas APIs do
produto. Para webhook, use `rotate-secret` e a janela de coexistência descrita
em [WEBHOOKS.md](../plataforma/WEBHOOKS.md). Trocar `FNFE_WEBHOOK_MASTER_KEY` diretamente
inutiliza os registros cifrados: não há comando de migração dessa mestra neste
roteiro. Preserve-a na custódia e planeje a recifragem antes de substituí-la.

Para certificados, adicione uma nova versão ao keyring e reempacote os
envelopes pelo fluxo de [CERTIFICATES.md](../plataforma/CERTIFICATES.md). Só retire versões
antigas depois de conferir registros e backups retidos. Para
`BETTER_AUTH_SECRET`, programe uma janela de manutenção, substitua o secret
e valide novo login, recuperação e recusa de cookies anteriores. Para
`AUTH_PROXY_SECRET`, suspenda o acesso ao console durante a troca coordenada
no Worker e backend; teste o proxy assinado antes de reabrir. Secrets antigos
de backups permanecem sob custódia restrita, separados do snapshot.

Antes de atualizar, registre SHA da aplicação, digest/revisão do servidor,
versões de Node/Bun e schema. Exporte banco **com storage** para um local
restrito. Custodie separadamente os secrets e suas versões; o snapshot Convex
não exporta variáveis de ambiente. O volume Docker sozinho não substitui uma
cópia fora do host. Exporte também os componentes de autenticação, conforme
o comando de export do deployment, e confira o login depois do restore.

Atualize primeiro em uma instalação descartável. Instale com lockfile,
publique backend compatível, compile frontend e repita a jornada. Registre
as revisões anterior e nova; reaplicar o mesmo SHA não prova uma migração.
Mudanças incompatíveis usam expansão, migração e contração. M6 tem aceite
próprio. Para trocar o servidor, revise as notas da versão e repita a prova
com a imagem por digest antes de substituir o volume em uso.

Restaure somente em destino vazio, com gates desativados. Depois confira
relações, JSON, originais por hash, API key restrita e login. Recupere as
chaves pela custódia separada, preservando as versões usadas por backups
retidos. Não substitua uma chave ausente por outra sob o mesmo identificador.
O [runbook de restauração](restauracao.md) cobre também certificados cifrados,
rotação, chave incorreta e contexto adulterado.

Se a publicação falhar parcialmente, mantenha transporte desativado e
confira backend e frontend antes de retentar. Rollback de código não desfaz
migração nem efeitos externos. Defina cadência, retenção, responsáveis e
RPO/RTO com operação; os tempos locais medidos não são SLA.

Roteiro automatizado, apenas nas instalações locais sintéticas:

```powershell
node --experimental-strip-types scripts/deploy/prove-selfhost.mjs prepare ORIGEM
bun run sdk:prove
node --experimental-strip-types scripts/deploy/prove-selfhost.mjs journey ORIGEM CAMINHO_CLOUDFLARED
# Em checkout exclusivo do ensaio, trocar para a revisão compatível aprovada.
git switch --detach REVISAO_APROVADA
bunx bun@1.4.0 install --frozen-lockfile
node --experimental-strip-types scripts/deploy/prove-selfhost.mjs upgrade ORIGEM
node --experimental-strip-types scripts/deploy/prove-selfhost.mjs restore ORIGEM DESTINO_VAZIO
```

O servidor do console precisa estar ativo na origem e no destino. O receptor
expõe somente `/hook` e `/ready` em HTTPS temporário, nunca o banco ou console.
O destino precisa ter sido configurado no SHA do snapshot com volume vazio.
Preserve os recibos da revisão anterior antes de repetir qualquer modo do
runner, que escreve no mesmo nome de arquivo. A atualização de
`a9445db` para `a14318f`, a instalação limpa atual e o restore sem a origem
estão na revalidação de 05/10/2026.
O runner usa dados sintéticos, desliga o destino webhook e restaura o gate ao
terminar. Recibos públicos ficam em `.ci-results/82`; credenciais ficam em
`.selfhost`, fora do Git. O snapshot fica em um diretório temporário exclusivo
`fnfe82-snapshot-*`, separado dos secrets; seu caminho fica no estado privado
da prova. O upgrade grava uma cópia das três chaves de aplicação em
`fnfe82-custody-*`, vinculada ao hash do snapshot, preservando todas as versões
do keyring. Transfira ambas as cópias e o estado privado `proof-private.json`
para custódia restrita, em locais separados. Esse estado contém credenciais
sintéticas de login e os hashes esperados; ele também não pode ser público.
O restore verifica integridade, versão do código e imagem antes de escrever
no destino. Recupera a cópia de custódia sem consultar o servidor ou o
`backend.env` da origem. Pode-se parar a origem depois do upgrade para provar
esse caminho. Perda ou divergência da custódia interrompe o ensaio antes do import.
Remova somente os diretórios específicos criados
depois do ensaio. Preserve recibos de falha antes de repetir.

A prova da instalação própria compara leituras públicas de organização, projeto e documento,
originais por hash e login após atualização e recuperação. A inspeção completa
das relações internas e certificados permanece na prova da restauração.

## Licenças e limites

A licença do servidor Convex é distinta da aplicação, SDK, dependências e
schemas fiscais. A revisão fixada do servidor deve ser conferida contra seu
[LICENSE](https://github.com/get-convex/convex-backend/blob/0cf49cbf8c4b7e22e631ceda9b5111f6cccbcd49/LICENSE.md).
A revisão fixada usa FSL-1.1-Apache-2.0, com conversão futura definida no texto.
A decisão final da preparação da distribuição aplica a licença Freecorps 1.0 à plataforma e ao motor,
com exceção MIT explícita para o cliente SDK e contratos de integração.
Isso não relicencia o servidor, schemas ou dependências. A
[matriz de distribuição](../../LICENSING.md) registra os bloqueios restantes,
incluindo schemas incorporados e condições de outros formatos de distribuição.

O operador responde por atualizações, TLS, acessos administrativos, custódia,
backups externos, recuperação, capacidade e e-mail. Este roteiro não habilita
emissão fiscal, não comprova operação fiscal real e não declara toda a stack
FOSS. Evidências da instalação própria registram o que foi executado.
