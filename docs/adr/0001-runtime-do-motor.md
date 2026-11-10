# ADR 0001 — Runtime do motor de emissão: Convex `"use node"` (Plano A)

Data: 29/08/2026 · Status: **Aceita** (decidida no gate da Fase 2 do plano)

## Situação em 21/10/2026

> O motor legado de `convex/engine/` e os `convex/spike*.ts` citados aqui foram
> removidos pela PR [#373](https://github.com/freecorps/freecorpsNFE-arquivo/pull/373), no commit [`e1156c5`](https://github.com/freecorps/freecorpsNFE-arquivo/commit/e1156c58a126bcc664403163e63bd69c17e3b611). A decisão de rodar o
> motor em actions Convex `"use node"` continua valendo para a plataforma, que
> hoje usa o núcleo de `packages/fiscal-nfse` (ver
> [ADR 0004](0004-motor-de-emissao-nfse.md)).
> O código histórico continua no Git: `git show e1156c5^:<caminho>` mostra
> cada arquivo como era antes da remoção. O texto abaixo registra a decisão
> como foi tomada e não foi reescrito.

## Decisão

O motor criptográfico (parse do A1, assinatura XMLDSig, transporte mTLS) roda em
**actions Convex `"use node"`**. O Plano B (container Node separado) fica arquivado e
só volta se um limite operacional do runtime aparecer (tamanho de bundle, tempo de
execução, socket).

## Evidência (spike executado em 29/08/2026, produção restrita)

A action `spike:run` (`convex/spike.ts`), rodando num deployment dev:

1. **A1 carregado do env** (PFX AES em 2 chunks base64 + senha) e parseado com
   `node-forge` — CN `FREECORPS TECNOLOGIA DA INFORMACAO LTDA:63113119000190`.
2. **DPS 1.01 montada** (`xmlbuilder2`, ordem de elementos normativa) e **assinada
   XMLDSig enveloped RSA-SHA256/C14N** (`xml-crypto`); assinatura **verificada
   localmente** com sucesso.
3. **Transmitida com mTLS** (`node:https` com `pfx`/`passphrase`) à
   `sefin.producaorestrita.nfse.gov.br` — handshake aceito e **cadeia de respostas de
   negócio** obtida, cada uma provando uma camada mais funda do pipeline:
   - `E1235` (schema: `verAplic` longo demais) → schema chegou ao validador;
   - `E0015` (dCompet > dhEmi) → schema OK, regras de negócio ativas;
   - `E0039` (Campinas não parametrizada p/ emissor nacional na prod. restrita);
   - `E0312`/`E0084` (código de serviço × município; domicílio do CNPJ) com
     `cLocEmi` de teste (Maringá).

O `201` pleno não é alcançável no sandbox hoje por **motivo externo ao código**:
o CNPJ é domiciliado em Campinas e Campinas não tem `aderenteEmissorNacional` em
nenhum ambiente (consulta oficial `GET adn.nfse.gov.br/parametrizacao/3509502/convenio`
→ `{ aderenteAmbienteNacional: 1, aderenteEmissorNacional: 0 }`; Maringá, para
comparação, retorna `1/1`). Ver consequências no PLANO (Fase 0) e PESQUISA-FISCAL.

## Consequências

- Nenhum container/host extra: fila, estado, storage e motor vivem no Convex.
- O cofre de certificados (Fase 1) substitui os env vars `FNFE_CERT_PFX_BASE64_1/2`
  (limite de 8 KiB por env var do Convex foi o motivo do chunking).
- `convex/engine/*` são módulos `"use node"` puros (testáveis offline com certificado
  self-signed); `convex/spike*.ts` são descartáveis ao fim da Fase 3.
- A adesão de Campinas ao Emissor Nacional é **monitorável por API** — um cron passará
  a vigiar o flag e alertar quando virar `1`.
