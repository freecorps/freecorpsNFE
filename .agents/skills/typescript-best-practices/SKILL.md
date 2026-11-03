---
name: typescript-best-practices
description: "Modelar ou revisar tipos TypeScript, validação de entradas, variantes e contratos, preservando as fontes geradas e as regras do domínio."
---

# Tipos TypeScript

Use o tipo mais simples que expresse o contrato e impeça os erros relevantes.
As guidelines Convex indicadas pelo `AGENTS.md` prevalecem quando o código
pertencer ao backend. Origem e adaptações estão em
[EXTERNAS.md](../EXTERNAS.md#importação-do-pstack-em-20102026).

## Modelar estados e identidades

- Use unions discriminadas quando variantes exigirem campos diferentes.
  Aproveite o discriminante existente; não renomeie contratos para adotar
  `kind` nem converta schemas sem necessidade.
- Confira exaustividade ao tratar variantes fechadas, com `never` ou o padrão
  equivalente já usado pelo projeto. A checagem de tipos deve acusar um caso
  novo sem tratamento.
- Preserve `T[]` enquanto ele representar o contrato. Um tipo de lista não
  vazia só ajuda quando essa propriedade é exigida e verificada na criação.
- Reutilize `Id`, `Doc` e os tipos gerados pelo Convex, além dos contratos
  `@freecorps/*`. Marcas adicionais em tipos primitivos só se justificam por
  confusão concreta entre conceitos ainda não protegidos pelos tipos atuais.
- Derive tipos da fonte que os possui, com inferência do schema ou utilitários
  como `Pick`, `Omit`, `Parameters`, `ReturnType` e `Awaited`. Preserve
  contratos públicos próprios quando forem uma fronteira intencional; não
  exponha o schema interno do banco pela API apenas para evitar uma interface.

## Validar sem esconder erros

Dados externos começam como `unknown`. Use os validators e schemas existentes
para estabelecer seu formato, sem instalar outra biblioteca por convenção.
Um type guard precisa verificar todas as propriedades que afirma.

Prefira narrowing por discriminante, `in`, `typeof` ou guard verificado a uma
asserção `as`. Use `satisfies` para conferir compatibilidade de um valor
conhecido em compilação; ele não valida dados em runtime. Asserções inevitáveis
numa integração precisam de uma justificativa verificável e do menor alcance
possível. `any` e `!` não corrigem um contrato desconhecido.

Validar o formato uma vez evita parsing repetido, mas não comprova permissão,
existência atual de registros, concessões, limites ou transições. O servidor
deve conferir essas condições na operação responsável pelo efeito, inclusive
quando seus argumentos já têm tipos internos. Um `Id` é seletor, não prova
de acesso. Reutilize os helpers de autorização de cada domínio.

Mantenha valores fiscais nas representações exatas do projeto: texto decimal
e helpers de `packages/fiscal-core` na plataforma, unidades menores inteiras
nas regras legadas. Uma conversão para `number` não fica segura por receber
um nome ou uma marca de tipo.

## Verificar o contrato

Execute os checks de tipos e testes exigidos para a área alterada. Quando a
mudança envolver inferência, rejeição de entradas ou seleção de overload,
prove o comportamento de um consumidor representativo. Typecheck não substitui
teste de permissão nem de efeitos; use
[testes por comportamento](../principle-test-behavior-not-implementation/SKILL.md).
Mantenha integrações externas simuladas conforme o `AGENTS.md`.
