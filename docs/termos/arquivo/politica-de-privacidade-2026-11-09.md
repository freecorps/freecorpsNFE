## Política de privacidade e retenção de dados do freecorpsNFE

Versão 1.1, vigente a partir de 9 de novembro de 2026. Aplica-se ao serviço hospedado em https://nfe.freecorps.com.br e à API em https://api.nfe.freecorps.com.br.

## 1. Quem somos e qual é o nosso papel

O freecorpsNFE é operado por FREECORPS TECNOLOGIA DA INFORMACAO LTDA, CNPJ 63.113.119/0001-90 ("Freecorps"). Tratamos dados em dois papéis:

- Como operadora, em nome do cliente que contrata o serviço, a organização: documentos fiscais importados ou recebidos pela captura fiscal, seus XML originais, eventos e itens, cadastros de empresas e certificados. O cliente é o controlador desses dados e decide sobre eles, nos termos da cláusula de operadora, parte dos termos de uso que o cliente aceita no console. Os documentos fiscais contêm dados de terceiros, descritos na seção 2.
- Como controladora: contas de usuário, membros e convites das organizações, registros de acesso à aplicação, registros de uso, cobrança e idempotência, registros de atendimento a direitos, o histórico de liberação da emissão NFS-e com validade fiscal e das verificações feitas com o certificado do cliente, com os logins GitHub dos colaboradores da Freecorps que as dispararam e aprovaram, e o histórico de liberação da captura fiscal, com a pessoa da organização que a ativou ou desativou e a versão e o hash dos termos aceitos.

## 2. Dados que tratamos

- Conta: nome, e-mail, senha protegida e sessões.
- Organização: nome, endereço no console, membros, papéis e convites.
- Empresas e integrações: CNPJ, dados cadastrais, projetos, chaves de API, das quais guardamos só o hash, e destinos de webhook.
- Certificados A1: o arquivo e a senha ficam cifrados no cofre; não aparecem em logs nem em telemetria.
- Documentos fiscais: XML original preservado, versões normalizadas, itens e eventos. Vêm da importação feita pelo cliente ou, para as empresas que ativaram a captura fiscal, da distribuição de NF-e da Receita, consultada com o certificado A1 da empresa.
- Dados de terceiros nos documentos fiscais: as notas trazem o que o emitente declarou sobre as partes da operação, como emitente, destinatário ou tomador, transportador e pessoas autorizadas a obter o XML. Quando uma delas é pessoa física, a nota tem o CPF dela e, conforme o grupo, nome e endereço, e pode ter outros dados nas informações complementares. Guardamos o XML original inteiro; não filtramos nem mascaramos esses dados, porque o documento fiscal precisa ficar íntegro.
- Uso: contagens por unidade e período, planos e alterações de plano.
- Cobrança: pedidos e pagamentos dos planos. Pagamentos por cartão são processados pela Stripe; não recebemos o número do cartão.
- Registros de acesso: identificação do usuário ou da chave, endereço IP e data e hora de cada acesso autenticado ao console e à API.
- Telemetria operacional: identificadores de requisição e operação, rota, estado e duração, sem corpo de requisição, XML ou credenciais.

## 3. Para que usamos e com que base legal

Usamos os dados para prestar o serviço contratado, que é importar, guardar, consultar, exportar e notificar sobre documentos fiscais, autenticar pessoas e integrações, medir uso e aplicar limites do plano, cobrar os planos pagos, investigar falhas e abusos, cumprir obrigações legais e regulatórias e atender pedidos dos titulares. Cada classe de dado tem um papel e uma base legal:

- Documentos fiscais e dados de terceiros neles. Papel: operadora. Base legal: a do cliente controlador; para guardar as notas, o cumprimento da obrigação fiscal do contribuinte (LGPD, art. 7º, II). A guarda depois do encerramento segue o art. 16, I.
- Cadastro de empresas, certificados e configurações das integrações. Papel: operadora. Base legal: a do cliente controlador; para a Freecorps, a execução do contrato com ele (art. 7º, V).
- Conta, sessões, membros e convites. Papel: controladora. Base legal: execução do contrato (art. 7º, V).
- Registros de acesso. Papel: controladora. Base legal: obrigação legal (art. 7º, II), pelo Marco Civil da Internet, art. 15.
- Uso, cobrança, planos e idempotência. Papel: controladora. Base legal: execução do contrato (art. 7º, V) e obrigação legal da Freecorps (art. 7º, II) para a guarda, conforme o Código Tributário Nacional, art. 173, e o Código Civil, art. 1.194.
- Históricos do gate e das verificações da emissão NFS-e e da liberação da captura fiscal. Papel: controladora. Base legal: exercício regular de direitos (art. 7º, VI), com legítimo interesse (art. 7º, IX) durante a vigência.
- Telemetria operacional, auditoria HTTP e notificações. Papel: controladora. Base legal: legítimo interesse (art. 7º, IX), para segurança, diagnóstico e suporte.
- Atendimento a direitos. Papel: controladora. Base legal: obrigação legal (art. 7º, II) e comprovação do atendimento (art. 16, I e II).
- Consulta e cache de CNPJ. Papel: controladora. Base legal: legítimo interesse (art. 7º, IX), conforme avaliação própria da Freecorps.

