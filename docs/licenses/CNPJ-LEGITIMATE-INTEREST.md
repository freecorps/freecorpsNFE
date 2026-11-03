# Avaliação de legítimo interesse da consulta CNPJ

Registro documental de 21/10/2026, preparado pelo agente a pedido do mantenedor.
Aplica-se à consulta pontual descrita em [REGISTRY.md](../plataforma/REGISTRY.md).
Não registra aceite do mantenedor, parecer jurídico ou autorização da ANPD.

A conclusão é favorável ao legítimo interesse para a conferência cadastral
restrita descrita aqui, com as salvaguardas implementadas e o atendimento
por D02. A Freecorps decide consulta e cache; o cliente decide sobre o cadastro
confirmado. O aviso e as funções desta PR passam a valer na instalação após
publicação. Não se estende a conclusão à distribuição de uma base, prospecção
ou dados sensíveis. Mudanças de escopo exigem novo balanceamento.

## Fonte e método

O [guia da ANPD](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia_legitimo_interesse.pdf),
versão 1.0 de fevereiro de 2024, tem 53 páginas. O anexo fornecido pelo
mantenedor é idêntico ao PDF oficial, conforme o
recibo de comparação.
Usaram-se as três fases das páginas 29 a 33 e as perguntas do Anexo II,
páginas 45 a 52. As páginas 7 a 14 tratam de dados sensíveis e menores;
as páginas 21 a 26, de expectativas, direitos e transparência.

A hipótese examinada é a dos arts. 7º, IX, e 10 da
[LGPD](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm).
As conclusões sobre o produto são inferências desta análise, apoiadas no
código e nas políticas locais. Não são conclusões da ANPD sobre a Freecorps.

## 1. Finalidade e contexto

A organização cadastra uma empresa e solicita a conferência de seu nome,
situação e endereço. O resultado permite identificar divergências e escolher
se aplica nome e/ou endereço ao cadastro usado no trabalho fiscal. O
benefício concreto é reduzir erro de digitação e manter uma referência de
conferência. Não se toma decisão de crédito ou elegibilidade automaticamente.

Desde 31/10/2026, owner ou admin também pode consultar um CNPJ antes de
cadastrar a empresa, para preencher o cadastro e revisá-lo antes de
confirmar. Os dados, a fonte, o cache e seus prazos são os mesmos. Se a
empresa não chega a ser cadastrada, resta só o cache global e o registro da
consulta (organização, CNPJ, autor e datas, sem dado cadastral), apagado em
24 horas.

O interesse imediato é da organização cliente na qualidade do cadastro.
O cadastro confirmado é tratado pela Freecorps em nome desse cliente,
conforme [RIGHTS.md](../plataforma/RIGHTS.md). O cache por provedor+CNPJ é
reutilizado entre clientes e tem fonte, campos,
prazo e finalidade definidos pela Freecorps. A análise enquadra a Freecorps
como controladora dessa etapa, conforme as decisões efetivamente exercidas,
sem alterar seu papel de operadora do cadastro confirmado. Esse enquadramento
consta do aviso público e do procedimento de atendimento.

Os dados são CNPJ, razão social, situação cadastral, endereço e metadados da
consulta. Nome e endereço de empresário individual podem identificar pessoa
natural ou sua residência. A análise cobre esses casos, sem presumir que
todo dado de CNPJ é apenas dado de pessoa jurídica.

Não há finalidade de tratar dados sensíveis ou identificar menores. O modelo
não contém idade e não comprova ausência desses titulares. Dados sensíveis
incidentais e casos que envolvam menores exigem avaliação específica; a
presente conclusão não os autoriza por extensão. Não se deve coletar idade
ou QSA apenas para preencher este teste.

## 2. Necessidade e alternativas

| Dado ou operação             | Necessidade para a conferência e limite                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| CNPJ                         | Identifica a empresa consultada e deve coincidir com a empresa acessível ao solicitante.                                                        |
| Razão social e situação      | Permitem comparar identidade cadastral e situação publicada; não comprovam regularidade fiscal atual.                                           |
| Endereço completo            | Permite conferir os campos do cadastro, inclusive número e complemento. Pode revelar residência, por isso fica restrito ao contexto da empresa. |
| Origem, datas e versão local | Explicam a procedência e a idade do resultado. Data de consulta não é data de atualização da Receita.                                           |
| Cache temporário             | Evita consultas externas repetidas. Reuso e prazo não legitimam outras finalidades.                                                             |
| Histórico de aplicação       | Permite identificar o que foi confirmado, os valores anteriores, quem confirmou e quando. Permanece com a empresa, não pelo prazo do cache.     |

