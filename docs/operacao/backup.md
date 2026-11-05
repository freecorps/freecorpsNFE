# Backup externo, D04

Este roteiro aplica a decisão D04 da [retenção](../plataforma/RETENTION.md#proposta-operacional-de-06102026).
A cada 12 horas, uma cópia cifrada do banco e do storage de `elated-possum-295`
vai para um bucket R2, fora do Convex, onde fica retida por 14 dias. As metas
internas são RPO de 24 horas e RTO de 24 horas. Não são SLA contratado.

**Situação em 30/10/2026.** O dono do projeto decidiu manter a cadência de
12 horas e as metas de 24 horas, sem passar a uma execução por dia, e reduzir
o custo com um banco quente menor
([ADR 0010](../adr/0010-guarda-em-camadas-e-custo-dos-planos.md)). Essa
economia depende do formato 2 ligado: o formato 1 exporta com
`--include-file-storage`, e nele mover bytes do banco para arquivos não reduz
o snapshot. A correção local da #688 substitui o teto de 64 MiB por tabela por
leitura em fluxo e ordenação em disco, mantendo os digests anteriores. O código
do formato 2 admite orçamento explícito de até 8 GiB; o plano ativo usa o
formato 2 com 4 GiB, conforme o
[gate de ativação](#gate-de-ativação-e-retenção-de-objetos). A B4 da ADR 0010 já escreve o blob compactado junto com o
conteúdo em linha, sem reduzir o banco. Leitores e migração ainda faltam.

Bucket, environment, secrets e cofre foram configurados em 08/10/2026. Desde
19/10/2026, o plano cifra para o substituto e o mantenedor, duas pessoas
distintas, como a D04 pede. A identidade provisória do substituto saiu do
plano; as cópias cifradas para ela expiram em até 14 dias, e ela é destruída
depois disso ([troca de custodiante](#troca-de-custodiante)).
Em 21/10/2026, a recuperação com a custódia do mantenedor passou em um
ensaio de perda do host simulada,
com origem bloqueada por rede, RPO de 4 h 21 min e restauração automática em
18,654 s. O mantenedor confirmou login, documentos, download e certificado;
o destino e as exportações temporárias do cofre foram removidos. A execução
independente pelo substituto foi adiada pelo mantenedor em 28/10/2026. Desde
31/10, seu aceite segue na #178, sem marco global, conforme a
[ADR 0011](../adr/0011-entregas-graduais.md); a capacidade do backup segue na #688. A identidade
provisória deve ser destruída a partir de 02/11/2026, após confirmar a
expiração das últimas cópias cifradas para ela.

De 09/10 a 18/10/2026 todas as execuções agendadas falharam ao localizar os
arquivos de storage, e o último backup íntegro chegou a 238 horas, acima do
RPO de 24 horas. A #244 corrigiu a busca pelo id; as execuções manuais de
`snapshot` e `check` de 18/10 passaram e o alerta #218 foi encerrado. Em
19/10 as execuções agendadas de [08:19](https://github.com/freecorps/freecorpsNFE-arquivo/actions/runs/39221926587) e
[10:06 UTC](https://github.com/freecorps/freecorpsNFE-arquivo/actions/runs/39235052818) passaram, assim como o [`snapshot`](https://github.com/freecorps/freecorpsNFE-arquivo/actions/runs/39258590020)
e o [`check`](https://github.com/freecorps/freecorpsNFE-arquivo/actions/runs/39258800492) manuais com os novos custodiantes. A violação foi registrada na
[#51](https://github.com/freecorps/freecorpsNFE-arquivo/issues/51#issuecomment-6256889730).

## Como funciona

O plano versionado usa o formato 2 incremental, descrito em
[Backup incremental](#backup-incremental-formato-2). O formato 1, descrito
abaixo, continua sendo lido por `fetch`, `check` e `rehearse` para os
snapshots anteriores à ativação, até expirarem. A ativação seguiu o
[gate](#gate-de-ativação-e-retenção-de-objetos); o primeiro snapshot no
formato 2 em produção é conferido na #688.

O workflow `Offsite backup` (`.github/workflows/offsite-backup.yml`) tem dois
jobs. Os dois executam `scripts/backup/backup-offsite.mjs` com o plano
`deploy/offsite-backup.json` e o alvo de `deploy/platform-release.json`.

O job `snapshot` roda às 00:00 e às 12:00 de Brasília (03:00/15:00 UTC), no
runner `blacksmith-2vcpu-ubuntu-2404`, em VM efêmera:

1. Lê o SHA publicado em `/health` e as variáveis do deployment. Das chaves de
   custódia, guarda só fingerprints SHA-256 com prefixo de domínio, nunca o valor.
2. Executa `convex export --include-file-storage` e confere o SHA de novo.
   Se houve publicação no meio, falha, e o próximo ciclo repete.
3. Confere o CRC de cada entrada do zip e o sha256 de cada arquivo de storage
   contra os metadados do Convex. O export nomeia cada arquivo com uma
   extensão derivada do `contentType`, como `_storage/<id>.xml`; a conferência
   localiza o arquivo pelo id. Exige que toda versão de chave usada por
   certificados exista no ambiente.
4. Cifra com `age` para os destinatários do plano e para uma identidade
   efêmera. Decifra com a efêmera para provar a cifra e a descarta.
5. Envia `snapshot.zip.age` ao R2, confere o tamanho e só então envia o
   `manifest.json`. Um manifesto presente marca uma cópia completa.

O plaintext existe só no diretório temporário do runner, removido ao final.
O runner não consegue decifrar cópias antigas: só os custodiantes têm as
identidades.

Os objetos ficam em `elated-possum-295/snapshots/<início UTC>/`. O manifesto
registra SHA do código, início do export, hashes e tamanhos do plaintext e da
cifra, contagem e digest por tabela, storage, versões de chave exigidas e
fingerprints da custódia. Ele não contém dados de documentos.

O snapshot não contém código, variáveis de ambiente nem funções agendadas.
O código vem do `codeSha` do manifesto; as variáveis, da custódia separada.
As funções agendadas seguem o [roteiro de D05](../plataforma/RETENTION.md#prova-de-d05).

O job `check` roda 90 minutos depois de cada snapshot, em outra VM Blacksmith,
sem depender da execução do snapshot. A perda de uma VM não impede o monitor;
uma indisponibilidade da Blacksmith pode impedir os dois jobs de iniciar.
Com um token R2 somente leitura, ele:

- procura o manifesto mais recente e baixa a cifra para conferir tamanho e hash;
- alerta se o último backup íntegro tem mais de 13 horas, isto é, se um ciclo
  falhou, o que deixa 11 horas até violar o RPO;
- alerta se o snapshot mais novo não tem manifesto;
- alerta se existe cópia com mais de 15 dias, o que indica falha no lifecycle.

## Alerta

Uma falha do `check` abre a issue `Alerta: backup externo D04`, com o rótulo
`offsite-backup-alert` atribuído ao mantenedor, ou comenta na issue que já
estiver aberta. O próximo `check` bem-sucedido fecha a issue. O GitHub também
avisa por e-mail quem editou o workflow por último quando um run agendado falha.

Ao receber o alerta:

1. Abra o run indicado e o recibo `offsite-backup-check-*`.
2. Confira o último run do `snapshot`. Falha de credencial, de export ou de
   publicação concorrente se resolve executando de novo:
   `gh workflow run offsite-backup.yml -f job=snapshot` e, depois,
   `-f job=check`.
3. Hash divergente ou snapshot sem manifesto: não apague nada. Preserve o
   objeto para investigação e gere outro snapshot.
4. Cópia acima de 15 dias: confira a regra de lifecycle do bucket.

Se o alerta não se resolver antes de 24 horas desde o último backup íntegro,
registre a violação do RPO na issue da entrega operacional afetada.

## Configuração única

Feita uma vez pelo mantenedor, com a participação do substituto nos itens
de custódia. Nenhum valor secreto entra no repositório, em issues ou em logs.

1. **Bucket.** Na conta `ceccd1846b474bb179054a3c2c4a6185`:

   ```sh
   wrangler r2 bucket create freecorpsnfe-offsite-backups
   wrangler r2 bucket lifecycle add freecorpsnfe-offsite-backups expire-14d elated-possum-295/snapshots/ --expire-days 14
   wrangler r2 bucket lock add freecorpsnfe-offsite-backups lock-14d elated-possum-295/snapshots/ --retention-days 14
   ```

   O lock impede que um token de escrita vazado apague as cópias retidas.

2. **Tokens R2 (API S3), escopo restrito ao bucket.** Crie um token
   `Object Read & Write` para o job `snapshot`, um `Object Read` para o
   `check` e um `Object Read` para cada custodiante, guardado fora do GitHub.
3. **Chave de deploy.** No painel do Convex, crie uma chave de produção
   exclusiva, chamada `offsite-backup`, que pode ser revogada sem afetar o deploy.
4. **Environment `offsite-backup`** no GitHub, restrito à `main`, com os
   secrets `CONVEX_DEPLOY_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_READ_ACCESS_KEY_ID` e `R2_READ_SECRET_ACCESS_KEY`.
5. **Identidades age.** Cada custodiante instala o age v1.3.2 e gera a
   própria identidade no seu dispositivo:

   ```sh
   age-keygen -o freecorpsnfe-d04.key
   ```

   A identidade fica no cofre pessoal do custodiante, fora do GitHub, do R2 e
   do Convex. Cada um acrescenta a própria chave pública (`age1…`) em
   `recipients` de `deploy/offsite-backup.json`, por PR. O plano exige ao menos
   dois custodiantes distintos. A PR do substituto com a própria chave e o
   registro dele na issue da entrega registram o aceite da custódia.

6. **Custódia das chaves.** Guarde `BETTER_AUTH_SECRET`,
   `FNFE_WEBHOOK_MASTER_KEY` e `FNFE_PLATFORM_CERT_KEYS`, com todas as versões,
   em um cofre compartilhado só pelos dois custodiantes, separado do R2
   e do GitHub. Use o formato `.env`, que o `fetch` lê. Antes de rotacionar uma
   chave no Convex, atualize o cofre. Mantenha as versões antigas enquanto
   alguma cópia retida ou algum envelope depender delas, ou seja, por pelo
   menos 14 dias depois da última cópia que as usa.
7. **Primeira execução.** `gh workflow run offsite-backup.yml -f job=snapshot`
   e, ao terminar, `-f job=check`. Confira os dois recibos.

### Troca de custodiante

A lista `recipients` só é usada ao cifrar um snapshot novo; `check` e `fetch`
não a comparam com as cópias existentes. Para trocar a identidade provisória pela
chave do mantenedor, uma PR substitui a entrada em
`deploy/offsite-backup.json` e a lista esperada em
`scripts/backup/offsite-backup.test.ts`. Os snapshots seguintes cifram para os novos
destinatários. As cópias anteriores continuam legíveis só pelas identidades
antigas até expirarem, em 14 dias; guarde a identidade substituída até lá e
destrua-a depois.

### Custo

O R2 cobra armazenamento (US$ 0,015/GB-mês, com 10 GB gratuitos) e
operações. Não cobra saída. São 28 cópias retidas. O tamanho real fica no
recibo do `snapshot`, em `ciphertext.bytes`; multiplique por 28 para estimar
o volume. As operações somam poucas centenas por mês. Os jobs `snapshot` e
`check` rodam em Blacksmith de 2 vCPU; medir seus minutos reais, compartilhados
com o restante do CI, em vez de presumir custo fixo por execução.

O custo também inclui a origem: leitura do banco e dos arquivos, geração e
download do ZIP no Convex, cerca de 60 vezes em um mês de 30 dias. A saída
gratuita do R2 não elimina essas cobranças. Confira a
[comparação de custos e hipóteses](../plataforma/PLATFORM-COSTS.md#referência-anterior-export-completo-reproduzível)
antes de definir cotas comerciais. `maxSnapshotBytes` é 1 GiB global. O
preflight agora mede o banco por páginas, soma os arquivos e uma reserva e
recusa a exportação acima desse limite. No formato 1, partes de exports dos
clientes também entram no snapshot.
Confira o tamanho, a duração e a fatura e registre a capacidade aceita na #688.

## Recuperação após perda do host

O custodiante precisa só do token R2 de leitura, da própria identidade age e
do cofre de chaves. Não precisa de acesso ao Convex de origem. Use Bun 1.4.0,
que executa o módulo TypeScript do cofre de certificados, e o age no `PATH`
(ou `AGE_BIN`).

```powershell
$env:R2_ACCESS_KEY_ID = "<token de leitura>"; $env:R2_SECRET_ACCESS_KEY = "<segredo>"
bun scripts/backup/backup-offsite.mjs fetch --out C:/recuperacao/d04 --identity C:/cofre/freecorpsnfe-d04.key --custody C:/cofre/custodia.env
```

O `fetch` escolhe o manifesto mais recente, ou o informado em
`--snapshot <início UTC>`. Ele confere a cifra, decifra, confere o plaintext,
o CRC e o digest de cada tabela e o hash de cada arquivo. Também confere a
custódia contra os fingerprints, abre todos os envelopes de certificado e
todos os segredos de webhook. Se qualquer verificação falhar, apaga o que
decifrou. O diretório precisa estar vazio e fora do checkout.

Para restaurar em um deployment novo:

1. Faça checkout do `codeSha` do recibo e publique o backend nesse SHA.
2. Configure as variáveis conforme [instalacao-propria.md](instalacao-propria.md) e
   [deploy-producao.md](deploy-producao.md), com as chaves do cofre, `FNFE_CRONS=off` e
   `WEBHOOK_MODE=disabled`. Não grave `FNFE_CAPTURE_FISCAL` nem
   `FNFE_CAPTURE_TRANSPORT`, mesmo que a custódia ou o deployment de origem
   as tenham (veja o motivo abaixo).
3. Confira que as duas estão ausentes, com a chave de deploy do deployment
   restaurado só na sessão (Git Bash):

   ```sh
   cd platform
   export CONVEX_DEPLOY_KEY='<deployment restaurado>|…'   # colar, sem gravar em arquivo
   bunx convex env list | grep -E '^FNFE_CAPTURE_(FISCAL|TRANSPORT)='
   ```

   Esperado: nenhuma linha, e o `grep` termina com código 1. Se aparecer
   alguma, remova-a com `bunx convex env remove FNFE_CAPTURE_FISCAL` ou
   `bunx convex env remove FNFE_CAPTURE_TRANSPORT` e repita a conferência.

4. Importe com `convex import --replace <snapshot.zip>`, conferindo o alvo.
5. Antes de abrir o acesso, confira de novo: o `/health` do deployment
   restaurado responde `captureFiscal: "disabled"`. Qualquer outro valor
   (`enabled`, `halted`) quer dizer que uma das variáveis voltou; volte ao
   passo 3.
6. Siga o [roteiro de D05](../plataforma/RETENTION.md#prova-de-d05) antes de liberar o acesso.
7. Apague o diretório de recuperação.

**Por que sem as variáveis da captura.** Desde 22/10/2026 o banco do site
tem captura fiscal real de NF-e ([ADR 0007](../adr/0007-captura-fiscal-no-site.md),
evidência): empresas liberadas,
streams com checkpoint e A1 de clientes no cofre. Com as duas variáveis, o
deployment restaurado consultaria a Receita para os mesmos CNPJs junto com o
site:

- as consultas dos dois somam no mesmo CNPJ e levam a 656, que bloqueia a
  distribuição por uma hora para todos os sistemas da empresa
  ([656](captura-fiscal.md#656-e-esperas));
- cada deployment parte do próprio checkpoint, e o restaurado está atrasado
  em relação ao site. Os NSUs lidos por um não aparecem no outro, e a fila
  da empresa fica dividida entre dois bancos, sem um que tenha tudo.

Sem `FNFE_CAPTURE_FISCAL`, as empresas liberadas valem como desativadas no
restaurado, e o que já foi capturado continua legível e exportável. Sem
`FNFE_CAPTURE_TRANSPORT`, nenhuma consulta sai.

Ligar a captura num deployment restaurado só faz sentido quando ele
substitui o site, e é decisão do mantenedor, depois de
confirmar que o deployment de origem não consulta mais a Receita: fora do
ar, ou com as variáveis removidas lá. Depois, siga
[ligar de novo](captura-fiscal.md#depois-do-corte-por-variável) e confira
cada empresa liberada. Esse caminho não foi ensaiado: o snapshot não traz as
funções agendadas, e ninguém conferiu se as capturas ativas no restaurado
voltam a consultar sozinhas.

Trocar o alvo de produção é uma mudança de `deploy/platform-release.json` e
passa por PR.

## Ensaio de perda do host

Este é o ensaio de recuperação independente da #178. Deve ser executado por um custodiante,
preferencialmente o substituto, em uma máquina sem acesso ao Convex de origem:

1. Crie um destino vazio no SHA do snapshot e suba-o:

   ```powershell
   bun run worktree:create test/d04-ensaio --from <codeSha> --app platform
   cd ../freecorpsNFE-worktrees/test-d04-ensaio; bun run dev
   ```

   O worktree sobe com `APP_ENV=development`, perfil em que a captura do
   site não consulta a Receita. Não grave nele `FNFE_CAPTURE_FISCAL` nem
   `FNFE_CAPTURE_TRANSPORT`.

2. Do checkout principal, com o token R2 de leitura:

   ```powershell
   bun scripts/backup/backup-offsite.mjs rehearse C:/Users/<você>/freecorpsNFE-worktrees/test-d04-ensaio --identity <identidade> --custody <cofre.env>
   ```

   O ensaio faz o `fetch` completo e recusa um destino em outro SHA, com crons,
   fora de `development` ou com dados. Importa o snapshot, aplica as chaves da
   custódia, exporta o destino de novo e compara o digest de cada tabela e de
   cada storage com o manifesto. O recibo `.ci-results/offsite-backup/rehearse.json`
   registra o RPO (idade do snapshot no início) e o RTO (do download até a
   última comparação) contra as metas de 24 horas.

3. Entre no console do destino (`http://localhost:<porta>`) com uma conta real
   e confira documentos, downloads e certificados. O login é manual e fica
   registrado no recibo como pendente até essa conferência.
4. O destino contém dados reais de produção. Remova-o com
   `bun run worktree:remove test/d04-ensaio` assim que terminar.
5. Arquive somente o recibo sanitizado e o resultado do login, em
   `docs/v1.0/evidence/178/` quando for a prova do segundo custodiante (veja o
   roteiro e os modelos) ou em
   `docs/v1.0/evidence/51-offsite/` nos demais ensaios. Registre o aceite do
   mantenedor na #178.

O RTO do ensaio não inclui criar um deployment de nuvem, publicar o código e
apontar os domínios. Registre esses tempos à parte se o ensaio usar um
deployment de nuvem.

## Limites

- O formato 1 ainda lê o export inteiro em memória, mantém o preflight de
  64 MiB por tabela e recusa plano acima de 1 GiB. Na leitura, soma os
  tamanhos declarados antes de descompactar e recusa o ZIP quando a soma
  expandida passa de `maxSnapshotBytes`. Também recusa a entrada que expande
  além do tamanho declarado e nomes que apontam para bytes comprimidos
  sobrepostos. O formato 2 processa ZIP, arquivos, cifra e JSONL em fluxo; ordena
  digests em blocos de 8 MiB e mescla até 16 blocos por vez em disco. Cada
  linha JSONL fica limitada a 16 MiB. O orçamento explícito pode chegar a
  8 GiB; o plano ativo usa 4 GiB. O ensaio local da #688 cobre
  2,25 GiB de arquivos, não prova o teto de 8 GiB nem o runner hospedado.
- O monitor confere a cópia cifrada, não a decifra. Só o ensaio periódico
  comprova que as identidades e o cofre continuam válidos.
- Uma rotação de chave no Convex sem atualizar o cofre não dispara alerta.
  Depois de qualquer rotação, execute `fetch` contra o snapshot seguinte.
- Em 07/10/2026, o código passou em um ensaio local com dados sintéticos do
  prepare de restore, R2 simulado em memória e duas identidades de teste. O
  destino vazio foi restaurado com 129 digests iguais, 4 arquivos e 2 versões
  de chave de certificado. Destino com dados, custódia divergente e identidade
  errada foram recusados. Isso valida o código, não o ensaio operacional da #178.

## Backup incremental, formato 2

O `snapshot` usa formato 2 quando `deploy/offsite-backup.json` contém
`incremental.version: 2`. `fetch`, `check` e `rehearse` reconhecem os dois
formatos. Não se apagam snapshots do formato 1 nem se altera sua retenção ao
migrar. Cadência de 12 horas, janela de 14 dias, alerta de 13 horas e metas
de RPO/RTO de 24 horas permanecem iguais.

No formato 2, cada conteúdo imutável é cifrado com age e enviado uma vez por
SHA-256 e conjunto de destinatários. Uma troca de destinatários cria outro
namespace para não reutilizar uma cifra inacessível ao novo custodiante.
O objeto fica em `<deployment>/objects/<hash-dos-destinatários>/<sha256>.age`,
com uma prova de tamanho, hash da cifra e hash do original no arquivo `.json`
correspondente. Essa prova não contém IDs de clientes nem metadados fiscais.
O executor verifica um roundtrip age com identidade efêmera antes do upload
e lê de volta a cifra antes de gravar a prova. Repetições conferem a cifra
armazenada e reutilizam o objeto; não baixam o original do Convex outra vez.
PUT condicional impede sobrescrita. Objeto sem prova após interrupção exige
reconciliação por custodiante, sem substituir o objeto por tentativa.

A cópia é **um objeto em um bucket R2**. Os dois custodiantes têm meios de
decifrar a mesma cópia; isso não representa duas cópias independentes.

O fluxo é:

1. `readSystemInventory` usa as consultas administrativas paginadas do CLI
   Convex para medir bytes JSON do banco, incluindo Better Auth, rate limiter
   e as filas montadas. Cada página lê até 128 registros e pede limite de
   2 MiB. `backupInventory:page`, uma `internalQuery`, lista metadados e URLs
   de storage. Nada disso é exposto como API pública.
2. Antes de solicitar o export, soma banco, arquivos retidos, reserva de
   10% do banco com mínimo de 1 MiB e overhead de tabelas/arquivos. Recusa
   acima de `maxSnapshotBytes`, 4 GiB no plano ativo. No formato 2,
   o código admite até 8 GiB por configuração explícita. A medição tem custo
   de leitura; não é contagem de documentos tratada como bytes físicos.
   Escritas concorrentes ainda podem aumentar o tamanho depois da medição;
   os limites também são conferidos ao extrair, copiar e reconstruir.
3. Copia os arquivos antes do snapshot para cobrir deleções durante o
   export. ZIPs identificados apenas por `exportParts` ficam de fora;
   referência fiscal compartilhada preserva o arquivo. Blobs sem dono
   identificado são conservados por precaução.
4. Executa `convex export --path ...`, sem `--include-file-storage`.
   Confere o SHA publicado e lê o ZIP em disco, com validação de CRC. As
   referências autoritativas vêm das tabelas do snapshot. Arquivo novo que
   não estava no inventário é resolvido por `backupInventory:resolve` e
   copiado. Se desapareceu e não há cópia comprovada, a execução falha sem
   publicar o manifesto. Um teste exige cobertura de todos os campos
   `v.id("_storage")` e de todos os componentes montados.
5. Preserva todos os IDs, hashes, tamanhos, tipos MIME e `_creationTime` dos
   arquivos em `_storage/documents.jsonl`, dentro do ZIP cifrado do banco.
   Nenhum original fiscal ou lote compartilhado é transformado.
6. No banco destinado ao restore, exportações `running` ou `succeeded`
   viram `expired`, com `BACKUP_REGENERATE_EXPORT`, sem `expireJobId`.
   `exportTickets` fica vazio. Os metadados de `exportParts` permanecem para
   histórico/limpeza, sem downloads disponíveis. Uma nova exportação exige
   novo pedido e autorização. `capacityFiles` é contábil e não promove
   arquivos à guarda; `capacityAccounts` volta para `ready=false`, fase zero
   e cursor nulo. É obrigatório reconciliar o estoque antes de reativá-lo.
7. Cifra o banco, verifica o roundtrip e envia a cifra. Confere novamente
   cada objeto referenciado e publica `manifest.json` por último. O manifesto
   traz os hashes dos objetos necessários, nunca os IDs ou dados fiscais.

O preflight e a resolução de referências não são uma transação com o
snapshot Convex. A garantia é de completude verificada: uma corrida que
impede obter bytes e metadados impede a publicação. O próximo ciclo tenta
de novo. O monitor lê as cifras de banco e objetos e alerta sobre ausência
ou corrupção. A cópia de origem é incremental; essa verificação no R2
continua lendo todos os objetos referenciados.

### Gate de ativação e retenção de objetos

O plano só aceita `incremental` com os três campos abaixo:

```json
{
  "version": 2,
  "blobPrefix": "<deployment>/objects/",
  "retentionConfigured": true
}
```

`retentionConfigured` registra uma configuração operacional conferida, não
a cria. Antes de marcá-lo, o responsável precisa provar:

- O lifecycle de 14 dias alcança apenas `<deployment>/snapshots/`. Nenhuma
  regra de expiração por idade alcança `objects/`; o mesmo original pode
  permanecer referenciado durante anos. Não copie a regra do ZIP para ele.
- Os objetos permanecem protegidos contra sobrescrita e exclusão durante
  **toda** a vida de cada referência retida. Um lock de 14 dias contado da
  criação do objeto é insuficiente para um objeto reutilizado meses depois.
- A coleta por referências está configurada e sob controle do operador.
  Só pode remover um objeto depois de não existir referência no banco vivo,
  em arquivo econômico sob guarda ou em qualquer snapshot ainda retido,
  sem execução de backup concorrente. Snapshot incompleto, inventário
  incompleto ou retenção legal pendente impede coleta. O encerramento de
  organização não autoriza apagar um objeto compartilhado por outra.
- Rotação de custodiantes preserva identidades antigas enquanto objetos ou
  snapshots retidos dependerem delas, ou recifra e prova sua recuperação
  antes de aposentar a chave. O prazo de 14 dias sozinho não vale para
  objetos permanentes.

A coleta manual e o controle de lock são executados por `backup:collect`,
conforme o procedimento abaixo. Guardar objetos indefinidamente sem coleta
também não cumpre a política de retenção.

Em 31/10/2026 foi configurada e relida no bucket ativo a regra
`lock-permanent-objects`, indefinida, para `elated-possum-295/objects/`.
O lifecycle continua expirando somente `snapshots/` em 14 dias. A regra
resolve a proteção contra exclusão por idade do objeto. A coleta foi
implementada na continuação, sem executar exclusões no bucket ativo. A
prova no runner hospedado foi dispensada pelo mantenedor em 01/11/2026, e a
independência exigida é a recuperação pelo segundo custodiante da #178,
executada e aceita em 02/11/2026 antes da ativação
(recibo). O plano ativo usa o formato 2, com
`maxSnapshotBytes` de 4 GiB, decidido pelo mantenedor em 01/11/2026 para
cobrir os 2 GiB de arquivos do plano Grande com folga para o banco. Os
snapshots do formato 1 continuam recuperáveis até expirarem.

### Coleta manual por referências

`bun run backup:collect` simula a seleção. Só imprime contagens e o hash do
plano; não grava recibo local. O comando usa o deployment padrão da
plataforma e o bucket do plano versionado.
Precisa do acesso administrativo Convex e do acesso S3 de leitura/escrita
ao bucket. Mesmo a simulação cria e remove um lease remoto de controle.

O inventário considera todo o storage vivo, de todas as organizações,
todos os snapshots ainda presentes, inclusive formato 1 e snapshots mais
velhos que 14 dias, e os pacotes de arquivo econômico referenciados. A
identidade `--identity <arquivo>` é necessária para decifrar snapshots do
formato 1 e pacotes frios. O executor lê os metadados originais desses
pacotes, mesmo quando o catálogo quente já foi compactado. Temporários
decifrados ficam fora do checkout e são removidos ao terminar.

Um hash referenciado conserva suas cópias em todos os namespaces de
custodiantes. Só vira candidato um par cifra/prova íntegro, sem qualquer
dessas referências e com ambos os objetos há pelo menos 14 dias no R2.
Retenção legal ativa bloqueia toda a coleta, independentemente da
organização. Arquivo em movimentação, paginação incompleta, snapshot sem
manifesto/cifra, backup atrasado ou objeto sem prova também bloqueiam.
`snapshots/`, `cold/` e os arquivos do Convex nunca são apagados pelo coletor.

Antes de aplicar, publique o executor com o lease e espere terminar qualquer
job iniciado por uma versão anterior. Combine uma janela de manutenção,
pause o deployment no painel Convex e mantenha-o pausado até a conclusão.
Não execute importações, alterações de lock/lifecycle ou ferramentas antigas
de backup durante essa janela. A pausa interrompe as funções da aplicação;
por isso a coleta não tem cron nem pausa a produção automaticamente.

```sh
bun run backup:collect --identity <arquivo>
bun run backup:collect --identity <arquivo> --apply <hash-da-simulacao>
```

A aplicação exige ainda `CLOUDFLARE_API_TOKEN` com permissão para editar a
configuração R2 do bucket. Credenciais entram pelo ambiente/cofre, nunca
por argumento ou documentação. A simulação não exige esse token. Uma
mudança de referências, objetos ou snapshots invalida o hash revisado.

Snapshot e coleta usam o mesmo lease condicional por bucket, em
`__fnfe_backup_maintenance__/lease.json`. Ele não expira automaticamente:
um processo lento ou interrompido não pode disputar a coleta com outro
executor. A coleta verifica o estado pausado antes do inventário e antes
de cada exclusão. As consultas administrativas de sistema continuam
disponíveis durante a pausa; o ensaio local confirmou esse comportamento.

O coletor adiciona locks indefinidos para os prefixos dos objetos retidos,
relê a configuração e só então retira temporariamente o lock amplo de
`objects/`. Os prefixos não cobrem nenhum candidato. Outras regras do
bucket são preservadas; se forem necessárias mais de 1.000 regras,
nenhuma exclusão começa. Após excluir os pares e confirmar sua ausência
por HEAD, restaura e relê a configuração original antes de liberar o lease.
As regras seguem a semântica de
[Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/).

**Interrupção exige reconciliação.** Se o processo morrer, ou a restauração
do lock não puder ser confirmada, o lease permanece e bloqueia novos
snapshots/coletas. Confirme que o executor terminou, restaure primeiro o
lock indefinido amplo do prefixo, confira os objetos parcialmente removidos
e só então retire as regras `fnfe-gc-retained-*` e o lease. Não remova o
lease apenas por sua idade. Falha entre exclusão da cifra e da prova deixa
um par incompleto e impede nova coleta até essa reconciliação. Nunca apague
um remanescente sem refazer o inventário e investigar a interrupção.

### Recuperação e prova do formato 2

Os comandos `fetch` e `rehearse` são os mesmos. O `fetch` baixa e decifra o
banco e cada objeto necessário, confere hashes, tamanhos e metadados e monta
um ZIP Convex ZIP64 com os **IDs originais** em `_storage/<id>`. Dois IDs com
os mesmos bytes compartilham um objeto R2, mas voltam como duas entradas do
ZIP. O ZIP é importável pelo procedimento já descrito e não precisa da
origem para ser reconstruído. A custódia de certificados e webhooks continua
sendo conferida. Falha remove os temporários decifrados e o ZIP incompleto.

`scripts/backup/incremental-backup.test.ts` usa dados sintéticos, R2 simulado e uma
identidade age gerada só para o teste. Compara bytes, metadados, IDs e digests
do ZIP reconstruído, testa reutilização por hash, CRC/cifra corrompidos,
referência ausente e publicação do manifesto somente após todas as provas.
Esses testes não importam em um deployment Convex. Separadamente, o
ensaio local real
restaurou e reexportou 165 tabelas e três arquivos com IDs, metadados e bytes
iguais. Validou inventário pendente e export expirado, conservando reservas
numéricas. R2, retenção remota e atendimento do RTO continuam sem prova.

Exports `uniform` distinguem int64 e float64 pela representação numérica.
O preparo preserva os tokens originais, inclusive campos aninhados, e só
reescreve controles em `capacityAccounts` e `documentExports`. O digest
canônico compara tipos e valores sem depender da ordem das chaves. Exclui
apenas `internalId` de `_storage`, localizador transitório acrescentado pelo
export; todos os demais metadados e IDs continuam na comparação.

### Arquivo econômico e catálogo frio

O executor de arquivo econômico está em `scripts/cold-tier/cold-archive.mjs` e seu
procedimento em [arquivo-economico.md](arquivo-economico.md). Ele conserva um
pacote por organização, com os registros fiscais e originais, cifrado com
age. Só autoriza remoção quente após baixar, decifrar, importar em destino
isolado e comparar a reexportação, para organizações encerradas e `purged`
ou abertas elegíveis após aviso. A ADR 0009 já implementa o retorno à origem
sob IDs novos e a restauração isolada para exportação assistida. O ensaio
anterior recuperou 86 registros e três arquivos em destino isolado, mas
falhou ao recriar IDs apagados na origem; ele não prova a reidratação nova.
O gate `FNFE_COLD_ARCHIVE` permanece desligado, e o estoque no hospedado
continua quente. O ensaio da #691 provou
R2 com lock por run, renovação, import isolado e upload reais numa origem
descartável. Faltam duas cópias independentes, a decifração com as
identidades dos custodiantes reais e backup integral do Grande acima de
1 GiB, além de textos jurídicos, margem medida e
fundos reais ([#549](https://github.com/freecorps/freecorpsNFE-arquivo/issues/549#issuecomment-6530738648)).

O formato 2 inclui `coldArchives` no manifesto do backup. Cada referência
leva o manifesto frio imutável e seu SHA-256, conferidos contra o catálogo
do banco. Publicação e recuperação verificam a existência e a integridade
da cifra externa. Referência ausente, manifesto alterado ou movimentação em
`deleting`/`restoring` interrompe a execução. A restauração da plataforma
preserva o estado arquivado; a recuperação da organização encerrada ocorre
somente em destino isolado. O formato 1 recusa dados já arquivados.

Depois de `archived`, o catálogo `coldArchiveEntries` do run sai do banco
para um objeto cifrado com age para os mesmos custodiantes do pacote, em
`<prefixo>cold/<runId>/catalog.jsonl.age`, com manifesto imutável em
`catalog-manifest.json`, ao lado do pacote
([catálogo compactado](arquivo-economico.md#catálogo-compactado)). Desde que o
run grava o hash desse manifesto, a referência em `coldArchives` leva também
`catalogSha256`, e publicação e recuperação conferem o manifesto do catálogo
no R2 por esse hash e percorrem a cifra dele. O objeto do catálogo é
dependência permanente do backup, como o pacote: sem ele, a restauração
isolada de um run compactado recusa, porque o banco não tem mais as entradas.
Rotação de custódia precisa reler ou recifrar também os catálogos, e manter
as identidades antigas enquanto um catálogo cifrado para elas estiver
retido.

O prefixo `cold/` fica fora do lifecycle de snapshots. Nem encerramento,
reativação, nem o horizonte comercial de 72 meses autorizam excluir o
pacote nem o catálogo compactado; os dois seguem o mesmo lock e o mesmo
`retainUntil`. Uma coleta futura precisa considerar catálogo, banco e todos os
backups retidos, além de guarda fiscal e retenções legais. Os dados
comerciais, o controle e, até a compactação, o catálogo continuam quentes e entram no
custo. Não declare economia observada antes do ensaio real e da conclusão
de `archived`.

### Documentos frios da ADR 0010

A camada fria ([camada-fria.md](camada-fria.md)) guarda o conteúdo das notas
antigas num bucket R2 próprio, fora do export, e, pela decisão 8 da ADR
0010, também o XML original delas. A linha de cada versão fria
(`content-<sha>.gz`) e de cada original frio (`documentArtifacts`,
`original-<sha>.gz`), dentro do banco cifrado, tem a chave, o SHA-256 e o
tamanho do objeto. As duas espécies entram na mesma lista. O
manifesto do formato 2 leva `coldDocuments`, com o bucket, a contagem e o
SHA-256 da lista ordenada (`chave sha256 tamanho`, uma por linha). Um backup
sem nota fria não tem o campo.

- **Publicação:** confere por HEAD que cada objeto existe com o tamanho
  registrado. O snapshot falha sem `coldTier.bucket` no plano, com nota fria.
- **Recuperação:** recalcula a lista a partir do banco restaurado, exige a
  mesma contagem e o mesmo digest do manifesto, e relê cada objeto
  conferindo o SHA-256.

Os dois passos leem o bucket frio com o token só de leitura
`R2_COLD_READ_ACCESS_KEY_ID` e `R2_COLD_READ_SECRET_ACCESS_KEY`; sem ele,
usam as credenciais R2 do próprio passo, que então precisam de leitura no
bucket frio. Na recuperação manual, defina as duas variáveis junto com as
credenciais do backup. O backup não copia os objetos frios: eles são
dependência dele, como os pacotes da ADR 0009. Ninguém deve apagar um objeto
frio fora da fila de expurgo da guarda (`coldObjectDeletions`).

## Métricas agregadas do snapshot

A baseline operacional de 31/10/2026
registra medições do formato 1 e a projeção reproduzível da #557.
A investigação da #688 registra as regras
R2 consultadas, o limite corrigido e a restauração integral de 2,25 GiB
sintéticos do R2 em outro Convex local. A coleta tem testes e ensaio de locks
em R2 real. A prova hospedada foi dispensada em 01/11/2026; o formato 2 foi
ligado depois da recuperação independente da #178. Por decisão do mantenedor nesta
entrega, a conciliação financeira detalhada deixou de ser requisito deste
trabalho; os valores não medidos continuam desconhecidos.

O recibo local de `snapshot` acrescenta `metrics.version: 1`, `format: 1|2`
e `complete`, sem alterar o manifesto nem os campos anteriores. O período é
`startedAtMs` até `finishedAt`. `complete: false` conserva as observações até
a falha. Tamanhos ainda não medidos são `null`; fases não iniciadas ficam
ausentes. Contadores zero significam nenhum evento observado naquela fronteira,
não ausência de tráfego ou custo. Falhas conhecidas preservam diagnósticos
definidos pelo programa (argumentos, recuperação, custódia e integridade).
Mensagens externas desconhecidas usam `BACKUP_FAILED`, sem copiar payloads,
diffs de assertions, caminhos ou credenciais. No monitor, `BACKUP_CHECK_FAILED`
remete a `problems`, que conserva os alertas de prazo e os diagnósticos seguros.
O inventário automatizado dos testes extrai as mensagens explícitas do CLI e
dos helpers de backup, incremental, ZIP e diretório de recuperação, além de
`backendRequest`, `releaseTarget`, `worktreePaths` e criptografia de certificados.
Esse inventário tem escopo explícito e não
percorre automaticamente todas as dependências transitivas. Cada
mensagem deve conservar seu diagnóstico mesmo com valores privados em um
diff de assertion. Mensagens com IDs ou caminhos retornam categorias fixas;
status HTTP conservam apenas serviço e código. Falhas de `age`/`age-keygen`,
CLI Convex e chamada ao backend local têm categorias próprias. Erros sem
mensagem definida pelo programa continuam usando o fallback seguro.
Respostas HTTP 401, 403 e 503 da origem e uma rejeição lógica com HTTP 200
também são exercitadas pelo helper real com transporte simulado, sem copiar
o corpo da resposta para o diagnóstico.

Todos os valores de `metrics.observed` são observados, sem projeções:

- `exportZipBytes`: arquivo produzido pelo CLI, com storage no formato 1 e
  somente banco no formato 2. `snapshotZipBytes`: ZIP efetivamente cifrado,
  que no formato 2 já contém as transformações de recuperação.
- `databaseJsonlBytes`: soma das entradas `*/documents.jsonl` desse ZIP,
  incluindo componentes e metadados internos/storage; exclui blobs e demais
  entradas. É JSONL serializado, não tamanho lógico ou físico do banco.
- `snapshotCiphertextBytes`: tamanho local da cifra do ZIP, sem blobs externos.
- `newBlobObjects`: uploads de cifras de blobs aceitos no formato 2, mesmo
  se a prova posterior falhar. `reusedBlobReferences`: chamadas de `copyBlob`
  que reutilizaram uma cifra após verificá-la. Dois IDs com conteúdo igual
  podem contar duas referências; não é estoque de objetos únicos. No formato 1
  ambos ficam zero, pois os arquivos estão dentro do ZIP.
- `r2.completedPutRequests` e `acknowledgedPutBodyBytes`: PUTs aceitos e soma
  dos tamanhos dos corpos enviados, incluindo cifras, provas e manifesto.
  Excluem HTTP 412, respostas de erro e uploads sem confirmação; uma falha
  de transporte pode ter enviado bytes não contabilizados.
- `r2.verificationReadBytes`: bytes consumidos por `verifyFile`, inclusive
  leitura parcial ou corrompida. `verifiedCiphertextBytes` e
  `completedVerifications` contam apenas verificações completas com hash e
  tamanho corretos. Releituras somam novamente. No formato 2 incluem banco,
  blobs reutilizados e dependências frias. No formato 1 ficam zero durante
  o snapshot: ele faz roundtrip local e HEAD remoto, sem GET de verificação.
- `durationsMs`: relógio monotônico em milissegundos. `export` cobre o CLI;
  `initialBlobCopies` cobre as cópias anteriores ao export do formato 2;
  `publication` cobre envio e verificações finais do formato 2; `total`
  inclui preparação e limpeza até finalizar o recibo, sem gravá-lo. Fases
  que falham preservam sua duração. As fases não decompõem todo o total.

Não há medição de GETs de manifestos/provas, cabeçalhos, tráfego de rede total,
I/O faturável Convex, cópias temporárias, estoque retido, custo efetivo ou
minutos faturados do runner. Os modos `check`, `fetch` e `rehearse` ainda não
recebem esse bloco. Reutilizar evita novo upload do blob, mas continua lendo
sua cifra na verificação e novamente na publicação. Estes recibos não
comprovam economia nem capacidade operacional. O recorte de medição da #557
foi concluído com a baseline do formato 1, por dispensa do mantenedor, sem
medir o formato 2.
