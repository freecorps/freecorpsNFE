---
name: create-formal-verification-skill
description: "Criar ou atualizar uma verificação formal local para invariantes de concorrência, retries ou máquinas de estados, com limites explícitos e vínculo ao código. Use quando testes não alcançam as ordens de execução relevantes."
---

# Criar uma skill de verificação formal

Escolha uma propriedade cujo descumprimento cause dano concreto e seja difícil
de alcançar pelos testes existentes. Quando o pedido nomear uma área, mantenha
esse escopo. Não introduza verificação formal como requisito de toda mudança.

No freecorpsNFE, um alvo possível é o protocolo descrito em
[OPERATIONS.md](../../../docs/plataforma/OPERATIONS.md): geração, lease, fence,
resposta tardia e reconciliação. Isso é uma sugestão de alvo, não um modelo já
validado. Leia o código atual e as guidelines indicadas pelo `AGENTS.md`
antes de descrever passos do Convex.

## Escolher ferramenta e propriedade

Expresse a propriedade e o dano em uma frase cada. Para ordens concorrentes
de ações, prefira um modelo pequeno com TLC/TLA+ e use
[statechart](../statechart/SKILL.md) para executar e comunicar o resultado.
Para propriedades de entradas, use um verificador aplicável ao código quando
disponível. Testes gerados ou fuzzing são alternativas úteis, mas devem ser
relatados como testes, sem prometer prova formal universal.

Registre ferramenta, versão, limites e hipóteses. Cada transição do modelo
precisa apontar para funções e persistências reais. Uma mutation transacional
pode ser indivisível; uma action que chama o fisco e depois persiste não é.
Inclua os intervalos em que acesso pode ser revogado, lease pode vencer ou
uma resposta antiga pode chegar, conforme a propriedade escolhida.

## Gerar o roteiro local

Crie `.agents/skills/verify-<domínio>-formal/SKILL.md`, com metadados e os
modelos ou verificadores necessários. O próximo agente deve conseguir:

- identificar se sua mudança alcança os arquivos, funções e estado cobertos;
- reproduzir o check com uma versão fixa da ferramenta e um comando concreto;
- ler a propriedade, o limite explorado e as hipóteses sem conhecer TLA+;
- distinguir defeito do produto, erro de modelagem e execução incompleta;
- atualizar o modelo após uma mudança intencional, preservando o contrato.

Registre o SHA conferido e as alterações locais incluídas. Só avance essa
referência depois de comparar a verificação com o código novo. Na manutenção,
leia também funções novas que escrevem o mesmo estado e código que mudou de
arquivo. Um modelo antigo continuar verde não demonstra que ainda descreve
o produto. Essa manutenção faz parte do roteiro gerado.

## Provar a capacidade de detectar falha

Execute a verificação e provoque uma violação conhecida numa variante
descartável. Quando a propriedade se refere ao código, confirme que a quebra
nesse código também é representada e detectada: mudar apenas uma constante
do modelo prova a ferramenta, não a correspondência com a implementação.
Use isolamento conforme [worktrees](../../../docs/worktrees.md) quando for
necessário alterar código; preserve mudanças locais do dev.

Reproduza um contraexemplo no código real com teste ou reprodução local quando
possível. Se um passo não puder acontecer no código, trate primeiro como erro
de modelagem. Sem reprodução, reporte o contraexemplo como candidato, com
essa limitação. Retire a quebra descartável e confirme o resultado original.

Uma falha real permanece achado. Não enfraqueça a propriedade para deixar
o modelo verde, nem corrija produto fora do escopo. Mudança de garantia exige
evidência no contrato aceito; uma alteração de implementação não basta.

Entregue ferramenta, comando, resultado, evidências, limites e o que ficou
sem prova. Sem executar o roteiro gerado, entregue-o como rascunho. Nenhum
modelo ou ensaio sintético comprova autorização fiscal ou comportamento de
produção fora das hipóteses verificadas.
