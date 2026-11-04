## Termos de uso do freecorpsNFE

Versão 1.2, publicada em 4 de novembro de 2026. Para uma organização criada a partir dessa data, vale desde o aceite no console. Para uma organização que já existia, vale desde o aceite ou a partir de 4 de dezembro de 2026, o que vier antes.

Estes termos se aplicam ao console em https://nfe.freecorps.com.br e à API em https://api.nfe.freecorps.com.br, operados por FREECORPS TECNOLOGIA DA INFORMACAO LTDA, CNPJ 63.113.119/0001-90 ("Freecorps"). O uso do código em infraestrutura própria segue a licença do repositório, não estes termos.

## Contratação

O cliente contrata no console. Ao criar a organização, e de novo a cada versão destes termos, um Proprietário lê e aceita estes termos e a cláusula de operadora, que é parte deles e vem no fim deste texto, e declara que pode representar a organização. A Freecorps registra quem aceitou, quando, a versão e o SHA-256 do texto aceito. Um contrato assinado à parte só existe quando as partes o combinarem, por exemplo no plano Personalizado, e prevalece no que disser de diferente.

## 1. O serviço

O freecorpsNFE guarda e organiza documentos fiscais eletrônicos para o software do cliente. Hoje ele:

- importa XML de NF-e modelo 55, preserva o arquivo original e entrega o documento normalizado, com itens e eventos, pelo console, pela API REST e pelo SDK TypeScript. As NFS-e importadas de lotes no padrão ABRASF até 2 de novembro de 2026 continuam disponíveis para leitura, download e exportação;
- valida a estrutura técnica do XML. Validar não comprova que a nota foi autorizada pelo fisco;
- consulta referências fiscais, como municípios e NCM, e o cadastro de CNPJ;
- guarda certificados A1 cifrados num cofre;
- notifica o sistema do cliente por webhooks assinados, com novas tentativas;
- exporta os documentos da organização;
- mede o consumo e aplica as cotas do plano;
- emite NFS-e só em sandbox, com transporte simulado e sem validade fiscal;
- consulta a distribuição de NF-e da Receita, em produção, para as empresas que ativam a captura fiscal no console, sob os termos próprios da captura, que a empresa aceita ao ativá-la.

Não fazem parte do serviço: emissão de nota com validade fiscal, cálculo de tributos, manifestação do destinatário, captura de NFS-e e de NFC-e, e escrituração ou guarda fiscal no lugar do cliente.

## 2. Ambientes

Cada empresa tem o ambiente Sandbox, sem efeito fiscal. O ambiente Produção existe só para a empresa que ativou a captura fiscal e cobre apenas os documentos recebidos por ela. Nada do Sandbox aparece em Produção, e o inverso também não. Uma chave de API vale para os ambientes que a organização lhe concedeu.

## 3. Conta, organização e acesso

A conta é pessoal e exige e-mail verificado. O cliente é a organização; cada membro tem um papel (Proprietário, Administrador, Desenvolvedor, Operador ou Leitura) que limita o que ele faz. As chaves de API pertencem a um projeto e só alcançam as empresas e os escopos concedidos. O cliente guarda as próprias chaves e senhas e responde pelo que for feito com elas. A Freecorps guarda só o hash de cada chave e não consegue mostrá-la de novo.

## 4. Obrigações do cliente

- Enviar e capturar só documentos e certificados de empresas que ele representa ou que o autorizaram.
- Ter base legal para os dados pessoais contidos nos documentos que envia ou recebe; nesses dados, o cliente é o controlador e a Freecorps a operadora, como diz a cláusula de operadora.
- Cumprir as próprias obrigações fiscais. A Freecorps guarda os documentos em favor do cliente, mas não substitui a escrituração, o contador nem a conferência no fisco.
- Respeitar os limites de uso. Uma chamada acima do limite recebe recusa e pode ser repetida depois; contornar os limites não é permitido.
- Não usar o serviço para atacar, sobrecarregar ou testar a segurança de outros clientes ou da Freecorps sem autorização. Falhas de segurança são comunicadas pelo canal de segurança indicado no repositório do projeto.

## 5. Plano, cotas e preço

