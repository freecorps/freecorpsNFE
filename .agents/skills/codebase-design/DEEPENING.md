# Concentrar comportamento atrás de uma interface

Use o vocabulário de [SKILL.md](SKILL.md). Antes de agrupar módulos, identifique
qual regra hoje exige conhecimento espalhado e quais chamadores se beneficiam.
Código pequeno ou distribuído não é, por si só, um problema.

## Dependências e provas

| Dependência | Estratégia |
| --- | --- |
| Cálculo puro e estado em memória | Testar diretamente as entradas e saídas da interface. |
| Persistência com ambiente local de teste | Usar os helpers e `convex-test` existentes, sem instalar outro banco. |
| Serviço próprio pela rede | Manter o contrato explícito; simular o transporte quando necessário para testar a regra local. |
| Serviço fiscal ou integração externa | Usar o adaptador simulado na prova local e distinguir essa prova de evidência do serviço real. |

Um módulo pode esconder colaboradores menores. A interface pública precisa
expor apenas o que seus consumidores realmente usam; o teste pode precisar
substituir uma dependência interna sem torná-la parte da API do produto.

## Migração

1. Identifique o contrato atual, seus consumidores e os testes que protegem
   estados, erros e regressões relevantes.
2. Defina a interface proposta e a responsabilidade que passa a ficar dentro
   dela. Preserve contratos e estados persistidos ou planeje explicitamente
   sua migração conforme as regras do projeto.
3. Implemente e prove o comportamento pelo caminho apropriado. Quando houver
   várias entradas para a regra, verifique as aplicáveis.
4. Substitua testes acoplados a detalhes removidos somente depois de conferir
   que cada comportamento protegido continua coberto. Mantenha provas
   especializadas que o teste de integração não consegue observar.

Testes devem sobreviver à troca de organização interna quando o comportamento
permanece igual. Uma falha após refatorar também pode revelar regressão real;
investigue antes de atribuí-la ao desenho do teste.
