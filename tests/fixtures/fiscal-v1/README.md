# Corpus fiscal sintético

Escrito à mão para testes, sem captura de tráfego ou dados de clientes. Não
contém CNPJ, CPF, certificados, assinaturas, credenciais ou documentos reais.
URLs em namespace são identificadores XML; não são destinos de requisição.

O manifesto fixa hashes SHA-256 dos bytes UTF-8, versões do envelope e resultado
esperado. A versão 2 retirou os cinco casos que só o parser NFC-e do backoffice
legado consumia (recibo, duplicidade, ambiente divergente, XML malformado e
entidade proibida), aposentado na #345; eles continuam no histórico do Git.

`distribution-empty.xml` foi preparado para a B06 e continua com somente
integridade/sintaxe verificadas. Não comprova integração com a SEFAZ ou validade
contra XSD. A captura NF-e entregue tem testes próprios no pacote, em
`packages/fiscal-nfe/distribution.test.ts`, e contrato em
[CAPTURE.md](../../../docs/plataforma/CAPTURE.md); este arquivo não os substitui.

Certificados e chaves de teste são gerados em memória para cada execução
(`tests/helpers/certificates.ts`); não copiar A1 real para o corpus.

Mudanças intencionais no corpus atualizam versão/hashes e comportamento esperado
no mesmo PR. Conservar casos antigos quando forem necessários para regressão.
