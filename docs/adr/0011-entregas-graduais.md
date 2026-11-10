# Entregas graduais e aceite por capacidade

Data: 31/10/2026 · Status: **Aceita** por decisão do mantenedor na
[#43](https://github.com/freecorps/freecorpsNFE-arquivo/issues/43), documentada na
[#694](https://github.com/freecorps/freecorpsNFE-arquivo/issues/694).

## Contexto

O processo anterior reunia CI, termos, distribuição, operação e expansão
fiscal num encerramento global da plataforma 1.0, pela sequência
#47 → #51 → #43. Isso fazia entregas esperarem capacidades sem relação com
seu resultado. A plataforma já tem capacidades publicadas, outras integradas
com ativação desligada e provas com ambientes e limites distintos.

## Decisão

Cada entrega tem resultado, dependências e critério de pronto na própria
issue. O aceite fica nela, com SHA, ambiente, evidências, limites e aprovações
aplicáveis. Não há lançamento global 1.0, data comum nem cadeia de fechamento.
#43 é um mapa de prioridades; #47 e #51 conservam registros históricos.

Uma entrega só espera os pré-requisitos do seu escopo. Integrado significa
incorporado ao código; publicado exige recibo no destino; habilitado exige
os gates e autorizações da capacidade. Nenhum desses estados implica os
demais. O aceite identifica exatamente quais estados foram comprovados.

Os checks obrigatórios continuam valendo. Provas anteriores podem ser
reaproveitadas quando a comparação do conteúdo e do ambiente mostrar que
continuam válidas. Uma mudança que as invalide exige nova prova; um hash
antigo não certifica um artefato novo. Falhas de segurança, isolamento,
idempotência ou integridade bloqueiam a entrega afetada.

## Aplicação

- A [matriz](../v1.0/ACCEPTANCE.md) registra capacidades, limites e lacunas.
  O [índice de evidências](../v1.0/EVIDENCE.md) conserva os recibos. Andamento
  e aceite ficam na issue da entrega, sem nova revisão global.
- A #83 escolhe SHA por lote de publicação e aceita cada pacote por versão
  e hash, com os gates `rights` e `release-acceptance`. A #267 cuida da árvore
  pública correspondente; não bloqueia por si só a publicação de pacotes.
- A #428 publica termos para o serviço disponível, com data real por
  publicação, versão, hash, avisos, aceites e auditoria. A aprovação já dada
  aos textos não se repete por ritual. As revisões jurídicas exigidas para
  anual e custódia permanecem. D01 continua na #80, sem bloquear globalmente
  outras entregas nem antecipar expurgo.
- Revisão humana e comunicação ficam na #85; recuperação independente,
  atendimento pelo substituto e retomada fiscal após restauração seguem
  #178, #692 e #693. As dependências comerciais e fiscais continuam nas
  respectivas issues, incluindo #549, #690, #691, #197 e #198.

## Consequências e limites

Esta decisão substitui apenas a exigência de encerramento global e as datas
atreladas a ele. Decisões históricas e recibos não são reescritos nem passam
a comprovar tarefas pendentes. As referências antigas a "antes/depois da
1.0" descrevem a organização anterior; a issue da entrega define a fila atual.

Permanecem as versões técnicas da API, SDK e termos, a licença Freecorps 1.0,
o diretório `docs/v1.0`, os prazos de retenção, avisos e regras de segurança.
Não mudam CI, publicação automática da aplicação, publicação dos pacotes,
gates fiscais ou aprovações de produção. A decisão não publica software,
ativa oferta comercial, transmite ao fisco ou concede aceite jurídico.
