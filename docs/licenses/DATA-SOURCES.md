# Fundamento e atribuição de IBGE, NCM e OpenCNPJ

Pesquisa de 21/10/2026 para a #83, sem pedido pelo Fala.BR nem contato com
os fornecedores. Substitui a exigência de obter respostas formais registrada
em [DISTRIBUTION.md](DISTRIBUTION.md). A conclusão documental é que existe
fundamento legal para o reuso dos dados cadastrais e normativos descritos
abaixo, inclusive no serviço comercial. Não depende de atribuir uma licença
MIT ou Creative Commons que a fonte não declarou para esse material.

Esta análise escolhe o fundamento e os créditos. Não é parecer jurídico nem
aceite de release. A captura fornecida pelo mantenedor confirma o rótulo
Creative Commons Attribution do CNPJ; a versão da licença não está visível.
A [avaliação de legítimo interesse](CNPJ-LEGITIMATE-INTEREST.md) aplica o guia
da ANPD ao serviço e registra a implementação de atendimento e restrição preparada nesta entrega.

## Fundamento escolhido

O [Decreto 8.777/2016, arts. 1º a 4º][dados-abertos], abrange a administração
federal direta, autárquica e fundacional, prevê reuso das bases abertas e
inclui desenvolvimento de negócios entre seus objetivos. O art. 4º estabelece
livre utilização dos dados disponibilizados pelo Executivo federal. A
[alteração pelo Decreto 9.903/2019][alteracao] autoriza também a utilização
gratuita das bases protegidas cujos direitos patrimoniais sejam da União.
Direitos de terceiros devem ser identificados com suas condições.

A [Lei 9.610/1998][lda], art. 8º, IV e V, exclui da proteção autoral os atos
oficiais e as informações de uso comum, como cadastros. Os arts. 7º, XIII e
§ 2º, distinguem a organização criativa de uma base dos dados que ela contém.
Por isso, a conclusão se limita aos campos cadastrais e textos normativos
usados pela plataforma. Não declara todo produto governamental em domínio
público nem elimina direitos sobre mapas, fotografias, software ou obras de
terceiros.

Os [termos aprovados pela Resolução CGINDA 2/2017][cginda], Anexo I, permitem
uso comercial, adaptação e redistribuição com citação, sujeitos a condições
adicionais do conjunto. Exigem crédito ao Portal Brasileiro de Dados Abertos
e à fonte produtora, sem usar sua logomarca ou sugerir aprovação oficial.
São apoio para o conjunto CNPJ catalogado. Não são tratados como uma licença
CC BY universal de qualquer API federal.

## IBGE: municípios da API de localidades

O objeto é o cadastro de códigos, nomes e UFs retornado pela
[API de localidades][ibge-api]. O snapshot examinado na plataforma tem
5.571 registros e conteúdo `2026-09-30-66817c020c86e184`.
Os hashes completos e a coleta estão no
recibo de 30/09.

Fundamento escolhido: livre utilização dos dados federais e natureza
cadastral desses campos, conforme as normas acima. A seleção e normalização
feitas pela Freecorps não transformam a lista em uma publicação oficial do
IBGE. A versão e a data são do snapshot local; não são vigência oficial de
cada município.

O [termo geral do portal][ibge-termo], versão 1 de 11/03/2024, foi recuperado
no índice de busca da página oficial. Ele descreve serviços, responsabilidades
e tratamento de dados pessoais. Não contém, no texto recuperado, uma licença
específica de redistribuição da API. O acesso HTTP direto respondeu 403;
portanto, não se apresenta uma cópia integral autenticada desse termo.

Foi localizado um contraexemplo relevante: o
[termo da base cartográfica BC250, versão 2017][ibge-bc250], restringe
comercialização e exige autorização escrita. Seu objeto identificado é a
base cartográfica, não a API de localidades. Ele não foi estendido aos
municípios nem declarado revogado. Demonstra por que esta decisão não vale
automaticamente para qualquer produto do IBGE. A
[licença da Agência de Notícias][ibge-noticias] também tem objeto próprio;
não é o fundamento para a lista de municípios.

Texto de atribuição para o snapshot examinado:

> Fonte: IBGE, API de localidades. Coleta em 30/09/2026. Seleção e normalização
> por Freecorps. Versão local 2026-09-30-66817c020c86e184. Sem endosso do IBGE.

