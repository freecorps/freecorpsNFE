# Changelog

## Não publicado

- O e-mail da plataforma pode passar pelo Ember Mail (freecorps/mail), com
  `@freecorps/mail-sdk` (`EMAIL_MODE=mail`, `MAIL_API_URL`, `MAIL_API_KEY`),
  que cuida da fila, dos eventos de entrega e das supressões; quem opera
  ainda escolhe o Email Sending da própria conta Cloudflare
  (`EMAIL_MODE=cloudflare`, agora com `CLOUDFLARE_EMAIL_ACCOUNT_ID`). O site
  da Freecorps passa a usar `mail`. As caixas `privacidade@`, `seguranca@`, `suporte@` e
  `operacao@nfe.freecorps.com.br` passam a ser lidas e respondidas no Ember
  Mail, com o mesmo ciclo de cinco anos. Saem a caixa do console
  (`/console/privacidade`, `/seguranca`, `/suporte`, `/operacao`), as tabelas
  `privacy*` e o Worker `freecorpsnfe-privacy-mail`. A ordem da troca está em
  `docs/operacao/email.md`.
- A captura de NF-e não para mais no primeiro cStat 999 ("Rejeição: Erro
  não catalogado") da Receita (#195): o 999 não aponta problema na consulta,
  então a captura repete a consulta depois de uma hora e do intervalo mínimo
  da empresa, sem mexer no ponto de leitura. Só o terceiro 999 seguido põe a
  captura em atenção com `SOURCE_999` e manda o alerta; qualquer outra
  resposta zera a contagem, e cada 999 conta como falha da fonte nos
  monitores.
- O SDK muda de nome no npm: `@freecorps/sdk` passa a ser
  `@freecorps/freecorpsnfe-sdk`, com o export `/webhooks`. A API não muda;
  troque o pacote e os imports. O npm não aceita maiúsculas, por isso o nome
  é todo em minúsculas. A 0.1.0 com o nome novo foi aceita e publicada em
  03/11/2026 (#73; recibo em `docs/v1.0/evidence/73/2026-11-03`), e
  `@freecorps/sdk` ficou marcado como obsoleto, apontando para o nome novo.
- Os seis workflows da captura fiscal viram um, **Fiscal capture**
  (`capture-fiscal.yml`, #57), com a operação escolhida em `operation`:
  `list`, que é o padrão, `alert_test`, `emergency_withdraw`, `unblock`,
  `halt` e `resume`. Mesmo environment, mesmas pessoas autorizadas e uma fila
  por operação. Como o formulário mostra todas as entradas, o runner recusa
  com `INPUT_UNEXPECTED` uma entrada que a operação não recebe: um id de
  empresa em `halt` não para todas as empresas. Runbook em
  [captura-fiscal.md](docs/operacao/captura-fiscal.md).
- Repositório público (#267): desde 03/11/2026 o código está em
  https://github.com/freecorps/freecorpsNFE, sem o histórico anterior, que
  fica num repositório arquivado e privado. Guias, landing e documentação
  deixam de dizer que o repositório é privado; `tests/publicSite.test.ts`
  recusa essa frase e o `Callout` de acesso nos guias.
- Termos de uso 1.2 (`termos-de-uso-2026-11-04`): o primeiro parágrafo da
  seção 5 e a seção 5A levam os planos pagos ao período por aniversário
  (ADR 0012). As cotas do Gratuito seguem o mês civil UTC, e as dos planos
  pagos, o mês da assinatura; os planos pagos são só por cartão, cobrados na
  contratação e renovados no aniversário dela. As organizações recebem o
  aviso da seção 11 e aceitam a 1.2 até 04/12/2026.
- Termos de uso 1.1 (`termos-de-uso-2026-11-02`): a seção 1 deixa de oferecer
  a importação de lotes NFS-e ABRASF, retirada na #142, e diz que as NFS-e já
  importadas continuam para leitura, download e exportação. As organizações
  recebem o aviso da seção 11 e aceitam a 1.1 até 02/12/2026.
- Importação de lotes NFS-e ABRASF retirada (#142): Campinas passou o Simples
  Nacional para o Emissor Nacional em 01/11/2026 (#199), e os sistemas
  municipais ABRASF estão sendo trocados pela NFS-e nacional. Desde
  02/11/2026, um XML ABRASF (`ListaNotaFiscal/Nfse/InfNfse`, #141) enviado
  pelo console, pela REST ou pelo SDK é recusado com
  `XML_NAMESPACE_UNSUPPORTED`; a importação aceita só NF-e modelo 55. As
  NFS-e já importadas ficam só para leitura: continuam na lista, na
  consulta, no download e na exportação, e reprocessar um arquivo ABRASF
  antigo responde `OPERATION_CONFLICT` (409). A consulta fiscal dessas notas
  (#142) não será feita. A emissão NFS-e no sandbox não muda. Landing,
  guias, painel e documentação deixam de oferecer a importação ABRASF.

- Pacotes no npm (#83): `@freecorps/sdk`, `@freecorps/fiscal-core`,
  `@freecorps/fiscal-nfe` e `@freecorps/fiscal-nfse` 0.1.0 publicados em
  01/11/2026, com os bytes do lote `08e85d8` aceitos por pacote, versão e
  hash e conferidos pela prova de instalação a partir do registry.
  `@freecorps/contracts` continua privado. `packages/contracts/published.json`
  registra o contrato 8.0.0 como publicado, e o gate de contrato passa a
  recusar mudança incompatível nesse major. Guias, landing e `SDK.md` deixam
  de mandar instalar o tarball.

- Aceite dos termos de uso no console (#586): a organização nova é criada com
  o aceite do proprietário, e uma versão nova é avisada no console e vale 30
  dias depois; sem aceite, a organização mantém leitura, exportação e pedidos
  de titulares, mas não cria comandos novos (`TERMS_OF_USE_REQUIRED`, 403
  `SCOPE_DENIED` na API). Cada aceite guarda pessoa, data, versão e SHA-256
  em `termsOfUseAcceptances`. Nenhuma versão está em vigor até a D06: nada é
  pedido nem cortado.

- Caixa de operação (#463) no fluxo da privacidade, em `/console/operacao`:
  `operacao@nfe.freecorps.com.br` recebe os alertas da captura fiscal no
  console, com operadores próprios em `FNFE_OPERATION_OPERATOR_EMAILS`, em vez
  de caixas pessoais. O workflow `capture-fiscal.yml`, operação `alert_test`, manda um e-mail de
  teste pelo mesmo envio dos alertas, sem alerta de empresa. Ativada em 28/10/2026,
  com a entrega comprovada pelo teste.

- Caixa de suporte (#519) no fluxo da privacidade, em `/console/suporte`:
  faltava um canal geral de ajuda atendido. Usa o Worker, a fila e o console
  da caixa de privacidade, com operadores próprios em
  `FNFE_SUPPORT_OPERATOR_EMAILS`. Ainda não ativada: faltam a regra de Email
  Routing, os operadores, o ensaio externo e as decisões de prazo e guarda.

- Canal de segurança (#266): `seguranca@nfe.freecorps.com.br` usa o
  Worker, a fila e o console da caixa de privacidade, em `/console/seguranca`,
  com operadores próprios em `FNFE_SECURITY_OPERATOR_EMAILS`. Primeira
  resposta em até 5 dias úteis. Em 21/10/2026, uma mensagem externa foi
  recebida, lida e respondida pelo console, e o canal entrou no `SECURITY.md`.

- Restauração D05: em 19/10/2026, depois da #259, `retentionRecovery:recover`
  rodou em `elated-possum-295` e `inspect` terminou sem prazo sem job. O
  roteiro de D05 passou sobre o backup real `2026-10-19T15-11-40Z`, com o token
  R2 somente leitura do custodiante e login real no destino. O ensaio de perda
  do host da #51 continua pendente.

- Atendimento a direitos D02: o substituto aceitou a função, em conversa
  presencial relatada pelo mantenedor em 19/10/2026. Faltam o canal
  `privacidade@` e um pedido sintético exercitado.

- Atendimento a direitos D02: correção de nome e e-mail e exclusão de conta
  passam a ter procedimento manual do operador em RIGHTS.md, com resposta em
  até 15 dias, conforme a decisão de 19/10/2026. O fluxo no produto fica para
  depois do lançamento.

- Landing alinhada à cobertura aceita da 1.0 (#85): a página anuncia só a
  importação de NF-e modelo 55 e de lotes NFS-e ABRASF, a emissão NFS-e no
  sandbox, sem validade fiscal, e os contratos de API, SDK e webhook. Saem as
  contagens de cobertura nacional, a nota autorizada, a produção nos exemplos
  (agora a reserva de importação no sandbox), o backup e o link aberto para o
  repositório privado. NFC-e, CT-e e MDF-e aparecem como previstos; captura e
  Stripe, como em construção. A licença lista as restrições a terceiros e a
  minuta em revisão. `tests/publicSite.test.ts` recusa essas promessas, e
  PUBLIC.md registra a decisão de 18/10/2026, que substitui a de 12/10.

- Backup externo D04 (#178): a custódia provisória do substituto sai do
  plano e o mantenedor passa a ser o segundo custodiante, ao lado do
  substituto. As cópias cifradas para a identidade antiga expiram em até 14 dias.

- Backup externo D04 (#218): o `snapshot` localiza os arquivos de storage
  pelo id, aceitando a extensão que o `convex export` deriva do `contentType`
  (`_storage/<id>.xml`, `.pdf`). Desde 09/10/2026, com os primeiros artefatos
  de emissão em `application/xml`, todo snapshot falhava com "Arquivo ausente
  no snapshot" e nenhuma cópia íntegra foi gerada.
- Emissão NFS-e em Campinas (#197): o optante do Simples sem retenção deixa de
  informar a alíquota de ISS também no canal `campinas-adn`, como na Sefin
  Nacional (E0625). Pedido com `issRate` nesse caso passa a ser recusado com
  `ISSUANCE_ISS_RATE_NOT_ALLOWED`, e a DPS sai sem `pAliq`. Na homologação da
  IMA, em 09/10/2026, `pAliq` 2.00 sem retenção voltou com L0006 e com
  retenção, com L0009. Não optante e retenção continuam exigindo `issRate`. O
  console esconde o campo de alíquota nesse caso.
- Emissão NFS-e validada no XSD oficial (contrato 5.0.0, #195 e #197): o
  pacote `@freecorps/fiscal-nfse` incorpora os esquemas v1.01-20260209 do
  Portal NFS-e e confere cada DPS e pedido de cancelamento antes de assinar,
  rejeitando localmente com `DPS_SCHEMA_INVALID`/`EVENT_SCHEMA_INVALID`, sem
  transmitir. Corrige as duas causas da rejeição L9999 da primeira DPS real
  (09/10/2026): `verAplic` passa a `freecorpsNFE/1` (máximo 20) e o tomador
  no exterior exige código postal, estado, logradouro, número e bairro
  (`ISSUANCE_FIELD_INVALID` com `field`), obrigatórios também no contrato
  público e no SDK. A DPS de Campinas deixa de levar `dest` e `cLocIncid`, põe
  `pAliq` depois de `tpRetISSQN` com 2 casas, e o cancelamento deixa de levar
  `nPedRegEvento`, como manda o XSD. Alíquota com 3ª ou 4ª casa diferente de
  zero passa a ser recusada. O console nomeia o destino de Campinas.

- Emissão NFS-e em sandbox pela API pública (contrato 4.0.0): `POST /v1/issuances`
  e `POST /v1/issuances/{id}/cancellation` com `Idempotency-Key`, consulta,
  lista e download dos XML e do PDF do DANFSe preservados, escopos `documents:issue` e
  `documents:cancel`, webhooks `issuance.authorized`, `issuance.rejected`,
  `issuance.cancelled` e `issuance.cancellation_rejected`, códigos de erro da
  emissão com `error.field`, e `downloadIssuanceArtifact` no SDK. Transporte
  simulado, sem validade fiscal; produção continua atrás do gate por empresa.
- Emissão NFS-e: o gate de produção passa a ser conferido depois do acesso
  do chamador, sem revelar o seu estado a quem não pode emitir; operações
  `documents.issue` e `documents.cancel` gravadas com `documents:import` antes
  da #206 exigem `documents:issue` ou `documents:cancel` em
  `/v1/operations`, no console e no executor. Projetos com concessão só de
  `documents:import` precisam receber os escopos de emissão.

- Guarda após o encerramento, D01: cada tabela tem classe de retenção
  conferida no typecheck. Documentos, originais, operações, auditoria e
  registros comerciais de uma organização encerrada saem juntos em
  1º/01 do sexto ano seguinte ao encerramento, salvo retenção legal
  registrada pelo operador. Prazo contado do encerramento, e não de cada
  fato, aceito pelo mantenedor em 19/10/2026.
- Roteiro da prova fiscal da #50 executável de ponta a ponta: o plano exige
  SHA, alvo, serviço, ambiente fiscal, autorização, janela e orçamento; o
  runner valida o PFX offline, publica o SHA no alvo dedicado com transporte
  desligado e gera recibo público por lista fechada de campos. Nenhuma
  consulta fiscal foi executada.
- Guia público de contrato com ambientes, paginação por rota, envelope e
  códigos de erro, eventos e headers de webhook, disponibilidade do XML e
  limites da captura, derivados de `packages/contracts`. Cobertura passa a
  citar consultas auxiliares e exportação; painel deixa de anunciar como
  futuras entregas já disponíveis.
- Backup externo D04: cópia cifrada com age de banco e storage em R2 a cada
  12 horas, com monitor em outro runner, alerta por issue e ensaio de perda
  do host. Falta configurar bucket, tokens e custodiantes.
- API REST pública em `https://api.nfe.freecorps.com.br`, servida pelo Worker.
  O backend registra chave ou membro, IP e hora de cada acesso por 184 dias.
- Landing redesenhada e site público reescrito como componentes React
  pré-renderizados no build (`apps/console/src/site`), com Geist, modo escuro,
  movimento só em CSS e sequência de importação derivada do contrato. O gerador
  de HTML em `scripts/lib/public-site*.mjs` foi removido.
- Landing e guias estáticos da plataforma, com referência REST derivada do
  contrato, quickstart e limites explícitos. Protótipos ficam restritos ao
  desenvolvimento; indexação e lançamento dependem de aceite.

- Guias, contratos e critérios de aceite podem ser lidos sem PRs, issues ou
  histórico Git. Índices por capacidade apontam documentação e evidências locais;
  recibos antigos mantêm sua proveniência e seus limites.
- A decisão inicial Apache-2.0 foi substituída pela Licença de Código Disponível
  Freecorps 1.0 para plataforma e motor, com SDK cliente e contratos externos
  selecionados em MIT. Licenças de terceiros e direitos anteriores preservados.
- Termos de contribuição com aceite expresso e regras de uso interno, prestação
  de serviços, forks de colaboração, código correspondente e oferta concorrente.
- Avisos de runtime nos tarballs, inventário do lock e verificação de conteúdo,
  exports e instalação independente. Pacotes continuam privados.
- A prova dos tarballs empacota cada pacote pelo campo `files` do manifesto e
  recusa NF-e assinada, certificados e cópias de fixtures ou PEM versionados,
  mesmo dentro de `dist/`. Pacotes continuam privados.
- Distribuição externa de fiscal-nfe bloqueada pela permissão dos schemas
  incorporados. Datasets oficiais e corpus interno excluídos dos tarballs.
- O CI chama diretamente, sem sessão, toda função pública do Convex da
  plataforma, inclusive de módulos novos, e reprova a que responder sem estar
  declarada como pública.

As versões `0.1.0` nos pacotes identificam candidatos internos, não releases
npm. A versão do contrato OpenAPI é independente da versão dos pacotes.
Entregas anteriores e cobertura estão em [docs/README.md](docs/README.md) e
[evidências](docs/v1.0/EVIDENCE.md); este changelog não reclassifica essas
entregas como produto fiscal homologado.
