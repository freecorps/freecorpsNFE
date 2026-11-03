# Licença do SDK

O cliente SDK e os quatro contratos externos incorporados no JS e nas declarações
usam MIT, com texto em `LICENSE`. Titular do código próprio: FREECORPS TECNOLOGIA
DA INFORMACAO LTDA. São permitidos uso comercial e uso por concorrentes sob MIT.
A licença restritiva da plataforma e do motor não se aplica a este cliente.

Os arquivos compartilhados MIT são `external.ts`, `references.ts`, `registry.ts`
e `webhooks.ts` de `packages/contracts/src`. O pacote não incorpora fiscal-core,
fiscal-nfe ou backend. A verificação do build recusa fontes e declarações fora
do escopo MIT explícito. Zod mantém MIT; seus avisos acompanham o pacote em
`THIRD_PARTY_NOTICES.txt`. `NOTICE` identifica as atribuições próprias.

Publicado no npm em 0.1.0, aceito pelo mantenedor em 01/11/2026 por versão e hash do tarball.
O aceite é independente da licença Freecorps, dos XSDs e dos datasets, ausentes
deste artefato. O cliente REST precisa
de um serviço compatível; MIT não concede serviço ou acesso gratuito à API.
O export `@freecorps/freecorpsnfe-sdk/webhooks` verifica assinatura sem conta ou backend SaaS.
Nenhum dataset, corpus interno ou schema XSD é incorporado neste pacote.