Cada organização usa o plano que tiver: o Gratuito, um plano pago contratado no console ou um plano atribuído pela Freecorps, como o Personalizado. O plano define as cotas mensais de importação, notas, captura, consulta de CNPJ, bytes e entregas de webhook. No Gratuito, o mês das cotas é o mês civil, no horário UTC; nos planos pagos, é o mês da assinatura, descrito na seção 5A. Atingida uma cota, o serviço recusa novas operações daquela unidade até o mês seguinte ou até a mudança do plano; o que já foi aceito termina, e nada é apagado.

A Freecorps oferece os planos no console aos poucos, conforme a capacidade. Enquanto um plano não estiver à venda no console, ele não pode ser contratado. Uma organização sem plano fica em medição: usa o serviço sem cota comercial, exceto a captura em Produção, que exige plano vigente com cotas, inclusive o Gratuito. Sem esse plano, novas consultas da captura não são feitas, e os documentos já recebidos continuam disponíveis. O preço, as cotas e as condições de cada plano são os que o console mostra no momento da contratação.

O plano Gratuito não tem prazo de teste. O saldo não usado de um mês não acumula. Ao atingir uma cota, a organização espera o mês seguinte ou contrata mais capacidade; não há cobrança nem mudança automática para um plano pago.

O plano Gratuito não pode ser multiplicado pelo mesmo beneficiário, ou por empresas sob controle comum, para contornar limites ou substituir um plano pago. Isso inclui dividir três CNPJs próprios entre três contas ou organizações gratuitas para evitar um plano que contemple as três empresas. Usar e-mails ou titulares de conta diferentes não afasta essa regra quando a finalidade é acumular franquias gratuitas para o mesmo beneficiário.

A análise de possível abuso é individual, com oportunidade de esclarecimento; compartilhar contador, prestador ou IP não basta para caracterizá-lo. A Freecorps avisa o Proprietário por e-mail, com os indícios, e ele tem 10 dias para esclarecer; a resposta da Freecorps é fundamentada e sai em até 5 dias úteis. Confirmado o fracionamento, a organização tem 30 dias para contratar um plano compatível, sem cobrança automática nem exclusão de documentos. Sem isso, o benefício gratuito das organizações envolvidas pode ser restrito às cotas de uma só, sem apagar documentos nem reduzir a guarda.

## 5A. Cobrança

Esta seção vale para os planos pagos quando estiverem à venda no console. Os planos pagos são pré-pagos, por cartão de crédito, e podem ser mensais ou anuais, conforme o que o console oferecer. O pagamento é processado pela Stripe; a Freecorps não recebe o número do cartão.

Mês da assinatura. O plano pago começa na data e hora da contratação, no horário UTC. Cada mês da assinatura vai dessa data e hora até o mesmo dia e hora do mês seguinte; num mês mais curto, termina no último dia dele, e o mês seguinte volta ao dia da contratação. As cotas do plano pago renovam no início de cada mês da assinatura. Por exemplo, um plano contratado em 18 de novembro às 14:30 UTC tem as cotas renovadas todo dia 18, às 14:30 UTC.

Plano mensal:

- Primeira mensalidade. É cobrada na contratação, integral, e concede as cotas do primeiro mês da assinatura.
- Renovação. A assinatura renova sozinha a cada mês da assinatura, pelo valor do plano, até ser cancelada.
- Mudança de plano. Subir de plano cobra na hora a diferença integral entre as mensalidades, sem proporção pelos dias restantes, e amplia as cotas do mês da assinatura em curso; a data de renovação não muda. Descer vale na renovação seguinte, se o uso couber no plano menor.
- Cancelamento. Cancelar impede a próxima renovação, sem multa nem permanência mínima. O mês pago continua valendo até o fim e não é reembolsado em parte.

Plano anual:

