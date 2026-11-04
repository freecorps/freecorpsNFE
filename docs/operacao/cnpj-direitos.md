# Atendimento de direitos sobre consulta CNPJ

Procedimento de D02 para a projeção OpenCNPJ, complementando
[RIGHTS.md](../plataforma/RIGHTS.md). O canal já foi ativado e ensaiado pelo
responsável, conforme [registro de 21/10](privacidade-email.md#ensaio-pelo-console-em-21102026-1647-utc).
O primeiro acesso do substituto permanece distinto do ensaio do responsável.

## Triagem e decisão

Receber pela caixa `privacidade@nfe.freecorps.com.br`, inclusive de pessoas
sem conta. Conferir identidade, relação com o CNPJ e eventual representação
antes de compartilhar informações. O remetente do e-mail não está verificado
apenas por ter enviado uma mensagem. Registrar nas notas restritas finalidade,
escopo, prazos e decisão por classe, sem copiar os dados para issues ou Git.

A Freecorps decide finalidade, fonte, projeção e reutilização do cache entre
clientes. Para essa etapa, este procedimento a trata como controladora.
No cadastro confirmado, a organização cliente é controladora e a Freecorps
executa suas instruções. A declaração da empresa pelo cliente não comprova
representação jurídica. Suspeita de uso indevido deve ser examinada na triagem,
sem conceder acesso ao reclamante ou confirmar a existência de outros clientes.

Separar os pedidos:

| Pedido deferido                               | Execução                                                                                                                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acesso                                        | Consultar somente o CNPJ e o escopo verificados. Explicar origem, campos, datas, destinatários e prazos, sem revelar organizações não abrangidas pelo pedido.                                                                          |
| Correção no cadastro confirmado               | Encaminhar ao cliente controlador; owner/admin usa a edição manual da empresa. Registrar a versão resultante. Isso não corrige a Receita nem o OpenCNPJ.                                                                               |
| Correção da projeção externa                  | Suspender consulta e retirar cache enquanto a fonte estiver incorreta. Orientar o titular a corrigir a origem. Só liberar depois de verificar a correção e registrar nova decisão. Não introduzir um endereço privado no cache global. |
| Oposição à consulta ou eliminação da projeção | Aplicar a restrição global por CNPJ e retirar o cache. A restrição acompanha o CNPJ, não a conta do solicitante ou uma organização.                                                                                                    |
| Eliminação de valores anteriores em histórico | Após decisão do cliente controlador, expurgar somente `registryApplications` da empresa indicada pelo procedimento abaixo. Cadastro atual e documentos fiscais exigem decisão própria.                                                 |

Não tratar uma reclamação como deferida automaticamente. Recusa ou conservação
exige motivo e fundamento comunicado ao titular. Se for necessário impedir
também o uso do cadastro atual, o cliente deve corrigi-lo ou seguir o fluxo de
encerramento aplicável. A restrição da fonte não oculta nem apaga esse cadastro.

## Executar a decisão

As funções abaixo são `internalMutation`: não são endpoints públicos e não
aceitam chamada de clientes pelo console ou por API key. O operador autorizado
da instalação as executa no painel administrativo do Convex, após conferir o
alvo conforme [deploy-producao.md](deploy-producao.md). Não editar linhas à mão.
`actor` identifica quem executou; não é uma credencial. `reference` é o código
do pedido restrito, sem nome, endereço ou motivo pessoal no argumento.

1. Ler `registryRestrictions` pelo CNPJ normalizado e anotar `version`, ou
   zero quando não há registro. Registrar a decisão e o executor na caixa.
2. Executar `registryStore:restrict` com `cnpj`, `blocked: true`,
   `reference`, `actor` e `expectedVersion`. A transação grava a restrição,
   cancela os jobs do cache e o remove. Repetir a mesma referência/estado
   não incrementa a versão e reaplica a remoção, inclusive após restore.
3. Conferir o resultado `{version, blocked: true}` e a ausência de cache.
   A leitura autenticada retorna `unavailable` sem dados; novas atualizações
   são negadas e operações que estavam na fila terminam `REGISTRY_RESTRICTED`.
   Uma chamada externa já iniciada não pode ser desfeita; sua resposta é
   descartada. Não interpretar esse caso como ausência de envio ao provedor.
4. Se o histórico da empresa tiver eliminação deferida, executar
   `registryStore:eraseApplicationHistory` com `organizationId`, `companyId`,
   `cnpj`, `expectedCompanyVersion` atual e `reference`. Exige a restrição
   ativa e confere organização, CNPJ e versão. Remove até 100 linhas por
   chamada; repetir até `done: true`. Guardar as contagens no pedido.
   Não altera cadastro atual, auditoria fiscal ou outra empresa.
5. Responder com o que foi executado, o que ficou, os motivos e as cópias
   remanescentes. Conservar o recibo e a decisão fora do snapshot operacional
   para que um restore não desfaça o atendimento.

Para liberar a consulta, registrar nova decisão e executar `restrict` com
`blocked: false`, nova `reference` e a versão corrente. A liberação não restaura
o cache antigo nem dispara uma consulta. Uma solicitação posterior segue o
fluxo normal. Não liberar só porque o provedor voltou a responder.
Sem bloqueio ativo, liberar não altera o cache nem cria ou incrementa o
registro de controle. A versão esperada continua sendo conferida, salvo
repetição da mesma decisão. Ao retirar um bloqueio ativo, a transação também
elimina eventual cache antigo recuperado de backup antes de permitir leituras.

## Retenção e recuperação

`registryRestrictions` é controle global, separado do cache de 30 dias e do
encerramento das organizações. Mantém CNPJ, estado, referência, executor,
versão e data enquanto a restrição ou sua reversão precisar ser aplicada.
O caso fica em revisão no registro D02; o encerramento de uma organização
não autoriza remover a restrição global. O registro mínimo evita recolher o
mesmo dado depois de um pedido deferido. Os motivos e provas ficam na caixa
com a retenção de atendimento, não no cache.

Antes de restaurar acesso depois de um backup, reaplicar as decisões posteriores
ao snapshot a partir do registro de D02, em ordem, conferindo a versão vigente.
Repetir também os expurgos de histórico deferidos. A versão passada ao comando
é a do banco restaurado, não necessariamente a do recibo antigo. Uma decisão
mais recente prevalece sobre a anterior. A verificação deve terminar antes
de reabrir consultas, conforme o procedimento D05.

## Prova e publicação

`platform/convex/registry.test.ts` usa transporte e cadastros sintéticos para
verificar cache compartilhado, permissões, fila, resposta em trânsito,
liberação, repetição e expurgo limitado à empresa. A caixa e seu ensaio externo
existente estão no roteiro vinculado acima. A resposta aceita pelo provedor
não comprova entrega final ou leitura pelo destinatário.

O aviso público está em `apps/docs/content/docs/privacidade-cnpj.mdx`, em
`/docs/privacidade-cnpj`, acessível sem login e ligado pelo rodapé. A PR prepara
sua publicação junto com as funções, pelo fluxo normal de deploy após merge;
não declara que código ainda não publicado já atende pedidos na instalação.
