# Material de divulgação por entrega

Este material é um rascunho do candidato. Não foi publicado como anúncio,
tag, release ou pacote. Nome comercial: Freecorps Fiscal, decidido pelo
mantenedor em 18/10/2026.

A divulgação segue a [ADR 0011](../adr/0011-entregas-graduais.md). Cada
anúncio seleciona capacidades e artefatos aceitos na issue da entrega, com
SHA, destino e limites.
Não há data comum ou lançamento global; publicação e habilitação precisam
ser conferidas separadamente.

## Texto para revisão

Infraestrutura fiscal para software brasileiro. Comece importando um XML
de NF-e modelo 55, acompanhe o processamento e consulte itens e JSON pelo
contrato REST. Integre mudanças por webhooks assinados, com tratamento de
duplicatas no receptor.

Importação não exige certificado fiscal. A captura é uma jornada distinta:
captura fiscal real por empresa, com ativação pelo dono e sem manifestação.
Cada empresa a ativa no console, com o certificado A1 dela, e a plataforma só
lê a distribuição DF-e. A primeira captura real no site foi de uma empresa
piloto, em 22/10/2026. Emissão com validade fiscal e cálculo tributário não
fazem parte da oferta disponível. O SDK e as bibliotecas fiscais estão no npm
desde 01/11/2026, e o código está no repositório público desde 03/11/2026.
Anunciar cada artefato
somente depois do aceite e da publicação correspondentes.

## Notas da versão

O rascunho completo está em [RELEASE-NOTES](RELEASE-NOTES.md): o que entra
por área, o que fica fora, orientação para quem usava o serviço anterior,
estado da distribuição e pendências antes da publicação. As notas não
declaram licença; remetem a [LICENSING.md](../../LICENSING.md).

## Roteiro de demonstração

Duração prevista de 20 a 25 minutos, em três blocos independentes. Cada bloco
diz o que mostrar, o que afirmar e o que não afirmar. Se um bloco não puder
ser executado de verdade, registre a limitação e pule-o; não simule sucesso.

### Preparação

1. Fixar o SHA do console e do backend e usar uma instalação de teste
   autorizada. Registrar origem, versão mostrada no painel, dataset sintético
   e estado dos transportes (webhooks e fiscal).
2. Conta sintética, organização de demonstração, empresa criada por
   Primeiros passos → Explorar demonstração e projeto em sandbox. Gerar a
   chave restrita antes da gravação; não gravar a exibição do segredo.
3. Pasta com os quatro downloads de `/docs/`, o SDK instalado pelo npm
   (`@freecorps/freecorpsnfe-sdk` 0.1.0), um túnel HTTPS e o receptor de exemplo. Terminais sem histórico
   de credenciais visível.

### Bloco 1: do XML ao JSON

1. Abrir a landing e `/docs/` sem sessão. Mostrar a tabela de capacidades:
   o que está disponível, o que está em construção e o que está fora da oferta disponível.
2. No painel, importar `nfe-demonstracao.xml`. Mostrar a operação
   assíncrona até concluir, o documento, os itens e o JSON.
3. Executar `node quickstart-curl.mjs` e, com o SDK,
   `node --experimental-strip-types quickstart.ts`. Comparar IDs, total e
   SHA-256 do original nas duas saídas. Mostrar o total como texto decimal.
4. Repetir com a mesma `Idempotency-Key` e mostrar `reused: true`.

Afirmar: importação sem certificado, identidade preservada, valores exatos.
Não afirmar: autorização da nota, consulta ao fisco ou validade fiscal; o
documento é sintético e a situação fiscal deriva só do XML.

### Bloco 2: webhooks

1. Cadastrar o destino com a URL do túnel e os eventos documentais e de
   importação. Guardar o segredo no arquivo local, fora da tela.
2. Importar com nova chave de idempotência. Mostrar no painel a entrega
   `Entregue / HTTP 204` e, no receptor, a assinatura verificada.
3. Usar Reenviar entrega e consultar o SQLite: contagem de eventos e efeitos
   por recurso iguais. Mostrar a mudança de `resourceVersion` quando a
   projeção emitir `document.updated`.

Afirmar: HMAC sobre os bytes originais, entrega pelo menos uma vez,
deduplicação no receptor por `eventId`. Não afirmar: ordem garantida,
exatamente uma vez ou entrega sem habilitação do operador. Se o painel
mostrar "O envio está desativado neste ambiente", mostrar esse estado e o
contrato de assinatura em `/docs/webhooks#assinatura`, sem fingir entrega.

### Bloco 3: captura de NF-e

