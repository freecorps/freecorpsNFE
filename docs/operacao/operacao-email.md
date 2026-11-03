# E-mail de operação

Caixa interna da Freecorps para os alertas da captura fiscal, acompanhada
pela [#463](https://github.com/freecorps/freecorpsNFE-arquivo/issues/463). O
endereço é `operacao@nfe.freecorps.com.br`, no mesmo subdomínio das outras
caixas. A caixa é lida em `/console/operacao`.

`FNFE_CAPTURE_ALERT_EMAIL` aponta para ela, e não para caixas pessoais. Em
28/10/2026, o mantenedor decidiu receber os alertas no console: quem os lê
muda pela lista de operadores, sem trocar o destino do Convex, e cada alerta
fica guardado com a conversa e as notas internas. A caixa não avisa ninguém
quando chega um alerta: um operador precisa abrir o console.

A caixa reaproveita o fluxo da [caixa de privacidade](privacidade-email.md),
como as de [segurança](seguranca-email.md) e de [suporte](suporte-email.md):
o mesmo Worker `freecorpsnfe-privacy-mail`, a mesma fila R2, as mesmas
tabelas `privacy*` e o mesmo envio pela Cloudflare. Cada conversa pertence a
uma caixa. Os operadores de uma caixa não leem, respondem nem baixam
mensagens das outras.

## Diferenças em relação à privacidade

| Item                  | Operação                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| Endereço              | `operacao@nfe.freecorps.com.br`; respostas voltam por `operacao+t_<token>@nfe.freecorps.com.br`                 |
| Operadores            | `FNFE_OPERATION_OPERATOR_EMAILS` no deployment Convex. Vazia não autoriza ninguém.                              |
| Remetente da resposta | `Freecorps Fiscal · Operação`                                                                                   |
| Console               | `/console/operacao`, item **Operação** em Plataforma                                                            |
| O que chega           | Os alertas da captura (`attention`, `stalled`, `quiet`, `gap`, `certificate`, `supervisor`) e o teste do e-mail |
| Guarda                | Cinco anos após encerrar a conversa, o ciclo das outras caixas, até decisão do mantenedor                       |

Os alertas saem de `ACCOUNT_EMAIL_FROM`, que não recebe resposta. Não
responda a um alerta pelo console: trate-o pelo
[runbook da captura](captura-fiscal.md#alertas-da-captura), registre o que foi
feito em notas internas e encerre a conversa. O e-mail traz tipo, código e
ids, sem CNPJ nem nome; confira a empresa pela
[lista](captura-fiscal.md#listar-as-empresas-liberadas) antes de agir.

`INBOUND_EMAIL_SECRET`, `FNFE_PRIVACY_SEND_MODE`,
`FNFE_PRIVACY_EMAIL_ACCOUNT_ID` e `FNFE_PRIVACY_EMAIL_API_TOKEN` valem para as
quatro caixas. Cada operador precisa de uma conta Better Auth com o e-mail
verificado.

## Estado em 28/10/2026

A caixa está ativa.

- Passo 1: `FNFE_OPERATION_OPERATOR_EMAILS` configurada em
  `prod:elated-possum-295` com duas contas corporativas da Freecorps. O site
  passou a servir `6e009bc` pelo dispatch do dono (run 40700281856), e o
  Worker `freecorpsnfe-privacy-mail` foi republicado da `main`, versão
  `68d3f201-6a33-429b-a5f1-6474c16cf47a`.
- Passo 2: o mantenedor informou em 28/10/2026 que criou a regra de Email
  Routing de `operacao@nfe.freecorps.com.br`.
- Passo 3: `FNFE_CAPTURE_ALERT_EMAIL=operacao@nfe.freecorps.com.br` gravada
  no site.
- Passo 4: o [run 40701209624](https://github.com/freecorps/freecorpsNFE-arquivo/actions/runs/40701209624)
  de `capture-alert-test.yml` passou com `delivery: "sent"` às 13:57:30 UTC.
  A conversa com o run no assunto entrou na caixa `operation` às
  13:57:35 UTC
  ([registro na #463](https://github.com/freecorps/freecorpsNFE-arquivo/issues/463#issuecomment-6470963411)).
  O teste não foi feito com alerta de empresa, e a recusa para operador de
  outra caixa e para conta cliente fica com os testes automáticos da #582.

## Ativação

Os passos 1 a 4 da [ativação da privacidade](privacidade-email.md#ativação)
(backend, Worker, Email Sending e subdomínio `nfe`) servem também a esta
caixa. Depois do merge e da publicação, o mantenedor:

1. Configura `FNFE_OPERATION_OPERATOR_EMAILS` no backend publicado, só com
   contas corporativas. Confere que um operador só de outra caixa e uma conta
   cliente não veem a caixa. Depois publica o Worker a partir da `main` com
   `bun run deploy:mail`; a configuração não muda.
2. Em Email Routing, cria a regra literal de `operacao@nfe.freecorps.com.br`
   com ação **Send to a Worker**, destino `freecorpsnfe-privacy-mail`.
   Confere que `operacao+t_<token>@nfe.freecorps.com.br` segue a mesma regra.
   Não habilita catch-all.
3. Grava `FNFE_CAPTURE_ALERT_EMAIL=operacao@nfe.freecorps.com.br` no
   deployment do site.
4. Roda o [teste do e-mail dos alertas](captura-fiscal.md#testar-o-e-mail-dos-alertas)
   e confere que a mensagem chega em `/console/operacao`, com o run no
   assunto. Registra na #463 o run, o `sentAt` e o horário de chegada, sem
   conteúdo nem endereços pessoais.

## Falha e recuperação

Fila, redelivery de `failed/`, coleta de originais sem dono e restore seguem
a [caixa de privacidade](privacidade-email.md#falha-recuperação-e-retenção).
Um alerta que não chega à caixa continua no log do Convex (`capture_alert`)
e na lista da captura; a caixa não é a única fonte dos alertas.
