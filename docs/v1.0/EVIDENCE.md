# Evidências e prontidão

Este índice permite conferir o que foi exercitado usando os arquivos do
repositório. Os planos de backend e frontend
registram o planejamento histórico. Os critérios atuais ficam na issue da
entrega e na [matriz](ACCEPTANCE.md); os recibos conservam resultado, ambiente
e limitações. O release operacional da #84 foi aprovado no seu escopo.
Desde 31/10/2026 não há release global da plataforma 1.0, conforme a
[ADR 0011](../adr/0011-entregas-graduais.md). Prova fiscal continua específica
da capacidade e do ambiente.

A [matriz de capacidades](ACCEPTANCE.md) separa limites, aceites históricos
e lacunas. A issue de cada entrega registra o aceite, com SHA, ambiente,
recibos e aprovações aplicáveis; #43 é um mapa de prioridades. Os checks do candidato
`1caf985bb57b745086a31ec04bdfa540b8aefa2c` e sua publicação parcial ficam no
registro histórico. A
recuperação posterior do smoke está
comprovada; a investigação antiga não permanece na fila de trabalho.

## Candidato de 26/10/2026

A prova local de 26/10/2026 rodou no
candidato proposto `71b754a8c724cd0e2ccb3b3417f62f0fdf4e6e38`, a `main`
depois do #502, com Bun 1.4.0 e árvore limpa. `ci:prove` passou: 185 arquivos
de teste, 3.106 testes aprovados e 1 ignorado; `vp check` sem erros; contrato
8.0.0 aceito, sem contrato publicado (46 rotas); `sdk:prove`, `xml:prove`
(54 casos), `licenses:check`, `distribution:prove`, `ci:docs` e as fronteiras
aprovados. Cinco jornadas de navegador passaram contra Convex local, com 52
telas no axe e nenhuma violação. A jornada de documentos só roda sob Bun:
sob Node, `documents.ts` importa `./external.js` e falha com
`ERR_MODULE_NOT_FOUND`, defeito de 19/09. Não houve publicação, captura real,
backfill nem prova hospedada. A [matriz](ACCEPTANCE.md#b00b11-e-f00f10) diz,
bloco a bloco, o que os PRs #467–#502 invalidam e o que falta.

## Consolidação de 26–29/10/2026

Registro histórico, trazido da [matriz](ACCEPTANCE.md) pela
[#116](https://github.com/freecorps/freecorpsNFE/issues/116). As issues citadas nele são do repositório arquivado e estão
encerradas. As pendências dessas tabelas que continuam abertas foram recriadas
neste repositório:

- mapa das entregas graduais: [#2](https://github.com/freecorps/freecorpsNFE/issues/2);
- revisão humana das telas novas e comunicação: [#4](https://github.com/freecorps/freecorpsNFE/issues/4);
- expurgo D01: [#3](https://github.com/freecorps/freecorpsNFE/issues/3);
- `tpEvento` da captura real: [#29](https://github.com/freecorps/freecorpsNFE/issues/29);
- reprocessamento das recusas históricas: [#38](https://github.com/freecorps/freecorpsNFE/issues/38);
- retomada num deployment restaurado: [#37](https://github.com/freecorps/freecorpsNFE/issues/37);
- atendimento pelo substituto: [#36](https://github.com/freecorps/freecorpsNFE/issues/36);
- catálogo pago e contratação anual: [#35](https://github.com/freecorps/freecorpsNFE/issues/35).

As decisões numeradas citadas na matriz e em outros documentos são as da
tabela de decisões abaixo.

### Issues abertas em 26/10/2026

<details>
<summary>Consolidação anterior às entregas graduais</summary>

Estado conferido no GitHub em 26/10/2026, com #600 e #601 abertas em 28/10; #493, #494, #499, #501, #429, #424 e #79, encerradas entre 26/10 e 29/10, foram para os [achados encerrados](ACCEPTANCE.md#achados-encerrados-e-decisões-de-escopo). A tabela diz a evidência mais
recente de cada issue aberta que pesa na 1.0, o que os PRs #467–#502 mudaram
nela e quem decide o que falta. Fecharam nessa janela: #50 e #430 (captura no
site, fase 6 e ADR 0007), #389 (schemas do portal), #395 (PL_010g), #426 e
#427 (documentação e site) e #442 (perda na captura de integração). Ficam de
fora as issues marcadas como "[Futuro]" (#398–#405), o motor de emissão NFS-e
com validade fiscal (#194, #197, #198), a captura de NFS-e pelo ADN
(#478–#491), a consulta de NFS-e de Campinas (#142), a consulta pelo DANFE
(#296) e a Ciência da Operação pelo console (#414): nenhuma está na cobertura
aceita da 1.0.

| Issue                                                                | Evidência mais recente e SHA                                  | #467–#502                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | O que falta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Quem decide             |
| -------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| [#43](https://github.com/freecorps/freecorpsNFE-arquivo/issues/43)   | Roteiro; fecha depois de #47 e #51                            | Nada direto.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Aceite completo da 1.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Mantenedor              |
| [#47](https://github.com/freecorps/freecorpsNFE-arquivo/issues/47)   | Prova do candidato, `71b754a`                                 | O grafo `validate` passou no candidato, sem cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | CI do GitHub no SHA final; cobertura acordada com os aceites fiscal, humano e operacional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Mantenedor              |
| [#51](https://github.com/freecorps/freecorpsNFE-arquivo/issues/51)   | Esta matriz e a prova do candidato                            | Aceite de B06/F07 registrado em 26/10 (#502); esta consolidação.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Aceite do backup com a custódia do mantenedor e o limite da #178 adiada, decisões abaixo e a decisão da release. Webhooks hospedados aceitos em 28/10, com limite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Mantenedor              |
| [#80](https://github.com/freecorps/freecorpsNFE-arquivo/issues/80)   | Aceite técnico; D05                                           | #473 acrescentou runbooks da captura.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Texto da política aceito com hash e prova real do expurgo dos 16 encerramentos, depois de 04/12/2026; D01 bloqueia a release (decisão de 28/10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Mantenedor              |
| [#83](https://github.com/freecorps/freecorpsNFE-arquivo/issues/83)   | Varredura de 25/10, `2d4a151`; publicação de 01/11, `08e85d8` | #475 achou PII e dados de cliente na árvore e no histórico; #498 e #495 trouxeram pacotes novos de schemas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Condições por artefato; decisões de [DISTRIBUTION.md](../licenses/DISTRIBUTION.md). Em 28/10: cinco pacotes no npm na release, depois da conferência dos membros da organização `freecorps` no npm, feita em 29/10.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Mantenedor e jurídico   |
| [#85](https://github.com/freecorps/freecorpsNFE-arquivo/issues/85)   | #85; #427, merge `2dd446f`                                    | #476 publicou no repositório a formulação aprovada; notas da versão e `LAUNCH.md` atualizadas nesta entrega.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Decisão de lançamento, indexação, pacotes e anúncio.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Mantenedor              |
| [#178](https://github.com/freecorps/freecorpsNFE-arquivo/issues/178) | Perda do host simulada, `9722906`                             | Nada.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Adiada para depois da 1.0 por decisão do mantenedor em 28/10: execução independente pelo substituto. Destruição da identidade provisória a partir de 02/11/2026, sem bloquear a 1.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Mantenedor e substituto |
| [#267](https://github.com/freecorps/freecorpsNFE-arquivo/issues/267) | Varredura de 25/10, árvore pública de 28/10 e de 29/10        | #475 fez o inventário e descreveu as duas opções de publicação. Em 28/10, `scripts/public-copy/public-tree.mjs` montou a árvore com manifesto SHA-256 e a #611 tirou dela o nome da empresa piloto, o caminho local e os clientes do plano histórico. Depois, a cópia passou a sair com as decisões do mantenedor de 28/10: mantenedores pelo papel, fora os arquivos que o processo lê; sem e-mails pessoais, deployments de teste, `docs/historico/` e recibos. A varredura dá zero bloqueios. Em 29/10, a nova execução achou dois testes do próprio script que falhavam na cópia por depender da custódia; corrigidos, a suíte passa na cópia montada. Desde a #632, link relativo para arquivo que não existe no commit montado bloqueia a cópia. | Lista pronta para revisão do mantenedor; nada publicado. Em 03/11 os deployments de teste deixaram de responder e o 2FA passou a ser obrigatório (recibo). Faltam conferir as proteções do repositório novo, decidir os links para este repositório privado e publicar a partir do SHA e do manifesto revisados. O SHA é o da `main` depois da última integração da 1.0 (decisão 6, 29/10). O script roda só neste repositório privado. Em 03/11 o formato mudou para desenvolvimento aberto (decisão 6): o repositório público recebe a árvore e passa a ser a fonte, e este é arquivado.                                                                                                     | Mantenedor              |
| [#428](https://github.com/freecorps/freecorpsNFE-arquivo/issues/428) | #428, merge `f1d6e7e`                                         | #472 arquivou os termos com hash e escreveu rascunhos de política, termos de uso e cláusula de operadora.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Textos aprovados sem jurídico em 28/10 (#586); versão, retenções e acesso administrativo do anexo preenchidos em 28/10. O console pede o aceite dos termos de uso desde a PR #596 (issue #586), sem versão em vigor; o aviso por e-mail de versão nova existe desde a PR #608 (issue #594), provado só em `convex-test`, e alcança apenas os destinatários autorizados do e-mail de contas; antes de publicar, o e-mail de contas ligado e sem allowlist que exclua proprietários ou administradores (decisão 2). Faltam os suboperadores com região, a retenção dos logs da Blacksmith, o HTTPS do anexo e a publicação de política e termos na release, com versão, hash e data de vigência. | Mantenedor              |
| [#500](https://github.com/freecorps/freecorpsNFE-arquivo/issues/500) | Proposta no #498                                              | A escolha dos 5 eventos aceitos foi inferida do XSD, não medida.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Gravar o `tpEvento` de cada envelope e levá-lo ao recibo da rodada. Fica para depois da 1.0 (decisão de 28/10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Mantenedor              |
| [#600](https://github.com/freecorps/freecorpsNFE-arquivo/issues/600) | Aberta em 28/10                                               | PR #602: código, contrato, SDK e testes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Pôr `SOURCE_COOLDOWN` e `sourceMaxNsu` no contrato 8.0.0 (decisão 9), antes de publicar o SDK 8.0.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Mantenedor              |
| [#601](https://github.com/freecorps/freecorpsNFE-arquivo/issues/601) | Aberta em 28/10; implementada na PR da #601                   | PR da #601: o servidor marca a atenção do corte (`freecorpsCut`), o console e o Início dizem que a Freecorps pausou a captura, o runbook deixa de pedir explicação manual; testes do corte, da revogação real e do isolamento.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Merge da PR; a #601 fecha com ele (decisão 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Mantenedor              |

</details>

### Decisões do mantenedor de 26–29/10/2026

<details>
<summary>Decisões e pendências registradas em 26–29/10/2026</summary>

Lista única, em 26/10/2026, das decisões que pesam no candidato. Cada linha
aponta onde a decisão está descrita, com as opções. Em 26/10 o mantenedor já
decidiu: a formulação pública da captura (#427), o aceite da ADR 0007 e de
B06/F07, o fim da nova rodada da #50 e o apagamento do alvo dedicado (#430),
quem aceita a perda e o evento da integração (ADR 0008, #442), a regra
`nfe-status/2` (#395), o gate de contrato contra o último publicado e, na
#424, a compensação da falta de proteção da `main` (o gate na publicação) e
a dispensa do passo 8 do ensaio dos workflows.

| #   | Decisão                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Onde está descrita                                                                                                                                                   | Issue     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Oferta dos planos pagos: financiar a guarda quente e o backup integral; plano obrigatório, Gratuito permanente e catálogo desligado com déficit registrado decididos em 27/10; custódia fria de organizações abertas decidida em 28/10 (ADR 0009), implementada, desligada e sem prova operacional completa                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [USAGE.md](../plataforma/USAGE.md#ambientes), [proposta](../plataforma/PLATFORM-PLAN-PROPOSAL.md) e [ADR 0009](../adr/0009-custodia-fria-de-organizacoes-abertas.md) | #549      |
| 2   | **Publicados em 01/11/2026 (#428):** termos de uso 1.0 com a cláusula de operadora (`termos-de-uso-2026-11-01`) e política 1.0 (`politica-de-privacidade-2026-11-01`), públicos em `/termos` e `/privacidade`; termos 1.1 (`termos-de-uso-2026-11-02`) sem ABRASF (#142) 1.2 (`termos-de-uso-2026-11-04`) com a cobrança da ADR 0012 e 1.3 (`termos-de-uso-2026-11-05`) com a guarda da NF-e real importada no Sandbox (#169), que as organizações aceitam até 05/12/2026 ([Termos](../termos/README.md#termos-de-uso)). Histórico: publicar política de privacidade e termos de uso, ou restringir a captura real até eles existirem. Textos, cláusula de operadora e direitos de titulares aprovados sem jurídico em 28/10 (#586); o aceite no console existe desde a PR #596 (issue #586), sem versão em vigor; o aviso por e-mail de versão nova existe desde a PR #608 (issue #594), provado só em `convex-test`, e alcança apenas os destinatários autorizados do e-mail de contas. Pré-condição da publicação dos termos: no perfil com clientes, o e-mail de contas precisa estar ligado e a allowlist `ACCOUNT_EMAIL_RECIPIENTS` precisa deixar de existir, ou incluir todos os proprietários e administradores, antes da publicação que põe a versão em vigor (`since`); senão o aviso de 30 dias da seção 11 não chega a todos. Em 29/10 o mantenedor decidiu tirar a allowlist da instalação: a política aceita `ACCOUNT_EMAIL_RECIPIENTS=*` só no perfil `installation` (#428); gravar o valor no deployment é ação do operador. Em 28/10: versão `1.0`, com vigência na data da publicação da release 1.0, preenchida na release; retenções de D03 e D04 e o acesso administrativo do anexo preenchidos com os aceites do dia; preços e termos de cobrança não mudam. Continuam abertas a lista de suboperadores com região, a retenção dos logs da Blacksmith e o HTTPS do anexo técnico | [TERMS-DRAFT.md](TERMS-DRAFT.md), [PRIVACY-DRAFT.md](PRIVACY-DRAFT.md), [OPERADORA-DRAFT.md](OPERADORA-DRAFT.md), PR #472                                            | #428      |
| 3   | Novo aceite das empresas já liberadas quando os termos mudarem: prazo, aviso e efeito de não aceitar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [Termos](../termos/README.md#publicar-uma-versão-nova), PRs #468 e #472                                                                                              | #428      |
| 4   | Decidida em 26/10: compensação da falta de proteção da `main` e de `CODEOWNERS` com efeito pelo gate na publicação (#503), com um dono só                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | [ADR 0007](../adr/0007-captura-fiscal-no-site.md#decisões-da-424-em-26102026)                                                                                        | #424      |
| 5   | Quando e como distribuir o SDK 8.0.0 aos integradores; o pacote continua na versão `0.1.0`, e ao publicar o contrato a release grava `packages/contracts/published.json`. **Decidida em 28/10:** os pacotes `sdk` (SDK 8.0.0), `contracts`, `fiscal-core`, `fiscal-nfe` e `fiscal-nfse` são publicados no npm na release; publicar dependia da #602 (#600), integrada em 28/10, e de o mantenedor conferir os membros da organização `freecorps` no npm (#83), conferidos em 29/10: só os dois mantenedores. **Em 01/11:** `contracts` ficou privado; os outros quatro foram publicados e `published.json` registra o contrato 8.0.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [SDK.md](SDK.md#versionamento), [release.md](../operacao/release.md)                                                                                                 | #83, #51  |
| 6   | Formato de publicação do repositório (este, ou um novo sem histórico), seleção do inventário, dados reais de clientes na árvore, como citar os mantenedores e os deployments de teste que ainda respondem. **Decidida em 28/10:** opção B, a árvore selecionada e saneada vai para um repositório novo, sem histórico, e este continua privado. A seleção é a classificação da varredura de 25/10 como está; a lista final é mostrada ao mantenedor antes de publicar. **Também em 28/10:** nomes e logins dos mantenedores só onde o processo exige uma pessoa (`CODEOWNERS`, gates do dono e da produção, plano de backup); no resto, o papel; e-mails pessoais, deployments de teste, `docs/historico/` e recibos fora da cópia. A lista aplica essas decisões, com manifesto e varredura sem bloqueio; a execução de 29/10 corrigiu dois testes que falhavam na cópia, e a suíte passa nela; nada publicado. **Em 29/10:** o SHA de publicação é o da `main` depois da última integração da 1.0; a árvore pública e as provas dos pacotes se repetem nesse SHA. **Revista em 03/11:** o desenvolvimento passa a ser aberto. A árvore saneada vira o primeiro commit de `freecorps/freecorpsNFE`, público, onde ficam código, issues, PRs, CI e operação. Este repositório passou a `freecorps/freecorpsNFE-arquivo` e é arquivado depois da virada, privado e sem ser apagado. Não há repositório privado de operação: os workflows de produção ficam no público, com segredos só nos environments do GitHub, e a evidência restrita sai cifrada para os custodiantes ([armazenamento](EVIDENCE-STORAGE.md#evidência-restrita)). Na cópia, outros produtos da Freecorps são citados como app consumidor; os custos dos planos e o registro de textos aprovados sem parecer jurídico ficam; os pareceres ficam fora do Git. As chaves de deploy são trocadas na virada                               | Varredura de 25/10, [DISTRIBUTION.md](../licenses/DISTRIBUTION.md), PR #475                                                                                          | #267, #83 |
| 7   | Retomada automática depois do corte por variável e a mensagem do console nesse corte. **Decidida em 28/10:** a retomada continua manual; o console diz que a Freecorps pausou a captura e que basta retomar. **Implementada na PR da #601**: o servidor marca a atenção causada pelo corte (`freecorpsCut`), sem mudar a API REST. Numa captura ativada por integração, o console diz que quem retoma é a integração (#607)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [Runbook](../operacao/captura-fiscal.md#depois-do-corte-por-variável), PR #473                                                                                       | #51, #601 |
| 8   | Ligar a captura num deployment restaurado que substitui o site, depois de confirmar que a origem parou; o caminho não foi ensaiado. **Decidida em 28/10:** limite aceito, sem ensaio na 1.0; o ensaio fica para depois dela                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [Restauração](../operacao/restauracao.md), PR #473                                                                                                                   | #51       |
| 9   | Pôr `SOURCE_COOLDOWN` e `sourceMaxNsu` no contrato público. Enquanto o 8.0.0 não for publicado, o gate aceita a mudança nele, sem outro major. **Decidida em 28/10:** `SOURCE_COOLDOWN` (409, com `nextAllowedAt` no erro) e `sourceMaxNsu` entram no contrato 8.0.0, implementados na PR #602 (#600). **Decidida em 29/10:** `ORGANIZATION_ARCHIVED` vira código público próprio, com HTTP 409, no lugar de `SCOPE_DENIED` 403, também dentro do 8.0.0 e pela mesma regra; implementado na PR #644 (ADR 0009, #549)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [Guia da captura](../../apps/docs/content/docs/captura-nfe.mdx), PRs #476 e #492; [SDK.md](SDK.md#versionamento)                                                     | #600      |
| 10  | Se #500 bloqueia a 1.0 e se rodar o reprocessamento da #499 no site entra no aceite ou bloqueia a 1.0 (a #494 tem correção na PR #524). **Decidida em 28/10 para a #500:** fica para depois da 1.0. Sobre a #499 não houve decisão nova                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [Issues abertas](#issues-abertas-em-26102026)                                                                                                                        | #51       |
| 11  | Se as telas novas (totais e finalidade, valores líquidos, Uso e limites por ambiente, termos aceitos, perda com motivo) pedem revisão humana além do axe dos recibos. **Decidida em 28/10:** sim; o mantenedor revisa as telas novas no candidato, com roteiro e capturas preparados pela engenharia                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [B00–B11 e F00–F10](ACCEPTANCE.md#b00b11-e-f00f10), linhas F04, F07, F08 e F09                                                                                       | #51       |
| 12  | Aceitar a admissão com plano aprovada em 28/10 e a migração do consumo; decidir se leituras concorrentes precisam de nova medição, se a disputa entre ambientes fica só em `convex-test` e se a soma observada igual é aceita sem prova de conservação. **Decidida em 28/10:** o mantenedor autorizou medir a correção da #593 na validação, medida em 28/10 em `3fc9c0a` e aprovada na segunda execução (medição da correção da #593), e, em 29/10, o perfil, as cotas, a migração e a disputa entre ambientes aceitos com esses limites, cobrindo `ac2e66e`, em que consumo, cotas, limitador REST e listagem de documentos não mudaram desde `3fc9c0a`; a disputa entre ambientes fica aceita só com `convex-test`; a migração fica aceita com a soma observada igual, que não é prova de conservação                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Parecer da #79; [B00–B11](ACCEPTANCE.md#b00b11-e-f00f10), linhas B05 e B09                                                                                           | #79       |
| 13  | Release: aceitar o candidato, publicá-lo, indexação, tag, pacotes e anúncio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [Notas da versão](RELEASE-NOTES.md), [LAUNCH.md](LAUNCH.md), [release.md](../operacao/release.md)                                                                    | #51, #85  |

O passo 8 do ensaio dos workflows da #424 foi dispensado em 26/10 e volta
quando uma terceira pessoa tiver escrita no repositório. O backfill do consumo por ambiente já rodou
em produção (27/10) e na validação (28/10); não repetir. A #493 foi
encerrada.

Em 28/10 o mantenedor decidiu também, fora da tabela: aceitar B07 com o
recibo hospedado de 21/10, com o
limite de não cobrir o evento `connection.history_limited` (#496) nem a cota
por ambiente, cobertos por `sdk:prove` e pelos testes; esperar, para a 1.0, a
prova real do expurgo dos 16 encerramentos de D01 (#80), possível depois de
04/12/2026, de modo que D01 bloqueia a release; e não mudar preços nem termos
de cobrança.

</details>

## Resultados da reconciliação de 18/10/2026

Resumo por issue dos recibos conferidos na reconciliação da
[matriz de aceite](ACCEPTANCE.md). Cada item conserva SHA, ambiente e limites.

- Publicação: o run `36790548031` falhou com `smoke / partial / UNKNOWN`.
  O registro posterior comprova publicação
  aprovada em `6f07c39`, preservação da sonda sintética, autenticação após
  recarga e smoke corrigido em leitura. A correção foi integrada em
  `aff17829bbea54411293dcb0844bed2253d9742c`. A falha original continua no
  histórico; diagnosticar aquele `UNKNOWN` não é tarefa pendente da release.
- #71/#72: aceites funcionais locais concluídos e issues encerradas em 05/10.
  A jornada NF-e/ABRASF cobre importação,
  consulta, retomada, reprocessamento, downloads e revogação com cache carregado.
  ABRASF importado conserva situação fiscal desconhecida.
  A importação ABRASF foi retirada em 02/11/2026: o runner da jornada passou a
  cobrir só a NF-e e a recusa de um lote ABRASF, e este recibo fica como histórico.
- #81/#82: aceites técnicos locais concluídos e issues encerradas em 05/10.
  Restore, instalação e upgrade
  revalidados em `a14318f`, incluindo NF-e, cofre e sete NFS-e ABRASF.
  Backup fora do host, custódia e recuperação operacional seguem as entregas
  #178/#688, com os limites registrados na matriz.
- #79/#80: a rodada hospedada de 05/10
  aprovou o perfil do piloto privado em `684edd7`: 100 mil metadados, 20 clientes
  em duas organizações, duas execuções de três rodadas e 720/720 respostas 200.
  Os p95 máximos de 1.087/2.177 ms atendem às metas selecionadas de
  1.200/2.500 ms. Os 800 ms/1 s permanecem alvos de otimização.
  Monitores, runbooks e expurgo técnico têm recibos em `4192e63`; a projeção
  de I/O e chamadas dos 20 monitores é US$ 14,88/mês. Limpeza conferida.
  O aceite técnico consolidado em 06/10
  retira carga, monitores e expurgo técnico da fila de repetição. A #80
  segue aberta para aplicação operacional e aceite público final.
  O parecer de 28/10 diz o que a
  admissão com plano e as migrações do consumo sustentam; com a
  medição da correção da #593,
  o mantenedor aceitou em 29/10 o perfil, as cotas e a migração, e a #79 foi
  encerrada.
  Os [prazos D01–D06](../plataforma/RETENTION.md#proposta-operacional-de-06102026) foram
  aprovados para implementação em 06/10; o mantenedor assumiu operação
  e fiscal/privacidade. Em 07/10 decidiu a [guarda por classe, o canal e o substituto](../plataforma/RETENTION.md#decisões-de-07102026).
  O [encerramento com expurgo](../plataforma/RETENTION.md#encerramento-implementado-d01)
  foi implementado (#175) e o expurgo após restore em destino vazio
  passou em ensaio local em 07/10. Em 08/10 entraram a
  [guarda após o encerramento e a retenção legal](../plataforma/RETENTION.md#guarda-implementada-d01)
  (#186, provada em `convex-test`), o [atendimento a direitos](../plataforma/RIGHTS.md)
  (#189), o [inventário dos logs dos provedores](../plataforma/OBSERVABILITY.md#logs-dos-provedores-d03)
  (#190), o [rascunho da política](PRIVACY-DRAFT.md) (#191, publicada em 01/11/2026 na #428) e o
  [backup externo](../operacao/backup.md) (#179, #192, #193), configurado em
  `elated-possum-295` em 08/10. Os agendamentos do backup falharam de 09/10 a
  18/10, com o RPO de 24 horas violado; a #244 corrigiu a falha, e as execuções
  agendadas de 19/10 passaram. A #248 trocou a custódia provisória pela chave
  do mantenedor. Em 19/10, depois da #259, `retentionRecovery:recover`
  rodou na instalação e D05 passou com o backup real.
  O que falta está na [matriz](ACCEPTANCE.md#lacunas-e-condições-de-saída).
- Emissão NFS-e (#194, #197–#199): núcleo `packages/fiscal-nfse`, API, SDK,
  webhooks, console, DANFSe e conexão Stripe integrados de 08/10 a 11/10. O
  perfil hospedado emite só em sandbox, com transporte simulado e sem validade
  fiscal; produção fica atrás de gate por empresa, desligado, e nenhuma nota
  com validade fiscal saiu da plataforma. A única prova real é uma nota de
  teste autorizada e cancelada na homologação da IMA de Campinas em 09/10
  ([ISSUANCE](../plataforma/ISSUANCE.md), evidência). A emissão
  não faz parte da cobertura aceita da 1.0.
- #47, CI: a divergência de contratos gerados (#181, #188), a varredura das
  funções públicas sem sessão (#184), as negativas HTTP de isolamento e
  retentativa (#187) e a conferência dos tarballs pelo manifesto (#180)
  entraram em 08/10. O verificador de fronteiras já recusava workspace sem
  classificação e cobre `fiscal-nfse`. Faltavam a fronteira do ponto de
  entrada `fiscal-nfse/pure`, a prova de instalação e tarball de
  `fiscal-nfse` e a emissão NFS-e na matriz automática, entregues depois
  conforme a [matriz](ACCEPTANCE.md#lacunas-e-condições-de-saída).
- #85, site: a landing de 12/10 (#236, #237) anunciava capacidades sem prova:
  NFC-e, CT-e, MDF-e, cobertura nacional, Stripe com nota autorizada, captura
  e produção. Em 18/10 o mantenedor decidiu o nome comercial Freecorps Fiscal
  e que o site anuncia só a cobertura aceita. A documentação Fumadocs (#239)
  já seguia a cobertura, com dois ajustes.
- #50: houve consulta fiscal real em 05/10, num dev
  dedicado, em homologação, SHA
  `d59df7909db19813c5f8f57bbabaa656d154a4b2`. Às 19:27:47 BRT, `consNSU=1`
  retornou `cStat=589`, com `ultNSU=maxNSU=0`. A resposta de 892 bytes foi
  persistida e seu hash conferido. mTLS e resposta real estão comprovados;
  houve zero envelopes, checkpoint zero e nenhum avanço real do NSU.
  O recibo registra transporte/crons/notificações
  desligados, stream pausado, remoção do envelope do certificado no dev,
  revogação da deploy key e agendamentos desativados. As duas autorizações
  de transporte foram consumidas. A espera registrada em 30/09 é histórica;
  uma nova rodada exige nova autorização e cenário com dados disponíveis.
  Em 20/10, duas consultas em produção
  voltaram `cStat=137`, com máximo zero. Em 22/10,
  duas consultas em produção voltaram
  `cStat=138`, com 100 envelopes e avanço real do NSU. Na mesma noite, a
  captura no site, já pela ADR 0007, fez
  4 consultas `138` até o NSU 2551, com recibo lido do deployment, e trouxe a
  NF-e indicada pela empresa, conferida pela chave. O mantenedor aceitou a
  captura fiscal real da #50 em 26/10; M4 continua sem aceite completo.

## Registros por capacidade

O aceite técnico de cofre e captura consolida
as #77/#78 com 95 testes, nove cenários TLS locais e consumo independente,
além dos recibos históricos de mTLS hospedado e navegador. As consultas reais
da #50 estão no resumo acima.

O aceite de webhooks da #73 consolida
assinatura, duplicidade, ordem invertida, retry, rotação e isolamento,
com 60 testes e 14 vetores repetidos na base integrada. A entrega HTTPS
ao receptor controlado conserva seu SHA histórico. O release do corte manteve
`WEBHOOK_MODE=disabled`; em 07/10 o mantenedor autorizou a ativação hospedada.
O piloto acompanhado registra
a ativação, quatro entregas HTTP 204 e eventos/documento persistidos no receptor.
O mantenedor autorizou manter `https` no merge da PR #168, e o preflight de
atualizações exige essa configuração, publicada em `79f2d08`. A
conferência posterior comprovou o
reenvio duplicado sem novo efeito no SQLite e explicou a revisão pública 1→2
pela conclusão da projeção fiscal, preservando a versão processada e o XML.
A rodada de 21/10 completou a
prova hospedada com rotação de segredo, expiração da versão antiga e isolamento
por organização, projeto, empresa, ambiente, chave e escopo, sem efeito das
chamadas negadas e com pausa antes da rede após revogar a concessão.

O aceite técnico de #79/#80, consolidado
em 06/10, aceita a carga no perfil privado medido e os ensaios de monitores,
runbooks e expurgo técnico. Os [prazos operacionais](../plataforma/RETENTION.md#proposta-operacional-de-06102026)
foram aprovados para implementação em 06/10; o mantenedor assumiu operação
e fiscal/privacidade. Em 07/10 decidiu a [guarda por classe, o canal e o substituto](../plataforma/RETENTION.md#decisões-de-07102026).
Faltam aplicação e provas operacionais antes do aceite público final.

O expurgo de organização após restore,
de 07/10, prova localmente o encerramento de D01 e a recuperação de D05 em
destino vazio, com massa sintética.

A jornada integrada #71 → #72, executada
em 05/10/2026, cobre NF-e e sete NFS-e ABRASF no console e Convex locais reais.
Confere sucesso parcial, resposta de upload perdida, refresh, consulta direta,
reprocessamento, DTOs e downloads por hash. Registra a correção do aviso de
download ABRASF, 21 recibos e 1.486 testes aprovados. Não substitui publicação,
aceite humano ou prova fiscal.

A atualização de dependências da #128 registra
a retirada do Undici 7.29.0 da cadeia Wrangler/Miniflare, as auditorias
repetidas e as provas locais de build e empacotamento. As provas finais de
instalação e distribuição devem usar esse lockfile; seus aceites permanecem
separados da atualização das ferramentas.

Os aceites técnicos de XML e operações consolidam
B04/B05. A reprodução dos eventos excluídos confirma a correção já integrada;
corpus, consumidor, action local, persistência e recuperação têm novas provas.
O registro separa o aceite desses recortes das jornadas e da release global.

O [site e a documentação do candidato](../plataforma/PUBLIC.md) têm uma
verificação própria. Essa preparação reutiliza os
recibos de SDK/importação/webhooks abaixo e conserva os aceites pendentes
de captura fiscal real, distribuição e lançamento.

A #83 registra as [condições por artefato](../licenses/DISTRIBUTION.md).
Na rodada de 05/10/2026, o mantenedor
reafirmou o bloqueio de todos os artefatos e a exigência de registrar cada
pendência. Os três tarballs foram inspecionados e instalados novamente;
35 testes focados e o inventário de 556 versões passaram. Os aceites jurídicos,
direitos e conteúdo público continuam abertos. O scan de histórico anterior
não foi repetido nem atribuído ao HEAD atual. SDK/core mantêm caminhos de
aceite independentes, sem liberação dos demais materiais. A
varredura de 25/10/2026 cobre árvore,
todas as refs, PII, imagens e licenças, com o inventário do que entra numa
publicação. A árvore pública de 28/10
aplica essa seleção a `origin/main` e à branch saneada e varre os bytes que
sairiam. A conferência de 29/10 empacota
`contracts`, repete as provas dos cinco tarballs no Bun 1.4.0 sobre `b868b73`,
com bytes iguais em duas execuções, gera os avisos de terceiros do painel e da
documentação, confere os textos OFL das 14 fontes do bundle e lê o aviso CNPJ
no site publicado.

Os nomes numéricos dos diretórios são identificadores estáveis do arquivo local.
Não é necessário consultar um rastreador de tarefas para interpretar os registros.

Os acompanhamentos posteriores registram a
prova do timeout no SDK empacotado e o
diagnóstico HTTP dos 429 locais. O primeiro preserva
o aceite histórico do SDK; o segundo registra a correção da renovação local,
com a #95 encerrada em 01/10 e os limites de login/OTP inalterados.

| Capacidade                      | Contrato ou roteiro                                                                                                                     | Evidências locais e limites                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fundação e ambientes            | Fundação, [validação](../operacao/validacao.md) e [deploy](../operacao/deploy-validacao.md)                                             | Fundação local, publicação integrada, reprodução e diagnósticos. As avaliações históricas de M0 conservam o escopo de cada execução.                                                                       |
| Contas e e-mail                 | [Autenticação por e-mail](../plataforma/ACCOUNT-EMAIL.md)                                                                               | Envio e recuperação, incluindo borda hospedada. Negativas de provedor e logout entre abas têm provas locais distintas.                                                                                     |
| Organizações, empresas e chaves | [Organizações](../plataforma/ORGANIZATIONS.md), [empresas](../plataforma/COMPANIES.md) e [projetos](../plataforma/PROJECTS.md)          | Organizações, empresas, chaves e revalidação. O aceite global de M1 não decorre de um recorte isolado.                                                                                                     |
| XML e operações                 | [Pacote fiscal](../../packages/fiscal-nfe/README.md) e [operações](../plataforma/OPERATIONS.md)                                         | Corpus XML e tarefas persistidas. Simulação de transporte não comprova autorização fiscal.                                                                                                                 |
| Importação e consulta           | [Importação](../plataforma/IMPORTS.md) e [documentos](../plataforma/DOCUMENTS.md)                                                       | Importação privada e consulta documental, com provas separadas de convex-test, Convex local e navegador.                                                                                                   |
| Webhooks e integração           | [Webhooks](../plataforma/WEBHOOKS.md) e [SDK](SDK.md)                                                                                   | Outbox e entrega, contrato/SDK e complemento de interoperabilidade. Publicação do pacote continua separada. Piloto assistido e reenvio hospedado concluídos; participante externo dispensado nesta rodada. |
| Referências e cadastro          | [Tabelas](../plataforma/REFERENCES.md) e [consulta CNPJ](../plataforma/REGISTRY.md)                                                     | Referências fiscais e consulta cadastral. Fonte real e fixtures sintéticas têm recibos distintos. Licença do dataset exige avaliação própria.                                                              |
| Certificados e captura          | [Certificados](../plataforma/CERTIFICATES.md) e [captura](../plataforma/CAPTURE.md)                                                     | Cofre e mTLS e coordenação NF-e. mTLS hospedado e captura com fonte controlada não comprovam integração fiscal real.                                                                                       |
| Consumo e operação              | [Consumo](../plataforma/USAGE.md) e [observabilidade](../plataforma/OBSERVABILITY.md)                                                   | Cotas e carga e auditoria/suporte. Carga local não comprova latência de nuvem ou SLA.                                                                                                                      |
| Recuperação e instalação        | [Exportação](../plataforma/EXPORTS.md), [restore](../operacao/restauracao.md) e [instalação própria](../operacao/instalacao-propria.md) | Exportação/restore e instalação completa. Ensaios isolados não equivalem a rollback de produção ou aceite global de operação.                                                                              |
| Licenças e distribuição         | [Licenciamento](../../LICENSING.md) e [release](../operacao/release.md)                                                                 | Pacotes e licenças. Plataforma/motor Freecorps 1.0 e cliente MIT; revisão jurídica, direitos e permissões de terceiros ainda limitam a distribuição.                                                       |

A conferência conjunta de municípios/NCM e CNPJ
registra o aceite técnico local em 30/09/2026, com leitura integral das tabelas,
estados cadastrais sintéticos e prova pública separada do OpenCNPJ. As condições
de redistribuição foram transferidas à #83.

A conferência conjunta de recuperação e instalação própria
repete banco/storage/cofre, instalação limpa, SDK/webhook e recuperação com
custódia separada após as correções documentais e de certificados. Os recibos
distinguem falhas do runner, tentativas repetidas e limites operacionais.
Sua revalidação de 05/10/2026
confere `a14318f`: NF-e/cofre, lote ABRASF de sete notas, instalação limpa,
upgrade desde `a9445db`, recuperação com origem parada e exportação na UI.
Os aceites hospedados e de custódia operacional ficam nas issues das
entregas correspondentes, com os limites registrados na matriz.

A substituição do legado tem recibos do corte concluído.
O mantenedor autorizou banco vazio, contas novas Better Auth e mesmo endereço.
Pausa do app consumidor, limpeza, bootstrap, login humano e release com persistência
foram comprovados em seus respectivos recibos. Isso não aprova emissão fiscal
nem o aceite de outras capacidades. Os ensaios de cópia anteriores permanecem históricos.

## Como registrar uma execução

1. Usar o modelo, com IDs estáveis para critérios e
   pendências e uma descrição do comportamento esperado.
2. Identificar código, runner, configuração não secreta, schema, dataset e
   ambiente. Guardar hashes do conteúdo executado e dos artefatos. Identificadores
   Git e de CI podem complementar a proveniência, mas não substituem os arquivos.
3. Registrar comandos ou jornada, resultado observado, limitações e regra de
   revalidação. Distinguir checkout alterado, revisão candidata e merge sintético.
4. Versionar os recibos sanitizados e apontar caminhos relativos. Links para
   pipelines ou artifacts temporários nunca são a única prova. Mídia e dados
   brutos seguem o [orçamento e a custódia](EVIDENCE-STORAGE.md).
5. Manter falhas e recuperações em arquivos distintos. Não depender do histórico
   Git para recuperar uma tentativa anterior nem substituir seus resultados.
6. Na mesma entrega, apontar o recibo neste índice, com o resultado e os
   limites em poucas linhas. Mudar a [matriz de aceite](ACCEPTANCE.md) só
   quando a execução alterar uma capacidade, um limite, um critério, uma
   lacuna ou uma condição de saída, e o contrato afetado só quando o
   comportamento mudar. O andamento e a próxima ação vão para a issue, com o
   link do recibo; não recontar a execução na matriz.

## Resultado e validade

Na #49, os relatos humanos do mantenedor e a inspeção de produção
estão separados do ensaio automatizado local do quickstart.
O segundo tem conferência de recibos e SQLite, com dois envios e um efeito,
mas não mede tempo humano nem encerra o piloto de integrador externo.

Em 07/10, o mantenedor confirmou a revisão humana do painel concluída sem
problemas em teclado, leitor de tela, zoom e celular. Confirmou também ser
o executor do quickstart e dispensou o amigo; o requisito de participante
externo foi retirado desta rodada por sua decisão, sem rotular o ensaio como
independente. Os obstáculos de SDK, PowerShell, túnel, segredos e transporte
alimentam a revisão da documentação pública e do guia do SDK.

| Resultado     | Significado                                                              |
| ------------- | ------------------------------------------------------------------------ |
| Passou        | O comportamento esperado foi observado no conteúdo e ambiente indicados. |
| Falhou        | O resultado divergiu do esperado; registrar problema e recuperação.      |
| Pendente      | Falta implementação, execução, artefato verificável ou revalidação.      |
| Não aplicável | Critério fora daquele ensaio, com motivo; não elimina obrigação futura.  |

A validade é separada do resultado. Uma prova pode ser válida para o conteúdo
identificado, histórica ou depender de revalidação. Um teste antigo aprovado
não certifica um candidato novo. Se o código antigo não estiver disponível,
o recibo continua sendo um registro histórico, sem promessa de reprodução exata.
Uma nova release precisa de provas sobre o conteúdo que será distribuído.

Identificar a natureza da prova: automática offline, integração hospedada,
navegador, revisão humana, simulação ou integração fiscal real. Mock não comprova
SEFAZ; protótipo não comprova UI integrada; exportação não comprova restore.
Testes do legado só comprovam regressões do legado.

## Quando repetir

| Mudança                                     | Evidências afetadas                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Auth, papéis, sessão, origens ou componente | Login/logout, revogação, expiração, acesso negado, troca de organização e navegador. |
| Schema, índices, storage ou migração        | Isolamento, persistência, compatibilidade, backfill e restore.                       |
| Parser, XML/XSD, decimais ou fixtures       | Corpus afetado, equivalência pacote/API/UI, assinatura e deduplicação.               |
| Filas, leases, cursor ou outbox             | Concorrência, retomada, ordem, duplicatas e entrega.                                 |
| Workflow, ambiente ou provedor              | Elegibilidade, serialização, conteúdo publicado, persistência e recuperação.         |
| UI, rotas, estilos ou contratos             | Jornadas afetadas, responsividade, teclado, acessibilidade e API.                    |
| Documentação sem efeito executável          | Links, consistência dos critérios e diff; não exige novo ensaio fiscal.              |

Comparar o conteúdo candidato com o conteúdo da prova e registrar critérios
afetados. Se essa comparação não for possível após uma substituição de histórico,
repetir as provas necessárias. Recalcular o hash de um documento editado não
revalida o código nem altera o resultado de um ensaio.

Antes de abrir outra rodada, conferir na issue o recibo mais recente e
registrar qual mudança ou lacuna exige a repetição. Provas válidas são
reaproveitadas com seu SHA e ambiente, sem atribuí-las ao HEAD por inferência.

## Pendências e aceite

Cada lacuna aberta tem, na [matriz](ACCEPTANCE.md#lacunas-e-condições-de-saída),
sua condição de saída e a issue que a acompanha. Esse texto local basta para
entender o problema; a issue coordena o trabalho, com o andamento, as
dependências, a evidência mais recente e as próximas ações, mas não pode
conter a única descrição da lacuna.

| Severidade  | Tratamento                                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crítica     | Acesso entre clientes, segredo exposto, perda/duplicação, cursor inconsistente ou incompatibilidade UI/API bloqueiam a entrega afetada. Exigir correção e reprodução negativa aprovada. |
| Alta        | Jornada obrigatória, migração ou recuperação sem prova bloqueiam as entregas que dependem dessa prova.                                                                                  |
| Média/baixa | Registrar impacto, responsável e prazo; adiamento exige decisão explícita do mantenedor.                                                                                                |

Quantidade de testes aprovados não compensa uma falha crítica. Critério
obrigatório pendente bloqueia aceite mesmo sem bug reproduzível.

Cada entrega exige as provas aplicáveis ao escopo anunciado: instalação e
restore, piloto humano, validação fiscal autorizada, inventário de
consumidores/dados ou ensaio de migração com um único escritor fiscal.
Uma entrega documental ou de pacote não exige uma nova prova fiscal sem
mudança que a justifique. O rollback deve considerar banco,
storage, certificados e efeitos externos. Para a #84, o mantenedor autorizou
um reinício vazio com emissão indisponível, com aceite
limitado àquela operação. Sua prova exige pausa dos consumidores, limpeza, publicação e
login no endereço final; não declara migração de histórico ou produção fiscal.
A decisão final identifica artefatos,
hashes, pendências aceitas e aprovação do mantenedor. A publicação da plataforma
segue o workflow de [deploy-producao.md](../operacao/deploy-producao.md). No candidato da matriz,
push na `main` publica após CI; disparo manual também existe.

## Dados publicáveis

A rodada hospedada de 05/10/2026 #79 → #80
registra publicações, carga de 10 mil/100 mil metadados, contenção e migração
dos orçamentos, capacidade de 20 monitores, recuperação dos alertas e expurgo
técnico. Cada recibo identifica o SHA e separa as metas originais dos critérios
selecionados para o piloto privado. O ensaio de 30/09
permanece histórico. A [revisão de retenção](../plataforma/RETENTION.md) mantém os bloqueios
da aprovação pública, que não é inferida dessas provas.

A conferência intermediária de 05/10
preserva a análise da carga reprovada de `4192e63`, anterior às correções e
às duas execuções finais de `684edd7` registradas na rodada acima.

Guardar somente metadados e evidências sanitizadas. Não versionar contas,
senhas, cookies, JWTs, cabeçalhos de autenticação, XML privado, PFX, dumps,
HAR, traces ou exportações de banco. Evidência restrita segue a
[política de armazenamento](EVIDENCE-STORAGE.md#evidência-restrita): o
recibo público traz a conclusão e os hashes, e o original sai cifrado para
os custodiantes.
Consultar uma URL pública mostra o ambiente atual, não o estado do ensaio antigo.