O preenchimento manual já existe e evita a consulta ao terceiro. Ele atende
ao cadastro, mas não realiza a mesma comparação com a fonte externa. A
consulta é uma ação específica; o GET apenas lê o cache. Uma consulta só de
nome/situação seria menos intrusiva, mas não atenderia à conferência de
endereço. Essa justificativa vale para a funcionalidade atual e deve ser
revista se os campos deixarem de ser necessários.

O adapter pede `datasets=receita`, recebe e decodifica o JSON em memória e
seleciona os campos. Não persiste payload bruto, QSA, telefone ou e-mail.
Isso é minimização da persistência e da resposta da plataforma, não prova de
que o provedor jamais envia outros dados. A recepção transitória também é
tratamento e deve ser reduzida se a fonte oferecer projeção mais restrita.

Conforme [REGISTRY.md](../plataforma/REGISTRY.md) e
[RETENTION.md](../plataforma/RETENTION.md), o cache positivo vale 24 horas e
tem expurgo em até 30 dias desde a consulta bem-sucedida; erros não renovam
os dados anteriores. Nome/endereço confirmados e seu histórico ficam com a
empresa. A política de encerramento exclui a classe cadastral após a janela
de 30 dias de exportação e até 7 dias de execução. Esses prazos são escolhas
operacionais do projeto, não uma exigência da licença ou uma aprovação da ANPD.
Pedidos de titulares precisam considerar separadamente cache, cadastro,
histórico e cópias, sem estender automaticamente a guarda dos XML a todos eles.

## 3. Balanceamento e salvaguardas

É razoável esperar conferência cadastral por quem administra a empresa,
considerando a finalidade comercial do cadastro publicado. Essa expectativa
fica mais fraca quando o endereço é residencial ou quando o solicitante não
tem relação legítima com a empresa. Publicação pela Receita não equivale a
consentimento do titular. A origem pública é um fator do teste, não dispensa
os limites de finalidade, necessidade e direitos.

| Risco concreto                                                | Salvaguarda e limite observado                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exposição de endereço residencial a terceiro                  | Leitura exige acesso à empresa no console ou concessão/escopo na API. O cache compartilhado não torna a consulta pública. Porém, cadastrar a empresa é uma declaração do cliente; não foi encontrada nessa entrada comprovação de representação da pessoa jurídica.                                                                                                      |
| Consulta sistemática de empresas sem relação com o cliente    | Consulta exige empresa cadastrada com o mesmo CNPJ ou, antes do cadastro, papel owner/admin; vale o limite de dez solicitações por organização e minuto, a cota do plano e o limite global. Essas medidas dificultam abuso; não provam que um cliente autorizado nunca consulte CNPJs de terceiros, e a consulta antes do cadastro dispensa até a declaração da empresa. |
| Aplicação de informação incorreta ou antiga                   | Origem, estado e datas são expostos. Owner/admin seleciona os campos; o servidor confere versões e cache vigente. Ausência na fonte não prova inexistência da empresa.                                                                                                                                                                                                   |
| Retenção desnecessária de endereços anteriores                | Cache tem expurgo; valores confirmados e histórico acompanham a empresa. A necessidade de manter o histórico e os pedidos de correção/exclusão precisam ser tratados por classe.                                                                                                                                                                                         |
| Reaparecimento de dado cuja exclusão ou oposição foi deferida | Expirar o cache não impede nova consulta ao provedor. O procedimento CNPJ grava restrição global persistente, elimina cache, impede novas chamadas e descarta respostas em trânsito. A liberação exige nova decisão; não há reativação por expiração do cache.                                                                                                           |
| Falta de conhecimento ou de atendimento ao titular            | O projeto tem roteiro D02 e caixa implementada. O roteiro operacional comprova ativação e ensaio do responsável em 21/10, 16:47 UTC. O texto antigo de RIGHTS estava desatualizado. O aviso público CNPJ acompanha esta entrega; o primeiro acesso do substituto não está comprovado.                                                                                    |
| Compartilhamento com o provedor e infraestrutura              | O request transmite CNPJ ao OpenCNPJ e usa a infraestrutura da plataforma. O inventário D03 existente registra os destinos e as retenções conferidos. O aviso informa OpenCNPJ, Cloudflare e Convex. Regiões e mecanismos contratuais de eventual transferência internacional seguem a revisão geral da instalação; esta PR não introduz novo provedor ou destino.       |

