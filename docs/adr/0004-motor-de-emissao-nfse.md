# Motor de emissão NFS-e da plataforma

Data: 08/10/2026 · Status: **Aceita** pelos sócios da Freecorps (aceite registrado por
um dos sócios em 08/10/2026)

## Situação em 21/10/2026

> O motor legado de `convex/engine/`, descrito abaixo como existente e
> congelado, foi removido pela PR [#373](https://github.com/freecorps/freecorpsNFE/pull/373), no commit [`e1156c5`](https://github.com/freecorps/freecorpsNFE/commit/e1156c58a126bcc664403163e63bd69c17e3b611), junto com
> o restante de `src/` e `convex/`. O porte para `packages/fiscal-nfse` é o
> único motor NFS-e do repositório. As divergências com o legado registradas
> abaixo continuam como histórico do porte.
> O código histórico continua no Git: `git show e1156c5^:<caminho>` mostra
> cada arquivo como era antes da remoção. O texto abaixo registra a decisão
> como foi tomada e não foi reescrito.

A Freecorps é optante do Simples Nacional, tem sede em Campinas/SP (IBGE 3509502) e precisa emitir NFS-e, inclusive de exportação de serviço (ISS não
incidente, LC 116/2003, art. 2º, I). A contabilidade atual não emite nota para
tomador no exterior. A plataforma 1.0 declara que a emissão fiscal está
indisponível; o motor que funciona hoje é o legado de `convex/engine/`
(`dps.ts`, `signer.ts`, `sefin.ts`, `events.ts`, `ptax.ts`, `danfse.ts`). Ele
comprovou DPS 1.01, assinatura, mTLS, cancelamento e exportação em homologação
(ver PESQUISA-FISCAL.md), mas não tem interface de
provedor, calcula em centavos e depende do runtime e das tabelas do legado.

Esta ADR registra como a plataforma passa a emitir NFS-e, por qual canal cada
nota deve sair e em que ordem a entrega acontece. Ela não autoriza emissão real
em produção: isso depende de um gate próprio, ligado por empresa.

## Decisão

### 1. Núcleo puro em `packages/fiscal-nfse`

Um pacote novo, `@freecorps/fiscal-nfse` (kind node, como `fiscal-nfe`), contém
o núcleo da NFS-e sem rede e sem Convex:

- montagem da DPS versionada por leiaute, começando pela 1.01 (XSD
  v1.01-20260209 e Anexo I correspondente), com um módulo por versão para que a
  troca de leiaute até 2033 não altere notas já montadas;
- assinatura XMLDSig enveloped/C14N com política por destino
  (`rsa-sha256` ou `rsa-sha1`);
- pedido de registro de evento, começando pelo cancelamento `e101101`;
- leitura das respostas (NFS-e autorizada, rejeições com código e mensagem,
  consulta de DPS, retorno de evento);
- conversão cambial pela PTAX de venda, com a cotação recebida como dado; a
  busca da PTAX no Banco Central fica na plataforma.

O código é portado de `convex/engine/` com os testes correspondentes, sem
importar nada de `convex/`. O legado fica intocado e congelado: correções
fiscais descobertas durante o porte entram no pacote novo e são registradas,
não aplicadas de volta. Dependências: somente as que `fiscal-nfe` já usa
(`@freecorps/fiscal-core`, `@xmldom/xmldom`, `fast-xml-parser`,
`libxml2-wasm`, `xml-crypto`). Se a montagem precisar de `xmlbuilder2`, como no
legado, a troca vira decisão explícita na PR da Fase 1, não dependência de
passagem.

### 2. Valores em decimal exato

Valores, alíquotas e taxas de câmbio entram e saem como texto decimal, com
`ExactDecimal`, `quantize` e `add` de `@freecorps/fiscal-core`. Nada passa por
ponto flutuante nem por centavos inteiros. Arredondamento é explícito por campo
(por exemplo, `half-even` só onde o leiaute ou a norma mandar). O núcleo
recusa valor que não caiba na escala do leiaute em vez de truncar em silêncio.

Divergência a resolver na Fase 1: `fiscal-core` ainda não tem multiplicação
exata, necessária para `valor × PTAX` e `base × alíquota`. A Fase 1 acrescenta
`multiply` ao `fiscal-core`, com testes, em vez de calcular por fora.

### 3. Interface de provedor e transporte injetado

O pacote define um provedor por canal:

```ts
interface NfseProvider {
  readonly id: "nacional" | "abrasf";
  issue(request: IssueRequest, io: ProviderIo): Promise<ProviderOutcome>;
  findByDps(dpsId: string, io: ProviderIo): Promise<ProviderOutcome>;
  cancel(request: CancelRequest, io: ProviderIo): Promise<ProviderOutcome>;
}
```

`ProviderIo` traz o assinador e um `send(request)` HTTP fornecido pela
plataforma. O pacote não abre sockets, não lê certificado e não conhece
Convex. Na plataforma, `send` é implementado sobre
`platform/convex/lib/certificateTransport.ts` (mTLS com o A1 do cofre da
[ADR 0003](0003-cofre-de-certificados-da-plataforma.md), origem permitida por
configuração do servidor).

`ProviderOutcome` usa a mesma classificação de
`platform/convex/lib/operationValues.ts`:

| Resultado    | Quando                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `success`    | NFS-e autorizada ou evento registrado, com XML de retorno preservado                             |
| `transient`  | indisponibilidade comprovada antes do processamento (conexão recusada, 503 sem corpo de negócio) |
| `definitive` | rejeição de negócio com código do fisco (schema, regra, cadastro)                                |
| `uncertain`  | timeout, conexão interrompida após o envio ou resposta ilegível                                  |
| `absent`     | consulta por DPS sem nota correspondente                                                         |

Timeout nunca é falha. Um resultado `uncertain` leva a operação a
`reconciling`: o reconciliador consulta a DPS pelo mesmo identificador
(`GET .../dps/{id}`) e só reenvia o mesmo XML assinado se a consulta responder
`absent`. O XML assinado é persistido antes do primeiro envio e nunca é
remontado para uma transmissão pendente.

### 4. Adaptadores

- `nacional`, parametrizado por destino:
  - `sefin-nacional`: `sefin.nfse.gov.br/SefinNacional` (produção) e
    `sefin.producaorestrita.nfse.gov.br/SefinNacional` (produção restrita);
    envio em `POST /nfse`, consulta em `GET /dps/{id}` e `GET /nfse/{chave}`,
    evento em `POST /nfse/{chave}/eventos`; assinatura RSA-SHA256.
  - `campinas-adn`: webservice municipal de Campinas (IMA) no padrão nacional.
    Mesmo contrato JSON (`dpsXmlGZipB64`, `pedidoRegistroEventoXmlGZipB64`),
    com particularidades próprias (ver "Canal de Campinas").
- `abrasf`, somente se ainda for necessário (Fase 5): SOAP ABRASF 2.03 do
  emissor municipal atual, para contribuintes que não podem usar o padrão
  nacional numa data.

### 5. Roteamento como dados

O canal de cada nota sai de uma tabela de regras, não de `if` no código:
município do prestador + regime (Simples ou não) + subitem LC 116 + data de
competência/emissão → destino. Cada linha guarda vigência (`desde`, `até`),
fonte e grau de confirmação. Sem regra vigente, o pedido é recusado com erro
explícito antes de reservar número. A tabela vive no pacote, versionada e
testada; mudar uma linha é uma PR com fonte.

Tabela de Campinas (3509502) conforme a pesquisa de 08/10/2026:

| #   | Regime      | Subitens                       | Vigência           | Canal                                                | Fonte e grau                                                                                                                                            |
| --- | ----------- | ------------------------------ | ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | qualquer    | qualquer                       | até 20/09/2026     | `abrasf` (emissor atual)                             | histórico; padrão nacional municipal em produção só a partir de 21/09 (guia IMA de 18/09). Confirmado.                                                  |
| C2  | não optante | exceto 1.03, 1.05, 1.09, 16.01 | desde 01/10/2026   | `campinas-adn`                                       | cronograma da Prefeitura (SMF) divulgado em 09/2026; Ato Conjunto RFB/CGIBS 4/2026, art. 1º, III, "d". Imprensa, sem ato municipal numerado localizado. |
| C3  | não optante | 1.03, 1.05, 1.09, 16.01        | até 30/11/2026     | `abrasf` ou `campinas-adn` (escolha do contribuinte) | resposta da equipe do grupo técnico em 01/10/2026; mensagem do erro L999. Fonte técnica, não normativa.                                                 |
| C4  | não optante | 1.03, 1.05, 1.09, 16.01        | desde 01/12/2026   | `campinas-adn`                                       | Ato Conjunto RFB/CGIBS 4/2026, art. 1º, III, "b" e "c"; cronograma da Prefeitura. Confirmado na norma federal.                                          |
| C5  | Simples     | qualquer                       | 01/10 a 31/10/2026 | `abrasf` ou `campinas-adn` (escolha do contribuinte) | resposta da equipe do grupo técnico em 01/10/2026; erro L999 ("emissor atual disponível somente para Simples Nacional"). Fonte técnica.                 |
| C6  | Simples     | qualquer                       | desde 01/11/2026   | `sefin-nacional` (Emissor Nacional, via API)         | Res. CGSN 191/2026 (Res. CGSN 140/2018, art. 59, § 1º); notícias da RFB e do Portal NFS-e; cronograma da Prefeitura. Data confirmada; ver ambiguidades. |
| C7  | Simples     | qualquer                       | desde 01/01/2027   | `sefin-nacional`, com grupo IBS/CBS obrigatório      | Ato Conjunto RFB/CGIBS 4/2026, art. 1º, § 1º; notícia da RFB de 14/08/2026. Confirmado.                                                                 |

**Caso Freecorps (Simples + subitem 01.05).** Até 31/10/2026, pode emitir pelo
emissor municipal atual ou pelo novo emissor municipal no padrão nacional (C5).
A partir de 01/11/2026, deve emitir pelo Emissor Nacional (C6), destino
`sefin-nacional`. A janela de dezembro para o 1.05 (C3/C4) vem do Ato Conjunto
4/2026, que trata da obrigatoriedade dos documentos com IBS/CBS e cujo § 1º já
adia tudo para o Simples até 01/01/2027; ela não suspende a Res. CGSN 191/2026,
que trata especificamente do emissor do Simples. Por isso a primeira nota real
da plataforma mira o Emissor Nacional.

Ambiguidades que exigem confirmação humana antes da Fase 4:

1. **Adesão de Campinas ao Emissor Nacional.** Em 29/08/2026, a consulta
   oficial `GET adn.nfse.gov.br/parametrizacao/3509502/convenio` respondeu
   `aderenteEmissorNacional: 0`, e a Sefin rejeitou a DPS com E0039. Se o flag
   não virar `1` até 01/11, a Sefin continuará recusando. A Fase 3 repete a
   consulta; se ainda for `0`, é preciso perguntar à Prefeitura (SMF/DRM) qual
   canal o Simples usa a partir de 01/11.
2. **Simples com 1.05 entre 01/11 e 30/11.** A mensagem do erro L999 do emissor
   municipal cita juntos o Simples e os subitens 1.03/1.05/1.09/16.01, e uma
   leitura de usuários no grupo técnico entende que o 1.05 só vai ao padrão
   nacional em 01/12. Não há resposta oficial dizendo se um optante do Simples
   com 1.05 pode continuar no emissor municipal em novembro. Esta ADR segue a
   Res. CGSN 191/2026; a Prefeitura deve confirmar.
3. **Ato municipal.** Não localizamos comunicado numerado nem publicação no
   Diário Oficial de Campinas com o cronograma de 01/10–01/12; as fontes são
   notícias que citam a Secretaria Municipal de Finanças, o guia técnico
   fixado no grupo `wsnfsecampinas` e respostas da equipe nesse grupo. O
   Comunicado DRM 02/2026 (junho) tinha datas anteriores, depois alteradas.
4. **Alíquota e tributação do Simples na Sefin.** O legado omite `pAliq` no
   Simples sem retenção (E0625). Confirmar com o contador a alíquota efetiva do
   mês, `regApTribSN`, e o tratamento da exportação (`tpRetISSQN`, `cLocIncid`,
   `cPaisResult`) antes da primeira nota real.

### 6. Canal de Campinas

O guia técnico da Prefeitura atualizado em 18/09/2026 publicou endereços novos,
em produção desde 21/09/2026:

| Ambiente    | Base                                                       |
| ----------- | ---------------------------------------------------------- |
| Homologação | `https://preprod-nfseapi.ima.sp.gov.br/notafiscal-ws/nfse` |
| Produção    | `https://nfseapi.campinas.sp.gov.br/notafiscal-ws/nfse`    |

Envio em `POST {base}`, consulta por DPS em `GET {base}/dps/{id}`, NFS-e em
`GET {base}/{chave}` e cancelamento em `POST {base}/{chave}/eventos`.
Substituição ainda não foi publicada.

Divergência com o legado: `convex/engine/sefin.ts` usa
`novanfse.campinas.sp.gov.br`/`preprod-nfse.ima.sp.gov.br` com
`/notafiscal-ws/api/adn` e envio em `/dps`, sondados em 29/08/2026. Esses
endereços estão desatualizados. O legado continua congelado; o adaptador novo
usa os endereços do guia, revalidados na Fase 3.

Particularidades conhecidas do validador IMA, todas observadas em homologação
no legado e a reconfirmar no endpoint novo:

- assinatura RSA-SHA1/SHA1 (E0714 com SHA-256 em 29/08/2026); a biblioteca de
  terceiros `4success/nfse-campinas` também assina com SHA-1;
- `cTribMun` obrigatório (sufixo de 3 dígitos), `cNBS` obrigatório, grupo
  `dest` e grupo `IBSCBS` exigidos;
- séries de integração entre 10001 e 49999 (L0022);
- alíquota mínima de 2% vinda do cadastro mobiliário do prestador;
- em 25/09–07/10/2026, notas do subitem 1.05 eram rejeitadas na produção nova
  com L0001 (código municipal não vinculado ao cadastro); segundo relato de
  usuário no grupo técnico, a Prefeitura reconheceu o defeito sem dar prazo.

O endpoint IMA aceitou DPS de optante do Simples em homologação (a exportação
da Freecorps foi autorizada e cancelada em 29/08/2026). Isso não muda a regra
C6: a partir de 01/11, o Simples não usa o canal municipal.

Referência para um adaptador `abrasf` futuro: ABRASF 2.03 SOAP, homologação em
`https://homol-rps.ima.sp.gov.br/notafiscal-abrasfv203-ws/NotaFiscalSoap?wsdl`
(conforme a biblioteca `4success/nfse-campinas` 2.x). O endereço de produção
não foi confirmado em fonte oficial nesta pesquisa.

### 7. Integração na plataforma

- **Operações.** Um workload novo, `issuance`, com as tarefas
  `documents.issue` e `documents.cancel`. O reconciliador é obrigatório nas duas
  (`findByDps` para emissão, consulta da NFS-e para cancelamento). Chave de
  idempotência por projeto e operação, como nas demais operações.
- **Perfil fiscal da empresa.** Inscrição municipal, IBGE, regime (Simples e
  `regApTribSN`), atividades (CNAE → item LC 116 → `cTribNac`, com `cTribMun` e
  `cNBS` quando o destino exigir) e série DPS por destino e ambiente. O perfil
  não guarda alíquota de ISS.
- **Numeração.** `nDPS` reservado atomicamente por empresa + ambiente + série,
  dentro da mutation que aceita o pedido. Número reservado nunca é reutilizado,
  nem após rejeição definitiva; lacunas são aceitas pelo padrão nacional.
- **Pedido por nota.** Competência, mercado (interno ou exportação), alíquota de
  ISS da competência (no Simples, a alíquota efetiva muda por faixa e fator R),
  tomador completo (no exterior: NIF ou motivo de ausência, endereço com
  número e CEP/código postal), moeda e valor de origem quando houver câmbio.
  A PTAX usada é congelada no documento com data e fonte.
- **Documentos.** Direção `emitted` ao lado dos documentos importados, com o
  XML da DPS assinada, o XML da NFS-e autorizada, os eventos e o DANFSe em PDF
  gerado pela plataforma (a API nacional do DANFSe foi descontinuada) como
  artefatos preservados.
- **API REST.** Rota nova de emissão e de cancelamento; `POST /v1/documents`
  não é reutilizado. Escopos novos `documents:issue` e `documents:cancel`,
  concedidos por empresa e ambiente como os demais. Contrato em
  `packages/contracts`, gerado por `bun run contracts:generate`.
- **Webhooks, console e uso.** Eventos de emissão autorizada, rejeitada,
  cancelada e em reconciliação; telas que mostram o estado persistido e a ação
  disponível sem sugerir sucesso antes da resposta do fisco; métrica de uso por
  nota emitida.

### 8. Ambientes e gates

- `sandbox`: provedor simulado, sem rede. É o perfil hospedado atual.
- `producao-restrita`: transporte real para a produção restrita da Sefin
  Nacional e para a homologação da IMA.
- `producao`: a emissão real fica atrás de um gate de servidor desligado por
  padrão, ligado por empresa depois da prova em produção restrita (fase 3).

**Emenda de 21/10/2026 (fase 4, [#198](https://github.com/freecorps/freecorpsNFE/issues/198)).**
Decisão dos sócios da Freecorps (decisão registrada pelo mantenedor em
21/10/2026). Ela detalha o `producao` acima sem mudar as demais decisões:

- A produção fiscal da emissão fica num deployment Convex separado do sandbox
  hospedado, com console e API em domínios próprios. O sandbox hospedado
  atende várias organizações e não vira produção por configuração.
- O gate de produção da empresa só é ligado ou desligado por um workflow do
  GitHub Actions. Uma pessoa dispara o workflow e outra pessoa, diferente
  dela, aprova a execução no environment protegido com _Prevent
  self-review_: são sempre duas pessoas distintas. O registro guarda o
  operador (`github.actor`, quem disparou), o aprovador e o id do run.

**Segunda emenda de 21/10/2026 (fase 4, [#198](https://github.com/freecorps/freecorpsNFE/issues/198)).**
Decisão dos sócios da Freecorps (decisão registrada pelo mantenedor em
21/10/2026). Ela substitui a forma de desligar e o que o registro guarda,
descritos acima, e mantém a de ligar:

- Ligar continua sendo pelo workflow aprovado: uma pessoa dispara e outra,
  diferente dela, aprova no environment protegido com _Prevent self-review_.
- Desligar, em qualquer caso, é pelo workflow de emergência: separado, sem
  aprovação, disparado por uma pessoa autorizada. Não existe chamada direta ao
  gate.
- O registro guarda, em toda troca, o operador (`github.triggering_actor`,
  quem disparou a execução), o `github.actor` (quem disparou o run original)
  quando for outra pessoa, o aprovador quando houver, o motivo, o id do run e
  a tentativa.
- A chave de deploy do deployment de produção fiscal existe só no GitHub.

A chave de deploy dá acesso completo ao deployment, inclusive no environment
de emergência, que não pede aprovação. Por isso a entrega que publica o
segundo alvo precisa, como requisito: os dois environments limitados à branch
padrão protegida; a `main` com revisão obrigatória, sem bypass de
administrador, e `CODEOWNERS` em `.github/workflows`; o workflow de emergência
conferindo `github.triggering_actor` contra uma allowlist e com o comando fixo
em `emergency_disable`; e o de ligar conferindo o run e a aprovação na API do
GitHub antes de chamar o gate. Separar uma chave para ligar e outra para
desligar não resolve, porque o Convex não restringe uma chave de deploy a uma
função (a conferir no provisionamento).

**Terceira emenda de 21/10/2026 (fase 4, [#198](https://github.com/freecorps/freecorpsNFE/issues/198)).**
Decisão dos sócios da Freecorps (decisão registrada pelo mantenedor em
21/10/2026). Ela define o efeito do gate e da lista de empresas do deployment
de produção fiscal:

- O gate desligado barra só notas novas.
- Cancelar nota autorizada e reconciliar emissão incerta (consulta, nunca
  reenvio) continuam enquanto a empresa estiver em
  `FNFE_NFSE_PRODUCTION_COMPANIES` e o deployment for o de produção fiscal.
- Reenviar a DPS depois de uma consulta que responde, de forma conclusiva, que
  ela não existe conta como nota nova e exige o gate ligado.
- Parar tudo, inclusive cancelamento e consulta, é tirar a empresa da lista.

Nota de 21/10/2026, coerente com a terceira emenda: a verificação de mTLS e a
verificação de uma nota autorizada só leem, nunca emitem, e por isso não
exigem o gate, só a empresa na lista do deployment de produção fiscal.

O contrato e os limites de cada parte estão em
[ISSUANCE.md](../plataforma/ISSUANCE.md#deployment-de-produção-fiscal).

## Fases

Acompanhamento na épica
[#194](https://github.com/freecorps/freecorpsNFE/issues/194); fases 1 a 5 em
[#195](https://github.com/freecorps/freecorpsNFE/issues/195),
[#196](https://github.com/freecorps/freecorpsNFE/issues/196),
[#197](https://github.com/freecorps/freecorpsNFE/issues/197),
[#198](https://github.com/freecorps/freecorpsNFE/issues/198) e
[#199](https://github.com/freecorps/freecorpsNFE/issues/199).

| Fase | Entrega                                                                                      | Critério de aceite resumido                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Esta ADR e as issues                                                                         | ADR aceita pelos sócios                                                                                                                   |
| 1    | `packages/fiscal-nfse`: núcleo + adaptador `nacional` (dois destinos) + tabela de roteamento | DPS 1.01 válida no XSD oficial, assinatura verificável nas duas políticas, outcomes classificados, testes offline                         |
| 2    | Plataforma em sandbox: perfil fiscal, numeração, operações, REST, webhooks, console, uso     | Fluxos de emissão, timeout/reconciliação e cancelamento com provedor simulado, incluindo casos negados                                    |
| 3    | Produção restrita com o certificado A1 novo                                                  | NFS-e de exportação autorizada e cancelada na produção restrita; flag de adesão de Campinas consultado                                    |
| 4    | Primeira nota real                                                                           | Fatura de exportação de um app consumidor da Freecorps, de 28/11/2026, emitida pelo Emissor Nacional, com gate ligado só para a Freecorps |
| 5    | Adaptador `abrasf` de Campinas, se ainda necessário                                          | Só se uma regra vigente da tabela exigir ABRASF para um cliente da plataforma                                                             |

## Consequências

- O motor novo pode evoluir por leiaute e por canal sem tocar no legado, e o
  mesmo núcleo atende Sefin Nacional e o webservice de Campinas.
- O porte duplica código por um período; o legado continua congelado até o
  corte descrito em
  [#84](https://github.com/freecorps/freecorpsNFE/issues/84).
- O roteamento depende de normas que ainda mudam. Uma linha sem fonte ou
  vencida bloqueia a emissão, em vez de escolher um canal por suposição.
- A Fase 4 depende de um fator externo: a habilitação de Campinas no Emissor
  Nacional. Se ela não acontecer até a data da fatura, a nota real é adiada ou
  emitida manualmente pelo canal que a Prefeitura indicar, fora da plataforma.

## Fontes consultadas em 08/10/2026

- [Ato Conjunto RFB/CGIBS nº 4, de 30/07/2026 (PDF no CGIBS)](https://www.cgibs.gov.br/upload/arquivos/202607/31091735-20260730-16h30-ato-conjunto-rfb-cgibs-na-c2-ba-4-260731-090909.pdf),
  art. 1º, III, "a" a "h", e § 1º.
- [RFB: NFS-e Nacional obrigatória para ME e EPP a partir de 01/11/2026 (14/08/2026)](https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/agosto/simples-nacional-nfs-e-nacional-sera-obrigatoria-para-me-e-epp-a-partir-de-1o-de-novembro-de-2026).
- [Portal NFS-e: CGSN prorroga a obrigatoriedade do Emissor Nacional (11/08/2026)](https://www.gov.br/nfse/pt-br/noticias/comite-gestor-do-simples-nacional-prorroga-a-obrigatoriedade-de-emissao-de-notas-fiscais-de-servico-pelo-emissor-nacional-da-nfs-e).
- Res. CGSN nº 191/2026 (DOU de 10/08/2026), que dá nova redação ao art. 59,
  § 1º, da Res. CGSN 140/2018 e revoga a Res. CGSN 189/2026. O texto foi lido
  em reprodução de terceiros; o texto oficial em `normas.receita.fazenda.gov.br`
  não foi aberto nesta pesquisa.
- Guia "Reforma Tributária – NFSe Campinas Padrão Nacional", atualizado em
  18/09/2026, fixado no grupo técnico indicado pela Prefeitura:
  <https://groups.google.com/g/wsnfsecampinas/c/oQOKosJ7n-Y/m/177VueC0AQAJ>.
- Resposta da equipe `wsnfsecampinas` sobre a escolha de modelo para Simples e
  itens 1.03/1.05/1.09/16.01 (01/10/2026):
  <https://groups.google.com/g/wsnfsecampinas/c/P0lJ13d4PmU/m/CyOs1nN4AQAJ>.
- Relatos de L0001 no subitem 1.05 na produção nova:
  <https://groups.google.com/g/wsnfsecampinas/c/fei0mi7uHIw/m/qE9XykTaAQAJ>.
- Cronograma municipal divulgado pela Secretaria Municipal de Finanças, na
  imprensa: [ACidade ON, 24/09/2026](https://www.acidadeon.com/campinas/economia/nota-fiscal-em-campinas-veja-o-que-ja-mudou-e-os-proximos-prazos/)
  e [ACidade ON, 18/06/2026 (Comunicado 02/2026, datas superadas)](https://www.acidadeon.com/campinas/economia/campinas-divulga-cronograma-para-adaptacao-da-nfs-e-a-reforma-tributaria-veja-prazos/).
- [Comunicado DRM 001/2026 da Prefeitura de Campinas](https://portal-adm.campinas.sp.gov.br/sites/default/files/anexos_avulsos/PMC%20%20SMF%20%20DRM%20%20Comunicado%20001-2026.pdf),
  que remete ao portal `campinas.sp.gov.br/sites/reformatributaria`.
- Biblioteca de terceiros [4success/nfse-campinas](https://github.com/4success/nfse-campinas)
  (PR #8, 23/09/2026, endereços novos; linha 2.x, ABRASF 2.03).
- Evidência própria em homologação: PESQUISA-FISCAL.md
  e [ADR 0001](0001-runtime-do-motor.md).