Associar o crédito à [documentação da API][ibge-api] e preservar no manifesto
a URL de coleta, a data e os hashes. Em outra coleta, usar os valores dela.
Não atribuir CC BY, CC0 ou MIT ao dataset por inferência.

## NCM: nomenclatura do Siscomex Classif

A [Receita disponibiliza expressamente o JSON][ncm-download], inclusive por
link direto sem CAPTCHA, e informa que ele contém apenas a tabela vigente.
A [Resolução Gecex 272/2021, art. 1º e Anexo I][gecex], é evidência da natureza
normativa da nomenclatura, sujeita a alterações posteriores.

Fundamento escolhido: art. 8º, IV, da Lei 9.610/1998 para o conteúdo de atos
oficiais e art. 4º do Decreto 8.777/2016 para os dados disponibilizados pela
Receita. A aplicação desses dispositivos à projeção é a conclusão desta
análise; não foi encontrada uma licença nominal específica do JSON.
O rodapé CC BY-ND 3.0 do portal não é usado como concessão para o arquivo ou
para a normalização.

O recorte existente tem códigos completos de oito dígitos, descrições e
datas de início/fim. O coletor remove pontos dos códigos e espaços nas
extremidades da descrição, exclui níveis incompletos e representa
`31/12/9999` como fim não informado. Não inclui NESH, alíquotas, comentários
privados ou o software do Classif. Não altera o significado da descrição.

Texto de atribuição para os 10.515 códigos examinados:

> Fonte: Receita Federal do Brasil, Siscomex Classif. NCM vigente na coleta
> de 30/09/2026. Seleção e normalização por Freecorps, versão local
> 2026-09-30-6f0485d0b173a795. Sem NESH ou alíquotas. Sem endosso oficial.

Vincular o aviso à [página de download][ncm-download]; conservar a URL do JSON,
os hashes e a versão informada pela fonte no manifesto. A tabela não certifica
classificação fiscal nem fornece histórico completo.

## OpenCNPJ: serviço e dados da Receita

Foi conferida a revisão `57a3cbef3f5ecdfd7f974f82eb4b1c8f48f58674`, datada de
15/10/2026. O [FAQ][opencnpj-faq] permite uso comercial gratuito; os
[limites][opencnpj-limites] descrevem consulta de CNPJ conhecido em cadastros,
backoffices e integrações. Varreduras e análises massivas devem usar os outros
produtos oferecidos, não uma sequência de consultas na API. A página
[sobre o serviço][opencnpj-sobre] descreve enriquecimento e processamento de
bases públicas. Essas evidências sustentam a integração comercial pontual
existente, sem promessa de SLA ou cota garantida.

A [definição do dataset `receita`][opencnpj-origens] identifica a origem no
catálogo oficial. A própria [Receita classifica o CNPJ como dados abertos][rfb-cadastros]
e seu [link do conjunto][rfb-cnpj] redireciona ao dados.gov.br. O fundamento
escolhido para reutilizar os campos é o regime legal de dados federais e
cadastros, somado às condições do serviço. A [MIT do repositório][opencnpj-mit]
cobre software e documentação associada; não é apresentada como licença da
base da Receita.

### Licença declarada no catálogo e limites da evidência

A [página do conjunto][cnpj-catalogo] entrega uma SPA. O GET de metadados,
identificado no [OpenAPI oficial][catalogo-openapi], respondeu 401 sem
autenticação. Duas leituras pelo navegador também falharam por timeout.
Essas tentativas não confirmaram os metadados. Depois delas, o mantenedor
forneceu uma captura do catálogo
que mostra `Licença: Creative Commons Attribution`. A pendência de identificar
o nome declarado da licença fica resolvida por essa evidência fornecida.

A imagem não mostra a URL da página. A inspeção do JavaScript público
confirmou que a linha de licença interpola apenas `license_title`, sem link.
Não existe nessa linha um texto legal vinculado a recuperar. O endpoint
usado pelo frontend também respondeu 401. A versão e eventuais condições
adicionais não são determináveis por essas evidências.
O campo `Versão: 1` é metadado do conjunto, não prova CC BY 1.0. Registrar
`Creative Commons Attribution, versão não identificada`, sem inventar um
identificador `CC-BY-4.0` ou vincular um texto legal por suposição. A data de
extração de 11/01/2026 e a alteração dos metadados em 09/02/2026 também não
identificam a versão individual servida pelo OpenCNPJ.

