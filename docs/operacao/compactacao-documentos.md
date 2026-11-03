# Compactação dos documentos (ADR 0010, fase B)

Este procedimento migra o conteúdo das versões de documento para o blob
`document-content/1`. Ele roda uma vez em cada deployment, depois da
publicação do código da B7. O desenho está na
[ADR 0010](../adr/0010-guarda-em-camadas-e-custo-dos-planos.md), e as funções
estão em `platform/convex/contentMigration.ts`.

| Etapa      | O que faz                                                                                                 | Apaga dados |
| ---------- | --------------------------------------------------------------------------------------------------------- | ----------- |
| `backfill` | Agenda o escritor da B4 para cada versão publicada sem blob e regrava o cartão de evento anterior à B5.   | Não         |
| `audit`    | Lê cada blob pelo codec, compara seu hash com o do conteúdo em linha e marca `contentVerifiedAt`.         | Não         |
| `cleanup`  | Retira a cópia em linha das versões verificadas (B8). Só começa com a auditoria concluída e sem bloqueio. | Sim         |

## Antes de começar

- O código publicado é o da `main` com a B7. O `Deploy production` é disparado
  pelo dono ([deploy-producao.md](deploy-producao.md)).
- Nenhuma recontagem de `capacity:inventory` está em curso.
- Confira o alvo antes de cada comando: em produção, só com a chave de
  deploy de produção, por `--env-file`, nunca por variável do terminal.

## Executar

Em `platform/`, com `<arquivo>` contendo a linha `CONVEX_DEPLOY_KEY=...` do
alvo, fora de qualquer repositório:

```sh
bunx convex run --env-file <arquivo> contentMigration:start '{"kind":"backfill"}'
bunx convex run --env-file <arquivo> contentMigration:status
```

Cada etapa avança sozinha, uma página por transação, e grava o cursor e as
contagens em `contentMigrations`. Espere `backfill` chegar a `done`, aguarde os
escritores agendados terminarem (alguns segundos por versão) e rode
`audit` da mesma forma. Os escritores que ainda não terminaram aparecem na
auditoria como `inlineOnly`. Se isso acontecer, repita a auditoria com
`{"kind":"audit","restart":true}`.

## Ler o resultado

`status` devolve, por etapa, o estado, as contagens e o erro.

- `backfill`: `scanned`, `scheduled` (versões que receberão blob), `withBlob`,
  `cardRefreshed`, `unpublished` e `corrupt` (referência de blob parcial, que
  o backfill não regrava).
- `audit`: `verified`, `inlineOnly` (sem blob: acima de 8 MiB, itens fora de
  posição ou organização arquivada quando escrita, um estado normal),
  `cleaned`, `unpublished` e os bloqueios `missing`, `corrupt`, `mismatch`,
  `unverified` e `changedDuringAudit` (o blob mudou entre a leitura e o
  registro).

Qualquer bloqueio impede a limpeza (`CONTENT_AUDIT_REQUIRED`). Investigue a
versão antes de seguir: um blob ausente ou diferente se refaz apagando a
referência da versão e rodando o `backfill` de novo, enquanto a cópia em linha
existir.

## Limpeza (B8)

Com a auditoria `done` e sem bloqueios, rode a limpeza:

```sh
bunx convex run --env-file <arquivo> contentMigration:start '{"kind":"cleanup"}'
```

As contagens são `cleared`, `already`, `noBlob` (versão sem blob, que guarda a
cópia em linha), `unverified` (gravada depois da auditoria e não relida;
repita a auditoria) e `cardPending` (cartão de evento anterior à B5; repita o
`backfill`), `corrupt` (referência de blob parcial) e `changed` (a cópia em
linha mudou depois da verificação, como uma evidência tardia; repita a
auditoria). Antes de apagar, a limpeza recodifica a cópia em linha e a compara
com o blob. A limpeza apaga a cópia em linha, e só o blob e o XML original
continuam. Para refazer uma versão sem a cópia, reprocesse o documento a
partir do original.

Depois da B8, uma versão nova perde a cópia em linha assim que o escritor relê
o seu blob, e não precisa desta etapa.

## Falhas e retomada

O escritor de uma versão se reagenda até três vezes depois de uma falha
passageira. Se a auditoria ainda mostrar `inlineOnly` acima do esperado,
repita o `backfill` com `restart: true`: ele só agenda as versões sem blob. A
execução em produção está registrada em
production-migration.md.

Cada `start` sobe a geração da etapa, e um passo agendado antes dele, atrasado
ou repetido, não muda nada. Uma etapa que falha fica `failed`, com o erro, no
cursor em que parou.
`start` com o mesmo `kind` retoma desse cursor. Um passo repetido ou atrasado
não avança nada, porque cada passo confere o cursor antes de gravar. `start`
numa etapa `done` não faz nada, e `restart: true` começa do início.
