# Conexão Stripe

A conexão Stripe emite NFS-e a partir das cobranças pagas no Stripe, sem código
no app consumidor. O Stripe manda os webhooks direto para a plataforma, que
confere a assinatura, lê o cliente e o valor do próprio evento e pede a emissão
em nome do projeto. A decisão está na
[ADR 0006](../adr/0006-conexao-stripe.md); a emissão segue
[ISSUANCE.md](ISSUANCE.md), com o mesmo gate de produção, cofre e transporte.
No perfil hospedado a nota sai pelo transporte simulado, sem validade fiscal.

A cobrança dos planos da própria Freecorps por cartão é outra integração, com
conta, chave e endpoint próprios: [BILLING.md](BILLING.md).

## Peças

| Peça                                                      | Onde                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Tabelas `stripeConnections` e `stripeEvents`              | `platform/convex/lib/stripeSchema.ts`                                           |
| Assinatura, leitura do evento e montagem do pedido (puro) | `platform/convex/lib/stripeEvent.ts`                                            |
| Rua e número da linha única do endereço (puro)            | `platform/convex/lib/stripeAddress.ts`                                          |
| Acesso da conexão como origem de operação                 | `platform/convex/lib/stripeAccess.ts`                                           |
| Console e processamento                                   | `platform/convex/stripe.ts`                                                     |
| Endpoint `POST /v1/stripe/connections/{id}/events`        | `platform/convex/stripeRest.ts`                                                 |
| Tela                                                      | Projeto → Stripe, em `apps/console/src/stripe.tsx` e nos módulos `stripe-*.tsx` |

## Configurar

Só owner e admin que gerenciam o projeto criam e alteram a conexão, porque ela
emite sozinha. Antes:

- a empresa tem perfil NFS-e com e-mail do prestador e as atividades que a
  conexão vai usar;
- a concessão do projeto para a empresa tem `documents:issue` no ambiente, e
  `documents:cancel` se o reembolso for cancelar a nota.

Passos no console (Projeto → Stripe):

1. Criar a conexão: empresa, ambiente, para quem o software vende (nacional,
   exterior ou os dois) e a atividade de cada mercado.
2. No Stripe, em Developers → Webhooks → Add endpoint, colar a URL
   `https://api.nfe.freecorps.com.br/v1/stripe/connections/{id}/events` e
   selecionar os eventos:
   - `invoice.paid`
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `charge.refunded`
   - `charge.dispute.closed`
3. Copiar o "Signing secret" (`whsec_…`) do endpoint e colar no console. O
   segredo fica cifrado (`FNFE_WEBHOOK_MASTER_KEY`, contexto `stripe:{id}`) e
   não volta a aparecer.
4. Enviar um evento de teste. A tela mostra o último evento recebido e a última
   falha de assinatura.

Salvar a conexão grava as épocas do projeto e da concessão em vigor. Revogar a
concessão ou desativar o projeto para a conexão; conceder de novo só a reativa
quando um owner ou admin salvar de novo.

### Configuração

| Campo                                        | Efeito                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `market`                                     | `domestic`, `export` ou `both`. Com `both`, o país do endereço do cliente decide: `BR` é nacional. Cliente fora do mercado é ignorado (`OUT_OF_MARKET`). |
| `domesticActivityCode`, `exportActivityCode` | Atividade do perfil NFS-e de cada mercado; o `cIndOp` vem dela.                                                                                          |
| `description`                                | Texto da nota. `{itens}`: descrições das linhas da fatura; `{cobranca}`: número da fatura ou id do Stripe; `{periodo}`: competência `MM/AAAA`.           |
| `issRate`                                    | Alíquota de ISS das notas nacionais de empresa fora do Simples. Nunca vai na exportação.                                                                 |
| `invoices`, `checkouts`                      | Faturas pagas (assinaturas) e Checkout avulso pago.                                                                                                      |
| `foreignWithoutNif`                          | Cliente estrangeiro sem tax id: `hold` segura o evento; `not_required` emite com `nifAbsence` 2.                                                         |
| `refundPolicy`                               | `notify` marca "cancelamento sugerido"; `cancel` pede o cancelamento sozinha.                                                                            |

## O que precisa vir do Stripe

A plataforma não chama a API do Stripe. Tudo vem do evento:

| Dado                    | Fatura (`invoice.paid`)           | Checkout (`checkout.session.*`)   |
| ----------------------- | --------------------------------- | --------------------------------- |
| Valor e moeda           | `amount_paid`, `currency`         | `amount_total`, `currency`        |
| Nome e e-mail           | `customer_name`, `customer_email` | `customer_details.name`, `.email` |
| Endereço                | `customer_address`                | `customer_details.address`        |
| Tax ids                 | `customer_tax_ids`                | `customer_details.tax_ids`        |
| Ligação com o reembolso | `payment_intent` ou `payments`    | `payment_intent`                  |

Exportação exige nome, linha 1, cidade, CEP/postal code e país; estado e linha 2
ficam `N/A` quando faltam. O NIF é o primeiro tax id não brasileiro. Moeda USD,
CAD, EUR ou GBP.

