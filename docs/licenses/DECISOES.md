# Política de licenciamento aprovada

A política do projeto está definida nos oito pontos abaixo. O titular declarado
é FREECORPS TECNOLOGIA DA INFORMACAO LTDA, CNPJ 63.113.119/0001-90.
A razão social e o CNPJ foram conferidos em comprovante cadastral privado.
O documento e os demais dados cadastrais ficam fora do repositório.
O comprovante identifica a empresa; não comprova titularidade de cada contribuição.

A licença própria restringe ofertas concorrentes, inclusive gratuitas.
Permissões concedidas anteriormente sob outras licenças continuam aplicáveis
às respectivas versões. Os recibos de ensaios anteriores preservam os textos
e hashes que foram efetivamente verificados.

| Ponto | Decisão aprovada                                                                        | Aplicação                                                                                      |
| ----- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1     | Incorporar o motor em ERP para terceiros exige autorização                              | LICENSE, seções 1 e 5; integração à API da Freecorps segue contrato do serviço                 |
| 2     | SDK cliente em MIT; plataforma e motor sob licença restrita                             | LICENSES/MIT.txt e first-party.json delimitam os arquivos de integração                        |
| 3     | Uso interno ilimitado no mesmo grupo; terceiros independentes exigem autorização        | LICENSE, seções 1 e 3; contabilidades, franquias e associações não são grupo por mero contrato |
| 4     | Serviços técnicos remunerados em instalação controlada pelo cliente são permitidos      | LICENSE, seção 4; oferta fiscal hospedada como produto do prestador exige autorização          |
| 5     | Forks de colaboração são permitidos; produto concorrente gratuito também é restrito     | LICENSE, seções 3 e 5; build interno pelo destinatário é permitido                             |
| 6     | Versão modificada distribuída ou servida a terceiros exige fonte correspondente         | LICENSE, seção 6; mudanças só internas não precisam ser públicas                               |
| 7     | Titular identificado; contribuições sem cessão automática de autoria                    | CONTRIBUTING.md e CONTRIBUICOES.md; concessão adicional aceita expressamente                   |
| 8     | Conservar avisos; versões modificadas não oficiais; logo não obrigatório no uso interno | LICENSE, seção 7                                                                               |

## Origem e limites do texto

A base consultada foi [Perimeter 1.0.1](https://polyformproject.org/licenses/perimeter/1.0.1).
O [projeto de origem](https://github.com/polyformproject/polyform-licenses#license)
permite adaptar o texto, mas exige remover seu nome e domínio da licença modificada.
Por isso LICENSE tem nome próprio, não usa o identificador SPDX da licença de
origem e não se apresenta como versão oficial dela.

O texto próprio inclui as distinções aprovadas de grupo, prestação de serviços,
integração e código correspondente. A concessão de patentes, preservação de
direitos legais, prazo de 32 dias no primeiro aviso e ausência de garantia
seguem a estrutura da base. A versão fica fixada em 1.0, sem alteração retroativa.
Essas cláusulas são uma minuta operacional adotada para preparação privada,
não um parecer jurídico. Revisão jurídica e comprovação da cadeia de direitos
permanecem requisitos antes da distribuição externa.

Hospedagem dedicada na infraestrutura do prestador não recebeu uma exceção
genérica. Está permitida a administração por conta do cliente nos limites
da seção 4. Uma oferta fiscal hospedada como produto próprio, mesmo isolada
por cliente, exige autorização. Casos comerciais novos devem ser formalizados
por escrito, sem alterar silenciosamente a licença de versões já recebidas.

O MIT do cliente e dos quatro contratos externos é uma concessão efetiva:
pode ser usado comercialmente, inclusive por concorrentes, sem transferir a
restrição do motor para esses arquivos. Não inclui fiscal-core, fiscal-nfe,
backend nem o restante de contracts. O build verifica fontes JS e declarações
emitidas contra a lista explícita. Adicionar um arquivo a essa lista é uma
decisão de licença, não uma correção automática de build.

## Ratificação de 07/10/2026

O mantenedor escolheu na #83 manter a Freecorps 1.0 para a
plataforma, o fiscal-core e o fiscal-nfe, e MIT para o SDK e os quatro contratos
externos. A proposta Apache-2.0 do plano original foi descartada. Por isso
a plataforma e o motor não são apresentados como FOSS nem como open source.
A ratificação não autorizou publicação. Ela veio do aceite por pacote de
01/11/2026, que publicou sdk, fiscal-core, fiscal-nfe e fiscal-nfse no npm; os
demais manifests continuam `private: true` e os bloqueios da [matriz de distribuição](DISTRIBUTION.md) seguem valendo,
exceto os pareceres `freecorps-legal-review` e `sdk-legal-review`, substituídos
em 20/10/2026 por [decisão do mantenedor](DISTRIBUTION.md#decisões-do-mantenedor-em-20102026).
