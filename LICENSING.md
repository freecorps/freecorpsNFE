# Licenças e distribuição

A plataforma e o motor fiscal usam a Licença de Código Disponível Freecorps 1.0.
O cliente SDK usa MIT. Titular: FREECORPS TECNOLOGIA DA INFORMACAO LTDA, CNPJ
63.113.119/0001-90. [LICENSE](LICENSE) contém os termos próprios;
[decisões aprovadas](docs/licenses/DECISOES.md) registra os oito pontos.
[NOTICE](NOTICE) preserva as exclusões. Em 20/10/2026 o mantenedor decidiu manter o texto sem parecer jurídico,
assumindo o risco ([decisões](docs/licenses/DISTRIBUTION.md#decisões-do-mantenedor-em-20102026));
a identificação do titular não substitui a conferência de autoria de
componentes e contribuições.
Em 01/11/2026 o mantenedor aceitou e publicou no npm `@freecorps/sdk`,
`@freecorps/fiscal-core`, `@freecorps/fiscal-nfe` e `@freecorps/fiscal-nfse`
0.1.0, por pacote, versão e hash (recibo).
Os demais manifests continuam `private: true`, inclusive `@freecorps/contracts`.
Em 03/11/2026 o código passou ao repositório público
https://github.com/freecorps/freecorpsNFE, sem o histórico anterior, que fica
num repositório arquivado e privado. Não houve tag nem release.

Esta revisão distingue o código próprio dos materiais incorporados. A licença
do projeto não concede direitos sobre dependências, schemas, dados, marcas ou
software de infraestrutura. Um download público não comprova redistribuição.

## Matriz por artefato

A [avaliação por artefato de 05/10/2026](docs/licenses/DISTRIBUTION.md)
registra a decisão de manter bloqueados os itens sem evidência, os responsáveis
e as condições de saída. Nenhum pacote recebeu autorização de publicação.
SDK e core podem ter aceites independentes dos XSDs/datasets. O SDK requer
revisão de seu escopo MIT e direitos, sem depender da minuta Freecorps do motor.
O mantenedor reafirmou o bloqueio de todos os artefatos nesta rodada. A matriz
detalha as evidências faltantes, responsáveis funcionais e condições de saída,
incluindo site/downloads. Não há parecer novo; a publicação dos quatro pacotes veio com o aceite de 01/11/2026.

| Artefato                                            | Versão e licença                                                       | Conteúdo e condição de distribuição                                                                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aplicação, console e código próprio do backend      | 0.0.0, Freecorps 1.0                                                   | Código próprio licenciado; snapshot integral do repositório ainda bloqueado pelos materiais abaixo. A aplicação requer a infraestrutura documentada.                                                                                                 |
| `@freecorps/fiscal-core`                            | 0.1.0, Freecorps 1.0                                                   | Sem dependências de runtime; publicado no npm em 01/11/2026.                                                                                                                                                                                         |
| `@freecorps/fiscal-nfe`                             | 0.1.0, `SEE LICENSE IN LICENSING.md`                                   | Código próprio Freecorps 1.0; inclui XSDs de terceiros em `dist/schemas.json`, redistribuídos por decisão de 20/10/2026 com atribuição e aviso W3C. Publicado no npm em 01/11/2026.                                                                  |
| `@freecorps/fiscal-nfse`                            | 0.1.0, `SEE LICENSE IN LICENSING.md`                                   | Código próprio Freecorps 1.0; inclui XSDs NFS-e nacionais em `dist/schemas.json`, sem datasets; runtime xmldom, xml-crypto e libxml2-wasm. XSDs sob CC BY-ND 3.0 com atribuição, por decisão de 20/10/2026. Publicado no npm em 01/11/2026.          |
| @freecorps/freecorpsnfe-sdk e export /webhooks      | 0.1.0, MIT                                                             | Cliente e quatro contratos externos explicitamente MIT, incluindo JS e tipos incorporados; Zod MIT externo. Não incorpora fiscal-core nem fiscal-nfe. Publicado no npm em 01/11/2026 como `@freecorps/sdk`; o nome novo aguarda aceite e publicação. |
| @freecorps/contracts                                | 0.1.0, licenças por arquivo                                            | Freecorps 1.0 por padrão; external.ts, references.ts, registry.ts e webhooks.ts em MIT para integração. Tarball privado próprio, com `LICENSE` e `LICENSE-MIT`, por `contracts:build`.                                                               |
| Dependências npm                                    | Versões e integridades do `bun.lock`                                   | [Inventário completo](docs/licenses/dependencies.json), inclusive ferramentas e plataformas opcionais; condições por família abaixo. Não se distribui `node_modules`.                                                                                |
| Servidor Convex                                     | Revisão `0cf49cbf8c4b7e22e631ceda9b5111f6cccbcd49`, FSL-1.1-Apache-2.0 | Imagem e digest em `deploy/selfhost/versions.json`. Não está incorporado nos tarballs. Não é apresentado como Apache-2.0 hoje nem como parte de uma stack inteiramente FOSS.                                                                         |
| XSDs NF-e e eventos                                 | Seis origens, versões/hashes no manifesto                              | Sem licença declarada pelo portal; redistribuídos sem alteração de conteúdo por decisão de 20/10/2026, com atribuição e aviso W3C do XMLDSig.                                                                                                        |
| XSDs NFS-e nacional                                 | Pacote v1.01-20260209 do Portal NFS-e, hashes no manifesto             | CC BY-ND 3.0 do portal, aplicada por decisão de 20/10/2026; originais preservados, cópia de runtime com BOM e âncoras removidos.                                                                                                                     |
| Municípios IBGE e NCM Siscomex                      | Snapshots identificados por manifesto/hash                             | Payloads em `.reference-data/` e storage privado; fora do Git/tarballs. Redistribuição em dataset próprio continua pendente.                                                                                                                         |
| Consulta OpenCNPJ                                   | Fonte fixada em `REGISTRY.md`                                          | Consulta e cache cadastral conforme contrato existente; não redistribui base, QSA ou contatos. MIT do software do provedor não licencia os dados.                                                                                                    |
| Corpus de testes                                    | Manifestos NF-e 4.00 e referências 1.0                                 | Dados inventados e geradores próprios sob Freecorps 1.0; corpus interno excluído de todos os tarballs, inclusive chave/certificado sintéticos. Não existe pacote test-fixtures.                                                                      |
| Skills e ferramentas de outro projeto do mantenedor | Procedência em `.agents/skills/EXTERNAS.md` e `docs/worktrees.md`      | Avisos existentes preservados. Revisão de todas as 93 skills e de código importado permanece requisito para tornar público o snapshot integral; nada disso entra nos tarballs.                                                                       |
| UI e fonte Geist                                    | UI própria; Geist 5.3.0 OFL-1.1                                        | Sem marcas do shadcn/ui em `apps/console/src/ui/`. Fonte mantém OFL; distribuição de bundles do console precisa conservar a licença da fonte. Não entram nos pacotes independentes.                                                                  |

## Escopo MIT e licença própria

[first-party.json](docs/licenses/first-party.json) lista os arquivos MIT de
integração e exemplos; [LICENSES/MIT.txt](LICENSES/MIT.txt) contém a concessão.
O SDK mantém seu próprio LICENSE MIT e incorpora somente fontes nessa lista.
Os quatro contratos externos compartilhados têm cabeçalho SPDX MIT, mesmo
quando consumidos pelo backend. Os demais contratos, fiscal-core, fiscal-nfe e fiscal-nfse
continuam sob a licença própria. O restante do código próprio usa LICENSE,
ressalvados componentes de terceiros e avisos específicos já existentes.

O uso interno e serviços técnicos nos limites da licença são gratuitos.
Ofertas fiscais para terceiros, inclusive ERP com motor embutido, SaaS ou
produto concorrente gratuito, dependem de autorização escrita. O MIT permite
uso comercial do cliente inclusive por concorrentes; não concede direito
sobre o motor nem acesso gratuito ao serviço. Alterações internas podem ficar
privadas. Distribuição ou serviço de versão modificada exige fonte correspondente
nos termos da seção 6, sem obrigar uma PR e sem expor dados ou segredos.

O build verifica o grafo efetivo do JS e todas as declarações emitidas contra
o escopo MIT. O tarball recebe o texto MIT, sua atribuição e os avisos externos.
O pacote fiscal recebe o texto Freecorps 1.0. Metadata npm usa
`SEE LICENSE IN LICENSING.md` nos artefatos sujeitos à licença própria ou mista,
e MIT no SDK. Isso não representa uma licença SPDX padronizada para a minuta.

## Dependências e compatibilidade

O inventário consulta o manifesto de cada versão exata no registry e confere
sua integridade com o lock. Inclui 819 versões, aliases, transitivas e binários
opcionais de outros sistemas. Os campos `direct` identificam entradas diretas
por workspace; os demais registros são transitivos. Declaração SPDX é evidência
de origem, não substitui a leitura dos avisos do artefato.

As dependências de runtime dos três tarballs usam MIT, inclusive libxml2-wasm
e o libxml2 incorporado. Seus textos e copyrights acompanham cada pacote em
`THIRD_PARTY_NOTICES.txt`. O tarball de `@nodable/entities@3.1.0` omite o texto
MIT; incluímos a licença da revisão `gitHead` declarada pelo próprio registry.
O lock e a instalação npm limpa agora resolvem essa mesma versão.
O registro de [runtime-additions.json](docs/licenses/runtime-additions.json)
preserva a integridade do tarball e a origem da licença MIT no
[gitHead correspondente](https://github.com/nodable/val-parsers/blob/ac48e7ea591da372be023a481875c747535812b3/LICENSE).
Esse suprimento não altera o pacote instalado nem sua versão. A prova confere
versões e integridades instaladas contra os dois inventários; uma nova resolução
exige revisão.

| Família no lock                                                              | Tratamento nesta entrega                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT, MIT-0, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0 | Conservar textos, copyrights e NOTICE aplicáveis; licença própria não altera a licença da dependência nem dispensa suas condições.                                                                                      |
| Expressões `MIT OR Apache-2.0`, `MIT OR CC0-1.0`                             | Escolha MIT para esta preparação, conservando licença original.                                                                                                                                                         |
| node-forge, `BSD-3-Clause OR GPL-2.0`                                        | Escolha BSD-3-Clause; não afirmar obrigação GPL por ignorar o `OR`.                                                                                                                                                     |
| pako, `MIT AND Zlib`                                                         | Ambas as condições; manter avisos ao redistribuir.                                                                                                                                                                      |
| CC0-1.0, Unlicense, Python-2.0                                               | Conservar origem e termos. Sem presença nos três pacotes independentes salvo dependências futuras, que exigem nova revisão.                                                                                             |
| caniuse-lite, CC-BY-4.0                                                      | Dados de ferramenta de build; atribuição/licença própria. Não reclassificar sob a licença do código próprio.                                                                                                            |
| Geist, OFL-1.1                                                               | Fonte no console. Conservar OFL e nome reservado quando aplicável; não vender fonte isoladamente.                                                                                                                       |
| axe-core e Lightning CSS, MPL-2.0                                            | Ferramentas de teste/build; não incorporadas nos três tarballs. Redistribuir ferramentas modificadas exige revisão do código coberto e acesso ao fonte correspondente.                                                  |
| sharp/libvips, LGPL-3.0-or-later e expressões `AND`                          | Ferramentas/binários fora dos tarballs. Imagens que incorporem esses binários precisam revisar fontes, avisos e condições LGPL por plataforma antes de distribuição. Não se certifica uma imagem completa neste escopo. |
| Bindings `@yuku-parser`/`@yuku-codegen` 0.9.5                                | Os manifestos exatos agora declaram MIT; o lock não contém mais os bindings 0.5.48 sem declaração. Continuam fora dos tarballs. Redistribuir ferramentas exige conservar os avisos dos respectivos artefatos.           |

A licença upstream do Yuku foi preservada na revisão
[`fb32103d68aca3f41ecaa08b03ad7796486aeee4`](https://github.com/yuku-toolchain/yuku/blob/fb32103d68aca3f41ecaa08b03ad7796486aeee4/LICENSE).
O backoffice legado, que saiu da árvore na #345 e existe só no histórico,
adaptava componentes do shadcn/ui. A licença shadcn da revisão
[`db2db460a26fa84fb65c8d903b213925fbdee9ed`](https://github.com/shadcn-ui/ui/blob/db2db460a26fa84fb65c8d903b213925fbdee9ed/LICENSE.md)
fica em `docs/licenses/texts/shadcn-LICENSE` para uma distribuição que inclua
esse histórico. As buscas de 20/10 e 28/10 não acharam código do shadcn/ui na
árvore atual.
Essas revisões identificam os textos consultados, não a origem exata de cada
linha adaptada no passado. Patches de Better Auth, Workpool e Rate Limiter
ficam em `patches/`,
com as versões no lock, e conservam a licença dos respectivos componentes.

## Schemas e fontes de dados

O [manifesto NF-e](packages/fiscal-nfe/schemas/manifest.json) identifica cada
ZIP, arquivo, hash e transformação. Foram conferidos seis pacotes de origem
e o catálogo runtime. A tentativa de consultar o portal NF-e nesta revisão
encontrou redirecionamento circular; não constitui evidência de licença.
O portal não declara licença. Em 20/10/2026 o mantenedor decidiu
redistribuir os schemas sem alterar o conteúdo, com atribuição e o aviso W3C
do XMLDSig em [fiscal-nfe](packages/fiscal-nfe/LICENSING.md).

O [manifesto NFS-e](packages/fiscal-nfse/schemas/manifest.json) faz o mesmo para
os seis XSDs da DPS e do pedido de registro de evento, do pacote
"Esquemas XSD v1.01-20260209" da Documentação Atual do Portal NFS-e. O rodapé
do portal publica o conteúdo do site sob CC BY-ND 3.0 e não diz se a licença
cobre os arquivos para download. Em 20/10/2026 o mantenedor decidiu
redistribuí-los sob essa licença, com atribuição; a cópia de runtime, que
remove o BOM e as âncoras de um padrão, é registrada como ajuste técnico em
[fiscal-nfse](packages/fiscal-nfse/LICENSING.md).

[Municípios](docs/plataforma/REFERENCES.md) e
[NCM](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/download-ncm-nomenclatura-comum-do-mercosul)
são obtidos das fontes oficiais, com atribuição e hashes. A
[pesquisa de 21/10/2026](docs/licenses/DATA-SOURCES.md) define o fundamento
de reuso dos campos cadastrais e normativos e os textos de atribuição, sem
depender de pedido pelo Fala.BR. Não atribui ao dataset a licença de um portal
ou do software de um intermediário. Os payloads continuam excluídos dos
pacotes, e os avisos precisam acompanhar qualquer futura entrega selecionada.
Para CNPJ, a captura fornecida confirma Creative Commons Attribution, sem
versão identificada. A [avaliação LGPD](docs/licenses/CNPJ-LEGITIMATE-INTEREST.md)
está documentada; restrição, expurgo do histórico e aviso público acompanham esta entrega. O escopo e a retenção estão em
[REGISTRY.md](docs/plataforma/REGISTRY.md).

Os manifestos `tests/fixtures/nfe/4.00/manifest.json` e
`tests/fixtures/references/1.0/manifest.json` identificam corpus sintético;
eventos e distribuição reutilizam o pacote NF-e. Fixtures adicionais de
contratos e backend são internas. XML sanitizado de terceiros exigiria origem
e permissão próprias; sanitização não cria licença.

## Infraestrutura e instalação própria

O [texto fixado do servidor Convex](https://github.com/get-convex/convex-backend/blob/0cf49cbf8c4b7e22e631ceda9b5111f6cccbcd49/LICENSE.md)
é FSL-1.1-Apache-2.0. Restringe uso concorrente conforme a definição do texto
e concede Apache-2.0 a cada versão no segundo aniversário de sua disponibilização.
Esta entrega não presume que a conversão já ocorreu. A licença do cliente npm
`convex@1.46.0`, Apache-2.0, é distinta da licença do servidor.
O operador deve conferir o uso pretendido contra a licença fixada e seguir
[instalacao-propria.md](docs/operacao/instalacao-propria.md). A prova local de instalação não concede
permissão para redistribuir imagens ou oferecer um serviço concorrente.

## Bloqueios e responsáveis

O repasse das #75/#76 para #83
identifica os snapshots IBGE/NCM e a revisão dos documentos OpenCNPJ conferidos
em 30/09/2026. Registra condições por origem, responsável e condição de saída.
O aceite técnico local das consultas não remove esses bloqueios de distribuição.
A [pesquisa de 21/10](docs/licenses/DATA-SOURCES.md) atualiza o fundamento e
a atribuição dos datasets, sem alterar o aceite de release.

| Pendência                                                   | Responsável e próxima ação                                                                                                                                                                                                                                                                                                              | Efeito                                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Cadeia de direitos por artefato                             | Mantenedor, documentar origem e autorização dos arquivos incorporados; os pareceres foram substituídos pela decisão de 20/10/2026                                                                                                                                                                                                       | Bloqueia cada artefato sem evidência. A relação dos quatro pacotes publicados foi registrada em 01/11/2026. |
| Redistribuição de datasets IBGE/NCM/CNPJ                    | Mantenedor e responsável pelas fontes, incorporar os [créditos definidos](docs/licenses/DATA-SOURCES.md) à futura entrega; seguir o [teste LGPD](docs/licenses/CNPJ-LEGITIMATE-INTEREST.md) e o procedimento de atendimento. A página do catálogo não vincula um texto legal ao rótulo CC; o serviço usa o fundamento legal documentado | Payloads continuam excluídos; não bloqueia SDK/core sem dados.                                              |
| Procedência completa das skills/importações e binários Yuku | Mantenedor e responsáveis pelas ferramentas, confirmar origens e concessões                                                                                                                                                                                                                                                             | Bloqueia anunciar o repositório integral ou uma imagem com ferramentas como distribuição revisada.          |
| Aceite de release, nomes no registry, suporte e publicação  | Mantenedor; feito em 01/11/2026 para sdk, fiscal-core, fiscal-nfe e fiscal-nfse, por pacote, versão e hash                                                                                                                                                                                                                              | Os demais artefatos permanecem privados, sem tag/release/publicação automática.                             |

Essas pendências bloqueiam a distribuição dos artefatos indicados, mesmo com
as verificações técnicas aprovadas. A documentação pública deve distinguir
plataforma/motor Freecorps 1.0 e cliente MIT,
com bibliotecas independentes preparadas e restrições por artefato, sem chamar
toda a stack de FOSS ou prometer suporte fiscal ainda não comprovado.

## Reprodução

Com Bun 1.4.0 e dependências do lock:

```powershell
bun run licenses:inventory
node scripts/prepare-package-notices.mjs
bun run licenses:check
bun run packages:build
bun run sdk:prove
bun run xml:prove
bun run distribution:prove
bun run ci:boundaries
```

O primeiro comando consulta o registry; os checks usam o inventário versionado
sem rede. O check recalcula identidades, fontes, integridades e entradas diretas
do lock e restringe licenças às famílias revisadas, sem exceção para
declarações ausentes. Não autentica novamente `declaredLicense` ou `repository` no
registry. Alterações nesses metadados exigem nova coleta e revisão do diff,
mesmo quando ambas as licenças pertencem a famílias já conhecidas.
Revise esta matriz após qualquer mudança de dependência.
As provas de instalação acessam o registry, mas não serviços fiscais nem contas
SaaS. `distribution:prove` empacota cada pacote pelo seu campo `files` e
confere bytes dos tarballs, avisos, exports, dependências locais, arquivos
proibidos, padrões de credenciais e cópias do corpus versionado. Seu sucesso
comprova os bytes empacotados, não remove os bloqueios acima. Com `--registry`,
a prova confere os bytes publicados e instala pelo npm. Evidências e
limites da varredura de histórico ficam em evidence/83.
