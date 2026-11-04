---
name: fiscal-review
description: "Revisar um diff ou plano contra as regras fiscais do freecorpsNFE: valores decimais, chave de acesso, CNPJ e CPF, datas de Brasília, XML original e histórico, eventos, ambientes e gates, emissão NFS-e, captura e guarda. Use quando a mudança toca NF-e, NFS-e, ABRASF, valores ou dados fiscais."
---

# Revisão fiscal

Um erro fiscal aqui não aparece como exceção: aparece como um centavo a mais,
um evento aceito do autor errado, uma nota "autorizada" que o fisco nunca viu
ou um XML original sobrescrito. Esta revisão aplica as regras do projeto a um
diff ou plano. Ela não substitui `code-review`: soma a lente fiscal a ele.

As fontes são o `AGENTS.md`, os contratos em `docs/plataforma/` e as ADRs.
Quando código e documento divergem, o achado é a divergência; não reescreva a
decisão para justificar o código.

## 1. Classifique o diff

Liste os arquivos tocados e marque as áreas:

| Área | Sinais no diff |
| --- | --- |
| Núcleo | `packages/fiscal-core`, valores, identificadores, datas, `format.ts` |
| Importação NF-e | `packages/fiscal-nfe`, `imports*`, `documents*`, schemas, eventos, DANFE |
| Emissão NFS-e | `packages/fiscal-nfse`, `issuance*`, DPS, DANFSe, gate de produção |
| ABRASF | documentos `model: nfse` com `payload.kind: service-invoice` |
| Captura | `capture*`, NSU, `captureFiscalHalts`, liberação por empresa |
| Certificados | cofre, `certificate*`, `withCertificate` |
| Guarda | `retention*`, expurgo, versões, artefatos, auditoria |

Para cada área marcada além do núcleo, leia a seção correspondente de
[regras-por-area.md](regras-por-area.md).

## 2. Aplique as regras de todo diff fiscal

**Valor exato.** Valor fiscal é texto decimal e passa só por
`packages/fiscal-core` (`decimal`, `quantize`, `add`, `multiply`). Procure
`Number(`, `parseFloat`, `toFixed`, `Math.round` e aritmética com `number`
sobre valor fiscal, no backend e no console. Arredondamento tem modo
explícito; o padrão é `reject`. Operação que falta, como subtração ou divisão,
entra em `fiscal-core` com teste, não no lugar que a usa. Ausente é `null`,
nunca `0`, e um total ausente não é derivado de outro campo. Dinheiro no
console passa por `apps/console/src/format.ts`, que só arredonda para exibir.

**Identificadores como texto.** Chave de acesso, CNPJ e CPF ficam texto do
início ao fim e são validados por `validateAccessKey`, `normalizeCnpj` e
`validCpf`. O CNPJ alfanumérico (IN RFB 2.229/2024) é válido em toda parte:
regex, máscara, coluna, filtro e redação de log que aceitam só dígitos são
achado. Separadores saem e letras sobem para maiúsculas antes de validar.

**Data de Brasília.** Data fiscal é data civil de Brasília e não muda com o
fuso do navegador nem do servidor. `dhEmi`, `dCompet` e competência não se
misturam: cada regra diz qual delas usa. Datas do XML são lidas do texto, sem
conversão de fuso. Data inexistente (30/02) é recusada.

**Original e histórico.** XML original, artefatos, versões, tentativas,
eventos e auditorias são acrescentados, nunca sobrescritos nem apagados.
Reprocessar cria versão nova. DPS assinada e snapshot congelado nunca são
reconstruídos. Toda tabela nova tem classe em
`platform/convex/lib/retentionClasses.ts`.

**Retentativa sem efeito duplo.** Deduplicação por organização, empresa e
ambiente; `Idempotency-Key` por projeto e operação; mesma requisição devolve
o resultado anterior, requisição diferente com a mesma chave é conflito.
Timeout de transporte é incerteza: consulte e reconcilie antes de repetir.

**Ambientes separados.** Sandbox, homologação e produção não se cruzam. O
`tpAmb` do XML, do protocolo e dos eventos concorda entre si. Todo gate do
fluxo tocado continua lido do servidor, e uma combinação parcial de variáveis
falha fechada. Teste com transporte simulado prova o comportamento local, não
a autorização do fisco; o diff ou a PR que afirma mais que isso é achado.

**Status honesto.** "Autorizada", "cancelada" ou sucesso só depois da
resposta do fisco persistida. Rejeição, timeout, consulta inconclusiva e
reconciliação se distinguem de sucesso na API, no webhook e no console.

**Dado real e segredo.** Nenhum XML, chave, CNPJ, CPF, valor ou nome real em
código, fixture, teste, log, doc ou comentário: use os sintéticos de
`tests/fixtures/` e os identificadores permitidos em `scripts/public-copy/public-tree.mjs`.
Log e webhook carregam ids, nunca CNPJ, XML ou texto livre. Certificado,
senha, CSC e chave ficam no cofre ou no ambiente.

**Contrato e modelo.** Contrato REST muda pela fonte em `packages/contracts`
e `bun run contracts:generate`. Código de erro público ou valor novo de enum
de webhook exige versão maior. Uma regra de NF-e não vale automaticamente
para NFS-e emitida nem para ABRASF importada: confira cada modelo.

## 3. Relate

Cada achado com `caminho:linha`, a regra violada com a fonte (`AGENTS.md`,
contrato ou ADR com seção), o cenário concreto que produz o erro fiscal e a
correção. Classifique:

- **Bloqueia:** perda de valor exato, histórico apagado ou sobrescrito, efeito
  duplicado, ambiente cruzado, gate contornado, dado real ou segredo exposto,
  status de sucesso sem resposta do fisco.
- **Corrigir:** validação ausente num caminho, divergência de documento,
  teste que não cobre o caso negado ou o outro modelo.
- **Observação:** risco sem cenário concreto ainda.

A revisão termina quando cada regra do passo 2 e de cada área marcada foi
aplicada ao diff, com achado ou "sem achado". Diga também o que o diff exige
de evidência real do fisco que os testes não dão.
