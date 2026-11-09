# E-mail de contas na validação

O backend usa Cloudflare Email Sending pela API REST, seguindo a direção já adotada
em outro projeto do mantenedor.
O remetente preparado é `acesso@validacao.fiscal.freecorps.com.br`, na conta
FreeCorps. O domínio e o token dedicado foram preparados em 10/09/2026.
Na instalação (`prod:elated-possum-295`), o remetente passou a ser
`acesso@nfe.freecorps.com.br` em 29/10/2026 (#428), no subdomínio `nfe`
habilitado no Email Sending desde a caixa de privacidade, para os clientes não
receberem e-mails de um domínio de validação. O teste de alerta da captura do
[run 40935388761](https://github.com/freecorps/freecorpsNFE-arquivo/actions/runs/40935388761)
saiu por ele com `delivery: "sent"`. O endereço não tem regra de recebimento:
uma resposta volta ao remetente.
O recibo de preparação está em evidence/63.
Envio e proxy foram exercitados na validação hospedada com um destinatário
autorizado, conforme os recibos locais. O mantenedor confirmou recebimento na caixa,
recuperação e acesso ao painel com a nova senha. Verificação da conta, recusa
da senha antiga, revogação da sessão e limites entre dois IPs distintos foram
conferidos no backend/HTTPS. Provas e limites do aceite.
O papel viewer dessa conta foi concedido pelo operador; não é efeito do cadastro.

## Configuração e isolamento

O manifesto continua com envio desligado. A configuração compartilhada passa
pela mesma política em runtime e no preflight de publicação. Modos parciais,
credenciais remanescentes com envio desligado e provedores desconhecidos falham.

| Variável no Convex de validação | Uso                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_MODE`                    | `disabled` inicialmente; `cloudflare` após ativação controlada                                                                      |
| `AUTH_PROXY_MODE`               | Ausente/`disabled` inicialmente; `signed` na ativação                                                                               |
| `AUTH_PROXY_SECRET`             | 32 bytes aleatórios codificados em 64 caracteres hexadecimais; mesmo valor no Worker                                                |
| `CLOUDFLARE_EMAIL_API_TOKEN`    | Token exclusivo com Account → Email Sending → Edit na conta FreeCorps                                                               |
| `ACCOUNT_EMAIL_FROM`            | Remetente acima, pertencente ao domínio habilitado                                                                                  |
| `ACCOUNT_EMAIL_RECIPIENTS`      | 1–10 endereços autorizados, separados por vírgula, guardados privadamente. Só no perfil `installation`, `*` tira a allowlist (#428) |

O Worker recebe somente `AUTH_PROXY_SECRET`. O token de e-mail fica no backend;
não vai para o bundle, navegador, logs, fixtures ou variáveis `VITE_*`. O escopo
Cloudflare é da conta: a aplicação restringe remetente, destinatários e endpoint.
Não usar token de outro projeto ou a credencial de publicação do Worker para enviar e-mail.

O GitHub environment `validation` guarda cópias exclusivas com os nomes
`VALIDATION_AUTH_PROXY_SECRET`, `VALIDATION_CLOUDFLARE_EMAIL_API_TOKEN`,
`VALIDATION_ACCOUNT_EMAIL_FROM` e `VALIDATION_ACCOUNT_EMAIL_RECIPIENTS`.
Esses secrets não são injetados no CI de PR nem ativam o runtime automaticamente.

Nos worktrees, `EMAIL_MODE=local`, sem segredos remotos. Setup reaplica a allowlist
local e os subprocessos descartam variáveis de contas/proxy/provedor herdadas.
O coletor `mail:inbox` continua interno e recusa ambientes hospedados.
Reenvio substitui o OTP local anterior do mesmo endereço normalizado e finalidade.
A limpeza é limitada a 100 registros por captura; a leitura mostra apenas o
OTP mais recente por finalidade mesmo diante de histórico anterior maior.
Convites de organizações permanecem independentes, com leitura limitada aos
20 mais recentes. Cada registro traz `expiresAt`; o expirado continua na caixa
local até a próxima captura apagá-lo, porque a query não lê o relógio.

## Caminho da requisição e limites

No build hospedado, o cliente chama `/api/auth/*` na origem do console. O Worker
aceita GET/POST, exige a origem do painel para escrita, lê `CF-Connecting-IP`
e substitui cabeçalhos de encaminhamento/assinatura fornecidos pelo cliente.
Ausência de metadados da borda ou IP válido retorna 503.

A assinatura HMAC cobre método, caminho/query, origem, IP, instante e hash do
corpo. O backend exige assinatura válida com tolerância de 30 segundos antes
de chamar Better Auth. Chamadas diretas sem assinatura são recusadas quando
`AUTH_PROXY_MODE=signed`; somente JWKS e descoberta OpenID ficam públicos.
O corpo tem limite de 32 KiB. O proxy não segue redirects de upstream e aceita
somente o destino Convex fixo. URLs de retorno são limitadas à origem do console.

O componente `@freecorps/convex-rate-limiter` aplica janelas fixas de um minuto,
atomicamente: cinco tentativas por IP/rota para login, cadastro e alteração
de credencial; três nas rotas OTP; trinta nas demais. Rotas desconhecidas usam
um único grupo. IPv6 usa /64; clientes atrás do mesmo NAT compartilham limite.
Uma troca de janela permite a soma dos limites adjacentes em um intervalo curto.
Pedidos de cadastro, reenvio e recuperação têm ainda três solicitações por
destinatário/minuto, somando todos os IPs, antes de consultar conta ou allowlist.
O mesmo limite vale para endereços existentes, ausentes e não autorizados.

Na instalação com clientes (`APP_ENV=installation`), `ACCOUNT_EMAIL_RECIPIENTS=*`
tira a allowlist: cadastro, recuperação, convite, troca de e-mail e aviso de
versão nova dos termos de uso escrevem a qualquer endereço, sob os mesmos
limites por IP e por destinatário. Com isso o cadastro fica aberto a qualquer
pessoa com e-mail verificado; o acesso aos dados continua dependendo de
organização e papel. O perfil `validation` recusa `*` e mantém 1 a 10 endereços. O
mantenedor decidiu em 29/10/2026 (#428) tirar a allowlist da instalação antes
da publicação dos termos, para o aviso de 30 dias chegar a todos os
proprietários e administradores. Gravar `*` no deployment é ação do operador.
Chaves do limitador usam hash; não guardam IP ou e-mail em texto aberto.

Enquanto o proxy está desligado, o backend ignora IPs recebidos e mantém um
grupo compartilhado por rota. Esse modo permite a transição com envio desligado;
não habilita cadastro hospedado. A prova de IP real na borda continua obrigatória
antes do aceite.

No modo local, somente GET `/api/auth/get-session`, `/api/auth/convex/token`
e `/api/auth/convex/jwks` usam janelas fixas de 60 segundos, alinhadas ao minuto
UTC, no mesmo componente. JWKS participa porque o Convex consulta as chaves
públicas para validar os JWTs renovados.
Cada rota admite 30 chamadas agregadas entre todas as sessões, inclusive
chamadas sem sessão válida. O consumo é atômico e persistido; cabeçalhos de IP,
cookies e query strings não criam outro orçamento. Excesso retorna 429 com
`Retry-After` e `X-Retry-After` em segundos até a próxima janela. A atividade
não adia essa janela e o saldo nunca acumula acima de 30.

Essas três leituras não consomem também o contador do Better Auth. As demais
rotas e métodos locais conservam suas regras anteriores, incluindo login
com cinco tentativas e OTP com três, reiniciadas após inatividade. A validade
de sessão, a verificação de e-mail e as tentativas por código não mudam.
O pacer E2E continua necessário para jornadas com login/OTP repetidos;
renovação dentro do orçamento já pode atravessar minutos sem pausa global.
Veja a prova HTTP da renovação local.

## Entrega, códigos e sessão

O adaptador usa endpoint fixo, timeout de cinco segundos, sem redirects e sem
repetição automática. Resposta 2xx só é aceita quando `success=true` e o
destinatário aparece em `queued` ou `delivered`, sem rejeição permanente.
Resposta do provedor tem limite de 32 KiB; seu conteúdo nunca vai para o cliente.
Aceitação em fila não é prova de entrega na caixa de entrada.

O fluxo aguarda o provedor. Better Auth pode absorver erros do callback; a
instância criada para cada requisição retém a falha para registrar somente
`ACCOUNT_EMAIL_UNAVAILABLE` nos logs operacionais privados. Para cadastro,
reenvio e pedido de recuperação hospedados, a resposta é sempre HTTP 202 com
`{requestAccepted:true,delivery:"unconfirmed"}`, inclusive para destinatário
não autorizado, conta ausente ou falha do provedor. Endereços não autorizados
não criam contas nem enviam e-mail. Respostas de erro na validação de OTP usam
400 genérico, preservando 429 por excesso de tentativas.

A tela não afirma criação da conta nem envio, e diz o que acontece em cada
caso sem dizer qual é: "Se ainda não houver uma conta com este e-mail e ele
estiver autorizado neste painel, enviamos um código de verificação para ele.
Se você já tem conta, entre ou recupere a senha." Nos perfis locais, que
aceitam qualquer e-mail, a frase omite a autorização. O reenvio e a
recuperação seguem o mesmo cuidado ("Se houver uma conta com este e-mail,
enviamos um código…"). O cadastro continua no mesmo cartão com o campo do
código e, verificado o e-mail, entra com a senha recém-digitada, mantida só na
memória do formulário até esse login (`emailAndPassword.autoSignIn` continua
`false`; o servidor não cria sessão na verificação). Se esse login falhar, ou
se a verificação for feita depois, em `/verify-email`, a tela leva ao login
com o e-mail já preenchido. O e-mail passa entre as telas em memória (ou por
`?email=`), nunca em armazenamento. Os formulários de conta usam `noValidate`
e mensagens em pt-BR por campo, em vez do balão do navegador. Não há outbox
nem retry automático de OTP nesta entrega; o 202 também não promete uma fila
de entrega. Se a mensagem não chegar, o usuário pode pedir outro código. Uma
chamada interrompida pode ter sido aceita pelo provedor. Cadastro pode criar a
conta antes de uma falha; a tela de verificação permite pedir novo código.

OTP tem oito dígitos, dez minutos, três tentativas e consumo único; persiste
como hash. Login exige verificação mesmo com envio desligado. Recuperação normal
retorna a mesma resposta para conta existente, ausente ou fora da lista, inclusive
durante falha do provedor e limitação por destinatário. A prova cobre status,
corpo e efeitos. A duração ainda pode variar por hash de senha e chamada ao
provedor; não alegar resistência a inferência estatística por tempo. Antes de
ampliar o cadastro além do teste controlado, isolar a entrega e equalizar esse
canal em uma revisão própria. O diagnóstico de envio fica restrito ao operador.

A troca de e-mail em Minha conta usa um código com as mesmas regras, enviado só
ao novo endereço, com o limite por destinatário antes de consultar a conta.
Endereço de outra conta não recebe código e tem a mesma resposta
([Atendimento a direitos](RIGHTS.md#correção)).
Sem e-mail de contas, `account.capabilities.emailChange` é `false` e o
console não oferece a troca, porque o código não chegaria ao novo endereço.

As contas sintéticas `@validation.invalid` são criadas/verificadas somente por
operação interna do mantenedor. A preparação inicial verificou as três fixtures
já existentes antes da publicação que passa a exigir verificação. A função
`provision:verifySyntheticAccount` recusa endereços reais; não substitui OTP.

O plugin crossDomain continua transportando `Better-Auth-Cookie` e
`Set-Better-Auth-Cookie`. Sua representação permanece em `localStorage`, acessível
a JavaScript. O proxy não transforma esse armazenamento em HttpOnly. A sessão
expira em sete dias, o JWT em 15 minutos; recuperação revoga sessões anteriores.
Cada consulta confere a sessão no banco, então logout e revogação negam na
hora, mesmo com um JWT ainda válido. A expiração nega na hora em mutations e
nas actions que conferem a sessão por conta própria; uma query, e a action que
confere acesso por uma query, não lê o relógio e, com a sessão vencida, ainda
responde até o JWT terminar, no máximo 15 minutos, porque o Better Auth só emite
token para sessão viva (#43).
Logout e mudanças de storage atualizam outras abas. Verificar também sessão
removida/expirada no backend, não apenas o estado visual da SPA.

## Ativação após integração

1. Integrar o PR na `main` após revisão e CI. Disparar a publicação coordenada
   de validação (Actions → Deploy validation, branch `main`) com envio/proxy
   desligados. Conferir `/build.json`, `/health`, smoke,
   persistência e ausência de outro escritor. Não publicar a branch de PR por fora.
2. Em janela de operação do ambiente de validação, adicionar `AUTH_PROXY_SECRET`
   ao Worker **freecorpsnfe-validation**, na conta **FreeCorps**. Preservar código,
   assets e outros bindings. Nunca usar `freecorpsnfe-backoffice`.
3. Conferir contas sintéticas verificadas. Gravar todas as variáveis da tabela
   juntas no deployment dev **modest-seal-118**. Usar configuração privada e a
   operação em lote do Convex; não aplicar uma sequência de flags incompletas.
   A API `/api/update_environment_variables` recebe `{changes:[{name,value}]}`;
   remover uma variável usa `{name}`. O CLI instalado implementa esse contrato.
   Não imprimir a requisição, a resposta com valores, nem usar segredos na linha
   de comando. Reexecutar o preflight e o smoke antes de enviar códigos.
4. Pela URL do painel, o mantenedor usa o destinatário acordado: cadastro, leitura
   da mensagem na própria caixa, verificação, login, reenvio e recuperação.
   Senhas e códigos são digitados diretamente nas telas, nunca no chat/issue.
   Conferir senha antiga, sessão anterior e logout entre abas.
5. Exercitar clientes/IPs reais, chamada direta ao Convex sem assinatura,
   cabeçalhos forjados e origem externa. Registrar SHA, UTC, resultados e recibo
   sanitizado do Cloudflare. Não capturar corpo, e-mail privado, OTP ou cookies.
6. Guardar os recibos sanitizados em `evidence/63` e atualizar [EVIDENCE.md](../v1.0/EVIDENCE.md).
   O aceite exige a jornada real de e-mail; instalação limpa e diagnóstico de
   falhas têm provas independentes.

Para suspender envio, aplicar `EMAIL_MODE=disabled` e remover token, remetente e
destinatários na mesma operação. Manter proxy assinado e a verificação de login.
Para desativar também o proxy, remover seu segredo e definir o modo desligado no
Convex juntos; depois remover o binding do Worker. O backend volta ao grupo
compartilhado, mantendo cadastro fechado. Rollback anterior à autenticação por e-mail exige retirar
primeiro as novas variáveis, pois a allowlist antiga as recusa. Rotacionar o
segredo do proxy em janela controlada: a troca não é atômica entre provedores.

## Reproduzir as provas locais

```powershell
bun run ci:test
node --experimental-strip-types scripts/proofs/prove-auth-worker.mjs
bun run platform:browser
```

O último comando exige `bun run dev` no worktree de plataforma. O runner do
Worker usa workerd/Miniflare do Wrangler travado no lockfile, com upstream e
metadados de borda sintéticos e zero acesso externo. Não substitui a prova HTTPS.
O CI também executa esse runner e preserva seu recibo sanitizado.

Tipos do Worker são verificados em programa TypeScript separado da SPA/Convex.
Para regenerar `worker-configuration.d.ts`, use uma `.dev.vars` local contendo
somente um `AUTH_PROXY_SECRET` sintético (64 zeros), nunca credenciais remotas:
`wrangler types --config apps/console/wrangler.json --include-runtime false
--env-interface ValidationWorkerEnv apps/console/worker-configuration.d.ts`.

Fontes consultadas: [Cloudflare REST](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/),
[cabeçalhos Cloudflare](https://developers.cloudflare.com/fundamentals/reference/http-headers/),
[componente rate limiter](https://www.convex.dev/components/rate-limiter),
[Better Auth OTP](https://better-auth.com/docs/plugins/email-otp) e código instalado
do Better Auth/componente Convex. Versões exatas estão no lockfile desta entrega.