## 4. Com quem compartilhamos

Usamos provedores de infraestrutura que tratam dados em nosso nome, todos com sede nos Estados Unidos:

- Convex: banco de dados, arquivos e funções do serviço. Os dados ficam nos Estados Unidos, na AWS, região us-east-1.
- Cloudflare: console, API e Workers; recebimento e envio de e-mail; cópia externa cifrada do backup. As requisições passam pela rede global da Cloudflare, no ponto mais próximo de quem acessa; a cópia de backup fica no leste da América do Norte.
- GitHub: código e execução dos jobs de integração contínua, publicação e backup, incluindo o processamento transitório da cópia antes de cifrá-la. Os jobs rodam em máquinas da Microsoft Azure contratadas pelo GitHub, fora do Brasil.
- Stripe: processamento dos pagamentos por cartão dos planos pagos, quando contratados.

Mensagens de privacidade passam por uma fila privada e ficam no banco do serviço para atendimento pelos responsáveis autorizados. Não vendemos dados. Dados de um cliente não são entregues a outro cliente nem a terceiros sem decisão do controlador ou obrigação legal.

## 5. Por quanto tempo guardamos

Enquanto a organização existe:

- Documentos fiscais, XML originais, operações e sua auditoria: enquanto a organização existir.
- Uso, planos e registros de cobrança e idempotência: enquanto a organização existir.
- Registros de acesso, com usuário ou chave, IP, data e hora: 6 meses, pelo Marco Civil da Internet, art. 15.
- Rastros HTTP de diagnóstico: 30 dias.
- Projeção de auditoria operacional: 365 dias.
- Notificações no painel: 30 dias.
- Recibos de consultas de empresas pela API: 31 dias; depois, só os totais.
- Cache de consulta cadastral de CNPJ: até 30 dias.
- Cópias de backup: 14 dias na cópia externa cifrada; os backups do provedor do banco seguem a retenção dele.

Os logs ficam na retenção de cada provedor, sem exportação para outro destino:

- GitHub, integração contínua e publicação: logs e artefatos dos jobs por até 30 dias. Os logs gravados antes de 19/10/2026 seguem o prazo anterior, de 90 dias, e saem até 17/01/2027.
- Cloudflare: registros das requisições HTTP e histórico de recebimento de e-mail por 30 dias; histórico de envio de e-mail consultável por até 30 dias; logs do Worker que recebe as mensagens de privacidade, sem o conteúdo delas, por 3 dias.
- Convex: só o histórico curto de logs das funções no painel do deployment, sem prazo fixado pela Convex.
- Blacksmith, que executou os jobs até 9 de novembro de 2026: as máquinas de cada job foram descartadas ao fim dele; os logs desses jobs ficam no painel da Blacksmith enquanto a Freecorps for cliente e são apagados em até 30 dias depois do fim do contrato, conforme a política da Blacksmith.

Os backups nativos do Convex, quando feitos, seguem a retenção do provedor: sete dias para os manuais e diários e 14 para os semanais, conforme a documentação da Convex consultada em 05/10/2026.

Depois do encerramento da organização, descrito na seção 6:

- Cadastro, membros, convites, empresas, certificados, chaves, integrações e exportações: 30 dias para exportação; exclusão em até 7 dias depois.
- XML, eventos, protocolos, recibos e auditoria original das operações fiscais: até 31 de dezembro do quinto ano seguinte ao do encerramento.
- Registros comerciais, de cobrança e idempotência: o mesmo prazo, por obrigação da própria Freecorps.
- Históricos de liberação da emissão NFS-e e da captura fiscal: o mesmo prazo, para defesa da Freecorps.
- Registros de acesso: 6 meses desde cada acesso.
- Registros de atendimento a direitos: 5 anos desde o encerramento do pedido.

