# Regras por área

Leia só as seções das áreas que o diff toca. Cada regra aponta a fonte; em
caso de divergência, a fonte vence e a divergência vira achado.

## Importação NF-e

Fontes: [IMPORTS.md](../../../docs/plataforma/IMPORTS.md),
[DOCUMENTS.md](../../../docs/plataforma/DOCUMENTS.md),
[NFE-SCHEMAS.md](../../../docs/plataforma/NFE-SCHEMAS.md),
[DANFE.md](../../../docs/plataforma/DANFE.md).

- **Identidade:** organização + empresa + ambiente + modelo + chave. Bytes
  iguais dão `DUPLICATE`; XML completo diferente para a mesma identidade dá
  `ARTIFACT_CONFLICT`, guarda os dois e mantém a versão publicada. Não existe
  deduplicação global por hash.
- **Original:** `documentArtifacts` guarda bytes imutáveis com SHA-256 e
  procedência por importação. Schema desconhecido, identidade inválida ou
  empresa que não confere guardam o original e o diagnóstico, sem criar
  documento.
- **Schemas:** só NF-e `versao="4.00"` modelo 55. Os pacotes ficam fixados em
  `packages/fiscal-nfe/schemas/manifest.json` e mudam só por
  `scripts/fiscal/sync-nfe-schemas.py`; validação offline, nada baixado em runtime.
  Entrada nova em `SCHEMA_CATALOGS` declara os campos decimais tipados.
- **Escalas:** `FIELD_SCALES` em `fiscal-nfe/src/normalize.ts`; escala acima
  do limite é recusada, nunca arredondada.
- **Assinatura:** técnica não é autorização fiscal. Cadeia do certificado e
  origem fiscal não são verificadas e não podem ser apresentadas como se
  fossem.
- **XML seguro:** DOCTYPE e ENTITY recusados, só UTF-8, limites de tamanho,
  profundidade e nós (`fiscal-nfe/src/xml.ts`).
- **Eventos:** só os listados em NFE-SCHEMAS.md. Cancelamento (110111) é o
  único que muda a situação. 110300 nunca significa pagamento confirmado.
  Evento exclusivo do emitente exige o emitente como autor
  (`NFE_EVENT_AUTHOR_NOT_ISSUER`). Tipo novo traz parser, normalização,
  efeito, fixture sintética e teste.
- **Reprocessamento:** só um `PARSER_VERSION` novo reabre recusas técnicas.
  Campo novo que não muda a afirmação fiscal entra na exclusão de `claims` em
  `fiscal-nfe/src/status.ts`, ou o reprocessamento vira
  `PROCESSING_DISAGREEMENT`.
- **Totais:** `total` é sempre `ICMSTot/vNF`; `vNFTot` ausente é `null`. A
  plataforma não calcula imposto: tributos são `basis: declared`.
- **DANFE:** `tpAmb` 2 leva a marca "SEM VALOR FISCAL"; datas recortadas do
  texto do XML.

## Emissão NFS-e

Fontes: [ISSUANCE.md](../../../docs/plataforma/ISSUANCE.md) e
[ADR 0004](../../../docs/adr/0004-motor-de-emissao-nfse.md).

- **Ambientes:** `sandbox` + `simulated` é o padrão; `producao-restrita`
  exige as duas variáveis do sandbox de transporte; `production` só existe
  no deployment fiscal próprio, hoje `deployment: null` em
  `deploy/issuance-production.json`. O transporte congela no aceite, e o
  cancelamento usa o mesmo.
- **Gate de produção:** URL do plano versionado + `APP_ENV=installation` +
  `FNFE_ISSUANCE_ENV=production`, juntos; combinação parcial é erro de
  configuração. Uma só decisão, `productionTransportAllowed`, lida pelo worker
  e pelo cofre. O gate muda só pelos workflows: ligar com aprovação de outra
  pessoa, desligar em emergência sem ela. `issuanceGateEvents` só recebe
  acréscimos. Gate desligado bloqueia nota nova, não consulta nem
  cancelamento. Em produção, marcadores `[simular:` são recusados.
- **Numeração:** `dpsSequences` por empresa + ambiente + série, reservada na
  mesma transação da emissão. Número rejeitado nunca é reutilizado; lacunas
  são aceitas. Rota e IBS/CBS são conferidos antes de reservar.
- **Snapshot:** perfil, rota, decisão IBS/CBS, transporte, `dhEmi`, `dCompet`
  e número congelados com SHA-256.
