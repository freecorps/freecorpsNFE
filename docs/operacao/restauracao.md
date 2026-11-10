# Restauração operacional

Este roteiro usa exclusivamente massa sintética e dois deployments Convex
locais, com código e schema iguais. Ele não comprova rollback de produção,
compatibilidade de uma migração M6 ou recuperação de efeitos externos.
A exportação do cliente está documentada em [EXPORTS.md](../plataforma/EXPORTS.md).

Para servidor Docker próprio e recuperação de contas junto da jornada pública,
consulte [instalacao-propria.md](instalacao-propria.md). Cada ensaio conserva seu SHA e escopo.
A revalidação de 05/10/2026
repete banco, arquivos e certificados no código integrado e acrescenta
recuperação de sete NFS-e ABRASF, instalação limpa e atualização compatível.

## Pré-condições e custódia

1. Conferir o SHA do código, schema, runner e versões fixadas. Criar a origem
   com `worktree:create --app platform`, conforme [worktrees](../worktrees.md).
2. Confirmar `APP_ENV=development`, `PRODUCT_ENV=sandbox`, `FISCAL_ENV=disabled`,
   `FNFE_CRONS=off`, `WEBHOOK_MODE=disabled`, e-mail local e zero crons registrados.
   Desligar crons não cancela tarefas já agendadas. Usar banco vazio e jamais
   importar produção para este ensaio.
3. Preservar banco, storage e contexto dos envelopes. O snapshot não contém
   variáveis de ambiente. Custodiar `FNFE_PLATFORM_CERT_KEYS`, com todas as
   versões usadas pelos snapshots retidos, em local separado e restrito.
   Segredos de autenticação, webhooks e integrações exigem sua própria
   recuperação; este ensaio não habilita essas integrações.
4. Criar um segundo worktree `--app platform` no mesmo SHA. O destino deve ter
   URL, portas, banco e dependências exclusivos. O runner recusa destino igual
   à origem, com outro SHA ou com registros nas tabelas da aplicação,
   autenticação ou storage. Metadados internos de pools recém-instalados
   não representam dados de negócio e não impedem o ensaio.

## Execução

Com a origem local iniciada por `bun run dev`:

```powershell
bun scripts/backup/prove-restore.mjs prepare
bun run worktree:create test/81-restore --from HEAD --app platform
```

Inicie `bun run dev` no destino, em outro terminal. Na origem:

```powershell
bun scripts/backup/prove-restore.mjs restore C:/caminho/absoluto/do/worktree-destino
```

Use Bun 1.4.0. O runner lê os descritores locais dos worktrees e passa URL e
credencial administrativa diretamente ao CLI, sem shell. Os alvos aparecem
antes de cada comando. O fluxo usa `convex export --include-file-storage` e
`convex import --replace --yes` somente no destino descartável conferido.
Nenhum comando usa os seletores de produção ou validação compartilhada.

`prepare` cadastra uma conta sintética, verifica seu e-mail no coletor local,
importa XML de nota e evento, preserva versões, reprocessa, cria certificados
sintéticos substituído/ativo com duas versões de chave e confere a exportação
privada. Em seguida exporta banco e storage e faz uma escrita controlada após
o snapshot para demonstrar a perda correspondente à janela de recuperação.

`restore` importa o snapshot, compara o hash dos registros e suas relações,
confere cada original por tamanho e hash e tenta abrir os envelopes antes de
repor a chave. A falha é obrigatória. Depois recupera o conjunto de chaves pela
custódia separada, abre ambas as versões e confere fingerprints e bytes. Também
testa versão incorreta, chave incorreta, contexto adulterado e reempacotamento
sob nova mestra. Nenhuma senha ou chave aparece no recibo.

Antes de importar, o runner confere os hashes do snapshot e da cópia de
custódia contra o estado privado de `prepare`. Exige o mesmo SHA do snapshot
e checkouts limpos. Se código ou artefatos mudaram, prepare outra cópia;
não reatribua um recibo antigo ao candidato atual.

