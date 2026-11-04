# Armazenamento das evidências

Esta política define onde cada evidência nova fica guardada, por quanto tempo
e como se confere. Ela complementa as regras de registro do
[índice de evidências](EVIDENCE.md) e não muda nenhum recibo existente. Desde
03/11/2026 o repositório é desenvolvido em público (decisão 6 da
[matriz](ACCEPTANCE.md)): todo recibo versionado é público, e o que não pode
ser segue a [evidência restrita](#evidência-restrita).

## Inventário de 20/10/2026

O inventário, a linha de base e os testes que conferem os recibos são do
repositório anterior, hoje `freecorps/freecorpsNFE-arquivo`, onde os recibos
ficaram (decisão 6 da [matriz](ACCEPTANCE.md)); a cópia pública não traz
nenhum deles.

Medido sobre `d2c29bd` com `git ls-tree -l` (tamanho dos blobs, sem blocos
do sistema de arquivos) e `git cat-file --batch-check` sobre os objetos
alcançáveis da `main`.

| Classe                               | Arquivos |        MiB | Uso                                                               |
| ------------------------------------ | -------: | ---------: | ----------------------------------------------------------------- |
| Capturas de tela (`.png`)            |      645 |      99,99 | Revisão visual; 76 MiB em `console-*` e `issuance-console`        |
| Dados brutos (`.jsonl`)              |       20 |      21,57 | Carga hospedada; lidos pelo teste do resumo da rodada, no arquivo |
| Recibos e resumos (`.json`)          |      594 |       8,06 | Resultado verificável; inclui os recibos de gate do publicador    |
| Vídeos (`.webm`, `.mp4`)             |        8 |       7,77 | Jornadas de #71, #72, #81 e console                               |
| Texto, tabelas e roteiros de captura |      218 |       1,12 | README, `.txt`, `.tsv`, `.mjs`                                    |
| **Total em `docs/v1.0/evidence`**    | **1485** | **138,51** | De 154,13 MiB do checkout inteiro                                 |

Três medidas diferentes respondem a perguntas diferentes:

- **Checkout.** As evidências são 90% dos bytes do checkout. Só sair da
  árvore reduz esse número, e não reduz o histórico.
- **Histórico.** A `main` alcança 1.913 blobs de evidência, 163,02 MiB brutos
  e 118,13 MiB comprimidos no pack, de 127,85 MiB de todos os blobs. Esses
  bytes ficam em todo clone completo enquanto o histórico não for reescrito.
  Duplicatas idênticas somam cerca de 0,91 MiB; o peso vem do volume.
- **Retenção.** O Git guarda para sempre o que entrou. Artefatos do GitHub
  Actions expiram em 14 ou 30 dias (`retention-days` dos workflows) e por
  isso nunca são a única prova.

Os 29 arquivos acima de 512 KiB (36,98 MiB) e os 14 diretórios com mais de
2 MiB de mídia (81,07 MiB) estão em
`storage-baseline.json`, no arquivo: cada arquivo com seu
SHA-256 e cada diretório com o total de mídia em bytes.

## Classes e destino

| Classe             | Exemplos                                                                                                                                        | Destino                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recibo exigido     | Gates de `deploy/platform-release.json` (`84/publico/legacy-reset.json` e outros), arquivos de `tests/coverage-matrix.json`, entradas de testes | Git, sempre. Caminho e bytes estáveis; mudança exige novo recibo e novo hash no consumidor.                                                                                                                  |
| Recibo e resumo    | `README.md`, JSON de resultado, `.txt` de comando, `.tsv`, roteiro `.mjs` da captura, manifesto de hashes                                       | Git. Precisa conter a conclusão: o que foi observado, onde e com qual conteúdo.                                                                                                                              |
| Dado bruto         | `.jsonl` de carga, saídas longas de ferramentas                                                                                                 | Git até o orçamento, se um teste ou a conclusão dependem dele; acima, resumo no Git e original na custódia.                                                                                                  |
| Mídia ilustrativa  | Capturas antes/depois, vídeo de jornada                                                                                                         | Git até o orçamento, com uma seleção; o conjunto completo vai ao PR ou artefato de revisão, com manifesto.                                                                                                   |
| Evidência restrita | Dados privados, IDs de ambiente privado, material que não pode ser público                                                                      | Nunca no Git, nem cifrada. Cifrada para os custodiantes, só na custódia, fora o recibo dos workflows de operação, com a conclusão e os hashes no recibo público ([evidência restrita](#evidência-restrita)). |

A conclusão de uma prova visual fica no texto, não na imagem: axe,
`horizontalOverflow`, contraste e rotas conferidas vão no JSON ou no README.
Uma captura mostra o resultado ao revisor; ela não é a única prova.

## Orçamento no Git

Para evidências novas, a partir desta política:

- Nenhum arquivo acima de **512 KiB**.
- No máximo **2 MiB de mídia** (`.png`, `.jpg`, `.gif`, `.webp`, `.webm`,
  `.mp4`, `.mov`) por diretório.
- PNG otimizado sem perda (por exemplo, `oxipng -o 4 --strip safe`) antes do
  commit. Vídeo só quando a sequência não cabe em capturas.

No arquivo, `scripts/evidence-storage.test.ts` recusava arquivos e
diretórios fora do orçamento e conferia que os 29 arquivos inventariados
continuavam com os mesmos bytes. Ele só confere recibos e não veio para a
cópia pública; aqui, o orçamento é conferido na revisão. Os diretórios do
inventário podem manter o tamanho atual, mas não crescer.

Exemplo: uma tela nova em quatro variações (desktop/mobile, claro/escuro)
cabe no orçamento com as capturas "depois" otimizadas. A matriz completa
antes/depois de várias telas, como `console-design-telas-fiscais` (116
capturas, 19,4 MiB), não cabe: versione o README, os JSON de resultado, o
roteiro de captura, duas a quatro capturas representativas e um
`media.sha256` com o hash de todas as capturas; anexe o conjunto completo
ao PR para a revisão.

## Fora do Git

O manifesto `media.sha256` usa o formato de `sha256sum` (hash, dois espaços,
nome do arquivo) e fica no diretório da evidência. Ele permite conferir
qualquer cópia do conjunto completo, mas não promete que essa cópia exista.

Anexos de PR e artefatos de CI servem à revisão e não têm retenção
garantida. Quando a mídia acima do orçamento precisa sobreviver, por ser a
prova de um aceite humano, de produção ou fiscal, ela vai à custódia privada:

- **Proposta:** um bucket R2 privado na conta Cloudflare da Freecorps, com
  bucket lock sem expiração no prefixo das evidências, no mesmo modelo do
  [backup externo](../operacao/backup.md). Ainda não existe; seu provisionamento é uma
  decisão do mantenedor.
- **Registro no Git:** chave do objeto, SHA-256 e tamanho do arquivo enviado
  (um `.tar` do conjunto, por exemplo), `media.sha256` do conteúdo,
  custodiante e procedimento de acesso.
- **Retenção:** no mínimo enquanto existir o recibo no Git que a referencia.
  Exclusão exige decisão registrada do mantenedor.
- **Conferência:** baixar o objeto, comparar o SHA-256 do arquivo e, depois
  de extraído, `sha256sum -c media.sha256`.

Até o bucket existir, mídia acima do orçamento não tem guarda durável. Se uma
prova depender dela, a exceção é decidida pelo mantenedor no PR e entra em
`storage-baseline.json`, visível no diff.

## Evidência restrita

Evidência restrita é o que prova um resultado mas não pode ser público:
recibo de workflow de produção com empresa ou CNPJ, resposta bruta do fisco,
saída de uma leitura de produção, captura de tela com dado de cliente. O
recibo versionado traz a conclusão e só identificadores sanitizados
(contagens, NSU, hashes e sufixos). O original sai cifrado:

1. Cifrar o original com `age`, um `-r` por destinatário de `recipients`
   em [`deploy/offsite-backup.json`](../../deploy/offsite-backup.json).
   Os custodiantes são as pessoas listadas ali.
2. Registrar no recibo público o SHA-256 do original e do arquivo cifrado, o
   tamanho e a chave do objeto na custódia.
3. Guardar o arquivo cifrado somente na custódia de evidências descrita em
   [Fora do Git](#fora-do-git). O Git não recebe nem o arquivo cifrado,
   porque é permanente e público. O artefato de CI não é custódia: ele
   expira, e qualquer pessoa o baixa; a única exceção vem logo abaixo.
4. Para conferir, um custodiante baixa e decifra o arquivo e compara o
   SHA-256 do original com o do recibo.

A exceção é o recibo dos workflows de operação (`capture-*`, `nfse-gate-*`
e `nfse-production-probe`), decidida pelo mantenedor em 03/11/2026. O
`receipt.full.json.age` vai cifrado no artefato do run para o operador ler
no prazo de retenção, de 30 dias, por `scripts/lib/sealed-receipt.mjs`.
O artefato serve à operação e não é custódia: uma prova que dependa desse
recibo leva o arquivo cifrado à custódia.

Até o bucket de evidências existir, a evidência restrita não tem guarda
durável. Se uma prova depender dela, a guarda é decidida pelo mantenedor no
PR.

## Custódia

O autor da entrega gera, sanitiza e versiona os recibos e o manifesto. O
revisor confere que a conclusão está no texto e que o orçamento foi
respeitado. O mantenedor, que assumiu a operação em 06/10/2026, custodia
o repositório e, quando existir, o bucket de evidências; aprova exceções ao
orçamento, envios e exclusões.

## Migração das evidências existentes

Esta política não move, apaga nem reescreve nada. Se o mantenedor decidir
reduzir o checkout depois de provisionar a custódia:

1. Escolher somente mídia ilustrativa do inventário. Os candidatos são os
   diretórios `console-*` e `issuance-console` (cerca de 76 MiB de PNG) e
   `72/journey.webm`. Ficam fora os recibos exigidos, os `.jsonl` de
   `79-80-2026-10-05` (entrada de teste) e todo arquivo citado por
   `tests/coverage-matrix.json` ou `deploy/platform-release.json`.
2. Gerar `media.sha256` a partir dos arquivos versionados, enviar o conjunto
   à custódia e conferir o hash do objeto baixado.
3. No mesmo PR, trocar os links do README pela seleção mantida e pela
   referência de custódia, remover os arquivos da árvore e atualizar
   `storage-baseline.json`.

A remoção da árvore reduz o checkout; o histórico continua com os blobs e
os commits antigos continuam íntegros. O repositório público começa
sem esse histórico, que fica no arquivo privado (decisão 6 da
[matriz](ACCEPTANCE.md)). Enquanto isso, quem precisa de um clone
menor pode usar `git clone --filter=blob:limit=512k` e baixar os blobs sob
demanda.