O impacto da projeção é menor que o de divulgar uma base completa, mas não
é nulo. O benefício da conferência sustenta o recorte de dados; não justifica
prospecção comercial, enriquecimento de perfis pessoais ou publicação de
endereços. Esses usos exigiriam outra avaliação e não estão incluídos.

## Resultado e ações verificáveis

O benefício da conferência é compatível com o contexto cadastral. A consulta
pontual, o acesso limitado, a confirmação humana, o cadastro manual disponível
e a possibilidade de impedir novas coletas reduzem a interferência sobre o
titular. A existência de endereço residencial torna necessários os limites
de acesso e finalidade; não se autoriza sua publicação ou uso em prospecção.
A declaração de empresa pelo cliente não prova representação, por isso o
procedimento exige examinar a relação e o escopo em pedidos ou abuso.

O [procedimento CNPJ](../operacao/cnpj-direitos.md) define correção, oposição,
expurgo de histórico e reaplicação após restore. A caixa está operacional,
conforme o [ensaio existente](../operacao/privacidade-email.md#ensaio-pelo-console-em-21102026-1647-utc).
O aviso em `apps/docs/content/docs/privacidade-cnpj.mdx` informa finalidade,
campos, origem, papéis, destinatários, prazos e direitos sem exigir login.
Os testes exercitam os controles com dados sintéticos. A publicação desse
aviso e das novas funções depende do merge e deploy; o teste não antecipa
que a instalação já executa o código desta branch.

Persistem riscos de abuso por cliente autorizado, desatualização da fonte e
cópias conservadas em backup. D02 trata pedidos concretos e D05 exige reaplicar
as decisões antes de restabelecer acesso. O acompanhamento geral de provedores,
transferências e contrato de operadora continua em D03/D06, sem transformar
esta pesquisa de fontes no aceite da entrega que publica esse uso. Não há pedido ao
Fala.BR ou homologação prévia da ANPD a obter para concluir esta PR.

Este teste pode integrar o registro de operações. Não é um RIPD nem demonstra
que ele é dispensável em qualquer ampliação. Reavaliar ao mudar fonte, campos,
finalidade, público, escala, compartilhamento ou retenção, e diante de pedido
ou incidente que altere as premissas.

## Ampliação de 31/10/2026

A consulta antes do cadastro (#511) mudou o público e o momento da consulta:
owner ou admin consulta um CNPJ que a organização ainda não cadastrou. A
finalidade continua sendo o cadastro da empresa administrada pelo cliente, com
os mesmos campos, fonte, cache, prazos, restrição e confirmação humana. O
risco de consulta sem relação com o cliente aumenta, porque não há declaração
prévia da empresa; os limites de papel, frequência e cota são a salvaguarda
adotada. Como o cache é global, a situação da consulta pode indicar que outra
organização consultou o mesmo CNPJ há pouco (chamada em andamento ou data da
última resposta); nenhum dado ou identidade dessa organização é exposto.
O mantenedor confirmou a ampliação em 31/10/2026, no PR #679.

## Conferência desta rodada

Foram lidos o contrato em `packages/contracts/src/registry.ts`, o adapter
`platform/convex/lib/registryProvider.ts`, as entradas `registry.ts` e
`registryRest.ts`, a criação de empresa em `companies.ts` e o controle de
acesso em `lib/companyAccess.ts`, além das políticas vinculadas. A pesquisa
não consultou CNPJ real nem acessou produção. A implementação
foi exercitada por testes sintéticos de restrição, fila, concorrência e expurgo
do histórico. O ensaio externo da caixa é a prova anterior vinculada acima;
não foi repetido nem estendido por inferência ao novo código. As evidências
antigas de runtime conservam suas próprias datas e limites.