1. Mostrar os requisitos e limites da captura (`/docs/captura-nfe` e
   [CAPTURE](../plataforma/CAPTURE.md#liberação-fiscal-no-site)): 90 dias de
   disponibilidade na fonte, uma consulta por segundo enquanto há fila e o
   intervalo mínimo da empresa, de 1 a 24 horas, no fim da fila, sem
   manifestação.
2. No painel, mostrar que a empresa de demonstração não oferece certificado
   nem captura, e o cartão "Captura fiscal (Produção)" de uma empresa
   declarada: intervalo, termos, a revogação das chaves de produção e o passo
   "Iniciar captura fiscal".
3. Não ativar a captura fiscal de uma empresa real para a demonstração. Uma
   empresa já liberada só aparece com autorização dela e sem CNPJ, nome ou
   documento na tela; sem isso, mostrar o fluxo com a fonte sintética local e
   dizer que é sintética.

Afirmar, na formulação aprovada em 26/10/2026
([PUBLIC](../plataforma/PUBLIC.md#captura-fiscal-no-site-427)): captura fiscal
real por empresa, com ativação pelo dono e sem manifestação; a primeira foi
de uma empresa piloto, em 22/10/2026; resumo e XML conforme a
disponibilidade real da fonte. Não afirmar: disponibilidade para qualquer
empresa, preço ou plano da captura, XML completo garantido ou histórico além
de 90 dias.

### Encerramento

Revogar a chave de teste, desativar o destino, encerrar túnel e receptor e
apagar o arquivo de segredos. Guardar recibo sanitizado com SHA, resultados,
limitações e hashes. Revisar a gravação antes de divulgar: sem segredo,
e-mail pessoal, ID de ambiente privado ou dado de cliente.

O piloto da #49 foi concluído em 07/10 pelo próprio mantenedor, que dispensou
o participante externo; ver [PILOT](PILOT.md). Não descrever o piloto como
integração externa independente nem usar depoimentos, documentos de cliente
ou casos de piloto sem autorização de divulgação e dados publicáveis.

## Checklist de divulgação

- [ ] Revisar cada promessa contra [PUBLIC](../plataforma/PUBLIC.md), contrato e evidências
      do SHA candidato. Identificar o que foi integrado e o que foi publicado.
- [x] Registrar o piloto #49 e resolver ou aceitar explicitamente seus
      obstáculos, incluindo a revisão humana aplicável. Concluído em 07/10 no
      recorte assistido, conforme [PILOT](PILOT.md).
- [x] Conferir #50 antes de anunciar captura fiscal real. Aceita pelo
      mantenedor em 26/10/2026, com a formulação pública aprovada no mesmo
      dia (#427). Não tratar a ausência de XML na fonte como falha resolvida
      pela interface.
- [x] Para os artefatos selecionados, resolver as condições da #83 e conferir termos,
      direitos, avisos e hashes. Confirmar nomes e versões no registry.
      Feito em 01/11/2026 para sdk, fiscal-core, fiscal-nfe e fiscal-nfse
      (recibo).
- [x] Decidir o nome comercial. Freecorps Fiscal, decidido em 18/10/2026;
      landing, documentação e console já o usam. O domínio continua
      `nfe.freecorps.com.br` e o repositório, `freecorpsNFE`.
- [ ] Revisar [RELEASE-NOTES](RELEASE-NOTES.md) no SHA final, retirando o que
      não estiver aceito e conferindo a seção de licenças contra LICENSING.md.
- [x] Ensaiar o roteiro de demonstração no ambiente escolhido e guardar o
      recibo sanitizado. Ensaiado em 20/10/2026 no ambiente hospedado; o
      Bloco 3 ficou limitado à ausência de captura
      (recibo).
- [ ] Registrar na issue da entrega o aceite e a autorização do mantenedor para
      site, indexação, pacotes, tag, release notes e anúncio selecionados.
- [x] Conferir instalação dos exatos bytes aceitos e os recibos de publicação.
      A prova pelo registry de 01/11/2026 instalou do npm os bytes aceitos
      (recibo).
- [ ] Gerar o build com `PUBLIC_SITE_ORIGIN` somente após a autorização e
      verificar URLs, headers, canonical e sitemap no destino final; testar
      acesso ao painel, cadastro quando habilitado e recuperação de conta.
- [x] Atualizar os links que apontavam para o GitHub privado. Em 03/11/2026
      o repositório passou a público, e guias e landing deixaram de marcá-lo
      como privado ([PUBLIC.md](../plataforma/PUBLIC.md#promessas-e-evidências)).
- [ ] Registrar na issue da entrega e na #85 o escopo divulgado, SHA, ambiente,
      recibos, limites e pendências. O merge não comprova publicação ou habilitação.

Nenhuma caixa é concluída apenas pela existência deste documento. O fluxo
operacional detalhado permanece em [release.md](../operacao/release.md).