A [RedeCNPJ][redecnpj] menciona Creative Commons Atribuição, e um
[registro do AmeriGEOSS][qsa-catalogo] conserva `cc-by` para o conjunto QSA.
São indícios secundários, e QSA é outro conjunto. A captura passa a ser a
evidência do rótulo, sem converter esses indícios em prova de CC BY 4.0.
O fundamento legal acima permanece válido para o recorte analisado; o nome
declarado complementa a documentação de origem.

Texto de atribuição para a consulta existente:

> Fonte dos dados: Receita Federal do Brasil, Cadastro Nacional da Pessoa
> Jurídica, catalogado no Portal Brasileiro de Dados Abertos. Consulta via
> OpenCNPJ, dataset receita. Projeção cadastral por Freecorps. Data da consulta
> informada no resultado; versão individual da fonte não confirmada.
> Licença declarada no catálogo: Creative Commons Attribution, versão não
> identificada. Sem endosso dos órgãos ou do provedor.

Vincular a [Receita][rfb-cadastros], o [catálogo][cnpj-catalogo] e o
[OpenCNPJ][opencnpj]. O contrato atual expõe `provider`, `sourceUrl` e
`consultedAt`; esses campos não equivalem à atribuição completa em qualquer
exportação futura. Não apresentar a data do cache como atualização oficial.

### Dados pessoais e retenção

A [LGPD][lgpd] continua aplicável aos dados que identificam pessoas naturais.
Nome empresarial e endereço de MEI podem ter essa natureza. O art. 7º, § 3º,
exige considerar o contexto da publicidade; não é uma hipótese autônoma de
tratamento. Publicação pela Receita também não equivale automaticamente à
publicação voluntária pelo titular prevista no § 4º.

Para a finalidade restrita de conferir o cadastro de uma empresa declarada
pelo cliente e acessível ao solicitante, a hipótese analisada é legítimo
interesse, arts. 7º, IX, e 10.
Não se assume obrigação legal genérica de consultar OpenCNPJ. Execução de
contrato só se aplica quando seus requisitos concretos estiverem presentes,
inclusive a relação com o titular. O [teste aplicado](CNPJ-LEGITIMATE-INTEREST.md)
registra finalidade, necessidade, balanceamento e salvaguardas a partir do
[guia da ANPD][anpd]. O PDF fornecido corresponde byte a byte ao oficial.
A avaliação diferencia a Freecorps como controladora da consulta/cache e
operadora do cadastro confirmado do cliente. O canal foi ativado e ensaiado
em 21/10; o aviso público e as funções de restrição/expurgo entram nesta
entrega. Sua disponibilidade hospedada depende do deploy normal após merge.
Não é aprovação da ANPD.

O escopo existente, conforme [REGISTRY.md](../plataforma/REGISTRY.md), é razão
social, situação e endereço, com leitura restrita à empresa autorizada,
confirmação humana antes de aplicar sugestões e sem payload bruto, QSA,
telefone ou e-mail. O cache dura até 30 dias; o cadastro confirmado e seu
histórico são conservados com a empresa, conforme
[RETENTION.md](../plataforma/RETENTION.md). Portanto, 30 dias não é prazo de
todos os dados derivados nem obrigação imposta pelo OpenCNPJ. A avaliação
deve abranger ambas as retenções e o atendimento aos direitos do titular.

## Efeito na pendência e limites da prova

Fica substituída a ação obrigatória de pedir termos pelo Fala.BR. O fundamento
e os textos de atribuição estão definidos para o recorte existente. Para
uma futura entrega de datasets, falta selecionar os arquivos e hashes,
incorporar esses avisos ao artefato e conferir condições específicas da
versão. No CNPJ, o rótulo da licença foi confirmado e a avaliação de dados
pessoais está documentada, com procedimento, aviso e implementação de
restrição/expurgo. A inexistência de link na linha de licença encerra a busca
pelo suposto texto vinculado; não prova uma versão CC BY. Para o recorte do
serviço, a decisão é usar o fundamento legal acima e a atribuição declarada.
A versão CC desconhecida não bloqueia esta PR, que não distribui a base.
Uma futura distribuição integral exigirá avaliação própria do objeto, sem
herdar desta decisão uma concessão CC BY 4.0 ou a MIT do software.

