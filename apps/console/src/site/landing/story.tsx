import {
  cityHall,
  crate,
  delivery,
  desk,
  intake,
  manifest,
  plant,
  register,
  transmitter,
  truck,
  validator,
} from "./figures/index.ts";
import { brazilMap } from "./map.ts";
import { Reform } from "./reform.tsx";
import { Arrow, Iso, sandboxEntry } from "./shell.tsx";

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-field" aria-hidden="true">
        <canvas className="shader" data-shader="hero" />
      </div>
      <div className="hero-inner">
        <div className="hero-copy">
          <h1 id="hero-title">
            NF-e e NFS-e.
            <br />
            <em>Um contrato.</em>
          </h1>
          <p className="lead">
            Importe XML de NF-e modelo 55 e consulte documentos normalizados pela API, pelo SDK ou
            pelo console. A emissão de NFS-e existe só no sandbox, sem validade fiscal.
          </p>
          <div className="actions">
            <a className="btn btn-primary" href={sandboxEntry}>
              Começar no sandbox
              <Arrow />
            </a>
            <a className="btn btn-ghost" href="/docs/">
              Ler a documentação
            </a>
          </div>
        </div>
        <Iso
          figure={plant()}
          className="hero-figure"
          label="Linha de produção fiscal: uma pilha bagunçada de XML entra na esteira, passa pela conferência do XSD, recebe o carimbo do hash do original e sai como JSON. A antena que transmite notas ao fisco ainda está em construção."
        />
      </div>
    </section>
  );
}

const terms = [
  "Emissor Nacional",
  "DPS",
  "NFC-e",
  "GINFES",
  "ISSNet",
  "Betha",
  "WebISS",
  "SOAP",
  "certificado A1",
  "contingência",
  "DANFE",
  "DANFSe",
  "NSU",
  "DistribuiçãoDFe",
  "rejeição 539",
  "RPS em lote",
  "ICMS",
  "ISS",
  "IBS",
  "CBS",
  "chave de acesso",
  "homologação",
  "SEFAZ-MG",
  "manifestação",
];

export function Chaos() {
  return (
    <section className="chaos" id="problema" aria-labelledby="chaos-title">
      <div className="chaos-stage">
        <canvas className="shader chaos-noise" data-shader="chaos" aria-hidden="true" />
        <ul className="chaos-terms" aria-hidden="true">
          {terms.map((term, i) => (
            <li key={term} className={`t${i + 1}`}>
              {term}
            </li>
          ))}
        </ul>
        <div className="chaos-copy">
          <h2 id="chaos-title">O Brasil tem milhares de jeitos de emitir uma nota.</h2>
          <p>
            Cada prefeitura com seu leiaute, cada estado com sua SEFAZ, certificado vencendo e a
            Reforma Tributária mudando tudo até 2033. A gente começa pelo que já chega até você: o
            XML.
          </p>
          <code className="chaos-call">
            <span>POST</span> /v1/imports
          </code>
        </div>
      </div>
    </section>
  );
}

const stations = [
  {
    figure: intake(),
    name: "Entrada",
    title: "XML de NF-e modelo 55",
    body: "Envie o XML dos seus fornecedores pela API, pelo SDK ou pelo console, sem certificado. Com o A1, a empresa pode ativar no console a captura das NF-e emitidas contra o CNPJ dela, sem manifestação.",
    op: "reserveImport, controlCapture",
    label: "Bandeja de entrada com folhas de XML e uma antena recebendo documentos.",
  },
  {
    figure: validator(),
    name: "Validação",
    title: "Conferido antes de virar documento",
    body: "O XML da NF-e passa pelo XSD oficial e pela conferência da chave e da empresa. A recusa volta com o código e uma mensagem em português.",
    op: "IDENTITY_INVALID, COMPANY_MISMATCH",
    label: "Esteira com um portal de luz conferindo uma folha e um painel mostrando XSD sem erros.",
  },
  {
    figure: transmitter(),
    name: "Processamento",
    title: "Assíncrono, sem efeito em dobro",
    body: "Cada arquivo vira uma operação com estado e tentativas. O mesmo XML não gera dois documentos. A transmissão às SEFAZ e às prefeituras está em construção.",
    op: "getOperation, import.completed",
    label: "Antena com um feixe de luz apontado para um prédio público.",
  },
  {
    figure: delivery(),
    name: "Entrega",
    title: "Direto no seu sistema",
    body: "Webhook assinado com HMAC, JSON normalizado com decimais exatos e o XML original guardado com hash SHA-256.",
    op: "x-fnfe-signature, documentJson",
    label: "Tubo pneumático levando a nota até o prédio do seu sistema, com janelas acesas.",
  },
];