## Retenção e encerramentos após o restore

O snapshot não traz as funções agendadas. Antes de liberar o acesso,
reaplique as retenções legais, recupere os prazos de retenção, inclusive a
guarda das organizações já expurgadas, e reaplique os encerramentos
registrados fora do banco, conforme
[Retenção](../plataforma/RETENTION.md#encerramento-implementado-d01).
`scripts/backup/prove-closure-restore.mjs` ensaia esse fluxo em destino vazio, com
`prepare` e `restore <worktree-destino>` como acima. O recibo de 07/10 está
na evidência de D05.

As caixas de privacidade, segurança, suporte e operação ficam no
[Ember Mail](email.md), fora do snapshot do Convex: um restore não as toca nem
precisa reter originais. Um snapshot anterior à troca ainda traz as tabelas
`privacy*`, que o schema atual não tem. Restaure-o com o código da revisão
dele, ou esvazie essas tabelas depois de exportá-las para o registro restrito
([troca](email.md#troca)).

## Arquivo econômico na restauração

Este roteiro restaura o deployment inteiro e não reidrata organizações. A
reidratação de uma organização aberta arquivada, com IDs novos na própria
origem, é um procedimento do
[arquivo econômico](arquivo-economico.md#reidratação-com-ids-novos). O backup
recusa um snapshot com run em `deleting` ou `restoring`, então um snapshot
nunca traz uma reidratação pela metade. Depois de restaurar, um run em
`archived` continua dependendo do pacote e do catálogo no R2, e as intenções
de upload (`coldArchiveUploads`) de reidratações anteriores voltam com o
snapshot; uma coleta de órfãos repetida (`cold-archive.mjs orphans`) não apaga
arquivo que alguma tabela guarda.

O deployment restaurado traz o run, o mapa de IDs (`coldArchiveIdMap`) e a
cerca (`dpsSequences`, `captureStreams`) como estavam no snapshot. O pacote e
o catálogo no R2 não fazem parte do snapshot; o lock os conserva. Conforme o
estado do run no snapshot:

- **`archived`**, de organização encerrada ou aberta: a
  [restauração isolada](arquivo-economico.md#recuperação-isolada-e-exportação-assistida)
  (`cold-archive.mjs restore`) atende a exportação assistida a partir do
  deployment restaurado. Ela só lê origem e R2. Se o deployment restaurado
  passar a ser a origem, a organização aberta é reidratada por ele.
- **`archived`, com reidratação concluída depois do snapshot:** o
  deployment volta com a organização arquivada, sem as linhas reidratadas.
  Uma nova reidratação gera IDs novos, diferentes dos que a integração viu
  depois do snapshot. Os IDs anteriores ao arquivamento continuam resolvendo
  pelo mapa; os da reidratação perdida, não. Registre isso no incidente,
  junto com o resto da perda da janela de recuperação.
- **`sealed` ou `verified`:** os dados ainda estão quentes, e o pacote
  selado está no R2. `archive` refaz a prova e continua.
- **`frozen`:** os dados ainda estão quentes. Se o pacote e o manifesto
  foram publicados no R2 depois do snapshot, `archive` não os sobrescreve. Ele
  só sela com aquele manifesto se o resumo, a contagem e os bytes forem iguais
  aos da varredura gravada no run (`coldArchive:seal`). Se não forem, para, e
  o caso exige revisão administrativa, sem apagar o objeto, que o lock
  protege.

Num deployment restaurado só para ensaio, use apenas `restore`. `archive` e
`compact` gravam no mesmo prefixo `cold/` do R2 que a produção usa, e
`rehydrate` e `orphans` gravam no próprio deployment, o que tira o ensaio do
estado do snapshot.

### Exportação assistida e destino isolado

A [exportação assistida](arquivo-economico.md#exportação-assistida)
(`cold-archive.mjs export`) restaura o pacote no destino isolado, gera ali a
exportação de [EXPORTS.md](../plataforma/EXPORTS.md) e a publica na origem.
O destino guarda então o JSONL do Convex, os originais e as partes geradas
de uma organização real. Depois que o recibo do comando trouxer
`"state": "published"`:

1. Pare o Convex local do destino. Se ele é um worktree, use
   `bun run worktree:cleanup` nele e depois, de outro checkout,
   `bun run worktree:remove <nome-do-worktree-destino>`, como na limpeza
   abaixo e em [worktrees.md](../worktrees.md), sem afetar outros processos.
2. Apague o diretório de dados desse Convex local, que guarda banco e
   storage: `platform/.convex/local/` do checkout destino, ou
   `.convex/local/` num worktree antigo do legado. Um destino descartável não é reaproveitado para outra
   organização sem essa limpeza: o próximo `restore` usa `--replace-all`, mas
   os arquivos antigos podem continuar no storage local.
3. Confirme que não sobrou cópia fora dele: o executor só usa um diretório
   temporário fora do checkout e o remove ao terminar, mesmo com falha.

O comando não apaga o destino sozinho, porque o destino é um processo local
do operador que o executor não controla. Se a publicação falhar, mantenha o
destino até repetir o comando com o mesmo pedido; ele retoma de onde parou.

## Tempos e falhas parciais

O RTO medido começa antes do import e termina após todas as comparações e a
recuperação criptográfica. O recibo registra a idade do snapshot nesse início,
a escrita posterior perdida e sua data. Isso mede esta execução, sem prometer
um RPO/RTO de produção. Definir objetivos com operação antes de contratar
disponibilidade. Para um RPO de 24 horas, por exemplo, a cadência deve ser
menor que 24 horas, incluindo atraso, duração do export e recuperação de
falhas. A cópia hospedada a cada 12 horas, o monitor e o ensaio de perda do
host estão em [Backup externo](backup.md).

Se o import falhar, manter o destino isolado e conferir o erro antes de
retentar. Nunca habilitar transporte com parte das relações recuperadas.
Se faltarem chaves, obter a versão correta na custódia; não substituir por
uma chave aleatória sob o mesmo identificador. Se o conteúdo divergir, preservar
os recibos, descartar o destino pelo ciclo de worktrees e repetir em outro
banco vazio. O runner recusa sobrescrever um destino que já recebeu dados.

O ensaio reproduziu uma referência antiga de `env` no runtime Node aquecido
após trocar as variáveis. O cofre lê agora `process.env` a cada operação por
`currentCertificateKeyring`, preservando os arquivos gerados. O recibo compara
apenas nomes de versões, sem valores secretos. O runner tolera até 30 segundos
de indisponibilidade da chave; erros criptográficos e testes negativos não
recebem essa tolerância.

Rotação do certificado cria nova versão fiscal e preserva a anterior conforme
o contrato da proteção de certificados. Rotação da mestra reempacota a chave de dados sem mudar o
certificado. Manter as mestras antigas enquanto qualquer envelope ou backup
retido depender delas. Aposentar uma chave exige inventariar ambos.

## Evidências e limpeza

Recibos públicos ficam em `.ci-results/81/prepare.json` e `restore.json`.
`.ci-results/81/private.json` contém dados de acesso sintéticos e material
restrito do ensaio; nunca versionar esse arquivo nem copiar a pasta inteira.
Snapshot e custódia temporários ficam em diretórios distintos fora do checkout.
O runner remove essas duas cópias após sucesso. Em falha, mantê-las restritas
até concluir a investigação e remover somente os caminhos criados pelo ensaio.

Arquivar em `docs/v1.0/evidence/81` apenas recibos sanitizados, hashes e provas
de interface. Registrar SHA integrado/publicado separadamente do candidato.
Parar os dois ambientes com `worktree:cleanup`; remover o destino usando
`worktree:remove`, sem afetar outros processos.
