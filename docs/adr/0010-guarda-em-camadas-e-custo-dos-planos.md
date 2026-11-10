# Guarda em camadas e custo dos planos

Data: 29/10/2026 · Status: **Aceita** pelo dono do projeto,
nas onze decisões da seção [Decisão](#decisão), tomadas em sessão de
trabalho em 29/10/2026 e registradas na
[#642](https://github.com/freecorps/freecorpsNFE-arquivo/issues/642). As decisões 9,
10 e 11 resolvem as antigas pendências 4, 5 e 6 e estão no
[comentário da #642](https://github.com/freecorps/freecorpsNFE-arquivo/issues/642#issuecomment-6510521089) que as registra. As
[Pendências do dono](#pendências-do-dono) que restam não estão decididas.
Desde 09/11/2026 o Pix assistido não está mais no código (#125): o cartão é a
única forma de pagamento, e as menções ao Pix abaixo ficam só como registro da
decisão ([BILLING.md](../plataforma/BILLING.md)).

Esta ADR complementa a [ADR 0009](0009-custodia-fria-de-organizacoes-abertas.md);
as decisões 5 e 6 a ajustam. A emenda da
[#643](https://github.com/freecorps/freecorpsNFE-arquivo/pull/643) diz que a PR 6 da
série da 0009 reidrata só a janela quente e que a capacidade conta só a
janela; esta ADR substitui esses dois pontos (decisão 5). Ela substitui
também a atribuição às PRs 4 e 6 da referência por hash aos objetos frios
(decisão 6). O texto da 0009 será alinhado pela
[#644](https://github.com/freecorps/freecorpsNFE-arquivo/pull/644), PR da série da
0009 (acesso com organização arquivada). Da ADR, estão implementadas as 5
empresas do Intermediário (decisão 4, item 1) e, na fase D2, a cota de notas
do Gratuito (decisão 4, item 3, e decisões 10 e 11); o resto não está
implementado. Até cada fase ser publicada e provada, valem
[RETENTION.md](../plataforma/RETENTION.md), [backup.md](../operacao/backup.md),
[PLATFORM-PLAN-PROPOSAL.md](../plataforma/PLATFORM-PLAN-PROPOSAL.md) e
[PLATFORM-COSTS.md](../plataforma/PLATFORM-COSTS.md) como estão, e o catálogo
de planos continua desligado.

## Contexto

**Quanto ocupa uma nota.** Em 29/10/2026, com autorização do dono, uma
leitura sem escrita de `elated-possum-295` mediu 71 NF-e de Produção
capturadas, com resumos e eventos. Só agregados saíram da leitura, e ela não
tem recibo versionado. A amostra é pequena: 1 a 8 itens por nota, média de
2,37. O tamanho é o JSON das linhas, como aproximação de `getDocumentSize`,
sem índices. A medição cobre só NF-e; a NFS-e não foi medida.

| Medida                         |    Média | Regressão por item      |
| ------------------------------ | -------: | ----------------------- |
| XML `procNFe`                  | 10.005 B | 7.659 B + 991 B/item    |
| XML `resNFe`                   |    541 B | Não se aplica           |
| XML `procEventoNFe`            |  4.951 B | Não se aplica           |
| Banco lógico por nota completa | 37.220 B | 27.391 B + 4.154 B/item |

O banco por nota é de 3 a 4 vezes o XML e é quase todo derivado dele: a
versão completa (cerca de 12,5 KB, em `result`), a versão de resumo mantida
depois do XML completo (cerca de 5,3 KB), a evidência fiscal (cerca de
3,6 KB, em `snapshot`) e os itens (cerca de 3,5 KB cada).

**Custo.** No modelo `paid-plans.mjs`,
em estresse, o backup de 12 horas custa R$ 8,30, R$ 16,61 e R$ 66,44 por mês
no Gratuito, no Intermediário e no Grande, contra R$ 0,40, R$ 0,75 e
R$ 2,70 de todo o armazenamento com a cota cheia. Um GB de banco custa
cerca de R$ 1,90 por mês de armazenamento e cerca de R$ 248 por mês no
backup, que o lê 60 vezes. Uma nota completa de 37 KB no banco custa cerca
de R$ 0,0092 por mês em backup.

**Limites.**

- O backup recusa o snapshot acima de 1 GiB do deployment inteiro, banco e
  arquivos (`maxSnapshotBytes`); a D04 fica sem RPO. Um Grande com os 2 GiB
  de arquivos cheios já não cabe.
- O [formato 2](../operacao/backup.md#backup-incremental-formato-2) limita
  cada tabela a 64 MiB (`TABLE_LIMIT`, em
  `scripts/lib/incremental-backup.mjs`). As duas versões de uma nota somam
  cerca de 17,8 KB em `documentVersions`, que chega a 64 MiB perto de 3.700
  notas no deployment; o limite então recusa o snapshot e limita a
  capacidade dos planos. Os bloqueios atuais do formato 2 (retenção e lock,
  coleta e ensaio) estão em
  [backup.md](../operacao/backup.md#gate-de-ativação-e-retenção-de-objetos).
- Com 37 a 48 KB por nota (48 KB corresponde a 5 itens pela regressão), o
  banco de 32 MiB do Gratuito comporta 700 a 900 notas no total; com 100 por
  mês, enche em 7 a 9 meses.

**Prazos.** A guarda fiscal segue o
[CTN, art. 173, I](https://www.planalto.gov.br/ccivil_03/leis/l5172compilado.htm),
e o art. 195, parágrafo único; a
[D01](../plataforma/RETENTION.md#guarda-após-o-encerramento-d01) conta até
31/12 do quinto ano seguinte ao fato, até cerca de 72 meses.

## Decisão

O dono do projeto decidiu, em 29/10/2026, o que segue. O que vem marcado
como decorrência não é texto do dono, mas segue dele sem escolha.

### 1. Backup

O backup continua a cada 12 horas, com RPO e RTO internos de 24 horas. Não
passa a uma execução por dia. A redução de custo vem de um banco quente
menor.

Decorrência: a economia de mover bytes do banco para arquivos depende do
formato 2. O formato 1 exporta com `--include-file-storage`, e nele mover
bytes do banco para arquivos não reduz o snapshot.

### 2. Compactação

Os dados derivados do XML original (por exemplo `result`, `fiscalEvidence` e
`snapshot`) deixam de ocupar o banco quente além do necessário para listagem
e busca. Mover, nunca descartar. A linha continua no banco com seus
metadados e hashes. O conteúdo vai para um blob imutável, conferido por hash
na leitura. Valores fiscais continuam texto decimal exato. A compressão do
blob é desenho da fase B.

### 3. Camadas

A nota fica na camada quente por 3 meses no Gratuito e 12 meses nos planos
pagos, e depois na camada fria até completar no mínimo cinco anos, pela
contagem da D01. A guarda segue [RETENTION.md](../plataforma/RETENTION.md),
inclusive a regra da organização mista: uma organização com qualquer dado de
Produção guarda também o Sandbox. O expurgo antecipado vale só para a
[organização sem Produção](../plataforma/RETENTION.md#organização-sem-produção-decidido-em-27102026).
A passagem nunca apaga originais, o expurgo segue a RETENTION, e nenhum ID é
recriado.

### 4. Comercial

1. Intermediário com 5 empresas, antes 3.
2. Plano anual com 2 meses grátis, a R$ 1.490 e R$ 4.990, por cartão no
   Stripe e Pix assistido. Nos dois planos, o anual só é ligado depois da
   fase E (#642).
3. No Gratuito, a captura em Produção admite no máximo 100 notas por mês,
   com a definição de nota da decisão 11; no Sandbox, a captura segue com
   cota de teste própria. A decisão 10 estende o limite à importação.
4. Os planos pagos não são convertidos para notas.
5. O catálogo continua desligado.

A unidade da cota do Gratuito está na decisão 10.

### 5. Reidratação

Este item ajusta a seção 5, itens 1 e 7, da ADR 0009. Ao reativar uma
organização arquivada, só a janela quente do plano volta ao banco; o
restante vai para a camada fria. A checagem de capacidade conta a janela
quente mais o resíduo de todas as notas, e não só a janela, como diz a
emenda. Quanto à ordem, a PR 6 da série da 0009 reidrata tudo, como antes, e
a regra da janela entra numa PR depois da fase C (fase C2). Isso substitui o
que a emenda da #643 atribuiu à PR 6.

Decorrência, como invariante: a reidratação sempre recria o resíduo quente
de toda nota (`fiscalDocuments`, o índice e as linhas que ficam no banco),
para preservar a listagem e a deduplicação.

Implementada na fase C2 ([#689](https://github.com/freecorps/freecorpsNFE-arquivo/issues/689)),
com o desenho descrito no fim da seção [Fases](#fases).

### 6. Pacote da 0009 e camada fria no R2

O pacote da ADR 0009 de uma organização com notas frias referencia esses
objetos pelo hash, sem copiá-los. O lock do R2 segue o maior prazo entre o
do pacote e o da nota fria. Decorrência: a camada fria fica no R2, fora do
deployment. A partir da fase C, o pacote referencia por hash; antes dela não
há notas frias. Isso substitui a atribuição às PRs 4 e 6 da 0009.

### 7. Anual do Intermediário

O anual do Intermediário fica mantido. A fase E inclui, além do cenário de
100% de uso, um cenário com o uso medido em produção, no percentil 75 por
organização.

Cálculo desta ADR, como limite superior (backup zerado): no preço anual
(R$ 1.490 / 12 e R$ 4.990 / 12), a partir dos custos de `paid-plans.mjs` e
com 100% de uso, a margem base e em estresse é de 25,8% e 20,5% no
Intermediário e de 28,8% e 24,0% no Grande, contra as metas de 25% e 20%.

### 8. Original da nota fria no R2

O XML original de uma nota fria também vai para o R2, junto com os
derivados, e sai do teto de 1 GiB. O efeito em `documentArtifacts.storageId`,
`documentDownloads`, `fiscalGuard` e no pacote da 0009 fica para o desenho da
fase C.

### 9. Anual: reembolso e ciclo

Resolve a antiga pendência 4
([#642](https://github.com/freecorps/freecorpsNFE-arquivo/issues/642#issuecomment-6510521089)).

- Até 7 dias depois da compra, o reembolso é integral (arrependimento, CDC
  art. 49).
- Depois disso, os meses usados são recalculados pelo preço mensal cheio, e
  o cliente recebe a diferença; o acesso vai até o fim do mês civil corrente.
  - Exemplo: o Intermediário cancelado no 4º mês devolve
    R$ 1.490 − 4 × R$ 149 = R$ 894.
  - A partir do 10º mês, o reembolso é zero.
  - A punição é perder o desconto.
- Upgrade do Intermediário anual para o Grande anual: o cliente paga
  (R$ 4.990 − R$ 1.490) / 12 por mês restante, com o mês corrente contado
  inteiro. A renovação não muda, e a Freecorps complementa o aporte de
  R$ 172 antes de liberar.
- Downgrade só vale na renovação, sem reembolso.
- Mensal para anual: começa no dia 1 do mês seguinte ou imediatamente, com
  cobrança cheia, à escolha do cliente.
- Pix assistido segue as mesmas regras, com reembolso manual.
- A seção 5A dos termos precisa de revisão jurídica antes da oferta.
- Decidido pelo dono em 30/10/2026
  ([#642](https://github.com/freecorps/freecorpsNFE-arquivo/issues/642#issuecomment-6523073174)):
  - o reembolso integral em 7 dias vale para cada cobrança anual, inclusive
    as renovações, a confirmar na revisão jurídica;
  - "Não renovar" é pelo próprio cliente, sem reembolso e com os meses pagos
    mantidos; "Rescindir" passa pelo suporte, com o reembolso calculado pelo
    servidor e devolvido à mão pelo operador (Stripe ou Pix), e o acesso vai
    até o fim do mês civil corrente, ou termina na hora dentro dos 7 dias;
  - "a renovação não muda" quer dizer que o upgrade mantém a data de
    renovação, e a renovação passa a ser do Grande anual;
  - no cartão, o anual começa no dia 1 do mês seguinte; "imediatamente" é
    só pelo Pix.
- Decidido pelo dono em 31/10/2026:
  - o reembolso integral em 7 dias vale também para a cobrança de upgrade:
    desfeito nesse prazo, ela volta inteira, e o termo e a renovação voltam
    ao Intermediário;
  - depois dos 7 dias, a rescisão de um termo com upgrade devolve o total
    pago menos os meses usados, cada um pelo preço mensal cheio do tier em
    vigor nele. Exemplo: Intermediário anual de R$ 1.490, upgrade no 5º mês
    por R$ 2.333,33 e rescisão no 8º devolvem
    R$ 3.823,33 − (4 × R$ 149 + 4 × R$ 499) = R$ 1.231,33.

- Decidido pelo dono em 01/11/2026 (#428): a seção 5A dos termos de uso 1.0,
  publicados nesse dia, traz o anual como está acima, aprovada por ele sem
  revisão jurídica. Isso substitui a revisão jurídica pedida acima, inclusive
  a confirmação do arrependimento nas renovações e no upgrade
  ([decisões](../v1.0/TERMS-DRAFT.md#decisões-de-01112026)). O anual continua
  desligado até a #690.
- Decidido pelo dono em 03/11/2026: toda assinatura paga, mensal ou anual,
  corre por aniversário, do instante da contratação ao mesmo dia e horário do
  mês ou do ano seguinte; o anual no cartão começa e é cobrado na
  contratação; e as cotas dos planos pagos seguem o mês da assinatura. Isso
  substitui "no cartão, o anual começa no dia 1 do mês seguinte;
  'imediatamente' é só pelo Pix". O resto foi adotado no desenho da
  [ADR 0012](0012-periodo-por-aniversario.md), e não decidido pelo dono:
  - a escolha do Pix entre o dia 1 e o início imediato deixa de existir; o
    Pix começa na confirmação ou, na renovação pedida no último mês, no fim
    do plano em vigor;
  - "Mensal para anual: começa no dia 1 do mês seguinte ou imediatamente,
    com cobrança cheia, à escolha do cliente" passa a ser o anual no cartão
    cobrado e iniciado no pagamento, com cobrança cheia, sobre um mensal de
    tier igual ou menor, ou o anual Pix como renovação no fim do mensal; no
    cartão, um anual menor que o mensal em vigor espera o fim dele (regra de
    um plano pago por vez, aprovada pelo dono como desenho);
  - os meses do reembolso passam a ser os da assinatura, e o acesso depois
    da rescisão fora dos 7 dias vai até o fim do mês corrente da assinatura,
    no lugar de "o fim do mês civil corrente", nas duas vezes acima.

  Valores e prazos acima não mudam. A ADR 0012 ainda não está implementada.
  (Nota posterior: a ADR 0012 foi implementada nas fatias 0 a 2b, com o
  catálogo ainda desligado; ver o status dela.)

### 10. Importação e cota de notas do Gratuito

Resolve a antiga pendência 5
([#642](https://github.com/freecorps/freecorpsNFE-arquivo/issues/642#issuecomment-6510521089)).

- Em Produção, o limite é de 100 notas novas por mês, somando importação e
  captura. Ele substitui a cota de consultas de captura em Produção.
  Continuam valendo os limites técnicos: 120 consultas/h por empresa,
  cooldowns da SEFAZ e reserva de 18 MiB.
- No Sandbox, a cota de teste continua a de hoje (100 arquivos importados e
  100 consultas de captura por mês) e fica fora da conta de notas.

Implementada na fase D2, com a decisão 11: `notes` no catálogo do Gratuito,
contada pela unidade Documento de Produção e conferida na admissão
([USAGE.md](../plataforma/USAGE.md#cota-de-notas-do-gratuito)).

Lote NFS-e ([#649](https://github.com/freecorps/freecorpsNFE-arquivo/issues/649)):
cada arquivo admitido reserva uma nota provisória, mas um lote NFS-e publica
até 20. O dono decidiu, em 30/10/2026, conferir a cota quando o lote é lido:
as notas novas do lote, somadas às publicadas e pendentes do mês sem a
provisória do arquivo, não podem passar do limite, ou o lote falha inteiro com
`NOTES_QUOTA_EXCEEDED`. Foram recusadas a reserva de 20 notas por arquivo, que
travaria o Gratuito com poucos arquivos pendentes, a recusa do lote NFS-e no
Gratuito e um teto de arquivos pendentes, que só reduziria o pior caso.

### 11. Definição de nota

Resolve a antiga pendência 6
([#642](https://github.com/freecorps/freecorpsNFE-arquivo/issues/642#issuecomment-6510521089)).

- Uma chave de acesso distinta conta 1 nota. Resumo, XML e eventos da mesma
  chave contam uma vez só.
- A mesma chave em duas empresas da organização conta 2 notas.

Implementada na fase D2: a nota é um `fiscalDocuments` de Produção, único por
organização, empresa, ambiente, modelo e chave, contado uma vez na primeira
publicação.

## Invariantes

Toda fase prova, na PR que a implementa:

- o histórico nunca é apagado;
- valores fiscais continuam decimais exatos;
- a leitura é conferida por hash e recusa se divergir;
- nenhum ID é recriado;
- a guarda mínima é cumprida;
- organizações, projetos e empresas ficam isolados;
- Sandbox e Produção ficam separados;
- a deduplicação por organização, empresa e ambiente vale também para a nota
  fria, na importação e na captura;
- repetição e retomada não duplicam efeito, e nenhum blob referenciado se
  perde;
- a passagem e um run da 0009 não correm ao mesmo tempo na mesma
  organização;
- a passagem não grava no R2 lock que impeça o expurgo antecipado da
  organização sem Produção, nem altera o que a detecção de `sandboxOnly` lê
  (ADR 0009, seção 1;
  [arquivo econômico](../operacao/arquivo-economico.md#elegibilidade-e-congelamento));
- os objetos frios no R2 são dependências do backup: entram no manifesto do
  formato 2 e são conferidos na publicação e na recuperação, como os pacotes
  da 0009 em `coldArchives`
  ([arquivo econômico](../operacao/arquivo-economico.md#backup-e-recuperação-da-plataforma));
- as notas frias entram na exportação da janela de 30 dias do encerramento
  (D01), nos downloads e nos exports;
- nenhum dado real entra em teste, recibo ou documento;
- o teto de 1 GiB e o limite de 64 MiB por tabela são conferidos antes de
  ligar a fase.

## Fases

| Fase | Assunto                                                                                                                               | Depende de                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A    | Esta ADR                                                                                                                              | Nada                                                                     |
| B    | Compactação do banco                                                                                                                  | PR 6 da série da ADR 0009                                                |
| C    | Camada fria no R2: índice, passagem, leitura e download frios, pacote da 0009 por hash, contrato REST, OpenAPI, SDK e console         | B; formato 2 ligado                                                      |
| C2   | Reidratação só da janela quente                                                                                                       | C                                                                        |
| D    | Catálogo e cobrança: 5 empresas; anual por Stripe e Pix; Gratuito com 100 notas por mês em Produção; termos (seções 5A e 9) e BILLING | Corre em paralelo a B e C                                                |
| E    | Modelo de custo com os cenários de 100% de uso e de uso P75                                                                           | B e C medidas; formato 2 ligado para medir a economia; liga o anual de D |

A fase B:

- muda o formato de `ARCHIVE_STORAGE_FIELDS`, que a PR 5 ou 6 da série da
  0009 converte de um campo por tabela para uma lista de campos;
- muda `lib/storageHolders.ts`, o `STORAGE_FIELDS` e o teste do backup
  incremental;
- muda todos os leitores dos campos movidos, levantados por inventário na
  própria fase. Entre eles: a listagem (`summary()`), o detalhe, `/items`,
  `/events`, `/versions` e `/json?versionId=`, o histórico do console, os
  exports, o resultado de importação, o worker de projeção e a conferência
  de repetição do processamento (`PROCESSING_CHANGED`), que não pode dar
  falso positivo nem deixar passar divergência;
- inclui um recibo de medição gerado por script, sem dado real, e a contagem
  de órfãos.

A medição de antes da compactação (B1) está no
recibo da #642, com a comparação com a
leitura de produção desta ADR. A contagem de órfãos é
`backupInventory:storageAudit`, ainda não executada em produção.

O formato do blob (B2) é `document-content/1`, em
`platform/convex/lib/documentContent.ts`, ainda sem escritor nem leitor: um
JSON com a etiqueta do formato e, nesta ordem, `result`, `fiscalEvidence`
(opcional), o `data` dos itens em ordem de posição e o `snapshot` (opcional),
cada um a string exata do banco, sem reinterpretar valores. A identidade é o
SHA-256 do JSON sem compressão (`contentSha256`), conferido com o tamanho e a
etiqueta em toda leitura; o SHA-256 do gzip só casa o upload. O runtime
padrão do Convex tem `crypto.subtle`, mas não `CompressionStream` nem
`DecompressionStream`, conforme o código aberto do runtime em 30/10/2026.
Por isso o gzip vem do `fflate`, JavaScript puro sem dependências, que roda
nos dois runtimes: nível 9, mtime 0 e sistema 255, com saída determinística
para a mesma versão do `fflate`. Nada disso foi executado num backend
Convex. O conteúdo acima de 8 MiB é recusado na escrita e na leitura. A
leitura recusa também bytes fora da forma canônica, mesmo com hash certo. Os
itens valem pela posição na lista: o escritor da B4 confere que as posições
de `documentItems` da versão vão de 0 em diante, sem lacunas, antes de
codificar.

A B3 só alarga o schema, sem escritor, leitor nem backfill. O escritor é a
B4, descrita no fim desta seção.
`documentVersions` ganha os campos opcionais e planos `contentStorageId`
(índice `by_contentStorageId`), `contentSha256`, `contentSize`,
`contentFormat` e `card`: tipo, emissão, número, emitente, total em texto e
origem, como `summary()` os devolve. O número pode vir da chave de acesso
(`fiscalKey`), não de `result`, e o escritor da B4 grava a saída de
`summary()`.
`documentFiscalEvidence` ganha `snapshotSha256` opcional. `result`,
`documentItems.data` e `snapshot` continuam obrigatórios. O blob entra em
todos os inventários de arquivo: `storageHolders`, o `STORAGE_FIELDS` do
backup incremental, `ARCHIVE_STORAGE_FIELDS`, a classificação
`rewritten` de `coldArchiveReferences.ts` (os IDs dentro do blob ficam
como estão, então o hash continua válido), o inventário de capacidade, pelo
tamanho comprimido, e o expurgo da guarda, que apaga o blob com a versão e
acha o dono pela operação, porque no caminho das operações o artefato já
saiu.

A B4 é a escrita dupla, sem leitor nem backfill. Toda versão criada passa
por `importProcessing.stage` e é publicada por `importProcessing.published`,
inclusive a NFS-e, a captura e o reprocessamento de recusas. Ao publicar a
versão, essa mutation agenda `importProcessing.storeContent`, uma action do
runtime padrão que lê o conteúdo, confere que as posições dos itens vão de 0
em diante, codifica e grava o blob com o MIME
`application/vnd.freecorps.document-content+gzip`. Em seguida,
`importProcessing.attachContent` relê a versão e recalcula o `contentSha256`
a partir dos campos em linha. A mutation confere o hash e o tamanho do
arquivo e grava os campos e o `card`, a saída de `summary()`, só se a versão
ainda não tiver blob. Também grava o `snapshotSha256` da evidência que a
versão escreveu e conta o arquivo na cota pelo tamanho comprimido, sem
recusar. Repetir com o mesmo blob não faz nada. Um segundo blob da mesma
versão é apagado, e um blob de outra versão é recusado sem ser apagado. Se o
conteúdo mudou depois da codificação, o blob é apagado e a codificação se
repete até três vezes. Conteúdo acima de 8 MiB, ou com lacuna nos itens,
fica só em linha, com aviso no log, e a importação não muda de resultado.
Uma queda entre a gravação e o vínculo deixa um órfão com esse MIME. A
varredura de `importUpload.ts` apaga esse órfão depois da janela de upload,
se nenhuma versão o tiver e nenhuma intenção de `coldArchiveUploads` o
segurar. Uma reidratação pausada não perde o blob que já subiu. Cada gravação
pede essa janela à varredura logo antes de gravar, porque a captura não pede
outra e a action pode rodar atrasada. Numa organização já em custódia do
arquivo, o vínculo devolve `archived` sem gravar nada, e a varredura recolhe o
blob. A conferência
`PROCESSING_CHANGED` continua comparando o texto em linha. Quando a B8 limpar
esses campos, ela terá de comparar pelo hash.

Uma versão publicada pode ficar sem blob: falha passageira da action,
organização arquivada no momento do vínculo, conteúdo acima de 8 MiB ou
lacuna nos itens. A B5 e a B8 tratam "publicada sem blob" como estado
normal, lido em linha. O backfill da B7 cobre essas versões. O consumo de
memória perto do limite de 8 MiB não foi medido num backend Convex real, só
no Node dos testes. O smoke B4 local
agora comprova o caminho no backend Convex local com fixtures após o parser,
inclusive perto de 8 MiB e a recusa acima do limite. Não mede memória: essa
métrica não foi fornecida pelo runtime. Não é prova em produção nem migra B5.
Este smoke satisfaz apenas a prova funcional local da escrita B4. O parágrafo
acima descreve o estado antes da prova de margem: a avaliação de memória
exigida antes da B5 terminou em 01/11/2026, pelo critério do dono:
os leitores rodam em actions Node e precisam ler 3× o limite. Num preview
descartável, com conteúdo sintético incompressível, o leitor Node leu 24 MiB e
falhou a 32 MiB, e quatro leituras simultâneas no limite passaram. O V8 leu
16 MiB. O recibo está em margin-hosted.md.

A B5 muda os leitores para o blob. Uma query não lê arquivos, então cada
leitor de conteúdo trabalha em três passos (`lib/documentContentPlan.ts`):

1. Uma query confere o acesso, pagina e devolve um plano. O plano traz os
   metadados da resposta e, para cada versão, a referência do blob ou, sem
   blob, as partes lidas em linha.
2. Uma action Node (`documentContentNode.ts`) lê cada blob inteiro pelo codec,
   uma versão por vez, e guarda só as partes pedidas.
3. Uma função pura (`lib/documentRender.ts`) monta a resposta. Em seguida, a
   query roda de novo, e a resposta só sai se o segundo plano for igual ao
   primeiro. Depois de três divergências seguidas, a resposta é
   `UNAVAILABLE`.

Uma versão com blob é sempre lida dele, mesmo com a cópia em linha ainda
gravada. Um blob ausente, com hash errado ou com referência parcial responde
`UNAVAILABLE` (503) e nunca cai para a cópia em linha. Esse caminho atende:

- a REST de detalhe, `json`, `items`, `events` e `versions`;
- o resumo e o histórico de importação na REST;
- a exportação, em que a query emite registros `$content` e o worker os
  preenche;
- o worker de projeção fiscal, inclusive o `snapshot` da evidência, conferido
  por `snapshotSha256` quando a linha não o tiver.

A listagem e o número das notas de um lote vêm do `card`. O DANFE sabe pelo
`card.cancellation` quais eventos são cancelamentos com resposta da SEFAZ.
Um card sem esse campo, gravado antes da B5, é lido de novo em linha. O
cursor de `/items` passa a ser a próxima posição, com no máximo `limit`
itens e cerca de 400 KB por página. Um cursor emitido antes da B5 é recusado
com `INVALID_CURSOR`, e uma exportação em andamento com cursor antigo de
itens falha e precisa ser pedida de novo.

A B6 leva o console ao mesmo caminho. Cada leitor de conteúdo do console
(detalhe, itens, versões e eventos de um documento, resultado e histórico de
um arquivo importado) tem duas entradas com os mesmos argumentos
(`contentRead.ts`):

- uma query de token, reativa, que devolve o SHA-256 da seleção;
- uma action Node pública (`documentContentNode.ts`), que lê e monta a resposta
  com a identidade de quem chama.

O hook `useContent` do console assina o token e chama a action de novo quando
o token muda. Até a resposta nova chegar, a tela mostra a anterior. As queries
públicas que liam em linha (`documents.detail`, `documents.items`,
`documents.versions`, `imports.detail` e `importHistory.get`) saíram. O
resumo de importação do console (`imports.get` e `imports.selected`) não traz
mais `result`, e o argumento `includeResults` é aceito e ignorado. A REST
continua trazendo o resultado no resumo.

A B7 é a migração dos dados já gravados (`contentMigration.ts`, procedimento em
[compactacao-documentos.md](../operacao/compactacao-documentos.md)). O
`backfill` agenda o escritor da B4 para cada versão publicada sem blob e
regrava o cartão de evento sem `cancellation`. A `audit` lê cada blob pelo
codec numa action Node e compara o hash com o do conteúdo em linha codificado
naquele momento. Se forem iguais, marca `contentVerifiedAt`. Um blob ausente,
danificado ou diferente bloqueia a B8. Cada passo é uma transação limitada que
grava o cursor e as contagens em `contentMigrations` e agenda o seguinte. Uma
etapa interrompida retoma do cursor, e um passo repetido não avança nada.

A B8 retira a cópia em linha (`lib/documentContentCleanup.ts`). Uma versão a
perde quando tem blob verificado e, se tiver documento, um cartão completo.
Saem `result` e `fiscalEvidence` (o hash da evidência fica em
`fiscalEvidenceSha256`), as linhas de `documentItems` da versão e o `snapshot`
da evidência que ela escreveu, este só quando confere com `snapshotSha256`. Em
uma versão nova, o escritor relê o blob pelo codec logo depois do vínculo,
marca `contentVerifiedAt` e retira a cópia na mesma hora. As versões gravadas
antes passam pela etapa `cleanup` de `contentMigration.ts`, que só começa com
a auditoria da B7 concluída e sem bloqueio. Uma versão sem blob (acima de
8 MiB, com itens fora de posição ou arquivada quando escrita) guarda a cópia
em linha para sempre. O `PROCESSING_CHANGED` passa a comparar por
`outputHash` e `fiscalEvidenceSha256` (`stagedVersionChanged`), e uma versão
sem a cópia não recebe evidência tardia. A auditoria tira `contentVerifiedAt`
de um blob que deixou de ler ou que diverge. Medido em convex-test, o banco
de uma NF-e cai de 22,7 KB para 5,9 KB por nota
(recibo).

A fase C entra em PRs pela
[#689](https://github.com/freecorps/freecorpsNFE-arquivo/issues/689). A C1 move o
conteúdo da versão (o blob da fase B) para um bucket R2 próprio da camada
fria e lê dali (`coldTier.ts`, `coldTierWorker.ts`, `lib/coldObjects.ts`).
O procedimento está em [camada-fria.md](../operacao/camada-fria.md).

- O Convex fala com o bucket pela API S3, com um token restrito a ele no
  ambiente do deployment. Não há cifra na aplicação: o R2 cifra em repouso,
  e toda leitura confere o SHA-256 do conteúdo pelo codec da fase B. O
  objeto é o mesmo gzip, byte a byte, com a chave
  `documents/<organização>/<versão>/content-<contentSha256>.gz`.
- `documentVersions` ganha `contentObjectKey`; a versão tem o blob em
  exatamente um lugar, `contentStorageId` (quente) ou `contentObjectKey`
  (frio). `fiscalDocuments` ganha `coldState` (`moving` ou `cold`),
  `coldClaimedAt` e `coldAt`. A linha, a listagem, o cartão e a chave de
  deduplicação ficam no banco.
- A passagem é um job com gate (`FNFE_COLD_TIER=enabled` e o bucket
  configurado). O operador o inicia uma vez, e cada varredura agenda a
  seguinte um dia depois. Não há cron registrado, porque o smoke da
  publicação exige zero crons. A varredura lê, 16 por passo e com um minuto
  entre os passos, as notas quentes que saíram da janela do plano (3 meses no
  Gratuito, 12 nos demais e sem plano; a leitura começa nas mais antigas que
  3 meses, a menor janela). Uma nota passa quando sai da janela e todas as versões publicadas têm blob
  verificado (B7). A action grava o objeto, relê e compara os bytes, e só
  então aponta a versão para ele. O arquivo quente sai uma hora depois, para
  os leitores que já tinham selecionado a versão.
- Nunca correm juntos uma passagem e um run da ADR 0009: a varredura pula a
  organização com run, e o aviso e o congelamento da 0009 recusam a
  organização com nota em passagem (`ARCHIVE_COLD_TIER_MOVING`).
- O expurgo da guarda enfileira o objeto frio da versão apagada
  (`coldObjectDeletions`), e o job o apaga do bucket.

A C2 está descrita depois desta lista. A REST e o SDK não indicam a camada: o contrato v1 está
publicado e não aceita campo novo num schema existente sem versão major; uma
indicação pública fica para o próximo major ou para uma rota nova. O console
mostra a camada na listagem, e a leitura não muda. A coleta de órfãos usa uma intenção gravada antes de cada objeto
(`coldObjectUploads`) e respeita o lock do ano de guarda
([camada-fria.md](../operacao/camada-fria.md#objetos-órfãos)).

Lock do bucket frio, decidido pelo dono em 02/11/2026: o R2 só trava por
prefixo, e a chave da nota de Produção leva o ano em que termina a sua guarda
(`documents/production/guard-<ano>/...`). Uma regra por data trava cada ano
até 01/01 do ano seguinte, e o Sandbox (`documents/sandbox/...`) fica sem
lock. A passagem só move a nota cujo ano tem regra confirmada
(`FNFE_COLD_LOCKED_THROUGH`). O pacote da 0009 estende o lock até o seu
`retainUntil` com uma regra por organização e ano, o maior prazo da decisão 6
([camada-fria.md](../operacao/camada-fria.md#lock)).

O pacote da 0009 referencia os objetos frios pelo hash (decisão 6), sem
copiá-los. O executor tira a lista das linhas de `documentVersions` do
próprio pacote, relê cada objeto no bucket frio e confere o SHA-256 antes de
selar. A lista (`chave sha256 tamanho`, uma por linha) fica imutável ao lado
do pacote, em `cold-documents.txt`. O manifesto do pacote leva
`coldDocuments`, com o bucket, a contagem e o SHA-256 da lista. O backup
confere esses objetos junto com o pacote: por HEAD na publicação e pelo hash
na recuperação. Uma organização com nota fria entra no arquivo como qualquer
outra, e a reidratação recria a versão com a mesma chave do objeto.

Os objetos frios entram no manifesto do formato 2 em `coldDocuments`
([backup.md](../operacao/backup.md#documentos-frios-da-adr-0010)). A versão
fria guarda o SHA-256 e o tamanho do objeto, e o manifesto amarra a lista
ordenada pela contagem e por um digest. A publicação confere existência e
tamanho de cada objeto por HEAD, e a recuperação relê cada um e confere o
hash.

O XML original da nota fria (decisão 8) vai ao mesmo bucket, na mesma
passagem, depois das versões. O objeto é o gzip determinístico dos bytes do
XML, com a chave
`documents/<production/guard-<ano> | sandbox>/<organização>/<artefato>/original-<sha256>.gz`,
em que o `<sha256>` é o do XML (`documentArtifacts.sha256`) e o ano de guarda
é o maior entre as versões que leem o original. `documentArtifacts` ganha
`objectKey` (índice `by_objectKey`), `objectSha256` e `objectSize`, os dois
últimos do objeto; `storageId` passa a opcional, e o original fica em
exatamente um lugar. O arquivo do import solta o mesmo arquivo, que sai do
armazenamento uma hora depois. Vai só o original que é da nota: o artefato de
uma versão dela, com o `documentId` dela, que nenhuma versão de outro
documento lê e cujo arquivo nenhuma outra linha segura. O lote de NFS-e, as
suas entradas e qualquer original compartilhado ficam quentes e não seguram a
nota. Uma regra só (`coldTier.noteOriginals`) decide isso para o plano, o
vínculo e o fim da passagem: a nota fica fria quando todas as versões
publicadas e todos esses originais estão no bucket, e o original espera o
lock do seu ano como as versões. Ao ficar fria, a nota perde o PDF guardado
do DANFE, que é gerado de novo do original frio no próximo download. Todo
leitor dos bytes do original passa por `lib/documentOriginalRead.ts`, que
confere hash e tamanho do objeto e do XML e responde `UNAVAILABLE` sem cair
para outra cópia: o download pela REST e pelo ticket do console (mesmos
bytes e cabeçalhos, consumo pelo tamanho do XML), o DANFE, a exportação, a
projeção fiscal e o reprocessamento. O expurgo da guarda enfileira o objeto
em `coldObjectDeletions`, e a coleta de órfãos trata a chave de um original
como segura. A REST e o SDK não mudam. O backup e o pacote da 0009 leem os
mesmos campos e a mesma chave
([#740](https://github.com/freecorps/freecorpsNFE-arquivo/pull/740)).

A C2 reidrata só a janela quente (decisão 5, na
[#689](https://github.com/freecorps/freecorpsNFE-arquivo/issues/689)). O executor da
ADR 0009 não grava no bucket frio e não recebe credencial nova, por decisão
do dono: os arquivos passam por lotes no Convex. O executor deixa fora da
etapa de arquivos os arquivos das notas fora da janela. Depois das linhas e
das referências, sobe esses arquivos ao Convex em lotes. A passagem da fase C
(`coldTierWorker.move`) move cada lote para o bucket e apaga os arquivos
quentes antes do lote seguinte. É a mesma passagem da varredura, com a
intenção em `coldObjectUploads`, a releitura com comparação de hash, a chave
com o ano de guarda e a regra do lock (`lockPending`). O procedimento está em
[arquivo-economico.md](../operacao/arquivo-economico.md#reidratação-com-ids-novos)
e em [camada-fria.md](../operacao/camada-fria.md#na-reidratação).

- **Ordem.** A etapa fria (`cold`) fica entre a reescrita das referências e
  a conferência (`coldArchiveRehydration.coldBatch` e `coldStep`). As linhas
  já existem com os IDs novos. Por isso a chave do objeto leva o ID novo da
  versão ou do artefato, e o ano de guarda sai das linhas reidratadas. O
  vínculo (`attach` e `attachOriginal`) confere a chave com `objectPlace` e
  `noteOriginals`, como na varredura. Até a etapa fria, as linhas que guardam
  um arquivo adiado ficam com o ID de storage anterior, sem entrada no mapa.
  `recordUpload` grava o mapa e aponta essas linhas para o arquivo novo na
  mesma transação.
- **Regra.** A janela é a da varredura, num helper só
  (`coldTier.hotWindowCutoff`): 3 meses no Gratuito e 12 nos demais, contados
  da entrada da nota (`createdAt`), pelo plano em vigor no `begin`, que grava
  o corte no run. A nota passa quando `coldTier.notePlan`, a mesma regra do
  `movePlan` da varredura, a aceita: nenhuma versão em processamento, ao
  menos uma publicada, todo blob verificado e o ano de guarda com lock
  confirmado. As linhas já frias no pacote voltam como estavam, com a mesma
  chave (decisão 6).
- **Admissão.** O executor lê `coldPolicy` (gate, retenção legal, corte e
  `FNFE_COLD_LOCKED_THROUGH`), aplica a mesma regra às linhas do pacote
  (`coldRehydrationPlan`) e conta como quente toda nota que não passaria. O
  `begin` recusa o plano feito com outra regra
  (`ARCHIVE_REHYDRATE_COLD_POLICY`) e confere que os arquivos quentes e os
  adiados somam os do manifesto. A capacidade conta, no banco, todas as
  linhas do pacote (o resíduo de toda nota), mais o que a nota fria ganha
  (320 bytes por arquivo e 64 por nota), com a margem de 10%. Nos arquivos,
  conta os quentes mais o maior lote (`batchBytes`). Se não couber, o `begin`
  recusa antes de gravar.
- **Falha fechada.** A nota que deixa de poder passar depois do `begin`
  (retenção legal nova, ano de lock retirado, gate desligado) tem os arquivos
  devolvidos ao quente. Cada envio dessa etapa confere a capacidade antes da
  URL de upload e, sem espaço, para com `QUOTA_EXCEEDED`. A organização com
  retenção legal ativa no `begin` não tem etapa fria e volta inteira quente
  (pendência 6). Nada é apagado, e nenhuma guarda fica mais curta.
- **Retomada.** O lote em curso fica no run (`rehydration.cold.batch`), com
  a sua reivindicação. Cada passo lê o resultado das notas e do mapa, e
  repetir ou atrasar uma chamada não faz nada duas vezes. A nota que não
  ficou fria (bucket recusou, reivindicação vencida) é reivindicada de novo
  no passo seguinte. O executor desiste depois de três tentativas do mesmo
  lote (`ARCHIVE_REHYDRATE_COLD_STALLED`), e a execução seguinte retoma esse
  lote. O objeto órfão segue a coleta da fase C, e o upload órfão, a da ADR 0009.
- **Passagem do servidor.** Depois dos lotes do executor, o servidor percorre
  todas as notas da organização e move a nota que o plano deixou quente e que
  já pode passar. A etapa só termina com todos os arquivos do pacote enviados
  e nenhuma nota em `moving` (`ARCHIVE_REHYDRATE_COLD_INCOMPLETE` e
  `ARCHIVE_REHYDRATE_COLD_MOVING`).
- **Conferência.** O `check` reconstrói cada linha como o pacote a levava. A
  versão ou o original movido nesta etapa volta a ter o arquivo no lugar do
  objeto, depois de a chave, o SHA-256 e o tamanho do objeto conferirem com a
  intenção do upload, que os guarda junto com o arquivo do import liberado. A
  nota com `coldAt` depois do `begin` volta quente. O arquivo movido é
  conferido pelo hash e pelo tamanho que `recordUpload` comparou com o
  pacote.
- **Isolamento da passagem.** `organizationBlock` só libera a organização em
  `restoring` para a passagem que leva o próprio run, na etapa fria; a
  varredura continua bloqueada. Na reidratação, o arquivo quente sai na hora,
  sem a hora de espera, porque as leituras continuam recusadas até o fim.

O desenho técnico de cada fase é decidido na PR da própria fase e revisado
com o código, sem nova decisão do dono, salvo se tocar um invariante ou uma
pendência. Isso inclui o formato e o nome do blob e do objeto no R2, a
compressão, a intenção de upload e o hash, o gzip determinístico, a coleta
de órfãos, o gatilho e o job da passagem, a identidade age e a rotação de
destinatários e as credenciais do R2.

## Pendências do dono

Decididas pelo dono em 30/10/2026 ([#642](https://github.com/freecorps/freecorpsNFE-arquivo/issues/642#issuecomment-6527244446)):

- **1. Versão de resumo depois do XML completo:** compactada, nunca descartada.
- **2. Alcance da camada quente:** no banco ficam só metadados e um cartão
  pequeno, para listagem e deduplicação; o conteúdo da versão, a evidência fiscal e os itens vão para um
  blob gzip por versão.
- **10. Em qual cota os blobs contam:** na de arquivos, pelo tamanho
  comprimido; o backfill nunca é recusado por cota.
- **11. NFS-e nas camadas:** NF-e e NFS-e são compactadas juntas na fase B,
  com a NFS-e medida sinteticamente; a camada fria da NFS-e espera a fase C.

Decididas pelo dono em 02/11/2026
([#689](https://github.com/freecorps/freecorpsNFE-arquivo/issues/689)):

- **3. Data da idade quente para fria:** a primeira entrada na plataforma
  (`fiscalDocuments.createdAt`), e não a emissão. Uma nota antiga recém-importada
  fica quente pela janela inteira.
- **5. Nota fria na listagem:** aparece na listagem padrão do console e da
  REST, sem filtro. O resíduo quente mantém a listagem como está.
- **6. Retenção legal durante a passagem:** uma retenção legal ativa impede a
  passagem, como diz o arquivo econômico. As notas ficam quentes até a
  liberação.
- **7. Depois de cinco anos, numa organização ativa:** a nota continua fria. O
  expurgo segue só a RETENTION, sem fluxo novo.
- **8. Mudança de plano e organização sem plano:** vale o plano em vigor na
  varredura, 3 meses no Gratuito e 12 em qualquer outro, inclusive
  personalizado e sem plano. No downgrade, o que passou de 3 meses vai ao
  frio; no upgrade, a nota fria não volta.

As demais não estão decididas.

- **4. Tamanho do Gratuito:** o resíduo por nota fria é estimado em 4 a 7 KB,
  a medir na fase B. No horizonte da D01, cerca de 72 meses, 100 notas por
  mês dão 7.200 notas. Com 4 KB, o resíduo soma cerca de 27,5 MiB; mais as
  300 quentes (37 a 48 KB), cerca de 38 a 41 MiB. Com 7 KB, o resíduo soma
  cerca de 48 MiB; mais as quentes, cerca de 59 a 62 MiB. Em todos os casos
  passa dos 32 MiB.
- **9. Aporte de custódia** (R$ 60, R$ 108 e R$ 280) e a fórmula do pacote
  frio.

## Alternativas recusadas pelo dono

- Backup uma vez por dia.
- Converter as cotas dos planos pagos para notas.
- Limitar a guarda a um mês; o dono considerou e escolheu as camadas
  ([#642](https://github.com/freecorps/freecorpsNFE-arquivo/issues/642)).
