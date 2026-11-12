# Recibos das provas operacionais

Algumas garantias da plataforma só valem enquanto uma pessoa repete uma prova:
recuperar o backup com os materiais do outro custodiante, conferir os destinos
de log, receber o teste do alerta da captura. `deploy/receipts.json` diz, para
cada uma, quem é o dono, de quanto em quanto tempo ela se repete, que código a
torna velha e qual foi o último recibo (#127).

`scripts/repo/receipts.test.ts`, no projeto `repository` do Vitest, confere a
tabela em toda PR. Erro de registro reprova. Prazo vencido só avisa: refazer a
prova é trabalho do dono, não da PR.

## A tabela

| Campo            | O que é                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`             | Nome da prova, em minúsculas com hífens. O recibo repete este valor.                                                           |
| `title`          | O que a prova demonstra, numa frase.                                                                                           |
| `issue`          | Onde a prova é discutida e registrada, como `freecorps/freecorpsNFE#126`.                                                      |
| `owner`          | Login do GitHub de quem refaz a prova.                                                                                         |
| `everyDays`      | Validade do recibo em dias, contada de `provedAt`.                                                                             |
| `riskPaths`      | Arquivos ou pastas cuja mudança depois do `codeSha` deixa o recibo velho. Todos precisam existir.                              |
| `applicableWhen` | `always`, ou `issuanceProduction`: só enquanto `deploy/issuance-production.json` nomeia um deployment.                         |
| `last`           | `null` enquanto não há recibo neste repositório; `{ path, sha256 }` para um arquivo; `{ run, provedAt, codeSha }` para um run. |

As entradas de 12/11/2026:

| `id`                       | Dono            | A cada   | Último recibo                                                                                                |
| -------------------------- | --------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `restore-second-custodian` | `hhs0001`       | 180 dias | Nenhum aqui. O ensaio de 02/11/2026 está no repositório arquivado, com commit de fora desta história.        |
| `d03-provider-logs`        | `wolf-stievano` | 180 dias | Nenhum aqui. O inventário de 21/10/2026 está no repositório arquivado; #129 fecha o que falta.               |
| `nfse-producao-restrita`   | `wolf-stievano` | 90 dias  | Não se aplica: `deploy/issuance-production.json` tem `deployment: null`.                                     |
| `capture-alert`            | `wolf-stievano` | 90 dias  | O teste de 09/11/2026 ([recibo](../v1.0/evidence/126/2026-11-09/alert-test.json)), ainda pelo Email Sending. |

O recibo do alerta é anterior à troca para o Ember Mail (#220), por isso o
teste avisa que `platform/convex/lib/accountMail.ts` e
`platform/account-policy.mjs` mudaram desde ele. O `alert_test` de 11/11/2026
(run 42931956665) já saiu pelo Ember Mail com `delivery: "sent"`, mas a
chegada na caixa `nfe-operacao` não foi registrada. Sem ela, não conta como
recibo.

## O que reprova e o que avisa

Reprova:

- entrada com campo desconhecido ou fora do formato, `id` repetido, `riskPath`
  inexistente;
- recibo em arquivo que não existe, ou cujo SHA-256 não é o da tabela;
- recibo em formato desconhecido (abaixo);
- `codeSha` que não é commit deste repositório ou não é ancestral do HEAD.

Avisa, quando a prova se aplica:

- não há recibo (`last: null`);
- passaram mais de `everyDays` dias desde `provedAt`;
- algum arquivo de `riskPaths` mudou entre o `codeSha` e o HEAD.

A data de referência do prazo é a do commit testado, não o relógio da máquina.
Na PR, é o commit de merge que o GitHub cria para o run, e os avisos aparecem
como anotações do job `Validate`. Localmente, rode
`vp test run scripts/repo/receipts.test.ts`; um agente que roda os testes vê
os avisos só com `--silent=false`. Como os outros testes, o resultado
aprovado pode vir do cache do Vite Task, e aí o aviso não se repete.

O teste precisa da história completa do Git: o checkout do CI usa
`fetch-depth: 0`. Num clone raso, todo `codeSha` reprova como desconhecido.

## Registrar um recibo

1. Faça a prova pelo roteiro dela ([backup](backup.md#ensaio-de-perda-do-host),
   [D03](../plataforma/OBSERVABILITY.md#logs-dos-provedores-d03),
   [teste do alerta](captura-fiscal.md#testar-o-e-mail-dos-alertas),
   [emissão NFS-e](emissao-nfse.md)) e anote o commit que estava publicado.
2. Grave o recibo em `docs/v1.0/evidence/<issue>/<AAAA-MM-DD>/`, em JSON:

   ```json
   {
     "version": 1,
     "receipt": "capture-alert",
     "provedAt": "2026-11-09T21:02:54Z",
     "codeSha": "<commit de 40 dígitos que a prova exercitou>",
     "result": "passed",
     "recordedBy": "<login>"
   }
   ```

   `provedAt` é o instante da prova em UTC. O resto do arquivo é a evidência
   da prova, livre. Só dado sanitizado: sem endereço de e-mail, CNPJ, chave de
   acesso, nome de cliente ou segredo (veja `AGENTS.md`, Credenciais e dados
   reais).

3. Formate o arquivo com `vp fmt <arquivo>`, calcule o SHA-256 dos bytes
   gravados (`sha256sum <arquivo>`) e atualize `last` da entrada:
   `{ "path": "<arquivo>", "sha256": "<hash>" }`.
4. Quando o próprio run do GitHub é a evidência, `last` pode ser
   `{ "run": "<URL do run>", "provedAt": "...", "codeSha": "..." }`, sem
   arquivo. O teste confere o commit, não o run: ele roda sem rede.
5. Cite o recibo na issue da entrada e abra a PR. `deploy/` tem dono em
   `.github/CODEOWNERS`.

Uma prova nova entra como outra entrada da tabela, com `last: null` até o
primeiro recibo. Esta tabela não agenda nem abre issue sozinha; se os prazos
passarem sem ninguém ver, o próximo passo, um cron, se discute em issue
própria.