- Preço e período. O anual é pago de uma vez, pelo preço anual mostrado no console, e vale por 12 meses da assinatura, da data e hora da contratação até a mesma data e hora do ano seguinte.
- Início. O anual é cobrado na contratação e começa na hora. Quem tem um plano mensal por cartão desliga antes a renovação dele; o mês mensal já pago não é descontado do anual.
- Renovação. O anual renova sozinho por mais 12 meses na data de aniversário da contratação, pelo preço anual do plano, até o cliente escolher não renovar.
- Upgrade. O Intermediário anual sobe para o Grande anual no meio do período. O cliente paga a diferença entre os dois preços anuais, dividida por 12, por mês restante do período, com o mês da assinatura em curso contado inteiro. As cotas do Grande valem desde o mês em curso, a data de renovação não muda, e a renovação passa a ser do Grande anual. O upgrade é recusado nas últimas 72 horas do período.
- Downgrade. Vale só na renovação, sem reembolso.
- Não renovar. O cliente desliga a renovação no console a qualquer momento, sem reembolso. Os meses pagos continuam valendo até o fim do período.
- Rescindir. O cliente pede a rescisão pelo suporte. A Freecorps calcula o reembolso e o devolve no cartão, pela Stripe. Com um anual em vigor, a organização só é encerrada depois da rescisão.
- Arrependimento. Até 7 dias depois de cada cobrança anual, inclusive de uma renovação, a rescisão devolve tudo o que foi pago pelo período, e o acesso ao plano termina na hora. O mesmo vale para a cobrança de um upgrade, contada da data em que ele foi pago: desfeito nesse prazo, ela volta inteira, e o período e a renovação voltam ao Intermediário.
- Reembolso depois dos 7 dias. É o total pago pelo período menos os meses da assinatura já usados, o em curso contado inteiro, cada um pelo preço mensal cheio do plano em vigor naquele mês, nunca negativo. O acesso vai até o fim do mês da assinatura em curso. Por exemplo, com o Intermediário anual a R$ 1.490 e o mensal a R$ 149, a rescisão no 4º mês devolve R$ 894, e a partir do 10º mês não há reembolso. Quem rescinde perde o desconto do anual.

Regras comuns:

- Encerramento da organização. Sem anual em vigor, encerrar a organização cancela a assinatura na hora, sem devolver o mês pago. Cancelar o plano não encerra a organização.
- Falha de pagamento. Não há carência. Se a renovação não for paga, o plano vence no fim do período pago: novas entradas param, e a leitura, a exportação, os pedidos de titulares e a guarda dos documentos continuam. O console mostra a cobrança em aberto, e a Stripe tenta de novo. Pago dentro do primeiro mês da assinatura do novo período, o plano volta até o fim desse período, sem desconto pelos dias parados e sem mudar a data de renovação. Esgotadas as novas tentativas, a assinatura é cancelada.
- Reembolso. Cobrança em duplicidade ou indevida é devolvida inteira, no cartão, em até 10 dias úteis depois de confirmada pela equipe da Freecorps. Fora disso e do que esta seção prevê para o anual, o que foi pago não é devolvido, salvo o que a lei exigir. Todo reembolso é feito por uma pessoa da equipe, nunca automaticamente.
- Contestação. O cliente contesta uma cobrança pelo suporte em até 90 dias; a resposta sai em até 10 dias úteis. Uma contestação aberta direto no cartão, sem passar pelo suporte, não muda o plano sozinha: a equipe da Freecorps a analisa e pode suspender o plano pago até ela se resolver; o valor estornado sem razão continua devido.
- Reajuste. O preço pode ser reajustado uma vez por ano, com aviso de 30 dias. Quem não aceitar cancela ou não renova antes da data, sem multa. O reajuste não muda o preço de um anual já pago.

A cobrança da Freecorps não tem relação com a conexão Stripe que os apps consumidores usam para os próprios pagamentos.

## 6. Disponibilidade e suporte

A Freecorps opera o serviço com cópia de backup cifrada a cada 12 horas e procedimento de restauração ensaiado, mas não oferece acordo de nível de serviço. O serviço depende de provedores de infraestrutura e, na captura fiscal, da Receita: indisponibilidade, bloqueio por consumo indevido ou atraso da fonte não são falhas da Freecorps. Uma operação sem resposta não prova falha; a plataforma reconcilia antes de repetir.

O suporte atende por suporte@nfe.freecorps.com.br e responde assim que possível, sem prazo garantido, salvo os prazos destes termos. Pedidos sobre dados pessoais vão para privacidade@nfe.freecorps.com.br. Uma manutenção programada que interrompa o serviço é avisada por e-mail aos Proprietários e Administradores com pelo menos 48 horas de antecedência e feita, quando possível, fora do horário comercial. Uma manutenção de emergência é avisada assim que possível.

## 7. Dados e privacidade

O tratamento de dados pessoais segue a política de privacidade publicada em https://nfe.freecorps.com.br/privacidade, que traz os prazos de guarda de cada dado.

## 8. Suspensão

A Freecorps pode recusar operações acima dos limites e suspender a captura fiscal de uma empresa, sem apagar o que já foi recebido. A Freecorps também pode suspender uma organização, uma conta, uma chave de API ou a captura fiscal de uma empresa por:

