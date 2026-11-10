# E-mail pelo Ember Mail

O envio e as caixas de e-mail da plataforma passam pelo Ember Mail
([freecorps/mail](https://github.com/freecorps/mail)). É o serviço de e-mail
da Freecorps, sobre o Cloudflare Email Service. O
backend chama a API do serviço com `@freecorps/mail-sdk`. As caixas são lidas
e respondidas no próprio Ember Mail (`mail.freecorps.com.br` e o aplicativo),
não no console.

Antes desta mudança, o backend enviava direto pela API REST do Email Sending,
e um Worker próprio (`freecorpsnfe-privacy-mail`) guardava as mensagens
recebidas nas tabelas `privacy*`, lidas em `/console/privacidade`,
`/seguranca`, `/suporte` e `/operacao`. Os roteiros dessa caixa ficam como
registro em [privacidade](privacidade-email.md), [segurança](seguranca-email.md),
[suporte](suporte-email.md) e [operação](operacao-email.md).

## Envio

| O que                                                                      | Por onde                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------- |
| Códigos de conta, convites, aviso dos termos, do arquivo e do encerramento | `sendAccountMail` em `platform/convex/lib/accountMail.ts` |
| Alertas da captura e o teste do alerta                                     | `deliverMail`, pela mesma biblioteca                      |

O remetente continua em `ACCOUNT_EMAIL_FROM`. A allowlist
(`ACCOUNT_EMAIL_RECIPIENTS`), o proxy assinado e os limites por destinatário
não mudaram ([e-mail de contas](../plataforma/ACCOUNT-EMAIL.md)).

Quem opera escolhe o provedor em `EMAIL_MODE`. Só as variáveis do provedor
escolhido contam; as do outro são ignoradas, e `disabled` não aceita nenhuma.

| `EMAIL_MODE` | Provedor                                                                  | Variáveis                                                                                                        |
| ------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `mail`       | um Ember Mail, que cuida da fila, dos eventos de entrega e das supressões | `MAIL_API_URL` (HTTPS) e `MAIL_API_KEY`, uma chave `sending_access` restrita ao domínio do remetente             |
| `cloudflare` | o Email Sending de uma conta Cloudflare, chamado direto pela API REST     | `CLOUDFLARE_EMAIL_API_TOKEN` (Email Sending → Edit) e `CLOUDFLARE_EMAIL_ACCOUNT_ID`; sem a conta, a da Freecorps |
| `disabled`   | nenhum                                                                    | nenhuma                                                                                                          |

A Freecorps usa `mail`, com `MAIL_API_URL=https://mail-api.freecorps.com.br`.
Cada deployment tem a sua chave, mantida no cofre:

- **Instalação** (`prod:elated-possum-295`): projeto `nfe`, domínio
  `nfe.freecorps.com.br`, remetente `acesso@nfe.freecorps.com.br`.
- **Validação:** projeto `nfe-validacao`, domínio
  `validacao.fiscal.freecorps.com.br`, remetente
  `acesso@validacao.fiscal.freecorps.com.br`.

Uma chave de um domínio não envia de outro. A chave não vai para `VITE_*`,
logs, fixtures nem recibos.

O desfecho de um envio:

- **Aceito:** no Ember Mail, a mensagem está na fila, com um id, e a entrega,
  os bounces e as supressões ficam no serviço (`GET /emails/:id`). No Email
  Sending, cada destinatário voltou em `queued` ou `delivered`. Aceitação não
  prova leitura nem entrega final.
- **Recusado (4xx, ou bounce permanente no Email Sending):** nada saiu.
- **Sem resposta, timeout ou 5xx:** incerto. Pode ter sido aceito.

Os códigos de conta e os avisos têm cinco segundos e nenhuma retentativa,
como antes: a pessoa pede outro código. Os alertas têm quinze segundos, sem
retentativa, e levam a chave de idempotência `capture-alert/<id>` (o teste,
`capture-alert-test/<run>/<tentativa>`). Assim, uma repetição da mesma
chamada não vira um segundo e-mail no serviço.

## Caixas

| Endereço                           | Caixa no Ember Mail | Nome mostrado                  |
| ---------------------------------- | ------------------- | ------------------------------ |
| `privacidade@nfe.freecorps.com.br` | `nfe-privacidade`   | Freecorps Fiscal · Privacidade |
| `seguranca@nfe.freecorps.com.br`   | `nfe-seguranca`     | Freecorps Fiscal · Segurança   |
| `suporte@nfe.freecorps.com.br`     | `nfe-suporte`       | Freecorps Fiscal · Suporte     |
| `operacao@nfe.freecorps.com.br`    | `nfe-operacao`      | Freecorps Fiscal · Operação    |

São caixas compartilhadas do Ember Mail. Uma conta do serviço lê uma caixa
quando um admin a concede, e os admins leem todas. Papéis nas organizações do
console não dão acesso. O responsável e o substituto de D02 são os admins do
serviço. Quem mais receber uma caixa fica registrado no próprio serviço
(`GET /inbox/members`).

Cada conversa tem número, status (aberta, aguardando, encerrada, spam),
responsável e notas internas. As notas não vão ao remetente e são o
[registro restrito](../plataforma/RIGHTS.md#registro-restrito) do
atendimento. A resposta sai do endereço da caixa, com os cabeçalhos de
conversa, e a réplica volta para a mesma conversa. O remetente não é
considerado verificado. Conferir a identidade segue
[Atendimento a direitos](../plataforma/RIGHTS.md).

**Guarda:** as quatro caixas apagam as conversas encerradas e as de spam
1.826 dias (cinco anos) depois da última mudança de status ou mensagem.
Uma rotina diária, às 04:00 UTC, remove a conversa, as mensagens, os
originais `.eml` e os anexos. Reabrir ou escrever reinicia o prazo. É o
mesmo ciclo da caixa anterior, definido por caixa no serviço
(`retention: { closed_days: 1826, spam_days: 1826 }`).

Os alertas da captura (`FNFE_CAPTURE_ALERT_EMAIL`) continuam indo para
`operacao@` e para o [endereço de plantão](operacao-email.md#aviso-fora-do-console).
Trate cada alerta pelo [runbook](captura-fiscal.md#alertas-da-captura),
registre o que foi feito numa nota interna e encerre a conversa.

## Troca

Preparado no Ember Mail em 10/11/2026:

- os domínios `nfe.freecorps.com.br` (verificado, envio e recebimento) e
  `validacao.fiscal.freecorps.com.br` (só envio), com a assinatura dos
  eventos de entrega;
- as quatro caixas, com a guarda acima;
- as chaves `nfe` e `nfe-validacao`.

Um envio de teste de cada remetente chegou. As regras de recebimento dos
quatro endereços continuam apontando para o Worker `freecorpsnfe-privacy-mail`
até a troca.

O código novo aceita os dois provedores, então a publicação não depende da
troca das variáveis: o envio segue pelo Email Sending até o passo 4.

1. Mover as regras de `privacidade@`, `seguranca@`, `suporte@` e `operacao@`
   (e o subendereçamento) para o Worker `ember-mail-prod`. Esperar a fila R2
   do Worker antigo esvaziar.
2. Exportar as conversas, as notas e os originais das tabelas `privacy*` para
   o registro restrito, fora do snapshot (autorizado pelo mantenedor em
   10/11/2026), e esvaziar as tabelas. O schema novo não as tem, e o Convex só
   aceita retirá-las vazias. Os pedidos de D02 continuam no registro restrito
   pelos cinco anos.
3. Fazer o merge. O `Deploy production` publica o backend e o console.
4. Em cada deployment (instalação e validação), definir `MAIL_API_URL` e
   `MAIL_API_KEY`, trocar `EMAIL_MODE` para `mail` e remover
   `CLOUDFLARE_EMAIL_API_TOKEN`, `FNFE_PRIVACY_*`, `FNFE_*_OPERATOR_EMAILS`,
   `INBOUND_EMAIL_SECRET` e os segredos do GitHub correspondentes
   (`VALIDATION_MAIL_API_KEY` entra no lugar de
   `VALIDATION_CLOUDFLARE_EMAIL_API_TOKEN`). Rodar o teste do alerta
   (`scripts/deploy/capture-release.mjs alert_test`) e um código de conta na
   validação.
5. Desligar o Worker `freecorpsnfe-privacy-mail` e apagar o bucket R2
   `freecorpsnfe-privacy-mail`, já vazio. Revogar o token de Email Sending
   antigo.

Para voltar antes do passo 5, reverta as variáveis do passo 4 (o envio volta
ao Email Sending) ou o merge e as regras.
