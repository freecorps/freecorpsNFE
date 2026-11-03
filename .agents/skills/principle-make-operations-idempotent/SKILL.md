---
name: principle-make-operations-idempotent
description: "Projetar ou revisar operações, comandos e filas que podem ser repetidos ou interrompidos, verificando deduplicação, retomada e reconciliação de efeitos incertos."
---

# Tornar operações idempotentes

Uma repetição precisa preservar o resultado correto mesmo quando a execução
anterior parou no meio. Derive a próxima ação do estado observado e das
evidências persistidas, incluindo a possibilidade de um efeito externo ainda
estar em andamento.

Para operações da plataforma, comece por
[OPERATIONS.md](../../../docs/plataforma/OPERATIONS.md) e pelo contrato do
domínio. Reutilize o protocolo existente; não crie outro controle de retry
para uma entrada que já chega ao mesmo domínio.

## Conferir o desenho

- Defina a identidade do pedido e o escopo da deduplicação. Preserve projeto,
  organização, empresa e ambiente conforme o contrato. Mesma chave com
  conteúdo incompatível não deve virar sucesso reaproveitado.
- Carregue o registro e valide o acesso atual também ao devolver resultado
  deduplicado ou retomar trabalho. Um identificador ou tipo correto não
  demonstra membership, concessão ativa ou permissão.
- Separe persistência transacional de chamada externa. Registre a intenção
  antes do efeito e confira geração, fence e lease nos pontos exigidos pelo
  protocolo. Uma resposta tardia não pode sobrescrever a tentativa atual.
- Timeout, queda após envio e consulta inconclusiva preservam incerteza.
  Consulte e reconcilie; ausência observada não prova que a chamada anterior
  deixou de produzir efeito. Só o contrato do adaptador pode justificar uma
  retransmissão. Não prometa exactly-once para um receptor externo.
- Torne resíduos reconhecíveis, como arquivos temporários e trabalho
  reclamado. Idade de lock ou PID isolado não comprova abandono. Para
  worktrees, use o protocolo de identidade e concorrência dos scripts locais.
- Preserve XML original, tentativas e auditoria. Idempotência não autoriza
  apagar histórico para fazer uma repetição parecer nova.

## Provar a retomada

Escolha a menor prova do domínio, com integrações simuladas. Exercite duas
execuções sequenciais, concorrentes e interrupções nos limites de efeito e
persistência. Confira o resultado, a quantidade de efeitos e o histórico.
Inclua resposta atrasada, revogação de acesso e isolamento entre escopos
quando esses casos alcançarem o fluxo alterado.

Para webhooks, diferencie repetição de entrega e identidade do evento: o
receptor precisa conseguir deduplicar. Para emissão, use o transporte
simulado e a reconciliação do domínio. Uma prova local não autoriza emissão
real. Em comandos, observe arquivos e processos após repetir; sucesso no
exit code sozinho não demonstra convergência.