- fraude, uso ilegal ou uso de documentos e certificados sem autorização;
- risco à segurança do serviço, de outros clientes ou da Freecorps, incluindo ataque, sobrecarga ou tentativa de contornar limites;
- ordem de autoridade ou bloqueio pela Receita;
- dados cadastrais falsos;
- violação destes termos depois de aviso sem correção.

Nos três primeiros casos a suspensão pode ser imediata. Nos outros, a Freecorps avisa o Proprietário por e-mail, com o motivo, e dá 5 dias para corrigir. Em todos, o Proprietário pode contestar pelo suporte em até 10 dias; a resposta é fundamentada e sai em até 5 dias úteis. Durante a suspensão, os documentos continuam guardados e, salvo ordem de autoridade ou risco de segurança, disponíveis para leitura e exportação. A falta de pagamento segue a seção 5A.

## 9. Encerramento e arquivamento

O Proprietário encerra a organização no console. O encerramento bloqueia novas operações e revoga chaves e integrações na hora. Durante 30 dias, Proprietários e Administradores podem exportar os dados. Depois, cadastros, membros, certificados, chaves e integrações são apagados em até 7 dias, e os documentos fiscais ficam guardados até 31 de dezembro do quinto ano seguinte ao do encerramento, em favor do cliente, e então são apagados. Se a organização nunca teve dados de Produção, só do Sandbox, sem efeito fiscal, não há guarda: esses dados são apagados logo depois dos cadastros, salvo retenção legal. A conta de cada pessoa não sai com a organização; a pessoa a exclui em Minha conta.

A Freecorps pode encerrar a organização:

- sem motivo, com aviso de 30 dias e devolução da parte não usada do período já pago;
- por violação grave destes termos não corrigida, depois da suspensão e da contestação da seção 8;
- por falta de pagamento, quando a organização tiver ficado 60 dias sem plano pago e com uso acima do que o plano gratuito permite, com aviso de 30 dias.

O encerramento pela Freecorps segue as mesmas regras do encerramento pelo cliente: 30 dias para exportar e guarda dos documentos fiscais.

Os dois parágrafos seguintes valem quando a Freecorps ativar o arquivamento de organizações inativas, com aviso aos clientes. Até lá, nenhuma organização é arquivada nem encerrada por inatividade.

Arquivamento de organização inativa. A organização continua aberta, mas a Freecorps pode arquivá-la quando ficar 90 dias sem atividade no plano gratuito, ou quando o período pago terminar sem renovação. Antes, avisa por e-mail os Proprietários e Administradores e mostra o aviso no console, com 30 dias de antecedência. Nesse prazo, no gratuito, um Proprietário ou Administrador mantém a organização ativa no próprio aviso; no plano pago, basta renovar. Arquivada, a organização fica só para leitura: param importação, captura e emissão, e os documentos fiscais vão para uma guarda fria cifrada. O Proprietário pode pedir pelo suporte uma exportação assistida dos documentos fiscais, entregue por download com prazo, sem custo, no máximo uma vez a cada 30 dias, salvo pedidos de titulares de dados. A reativação é possível, mas não é imediata. Enquanto a organização estiver arquivada, a captura de NF-e fica parada, e a Receita só disponibiliza os documentos por tempo limitado: alguns podem não estar mais disponíveis na volta. O arquivamento nunca encurta a guarda dos documentos fiscais.

Organização só com Sandbox. Uma organização que nunca teve dados de Produção e fica 90 dias sem atividade é encerrada pela Freecorps, depois de aviso de 30 dias por e-mail aos Proprietários e Administradores e no console, onde eles podem mantê-la ativa. Os dados do Sandbox não têm validade fiscal e são apagados depois do encerramento; a conta de cada pessoa continua.

## 10. Responsabilidade

O serviço é prestado como descrito na seção 1. A Freecorps não garante que ele funcione sem interrupção ou sem erro, nem que um documento validado foi autorizado pelo fisco. Ela não responde por falha, indisponibilidade, bloqueio ou atraso da Receita, das prefeituras, do Ambiente Nacional ou de outras fontes, nem por documentos, certificados e dados que o cliente envia.

