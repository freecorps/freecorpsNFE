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
  O que falta está na [matriz](ACCEPTANCE.md#pendências-atuais-e-condições-de-saída).
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
  conforme a [matriz](ACCEPTANCE.md#pendências-atuais-e-condições-de-saída).
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

## Pendências e aceite

Cada pendência declara, na [matriz](ACCEPTANCE.md#pendências-atuais-e-condições-de-saída),
o critério afetado, a lacuna, a condição de saída, o responsável funcional, a
evidência mais recente e a issue que a acompanha, com dependências explícitas.
Esse texto local basta para
entender o problema; a issue coordena o trabalho, com o andamento e as
próximas ações, mas não pode conter a única descrição da lacuna.

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
