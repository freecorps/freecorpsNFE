# E-mail de suporte

> **Aposentado.** Esta caixa passou para o Ember Mail, com o envio da
> plataforma: veja [E-mail pelo Ember Mail](email.md). O Worker
> `freecorpsnfe-privacy-mail`, as tabelas `privacy*` e a página do console
> saíram do código, com os comandos `deploy:mail`, `platform:privacy-worker`
> e `ci:privacy-worker`. O texto abaixo é o registro do que foi feito: não
> execute os passos dele.

Canal geral de ajuda, acompanhado pela
[#519](https://github.com/freecorps/freecorpsNFE-arquivo/issues/519). O endereço é
`suporte@nfe.freecorps.com.br`, no mesmo subdomínio das caixas de privacidade
e de segurança. A caixa é lida e respondida em `/console/suporte`.

A caixa reaproveita o fluxo da [caixa de privacidade](privacidade-email.md),
como a [de segurança](seguranca-email.md): o mesmo Worker
`freecorpsnfe-privacy-mail`, a mesma fila R2, as mesmas tabelas `privacy*` e o
mesmo envio pela Cloudflare. Cada conversa pertence a uma caixa. Os
operadores de uma caixa não leem, respondem nem baixam mensagens das outras.
O token de resposta só reabre a conversa na caixa de origem.

## Diferenças em relação à privacidade

| Item                  | Suporte                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| Endereço              | `suporte@nfe.freecorps.com.br`; respostas voltam por `suporte+t_<token>@nfe.freecorps.com.br` |
| Operadores            | `FNFE_SUPPORT_OPERATOR_EMAILS` no deployment Convex. Vazia não autoriza ninguém.              |
| Remetente da resposta | `Freecorps Fiscal · Suporte`                                                                  |
| Console               | `/console/suporte`, item **Suporte** em Plataforma                                            |
| Primeira resposta     | Sem prazo: "respondemos assim que possível, sem prazo garantido"                              |
| Guarda                | Cinco anos após encerrar o chamado, o ciclo das outras caixas                                 |

Em 27/10/2026 o mantenedor decidiu as duas linhas: a primeira resposta não
tem prazo, e o texto público diz "respondemos assim que possível, sem prazo
garantido"; a guarda de cinco anos após encerrar o chamado fica confirmada.
Ela vem do código comum às caixas, e não de uma regra própria do
suporte; nenhuma regra de [RETENTION.md](../plataforma/RETENTION.md) trata de
chamados de suporte. Um prazo diferente exigiria mudança no expurgo.

Também em 27/10/2026, o mantenedor decidiu que, enquanto o catálogo de planos
estiver desligado, os pedidos de plano, como o da captura em produção, chegam
por esta caixa, aberta a todas as organizações. Os níveis de suporte por
plano de [PLATFORM-PLAN-PROPOSAL.md](../plataforma/PLATFORM-PLAN-PROPOSAL.md)
(Gratuito com documentação e comunidade, e-mail a partir do Intermediário)
só valem com a liberação do catálogo, na #549.

`INBOUND_EMAIL_SECRET`, `FNFE_PRIVACY_SEND_MODE`,
`FNFE_PRIVACY_EMAIL_ACCOUNT_ID` e `FNFE_PRIVACY_EMAIL_API_TOKEN` valem para as
quatro caixas. Cada operador precisa de uma conta Better Auth com o e-mail
verificado.

## Estado em 27/10/2026

- Passo 1: primeira resposta e guarda decididas pelo mantenedor (tabela acima).
- Passo 2: `FNFE_SUPPORT_OPERATOR_EMAILS` configurada em
  `prod:elated-possum-295` com a conta autorizada do mantenedor. O Worker
  `freecorpsnfe-privacy-mail` foi publicado de novo a partir da `main` em
  `a570dbe3`, versão `4d328cd6-d4a5-4243-9c27-6192bd414018`. A conferência de
  que um operador só da privacidade ou da segurança e uma conta cliente não
  veem a caixa ficou com o ensaio do passo 4.
- Passo 3: feito. O mantenedor confirmou em 27/10/2026 que configurou na
  Cloudflare a regra de Email Routing de `suporte@nfe.freecorps.com.br`.
- Passo 4: feito. Em 27/10/2026 o mantenedor fez o ensaio externo e informou
  que todas as etapas passaram: o item Suporte aparece para o operador e não
  para uma conta cliente; a mensagem externa com anexo chegou, o original foi
  baixado, a resposta pelo painel foi aceita, o retorno caiu na mesma conversa
  como não lido, e o chamado foi encerrado e reaberto. Os horários não foram
  anotados. O isolamento diante de operadores só da privacidade ou da
  segurança fica com os testes automáticos da #558, porque hoje o mesmo
  operador está nas três listas. O
  recibo sanitizado
  não guarda conteúdo nem endereços pessoais.
- Passo 5: feito pela página `/docs/ajuda` da #519, com os links das
  orientações de erro
  ([PUBLIC.md](../plataforma/PUBLIC.md#ajuda-e-condições-de-acesso-519)).

## Ativação

Os passos 1 a 4 da [ativação da privacidade](privacidade-email.md#ativação)
(backend, Worker, Email Sending e subdomínio `nfe`) servem também a esta
caixa. Depois deles, o mantenedor:

1. Decide a primeira resposta e a guarda da tabela acima e as registra aqui
   (feito em 27/10/2026).
2. Configura `FNFE_SUPPORT_OPERATOR_EMAILS` no backend publicado. Confere
   que um operador só da privacidade ou da segurança e uma conta cliente não
   veem a caixa. Depois publica o Worker a partir da `main` com
   `bun run deploy:mail`; a configuração não muda.
3. Em Email Routing, cria a regra literal de `suporte@nfe.freecorps.com.br`
   com ação **Send to a Worker**, destino `freecorpsnfe-privacy-mail`.
   Confere que `suporte+t_<token>@nfe.freecorps.com.br` segue a mesma regra.
   Não habilita catch-all.
4. Executa o ensaio abaixo e registra somente o recibo sanitizado.
5. Só então integra a entrega que cita o endereço nos documentos públicos,
   a página `/docs/ajuda` da #519.

## Ensaio de recebimento e resposta

Usar uma caixa externa controlada, fora da organização, e uma dúvida
sintética, sem dados de clientes nem credenciais.

Anote o horário UTC de cada etapa enquanto a faz, inclusive o envio, a
chegada, a resposta, o retorno, o encerramento e a reabertura. O recibo
registra esses horários, e o encerramento e a reabertura não deixam registro
próprio no banco para consultar depois.

1. Enviar ao endereço base, com um anexo sintético.
2. Entrar como operador de suporte e conferir remetente, assunto, texto e
   download do original. Entrar como operador só da privacidade ou da
   segurança e conferir que o chamado não aparece.
3. Responder pelo console. Conferir a resposta na caixa externa, responder de
   volta pelo Reply-To e confirmar que a mesma conversa reabre como não lida.
4. Encerrar e reabrir o chamado e conferir o estado persistido.
5. Registrar data, horários, revisão, ambiente e resultados, sem conteúdo
   nem endereços pessoais, em `docs/v1.0/evidence/`.

## Falha e recuperação

Fila, redelivery de `failed/`, envio sem confirmação, coleta de originais
sem dono e restore seguem a
[caixa de privacidade](privacidade-email.md#falha-recuperação-e-retenção).
Chamados podem trazer anexos maliciosos e dados de clientes: o console mostra
só texto, o original deve ser aberto apenas em ambiente isolado, e o operador
não pede senhas, certificados nem chaves de API.