A responsabilidade total da Freecorps perante o cliente, por qualquer causa ligada a estes termos, fica limitada ao que o cliente pagou à Freecorps nos 12 meses anteriores ao fato. A Freecorps não responde por lucros cessantes, perda de chance nem danos indiretos. Esses limites não valem para dolo ou culpa grave, nem onde a lei não permitir limitar.

O cliente indeniza a Freecorps pelo que ela tiver de pagar a terceiros por causa de uso ilícito do serviço pelo cliente ou de documentos, certificados e dados que ele enviou sem autorização.

## 11. Alterações

Uma mudança destes termos recebe nova versão e data de vigência, e é avisada por e-mail aos Proprietários e Administradores e no console com pelo menos 30 dias de antecedência. Uma mudança exigida por lei ou por segurança pode valer antes, com aviso. O Proprietário aceita a versão nova no console. Quem não aceitar pode cancelar o plano ou encerrar a organização antes da vigência, sem multa e com devolução da parte não usada do período pago. Depois da vigência, enquanto a versão nova não for aceita, a organização mantém a leitura, a exportação e os pedidos de titulares, mas não cria operações novas.

## 12. Lei e foro

Estes termos seguem a lei brasileira. Fica eleito o foro da comarca de Campinas/SP, sede da Freecorps, com renúncia a qualquer outro.

## Cláusula de operadora

Esta cláusula é parte dos termos de uso e trata dos dados pessoais que a Freecorps trata em nome do cliente.

1 · Partes e papéis. O cliente, a organização cadastrada no freecorpsNFE, é o controlador dos dados pessoais contidos nos documentos fiscais e nos cadastros que ele envia ou que a plataforma recebe em nome dele. A Freecorps é a operadora desses dados e os trata em nome do cliente, conforme a LGPD, arts. 37 a 40. Esta cláusula vale enquanto a Freecorps tratar esses dados, inclusive durante a guarda depois do encerramento.

2 · Objeto. A Freecorps importa, recebe pela captura fiscal, guarda, normaliza, mostra, exporta e notifica documentos fiscais (NF-e modelo 55 e NFS-e), e guarda os certificados A1 e cadastros de empresas que o cliente envia, para prestar o serviço descrito nestes termos.

3 · Instruções do cliente. As instruções do cliente são este contrato e o que ele configura no produto: empresas, certificados, captura fiscal e seu intervalo, projetos, chaves de API, concessões, webhooks, exportações e encerramento da organização. A Freecorps não usa os dados para outra finalidade, não os vende e não os entrega a outro cliente. Uma instrução que o produto não executa, por exemplo apagar uma nota avulsa, é pedida por escrito pelo suporte. A Freecorps responde em até 5 dias úteis se pode executá-la, em que prazo e a que custo, ou por que não pode. A Freecorps avisa o cliente e não executa uma instrução que entenda contrária à lei.

4 · Dados e titulares. Documentos fiscais com seus XML originais, eventos e itens; dados das partes das notas, inclusive pessoas físicas, com nome, CPF e endereço quando declarados; cadastros de empresas; certificados A1 e suas senhas. Titulares: emitentes, destinatários, tomadores, transportadores e outras pessoas citadas nas notas, e representantes das empresas do cliente.

5 · Pessoas com acesso. Fora do produto, o banco só é acessado pelo painel do deployment, restrito a quem opera a instalação, para operar, recuperar ou atender um pedido registrado. Toda pessoa da Freecorps ou de prestador que possa ver esses dados está sob dever de sigilo por contrato, que continua depois que ela deixa a função.

6 · Segurança. Autorização conferida no servidor a cada leitura e escrita, por organização, projeto, empresa e ambiente; chaves de API guardadas só como hash; certificados e senhas cifrados no cofre, fora de logs e telemetria; logs sem corpo de requisição, XML ou credenciais; cópia de backup cifrada fora do provedor do banco. O anexo técnico abaixo detalha essas medidas; uma atualização dele pode trocar uma medida por outra equivalente, mas não reduzir a proteção.

7 · Suboperadores. A Freecorps usa provedores de infraestrutura que tratam os dados em nome dela: Convex, para banco, arquivos e funções; Cloudflare, para os Workers, o e-mail e a cópia externa cifrada do backup; e Blacksmith, para a execução dos jobs, incluindo o processamento transitório do backup. A lista fica publicada com a política de privacidade. A Freecorps avisa os clientes por e-mail com 30 dias de antecedência antes de incluir ou trocar um suboperador. O cliente pode se opor, com motivo, em até 15 dias; se as partes não chegarem a uma solução, o cliente pode encerrar a organização sem multa, com devolução da parte não usada do período pago.

