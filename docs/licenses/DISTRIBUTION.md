# Condições de distribuição por artefato

Avaliação da #83 atualizada em 05/10/2026. O mantenedor determinou nesta
rodada: "mantenha bloqueado no momento e registre exatamente o que ha pendente".
Todos os artefatos continuam bloqueados para nova distribuição externa.
Não foi apresentado parecer jurídico adicional nem comprovação nova de
direitos. A política Freecorps 1.0
para plataforma/motor e MIT para o cliente permanece conforme
[DECISOES.md](DECISOES.md). Não há nova concessão ou autorização de publicação.

Desde 31/10/2026, a [ADR 0011](../adr/0011-entregas-graduais.md) define
aceite por artefato na #83, com versão/hash e SHA escolhido por lote.
Os gates `rights` e `release-acceptance` continuam obrigatórios. A #267
trata apenas da árvore pública correspondente; não há último merge global
a esperar. Npm/2FA e nomes foram conferidos em 29/10, e a #636 entregou
empacotamento e avisos; os bytes finais ainda exigem prova e aceite.

O inventário e os textos estão em [LICENSING.md](../../LICENSING.md).
Esta avaliação conclui o recorte técnico das condições e exclusões; a #83
registra os aceites abaixo. Em 01/11/2026 o mantenedor selecionou, aceitou
por pacote, versão e hash e publicou no npm sdk, fiscal-core, fiscal-nfe e
fiscal-nfse, e manteve contracts privado
([decisões de 01/11](#decisões-do-mantenedor-em-01112026),
recibo).
Só os manifests desses quatro deixam de ter `private: true`; os demais o conservam.
O registro desta rodada fixa o
código conferido, as provas técnicas e seus limites. A decisão não altera
o serviço hospedado existente nem revoga concessões das licenças já adotadas.

## Decisão por artefato

| Artefato e versão                                               | Decisão atual                                                                                       | Condições que faltam                                                                                                                                                                                                                                                                                                               | Materiais que não condicionam este aceite                                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `@freecorps/sdk@0.1.0`, inclusive `/webhooks`                   | Publicado no npm em 01/11/2026, pelos hashes do lote (MIT, independente); obsoleto desde 03/11/2026 | Nenhuma; `rights` e `release-acceptance` registrados em 01/11/2026                                                                                                                                                                                                                                                                 | Motor, XSDs, datasets, skills e servidor Convex não são incorporados. A minuta Freecorps não precisa ser liberada para publicar este cliente. |
| `@freecorps/freecorpsnfe-sdk@0.1.0`, inclusive `/webhooks`      | Publicado no npm em 03/11/2026, pelo hash do lote (MIT, independente)                               | Nenhuma; `rights` e `release-acceptance` registrados em 03/11/2026 (#73)                                                                                                                                                                                                                                                           | Motor, XSDs, datasets, skills e servidor Convex não são incorporados. A minuta Freecorps não precisa ser liberada para publicar este cliente. |
| `@freecorps/fiscal-core@0.1.0`                                  | Publicado no npm em 01/11/2026, pelos hashes do lote                                                | Nenhuma; `rights` e `release-acceptance` registrados em 01/11/2026                                                                                                                                                                                                                                                                 | Sem dependência de runtime, XSDs ou datasets.                                                                                                 |
| `@freecorps/fiscal-nfe@0.1.0`, inclusive captura                | Publicado no npm em 01/11/2026, pelos hashes do lote                                                | Nenhuma; `rights` e `release-acceptance` registrados em 01/11/2026                                                                                                                                                                                                                                                                 | Datasets, corpus, skills e servidor Convex não entram no tarball. A licença MIT do runtime não cobre XSDs.                                    |
| `@freecorps/fiscal-nfse@0.1.0`, inclusive `./pure` e `./danfse` | Publicado no npm em 01/11/2026, pelos hashes do lote; XSDs originais intactos                       | Nenhuma; `rights` e `release-acceptance` registrados em 01/11/2026                                                                                                                                                                                                                                                                 | Fixtures ADN/PTAX, chaves sintéticas e servidor Convex não entram no tarball. A licença MIT do runtime não cobre os XSDs NFS-e.               |
| `@freecorps/contracts@0.1.0`                                    | Privado por decisão de 01/11/2026; fora da publicação                                               | `rights` e `release-acceptance`. Freecorps 1.0 em `LICENSE`; external, references, registry e webhooks em MIT, com `LICENSE-MIT` e cabeçalho SPDX no JS e nas declarações, conferidos pela inspeção. Os mesmos quatro contratos entram no SDK sob o aceite dele. Pacote em `packages/contracts/dist` por `contracts:build` (29/10) | Não publicar todo contracts como MIT.                                                                                                         |
| Aplicação, console e backend próprios, 0.0.0                    | Snapshot ou bundle externo sem aceite                                                               | Direitos do código próprio; revisão do conteúdo efetivamente incorporado, incluindo UI, Geist e schemas quando presentes                                                                                                                                                                                                           | Provar os quatro tarballs não prova esse formato. A operação hospedada segue [deploy-producao.md](../operacao/deploy-producao.md).            |
| Site, guias e downloads do console, 0.0.0                       | Conteúdo candidato; nova divulgação sem aceite                                                      | Direitos dos textos, exemplos e assets; avisos MIT/OFL e Freecorps por arquivo; revisão das promessas e aceite na issue da entrega e na #85 do conteúdo/hash selecionado                                                                                                                                                           | Inclui XML sintético e fontes em `public/`; não herda a prova de exclusão de corpus dos tarballs.                                             |
| Repositório integral e histórico                                | Árvore pública desde 03/11/2026; histórico no repositório arquivado, privado                        | Formato de publicação; cadeia de direitos; dados de terceiros e mantenedores na árvore; segredo em imagem, dados reais e e-mails pessoais no histórico (25/10)                                                                                                                                                                     | Recibos de tarballs e scan de uma ancestralidade não liberam o repositório.                                                                   |
| Imagens de instalação e ferramentas                             | Redistribuição não aprovada neste escopo                                                            | Revisar cada imagem/digest, seus avisos e fontes exigidas; a pendência dos bindings Yuku 0.5.48 vale para artefatos antigos, pois o lock atual usa 0.9.5 com declaração MIT                                                                                                                                                        | A licença do cliente npm Convex não é a licença do servidor.                                                                                  |

O recibo de `distribution:prove` registra `distribution.status: blocked` e
`pendingConditions` em cada tarball, junto de versão, lista de arquivos e hash.
`result: passed` significa inspeção e instalação aprovadas. Não é um parecer
nem autorização de publicação. O recibo fixa também os hashes deste documento
e do inspetor. Não existe publicador ou mecanismo de aprovação automática.

## Responsáveis e condição de saída

| Identificador            | Responsável funcional                                 | Evidência necessária para remover a pendência                                                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rights`                 | Mantenedor e responsáveis pelos arquivos incorporados | Conferência de autoria por arquivo/revisão, origem de código reaproveitado e autorização de quem tem poderes. Aceites de contribuição devem cobrir o uso/licenciamento pretendido. Identificar restrições e excluir material sem concessão suficiente. CNPJ, autor de commit e cabeçalho SPDX isolados não comprovam a cadeia de direitos. |
| `sdk-legal-review`       | Mantenedor com assessoria jurídica                    | Substituído pela decisão do mantenedor de 20/10/2026, sem parecer jurídico; ver [decisões](#decisões-do-mantenedor-em-20102026).                                                                                                                                                                                                           |
| `freecorps-legal-review` | Mantenedor com assessoria jurídica                    | Substituído pela decisão do mantenedor de 20/10/2026, sem parecer jurídico; ver [decisões](#decisões-do-mantenedor-em-20102026).                                                                                                                                                                                                           |
| `xsd-permission`         | Mantenedor e responsável pelo motor                   | Substituído pela decisão do mantenedor de 20/10/2026: os XSDs são redistribuídos sem alteração de conteúdo, com atribuição e o aviso W3C nos `LICENSING.md` dos pacotes.                                                                                                                                                                   |
| `release-acceptance`     | Mantenedor e responsável pela release                 | Selecionar artefatos, versões e hashes; resolver suas pendências; conferir instalação, nomes no registry, conteúdo, avisos, segurança, suporte e limites fiscais anunciados. Registrar autorização explícita antes de alterar `private` ou publicar.                                                                                       |

Pareceres, contratos e comprovantes privados ficam em custódia restrita.
O registro publicável guarda identificador do documento, data, responsável,
escopo, hashes e conclusão autorizada, sem anexar dados pessoais ou segredos.
Ausência de evidência conserva o bloqueio; uma aprovação não se propaga para
outro pacote, versão, formato ou origem.

## Pendências abertas em 05/10/2026

O quadro abaixo preserva a avaliação daquela data. Para IBGE, NCM e OpenCNPJ,
a [pesquisa de 21/10/2026](DATA-SOURCES.md) substitui a pendência de obter
termos pelo Fala.BR e registra fundamento, atribuição e limites. Consulte a
seção de dados abaixo para as condições que ainda faltam.

As linhas abaixo detalham o que ainda precisa ser entregue. Nenhuma foi
concluída nesta rodada. Os responsáveis são funcionais; ainda falta designar
executor nominal, custodiante das evidências restritas e prazo. Esses dados
não são inferidos da autoria de commits nem da existência desta documentação.

| Pendência                                            | Escopo bloqueado                                                                                | O que existe e o que falta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Responsável e próxima ação                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cadeia de direitos, `rights`                         | Cada pacote, aplicação e conteúdo próprio selecionado                                           | Existem cabeçalhos, histórico e titular declarado. Falta relacionar os arquivos/revisões efetivamente incorporados aos titulares, origens, concessões e aceites de contribuição com poderes suficientes. O comprovante de CNPJ não supre essa relação.                                                                                                                                                                                                                                                              | Mantenedor e responsáveis pelo código: produzir a relação por arquivo/revisão, obter autorizações e excluir material sem direitos suficientes.                                                                                                                                                                                                                                                                                                                                       |
| Parecer do cliente, `sdk-legal-review`               | SDK 0.1.0 e seus quatro contratos MIT incorporados                                              | Resolvido pela decisão do mantenedor de 20/10/2026, sem parecer jurídico.                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rever o texto por nova decisão, se necessário.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Parecer da licença própria, `freecorps-legal-review` | Core, motor, aplicação e demais arquivos Freecorps 1.0                                          | Resolvido pela decisão do mantenedor de 20/10/2026, sem parecer jurídico.                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rever o texto por nova decisão, se necessário.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Permissão dos XSDs, `xsd-permission`                 | Fiscal-nfe, fiscal-nfse e bundles/snapshots com schemas                                         | Resolvido pela decisão de 20/10/2026, com atribuição, aviso W3C e, no NFS-e, CC BY-ND 3.0 nos `LICENSING.md` de fiscal-nfe e fiscal-nfse.                                                                                                                                                                                                                                                                                                                                                                           | Nenhuma.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Dataset IBGE                                         | Republicação de `2026-09-30-66817c020c86e184`, 5.571 registros                                  | Origem/hash e consulta técnica estão registrados. Faltam termos aplicáveis ao snapshot, atribuição e avisos aprovados. Payload permanece excluído.                                                                                                                                                                                                                                                                                                                                                                  | Mantenedor e responsável pela fonte: documentar concessão/fundamento e condições da versão exata antes de republicar.                                                                                                                                                                                                                                                                                                                                                                |
| Dataset NCM                                          | Republicação de `2026-09-30-6f0485d0b173a795`, 10.515 códigos                                   | Coleta e vigência em 30/09/2026 estão registradas. Falta revisar a concessão do JSON, sem estender automaticamente a licença do portal ao download. NESH e alíquotas estão excluídos.                                                                                                                                                                                                                                                                                                                               | Mantenedor e responsável pela fonte: registrar termos, atribuições e restrições do arquivo de origem.                                                                                                                                                                                                                                                                                                                                                                                |
| Dados OpenCNPJ                                       | Redistribuição de base/cache/respostas e aceite jurídico da projeção oferecida aos consumidores | Dataset `receita`; versão individual desconhecida. FAQ e limites fixados não são licença dos dados. Falta avaliar condições da origem Receita e da exposição da projeção, inclusive minimização e retenção.                                                                                                                                                                                                                                                                                                         | Mantenedor e responsável pela fonte, com assessoria jurídica: registrar o escopo autorizado e os limites; a exclusão dos pacotes não conclui a análise do serviço. Não muda a consulta/cache existente.                                                                                                                                                                                                                                                                              |
| Materiais reaproveitados                             | Snapshot integral, bundles e ferramentas que incorporem esses materiais                         | Projeto de origem e skills: decisão de 20/10, o projeto de origem é do mantenedor e as skills de terceiros creditam os autores, com as licenças em `.agents/skills/licencas/`. UI e patches resolvidos pela decisão de 20/10/2026. Os achados de 25/10 sobre a skill da Vercel e o shadcn foram resolvidos em 28/10 (#83): o texto MIT da skill da Vercel está em `.agents/skills/licencas/vercel-agent-skills-LICENSE`, e `NOTICE` e `LICENSING.md` dizem que o código do shadcn só existe no histórico do legado. | Decidido em 28/10 (#267): o código vai para um repositório novo, sem histórico e sem `docs/historico/`; o aviso do shadcn não acompanha a cópia pública.                                                                                                                                                                                                                                                                                                                             |
| Segredos, PII e histórico                            | Abertura do repositório e qualquer formato externo selecionado                                  | Varredura de 25/10 da árvore `bfb2a94` e de todas as refs (70 branches, 311 refs de PR): nenhuma credencial viva. Na árvore, dois clientes reais num plano histórico, o nome da empresa piloto da captura, nomes e e-mails corporativos dos mantenedores e nomes de deployment. Só no histórico, o segredo de uma chave do Convex local em quatro PNGs, um tomador real num teste legado, o endereço da Freecorps e dois e-mails pessoais nos metadados de commit.                                                  | Formato decidido em 28/10 e revisto em 03/11: desenvolvimento aberto num repositório público novo, sem o histórico deste, que é arquivado. A árvore pública de 28/10 monta a seleção com manifesto, aplica as decisões de 28/10 (mantenedores pelo papel; sem e-mails pessoais, deployments de teste, `docs/historico/` e recibos) e varre os bytes, sem bloqueio. Mantenedor: desligar ou isolar os deployments de teste, revisar a lista e repetir a montagem no commit publicado. |
| Binários, imagens e infraestrutura                   | Imagens de instalação e ferramentas redistribuídas                                              | Convex tem revisão/digest e licença próprios. Faltam revisão da composição de cada imagem/digest, avisos/fontes exigidos e correspondência dos bindings Yuku 0.5.48 em artefatos antigos com a concessão aplicável. O lock atual usa 0.9.5 com declaração MIT. Dependências de build MPL/LGPL têm condições próprias.                                                                                                                                                                                               | Responsável por instalação e mantenedor: inventariar cada imagem, conferir fontes/avisos e revisar o uso pretendido do servidor; MIT do cliente Convex não resolve essa pendência.                                                                                                                                                                                                                                                                                                   |
| Site, guias, exemplos e fontes                       | Nova divulgação do site/downloads e distribuição do bundle                                      | Os dois textos OFL acompanham as 14 fontes Geist do bundle: quatro WOFF2 de `public/fonts/` e dez do `@fontsource` importadas pelo painel (29/10); o XML é cópia de fixture sintética. Falta aceite dos arquivos/hashes efetivamente servidos, direitos e atribuições dos textos/assets e das promessas contra a cobertura comprovada.                                                                                                                                                                              | Responsáveis pelo console/material #85 e mantenedor: revisar `public/`, HTML e bundle final; conferir MIT dos exemplos de código, Freecorps dos demais arquivos próprios e OFL das fontes.                                                                                                                                                                                                                                                                                           |
| Aceite da release, `release-acceptance`              | Todos os artefatos selecionados, inclusive SDK/core sem schemas/dados                           | Há preparo técnico, SECURITY, CONTRIBUTING, changelog e checklist. Faltam resolver as pendências aplicáveis, fixar bytes finais, confirmar propriedade/nomes/versões no registry, matriz de runtimes/suporte e autorização explícita. O canal privado de segurança está publicado no SECURITY.md desde 21/10/2026.                                                                                                                                                                                                  | Mantenedor e responsável pela release: registrar pacote/versão/hash, dependências aceitas, condições resolvidas e destino de publicação. Fiscal-nfe e fiscal-nfse exigem aceite de fiscal-core.                                                                                                                                                                                                                                                                                      |

IBGE/NCM/OpenCNPJ, skills e imagens não entram nos cinco tarballs e não
acrescentam condições ao aceite isolado de SDK/core. Continuam com bloqueios
próprios. A revisão de conteúdo dos tarballs é necessária mesmo quando
nenhum desses materiais estiver presente. Desde 20/10, `distribution:prove` emite só `rights` e `release-acceptance`;
os identificadores dos pareceres e dos XSDs ficam na tabela como histórico.

Para encerrar uma linha, registrar data, decisor autorizado, escopo exato,
versões/hashes, referência e custodiante da evidência, conclusão e ressalvas.
Para exclusão, registrar quais bytes foram retirados e repetir a inspeção do
formato afetado. Uma pendência obrigatória conserva a #83 aberta; transferi-la
exige issue vinculada e decisão explícita de escopo, não apenas editar o status.

## Rodada de 20/10/2026

As minutas preparatórias sobre SDK MIT e Freecorps 1.0
respondem às 20 perguntas dessa rodada e registram as premissas informadas
pelos sócios. Foram elaboradas com assistência de IA, sem revisão ou
assinatura de advogado; não substituem a decisão do mantenedor abaixo,
não comprovam a cadeia de direitos e não liberam artefatos. A recomendação
prioritária é formalizar os direitos sobre o código dos dois fundadores.

O registro de 20/10 levantou
insumos dos pareceres, direitos dos materiais reaproveitados, termos das
fontes, as demais refs e o ensaio local da demonstração. Nenhuma pendência
acima foi removida: o que faltava depende de parecer, autorização ou decisão
do mantenedor. Esta rodada acrescentou só avisos que as licenças exigem e
corrigiu contagens e caminhos. O mantenedor decidiu em 20/10 que o material
copiado de outro projeto dele não precisa de justificativa de procedência;
as skills de terceiros só creditam os autores, nos
[créditos](../../.agents/skills/EXTERNAS.md#créditos).

### Decisões do mantenedor em 20/10/2026

A Freecorps não tem assessoria jurídica. O mantenedor decidiu substituir os
pareceres por decisão própria, assumindo o risco, e registrou:

- **`sdk-legal-review`:** aceito sem parecer. O SDK segue MIT, com o escopo e
  os avisos conferidos no registro de 20/10.
  A pendência sai do SDK.
- **`freecorps-legal-review`:** o texto atual de `LICENSE` e
  `CONTRIBUICOES.md` fica como está, sem parecer. Uma revisão futura pode
  alterá-lo por nova decisão. A pendência sai dos artefatos Freecorps 1.0.
- **Contribuições:** o mantenedor declara que o segundo autor humano do
  projeto aceitou os termos de `CONTRIBUICOES.md`.
- **Histórico e refs:** o repositório público começa sem o histórico
  deste (decisão 6 de [ACCEPTANCE.md](../v1.0/ACCEPTANCE.md), revista em
  03/11/2026). Metadados de commit e refs de PR antigos ficam no arquivo
  privado. A abertura segue a #267.
- **XSDs:** redistribuídos dentro de fiscal-nfe e fiscal-nfse, sem alterar o
  conteúdo, como especificação técnica oficial. Os `LICENSING.md` dos pacotes
  trazem a atribuição, o aviso completo do W3C para o XMLDSig e, no NFS-e, a
  CC BY-ND 3.0 do portal. A pendência `xsd-permission` sai dos dois pacotes.
- **Patches e assets:** os patches dos pacotes `@convex-dev/*` ficam sob
  Apache-2.0, como os originais. Desde 09/11/2026 (#142) o rate-limiter
  modificado fica em `packages/convex-rate-limiter`, com `LICENSE` e `NOTICE`;
  [patches/README.md](../../patches/README.md) registra arquivos, autoria e
  data como aviso de modificação. `public/favicon.svg` e `public/icons.svg` do
  legado, sem uso e com logotipos de terceiros, foram removidos.
- **npm:** o mantenedor declarou em 20/10 que a organização `freecorps` é dos
  dois mantenedores. A consulta sem login não mostra os membros; ela só
  confirmou que o escopo existe e que nenhum dos cinco nomes `@freecorps/*`
  foi publicado. A conferência pela conta fica no aceite da release.
- **Canal de segurança:** `seguranca@nfe.freecorps.com.br` foi ativado e
  ensaiado com mensagem externa em 21/10/2026 e está no `SECURITY.md`
  ([roteiro](../operacao/seguranca-email.md#ensaio-externo-em-21102026),
  [#266](https://github.com/freecorps/freecorpsNFE-arquivo/issues/266)).
- **Lançamento:** sem data. O lançamento ocorre quando o mantenedor
  considerar o produto pronto, então sujeito à #51. Essa organização foi
  substituída em 31/10 pela ADR 0011; a decisão de licença permanece.

### Decisões do mantenedor em 01/11/2026

Na #83, ao preparar o lote de publicação, o mantenedor decidiu:

- **Pacotes:** publicar no npm, públicos e na versão 0.1.0, `@freecorps/sdk`,
  `@freecorps/fiscal-core`, `@freecorps/fiscal-nfe` e `@freecorps/fiscal-nfse`.
  O SDK embute os quatro contratos MIT e depende só de `zod`, então seu aceite
  não exige o de contracts.
- **contracts:** `@freecorps/contracts` continua privado e fora da publicação.
  A inspeção recusa seu tarball se o manifesto deixar de ser privado.
- **`rights`:** a condição de saída fica como está escrita. A relação por
  arquivo e revisão dos bytes exatos de cada tarball aceito, com fontes,
  commits, autores, origem e concessão, é gerada por
  `scripts/licenses/rights-relation.mjs` e registrada com o aceite. Autor ou coautor sem
  classificação faz o gerador falhar.
- **XSDs NFS-e (CC BY-ND 3.0):** o tarball de fiscal-nfse leva os originais
  intactos, conferidos pela inspeção contra os hashes do manifesto. O BOM e as
  âncoras de `TSSerieDPS` são ajustados em memória ao carregar. A decisão de
  20/10 ("sem alterar o conteúdo") continua valendo como escrita.
- **Datasets das #75/#76:** IBGE, NCM e OpenCNPJ são fornecidos só por consulta
  ao serviço. Republicar as bases fica fora do produto, e os payloads continuam
  excluídos de Git, pacotes e fixtures; isso encerra os quatro itens repassados
  das #75/#76 à #83. Nova distribuição de base exigiria outra decisão.

O aceite final de `rights` e `release-acceptance` foi registrado na #83 em
01/11/2026, com versão, hash e a relação de cada tarball no SHA de publicação
`08e85d8`; o recibo traz também a
prova pelo registry.

Decisões e ações que continuam com pessoas:

| Pendência                 | Decisão ou ação que falta                                                                                                                                                                                                                                                                                                                                                                                             | Quem                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| IBGE, NCM, OpenCNPJ       | Fundamento e atribuição definidos na [pesquisa de 21/10](DATA-SOURCES.md), sem Fala.BR. Por decisão de 01/11/2026 as bases são fornecidas só por consulta, sem distribuição; para CNPJ, aplicar o [procedimento de direitos](../operacao/cnpj-direitos.md) e publicar aviso/funções pelo deploy normal. A página não vincula texto legal ao rótulo CC; versão desconhecida não bloqueia esta PR sem base distribuída. | Mantenedor e responsável pela fonte |
| `release-acceptance`      | Membros da organização npm `freecorps` conferidos pelo mantenedor em 29/10: só os dois mantenedores, ambos owners. Aceite por pacote, versão e hash registrado em 01/11/2026 para os quatro pacotes publicados; contracts segue privado                                                                                                                                                                               | Mantenedor                          |
| Segredos, PII e histórico | Formato decidido em 28/10 e revisto em 03/11 (desenvolvimento aberto num repositório público novo, sem histórico; este é arquivado); conteúdo aplicado na cópia. Falta revisar a lista da árvore pública, conferir as proteções do repositório novo (deployments de teste desligados e 2FA obrigatório em 03/11, recibo) e repetir a montagem no commit publicado                                                     | Mantenedor                          |

## XSDs, dados e materiais incorporados

| Origem fixada                                                                                                                             | Fornecimento decidido nesta avaliação                                                        | Próxima ação e limite                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XSDs NF-e: `nfe-4.00-010g`, `events-1.00-alphanumeric`, `cancellation-1.01`, `distribution-1.04`, `correction-1.01`, `manifestation-1.01` | Incorporado ao tarball fiscal-nfe por decisão de 20/10/2026                                  | Atribuição ao Portal NF-e e aviso W3C do XMLDSig em `packages/fiscal-nfe/LICENSING.md`. Conteúdo inalterado; só a codificação é convertida.                                                                                                                                                                                                                                                                                                                     |
| XSDs NFS-e nacional: `nfse-1.01-20260209` e `nfse-1.01-prodrest-20261020` (mesma fonte e licença, #197)                                   | Incorporados ao `dist` de fiscal-nfse por decisões de 20/10/2026 e, o segundo, de 02/11/2026 | CC BY-ND 3.0 com atribuição à Receita Federal em `packages/fiscal-nfse/LICENSING.md`. Distribuídos com os bytes originais (CC BY-ND 3.0, sem derivação); o BOM e as âncoras de `TSSerieDPS` são ajustados só em memória, ao carregar (decisão de 01/11/2026).                                                                                                                                                                                                   |
| IBGE `2026-09-30-66817c020c86e184`, 5.571 municípios                                                                                      | Payload excluído de Git e pacotes; `review-required` permanece                               | Fundamento cadastral e de dados federais e crédito ao IBGE definidos em [DATA-SOURCES.md](DATA-SOURCES.md). Incorporar avisos e conferir os bytes da futura entrega. A decisão não abrange bases cartográficas.                                                                                                                                                                                                                                                 |
| NCM `2026-09-30-6f0485d0b173a795`, vigente em 30/09/2026, 10.515 códigos                                                                  | Payload excluído; NESH e alíquotas também não fazem parte da entrega                         | Fundamento normativo e de dados federais e crédito à Receita/Siscomex definidos em [DATA-SOURCES.md](DATA-SOURCES.md). Conferir o artefato e seus avisos antes de distribuir. Não se presume CC BY-ND para o JSON.                                                                                                                                                                                                                                              |
| OpenCNPJ, dataset `receita`, versão individual desconhecida                                                                               | Base, cache e respostas reais excluídos de pacotes/fixtures                                  | Uso comercial pontual confirmado; fundamento e créditos documentados em [DATA-SOURCES.md](DATA-SOURCES.md). Captura do catálogo confirma Creative Commons Attribution, sem versão identificada. [Teste LGPD](CNPJ-LEGITIMATE-INTEREST.md), procedimento, aviso e restrição de consultas preparados. A linha da licença é texto sem link; o recorte atual usa o fundamento legal documentado. Distribuição integral exige análise própria. MIT cobre o software. |
| Corpus sintético NF-e/referências e extensões de eventos/captura                                                                          | Interno; sem pacote de fixtures                                                              | Manifestos preservam origem e hashes. Chave/certificado sintéticos não entram nos tarballs. XML sanitizado de terceiros precisaria de concessão própria.                                                                                                                                                                                                                                                                                                        |
| 94 skills, imports do projeto de origem, UI e patches                                                                                     | Fora dos tarballs independentes                                                              | Skills e projeto de origem resolvidos pela decisão de 20/10, conservando créditos e licenças. `manager`, do Brigade, conserva o texto AGPL-3.0 da origem, sem decisão própria; procedência em [EXTERNAS.md](../../.agents/skills/EXTERNAS.md#importação-do-brigade-em-26102026). Patches sob Apache-2.0 com aviso em `patches/README.md`; assets sem uso removidos.                                                                                             |
| Geist 5.3.0, OFL-1.1                                                                                                                      | Fora dos tarballs; presente no console                                                       | Conservar texto OFL e avisos no formato de console distribuído. O bundle de `4cc71f1` leva os dois textos OFL com as 14 fontes (conferência de 29/10); repetir no SHA publicado.                                                                                                                                                                                                                                                                                |
| Dependências npm e runtime                                                                                                                | Versões/integridades inventariadas; avisos nos pacotes                                       | [dependencies.json](dependencies.json) e [runtime-additions.json](runtime-additions.json). Nova resolução exige revisão. O lock atual usa bindings Yuku 0.9.5 com declaração MIT; a restrição anterior continua aplicável a artefatos que contenham 0.5.48.                                                                                                                                                                                                     |
| Servidor Convex `0cf49cbf8c4b7e22e631ceda9b5111f6cccbcd49`                                                                                | Dependência de infraestrutura externa aos tarballs                                           | FSL-1.1-Apache-2.0 no [texto fixado](https://github.com/get-convex/convex-backend/blob/0cf49cbf8c4b7e22e631ceda9b5111f6cccbcd49/LICENSE.md); não presumir conversão para Apache hoje. Digest em [versions.json](../../deploy/selfhost/versions.json).                                                                                                                                                                                                           |

O [fundamento e a atribuição atuais](DATA-SOURCES.md) foram pesquisados em
21/10/2026. As fontes de consulta, hashes e os limites de IBGE/NCM/OpenCNPJ estão no
repasse das #75/#76.
Na avaliação anterior, de 30/09/2026, foram reconsultados a
[API IBGE](https://servicodados.ibge.gov.br/api/docs/localidades), o
[download NCM](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/download-ncm-nomenclatura-comum-do-mercosul),
o [FAQ OpenCNPJ fixado](https://github.com/Hitmasu/OpenCNPJ/blob/7576e9fa57e2abd6a48a86bc957bb0188626b067/src/Page/src/pages/FaqPage.tsx)
e a licença fixada do servidor. Não foi obtida autorização nova de
redistribuição dos dados ou XSDs. A rodada de 05/10 registra suas próprias
consultas e limites no recibo vinculado acima. Não houve coleta de dados pessoais.

## Conteúdo publicável e aceite parcial

São candidatos de conteúdo dos pacotes somente JS/tipos necessários, README,
LICENSE, NOTICE, LICENSING e avisos de terceiros; fiscal-nfe e fiscal-nfse
contêm também seus catálogos e manifestos, ainda bloqueados. A lista/hash final vem da inspeção
do tarball, não de uma inferência a partir de `files` no package.json.
Evidências internas, `.env`, credenciais, PEM/PFX, corpus, respostas CNPJ,
datasets e `node_modules` ficam fora. As provas copiam o diretório inteiro de
cada pacote, com fontes, testes e fixtures, e deixam o empacotador aplicar o
campo `files` do manifesto; ampliar esse campo faz a inspeção recusar o
tarball. A inspeção recusa também, em qualquer caminho, NF-e assinada,
certificado incorporado, cópia byte a byte de arquivo versionado em
`fixtures/` ou de PEM/PFX e o corpo dos certificados e chaves sintéticos.
O scanner de credenciais da prova não substitui revisão humana de PII nem
varredura do histórico a ser exposto.

Desde 01/11/2026 os materiais da #85 descrevem sdk, fiscal-core, fiscal-nfe e
fiscal-nfse no npm, contracts privado, SDK MIT, plataforma/motor
Freecorps 1.0 e servidor com licença distinta; desde 03/11/2026, também o
repositório público. Não anunciar a stack inteira
como FOSS, nem emissão ou captura fiscal real como consequência da publicação
de um pacote. Documentação externa usa os
arquivos selecionados pelo gerador do site; não publicar `docs/` por inteiro.

O site também serve os arquivos de `apps/console/public/`. Nesta revisão,
`examples/nfe-demonstracao.xml` corresponde por SHA-256 a
`tests/fixtures/nfe/4.00/invoice-alphanumeric.xml`, do gerador sintético,
com certificado de teste embutido. A origem foi conferida, mas esse download
continua sujeito ao aceite próprio do site; não autoriza copiar o corpus
inteiro. Os exemplos de código de `public/developer/` têm escopo MIT explícito;
isso não relicencia automaticamente o XML, OpenAPI, SDK.md ou os demais textos.
Geist e Geist Mono 5.3.0 trazem quatro WOFF2 e dois textos OFL em `public/fonts/`;
o painel importa outras cinco WOFF2 e cinco WOFF do `@fontsource`, que saem em
`assets/`. A conferência de 29/10
achou os dois textos OFL no bundle de `4cc71f1`, iguais aos do `@fontsource`.
O JavaScript minificado não leva os textos de licença das dependências; o build
grava `/third-party-notices.txt` (painel) e `/docs/third-party-notices.txt`
(documentação) com a licença e o texto de cada pacote que entrou nos chunks,
conferido contra o inventário. O build falha com pacote fora do inventário ou
sem texto. Cópias embutidas por dependências ficam em
[vendored.json](vendored.json), e textos de pacotes publicados sem licença, em
[bundle-texts.json](bundle-texts.json). O `.wasm` do leitor de código de
barras da consulta pelo DANFE (`zxing-wasm` 3.1.6, MIT) compila o zxing-cpp
(Apache-2.0, sem arquivo NOTICE no commit usado) e o stb_image (MIT ou
Unlicense); os dois entram nos avisos do painel pelo `vendored.json`.
`noindex` controla indexação e não impede acesso ou redistribuição dos arquivos.

Para aceitar um lote, o mantenedor registra na #83 os pacotes selecionados,
versões, hashes, SHA e evidências, atualiza esta matriz e os avisos locais desses pacotes, e revisa o
gate privado somente para esse escopo. Depois repete as provas de
[release.md](../operacao/release.md) sobre os bytes finais. SDK pode ser aceito
sozinho; fiscal-core pode ser aceito sem fiscal-nfe ou fiscal-nfse. Publicar
fiscal-nfe ou fiscal-nfse exige resolver também a dependência fiscal-core. XSDs ou datasets sem permissão
continuam bloqueados mesmo que outro pacote seja liberado.