Nacional exige nome, CPF ou CNPJ (`br_cpf` ou `br_cnpj`), linha 1, CEP, cidade e
UF. O CPF ou CNPJ chega como foi digitado no Stripe; a emissão automática tira a
máscara e passa as letras do CNPJ alfanumérico para maiúsculas, como o console,
e o servidor valida o resultado. Dígitos que não conferem falham o evento com
`ISSUANCE_TAKER_DOCUMENT_INVALID`. O município sai da tabela de municípios pela cidade e UF; sem um resultado
único, o evento fica pendente. Moeda BRL. Bairro vem da linha 2 ou fica "Não
informado".

O número sai da linha 1: "Rua das Flores, 120" e "548 Market St" separam;
sem número, o pedido automático usa `S/N`. A tela de completar o tomador usa a
mesma regra (`platform/convex/lib/stripeAddress.ts`), mas deixa o número em
branco para a pessoa preencher. O CPF ou CNPJ digitado nessa tela aceita o CNPJ
alfanumérico: o console tira a pontuação e passa as letras para maiúsculas, como
no formulário de emissão, e o servidor valida o resultado.

No app que cobra:

```ts
// Checkout avulso
await stripe.checkout.sessions.create({
  mode: "payment",
  billing_address_collection: "required",
  tax_id_collection: { enabled: true },
  customer_update: { address: "auto", name: "auto" }, // com customer existente
  // ...
});
```

A fatura de assinatura copia o endereço e os tax ids do Customer quando é
finalizada. O Customer precisa tê-los antes disso, por exemplo com
`billing_address_collection: "required"` e `tax_id_collection` no Checkout em
modo `subscription`.

## Eventos

Cada evento com assinatura válida vira uma linha de `stripeEvents`,
deduplicada pelo id do Stripe. A resposta é 200 depois do registro, seja qual
for o resultado; 400 para assinatura ou corpo inválido; 404 para conexão sem
segredo ou inexistente; 413 (`EVENT_TOO_LARGE`) para corpo acima de 1 MB
(`MAX_EVENT_BYTES`). Tipos fora da lista recebem 200 e não são gravados.

| Estado         | Significado                                                 |
| -------------- | ----------------------------------------------------------- |
| `queued`       | Registrado, a caminho da emissão.                           |
| `issued`       | Virou emissão; o estado fiscal é o da emissão.              |
| `pending_data` | Falta dado do tomador (`missing`). Nenhum número reservado. |
| `ignored`      | Não gera nota (`code`).                                     |
| `failed`       | A emissão recusou o pedido (`code`).                        |
| `refund`       | Reembolso ou disputa, com o que foi feito (`code`).         |

Códigos de `ignored`: `ZERO_AMOUNT`, `NOT_PAID`, `CHECKOUT_NOT_PAYMENT` (o
checkout de assinatura gera a nota pela fatura), `OUT_OF_MARKET`,
`LIVEMODE_MISMATCH`, `TRIGGER_DISABLED`, `DUPLICATE_CHARGE`,
`CONNECTION_DISABLED`, `EVENT_MALFORMED`.

Códigos de `failed`: `STRIPE_ACTIVITY_MISSING`, `STRIPE_CURRENCY_UNSUPPORTED`,
`NOT_FOUND` (conexão sem a concessão em dia) e qualquer código da emissão
([ISSUANCE.md](ISSUANCE.md#códigos-de-erro)).

Códigos de `refund`: `PARTIAL_REFUND`, `DISPUTE_NOT_LOST`, `NO_ISSUANCE`,
`CANCEL_SUGGESTED`, `CANCEL_QUEUED`, `CANCEL_REQUESTED` ou o código da recusa
do cancelamento. A linha da cobrança ganha `refundAction`: `suggested`,
`requested` ou `failed`.

A chave de idempotência da emissão é `stripe:{in_…|cs_…}`, no namespace do
projeto. Depois de uma rejeição do fisco, "Tentar de novo" usa
`stripe:{id}:{n}`, porque o número rejeitado já foi gasto. O cancelamento usa
`stripe-cancel:{ch_…|dp_…}` com motivo 9.

### Liberar um evento

Uma pessoa com escrita na empresa (`owner`, `admin`, `operator`) completa o
tomador de um evento pendente ou com falha (`stripe.completeEvent`) ou tenta de
novo (`stripe.retryEvent`). A emissão continua saindo sob a concessão da
conexão, e quem liberou fica em `completedBy`.

## Ambientes

A conexão de `production` só aceita `livemode: true`. A de `sandbox` aceita os
dois, para acompanhar cobranças reais com transporte simulado. O modo de teste e
o real do Stripe têm endpoints e segredos separados, então cada conexão recebe
um modo por vez; para os dois, crie duas conexões.

## Retenção

`stripeConnections` e `stripeEvents` são `closure`. O encerramento da
organização desativa as conexões e, ao fim da janela, apaga conexões e eventos.

## O que não está provado

- Nenhum evento real do Stripe chegou à plataforma; os testes usam eventos
  sintéticos assinados (`platform/convex/stripe.test.ts`).
- O formato de `invoice.paid` muda com a versão da API do endpoint; a leitura
  aceita `payment_intent` e `payments`.
- Um evento perdido (endpoint fora do ar por mais de 3 dias) não é buscado no
  Stripe; reenvie pelo painel do Stripe.