export function Pipeline() {
  return (
    <section className="pipeline" id="produto" aria-labelledby="pipeline-title">
      <div className="pipeline-sticky">
        <div className="section-head">
          <h2 id="pipeline-title">Do XML ao seu sistema, em quatro estações.</h2>
        </div>
        <ol className="pipeline-track">
          {stations.map((station, i) => (
            <li key={station.name} className="station">
              <Iso figure={station.figure} label={station.label} className="station-figure" />
              <div className="station-copy">
                <p className="station-name">
                  <span className="station-n">{i + 1}</span>
                  {station.name}
                </p>
                <h3>{station.title}</h3>
                <p>{station.body}</p>
                <code>{station.op}</code>
              </div>
            </li>
          ))}
        </ol>
        {/* Shown only while the section is pinned and client.ts is running:
            each stop scrolls the walk to its station. */}
        <ol className="pipeline-rail" aria-label="Estações">
          {stations.map((station, i) => (
            <li key={station.name}>
              <button type="button" data-station={i}>
                <span className="rail-n">{i + 1}</span>
                {station.name}
              </button>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// Every model keeps its cell so the bento holds its shape; the ones the
// platform does not handle yet say so in the code line and the body.
const documents = [
  {
    cls: "doc-nfe",
    name: "NF-e",
    code: "modelo 55 · importação",
    body: "Venda e circulação de mercadoria. Importação do XML, com itens, valores exatos e o original guardado.",
    figure: crate(),
    label: "Pilha de caixas de mercadoria com uma etiqueta acesa.",
  },
  {
    cls: "doc-nfce",
    name: "NFC-e",
    code: "modelo 65 · previsto",
    body: "Previsto, sem data. Ainda não importa nem emite.",
    figure: register(),
    label: "Caixa registradora com o visor aceso.",
  },
  {
    cls: "doc-nfse",
    name: "NFS-e Nacional",
    code: "DPS 1.01 · sandbox",
    body: "Emissão e cancelamento só no sandbox, com transporte simulado e nota sem validade fiscal.",
    figure: desk(),
    label: "Mesa com um laptop mostrando o envio de uma DPS.",
  },
  {
    cls: "doc-cte",
    name: "CT-e",
    code: "modelo 57 · previsto",
    body: "Previsto, sem data. Ainda não importa nem emite.",
    figure: truck(),
    label: "Caminhão de carga com os faróis acesos.",
  },
  {
    cls: "doc-mdfe",
    name: "MDF-e",
    code: "modelo 58 · previsto",
    body: "Previsto, sem data. Ainda não importa nem emite.",
    figure: manifest(),
    label: "Carreta com um manifesto aceso na lateral.",
  },
  {
    cls: "doc-municipal",
    name: "NFS-e municipal",
    code: "lote ABRASF · retirado",
    body: "A importação de lotes ABRASF foi retirada com a troca dos sistemas municipais pela NFS-e nacional. As notas já importadas continuam para consulta.",
    figure: cityHall(),
    label: "Prefeitura com colunas e prédios vizinhos de janelas acesas.",
  },
];

export function Documents() {
  return (
    <section className="documents" id="documentos" aria-labelledby="documents-title">
      <div className="section-head">
        <h2 id="documents-title">Dois modelos hoje, uma resposta.</h2>
        <p>
          O mesmo envelope JSON, os mesmos eventos e a mesma idempotência para NF-e e NFS-e. Os
          outros modelos aparecem marcados como previstos.
        </p>
      </div>
      <ul className="bento">
        {documents.map((doc) => (
          <li key={doc.name} className={`bento-cell ${doc.cls}`}>
            <div className="bento-copy">
              <h3>{doc.name}</h3>
              <p className="bento-code">{doc.code}</p>
              <p>{doc.body}</p>
            </div>
            <Iso figure={doc.figure} label={doc.label} className="bento-figure" />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Coverage() {
  const map = brazilMap();
  return (
    <section className="coverage" id="cobertura" aria-labelledby="coverage-title">
      <canvas className="shader coverage-glow" data-shader="coverage" aria-hidden="true" />
      <div className="coverage-inner">
        <div className="coverage-copy">
          <h2 id="coverage-title">Cobertura, sem arredondar.</h2>
          <p>
            Hoje a plataforma importa NF-e modelo 55. A primeira captura real de NF-e foi de uma
            empresa piloto, em 22/10/2026. A emissão de NFS-e existe só no sandbox, com transporte
            simulado. A transmissão às SEFAZ e às prefeituras está em construção.
          </p>
          <dl className="stats">
            <div>
              <dt>modelo importado</dt>
              <dd>1</dd>
            </div>
            <div>
              <dt>emitido só no sandbox</dt>
              <dd>1</dd>
            </div>
            <div>
              <dt>notas emitidas com validade fiscal</dt>
              <dd>0</dd>
            </div>
          </dl>
        </div>
        <figure className="coverage-map">
          <svg
            className="map"
            viewBox={map.viewBox}
            role="img"
            aria-label="Mapa do Brasil e seus estados. De Campinas, onde roda a homologação da NFS-e, sai uma rota para cada capital. As rotas mostram o caminho em construção, não notas emitidas."
            dangerouslySetInnerHTML={{ __html: map.svg }}
          />
          <figcaption>
            <span className="key-origin">homologação em Campinas</span>
            <span className="key-capital">capitais em construção</span>
          </figcaption>
        </figure>
      </div>
      <Reform />
    </section>
  );
}
