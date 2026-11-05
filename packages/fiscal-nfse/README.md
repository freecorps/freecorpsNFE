# @freecorps/fiscal-nfse

Núcleo novo do motor de emissão NFS-e da plataforma: monta e assina a DPS,
monta e assina o cancelamento, converte câmbio pela PTAX, decide a rota de
emissão e fala o contrato ADN (Sefin Nacional e Campinas) por um transporte
injetado. Biblioteca Node independente: não importa Convex, não lê variáveis
de ambiente, não abre conexões e não consulta o relógio.

Foi portado do motor legado em `convex/engine/` (`dps.ts`, `signer.ts`,
`events.ts`, `sefin.ts`, `ptax.ts`, `codec.ts`, `danfse.ts`) e de seus testes. O legado
continua congelado e não é importado. A DPS e o pedido de cancelamento seguem
os do legado, menos onde o XSD oficial diverge dele (veja
[XSD oficial](#xsd-oficial)) e na representação dos valores (abaixo).

> [!WARNING]
> Nenhum teste deste pacote prova autorização no fisco. Os testes usam
> certificado autoassinado, dados sintéticos e respostas simuladas.

## Uso

```ts
import {
  nacional,
  resolveRoute,
  subitemFromCTribNac,
  type DpsInput,
  type NfseTransport,
} from "@freecorps/fiscal-nfse";

// Cliente HTTPS do chamador, com o A1 no handshake (mTLS), timeout e limites.
declare function mtlsFetch(url: string, init: RequestInit): Promise<Response>;
// PEMs já carregados pelo cofre da plataforma.
declare const privateKeyPem: string, certificatePem: string;

const dps: DpsInput = {
  /* tpAmb, dhEmi, prest, toma, serv, valores... (veja tests/inputs.ts) */
} as DpsInput;

const route = resolveRoute({
  municipioIbge: "3509502",
  regime: "nao-optante",
  subitem: subitemFromCTribNac(dps.serv.cTribNac),
  date: "2026-12-01", // data civil da emissão em Brasília, dada pelo chamador
});
if (route.kind === "unsupported") throw new Error(route.message);

const transport: NfseTransport = async ({ method, url, headers, body }) => {
  const res = await mtlsFetch(url, { method, headers, body });
  return { status: res.status, body: await res.text() };
};

const outcome = await nacional.issue(
  { dps },
  {
    signer: { privateKeyPem, certificatePem },
    transport,
    target: { id: route.target, environment: "producao-restrita" },
  },
);
```

## API

Montagem e assinatura são determinísticas e testáveis separadamente. A
montagem confere o XML no XSD oficial antes de devolvê-lo:

```ts
buildDps(input: DpsInput): { xml: string; id: string }
buildDpsId(input: { cLocEmi; serie; nDPS; prest: { cnpj } }): string
buildCancelEvent(input: CancelEventInput): { xml: string; id: string }
validateDpsXml(xml: string, layout?: DpsLayout): SchemaResult
validatePedRegEventoXml(xml: string, layout?: DpsLayout): SchemaResult
type SchemaResult = { valid: true } | { valid: false; issues: SchemaIssue[] }
type SchemaIssue = { element: string | null; message: string; line: number | null }
NFSE_SCHEMA_PACKAGE // "nfse-1.01-20260209", o leiaute padrão
DPS_LAYOUTS // ["nfse-1.01-20260209", "nfse-1.01-prodrest-20261020"]
VER_APLIC_MAX // 20
signDps(built, keys: SignerKeys, policy: "rsa-sha256" | "rsa-sha1"): string
signEvent(built, keys: SignerKeys, policy): string
verifySignature(signedXml: string, certificatePem: string): boolean
dhBrasilia(now: Date): string
hojeBrasilia(now: Date): string
competencia(year: number, month: number): string
gzipB64(xml: string): string
gunzipB64(b64: string): string
```

PTAX e conversão:

```ts
ptaxSaleForIssue(currency: string, issueDate: string, transport): Promise<PtaxQuote>
fetchPtaxSale(currency, isoDate, transport): Promise<PtaxQuote | null>
parsePtaxBulletins(body: string): string | null
convertToBrl(amount: string, rate: string): string
ptaxQuoteUrl(currency, isoDate): string
ptaxDateParam(isoDate): string
previousDay(isoDate): string
```

Roteamento e alvos:

```ts
resolveRoute(input: RouteInput, rules?: readonly RouteRule[]): RouteResult
ROUTE_RULES: readonly RouteRule[]
normalizeSubitem(subitem: string): string
subitemFromCTribNac(cTribNac: string): string
resolveEndpoint(target: NfseTarget): NfseEndpoint
ibsCbsRequirement(input: IbsCbsInput, rules?: readonly IbsCbsRule[]): IbsCbsRequirement
IBSCBS_RULES: readonly IbsCbsRule[]
```

Adaptador:

```ts
interface NfseProvider {
  readonly id: "nacional";
  issue(input: { dps: DpsInput }, ctx: NfseContext): Promise<IssueOutcome>;
  submitDps(
    input: { dpsId: string; signedDpsXml: string },
    ctx: NfseQueryContext,
  ): Promise<IssueOutcome>;
  consultByDps(dpsId: string, ctx: NfseQueryContext): Promise<ConsultOutcome>;
  consultByAccessKey(chaveAcesso: string, ctx: NfseQueryContext): Promise<NfseConsultOutcome>;
  cancel(input: { event: CancelEventInput }, ctx: NfseContext): Promise<CancelOutcome>;
  submitCancelEvent(
    input: { eventId: string; chNFSe: string; signedEventXml: string },
    ctx: NfseQueryContext,
  ): Promise<CancelOutcome>;
}
type NfseContext = { signer: SignerKeys; transport: NfseTransport; target: NfseTarget };
type NfseQueryContext = { transport: NfseTransport; target: NfseTarget };
type NfseTransport = (req: NfseHttpRequest) => Promise<NfseHttpResponse>;
```

`issue` e `cancel` montam, assinam e enviam numa chamada. `submitDps` e
`submitCancelEvent` enviam um XML já montado (e assinado) pelo chamador, sem
remontar nem reassinar: é o caminho da plataforma, que persiste o XML antes do
primeiro envio e reenvia o mesmo texto depois de uma reconciliação. Antes de
enviar, eles fazem o parse do XML e conferem o elemento que vai ao fisco
(`DPS/infDPS` ou `pedRegEvento/infPedReg`): o `Id` dele contra o informado, a
chave do evento e o `tpAmb` dele contra o alvo. Comentário ou elemento fora do
alvo não contam; XML malformado, com DTD, com encoding diferente de UTF-8 ou
com mais de um alvo é recusado
(`DPS_ID_MISMATCH`, `EVENT_ID_MISMATCH`, `ENVIRONMENT_MISMATCH`, com
`sent: false`).

Erros de entrada lançam `NfseError` com `code` estável e mensagem em pt-BR.
Mensagens de assinatura nunca repetem material de chave. `DPS_SCHEMA_INVALID`
e `EVENT_SCHEMA_INVALID` dizem o elemento e a regra do XSD que falharam; em
`issue` e `cancel` viram desfecho `definitive` com `sent: false`.

`signDps` e `signEvent` só assinam um XML com um único alvo, filho direto da
raiz (`DPS/infDPS` ou `pedRegEvento/infPedReg`) e com o `Id` informado; outro
formato é recusado com `SIGNATURE_TARGET_INVALID`. `verifySignature` devolve
`false`, sem calcular digest nem conferir o `SignatureValue`, quando o XML não
tem exatamente uma `Signature`, filha da raiz, com uma única `Reference` para
o `Id` desse alvo e as transformações que o signer grava (enveloped e C14N).

O subcaminho `@freecorps/fiscal-nfse/pure` exporta só o que não depende de
Node (`node:zlib`, `xml-crypto`, `@xmldom`): `resolveRoute`, `ROUTE_RULES`,
`ibsCbsRequirement`, `IBSCBS_RULES`, `subitemFromCTribNac`, `buildDpsId`, `dhBrasilia`, `hojeBrasilia`,
`competencia`, `isCalendarDate`, `BACEN_CURRENCY`, `COM_EXT_DEFAULTS`,
`VER_APLIC_MAX`, `convertToBrl`, `previousDay` e `NfseError`. As mutations do
Convex usam esse subcaminho; montagem, validação no XSD, assinatura e
transporte ficam nas actions Node. `/pure` e `/danfse` não carregam o XSD nem
o `libxml2-wasm`.

## XSD oficial

`schemas/nfse-1.01-20260209/` guarda, byte a byte, os seis arquivos do pacote
oficial "Esquemas XSD v1.01-20260209" do Portal NFS-e
([Documentação Atual](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual)),
e `schemas/nfse-1.01-prodrest-20261020/`, os mesmos seis do pacote da produção
restrita de 20/10/2026
([Homologação/testes](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita)),
com o leiaute da NT 009. São os arquivos
de que a DPS e o pedido de registro de evento dependem: `DPS_v1.01.xsd`,
`pedRegEvento_v1.01.xsd`, `tiposComplexos_v1.01.xsd`,
`tiposEventos_v1.01.xsd`, `tiposSimples_v1.01.xsd` e
`xmldsig-core-schema.xsd`. `schemas/manifest.json` registra a URL, a data de
obtenção, o SHA-256 do ZIP e de cada arquivo e o da cópia de runtime.
`scripts/fiscal/sync-nfse-schemas.py --download` baixa os ZIPs para `.ci-results/`,
recusa um ZIP diferente do fixado e gera `src/schemas.json`, o catálogo
offline que `src/schema.ts` registra no `libxml2-wasm`, como em
`@freecorps/fiscal-nfe`. Nada é baixado em runtime.

A cópia de runtime difere do original em dois pontos, ambos no manifesto: o
BOM UTF-8 de alguns arquivos sai, e o padrão de `TSSerieDPS` do pacote de
produção (`^0{0,4}\d{1,5}$`) perde `^` e `$`; o da produção restrita já vem
sem eles. Expressões do XSD são ancoradas por
definição e não têm esses metacaracteres; o libxml2 os lê como literais e
recusaria qualquer série.

### Leiaute por ambiente

`DpsInput.layout` escolhe o pacote: ausente, o de produção
(`nfse-1.01-20260209`); `nfse-1.01-prodrest-20261020` monta o leiaute da
NT 009, que a produção restrita da Sefin exige desde 20/10/2026. Nele,
`finNFSe` sai do grupo `IBSCBS` e vem em `infDPS`, entre `tpEmit` e
`cLocEmi`, sempre informado; `xDescServ` vem depois de `cNBS`; e `CST` e
`cClassTrib` ficam direto em `IBSCBS/valores/trib`, sem `gIBSCBS`. `buildDps`
confere a DPS no XSD do mesmo pacote, e cada leiaute é recusado pelo XSD do
outro. Sem `layout`, a saída é a mesma de antes, byte a byte. Em 02/11/2026 a
Sefin restrita recusou uma DPS do leiaute de produção com E1235 (#197).

O que o XSD mudou em relação ao legado:

- `verAplic` tem até 20 caracteres (`TSVerAplic`), na DPS e no evento.
- Tomador no exterior: `cEndPost`, `xCidade`, `xEstProvReg`, `xLgr`, `nro` e
  `xBairro` obrigatórios (`TCEnderExt` e `TCEndereco`), com os tamanhos do
  XSD.
- `dest` é filho de `IBSCBS`, depois de `indDest`, e só existe com `indDest` 1
  (Anexo I, E0910). O legado o punha depois de `toma`.
- `tribMun`: sem `cLocIncid` (não existe na DPS 1.01) e `pAliq` depois de
  `tpRetISSQN`, com 2 casas (`TSDec1V2`). O legado invertia a ordem e usava 4
  casas.
- O pedido de cancelamento não leva `nPedRegEvento`, ausente do XSD (1.00 e
  1.01) e do Anexo II v1.01.

A inscrição municipal do prestador é opcional: `prest.im` sai como `<IM>`
entre `CNPJ` e `email` (`TCInfoPrestador`), com 1 a 15 caracteres
(`TSInscMun`); vazia ou maior é recusada com `DPS_FIELD_INVALID`. Sem
`prest.im`, a DPS fica sem `<IM>`, como no legado. Quem monta decide quando
mandá-la: pela E0120, ela não vai quando o prestador não tem cadastro
complementar no CNC do município emissor.

## DANFSe

O subcaminho `@freecorps/fiscal-nfse/danfse` (Node) gera o DANFSe em PDF a
partir do XML da NFS-e autorizada. Portado de `convex/engine/danfse.ts`, sem
importar nada de `convex/`:

```ts
renderDanfse(nfseXml: string, options?: { mark?: "simulated" | "restricted" }): Promise<Uint8Array>
readNfseForDanfse(nfseXml: string): DanfseData
consultaPublicaUrl(chave: string): string
formatDecimal(value: string, places?: number): string
```

- **Entrada.** O XML devolvido pelo fisco, não um resumo montado pelo
  chamador. O PDF mostra chave de acesso (em grupos de 10) e QR de consulta
  pública, número da NFS-e, data de autorização (`dhProc`), emissão da DPS,
  competência, série e número da DPS, prestador (nome do grupo `emit`, CNPJ,
  e-mail, município), tomador (CPF, CNPJ, NIF ou sem NIF, endereço nacional
  ou no exterior), códigos do serviço (`cTribNac`, `cTribMun`, NBS),
  descrição, valor do serviço, moeda de origem na exportação, tributação do
  ISSQN, alíquota, retenção, `vISSQN` e `vLiq` quando a NFS-e os traz, e
  `xOutInf`. XML sem `infNFSe`, sem a DPS ou sem a chave no `Id` é recusado
  com `NfseError` `DANFSE_XML_INVALID`.
- **Marca.** `mark: "simulated"` imprime "SEM VALOR FISCAL — SANDBOX/SIMULADO";
  `"restricted"`, "SEM VALOR FISCAL — PRODUÇÃO RESTRITA". DPS com `tpAmb` 2
  recebe a marca de produção restrita mesmo sem a opção: ela não pode ser
  desligada. A marca aparece no cabeçalho, no rodapé de cada página e em
  diagonal, em transparência.
- **Valores** saem do texto decimal do XML (`formatDecimal`), sem ponto
  flutuante.
- **Determinismo.** Sem data de criação nem produtor: o mesmo XML e as mesmas
  opções dão os mesmos bytes. O pacote não consulta o relógio.
- **Texto.** A descrição longa continua em páginas seguintes, em vez de ser
  truncada como no legado. As fontes padrão do PDF só codificam WinAnsi:
  caracteres fora dela viram `?`.
- **QR** desenhado em vetor a partir da matriz de `qrcode` (`QRCode.create`),
  sem PNG embutido. A URL de consulta (`www.nfse.gov.br/consultapublica`) é a
  do legado e não foi conferida no portal.

**Dependências.** O ADR 0004 limita o pacote às dependências de `fiscal-nfe`.
A validação no XSD usa o mesmo `libxml2-wasm` 0.7.2 (MIT) que `fiscal-nfe`, já
no `bun.lock`, agora declarado também aqui. O DANFSe acrescenta, por decisão desta entrega, as mesmas bibliotecas que o
legado já usava e que já estavam no `bun.lock`: `pdf-lib` 1.17.1 e `qrcode`
1.5.4 (MIT). Elas ficam fora do ponto de entrada principal e de `/pure`. O
`qrcode` traz, pelo manifesto, as dependências da sua CLI (`yargs` e afins,
MIT/ISC); `create` não as usa, mas elas entram nos avisos de runtime
(`THIRD_PARTY_NOTICES.txt`). Os tipos vêm de `@types/qrcode`, aceito pelo
verificador de fronteiras só como declaração de uma dependência declarada.

## Valores

Valores e alíquota chegam como texto decimal (`"67.60"`, `"2.5"`), nunca como
centavos inteiros nem float, e passam por `@freecorps/fiscal-core`. Valores
monetários saem com 2 casas e a alíquota com 4. Casas além da escala do
leiaute são recusadas (`DECIMAL_PRECISION`); negativos e notação
exponencial também.

A PTAX segue o legado: cotação de venda do dia útil anterior ao fato gerador,
boletim de Fechamento, recuo de até 10 dias. A taxa é fixada em 6 casas com
half-up, o mesmo valor dos micros do legado. `convertToBrl` faz o produto
exato (`multiply` de fiscal-core) e arredonda em 2 casas com half-up, o mesmo
resultado de `convertToBrlCents` para valores positivos. O teste compara as
duas fórmulas em casos de borda.

## Desfechos

Os desfechos seguem `platform/convex/lib/operationValues.ts`:

| Situação                                                       | `kind`       | `code`                                        |
| -------------------------------------------------------------- | ------------ | --------------------------------------------- |
| 2xx com chave de 50 dígitos (ou `NFS` + chave) e NFS-e legível | `success`    | —                                             |
| 5xx, 429                                                       | `transient`  | `ADN_UNAVAILABLE`, `ADN_RATE_LIMITED`         |
| 401, 403 (gateway ou credencial, como no legado)               | `transient`  | `ADN_ACCESS_DENIED`                           |
| 4xx com `erros` estruturados                                   | `definitive` | `ADN_REJECTED`, com todos os códigos e textos |
| Erro local antes do envio                                      | `definitive` | código do `NfseError`, `sent: false`          |
| Exceção do transporte                                          | `uncertain`  | `TRANSPORT_UNCERTAIN`                         |
| 2xx sem NFS-e, corpo não-JSON, 4xx sem erros ou só com códigos | `uncertain`  | `RESPONSE_UNREADABLE`                         |
| 408, 1xx, 3xx                                                  | `uncertain`  | `HTTP_UNEXPECTED`                             |
| Duplicidade no código, mensagem ou complemento                 | `uncertain`  | `DPS_ALREADY_EXISTS`                          |

Todo desfecho de emissão enviado traz `dpsId` e `signedDpsXml`. O Id da DPS é
determinístico (município, CNPJ, série e número): diante de `uncertain` ou
`transient`, chame `consultByDps(dpsId)` antes de reenviar. Na consulta, exceção
do transporte é `transient` (`TRANSPORT_FAILED`), porque GET não tem efeito.
`consultByAccessKey` baixa a NFS-e autorizada para persistir o XML após a
reconciliação; o chamador confere que ela contém o Id da DPS consultada.

Só um 404 com o JSON do fisco confirma inexistência (`not-found`): um objeto
com o envelope do padrão nacional (`tipoAmbiente`, `versaoAplicativo` ou
`dataHoraProcessamento`, que a IMA devolve até no 404) ou com lista de
`erros`/`erro`/`alertas`. 404 vazio, HTML, texto ou outro JSON (como o erro de
rota do servidor de aplicação, com `timestamp`, `status`, `error` e `path`)
pode vir de uma rota inexistente ou de um proxy e vira `uncertain`
`CONSULT_INCONCLUSIVE`, sem liberar reenvio. O mesmo vale em
`consultByAccessKey`. 200 sem chave, 4xx e corpo ilegível também são
`uncertain`.

Todo desfecho `uncertain` que teve resposta traz `diagnostic`
(`ResponseDiagnostic`): `httpStatus`, `contentType` (tipo de mídia sem
parâmetros, opcional em `NfseHttpResponse`), `body` (`empty`, `json-object`,
`json-other`, `html`, `xml` ou `text`) e `keys`, até 20 nomes das chaves de
topo do JSON que tenham forma de identificador. Nunca valores: o corpo pode
trazer XML fiscal, chave de acesso ou dados do tomador. Sem resposta
(`TRANSPORT_UNCERTAIN`), `diagnostic` é `null`.

No cancelamento, 2xx é sucesso mesmo sem XML do evento, e a rejeição de evento
já registrado (no código, na mensagem ou no complemento) vira `success` com
`alreadyRegistered: true`, como no legado. Rejeição só com código é
`uncertain`: sem texto, não dá para descartar duplicidade. Base64 ou gzip
inválido gera `NfseError` `XML_DECOMPRESS_INVALID`.

`tpAmb` da DPS ou do evento precisa corresponder ao ambiente do alvo
(`producao` = 1, `producao-restrita` = 2); divergência para antes do envio.

## Alvos

| Alvo             | Ambiente            | Host                                 | Base                  | Assinatura |
| ---------------- | ------------------- | ------------------------------------ | --------------------- | ---------- |
| `sefin-nacional` | `producao-restrita` | `sefin.producaorestrita.nfse.gov.br` | `/SefinNacional`      | RSA-SHA256 |
| `sefin-nacional` | `producao`          | `sefin.nfse.gov.br`                  | `/SefinNacional`      | RSA-SHA256 |
| `campinas-adn`   | `producao-restrita` | `preprod-nfseapi.ima.sp.gov.br`      | `/notafiscal-ws/nfse` | RSA-SHA1   |
| `campinas-adn`   | `producao`          | `nfseapi.campinas.sp.gov.br`         | `/notafiscal-ws/nfse` | RSA-SHA1   |

Os quatro caminhos são explícitos no `NfseEndpoint` (`submitPath`, `dpsPath`,
`nfsePath`, relativos à base) e montados por `submitUrl`, `dpsUrl`, `nfseUrl`
e `eventsUrl`:

| Chamada                | Sefin Nacional                     | Campinas (IMA)                |
| ---------------------- | ---------------------------------- | ----------------------------- |
| Envio da DPS           | `POST {base}/nfse`                 | `POST {base}`                 |
| Consulta por DPS       | `GET {base}/dps/{id}`              | `GET {base}/dps/{id}`         |
| NFS-e pela chave       | `GET {base}/nfse/{chave}`          | `GET {base}/{chave}`          |
| Cancelamento (eventos) | `POST {base}/nfse/{chave}/eventos` | `POST {base}/{chave}/eventos` |

Os hosts e caminhos de Campinas vêm do guia da Prefeitura de 18/09/2026
(produção desde 21/09/2026), registrado no ADR 0004, e coincidem com os da
biblioteca `4success/nfse-campinas`. Até 09/10/2026 o pacote usava a base
`/notafiscal-ws` com os caminhos da Sefin: a consulta por DPS caía em
`/notafiscal-ws/dps/{id}`, rota que não existe (#197). O par do legado
(`novanfse.campinas.sp.gov.br`, `/notafiscal-ws/api/adn`, envio em `/dps`) está
desatualizado. RSA-SHA1 vem da rejeição E0714 no homolog antigo e precisa ser
reconfirmado no endpoint novo.

## Roteamento

`resolveRoute` percorre `ROUTE_RULES` em ordem; a primeira regra que casa
município, regime, subitem e vigência (inclusiva) decide. Cada regra tem fonte
textual. Fora de Campinas, o padrão é `sefin-nacional`. MEI segue as regras do
Simples. A rota não confere adesão do município nem credenciamento.

Campinas (3509502), conforme o ADR 0004 (proposto; provisório até o aceite):

| Regra | Regime      | Subitens                    | Vigência           | Resultado                             |
| ----- | ----------- | --------------------------- | ------------------ | ------------------------------------- |
| C1    | qualquer    | qualquer                    | até 20/09/2026     | ABRASF, `unsupported`                 |
| —     | Simples     | qualquer                    | 21/09 a 30/09/2026 | ABRASF, `unsupported`                 |
| —     | não optante | qualquer                    | 21/09 a 30/09/2026 | `campinas-adn`, alternativa ABRASF    |
| C5    | Simples     | qualquer                    | 01/10 a 31/10/2026 | `campinas-adn`, alternativa ABRASF    |
| C6    | Simples     | qualquer                    | desde 01/11/2026   | `sefin-nacional` (Res. CGSN 191/2026) |
| C2    | não optante | exceto 1.03/1.05/1.09/16.01 | desde 01/10/2026   | `campinas-adn`                        |
| C3    | não optante | 1.03/1.05/1.09/16.01        | 01/10 a 30/11/2026 | `campinas-adn`, alternativa ABRASF    |
| C4    | não optante | 1.03/1.05/1.09/16.01        | desde 01/12/2026   | `campinas-adn`                        |

Onde o ADR deixa o emissor à escolha, o padrão é `campinas-adn` e
`alternatives` registra o ABRASF. Quando só o ABRASF serve, o resultado é
`unsupported` com mensagem em pt-BR; a plataforma não opera esse emissor.

## Obrigatoriedade do IBS/CBS

`ibsCbsRequirement` diz se o grupo `IBSCBS` é obrigatório para regime,
subitem e data do fato gerador (`dCompet`), pela tabela `IBSCBS_RULES`, com o
mesmo formato de `ROUTE_RULES`: a primeira regra que casa regime e subitem dá
o início da obrigação (`since`), o `ruleId` e a fonte. A fonte é o Ato
Conjunto RFB/CGIBS 4/2026, art. 1º, III e § 1º, que conta a obrigação pelos
fatos geradores a partir de cada data:

| `ruleId`       | Regime                | Subitens         | Obrigatório desde |
| -------------- | --------------------- | ---------------- | ----------------- |
| `ato4-simples` | Simples, MEI incluído | qualquer         | 01/01/2027        |
| `ato4-iii-b`   | não optante           | 1.03, 1.05, 1.09 | 01/12/2026        |
| `ato4-iii-c`   | não optante           | 16.01            | 01/12/2026        |
| `ato4-iii-d`   | não optante           | os demais        | 01/10/2026        |

As plataformas digitais (alínea "a") e os fornecimentos fora da lista da LC
116 (alíneas "e" a "h") começam em 01/12/2026, mas não se reconhecem pelo
subitem; a regra fica com a data mais cedo, a da alínea "d". Mandar o grupo
antes da obrigação não é rejeitado (ocorrência 0-1 no leiaute 1.01). A função
não decide canal nem classificação (`cIndOp`, CST, `cClassTrib`), e não
conhece exigências de canal, como a do validador de Campinas.

## Exportação

O tomador no exterior usa NIF ou `cNaoNIF`, endereço completo em `endExt`
(código postal, cidade, estado/província/região) mais logradouro, número e
bairro, e o grupo `comExt` (moeda BACEN, `mdPrestacao`, `vincPrest` etc.). Sem
bairro no endereço, a região, o distrito ou `N/A` cabem em `TSBairro`. `tribISSQN=3`
(exportação) exige `cPaisResult`; `tribISSQN=4` (não incidência) é aceito.
O teste de exportação usa um tomador fictício no Canadá, valor em CAD e uma
resposta Olinda sintética, e confere a ordem dos grupos por DOM.

## O que não está provado

- Autorização, rejeição ou cancelamento reais em qualquer ambiente do fisco.
- Que o fisco aceite a DPS que passa no XSD: as regras de negócio do Anexo I
  só ele aplica. A forma sem `dest`, sem `cLocIncid` e com `pAliq` depois de
  `tpRetISSQN` segue o XSD e o Anexo I, mas não foi enviada à IMA nem à Sefin.
- Que o validador do fisco leia o padrão de `TSSerieDPS` sem as âncoras, como
  a cópia de runtime: é inferência da DPS real com série 20001, recusada só
  por outros campos.
- Formato real das respostas: as fixtures em `fixtures/adn/` são sintéticas,
  modeladas pelo tratamento do legado.
- Os caminhos de consulta e eventos e a política RSA-SHA1 no endpoint novo de
  Campinas.
- Cadeia ICP-Brasil, revogação e titularidade do certificado; a verificação
  local só confere a própria assinatura.
- Códigos e mensagens exatos de duplicidade: a detecção usa o padrão textual
  do legado.
- O DANFSe contra uma NFS-e real: os testes usam XML sintético no formato
  esperado do ADN. Conformidade com o leiaute oficial do DANFSe (NT da NFS-e
  nacional) e a URL de consulta pública não foram conferidas.

## Testes

`bun run nfse:test` (ou `vp test run packages/fiscal-nfse`). O pacote entra
também em `bun run platform:test`. Publicado no npm como `@freecorps/fiscal-nfse`.
`schema.test.ts` confere os hashes do manifesto, os originais no catálogo, o ajuste ao carregar e todas
as montagens de DPS e de cancelamento, sem e com assinatura, contra o XSD,
incluindo o equivalente sintético da exportação recusada em 09/10/2026.
