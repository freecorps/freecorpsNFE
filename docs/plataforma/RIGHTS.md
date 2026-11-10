# Atendimento a direitos dos titulares, D02

Procedimento manual de D02, aprovado para implementação em 06/10/2026 e com
canal e substituto decididos em 07/10, conforme
[Retenção](RETENTION.md#decisões-de-07102026). O substituto aceitou a função
em 19/10. A caixa foi ativada e o responsável concluiu o ensaio pelo console em
21/10, conforme [roteiro operacional](../operacao/privacidade-email.md#ensaio-pelo-console-em-21102026-1647-utc).
O primeiro acesso do substituto ainda não foi comprovado. Este documento
descreve a execução; não é parecer jurídico e não substitui a revisão
fiscal/privacidade de D06.

O modelo escolhido é o menor que atende D02: um canal dedicado, um registro
restrito de decisões recuperável fora do snapshot e os fluxos que o produto
já tem. A caixa e as notas restritas ficam no [Ember Mail](../operacao/email.md#caixas);
correção e exclusão da conta são feitas pelo próprio titular em **Minha conta**.

## Papéis e responsáveis

| Função                  | Quem                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| Responsável pelo pedido | O mantenedor, que assumiu atendimento a direitos e fiscal/privacidade em 06/10              |
| Substituto              | O outro sócio, designado em 07/10; aceite registrado em 19/10                               |
| Executor no deployment  | Quem opera a instalação, com acesso ao painel do Convex do alvo conferido em `../DEPLOY.md` |

A Freecorps tem papéis diferentes por classe, conforme as decisões de 07/10:

- **Operadora** dos documentos fiscais, originais, eventos, cadastros de
  empresas e certificados, tratados em nome do cliente (a organização
  contratante), que é o controlador. Um pedido sobre esses dados, como o
  CPF de um destinatário dentro de um XML, é encaminhado ao cliente
  controlador, e a Freecorps executa o que ele decidir pelos fluxos
  disponíveis. A Freecorps não decide pelo cliente.
- **Controladora** dos registros comerciais, de cobrança e idempotência.
  Este procedimento também trata como controladora as contas de usuário,
  membros, convites e registros de acesso, cuja finalidade e meios a
  Freecorps define. Confirmar essa classificação na revisão de D06.
- **Controladora da consulta e do cache CNPJ**, pois define fonte, finalidade,
  campos, prazo e reuso entre clientes. O cadastro confirmado permanece sob
  instruções do cliente. Veja [o procedimento CNPJ](../operacao/cnpj-direitos.md).

## Canal

O canal decidido é `privacidade@nfe.freecorps.com.br`, restrito ao responsável e
ao substituto. Ele é configurado no Worker de e-mail e no console; o
repositório não guarda credenciais.
A ativação e o ensaio do responsável estão comprovados no roteiro. Os passos
de conferência são:

1. Criar a caixa ou o alias e limitar o acesso às duas pessoas acima.
2. Enviar uma mensagem de teste de fora da organização e registrar o
   recebimento por ambas, com data, sem copiar o conteúdo para issues.
3. Publicar o canal junto com a identificação do encarregado
   ([LGPD, art. 41](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)),
   no texto de D06.

Trocar o canal exige atualizar este documento, [Retenção](RETENTION.md) e a
política pública na mesma mudança. Pedido recebido por outro meio (suporte,
GitHub, mensagem direta) é redirecionado ao canal sem transcrever seu
conteúdo. Issues públicas continuam vedadas para pedidos e evidências.

## Registro restrito

As notas da caixa constituem o registro restrito do atendimento. Conservar
também as decisões de exclusão e restrição em registro privado fora do
snapshot do Convex, acessível só ao responsável e ao substituto. Essa cópia
permite reaplicar decisões depois de um restore (D05). Ela guarda as decisões de
encerramento exportadas por `organizationClosure:decisions` e as linhas
`organization.purged`, `organization.guard-expired` e
`organization.decision-expired` do log, conforme
[Retenção](RETENTION.md#encerramento-implementado-d01).

Cada pedido tem uma entrada com estes campos. Use ids internos e referências;
não anexe PFX, senha, XML, documento de identidade nem cópia de dados do
titular.

| Campo                   | Conteúdo                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Referência              | Identificador sequencial, por exemplo `D02-2026-0001`                                                        |
| Recebimento             | Data, hora e canal                                                                                           |
| Responsável             | Quem conduz e quem substitui no pedido                                                                       |
| Verificação             | Método usado para conferir identidade e legitimidade, data e quem conferiu; nunca a cópia do documento       |
| Escopo                  | Conta, `organizationId`, membership e empresas envolvidas, por id                                            |
| Direitos pedidos        | Inciso do art. 18 ou art. 19 correspondente                                                                  |
| Papel por classe        | Controladora ou operadora; se operadora, cliente notificado, data e resposta                                 |
| Prazos                  | Triagem interna e prazo legal aplicável, com as datas-limite calculadas                                      |
| Decisão por classe      | Atender, conservar ou não aplicável, com motivo e fundamento; para conservação, prazo e destino ao fim       |
| Execução                | Ação, data, quem executou e comprovante: ids, contagens, hash da exportação ou linha de log                  |
| Cópias remanescentes    | Backups e exportações que ainda contêm o dado e até quando, conforme [Backup externo](../operacao/backup.md) |
| Resposta                | Data, meio e resumo do que foi comunicado ao titular                                                         |
| Encerramento e descarte | Data de encerramento; descarte da entrada cinco anos depois, conforme a decisão de 07/10                     |

## Prazos

- **Triagem interna:** até 2 dias úteis a partir do recebimento. É meta
  interna; não adia uma resposta que possa ser dada na hora nem estende
  prazos legais.
- **Confirmação e acesso:** resposta simplificada imediata ou declaração
  completa em até 15 dias do requerimento
  ([LGPD, art. 19](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)).
- **Demais direitos:** o prazo aplicável é avaliado na triagem e registrado.
  Se o pedido não puder ser atendido de imediato, o titular recebe a
  resposta prevista no art. 18, § 4º.

## Fluxo

1. **Registrar.** Abrir a entrada no mesmo dia, com referência, recebimento e
   responsável. Responder ao titular confirmando o recebimento e a referência.
2. **Conferir identidade e escopo.** Para titular de conta, responder pelo
   e-mail verificado da conta Better Auth e pedir a confirmação por esse
   endereço. Para representante, conferir o mandato. Para dados de uma
   organização, conferir no painel do deployment o papel da pessoa na
   organização. Login sem membership não dá acesso a dados da organização.
   Registrar só o método e o resultado.
3. **Triar.** Separar as classes envolvidas e o papel da Freecorps em cada
   uma. Encaminhar ao cliente controlador as que forem de operadora, com a
   referência e sem copiar o dado.
4. **Decidir por classe.** Usar a tabela abaixo. Conservação exige motivo e
   fundamento nos arts. 15, 16 e 18 e o prazo da
   [guarda decidida](RETENTION.md#guarda-após-o-encerramento-d01). Bloqueio
   de plano ou revogação de chave não equivale a exclusão.
5. **Executar** pelo fluxo existente, conferindo o alvo antes de qualquer
   escrita. Nada de alterar ou apagar linhas à mão no painel: uma exclusão
   sem função própria fica registrada como pendente de implementação, com
   prazo. Correção e exclusão de conta pedidas pelo canal são orientadas ao
   [fluxo do produto](#correção-e-exclusão-de-conta), feito pelo titular.
6. **Responder** ao titular com o que foi feito, o que foi conservado e por
   quê, e as cópias remanescentes com seu prazo.
7. **Encerrar** a entrada. Depois de um restore, reaplicar as decisões de
   exclusão registradas antes de liberar o acesso, conforme
   [Retenção](RETENTION.md#encerramento-implementado-d01).

## O que o produto permite hoje

| Pedido                                                  | Classes                                         | Execução disponível                                                                                                                         | Limite atual                                                                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmação e acesso (art. 18, I e II)                  | Conta, memberships, registros de acesso, uso    | Consulta pelo operador no painel do deployment: perfil Better Auth, `memberships` por `authUserId`, `accessRecords` por `userId` ou `actor` | Sem consulta pública de `accessRecords`; resposta montada à mão e conferida antes do envio                                                                             |
| Acesso e portabilidade de dados da organização          | Documentos, originais, itens                    | [Exportação da organização](EXPORTS.md) pelo owner ou admin do cliente controlador, inclusive na janela de encerramento                     | A Freecorps não exporta dados fiscais de um cliente a terceiro sem decisão do controlador                                                                              |
| Correção (art. 18, III)                                 | Nome e e-mail da conta                          | [Minha conta](#correção) no console, pelo titular                                                                                           | A troca de e-mail exige o código enviado ao novo endereço e encerra as sessões. Sem e-mail de contas (`EMAIL_MODE=disabled`), o console não oferece a troca de e-mail. |
| Eliminação, bloqueio ou anonimização (art. 18, IV e VI) | Dados de uma organização                        | [Encerramento](ORGANIZATIONS.md#encerramento) pelo owner; classes excluídas saem em até 37 dias e as conservadas ao fim da guarda           | Documentos e registros comerciais ficam até o fim da guarda; registros de acesso, 184 dias                                                                             |
| Eliminação de membro                                    | Membership e concessões                         | Remoção do membro por owner ou admin no console                                                                                             | A remoção marca o membership como removido; não apaga a linha nem a conta                                                                                              |
| Eliminação da conta                                     | Conta e sessões Better Auth                     | [Minha conta](#exclusão-de-conta) no console, pelo titular                                                                                  | Espera a saída de todas as organizações; memberships removidos ficam anonimizados                                                                                      |
| Informação sobre compartilhamento (art. 18, VII)        | Todas                                           | Lista de provedores e destinos do inventário de D03                                                                                         | Inventário de D03 ainda não conferido na instalação                                                                                                                    |
| Dados em XML de terceiros                               | CPF/CNPJ de destinatários, tomadores, endereços | [Encaminhar ao cliente controlador](#dados-de-pessoas-físicas-em-documentos-fiscais); executar a decisão dele pelos fluxos acima            | Não há busca por CPF dentro dos documentos; o cliente localiza pelo console                                                                                            |

Correção e oposição relativas à consulta CNPJ seguem o
[procedimento específico](../operacao/cnpj-direitos.md), com restrição global
da fonte e expurgo de histórico por empresa. Nos demais domínios, revogação
de consentimento, oposição e revisão de decisão automatizada não têm fluxo
próprio no produto. Se um pedido chegar, registre-o e leve a base
legal da classe à revisão de D06 antes de responder com mérito; a resposta de
recebimento e o prazo seguem normalmente.

## Dados de pessoas físicas em documentos fiscais

Acrescentado em 25/10/2026 (#428) e aprovado pelo mantenedor em 28/10/2026,
sem revisão jurídica (#586), com as três respostas marcadas abaixo. Nada
nesta seção mudou o produto.

### Que dados são

NF-e e NFS-e trazem o que o emitente declarou sobre as partes da operação.
Numa NF-e modelo 55 isso inclui emitente, destinatário, transportador e quem
pode baixar o XML (`autXML`); numa NFS-e, prestador e tomador. Qualquer uma
dessas partes pode ser pessoa física, com CPF e, conforme o grupo, nome e
endereço. As informações complementares são texto livre e podem citar outras
pessoas. A plataforma guarda o XML original inteiro e projeta emitente e
destinatário no documento normalizado ([Documentos](DOCUMENTS.md)).

As notas chegam por dois caminhos, e o controlador é o mesmo nos dois, a
organização cliente:

- **Importação.** O cliente envia o XML pelo console, pela API ou pelo SDK.
- **Captura fiscal.** Para uma empresa que ativou a captura no console, a
  Freecorps consulta a distribuição de NF-e da Receita com o A1 da empresa
  ([CAPTURE.md](CAPTURE.md#liberação-fiscal-no-site)). Ela recebe as notas
  em que a empresa é destinatária ou interessada, inclusive as emitidas por
  pessoas físicas, como um produtor rural. O titular não escolheu a
  Freecorps nem o cliente; a nota chegou porque o fisco a distribui à
  empresa.

### Como atender

1. Registrar o pedido no registro restrito, como qualquer outro.
2. Conferir a identidade do titular. Para localizar a nota, pedir a chave de
   acesso ou o CNPJ da empresa com quem ele fez a operação. A Freecorps não
   procura um CPF em todos os clientes: não há busca por CPF, e uma varredura
   do banco a pedido de terceiro exporia dados de clientes que não têm
   relação com o pedido. Se o titular não souber a empresa, a Freecorps
   não procura o controlador por conta própria (decisão de 28/10/2026).
3. Encaminhar o pedido aos proprietários e administradores da organização
   que guarda a nota, com a referência, sem copiar o dado. Informar ao
   titular que o pedido foi encaminhado ao controlador. Não dizer ao titular
   qual organização guarda a nota, porque isso revela a relação comercial do
   cliente; quem o titular indicou já sabe (decisão de 28/10/2026).
4. Executar a decisão do cliente pelos fluxos que existem e registrar o
   resultado. Desativar a captura não apaga nada.

### Limites da guarda fiscal obrigatória

O cliente tem a obrigação de guardar os documentos fiscais, e a Freecorps os
guarda em favor dele ([guarda após o encerramento](RETENTION.md#guarda-após-o-encerramento-d01)).
Isso limita o que um pedido do titular pode mudar:

| Direito pedido                     | O que acontece                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmação e acesso               | O cliente responde; ele vê e exporta a nota pelo console, pela API ou pela [exportação](EXPORTS.md). A Freecorps não envia a nota de um cliente ao titular sem a decisão do cliente.                                                           |
| Correção                           | Não se aplica ao conteúdo da nota. O documento é a declaração do emitente autorizada pelo fisco e tem assinatura e hash; só o emitente o corrige, por carta de correção ou cancelamento no fisco. Um evento recebido depois fica no histórico. |
| Eliminação, anonimização, bloqueio | Não existe exclusão nem anonimização de uma nota avulsa. A nota sai só no [expurgo ao fim da guarda](RETENTION.md#guarda-implementada-d01), depois do encerramento da organização, ou mais tarde, se houver retenção legal.                    |
| Oposição                           | Sem fluxo próprio. Registrar e levar a base legal da classe à revisão de D06, como os demais pedidos sem fluxo.                                                                                                                                |
| Portabilidade                      | Pela exportação do cliente controlador.                                                                                                                                                                                                        |

A guarda se apoia na LGPD, art. 16, I, conforme a decisão de 07/10/2026. O
prazo dela conta do ano do encerramento da organização, não da data de cada
nota, e por isso uma nota pode ficar mais tempo do que a obrigação fiscal
pediria ([guarda implementada](RETENTION.md#guarda-implementada-d01)).
A recusa de eliminação durante a guarda vale também para as notas que o
cliente já não está obrigado a guardar: a guarda é uma só, contada do
encerramento (decisão de 28/10/2026).

## Correção e exclusão de conta

Em 19/10/2026, o mantenedor decidiu atender correção e exclusão de conta
por procedimento manual do operador até o fluxo existir no produto. A #254
implementou o fluxo e aposentou o procedimento: o titular corrige e exclui
a própria conta em **Minha conta** (`/account`), pelas funções de
`platform/convex/account.ts`. Só o próprio titular, autenticado e com e-mail
verificado, chega a essas funções; nenhuma recebe um id de conta. Login sem
membership também pode excluir a própria conta. Um pedido recebido pelo
canal é respondido com o caminho no console, dentro do prazo, e registrado
como atendido pelo produto; o operador não edita linhas no painel.

O membership copia nome e e-mail da conta quando a pessoa entra na
organização. Cada correção reescreve essas cópias, em todos os `memberships`
do `authUserId`, ativos e removidos, na mesma transação que altera `user`.
A versão do membership não muda: ela protege a troca de papel e os convites
emitidos por ele. `/update-user` do Better Auth fica desligado, para que
nenhum caminho altere o nome sem as cópias.

### Correção

- **Nome:** `account:rename` grava o nome, de 2 a 100 caracteres, em `user`
  e nos `memberships`.
- **E-mail:** o e-mail é o login. `account:requestEmailChange` envia ao novo
  endereço um código de oito dígitos, guardado só como hash em
  `emailChanges`, válido por dez minutos e por três tentativas. Um endereço
  já usado por outra conta não recebe código, e a resposta é a mesma de um
  endereço livre. `account:confirmEmailChange` confere o código, recusa de
  novo um endereço que outra conta passou a usar e, na mesma transação,
  grava o novo endereço em minúsculas em `user` e nos `memberships`, mantém
  `emailVerified`, apaga as linhas `verification` dos dois endereços e as
  linhas `session` da conta. A pessoa entra de novo com o novo e-mail.
  Convites pendentes para o endereço antigo deixam de servir à conta,
  porque o aceite compara o e-mail; a organização convida o novo endereço.
  Sem e-mail de contas (`EMAIL_MODE=disabled`), o console não oferece a troca
  de e-mail.

### Exclusão de conta

1. **Sair das organizações.** `account:deletion` lista os memberships
   ativos e marca o caso de único owner. Cada um é removido no console por
   owner ou admin da organização, que é quem controla seus membros. Se o
   titular é o único owner, ele transfere a propriedade ou
   [encerra a organização](ORGANIZATIONS.md#encerramento) antes. Enquanto
   houver membership ativo, `account:remove` recusa com
   `ACCOUNT_HAS_MEMBERSHIPS`, e a tela mostra o que falta, conforme o
   art. 18, § 4º.
2. **Excluir.** O titular digita o e-mail da conta e confirma.
   `account:remove` relista os memberships ativos na mesma transação que
   apaga, então um aceite de convite concorrente conflita em vez de passar.
   Na mesma transação:
   - revoga os convites `pending` ou `sending` ao e-mail em todas as
     organizações, com `invitation.revoked` na auditoria de cada uma: um
     convite válido serviria a quem recadastrasse o mesmo e-mail;
   - apaga o e-mail dos convites já encerrados ao endereço (aceitos,
     revogados ou sem entrega), que ficam com estado, papel e datas na
     organização; a lista de convites mostra `Conta excluída`;
   - grava `name` como `Conta excluída` e `email` vazio em cada membership
     do `authUserId`. Papel, datas, estado e o próprio `authUserId` ficam:
     são o histórico da organização, e a auditoria aponta para eles por id;
   - apaga no componente `betterAuth` as linhas `session`, `account` e
     `twoFactor` da conta, as `verification` do e-mail e por último a linha
     `user`; apaga também `validationAccess` e `emailChanges` do
     `authUserId`.
3. **Registrar.** A exclusão escreve no log uma linha `account.deleted`, com
   `authUserId`, data e contagens, sem nome nem e-mail. O operador a copia
   para o registro restrito: é a decisão que um restore reaplica.
4. **O que fica.** Os `memberships` anonimizados e o `actorUserId` de
   `organizationAudit` ficam com a organização até o encerramento dela;
   `accessRecords` seguem os 184 dias. Um token Convex já emitido vale até expirar, mas sem a
   conta nenhuma função o aceita. A conta continua nas cópias de
   [backup](../operacao/backup.md) até elas expirarem.

### Depois de um restore

Para cada `account.deleted` do registro restrito, antes de liberar o acesso
e depois de reaplicar os encerramentos
([Retenção](RETENTION.md#encerramento-implementado-d01)), rodar
`account:reapplyDeletion` com o `authUserId`. Os memberships que o snapshot
traz ativos são removidos de novo, como estavam antes da exclusão original,
e o restante segue o passo 2. O único owner de uma organização não
encerrada responde `blocked`, com a organização, e nada muda: resolver a
propriedade pelo registro antes de repetir. Repetir depois de aplicado
responde `unchanged`.

## Caixa implantada e acompanhamento

A decisão de 21/10/2026 substituiu o alias externo por uma caixa própria, no
endereço `privacidade@nfe.freecorps.com.br`. A caixa começou no console e
passou para o [Ember Mail](../operacao/email.md), o serviço de e-mail da
Freecorps, sem mudar o endereço. Ela recebe mensagens, registra notas
internas e permite responder. Só as contas do serviço com acesso à caixa a
leem: os admins, que são o responsável e o substituto. Papéis das
organizações clientes não concedem acesso.

O serviço guarda o original `.eml` e os anexos de cada mensagem. O remetente
não é considerado verificado. A conversa reúne as respostas pelos cabeçalhos,
mas isso não substitui a verificação de identidade exigida neste roteiro.
Notas internas registram os campos de atendimento acima e não são enviadas
ao titular. Conversas encerradas são apagadas cinco anos depois da última
mudança de status ou mensagem, junto dos originais, mensagens e notas.

Aceitação da resposta pelo serviço não comprova leitura nem entrega final; a
entrega e os bounces aparecem na própria conversa. A configuração e a troca
estão em [E-mail pelo Ember Mail](../operacao/email.md); o registro da caixa
anterior, em [E-mail de privacidade](../operacao/privacidade-email.md).

- Canal e ensaio do responsável concluídos no roteiro operacional de 21/10.
  Registrar o primeiro acesso do substituto quando ele criar e verificar sua conta.
- Para CNPJ, executar e registrar a decisão conforme o procedimento específico;
  as novas funções só estarão hospedadas depois do deploy desta entrega.
- O aviso específico CNPJ acompanha esta PR em `/docs/privacidade-cnpj`.
  A revisão geral de D06 e a identificação formal do encarregado continuam
  no escopo de lançamento, sem declarar todo o produto revisado por este aviso.
