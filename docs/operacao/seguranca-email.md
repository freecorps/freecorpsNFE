# E-mail de segurança

Canal privado para relatos de vulnerabilidade, acompanhado pela
[#266](https://github.com/freecorps/freecorpsNFE/issues/266). O endereço é
`seguranca@nfe.freecorps.com.br`, no mesmo subdomínio da caixa de
privacidade. A caixa é lida e respondida em `/console/seguranca`.

A caixa reaproveita o fluxo da [caixa de privacidade](privacidade-email.md):
o mesmo Worker `freecorpsnfe-privacy-mail`, a mesma fila R2, as mesmas tabelas
`privacy*` e o mesmo envio pela Cloudflare. Cada conversa pertence a uma caixa.
Os operadores de uma caixa não leem, respondem nem baixam mensagens da outra.
O token de resposta só reabre a conversa na caixa de origem.

## Diferenças em relação à privacidade

| Item                  | Segurança                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Endereço              | `seguranca@nfe.freecorps.com.br`; respostas voltam por `seguranca+t_<token>@nfe.freecorps.com.br` |
| Operadores            | `FNFE_SECURITY_OPERATOR_EMAILS` no deployment Convex. Vazia não autoriza ninguém.                 |
| Remetente da resposta | `Freecorps Fiscal · Segurança`                                                                    |
| Console               | `/console/seguranca`, item **Segurança** em Plataforma                                            |
| Primeira resposta     | Até 5 dias úteis, prazo decidido pelo mantenedor em 21/10/2026                                    |
| Guarda                | Cinco anos após encerrar o relato, o mesmo ciclo das conversas de privacidade                     |

`INBOUND_EMAIL_SECRET`, `FNFE_PRIVACY_SEND_MODE`,
`FNFE_PRIVACY_EMAIL_ACCOUNT_ID` e `FNFE_PRIVACY_EMAIL_API_TOKEN` valem para as
quatro caixas. Em 21/10/2026, a pedido do mantenedor,
`FNFE_SECURITY_OPERATOR_EMAILS` recebeu o e-mail corporativo do mantenedor, o
mesmo responsável da privacidade. Cada operador precisa de uma conta Better
Auth com o e-mail verificado.

## Estado em 21/10/2026

- `FNFE_SECURITY_OPERATOR_EMAILS` configurada em `prod:elated-possum-295`.
- Regra de Email Routing `Segurança Fiscal`, literal
  `seguranca@nfe.freecorps.com.br`, para o Worker `freecorpsnfe-privacy-mail`.
- A [publicação](https://github.com/freecorps/freecorpsNFE/actions/runs/39634126654)
  do merge da #332 (`5d7949f`) passou entre 16:22 e 16:28 UTC. Às 16:28 UTC,
  a versão `8ed3fea4-a4d6-44a6-a888-77525f81e5d1` do Worker foi
  publicada; o código baixado da Cloudflare é idêntico ao bundle da `main`.
- A manutenção preencheu `mailbox` em todas as conversas existentes. O campo
  já pode passar a obrigatório em uma entrega própria.
- Duas mensagens internas, enviadas de endereços da organização, chegaram à
  caixa às 16:29 e 16:31 UTC. Elas não contam como ensaio externo.
- O ensaio externo passou às 17:00 UTC (seção abaixo), e o canal foi
  publicado no `SECURITY.md`.

Decisões do mantenedor em 21/10/2026: o endereço fica em
`nfe.freecorps.com.br`, e não no domínio principal como a #266 sugeria; os
relatos seguem a guarda de cinco anos da privacidade.

## Ativação

Os passos 1 a 4 da [ativação da privacidade](privacidade-email.md#ativação)
(backend, Worker, Email Sending e subdomínio `nfe`) servem também a esta
caixa. Depois deles:

1. Configurar `FNFE_SECURITY_OPERATOR_EMAILS` no backend publicado. Conferir
   que um operador só da privacidade e uma conta cliente não veem a caixa.
   Depois publicar o Worker a partir da `main` com `bun run deploy:mail`.
2. Em Email Routing, criar a regra literal de
   `seguranca@nfe.freecorps.com.br` com ação **Send to a Worker**, destino
   `freecorpsnfe-privacy-mail`. Conferir que
   `seguranca+t_<token>@nfe.freecorps.com.br` segue a mesma regra. Não
   habilitar catch-all.
3. Executar o ensaio abaixo e registrar somente o recibo sanitizado.
4. Só então publicar o canal no `SECURITY.md`, com o texto abaixo, e marcar a
   pendência de `release-acceptance` em
   [DISTRIBUTION.md](../licenses/DISTRIBUTION.md). Antes disso, nenhuma
   release ou anúncio cita o canal.

Quando o repositório for publicado, ligar o Private vulnerability reporting
(Settings > Security), conferir por
`GET repos/freecorps/freecorpsNFE/private-vulnerability-reporting` e citá-lo
no `SECURITY.md` como segundo canal.

## Ensaio de recebimento e resposta

Usar uma caixa externa controlada, fora da organização, e um relato sintético,
sem dados de clientes nem credenciais.

Anote o horário UTC de cada etapa enquanto a faz, inclusive o envio, a
chegada, a resposta, o retorno, o encerramento e a reabertura. O recibo
registra esses horários, e o encerramento e a reabertura não deixam registro
próprio no banco para consultar depois.

1. Enviar ao endereço base, com um anexo sintético.
2. Entrar como operador de segurança e conferir remetente, assunto, texto e
   download do original. Entrar como operador só da privacidade e conferir
   que o relato não aparece.
3. Responder pelo console. Conferir a resposta na caixa externa, responder de
   volta pelo Reply-To e confirmar que a mesma conversa reabre como não lida.
4. Encerrar e reabrir o relato e conferir o estado persistido.
5. Registrar data, horários, revisão, ambiente e resultados, sem conteúdo
   nem endereços pessoais, em `docs/v1.0/evidence/`.

## Ensaio externo em 21/10/2026

Um mantenedor enviou um relato sintético de uma caixa Gmail, fora da
organização, ao endereço base. A mensagem chegou às 17:00:28 UTC na caixa de
segurança, não lida e com o original preservado, e foi lida no console. A
resposta pelo console foi aceita pelo provedor às 17:01:37 UTC e deixou o
relato aguardando resposta. O retorno pelo Reply-To, com um anexo sintético,
entrou na mesma conversa às 17:02:24 UTC. O relato foi encerrado e reaberto, e
a situação persistida é aberta. As duas entregas foram arquivadas.

O mantenedor confirmou no console o download do original e o retorno como
não lido antes da leitura; o ticket de download é apagado após o uso e não
deixa registro no banco. A recusa para um operador só da privacidade não foi
repetida em produção, porque hoje o mesmo responsável está nas duas
allowlists; o mantenedor aceitou a cobertura dos testes automatizados. Com
isso, o ensaio foi aceito em 21/10/2026.
O recibo sanitizado
registra a revisão, a versão do Worker e os resultados.

## Texto para o `SECURITY.md`

Aplicado em 21/10/2026, depois do ensaio:

> Relate suspeitas de vulnerabilidade por e-mail a
> `seguranca@nfe.freecorps.com.br`. A primeira resposta sai em até 5 dias
> úteis. Envie revisão afetada, reprodução mínima com dados inventados,
> impacto e resultado esperado e observado. Não envie API keys, PFX, senhas,
> CSC, XML de clientes, dumps ou URLs assinadas.

## Falha e recuperação

Fila, redelivery de `failed/`, envio sem confirmação, coleta de originais
sem dono e restore seguem a
[caixa de privacidade](privacidade-email.md#falha-recuperação-e-retenção).
Relatos podem trazer anexos maliciosos: o console mostra só texto, e o
original deve ser aberto apenas em ambiente isolado.