Esta entrega acrescenta controle de restrição e expurgo do histórico CNPJ,
procedimento de atendimento e aviso público. Os payloads seguem fora de Git e
tarballs; o coletor e os manifestos persistidos mantêm `review-required`.
Esse estado continua exigindo revisão do artefato antes de distribuí-lo;
não significa que esta pesquisa deixou de identificar fundamento legal.
O contrato REST mantém seus estados: consulta restrita retorna `unavailable`,
atualização e aplicação são negadas. Gates de release permanecem. Não foi
aprovada publicação de base, cache ou respostas reais como fixtures.

As coletas HTTP e seus hashes
registram 18 fontes, status e redirecionamentos. Os corpos integrais não
foram arquivados; um hash sozinho não permite reconstruí-los nem comprova
autenticidade. Os anexos e a comparação com o PDF oficial
registram separadamente a evidência posterior, sem apagar o histórico de 401.
A pesquisa não consultou CNPJs individuais nem baixou bases cadastrais.
A etapa seguinte acrescentou provas sintéticas do controle de restrição,
descritas no [procedimento](../operacao/cnpj-direitos.md) e no
recibo de validação.
As evidências de 30/09 e 20/10 conservam suas datas e limites.

[dados-abertos]: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2016/decreto/d8777.htm
[alteracao]: https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2019/decreto/d9903.htm
[lda]: https://www.planalto.gov.br/ccivil_03/leis/l9610.htm
[cginda]: https://www.gov.br/governodigital/pt-br/legislacao/resolucaocginda22432017pdf.pdf
[ibge-api]: https://servicodados.ibge.gov.br/api/docs/localidades
[ibge-termo]: https://www.ibge.gov.br/acesso-informacao/acoes-e-programas/politica-de-privacidade.html
[ibge-bc250]: https://geoftp.ibge.gov.br/cartas_e_mapas/bases_cartograficas_continuas/bc250/versao2017/informacoes_tecnicas/BC250_termo_uso_2017.pdf
[ibge-noticias]: https://agenciadenoticias.ibge.gov.br/agencia-sala-de-imprensa/2080-agencia-de-noticias/an-artigos-diversos/9277-licenca.html
[ncm-download]: https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/download-ncm-nomenclatura-comum-do-mercosul
[gecex]: https://www.gov.br/mdic/pt-br/assuntos/camex/resolucoes/gecex/resolucoes-compiladas/resolucao-gecex-no-272-de-19-de-novembro-de-2021-compilada
[opencnpj-faq]: https://github.com/Hitmasu/OpenCNPJ/blob/57a3cbef3f5ecdfd7f974f82eb4b1c8f48f58674/src/Page/src/pages/FaqPage.tsx
[opencnpj-limites]: https://github.com/Hitmasu/OpenCNPJ/blob/57a3cbef3f5ecdfd7f974f82eb4b1c8f48f58674/src/Page/src/pages/LimitsPage.tsx
[opencnpj-sobre]: https://github.com/Hitmasu/OpenCNPJ/blob/57a3cbef3f5ecdfd7f974f82eb4b1c8f48f58674/src/Page/src/pages/AboutPage.tsx
[opencnpj-origens]: https://github.com/Hitmasu/OpenCNPJ/blob/57a3cbef3f5ecdfd7f974f82eb4b1c8f48f58674/src/Page/src/data/datasets.ts
[opencnpj-mit]: https://github.com/Hitmasu/OpenCNPJ/blob/57a3cbef3f5ecdfd7f974f82eb4b1c8f48f58674/LICENSE
[opencnpj]: https://opencnpj.org/
[rfb-cadastros]: https://www.gov.br/receitafederal/pt-br/acesso-a-informacao/dados-abertos/cadastros
[rfb-cnpj]: https://www.gov.br/receitafederal/pt-br/acesso-a-informacao/dados-abertos/cadastros/cnpj
[cnpj-catalogo]: https://dados.gov.br/dados/conjuntos-dados/cadastro-nacional-da-pessoa-juridica---cnpj
[catalogo-openapi]: https://dados.gov.br/v3/api-docs
[redecnpj]: https://www.redecnpj.com/r/pag/adquirir.html
[qsa-catalogo]: https://data.amerigeoss.org/dataset/qsa
[lgpd]: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm
[anpd]: https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia_legitimo_interesse.pdf
