---
name: technical-writing
description: "Escrever ou revisar documentação técnica para pessoas, distinguindo tutorial, guia de tarefa, referência e explicação, em português do Brasil."
---

# Escrita técnica

Identifique o leitor e o problema que o documento resolve. Use o vocabulário
do projeto e nomes reais de símbolos, arquivos e comandos. Origem e adaptações
estão em [EXTERNAS.md](../EXTERNAS.md#importação-do-pstack-em-20102026).

Para instruções consumidas por agentes, use
[writing-for-agents](../writing-for-agents/SKILL.md). Para corpos de PR e
commits, preserve o formato de [file-pr](../file-pr/SKILL.md).

## Escolher o tipo de documento

Use a distinção do Diátaxis para organizar o material:

- **Tutorial:** conduz quem está aprendendo a construir algo concreto.
  Declare o resultado, pré-requisitos e o que deve aparecer após cada etapa.
  Mantenha explicações longas em referências ligadas ao passo relevante.
- **Guia de tarefa:** ajuda uma pessoa que já conhece o produto a resolver
  um problema. Apresente os passos, decisões e condições necessárias.
  Priorize o caminho comum e explique as alternativas quando se aplicarem.
- **Referência:** permite consultar formatos, parâmetros, limites, estados
  e erros. Siga a estrutura do contrato e derive conteúdo da fonte canônica
  quando o projeto já tiver um gerador.
- **Explicação:** responde por que algo funciona daquela forma. Apresente
  contexto, restrições, decisões e alternativas. Separe fatos documentados
  de interpretações.

Escolha um propósito principal por documento. Separe e conecte conteúdos
quando a mistura dificultar encontrar a resposta; um esclarecimento curto
ou uma tabela útil não exige criar outro arquivo.

## Escrever em pt-BR

Coloque a condição antes da ação que depende dela. Nomeie quem executa a
ação e o que muda. Em procedimentos, indique resultados observáveis e o
que fazer diante das falhas pertinentes.

Mantenha nomes consistentes, pronomes com referência clara e frases completas.
Divida frases que obriguem o leitor a voltar para entendê-las, sem impor
contagem fixa de palavras. Use listas numeradas para passos e links que
digam qual informação será encontrada.

Siga a formatação do projeto nos exemplos. Aplique
[unslop](../unslop/SKILL.md) para revisar linguagem e evite repetir aqui seu
catálogo de estilo.

## Conferir as fontes

Leia a implementação, o contrato e os documentos aplicáveis antes de descrever
comportamento. Preserve a distinção entre plataforma e legado, sandbox,
homologação e produção. Uma prova com transporte simulado não autoriza
afirmar emissão real ou validade fiscal.

Para `/docs`, siga `docs/plataforma/PUBLIC.md` e edite as fontes em
`apps/docs/content/docs/`. Conteúdo de API gerado deve ser corrigido na
fonte contratual, não na saída. Decisões aceitas em ADRs continuam sendo
referência; exponha divergências em vez de reescrevê-las para justificar código.

Confira caminhos, links, exemplos e comandos. Execute os checks apropriados
ao conteúdo alterado; um comando com efeitos externos só pode ser exercitado
no escopo autorizado. Registre exemplos não executados e limitações que
afetem a interpretação do leitor.