8 · Transferência internacional. Alguns suboperadores tratam os dados fora do Brasil. A transferência se apoia no art. 33 da LGPD, com as cláusulas-padrão contratuais aprovadas pela Resolução CD/ANPD nº 19/2024 ou outro mecanismo que a ANPD reconheça. O banco e os arquivos ficam nos Estados Unidos (Convex, na AWS, região us-east-1); a cópia de backup, no leste da América do Norte (Cloudflare R2); os jobs rodam nos Estados Unidos (Blacksmith, Phoenix); e as requisições passam pela rede global da Cloudflare.

9 · Pedidos de titulares. A Freecorps encaminha ao cliente, sem copiar o dado, os pedidos que receber sobre dados que trata em nome dele, e executa a decisão do cliente pelos fluxos do produto.

10 · Incidentes. A Freecorps avisa o cliente de incidente de segurança que possa acarretar risco ou dano relevante aos titulares em até 48 horas depois de tomar conhecimento, para que ele cumpra a LGPD, art. 48. O aviso diz o que se sabe: a natureza dos dados e dos titulares afetados, as medidas de segurança usadas, os riscos e o que foi feito ou será feito para reduzi-los. O que faltar segue assim que for apurado.

11 · Guarda e fim do tratamento. Enquanto a organização existir, os documentos fiscais ficam guardados. No encerramento, o cliente tem 30 dias para exportar; depois, cadastros, certificados, chaves e integrações saem em até 7 dias. Documentos fiscais, originais e a auditoria das operações ficam guardados até 31 de dezembro do quinto ano seguinte ao do encerramento, em favor do cliente, que tem a obrigação fiscal de guardá-los (LGPD, art. 16, I), e depois são apagados. Se a organização nunca teve dados de Produção, não há obrigação fiscal a cumprir: os dados do Sandbox são apagados logo depois dos cadastros, salvo retenção legal. Fiscalização, processo ou pedido formal de autoridade pode exigir guardar por mais tempo. Cópias de backup saem quando cada cópia expira. O cliente pode pedir, pelo suporte, que os documentos fiscais encerrados sejam apagados antes do fim da guarda, desde que declare que já os exportou e que assume a obrigação de guardá-los. A Freecorps apaga em até 15 dias depois da confirmação; o que a Freecorps precisa guardar por obrigação própria, ou por retenção legal ativa, fica bloqueado até o fim do prazo.

12 · Registros e informação. A Freecorps mantém o registro das operações que faz em nome do cliente: a auditoria das operações, da captura e do cofre de certificados. A exportação entrega os documentos e originais, não essa auditoria. O cliente pede esses registros pelo suporte, e a Freecorps os entrega em até 15 dias. Para comprovar o cumprimento desta cláusula, a Freecorps responde a questionários e entrega a documentação das medidas de segurança. Uma auditoria pelo cliente ou por terceiro indicado por ele, sob sigilo, cabe uma vez a cada 12 meses, ou depois de um incidente ou de pedido da ANPD, com 30 dias de aviso, em horário comercial e sem acesso a dados de outros clientes; o custo é do cliente.

13 · Responsabilidade, vigência e foro. Seguem os termos de uso. As obrigações de sigilo, segurança e apagamento continuam enquanto a Freecorps guardar os dados.

## Anexo técnico: medidas de segurança

- Acesso pelo produto: autorização no servidor por organização, projeto, empresa e ambiente, e papéis por membro.
- Chaves de API: só o hash é guardado; cada chave tem escopo, ambiente e concessão por empresa.
- Certificados A1 e senhas: cifrados no cofre, fora de logs e telemetria.
- Criptografia em trânsito: HTTPS em todo acesso ao console, à API e entre os provedores, com TLS 1.3 e HSTS no console e na API; um acesso por HTTP é redirecionado para HTTPS.
- Registros: auditoria das operações, da captura e do cofre; logs sem corpo de requisição, XML ou credenciais.
- Backup: cópia cifrada a cada 12 horas fora do provedor do banco, com restauração ensaiada.
- Acesso administrativo: painel do deployment restrito a quem opera a instalação; publicação só pelo processo de integração contínua.
- Incidentes: canal de segurança, parada geral da captura e aviso ao cliente em 48 horas.