- **Valores:** `money` e `multiplyRounded` de `fiscal-nfse/src/decimal.ts`;
  ISS em 2 casas half-up; PTAX em 6 casas, BRL em 2. Na API, JSON number ou
  escala maior é `INVALID_REQUEST`, nunca arredondado.
- **Datas:** `issueDate` não pode ser futura; competência não passa do mês de
  emissão; `dCompet` é o menor entre o último dia da competência e a emissão.
  IBS/CBS segue `dCompet`, a rota segue a data de emissão.
- **Transmissão:** DPS validada no XSD antes de assinar; DPS assinada
  persistida antes do primeiro envio; `submissions` incrementado antes de
  cada envio. Timeout, resposta ilegível e "DPS já existe" são incertos e vão
  para reconciliação, que consulta pelo Id da DPS antes de repetir. Só o 404
  com o envelope JSON do fisco prova ausência; o resto é
  `CONSULT_INCONCLUSIVE`. `NFSE_DPS_MISMATCH` nunca autoriza.
- **Cancelamento:** Id do evento determinístico; motivo `1`, `2` ou `9`,
  texto de 15 a 255 caracteres. Cancelamento rejeitado mantém a nota
  autorizada. Substituição não existe.
- **Alvos:** Sefin e Campinas diferem em assinatura, `cTribMun`, inscrição
  municipal e grupo IBSCBS; confira a seção de alvos do ISSUANCE.md para o
  alvo tocado.
- **Prova real:** só evidência do fisco no ambiente certo; a lista do que
  falta provar está no ISSUANCE.md.

## ABRASF

- A importação saiu em 02/11/2026. XML ABRASF novo recebe
  `XML_NAMESPACE_UNSUPPORTED`; reprocessar lote antigo é
  `409 OPERATION_CONFLICT`.
- Documentos existentes continuam legíveis, com situação `unknown` para
  sempre. Nenhuma mudança pode tirá-los da leitura nem inferir situação.
- Rota de emissão que resolve para ABRASF é recusada
  (`NFSE_ROUTE_UNSUPPORTED`).

## Captura

Fontes: [CAPTURE.md](../../../docs/plataforma/CAPTURE.md),
[ADR 0007](../../../docs/adr/0007-captura-fiscal-no-site.md) e
[ADR 0008](../../../docs/adr/0008-perda-fiscal-em-captura-de-integracao.md).

- **Gates:** `FNFE_CAPTURE_FISCAL=enabled`, `FNFE_CAPTURE_TRANSPORT=sefaz`,
  sem `captureFiscalHalts`, liberação da empresa e A1 válido da própria
  empresa, todos juntos. Variável ausente falha fechada.
- **Agenda:** cada consulta é agendada por stream, nunca por cron.
- **Parada geral:** adia consultas sem gastar cota, janela nem tentativas.
  Espera não é falha. Só `RefusedBeforeSend` prova que nada foi enviado.
- **NSU:** o checkpoint avança só sobre o prefixo contíguo de envelopes
  persistidos; o cursor remoto nunca é copiado para o checkpoint. 656 não
  move nada e espera 1 hora. Recuperação por `consNSU` tem limite por hora.
  Nenhum comando edita o cursor nem descarta evidência.
- **Perda aceita:** "Aceitar a perda" (`captures.acceptGap`) é o único avanço
  sem documento: só o owner, motivo obrigatório, só pelo console, registrado
  como `history_limited`.
- **Liberação:** ligar a liberação revoga as API keys de produção da empresa.

## Certificados

Fonte: [CERTIFICATES.md](../../../docs/plataforma/CERTIFICATES.md).

- Chave privada correspondente, uso de assinatura e autenticação de cliente,
  RSA de pelo menos 2048 bits e CNPJ no OID `2.16.76.1.3.3`; o CN não prova
  identidade.
- Envelopes AES-256-GCM presos ao contexto. Cada finalidade (`transport`,
  `capture-production`, `nfse-transport`, `nfse-production`, `nfse-probe`)
  tem política própria e não se cruza com outra.
- `withCertificate` nunca persiste nem registra a chave; `certificateAudit`
  nunca guarda corpo, PFX, senha ou chave. Certificados de teste são gerados
  em memória (`tests/helpers/certificates.ts`).

## Guarda

Fonte: [RETENTION.md](../../../docs/plataforma/RETENTION.md).

- XML, lotes, versões, identidade fiscal, tentativas e auditorias originais
  não são apagados enquanto a organização existe; depois do encerramento,
  até 31/12 do quinto ano seguinte, mais retenções legais.
- Chaves de idempotência não são apagadas para liberar cota.
- O único artefato substituível é o PDF do DANFE em cache, regenerado do
  original.
