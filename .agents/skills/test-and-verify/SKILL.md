---
name: test-and-verify
description: "Testar e registrar a evidência de uma mudança num bloco de verificação padronizado, antes de declará-la pronta ou de descrevê-la numa PR, recibo ou relatório."
---

# Testar e verificar

Toda mudança termina com um **bloco de verificação**: cada afirmação sobre o
comportamento ao lado do comando ou artefato que a prova e de um veredito. O
revisor confere o bloco sem refazer o trabalho nem ler a transcrição. O
método de provar uma afirmação está em
[principle-prove-it-works](../principle-prove-it-works/SKILL.md); esta skill
fixa o que rodar e como registrar.

## 1. Liste as afirmações

Escreva o que a mudança diz fazer, uma afirmação por linha, no nível que o
usuário ou o consumidor observa: "importar o mesmo XML duas vezes devolve o
documento existente", não "ajustei o índice". Para correção de defeito, a
primeira afirmação é o defeito reproduzido.

## 2. Escolha os checks pela camada tocada

| Camada tocada | Checks mínimos |
| --- | --- |
| Qualquer mudança | `vp check` e `bun run test:changed` |
| `packages/fiscal-*`, `packages/contracts`, `packages/sdk` | `vp run test:packages`; `bun run xml:prove` para NF-e, `bun run nfse:test` para NFS-e; `bun run sdk:prove` para o SDK |
| `platform/convex/` | `bun run platform:check` e `vp run test:platform` |
| Contrato REST | `bun run contracts:check` |
| `apps/console/` | `vp run test:console`, `bun run build` e a jornada de `apps/console/e2e/` da área |
| Scripts, CI, skills | `vp run test:tooling` |
| Antes de pedir merge | `bun run ci:local` ou a suíte inteira sem cache (`vp test run`) |

Confira os nomes em `package.json` e `vite.config.ts` quando a tabela e o
ambiente divergirem; o ambiente vence. Mudança visível também passa por
[ui-review](../ui-review/SKILL.md); mudança fiscal, por
[fiscal-review](../fiscal-review/SKILL.md).

## 3. Rode e guarde a saída

- Rode na revisão que vai para a PR. Anote o SHA e se a árvore estava limpa.
- Correção de defeito: o teste novo fica **vermelho** sem a correção e verde
  com ela. Mostre as duas execuções; um teste que nunca falhou não prova a
  correção.
- Teste instável: diga quantas vezes rodou e quantas passou. Não repita até
  passar em silêncio.
- Saída bruta e capturas transitórias vão para `.ci-results/<assunto>/`
  ([EXTERNAS.md](../EXTERNAS.md#fluxo-das-skills-de-engenharia)). Evidência
  versionada segue [EVIDENCE-STORAGE.md](../../../docs/v1.0/EVIDENCE-STORAGE.md):
  orçamento por arquivo e por diretório, `media.sha256` e evidência restrita
  fora do Git.
- Só dados sintéticos de `tests/fixtures/`. Nenhum XML, CNPJ, chave de acesso,
  valor ou credencial real em saída, captura ou recibo.

## 4. Dê o veredito no escopo exercitado

Cada afirmação recebe **Comprovado**, **Não comprovado** ou **Inconclusivo**,
com os critérios de `principle-prove-it-works`. O veredito vale para o
ambiente em que rodou:

- teste com transporte simulado prova o comportamento local, não a
  autorização do fisco;
- Convex local anônimo prova a função, não o deployment hospedado;
- `vp check` e o build provam tipos e compilação, não uma jornada.

Check que não rodou aparece com o motivo. Omitir um check é afirmar que ele
passou.

## 5. Escreva o bloco

Em pt-BR, no corpo da PR, no relatório final ou no `README.md` do recibo:

```md
## Verificação

Revisão: `<sha>` (árvore limpa | alterações locais: <quais>)
Ambiente: <local | Convex local anônimo | sandbox hospedado | homologação de <fisco>>

| Afirmação | Prova | Resultado | Veredito |
| --- | --- | --- | --- |
| <comportamento observável> | `<comando>` ou `<caminho do artefato>` | <contagem, código, valor observado> | Comprovado |

Não executado: <check> — <motivo>.
Não comprovado neste ambiente: <o que exige outro ambiente ou evidência do fisco>.
Artefatos: `.ci-results/<assunto>/...`
```

"Resultado" traz o observado: `214 testes, 0 falhas`, `HTTP 409
IDEMPOTENCY_CONFLICT`, `axe: 0 violações em 6 telas`. "Passou" sozinho não é
resultado.

A skill termina quando toda afirmação do passo 1 tem linha no bloco e todo
check do passo 2 tem resultado ou motivo de não execução. Se a mudança altera
a cobertura aceita de uma capacidade, atualize também
[ACCEPTANCE.md](../../../docs/v1.0/ACCEPTANCE.md) e
`tests/coverage-matrix.json` na mesma PR.