Esses prazos depois do encerramento valem para a organização que teve qualquer dado no ambiente de Produção. A que só usou o Sandbox, ambiente de teste sem validade fiscal, não tem o que guardar: logo depois da exclusão do cadastro, os documentos, operações, uso e demais registros fiscais também são excluídos. Se essa exclusão falhar, ela é tentada de novo a cada semana, e no pior caso os dados ficam até o prazo da lista acima. Ficam com os prazos da lista acima os registros de planos, pagamentos e capacidade, que a Freecorps guarda por obrigação própria, e os registros de acesso e de atendimento. A decisão é tomada uma vez, no encerramento; uma organização com arquivo econômico conta como tendo usado a Produção. Uma retenção legal ativa adia essa exclusão até a liberação.

Os documentos recebidos pela captura fiscal seguem a mesma guarda dos importados. Desativar a captura não apaga nada: o que já foi recebido continua disponível para consulta e exportação enquanto a organização existir.

Quando a Freecorps ativar o arquivamento de organizações inativas, previsto nos termos de uso, os documentos fiscais de uma organização arquivada vão para uma guarda fria cifrada, nos mesmos provedores, sem encurtar nenhum prazo desta seção.

Fiscalização, processo ou pedido formal de autoridade pode exigir a conservação além desses prazos; nesse caso registramos a referência, o responsável e a data de revisão. Prazos de exclusão indicam quando o dado deixa de ser guardado no banco em uso; cópias de backup saem quando a cópia expira, e uma restauração reaplica as exclusões antes de reabrir o acesso.

## 6. Encerramento e sua conta

O Proprietário da organização pode encerrá-la no console. O encerramento bloqueia novas operações e revoga chaves e integrações na hora. Durante 30 dias, Proprietários e Administradores podem exportar os dados da organização. Depois, as classes sem motivo de conservação são excluídas em até 7 dias, e as conservadas seguem os prazos da seção 5.

Contas de usuário são independentes das organizações e não saem com o encerramento. Você corrige o nome ou o e-mail e exclui a sua conta no console, em Minha conta; a troca de e-mail exige um código enviado ao novo endereço. A exclusão exige que você tenha saído de todas as organizações. Seu nome e e-mail saem do histórico de membro e dos convites, que ficam com cada organização com papel, datas, estado e o identificador técnico da conta; a auditoria da organização guarda esse mesmo identificador. Registros de acesso e cópias de backup seguem os prazos da seção 5.

## 7. Seus direitos

Você pode pedir confirmação de tratamento, acesso, correção, anonimização, bloqueio ou eliminação, portabilidade, informação sobre compartilhamento e os demais direitos do art. 18 da LGPD pelo canal privacidade@nfe.freecorps.com.br. Encarregado: Wolf Stievano. Respondemos à confirmação de existência e ao acesso de imediato, de forma simplificada, ou por declaração completa em até 15 dias. Pedidos sobre dados que tratamos como operadora são encaminhados ao cliente controlador, e executamos a decisão dele. Alguns dados precisam ser conservados por obrigação legal mesmo após o pedido; nesse caso informamos o motivo e o prazo.

Se você aparece numa nota fiscal guardada aqui, por exemplo como destinatário pessoa física de uma NF-e, o controlador é o cliente que importou ou recebeu a nota. Encaminhamos o seu pedido a ele e executamos o que ele decidir. A nota é um documento fiscal autorizado pelo fisco: não alteramos o seu conteúdo, e uma correção só pode vir de quem a emitiu, pelos meios do fisco. Enquanto durar a guarda fiscal da seção 5, a nota não é apagada a pedido; ela sai no expurgo ao fim da guarda.

## 8. Segurança

Autorização conferida no servidor para cada organização, projeto, empresa e ambiente; chaves de API guardadas só como hash; certificados e senhas cifrados no cofre; registros de log sem corpo de requisição, XML ou credenciais. Nenhuma medida elimina todo risco; incidentes relevantes serão comunicados conforme a lei. As medidas detalhadas estão no anexo técnico da cláusula de operadora, nos termos de uso.

## 9. Alterações

Mudanças nesta política recebem nova versão e data de vigência, publicadas nesta página com o histórico das versões anteriores. Uma mudança que altere o que tratamos, para que, com quem ou por quanto tempo é avisada por e-mail aos Proprietários e Administradores das organizações e no console com pelo menos 30 dias de antecedência. Uma mudança exigida por lei ou por segurança pode valer antes, com aviso. Correções que não mudam o tratamento ficam só no histórico.
