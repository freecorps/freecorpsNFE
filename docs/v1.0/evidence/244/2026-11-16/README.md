# Sefin restrita: tomador com NIF e 404 de DPS ausente

Janela de produção restrita de 16/11/2026 no perfil hospedado
`prod:elated-possum-295` (`PRODUCT_ENV=sandbox`, `FISCAL_ENV=disabled`),
pelo roteiro da fase 3 de
[emissao-nfse.md](../../../../operacao/emissao-nfse.md#fase-3-produção-restrita).
Ela cobre os itens 1 e 2 da
[#244](https://github.com/freecorps/freecorpsNFE/issues/244). O item 3, a
DPS com o grupo `IBSCBS`, continua à espera da classificação oficial pedida
na [#6](https://github.com/freecorps/freecorpsNFE/issues/6) e não foi
tentado. Nenhum dado de produção fiscal foi tocado: só a produção restrita
(`tpAmb` 2) e o ambiente sandbox da plataforma.

| Campo                | Valor                                                                               |
| -------------------- | ----------------------------------------------------------------------------------- |
| Operador             | Agente de código, com a autorização do mantenedor na sessão                         |
| Janela aberta        | 2026-11-16T17:39:56Z (`FNFE_NFSE_RESTRICTED_COMPANIES` primeiro, transporte depois) |
| Janela fechada       | 2026-11-16T17:41:41Z (as duas variáveis removidas e conferidas ausentes)            |
| SHA no passo 1       | `c04cf707013b01c07d32002866abf25b9ee04688` (`/health`)                              |
| SHA na janela        | `0b7d6b0a77adadc6ee299ef8cf60635a0bc6db79` (#267, publicado às 17:35:47Z)           |
| Empresa              | Freecorps, a mesma da prova de 02/11/2026, A1 versão 1 do cofre                     |
| Variáveis no passo 1 | `installation`, `sandbox`, `disabled`, `off`, NFS-e ausentes, keyring presente      |

A `main` publicou o #267 entre o passo 1 e a abertura da janela; ele só
muda `fiscal-nfe`, nada da NFS-e. O probe gravou o `0b7d6b0` como build, e
o `/health` o confirmou depois da janela: o probe e as duas operações
rodaram nele.

## Item 1: tomador estrangeiro com NIF

Exportação do Simples de Campinas pela regra C6, competência 2026-11, USD
`1.00`, "TESTE DE INTEGRAÇÃO - SEM VALOR FISCAL", tomador fictício nos EUA
com NIF fictício de 9 dígitos. Pedido, acompanhamento e cancelamento foram
pela REST hospedada (`POST /v1/issuances`, `GET /v1/issuances/{id}` e
`POST /v1/issuances/{id}/cancellation`, com `X-Environment: sandbox`), com
uma chave de API criada para a janela, e não pelo console. O mantenedor
revogou a chave às 17:48:19Z, e ela passou a receber 401.

| Etapa        | Resultado                                                                     |
| ------------ | ----------------------------------------------------------------------------- |
| Aceite       | `sefin-nacional`, `producao-restrita`, série 2 nº 100002                      |
| Envio        | `authorized` em 6 s, uma tentativa `execute` sem `diagnostic`, NFS-e nº 2     |
| PTAX         | 5,651800 do boletim de 13/11/2026 (sexta), `brlAmount` 5,65                   |
| DPS e NFS-e  | `toma/NIF` presente e sem `cNaoNIF` nas duas; `cStat` 100 e `ambGer` 2        |
| Cancelamento | Motivo `9`, `registered` em 3 s, sequência 1, sem rejeição                    |
| Artefatos    | `dps`, `nfse`, `danfse`, `cancel-request`, `cancel-event`, com hash e tamanho |

Os XMLs foram baixados pela REST (`GET .../artifacts/{id}`) só para conferir
`toma` e foram apagados; os hashes estão em `issuances-sefin-2026-11-16.json`.

## Item 2: 404 de DPS ausente e timeout real

O probe consultou na Sefin restrita e na homologação da IMA a DPS de série
99999 e número 999999999999999, que não pode existir. As duas responderam 404
com o JSON de ausência (`outcome: "not-found"`, sem `diagnostic`):
`fiscalAbsence` em `packages/fiscal-nfse/src/nacional.ts` só aceita o 404
cujo corpo traz o envelope ou a lista de erros do fisco. É a primeira leitura
real do critério do 404, que os probes de 09/10/2026 não alcançaram.

A reconciliação depois de um timeout real **não foi provada**. Não há como
induzir o timeout no deployment hospedado sem efeito colateral: o prazo do
transporte está fixo no código, e encurtá-lo ou falhar a rede pediria uma
publicação de código no deployment ou uma falha de rede fora do controle da
janela. As duas operações terminaram na primeira tentativa, sem passar pela
reconciliação, e a consulta de uma DPS existente pela Sefin restrita também
não foi exercida. Fica como está em
[ISSUANCE.md](../../../../plataforma/ISSUANCE.md#o-que-não-está-provado).

## Adesão

| Fonte                    | `aderenteAmbienteNacional` | `aderenteEmissorNacional` |
| ------------------------ | -------------------------: | ------------------------: |
| ADN de produção restrita |                          1 |                         1 |
| ADN de produção          |                          1 |                         0 |
| Sefin restrita           |           404, sem leitura |               sem leitura |

O ADN de produção continua com `aderenteEmissorNacional` 0 para Campinas,
como em 09/10 e 02/11.

## Arquivos

- `probe-sefin-2026-11-16.json`: o `issuanceProbe:verify` com a adesão de
  produção, sem ids do deployment.
- `issuances-sefin-2026-11-16.json`: a emissão e o cancelamento, com
  tentativas, PTAX, chave de acesso e hash de cada artefato.
- `certificate-audit-sefin-2026-11-16.json`: as ações do A1 na janela (um
  probe e duas operações, cada uma com `authorized` e `success`).

Não estão aqui: ids de organização, empresa, emissão, operação, chave de API
ou certificado do deployment, o XML, o PDF, a chave de deploy e o keyring.
