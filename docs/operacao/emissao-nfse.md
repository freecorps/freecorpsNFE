# Emissão NFS-e: produção restrita e produção fiscal

Runbook do operador da emissão NFS-e, em duas partes:

- [Fase 3, produção restrita](#fase-3-produção-restrita): abrir o transporte
  real da NFS-e para uma empresa no deployment hospedado, emitir e cancelar
  uma nota de teste e voltar ao simulador (passos 1 a 8);
- [Fase 4, produção fiscal](#fase-4-produção-fiscal): o que a `main` já tem
  para a emissão com validade fiscal, o que ainda falta e a ordem até a
  primeira nota.

O comportamento da emissão (estados, gate de produção, probe de mTLS e adesão,
reconciliação e códigos) está no contrato
[ISSUANCE.md](../plataforma/ISSUANCE.md); este documento só descreve a
execução e muda a cada janela autorizada.

## Fase 3, produção restrita

Issue [#197](https://github.com/freecorps/freecorpsNFE/issues/197). O
perfil hospedado é o deployment Convex `prod:elated-possum-295`
(`APP_ENV=installation`, `PRODUCT_ENV=sandbox`, `FISCAL_ENV=disabled`,
`FNFE_CRONS=off`); o tipo `prod` do Convex não o torna produção fiscal. Abrir
o transporte real nele é exceção ao perfil "transporte fiscal desativado" e
precisa de autorização do mantenedor, registrada como a ativação de
`WEBHOOK_MODE` em [DEPLOY](deploy-producao.md). Nada aqui toca `FISCAL_ENV`: o
preflight de `scripts/deploy-platform.mjs` exige `disabled` e as variáveis da
NFS-e não fazem parte dele, então as publicações automáticas da `main`
continuam durante a janela e preservam as variáveis.

Comandos em Git Bash, a partir de `platform/`, com a chave de deploy do
deployment em `CONVEX_DEPLOY_KEY` só na sessão do operador (a mesma do secret
do environment `production`; nunca em arquivo versionado nem em log). Confira
o alvo antes de cada escrita.

### 1. Conferir o alvo e a versão

```sh
cd platform
export CONVEX_DEPLOY_KEY='prod:elated-possum-295|…'   # colar, sem gravar em arquivo
for name in APP_ENV PRODUCT_ENV FISCAL_ENV FNFE_CRONS FNFE_NFSE_SANDBOX_TRANSPORT FNFE_NFSE_RESTRICTED_COMPANIES; do
  printf '%s=%s\n' "$name" "$(bunx convex env get "$name")"
done
bunx convex env get FNFE_PLATFORM_CERT_KEYS > /dev/null && echo "FNFE_PLATFORM_CERT_KEYS presente"
curl -s https://elated-possum-295.convex.site/health
```

Esperado: `installation`, `sandbox`, `disabled`, `off`, as duas variáveis da
NFS-e ausentes e o keyring presente (o valor nunca é exibido). O `sha` do
`/health` precisa conter esta entrega.

### 2. Preparar a empresa no console

1. Owner ou admin da organização Freecorps abre
   `/app/<organização>/companies/<empresa>`, confere que a empresa é
   declarada com o CNPJ do titular do A1 e envia o PFX e a senha em
   Certificado. Espera o estado "Ativo": a validação confere senha, chave,
   prazo, uso de autenticação e o CNPJ no OID ICP-Brasil
   ([CERTIFICATES.md](../plataforma/CERTIFICATES.md)). O PFX não passa por nenhum outro
   canal.
2. Perfil NFS-e completo ([COMPANIES.md](../plataforma/COMPANIES.md)): Campinas
   (`3509502`), Simples (`opSimpNac` e `regApTribSN` conferidos com o
   contador), atividade 01.05 (`cTribNac` 010501, NBS) e, para o canal de
   Campinas, `cTribMun`, IBS/CBS e `campinasDpsSeries`.
3. **Número inicial.** O legado já autorizou e cancelou DPS em produção
   restrita e na homologação da IMA com séries próprias. Em
   "Número inicial da DPS", ambiente sandbox, defina para cada série um início
   acima de qualquer número já usado fora da plataforma; senão o Id coincide e
   a reconciliação acharia a nota alheia.
4. O operador da emissão com papel `owner`, `admin` ou `operator` e acesso à
   empresa. O console não pede projeto; uma integração que emita pela API
   precisa de projeto com concessão `documents:issue` e `documents:cancel` da
   empresa em sandbox.
5. No dashboard do deployment, tabela `companies`, anote `_id` e
   `organizationId` da empresa.

### 3. Abrir a janela só para a empresa

```sh
bunx convex env set FNFE_NFSE_RESTRICTED_COMPANIES '<companyId>'
bunx convex env set FNFE_NFSE_SANDBOX_TRANSPORT producao-restrita
```

A lista primeiro: com a variável de transporte sozinha, nenhuma empresa sai do
simulador. A tela de emissão da empresa passa a mostrar "Produção restrita do
fisco (homologação)"; as demais continuam no simulador.

### 4. Verificar mTLS e adesão, sem emitir

Em 09/10/2026, o probe deu `not-found` na Sefin restrita e na IMA e
`aderenteEmissorNacional` 1 no ADN restrito e **0** no ADN de produção. Os
probes rodaram antes do critério do 404 com JSON: provam o handshake mTLS, não
o formato do 404 (evidência).

```sh
bunx convex run issuanceProbe:verify '{"organizationId":"<organizationId>","companyId":"<companyId>","operator":"<login GitHub>","reason":"Fase 3 (#197): prova de mTLS e adesão antes da emissão"}'
```

Com `"productionAdhesion":true`, a resposta inclui a adesão lida no ADN de
produção. Prossiga só com `not-found`/404 na Sefin (e na IMA, para emitir em
Campinas). Registre
`aderenteEmissorNacional` das fontes, com a data: o de produção alimenta a
pré-condição de adesão da fase 4.

Para saber a alíquota e as regras que o fisco aplica ao serviço do perfil
(a rejeição L0006 compara `pAliq` com elas; no Simples sem retenção, a DPS vai
sem `pAliq`), leia os parâmetros municipais de
Campinas na competência da nota. Com `cTribMun` 001, o código completo é
`010501001`; repita com `010501` (complemento `000`) se o primeiro voltar 404:

```sh
bunx convex run issuanceProbe:verify '{"organizationId":"<organizationId>","companyId":"<companyId>","operator":"<login GitHub>","reason":"Fase 3 (#197): alíquota do ISS de Campinas para L0006","municipalityCode":"3509502","parameters":{"serviceCode":"010501001","competence":"2026-10","production":true}}'
```

Leia `parameters[].json` de `aliquota` (`Aliq` vigente na competência) e de
`regimes_especiais` nas duas fontes; os dados de produção restrita são de
teste, e a alíquota que vale é a de produção. Registre os valores como
evidência antes de ajustar o perfil.

### 5. Emitir e cancelar a nota de exportação de teste

Pelo console (`/app/<organização>/issuances`), com a empresa escolhida:
mercado exportação, tomador no exterior fictício (por exemplo
`nifAbsence` 2, "não exigência do NIF", e país `US`; o 1, "dispensado do
NIF", afirmaria uma dispensa que o tomador fictício não tem) com o endereço
completo que o XSD exige: código postal, cidade, estado ou região,
logradouro, número e bairro (sem bairro, a região ou `N/A`). Moeda USD, valor pequeno (`1.00`), descrição
"TESTE DE INTEGRAÇÃO - SEM VALOR FISCAL", data de hoje. Antes de enviar, o
quadro "Para onde a nota vai" do formulário mostra o transporte e o canal
previsto ("Campinas (IMA, padrão nacional)" ou "Sefin Nacional (ADN)"); o
servidor confirma os dois ao aceitar, e o detalhe da emissão os registra.
Confira ali que o transporte é a produção restrita antes de acompanhar.

A primeira tentativa, em 09/10/2026, foi rejeitada pela IMA com L9999
("Arquivo em desacordo com o XML Schema"): `verAplic` com 25 caracteres
(máximo 20) e `end` do tomador sem `xBairro`. As duas causas foram corrigidas
e a DPS agora é validada no XSD oficial antes do envio; uma nova recusa
local aparece como `DPS_SCHEMA_INVALID`, sem nada transmitido. As tentativas
seguintes de exportação voltaram da IMA com E0187, com NIF e com `cNaoNIF`,
de causa não identificada
([análise](../plataforma/ISSUANCE.md#canal-de-campinas)). A nota autorizada
e cancelada em 09/10 foi doméstica: Simples sem retenção, sem alíquota,
tomador com CNPJ sintético e os mesmos dados de teste. Até 31/10, a
exportação da Freecorps só sai pela IMA; a prova da exportação é a da
Sefin, na [seção 8](#8-prova-da-exportação-na-sefin-a-partir-de-01112026).

O canal sai da regra vigente na data da emissão (ADR 0004, §5):

| Data da emissão     | Canal da Freecorps (Simples, 01.05)          | Host                                 |
| ------------------- | -------------------------------------------- | ------------------------------------ |
| até 31/10/2026 (C5) | `campinas-adn`, homologação da IMA, RSA-SHA1 | `preprod-nfseapi.ima.sp.gov.br`      |
| desde 01/11/2026    | `sefin-nacional`, produção restrita          | `sefin.producaorestrita.nfse.gov.br` |

O critério da fase 3 é a Sefin: a partir de 01/11/2026, pelo roteiro da
[seção 8](#8-prova-da-exportação-na-sefin-a-partir-de-01112026). Em
09/10/2026, o ADN de produção restrita dava `aderenteEmissorNacional` 1 para
Campinas e o de produção, 0. Se esse 0 ainda leva a Sefin a responder E0039
depois de 01/11 está em aberto ([adesão e E0039](#8-prova-da-exportação-na-sefin-a-partir-de-01112026));
um E0039 deixa a emissão `rejected`, com o número consumido e sem efeito
fiscal.
Antes de 01/11, a emissão prova o canal da IMA: em 09/10/2026, envio,
consulta por DPS, download da NFS-e, cancelamento e RSA-SHA1 no endpoint
novo.

Acompanhe o estado no console até `authorized` (ou `rejected` com o código do
fisco). Uma emissão em reconciliação não é reenviada à mão: a reconciliação
consulta a DPS antes. Na IMA, espere o envio cair em reconciliação
(`RESPONSE_UNREADABLE`): a resposta de sucesso ainda não é lida, e a consulta
é que autoriza. Se a operação pausar com `RECONCILIATION_REQUIRED`, use
"Retomar operação" no console. Autorizada, baixe XML e DANFSe (marca "SEM
VALOR FISCAL — PRODUÇÃO RESTRITA") e cancele pelo console com o motivo `9`
("Teste de integração da plataforma, nota sem valor"). Espere `cancelled` **antes** de
fechar a janela: depois dela, o cancelamento é recusado com
`ISSUANCE_TRANSPORT_CHANGED`.

### 6. Evidência

A execução de 09/10/2026 está em
evidence/197/README.md. Uma nova execução acrescenta
o próprio registro ao lado, em `docs/v1.0/evidence/197/` (README com data e
operador):

- SHA publicado (`/health`) e as variáveis conferidas no passo 1, sem o
  keyring;
- o JSON do `issuanceProbe:verify`;
- da emissão e do cancelamento: id, `target`, `transport`, `dpsId`,
  `accessKey`, `nfseNumber`, estados, códigos e rejeições, e `sha256`/tamanho
  de cada artefato (`IssuanceView.artifacts`);
- as ações de `certificateAudit` da empresa no período (ação, resultado,
  hora), sem outros campos.

Não versionar nem colar em ticket: PFX, senha, `FNFE_PLATFORM_CERT_KEYS`,
chave de deploy, XML ou PDF com dados do tomador, cookies e tokens. Os XMLs
ficam nos artefatos da plataforma; a evidência guarda os hashes.

### 7. Reverter para o simulado

Com toda emissão e cancelamento da empresa fora de `processing`:

```sh
bunx convex env remove FNFE_NFSE_SANDBOX_TRANSPORT
bunx convex env remove FNFE_NFSE_RESTRICTED_COMPANIES
bunx convex env get FNFE_NFSE_SANDBOX_TRANSPORT   # ausente
```

Novos pedidos voltam ao simulador. Uma operação real que ainda estiver na
fila termina `ISSUANCE_TRANSPORT_DISABLED` se nada saiu, ou fica em
reconciliação se algo pode ter chegado ao fisco; reabrir a janela retoma a
consulta. O cofre recusa o certificado a qualquer operação NFS-e fora da
política, mesmo uma action já iniciada. Se o A1 não deve continuar no
deployment hospedado, o owner o desativa no console (o envelope é removido e
os metadados ficam). Abrir a janela de novo é repetir os passos 3 a 7.

### 8. Prova da exportação na Sefin a partir de 01/11/2026

Critério que falta na fase 3: uma NFS-e de **exportação** autorizada e
cancelada na produção restrita da Sefin Nacional. A regra C6 só manda o
Simples de Campinas à Sefin com data de emissão em Brasília a partir de
01/11/2026 (00:00 em Brasília, 03:00Z); antes disso, o mesmo pedido vai à
IMA (C5). O pedido não aceita data futura: a prova roda no próprio dia.
O comportamento esperado está nos testes "exportação de Simples de
Campinas" de `tests/platform.issuance.test.ts` e
`packages/fiscal-nfse/export.test.ts`, e o contrato em
[ISSUANCE.md](../plataforma/ISSUANCE.md#canal-de-campinas).

**Calendário.** 01/11/2026 é domingo e 02/11 é feriado nacional (Finados); o
primeiro dia útil com a regra C6 é a terça, 03/11. Em qualquer desses três
dias, a PTAX da exportação é o boletim de 30/10 (sexta):
`ptaxSaleForIssue` (`packages/fiscal-nfse/src/ptax.ts`) começa no dia
anterior à `issueDate` e recua dia a dia até achar boletim, por no máximo
`LOOKBACK_DAYS` (10) dias. Rodar no fim de semana ou no feriado não muda o
canal nem a PTAX; muda quem está disponível.

**Adesão e E0039.** Fato: em 09/10/2026, `aderenteEmissorNacional` de
Campinas era 1 no ADN de produção restrita e 0 no de produção
(probe). Hipótese: pela
[notícia do Portal NFS-e de 28/09/2026](https://www.gov.br/nfse/pt-br/noticias/nova-funcionalidade-no-painel-administrativo-municipal-permite-antecipar-a-adocao-do-emissor-nacional-para-optantes-pelo-simples-nacional),
a partir de 01/11/2026 "todos os contribuintes enquadrados no Simples Nacional
estarão habilitados a utilizar os Emissores Nacionais, independentemente da
opção adotada pelo município"; se valer, a Sefin não recusaria o Simples de
Campinas com E0039 mesmo com o flag em 0. A hipótese não foi observada. O
valor do flag depois de 01/11 é dado a colher nesta janela (passo 2 da ordem
abaixo).
Esta prova vai à produção restrita, onde o flag já era 1, então não diz se a
Sefin de produção ainda responde E0039; isso só a fase 4 observa. A
pré-condição da fase 4 não muda: `aderenteEmissorNacional` 1 no ADN de
produção ou orientação escrita da Prefeitura
([pré-condições](#pré-condições-para-ligar-o-gate)).

**Antes de marcar o dia.** Cada item precisa de um nome ou de um valor
registrado na #197 antes da janela. Hoje (23/10/2026) estão todos pendentes:

- **A1 ativo no deployment hospedado.** Em 09/10, o certificado
  `ns7a4zg2cyjwx6fvb2gnbn4a6h8fzetj`, versão 1, foi enviado e validado
  (evidência). Conferir no
  console que ele continua "Ativo" e dentro do prazo; a data de vencimento não
  está registrada no repositório. Pendente.
- **Quem abre e fecha a janela.** A pessoa com a chave de deploy de
  `prod:elated-possum-295` na sessão (passo 1), com a autorização do
  mantenedor registrada como em [DEPLOY](deploy-producao.md). Em 09/10 foi
  um dos sócios. Para 01/11 em diante: pendente.
- **Série e número da Sefin.** O valor de `dpsSeries` no perfil
  (pré-checagem 4) e um número inicial acima de tudo que o legado já usou
  nessa série na Sefin restrita. A evidência de 09/10 registra só a série de
  Campinas (20001) e o início 100000; a série da Sefin e o maior número do
  legado nela não estão registrados. Pendente.
- **Quem autoriza.** O mantenedor que autoriza a janela precisa estar
  disponível no dia, até o cancelamento terminar. A fase 3 não passa pelo
  workflow aprovado da fase 4. Pendente, sobretudo para 01/11 e 02/11.

**Pré-checagens, antes de abrir a janela:**

1. A data em Brasília é 01/11/2026 ou posterior, e o SHA do `/health` do
   passo 1 contém o merge da #336 (ou `8747002`, já que o código de produção
   não muda nessa PR): `git merge-base --is-ancestor 8747002 <sha>` sai
   com 0.
2. Variáveis do passo 1 como esperado, A1 "Ativo" e válido no console.
3. Perfil NFS-e da empresa, conferido com o contador: Campinas (`3509502`),
   `opSimpNac` 3 como no cadastro do Simples na competência (E0160),
   `regApTribSN` preenchido (E0166) e `regEspTrib` 0 (E0175), atividade 01.05
   com `cTribNac` 010501 e NBS `111032200`. A IM e os campos de Campinas
   (`cTribMun`, IBS/CBS, `campinasDpsSeries`) podem ficar no perfil: não vão
   à Sefin. O IBS/CBS do Simples só passa a ir em fatos geradores desde
   01/01/2027, e a exportação com ele é recusada
   ([Grupo IBSCBS](../plataforma/ISSUANCE.md#grupo-ibscbs)).
4. Série da Sefin: a série principal do perfil (`dpsSeries`, não a de
   Campinas), entre 1 e 49999 (E0010). Em "Número inicial da DPS", ambiente
   sandbox, um início acima de qualquer número já usado nessa série na Sefin
   restrita, inclusive pelo legado (passo 2.3).
5. Tomador fictício no exterior como no passo 5, sem NIF e com
   `nifAbsence` 2.

**Ordem dos comandos:**

1. Passo 1 (alvo e versão) e passo 3 (lista primeiro, transporte depois).
2. Probe de mTLS e adesão, com a adesão de produção:

   ```sh
   bunx convex run issuanceProbe:verify '{"organizationId":"<organizationId>","companyId":"<companyId>","operator":"<login GitHub>","reason":"Fase 3 (#197): Sefin restrita antes da exportação","productionAdhesion":true}'
   ```

   Prossiga só com `not-found`/404 na Sefin restrita e
   `aderenteEmissorNacional` 1 no ADN de produção restrita. Registre o
   `adhesion` das três fontes, com a hora, no `probe-sefin-AAAA-MM-DD.json` e
   na tabela de adesão
   do registro: é a primeira leitura depois de 01/11. O valor do ADN de
   produção, 0 ou 1, não bloqueia esta prova; ele vai à #198 como dado da
   pré-condição de adesão. Com
   `CONSULT_INCONCLUSIVE`, `ADN_ACCESS_DENIED` ou `TRANSPORT_FAILED`, pare e
   feche a janela (passo 7).

3. Exportação pelo console, como no passo 5: competência 2026-11, mercado
   exportação, USD `1.00`, descrição "TESTE DE INTEGRAÇÃO - SEM VALOR
   FISCAL", sem alíquota nem retenção. Antes de enviar, "Para onde a nota
   vai" precisa mostrar "Produção restrita do fisco (homologação)" e "Sefin
   Nacional (ADN)"; com "Campinas (IMA, padrão nacional)", a data ainda é
   31/10 em Brasília: não envie. Uma nota por vez.
4. No detalhe da emissão, confira o mesmo destino e transporte gravados.
5. Até `authorized`: pelo manual da API, a Sefin responde ao envio com a
   chave e o XML da NFS-e. Se cair em `reconciling`, guarde o `diagnostic`
   da tentativa, deixe a consulta resolver e use "Retomar operação" só se
   pausar.
6. Baixe XML e DANFSe, cancele com o motivo `9` e espere `cancelled`.
7. Opcional, na mesma janela: uma segunda exportação com NIF fictício,
   autorizada e cancelada.
8. Passo 7 (fechar a janela) e o registro abaixo.

**O que registrar em `docs/v1.0/evidence/197/`:** preencha o esqueleto
README-sefin.md com data, horário UTC
de abertura e fechamento da janela, operador e SHA do `/health`, as variáveis
do passo 1 (sem o keyring) e a adesão, e acrescente os JSONs saneados como os
de 09/10:

- `probe-sefin-AAAA-MM-DD.json`: o probe;
- `issuances-sefin-AAAA-MM-DD.json`: id, `target`, `transport`, rota, série
  e número, `dpsId`, `accessKey`, `nfseNumber`, estados, códigos e
  rejeições com a mensagem do fisco, tentativas com `diagnostic`, PTAX
  congelada (`quoteDate` esperado 2026-10-30 para emissões de 01 a 03/11,
  porque 31/10 e 01/11 são fim de semana e 02/11 é feriado) e
  `sha256`/tamanho de cada artefato, do envio ao cancelamento;
- `certificate-audit-sefin-AAAA-MM-DD.json`.

Atualize o README da pasta (critérios, "O que não está provado" e
pendências), o [ISSUANCE.md](../plataforma/ISSUANCE.md#o-que-não-está-provado)
e o [ACCEPTANCE.md](../v1.0/ACCEPTANCE.md), e comente o resultado na #197.
Nada de XML, PDF ou dado do tomador, como no passo 6.

**Rejeições previstas e o que fazer.** Toda rejeição de negócio é
definitiva: a emissão fica `rejected`, o número é consumido e nada é
reenviado. Em todos os casos, registre código e mensagem e feche a janela
(passo 7); repetir é reabrir pelos passos 3 a 7, depois de resolver a causa.

| Código | Leitura                                                                                        | Ação, antes de fechar a janela                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E0039  | Campinas não está parametrizado para os emissores públicos nacionais no ambiente que respondeu | Inesperado: o flag de produção restrita era 1 em 09/10. Guarde o `adhesion` do probe do mesmo dia. Não troque o canal (C6 vem da Res. CGSN 191/2026). Leve à Prefeitura (SMF/DRM) e anote na #197 e na #198 |
| E0116  | Há registro complementar da empresa no CNC de Campinas e a DPS foi sem IM                      | Pare. Enviar a IM à Sefin pede mudança em `issuanceDps.ts`, numa PR própria                                                                                                                                 |
| E0084  | O município emissor não confere com os cadastros CNPJ/CNC (`cLocEmi`, CNPJ e IM)               | Pare: pode ser a mesma falta de IM do E0116. Confira o cadastro e trate como o E0116 se a IM for a causa                                                                                                    |
| E0160  | `opSimpNac` não confere com o cadastro do Simples na competência                               | Corrija o perfil com o contador                                                                                                                                                                             |
| E0010  | Série fora da faixa do aplicativo próprio                                                      | Ajuste `dpsSeries` para 1 a 49999                                                                                                                                                                           |
| E1235  | Falha de schema no fisco: a DPS não segue o XSD que o ambiente valida                          | Compare a mensagem com o pacote de XSD do ambiente (a produção restrita valida o da NT 009 desde 20/10/2026, a causa da recusa de 02/11/2026) e corrija o leiaute numa PR própria, com o XSD novo fixado    |

Qualquer outro código: registre e compare com o Anexo I v1.01-20260209
(aba "RN DPS_NFS-e"), ou com o da produção restrita de 20/10/2026 quando a
recusa vier dela, antes de mudar perfil ou código.

Em 02/11/2026, a primeira janela terminou em E1235: a DPS seguia o leiaute
de produção, e a produção restrita já valida o da NT 009. Com a #720
publicada, a segunda janela autorizou e cancelou a exportação (série 2 nº
100001); o critério da fase 3 está cumprido
(registro). Uma nova janela continua
a série 2 a partir de 100002.

## Fase 4, produção fiscal

Issue [#198](https://github.com/freecorps/freecorpsNFE/issues/198); decisões dos
sócios na [ADR 0004, §8](../adr/0004-motor-de-emissao-nfse.md#8-ambientes-e-gates)
e suas três emendas de 21/10/2026. Hoje **nenhum deployment é produção
fiscal**. A `main` já tem o código que recusa a emissão real fora desse
deployment, os workflows que operam o gate e o probe, a publicação e o
backup do segundo alvo. Eles recusam rodar enquanto o plano não nomear o
deployment. Ainda não existe o deployment: criá-lo e nomeá-lo são
[passos humanos](#passos-humanos). Esta parte registra o que existe, os passos
humanos e a ordem prevista.

### O que já existe na `main`

**Perfil e plano.** O deployment só é produção fiscal quando três condições
valem juntas. Quem confere é `requirePlatformEnvironment`
(`platform/convex/environment.ts`), com `isIssuanceProductionDeployment`
(`platform/convex/lib/issuanceProduction.ts`):

- o plano versionado `deploy/issuance-production.json` nomeia o deployment, e
  `CONVEX_CLOUD_URL` é igual à `url` dele. Hoje o plano tem
  `"deployment": null` e `"url": null`;
- `APP_ENV=installation`;
- o marcador `FNFE_ISSUANCE_ENV=production` (`ISSUANCE_PRODUCTION_MARK`),
  exatamente.

Qualquer combinação parcial é erro de configuração, nunca um sandbox
silencioso. As variáveis do sandbox e das provas de captura
(`issuanceProductionForbiddenVariables`) não podem existir no deployment. O
`/health` informa `issuanceEnv` (`platform/convex/http.ts`): `production` só
nesse deployment. Os detalhes estão em
[ISSUANCE.md](../plataforma/ISSUANCE.md#deployment-de-produção-fiscal).

**Lista de empresas e gate.** `FNFE_NFSE_PRODUCTION_COMPANIES`
(`productionCompanies` em `lib/issuanceProduction.ts`) é a lista de empresas
que podem sair para o fisco; fora do deployment de produção fiscal, ela é erro
de configuração. O gate de cada empresa muda só por
`internal.issuance.setProductionGate` (`platform/convex/issuance.ts`, com a
validação em `gateRequest` de `lib/issuanceGate.ts`). Nenhum membro, chave de
API ou função pública chega a ela:

- fora do deployment de produção fiscal, toda troca é recusada
  (`ISSUANCE_GATE_DEPLOYMENT_DENIED`);
- `enable` exige a empresa na lista (`ISSUANCE_GATE_COMPANY_DENIED`), a
  organização fora de encerramento e um `approver` diferente do `operator` e
  do `actor` (`ISSUANCE_GATE_APPROVER_INVALID`);
- `emergency_disable` não exige aprovador e vale mesmo com a empresa fora da
  lista: desligar nunca abre nada;
- toda troca exige `operator`, `reason`, `runId` e `runAttempt` válidos
  (`ISSUANCE_GATE_RUN_INVALID` para run ou tentativa inválidos).

Cada troca acrescenta uma linha a `issuanceGateEvents` e regrava
`issuanceGates`, o estado atual, na mesma transação (tabelas em
`platform/convex/lib/issuanceSchema.ts`). O histórico só recebe acréscimos
enquanto a organização existe; o expurgo segue a classe `commercial` de
[RETENTION.md](../plataforma/RETENTION.md#histórico-do-gate-de-produção).

**Uma resposta para sair.** `productionTransportAllowed`
(`platform/convex/lib/issuanceCore.ts`) decide se uma emissão ou um
cancelamento em `production` pode ir ao fisco. O executor a lê antes de cada
tentativa (`transportAllowed` em `issuanceProcessing.ts`), e o cofre ao
entregar o A1
(`certificateUse.authorize`, por `issuanceCertificateAllowed`). O primeiro
envio exige também o gate ligado (`productionGate`, no mesmo arquivo). Sem
isso, o pedido é recusado antes de reservar número (`requireProductionGate` em
`issuance.ts`, com `ISSUANCE_PRODUCTION_DISABLED`). Em produção, a origem só
pode ser `https://sefin.nfse.gov.br` (`PRODUCTION_ORIGINS` em
`issuanceWorker.ts`).

**Gate desligado: cancelar e reconciliar continuam.** Com o gate desligado e a
empresa ainda na lista, cancelar nota autorizada continua possível. A
reconciliação de uma emissão já enviada também continua: consulta a DPS e
autoriza sem reenviar. Reenviar depois de uma consulta que não acha a DPS é
envio novo. `issuanceProcessing.markSubmitted` confere o gate na mesma
transação que marca o envio; com ele desligado, nada sai
(`ISSUANCE_RESEND_BLOCKED`). O que fazer nesse caso está em
[Cortar a emissão](#cortar-a-emissão).

**Probe e verificação, só leitura.** `internal.issuanceProbe.verify` e
`internal.issuanceProbe.verifyIssued` (`platform/convex/issuanceProbe.ts`)
leem a Sefin e o ADN de produção com o A1 da empresa. Fazem só `GET`, para os
hosts de `PRODUCTION_PROBE_HOSTS`, e não exigem o gate. `verifyIssued` devolve
`single`, a evidência de uma única NFS-e para o Id da DPS. Cada execução fica
em `issuanceProbeEvents`
([ISSUANCE.md](../plataforma/ISSUANCE.md#histórico-do-probe)).

**Workflows do gate e do probe.** São três, todos só por `workflow_dispatch`
na `main`:

| Workflow                                      | Environment                 | O que faz                                                                                                    |
| --------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/nfse-gate-enable.yml`      | `nfse-production-gate`      | Liga o gate de uma empresa (`kind: "enable"`), depois da aprovação de outra pessoa no environment            |
| `.github/workflows/nfse-gate-emergency.yml`   | `nfse-production-emergency` | Desliga o gate (`kind: "emergency_disable"`), sem aprovação, só por quem está em `deploy/issuance-gate.json` |
| `.github/workflows/nfse-production-probe.yml` | `nfse-production-read`      | Probe de mTLS e adesão ou verificação de uma nota autorizada, só leitura, pelas mesmas pessoas autorizadas   |

Todos rodam `scripts/issuance-gate.mjs`, com as checagens em
`scripts/lib/issuance-gate.mjs` (testes em `scripts/issuance-gate.test.ts`),
nesta ordem, cada uma fechada antes da seguinte:

1. **Plano.** O executor confere o plano antes de qualquer segredo
   (`productionTarget`). Com `deployment: null`, ele falha com
   `PLAN_NOT_NAMED` e a explicação no log. No ligar e no probe, um job `plan`
   sem segredo faz isso primeiro, então o job com o environment nem começa e
   nenhuma aprovação é pedida. A emergência é um job só, sem esse passo a
   mais (abaixo).
2. **Entradas.** `organization_id`, `company_id`, `reason` e, na verificação,
   `issuance_id` chegam por `env:`, nunca interpolados no shell, e são
   validados (`dispatchInputs`).
3. **Run.** O run é lido da API do GitHub (`/actions/runs/{id}/attempts/{n}`)
   e precisa ser o próprio workflow, na `main`, por dispatch, em andamento,
   no SHA do checkout (`verifiedRun`). `operator` é o `triggering_actor` do
   run e `actor`, o `actor` quando é outra pessoa; nenhum dos dois vem de
   entrada.
4. **Aprovação (só ligar).** `approver` vem de
   `/actions/runs/{id}/approvals`. Exige uma única aprovação para
   `nfse-production-gate`, sem revisão recusada, de alguém que não é
   `operator` nem `actor` (`APPROVER_INVALID`) e que está em
   `authorizedActors` de `deploy/issuance-gate.json`
   (`APPROVER_NOT_AUTHORIZED`). Só a primeira tentativa do run liga: a API de
   aprovações não diz de qual tentativa é a aprovação, então uma nova
   tentativa é recusada (`RUN_ATTEMPT_REFUSED`) e o certo é disparar de novo.
5. **Pessoas autorizadas (emergência, probe e verificação).** `operator`, e
   `actor` quando há, precisam estar em `authorizedActors` de
   `deploy/issuance-gate.json`.
6. **Chave e deployment.** A chave do environment (segredo
   `FNFE_ISSUANCE_DEPLOY_KEY`) precisa ser a do deployment do plano, com o
   prefixo `prod:`, o nome do deployment e `|` (`deployKeyFor`). O `/health`
   do deployment precisa responder `issuanceEnv: production`
   (`productionHealth`).
7. **Chamada.** `convexCall` monta a chamada interna:
   `issuance:setProductionGate` com o `kind` fixo da ação, ou
   `issuanceProbe:verify` / `issuanceProbe:verifyIssued`. O log e o recibo público
   (`.ci-results/issuance-gate/receipt.json`) mostram só desfechos, códigos
   e ids (`summary`). A resposta completa vai só cifrada para os
   custodiantes, em `receipt.full.json.age` no mesmo artifact (30 dias),
   por `scripts/lib/sealed-receipt.mjs`.

Os jobs com credencial não instalam dependências: o executor só usa módulos
do Node. O ligar e o probe usam `actions/setup-node`, fixado por SHA. A
emergência depende do mínimo: um job só, num runner hospedado do GitHub
(`ubuntu-24.04`), com o Node da imagem do runner, conferido por versão, sem
baixar ferramenta.

`.github/CODEOWNERS` põe o mantenedor como único dono dos workflows, de
`deploy/`, desses scripts e do código do gate e do perfil de produção fiscal,
por decisão dele de 26/10/2026 (ADR 0007). A lista de quem dispara e aprova
este gate é outra, `authorizedActors` de `deploy/issuance-gate.json`, e não
mudou. A regra do `CODEOWNERS` só obriga a revisão depois do passo humano da
proteção da `main`, abaixo, que o plano atual do GitHub não permite
([bloqueio](#bloqueio-o-plano-do-github)).

**Console.** No deployment de produção fiscal:

- O selo diz "Produção fiscal · Notas com validade fiscal". A query pública
  `deployment.current` (`platform/convex/deployment.ts`) informa o ambiente, e
  `EnvironmentStamp` (`apps/console/src/environment-stamp.tsx`) mostra o selo.
  Nenhuma tela com escopo fiscal consulta antes da resposta (`useDeployment`
  em `apps/console/src/deployment.ts`).
- Owner e admin veem o gate da empresa só para leitura: "Liberada", com a
  hora do último ligar, ou "Desligada". O dado vem de `productionGate` no
  `context` de `platform/convex/issuanceConsole.ts`, e a tela usa
  `ProductionGateState` (`apps/console/src/issuance-production.tsx`). Não há
  botão de gate nem login da equipe na tela.
- "Revisar pedido" e "Revisar cancelamento" abrem uma confirmação com o
  resumo: tomador, valor, destino e, no cancelamento, a nota e o motivo. Só
  "Pedir emissão" ou "Confirmar cancelamento" enviam. O código está em
  `DraftForm` (`issuance-form.tsx`), `CancelForm` (`issuances.tsx`) e
  `ConfirmDialog`, com `settleMs` (`ui/dialog.tsx`).
- Num deployment de produção sem emissão, como o alvo da #50, o console não
  oferece emitir (`canIssue` falso no `context`).

Os testes com o plano e o ambiente substituídos estão em
`tests/platform.issuanceProduction.test.ts`. Os do console estão em
`apps/console/src/issuances-production.test.tsx`, e as capturas, em
console-ambiente-producao.

### Publicação, backup e smokes

Também já existem na `main`, todos fechados enquanto o plano não nomear o
deployment ([deploy-producao.md](deploy-producao.md#segundo-alvo-produção-fiscal-da-nfs-e)):

- **Publicação do segundo alvo.** O workflow `deploy-issuance-production.yml`
  roda só por dispatch, com `scripts/deploy-issuance-production.mjs`. O job
  `plan`, sem segredo, falha com `PLAN_NOT_NAMED` (ou `RELEASE_NOT_PLANNED`,
  com o deployment nomeado e sem `release`) antes da CI e da publicação.
  Antes de usar a chave de deploy, o job `publish` confere o run e a aprovação
  na API do GitHub com o mesmo `verifiedRun` do ligar: uma aprovação em
  `nfse-production-release`, de alguém em `authorizedActors` que não disparou
  o run. O console sai com `VITE_PRODUCT_ENV=production` num Worker e domínios
  próprios.
  O smoke depois da publicação exige `issuanceEnv: production`.
- **Backup offsite.** Os jobs `snapshot-issuance` e `check-issuance` do
  `Offsite backup` são pulados enquanto o plano não nomear o deployment.
- **Smokes estritos.** `scripts/lib/platform-smoke.mjs` (sandbox hospedado) e
  `scripts/lib/validation-smoke.mjs` (validação) exigem
  `issuanceEnv: disabled`. Na validação, uma revisão anterior à #337, sem o
  campo, é repetida até a nova responder
  ([deploy-validacao.md](deploy-validacao.md)), e a próxima publicação traz o
  campo.

Fica de fora, de propósito: domínio próprio para o backend Convex e URL
regional. O backend fica no `https://<nome>.convex.cloud` versionado e na
região padrão; os domínios próprios são os do Worker.

### Passos humanos

Configurações do repositório e do Convex que nenhuma PR faz. Os sócios fazem
cada uma e registram a evidência na #198. Os passos 1, 2 e 9 dependem de uma
decisão que os sócios ainda não tomaram
([bloqueio](#bloqueio-o-plano-do-github)).

1. **Proteção da `main`.** Exigir PR com revisão aprovada e de code owner
   (`.github/CODEOWNERS`), sem bypass de administrador, com os checks da CI
   obrigatórios.
2. **Environment `nfse-production-gate`.** Required reviewers com as pessoas
   que podem aprovar, _Prevent self-review_ ligado, deployment branches só
   `main`, e o segredo `FNFE_ISSUANCE_DEPLOY_KEY` com a chave de deploy do
   deployment de produção fiscal.
3. **Environment `nfse-production-emergency`.** Sem reviewers, deployment
   branches só `main`, e o mesmo segredo `FNFE_ISSUANCE_DEPLOY_KEY`.
4. **Environment `nfse-production-read`.** Sem reviewers, deployment branches
   só `main`, e o mesmo segredo `FNFE_ISSUANCE_DEPLOY_KEY`.
5. **Segredo só nos environments.** `FNFE_ISSUANCE_DEPLOY_KEY` não existe
   como segredo do repositório nem em outro environment.
6. **Pessoas autorizadas.** Conferir `authorizedActors` de
   `deploy/issuance-gate.json`; mudar a lista é um commit revisado.
7. **Deployment.** Criar o deployment Convex de produção fiscal na região
   padrão, restringir o acesso ao painel e ao time Convex a pessoas nomeadas e
   registrar a lista junto da evidência. Configurar as variáveis exigidas pelo
   preflight da publicação.
8. **Worker e domínios.** Escolher o nome do Worker e os domínios do console e
   da API, e publicar o segredo `AUTH_PROXY_SECRET` no Worker novo.
9. **Environment `nfse-production-release`.** Required reviewers, _Prevent
   self-review_, deployment branches só `main`, e os segredos
   `FNFE_ISSUANCE_DEPLOY_KEY` e `FNFE_ISSUANCE_CLOUDFLARE_API_TOKEN`.
10. **Environment `offsite-backup-issuance`.** Deployment branches só `main`,
    com `FNFE_ISSUANCE_DEPLOY_KEY` e as credenciais R2 de escrita e de leitura.
11. **Plano.** Num commit revisado, nomear `deployment`, `url` e `release` em
    `deploy/issuance-production.json`.

#### Bloqueio: o plano do GitHub

Conferido em 23/10/2026: a organização `freecorps` está no plano Free
(`gh api orgs/freecorps --jq .plan.name` devolve `free`) e o repositório é
privado. Nesse plano, o GitHub não oferece o que o desenho de duas pessoas da
[ADR 0004, §8](../adr/0004-motor-de-emissao-nfse.md#8-ambientes-e-gates)
pressupõe:

- **Required reviewers**, e com eles o _Prevent self-review_, só existem em
  repositório público nos planos Free, Pro e Team
  ([Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers)).
  Em repositório privado, só no Enterprise.
- **Proteção de branch** em repositório privado exige Pro, Team ou Enterprise
  ([About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).
  `GET repos/freecorps/freecorpsNFE/branches/main/protection` e
  `GET repos/freecorps/freecorpsNFE/rulesets` respondem 403, "Upgrade to
  GitHub Pro or make this repository public to enable this feature".
- **Environments e segredos de environment** em repositório privado também
  pedem plano pago pela documentação: no Free, só em repositório público
  ([Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
  e a seção "Environment secrets" de Deployments and environments). O
  repositório, porém, já tem `capture-fiscal-emergency`, `offsite-backup`,
  `production` e `validation`, com regra de branch, e o run `39969590818` de
  `capture-fiscal-halt.yml`, em 23/10/2026, recebeu `FNFE_SITE_DEPLOY_KEY`,
  segredo que só existe em `capture-fiscal-emergency`, e terminou com
  sucesso. Documentação e comportamento observado divergem aqui; required
  reviewers não foram testados, porque criá-los é escrita no repositório.
  Nenhum dos cinco environments da NFS-e (`nfse-production-gate`,
  `nfse-production-emergency`, `nfse-production-read`,
  `nfse-production-release` e `offsite-backup-issuance`) existe.

O que acontece com o código da `main` nesse plano, tomando a documentação como
certa para os required reviewers:

- `nfse-gate-enable.yml` recusa sempre. Sem required reviewers, o run não
  tem aprovação em `/actions/runs/{id}/approvals`, e `verifiedRun`
  (`scripts/lib/issuance-gate.mjs`) termina em `APPROVAL_MISSING` antes de
  chamar o Convex. O gate não liga; a falha é fechada.
- `deploy-issuance-production.yml` também recusa sempre. Antes de usar a
  chave de deploy, `scripts/deploy-issuance-production.mjs publish` lê o run
  e `/actions/runs/{id}/approvals` e passa pelo mesmo `verifiedRun` do ligar,
  com `RELEASE_WORKFLOWS` (`scripts/lib/issuance-release.mjs`). Sem required
  reviewers não há aprovação, e a publicação termina em `APPROVAL_MISSING`
  sem chamar o Convex nem a Cloudflare. `approved_sha` continua sendo entrada
  de quem dispara e não conta como aprovação: só confere que o SHA do run é o
  pretendido. A falha é fechada.
- Sem proteção da `main`, `.github/CODEOWNERS` não obriga revisão. Quem tem
  escrita no repositório altera um workflow que recebe a chave de deploy sem
  outra pessoa ver, e a segunda emenda da ADR 0004 põe a `main` com revisão
  obrigatória como requisito da publicação do segundo alvo.

**Decisão pendente dos sócios**, antes dos passos 1, 2 e 9 e de qualquer
publicação do segundo alvo:

1. mudar o plano. Team libera a proteção da `main`, mas não os required
   reviewers em repositório privado; o desenho da ADR inteiro pede
   Enterprise;
2. tornar o repositório público;
3. emendar a ADR 0004, §8, com outro controle de duas pessoas, e mudar
   workflows e scripts numa PR própria.

Este runbook não escolhe; registre a decisão na #198.

### Pré-condições para ligar o gate

As pré-condições e os critérios de aceite estão na
[#198](https://github.com/freecorps/freecorpsNFE/issues/198). Em resumo, antes
do primeiro `enable`:

1. a prova da exportação na Sefin restrita a partir de 01/11/2026, pelo
   roteiro da [seção 8](#8-prova-da-exportação-na-sefin-a-partir-de-01112026);
2. a orientação escrita da Prefeitura de Campinas sobre o canal do Simples, ou
   `aderenteEmissorNacional` 1 no ADN de produção;
3. a confirmação escrita do contador sobre alíquota, `regApTribSN` e campos de
   exportação;
4. a decisão dos sócios sobre o [plano do GitHub](#bloqueio-o-plano-do-github).
   Bloqueante: no plano atual, `nfse-gate-enable.yml` recusa todo `enable`
   e `deploy-issuance-production.yml` recusa toda publicação, ambos com
   `APPROVAL_MISSING`;
5. os [passos humanos](#passos-humanos) feitos;
6. o leiaute da DPS de produção conferido. A DPS com `tpAmb` 1 segue o XSD
   v1.01-20260209, o único publicado na Documentação Atual do Portal NFS-e.
   A produção restrita passou ao leiaute da NT 009 em 20/10/2026 e recusou o
   anterior com E1235 em 02/11/2026, e a página "Atualizações e implantações"
   anuncia as mudanças de 20/10 também para a produção. Antes do primeiro
   `enable`, confira na Documentação Atual qual pacote de XSD vale para a
   produção; se for o da NT 009, a DPS de `tpAmb` 1 passa a esse leiaute
   (`layout` em `platform/convex/lib/issuanceDps.ts`, com o XSD fixado em
   `packages/fiscal-nfse`) numa PR própria, antes da primeira nota real.

### Cortar a emissão

No deployment de produção fiscal, o gate e a lista de empresas têm efeitos
diferentes
([ISSUANCE.md](../plataforma/ISSUANCE.md#deployment-de-produção-fiscal)):

- **Desligar o gate** (`nfse-gate-emergency.yml`) barra só notas novas.
  Cancelamentos de notas autorizadas e a reconciliação de emissões já
  enviadas, que só consulta e nunca reenvia, continuam.
- **Tirar a empresa de `FNFE_NFSE_PRODUCTION_COMPANIES`** é o corte total:
  nada mais sai para ela, nem cancelamento, nem consulta. Uma emissão já
  enviada fica em reconciliação sem desfecho até a empresa voltar à lista.

Nos dois casos, uma emissão já enviada que continua incerta (consulta sem a
nota, com o gate desligado, ou nenhuma consulta, com a empresa fora da lista)
esgota as tentativas e termina `paused`, incerta, com `RECONCILIATION_REQUIRED`.
Ela não anda sozinha. Para retomá-la, primeiro desfaça o corte: religue o
gate pelo workflow aprovado (`nfse-gate-enable.yml`) ou devolva a empresa à
lista.
Depois retome a operação: "Retomar operação" no console ou
`POST /v1/operations/{id}/retry`, que concede uma reconciliação além do limite
([OPERATIONS.md](../plataforma/OPERATIONS.md#recuperação-e-limites)). A
reconciliação consulta a DPS antes de qualquer reenvio. Uma operação esgotada
sem incerteza pausa com `ATTEMPTS_EXHAUSTED`.

**Com o GitHub ou o Actions fora do ar**, o workflow de emergência não roda.
O caminho alternativo é o corte total: no painel do Convex do deployment de
produção fiscal, em Environment Variables, tirar o id da empresa de
`FNFE_NFSE_PRODUCTION_COMPANIES` (ou apagar a variável, se ela for a única).
O efeito é o do corte total descrito acima, não o do gate desligado:
cancelamento e consulta também param. Depois, registre na
[#198](https://github.com/freecorps/freecorpsNFE/issues/198) quem fez, quando,
o motivo e o valor anterior da variável; devolver a empresa à lista é a
mesma mudança ao contrário, também registrada.

### Ordem prevista até a primeira nota

Todos os comandos já existem e recusam rodar enquanto o plano não nomear o
deployment. Os passos 1 e 4 pressupõem a aprovação de outra pessoa no
environment, que o plano atual do GitHub não oferece
([bloqueio](#bloqueio-o-plano-do-github)).
`<org>`, `<empresa>` e `<emissão>` são os `_id` das tabelas `organizations`,
`companies` e `issuances`.

1. Publicar o deployment de produção fiscal pelo plano versionado. Outra pessoa,
   de `authorizedActors`, aprova o run no environment
   `nfse-production-release`, e o smoke confere `issuanceEnv: production` e o
   SHA publicado. Como no ligar, só a primeira tentativa do run publica; se a
   CI falhar, dispare de novo em vez de repetir o run:

   ```sh
   gh workflow run deploy-issuance-production.yml --ref main -f approved_sha=<SHA da main>
   ```

2. Cadastrar a empresa Freecorps, enviar o A1 pelo console e completar o
   perfil NFS-e, como no passo 2 da fase 3. Pôr só ela em
   `FNFE_NFSE_PRODUCTION_COMPANIES`.
3. Rodar o probe de produção, sem gate, e registrar o resumo do log e o
   artifact:

   ```sh
   gh workflow run nfse-production-probe.yml --ref main -f check=probe \
     -f organization_id=<org> -f company_id=<empresa> \
     -f reason="Fase 4 (#198): mTLS e adesão antes do gate"
   ```

4. Ligar o gate. Outra pessoa aprova o run no environment
   `nfse-production-gate`; depois, conferir "Liberada" no console:

   ```sh
   gh workflow run nfse-gate-enable.yml --ref main \
     -f organization_id=<org> -f company_id=<empresa> \
     -f reason="Fase 4 (#198): primeira nota da Freecorps"
   ```

5. Com o [destino de webhook](#webhook-ao-app-consumidor) já cadastrado,
   emitir por API a fatura de exportação de um app consumidor da Freecorps, de 28/11/2026, e
   verificar a nota, guardando `single`:

   ```sh
   gh workflow run nfse-production-probe.yml --ref main -f check=verify-issued \
     -f organization_id=<org> -f company_id=<empresa> -f issuance_id=<emissão> \
     -f reason="Fase 4 (#198): uma única NFS-e para a DPS"
   ```

   28/11/2026 é sábado. Com `issueDate` 2026-11-28, a PTAX é o boletim de
   27/11 (sexta), o primeiro dia que `ptaxSaleForIssue` consulta. A API aceita
   `issueDate` passada e recusa a futura (`ISSUANCE_DATE_FUTURE`), então a
   nota pode sair num dia útil seguinte com a mesma `issueDate`; nesse caso,
   `dhEmi` vai com `T12:00:00-03:00`. Não foi conferido se a Sefin aceita
   `dhEmi` retroativo. Quem emite e quem acompanha, no sábado ou depois:
   pendente.

6. Registrar a evidência como no passo 6 da fase 3: hashes, estados,
   auditoria, o histórico do gate, o recibo de cada run e a entrega do
   webhook, sem XML, PDF ou dados do tomador.

Em emergência, a qualquer momento:

```sh
gh workflow run nfse-gate-emergency.yml --ref main \
  -f organization_id=<org> -f company_id=<empresa> -f reason="<motivo>"
```

### Webhook ao app consumidor

O aceite da #198 inclui o webhook entregue ao app consumidor. Nenhum webhook
de emissão chegou ainda a um receptor real
([ISSUANCE.md](../plataforma/ISSUANCE.md#o-que-não-está-provado)); a
entrega e o reenvio só foram provados com `document.received` no sandbox
hospedado (#49).

**Receptor a definir.** Qual app consumidor recebe, com que URL e quem o
opera é decisão humana pendente, a registrar na #198 antes do passo 5. Sem
ela, este critério fica aberto.

1. **Projeto.** A nota sai por API: o que o console pede pertence ao projeto
   do console, que não tem webhooks
   ([ISSUANCE.md](../plataforma/ISSUANCE.md#console)). A concessão do projeto
   para a Freecorps em `production` precisa de `documents:issue`,
   `documents:cancel` e `webhooks:manage`
   ([escopos](../plataforma/WEBHOOKS.md#destinos-permissões-e-segredos)).
2. **Eventos.** `issuance.authorized` é o do aceite; assine também
   `issuance.rejected`, `issuance.cancelled` e
   `issuance.cancellation_rejected`
   ([catálogo](../plataforma/WEBHOOKS.md#eventos-e-identidade)). O corpo só
   traz ids; o receptor lê a nota por `GET /v1/issuances/{id}?companyId=`.
3. **Cadastro.** No console da produção fiscal, em
   `/app/<organização>/developer/webhooks/<projeto>`, ou por
   `POST /v1/webhook-endpoints` na API da produção fiscal, com chave do
   projeto e `X-Environment: production`
   ([REST](../plataforma/WEBHOOKS.md#rest-e-painel)). URL HTTPS, nome DNS,
   porta 443. O segredo `whsec_…` aparece uma vez: vai direto ao receptor,
   nunca a ticket ou evidência. O preflight da publicação já exige
   `WEBHOOK_MODE=https` no deployment
   ([deploy-producao.md](deploy-producao.md#segundo-alvo-produção-fiscal-da-nfs-e)).
4. **Teste sintético.** "Enviar teste sintético" no painel, ou
   `POST /v1/webhook-endpoints/{id}/test` com `Idempotency-Key`: o
   `webhook.test` precisa terminar em 2xx no histórico. Prova o transporte e a
   assinatura, não o evento da nota.
5. **Assinatura.** O receptor confere `X-Fnfe-Signature` com `verifyWebhook`
   (`@freecorps/sdk/webhooks`) sobre os bytes originais do corpo, recusa
   qualquer outro resultado e deduplica por `eventId` na mesma transação do
   efeito, como `examples/webhook-receiver.mjs`
   ([assinatura](../plataforma/WEBHOOKS.md#assinatura-e-verificação)).
6. **Entrega.** Depois do `authorized`, o histórico do destino
   (`GET /v1/webhook-deliveries?endpointId=…` ou o painel) mostra
   `issuance.authorized` confirmado, com `eventId`, `deliveryId` e HTTP; o
   receptor registra o mesmo `eventId` e `resource.version`.
7. **Reenvio sem efeito novo.** Reenvie essa entrega já confirmada ("Reenviar
   entrega" no painel, ou `POST /v1/webhook-deliveries/{id}/retry` com
   `{ expectedGeneration }` e `Idempotency-Key`; são até três por entrega). A
   tentativa nova leva o mesmo `eventId` e `deliveryId`; o receptor responde
   2xx e não repete o efeito.

**Evidência**, junto da do passo 6: id do destino e eventos assinados, sem a
URL se ela for privada; da entrega de `issuance.authorized`, `eventId`,
`deliveryId`, geração e HTTP de cada tentativa, antes e depois do reenvio; e,
do receptor, eventos únicos e efeitos antes e depois, como na
evidência da #49.
Nunca o segredo, o cabeçalho de assinatura nem o corpo devolvido pelo
receptor.
