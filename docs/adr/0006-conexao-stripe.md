# Conexão Stripe: emissão NFS-e a partir dos webhooks do Stripe

Data: 11/10/2026 · Status: **Proposta**, aguardando o aceite dos sócios

## Contexto

Um app consumidor da Freecorps cobra os clientes pelo Stripe (assinatura e compras avulsas) e
precisa emitir NFS-e da Freecorps a cada cobrança paga. Do jeito que a
plataforma estava, cada app consumidor teria de escutar o Stripe, guardar os
dados fiscais do tomador, montar o `POST /v1/issuances`, receber os webhooks da
plataforma e conciliar. Nada disso é específico desse app: qualquer
software que cobra pelo Stripe repetiria o mesmo trabalho.

Os eventos `invoice.paid` e `checkout.session.completed` do Stripe já trazem o
valor pago, a moeda, o nome, o e-mail, o endereço e as identificações fiscais
do cliente no momento da cobrança. Então dá para emitir sem chamar a API do
Stripe e sem guardar uma chave dele.

## Decisão

### 1. A conexão pertence a um projeto e a uma empresa

Uma **conexão Stripe** liga um projeto (a integração), uma empresa e um
ambiente a um endpoint de webhook do Stripe. Ela não é uma pessoa nem uma API
key; ela é uma **terceira origem de operação**, ao lado de `sourceKeyId` e
`sourceMembershipId`: `sourceStripeConnectionId`.

A autoridade da conexão é a concessão do projeto. Emitir exige
`documents:issue` e cancelar exige `documents:cancel` na concessão vigente da
empresa, no ambiente da conexão (`projectAccess`), como para uma chave. A
conexão grava as épocas do projeto e da concessão: revogar a concessão ou
desativar o projeto invalida a conexão, e conceder de novo não a reativa. O
worker revalida a conexão a cada tentativa (`executionAllowed`). As emissões
criadas pela conexão são do projeto: os eventos `issuance.*` vão aos webhooks
desse projeto.

Só owner e admin criam, configuram e desativam conexões, porque a conexão emite
nota sozinha. Quem lê as emissões da empresa no console lê também os eventos
recebidos.

### 2. O Stripe chama a plataforma direto

O endereço é `POST /v1/stripe/connections/{connectionId}/events`. O id da
conexão é só um seletor: a prova é a assinatura `Stripe-Signature` (HMAC
SHA-256 de `t.payload`, tolerância de 5 minutos), verificada contra o segredo
`whsec_…` que a pessoa copia do painel do Stripe e cola no console. O segredo
fica cifrado com a chave de webhooks da plataforma e não volta a aparecer.

A verificação usa Web Crypto, sem o SDK do Stripe.

### 3. Recebido não é emitido

Cada evento vira um registro (`stripeEvents`), deduplicado pelo id do evento
do Stripe. A cobrança é identificada pelo id da fatura (`in_…`) ou da sessão
(`cs_…`), e a chave de idempotência da emissão é `stripe:{id}`: reenviar o
evento, ou receber `checkout.session.completed` e depois
`checkout.session.async_payment_succeeded`, não gera outra nota.

Estados do evento:

- `issued`: virou emissão; o estado fiscal é o da emissão.
- `pending_data`: falta dado obrigatório do tomador. Nenhum número de DPS é
  reservado. Uma pessoa com escrita na empresa completa os campos no console e
  libera a emissão.
- `ignored`: não é cobrança que gera nota (valor zero, sessão não paga, cliente
  fora do mercado configurado, evento de teste em produção, tipo desativado).
- `failed`: a plataforma recusou o pedido (perfil, validação, gate). O código
  fica no registro; a pessoa corrige e tenta de novo.
- `refund`: reembolso total ou disputa perdida de uma cobrança que já virou
  nota, tratado pela política da conexão.

A resposta ao Stripe é 200 sempre que o evento foi registrado, mesmo quando ele
não virou nota: reenviar não muda o resultado. Antes do registro, o que o
Stripe não deve repetir recebe 4xx (400 para assinatura ou corpo inválido, 404
para conexão inexistente ou sem segredo, 413 para evento grande); só uma falha
interna responde 5xx, e o Stripe tenta de novo.

### 4. Mercado configurado pela conexão

A conexão diz se o software vende para cliente nacional, estrangeiro ou os
dois, com uma atividade do perfil NFS-e para cada mercado. Com os dois, o país
do endereço do cliente decide: `BR` é nacional, os demais são exportação.

- Nacional: CPF ou CNPJ vem dos tax ids `br_cpf` e `br_cnpj` do cliente; o
  município vem da tabela de municípios pela cidade e UF. Moeda BRL.
- Exportação: NIF vem do primeiro tax id não brasileiro. Sem NIF, a conexão
  segura o evento ou emite com "NIF não exigido", conforme a configuração.
  Moeda USD, CAD, EUR ou GBP, convertida pela PTAX como em toda emissão.

ISS retido não vem do Stripe: a conexão emite sempre sem retenção.

### 5. Reembolso é decisão do cliente

`charge.refunded` com reembolso total e `charge.dispute.closed` com disputa
perdida localizam a emissão pelo `payment_intent`. A conexão escolhe:

- `notify` (padrão): o evento marca a emissão como "cancelamento sugerido" no
  console. Uma pessoa decide e cancela.
- `cancel`: a plataforma pede o cancelamento sozinha (motivo 9, com o id da
  cobrança no texto), se a concessão tiver `documents:cancel`.

Reembolso parcial nunca cancela; só fica registrado.

### 6. Ambientes

A conexão do ambiente `production` só aceita eventos `livemode: true`. A de
`sandbox` aceita os dois, para que um app possa acompanhar cobranças reais com
transporte simulado antes de ligar a produção. Como o Stripe tem endpoints e
segredos separados para o modo de teste e o real, cada conexão recebe um modo
por vez; acompanhar os dois exige duas conexões. O gate de produção, o cofre e o
transporte não mudam.

## Consequências

- O app consumidor não precisa escutar o Stripe nem guardar dados fiscais.
  Basta cadastrar o endpoint no Stripe, pedir endereço e tax id no checkout e,
  se quiser, receber os webhooks `issuance.*`.
- O endereço do Stripe tem uma linha só; a plataforma separa rua e número por
  heurística e usa `S/N` quando não encontra o número. O bairro vem da linha 2
  ou fica "Não informado" no nacional e `N/A` na exportação.
- A plataforma passa a guardar nome, e-mail, endereço e tax id do cliente final
  em `stripeEvents`, com retenção `closure`, como os demais dados da
  organização.
- Eventos perdidos (endpoint desligado por mais de 3 dias) não são buscados na
  API do Stripe; a pessoa reenvia pelo painel do Stripe. Uma conciliação ativa
  exigiria guardar uma chave restrita do Stripe e fica para outra decisão.
