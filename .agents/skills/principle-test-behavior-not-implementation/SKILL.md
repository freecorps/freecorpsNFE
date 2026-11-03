---
name: principle-test-behavior-not-implementation
description: "Avaliar e escrever testes que protegem resultados, erros e efeitos observáveis, sem prender a cobertura aos detalhes internos."
---

# Testar comportamento

Um teste faz uma afirmação sobre o que um chamador, usuário ou serviço
consegue observar: resultado, erro, estado persistido, arquivo ou mensagem.
Escolha a interface correspondente ao contrato que precisa proteger.
Origem e adaptações estão em
[EXTERNAS.md](../EXTERNAS.md#importação-do-pstack-em-20102026).

## Avaliar a prova

Considere duas alterações:

1. **Quebrar o comportamento:** retornar um valor errado, omitir um efeito ou
   executá-lo duas vezes. O teste precisa detectar a quebra que promete cobrir.
   Um resultado esperado calculado pelo próprio código testado, ou uma
   asserção apenas sobre a fixture criada pelo teste, pode esconder o defeito.
2. **Mudar a implementação:** reorganizar helpers mantendo o contrato.
   Se o teste falhar, confira se ele depende de uma decisão interna que
   nenhum consumidor observa.

Derive o resultado esperado do requisito e use uma entrada concreta. Uma
asserção sobre a chamada a um helper privado normalmente prende o teste à
implementação; o payload enviado a um serviço externo pode ser o próprio
contrato. Uma invariante entre registros ou uma propriedade dos tipos também
pode ser o comportamento a proteger.

Quando o contrato proíbe um efeito, combine o caso negado com um caso em que
o efeito acontece, para demonstrar que a prova consegue observá-lo. Por
exemplo, uma tentativa sem permissão não deve criar uma operação; a tentativa
autorizada deve criá-la. Na deduplicação, confira a identidade retornada e
o estado persistido após repetir o pedido.

## Aplicar no projeto

Use o setup e os projetos de teste existentes, com imports de `vite-plus/test`.
Monte identidades e escopos reais do domínio nos testes Convex e mantenha
transporte fiscal, webhooks e e-mails simulados.

Preserve as provas especializadas de parsing, assinatura XML, precisão decimal,
isolamento e transições fiscais. Um teste de nível mais alto não demonstra
sozinho que a cobertura dessas regras ficou equivalente. Reescrever ou remover
um teste exige identificar a regressão que ele protegia e como ela continua
coberta; esta skill não pede uma limpeza geral da suíte.

Para uma correção, confirme a falha pelo motivo esperado antes da mudança e o
sucesso depois, quando essa reprodução for viável. Informe o que foi observado
e os limites da prova. O procedimento não exige testes novos para mudanças
reversíveis de baixo impacto sem comportamento a proteger.
