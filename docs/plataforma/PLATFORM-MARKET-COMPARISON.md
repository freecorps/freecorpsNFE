# Comparação comercial dos planos da plataforma

Referências de páginas oficiais consultadas em 27/10/2026 para a #429 e já
registradas no repositório. Esta revisão preserva essa coleta, sem nova consulta
remota. Valores públicos, sem negociação ou descontos anuais. A comparação
trata preço de entrada, unidade e escopo; não mede qualidade ou equivalência
de volume entregue.

O redesenho foi aprovado: Gratuito permanente, Intermediário de R$ 149/mês,
Grande de R$ 499/mês e Personalizado por orçamento, sem piso público. Não há
implantação obrigatória. Consultoria opcional custa R$ 180/h. **São preços do
catálogo ainda desligado, não ofertas disponíveis.** Restauração real, arquivo
econômico, margem medida e fundos reais são condições de lançamento.

A antiga referência assistida de R$ 299/R$ 999 com implantação deixa de ser a
tabela de trabalho. R$ 149/R$ 499 já correspondem às cotas redesenhadas em
[`planCatalog.ts`](../../platform/convex/lib/planCatalog.ts), com limites de
banco, arquivos e operação. A aprovação não comprova aceitação pelo mercado.

## Preços publicados

| Fornecedor e plano                                                          |        Mensalidade | Unidade e capacidade anunciadas                                                    | Comparabilidade                                                             |
| --------------------------------------------------------------------------- | -----------------: | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Focus Solo](https://focusnfe.com.br/precos/)                               |           R$ 94,90 | 1 CNPJ/CPF, 100 documentos; adicional R$ 0,11/documento                            | Emissão e recebimento; sem setup                                            |
| [Focus Start](https://focusnfe.com.br/precos/)                              |          R$ 119,90 | 3 CNPJs/CPFs, 100 documentos por CNPJ; adicional R$ 0,11/documento e R$ 39,90/CNPJ | Franquia por CNPJ, não um saldo conjunto de 300                             |
| [Focus Growth](https://focusnfe.com.br/precos/)                             |          R$ 572,00 | CNPJs/CPFs ilimitados, 4.000 documentos; adicional R$ 0,125/documento              | Emissão e recebimento contam no consumo                                     |
| [Espião Basic](https://espiaonfe.com.br/planos/)                            |           R$ 41,90 | 1 empresa; consultas NF-e anunciadas sem limite                                    | Referência de consulta pelo produto; não assumir API de histórico incluída  |
| [Espião VIP](https://espiaonfe.com.br/planos/)                              |          R$ 106,90 | 5 empresas; automação NF-e e API Histórico DF-e                                    | Referência mais próxima de captura com integração                           |
| [Espião Freedom](https://espiaonfe.com.br/planos/)                          |          R$ 171,90 | Tabela informa 10 empresas; inclui recursos do VIP                                 | A mesma página também diz 10+ e ilimitado; confirmar capacidade no contrato |
| [NFE.io Base / Crescimento / Escala](https://nfe.io/precos/emissao-nfe/)    | R$ 190 / 265 / 375 | 250 / 500 / 1.000 notas por mês                                                    | Página de emissão NF-e, não preço de captura                                |
| [Qive Inicial / Rotinas / Gestão / Customizado](https://qive.com.br/planos) |       Sob consulta | Consulta, guarda e download; API aparece no Gestão                                 | Não publica valor que permita calcular uma diferença de preço               |

A Focus oferece teste de 30 dias e Enterprise sob consulta. Os preços usados
são do domínio principal; a busca também encontrou uma versão antiga em
`2025.focusnfe.com.br`, com valores menores, que foi descartada. A franquia de
documentos não equivale às consultas de captura da nossa plataforma.

A [indexação Focus](https://focusnfe.com.br/produtos/indexacao-de-documentos/)
é separada: R$ 0,01 por nota indexada, com mínimo de R$ 59,90/mês. Inclui
interface de busca, relatórios e acesso aos arquivos. A página informa guarda
por seis anos enquanto o contrato estiver ativo. Assim, comparar nosso
console completo apenas com o preço do gateway subestima esse pacote Focus.
O mínimo de indexação usado abaixo não é uma cotação para qualquer estoque;
a base de faturamento ao longo da retenção deve ser confirmada comercialmente.

O Espião anuncia implantação zero nos três planos recorrentes e teste de
sete dias. Sua [FAQ da API](https://ajuda.espiaonfe.com.br/api-de-integracao/perguntas-frequentes-faq)
explica que a API Histórico lê documentos já capturados pela plataforma;
não força uma consulta manual à SEFAZ. A API exige plano contratado e não
fica disponível no teste gratuito. Isso limita a equivalência com nosso
controle de captura pela API. Sua página de planos informa guarda enquanto
a conta estiver ativa, com exclusão no cancelamento ou exclusão da empresa.
Essa condição difere da nossa política de retenção e não a altera.

A NFE.io anuncia onboarding, CNPJs ilimitados e armazenamento por 11 anos
com espaço ilimitado nos diferenciais da página. São condições do produto
de emissão consultado; não atribuir esse preço à recepção nem extrapolar a
guarda para depois do cancelamento. A Qive não permite uma comparação
numérica sem proposta comercial. Nuvem Fiscal foi excluída como referência
ativa: o [resultado indexado da página oficial](https://www.nuvemfiscal.com.br/)
anunciava desativação em 31/07/2026; a abertura direta retornou 502.
Não usar sua tabela histórica como oferta atual.

## Comparação com o catálogo desligado

A plataforma importa e captura NF-e e fornece originais e
dados normalizados pelo console, API e SDK. Emissão real não está disponível.
Guarda, permissões e reconciliação fazem parte do produto; a pesquisa não
quantificou o valor que os clientes atribuem a essas diferenças.

| Mensalidades, sem equivalência de volume | Nosso catálogo desligado | Focus gateway | Focus com mínimo de indexação | Diferença frente ao mínimo com indexação |
| ---------------------------------------- | -----------------------: | ------------: | ----------------------------: | ---------------------------------------: |
| Intermediário / Start                    |                   R$ 149 |     R$ 119,90 |                     R$ 179,80 |                                  -17,13% |
| Grande / Growth                          |                   R$ 499 |     R$ 572,00 |                     R$ 631,90 |                                  -21,03% |

Sem implantação obrigatória, doze mensalidades do Intermediário somam
R$ 1.788, contra o mínimo de R$ 2.157,60 do Start com indexação. Grande soma
R$ 5.988, contra R$ 7.582,80 do Growth com indexação. São contas de catálogo,
sem excedentes, serviços opcionais ou descontos. O mínimo de indexação não
é uma cotação para qualquer estoque acumulado.

O Intermediário fica 24,27% acima do Start sem indexação. Grande fica 12,76%
abaixo do Growth sem indexação. Os dois ainda superam as referências Espião
VIP e Freedom de R$ 106,90/R$ 171,90.

Desde 29/10/2026, o catálogo do Intermediário prevê 5 empresas, o mesmo número do
Espião VIP ([ADR 0010](../adr/0010-guarda-em-camadas-e-custo-dos-planos.md),
decisão 4). Isso não prova que um pacote seja melhor
ou mais barato para a mesma carga. Espião, Focus e nossa plataforma contam
unidades diferentes e têm condições de guarda distintas. A gratuidade
permanente também exige limites e financiamento que não se deduzem de um
teste gratuito de outro fornecedor.

## Pacote aprovado e limites da comparação

| Condição                              | Gratuito | Intermediário | Grande     | Personalizado                   |
| ------------------------------------- | -------- | ------------- | ---------- | ------------------------------- |
| Preço do catálogo, ainda não ofertado | R$ 0     | R$ 149/mês    | R$ 499/mês | Por orçamento, sem piso público |
| Implantação obrigatória               | Não      | Não           | Não        | Não                             |
| Arquivos acumulados                   | 128 MiB  | 512 MiB       | 2 GiB      | Orçado                          |
| Banco lógico                          | 32 MiB   | 64 MiB        | 256 MiB    | Orçado                          |
| Empresas                              | 1        | 5             | 10         | Orçado                          |
| Aporte prévio da empresa              | R$ 60    | R$ 108        | R$ 280     | Calculado antes da admissão     |

A [tabela completa](PLATFORM-PLAN-PROPOSAL.md) fixa as cotas mensais e por
organização. Consultoria de R$ 180/h é opcional e não condiciona a contratação.
Não há capacidade ilimitada pelo nome Personalizado nem piso herdado da
antiga referência assistida. Expansões também exigem orçamento.

Não converter 1.000 consultas em 1.000 notas. Os 64 MiB de banco lógico do
Intermediário incluem campos de sistema nos registros medidos pelo guard,
mas não índices ou toda a fatura física. Não dividir XML médio por estoque
para prometer quantidade de notas. Medir itens, eventos, listagens, reatividade,
tráfego e retenção com carga equivalente antes de comparar custo por documento.

O Intermediário pode preencher os 512 MiB de arquivos em dois meses usando
a entrada máxima nos dois ambientes; o banco pode limitar antes. A entrada
mensal renova, o estoque não. A pesquisa não encontrou tetos em bytes
comparáveis nas páginas Focus e Espião; não é evidência de ausência de
restrições contratuais. Grátis permanente não significa entrada ou estoque
infinitos, nem permite excluir histórico ao atingir limite.

## Viabilidade ainda condicionada

A [memória de custo](PLATFORM-COSTS.md) já usa os preços aprovados, os estoques
novos e suporte-alvo de R$ 12/R$ 50. A amortização econômica dos aportes é
R$ 9/R$ 23,33 por mês durante 12 meses, mas o dinheiro precisa existir inteiro
antes da admissão. O modelo não presume permanência mínima nem receita futura.
O cancelamento após um mês deixa exposição de R$ 69,05/R$ 152,78 para a empresa
no cenário de estresse, considerando o aporte integral e a operação do mês.

As margens em estresse são 20,10% e 20,82% no cenário de um bucket, contra
meta de 20%. Duas cópias independentes futuras deixam o Intermediário em
19,50%; dobrar suporte deixa ambos abaixo da meta. O backup incremental
implementado usa um bucket e um objeto por hash. Ele não é arquivo econômico
e não comprova reativação na origem. O ensaio real em banco isolado passou,
mas a origem recusou recriar IDs apagados. Contas abertas mantêm todo o
estoque quente. Essas margens são condicionais e não incluem financiar esse
estoque após o fim dos pagamentos; não autorizam oferecer os planos.

O Gratuito exige R$ 60 de aporte e subsídio recorrente previamente alocado.
A provisão de R$ 17,00/mês cobre o custo exato em estresse de R$ 16,8030583304
no cenário modelado, sujeito à medição da operação.
Usar 10% da margem modelada exigiria cinco Intermediários na base ou seis no
estresse por Gratuito, além do aporte inicial. São estimativas condicionais,
sem liberar vagas nem financiar guarda com conversão futura.

O script `paid-plans.mjs` contém
as contas em `rows`, `sensitivities`, `marketComparisons` e `checks`.
Ele não certifica disposição a pagar, margem real ou oferta lançada.
O próximo aceite comercial exige pacote compreensível, custo medido,
atendimento viável e todos os gates satisfeitos. Até lá, catálogo e preços
continuam indisponíveis para oferta, sem alterar a política de retenção.
