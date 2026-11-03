import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { formatCnpj } from "@freecorps/contracts";
// The same pure rules the import applies to a key (fiscal-nfe `validateIdentity`).
import {
  validateAccessKey,
  type AccessKeyIssuer,
  type AccessKeyParts,
  type AccessKeyReason,
} from "../../../packages/fiscal-core/src/accessKey";
import type { Organization } from "./organizations";
import { readingFrom, type BarcodeReading } from "./danfe-barcode";
// Only the type: the reader itself loads on the first photo.
import type { PhotoRead } from "./danfe-photo";
import { formatCpf, groupKey } from "./format";
import {
  Button,
  Callout,
  Card,
  CopyButton,
  DescriptionList,
  FormField,
  Icon,
  Page,
  PageHeader,
  StatusBadge,
  Textarea,
  buttonClass,
  controlProps,
} from "./ui";

/**
 * The official NF-e portal, with the key as the `nfe` parameter. The portal filling its form with
 * it was observed in the manual test recorded in #296 on 20/10/2026 and not tested again in this
 * delivery; "Copiar chave" covers a portal that stops doing it. Fixed origin; only the key,
 * already validated, goes in the query.
 */
const PORTAL = "https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx";
export function portalUrl(key: string): string {
  return `${PORTAL}?${new URLSearchParams({ tipoConsulta: "resumo", nfe: key }).toString()}`;
}

/**
 * The key as printed on a DANFE: groups of four separated by spaces, sometimes dots, hyphens or
 * slashes, and line breaks when copied from a PDF. Removes only those and uppercases; never
 * completes or replaces a character.
 */
export function normalizeKeyInput(input: string): string {
  return input.replace(/[\s./-]+/g, "").toUpperCase();
}

const emissionLabels: Record<string, string> = {
  "1": "Normal",
  "2": "Contingência FS-IA",
  "3": "Contingência SCAN (desativada)",
  "4": "Contingência EPEC",
  "5": "Contingência FS-DA",
  "6": "Contingência SVC-AN",
  "7": "Contingência SVC-RS",
  // MOC: 9 is the NFC-e's own off-line contingency; the key of a model 55 can still carry it.
  "9": "9 (contingência off-line, própria da NFC-e)",
};

type Checked = { ok: true; parts: AccessKeyParts; key: string } | { ok: false; message: string };

/** Asked whenever the key came from a photo: the barcode can belong to another DANFE in the shot. */
const COMPARE = "Chave lida do código de barras. Compare com a chave impressa no DANFE.";

/** What is wrong with the typed text, in words that point to the place in the DANFE. */
function check(input: string): Checked {
  const key = normalizeKeyInput(input);
  if (!key) return { ok: false, message: "Digite ou cole a chave de acesso impressa no DANFE." };
  const foreign = /[^0-9A-Z]/.exec(key);
  if (foreign)
    return {
      ok: false,
      message: `A chave só tem números e, no CNPJ do emitente, letras. Remova “${foreign[0]}”.`,
    };
  const result = validateAccessKey(key);
  if (result.ok) return { ok: true, parts: result.parts, key };
  return { ok: false, message: reasonMessage(result.reason, key) };
}
function reasonMessage(reason: AccessKeyReason, key: string): string {
  switch (reason) {
    case "length":
      return key.length < 44
        ? `A chave tem ${key.length} de 44 posições. Confira no DANFE se faltou algum grupo.`
        : `A chave tem ${key.length} posições, mais que as 44 de uma NF-e. Confira se outro número entrou junto.`;
    case "characters": {
      // Letters only in positions 7 to 18, the alphanumeric part of the issuer's CNPJ.
      const head = key.slice(0, 6).search(/[A-Z]/);
      const position = head >= 0 ? head + 1 : 19 + key.slice(18).search(/[A-Z]/);
      return `Há uma letra na posição ${position}. Letras só aparecem nas posições 7 a 18, do CNPJ do emitente; confira se é um número.`;
    }
    case "check_digit":
      return "O dígito verificador (última posição) não confere com as outras 43. Algum caractere está diferente do DANFE: confira a chave grupo por grupo.";
    case "model":
      return key.slice(20, 22) === "65"
        ? "Esta chave é de NFC-e (modelo 65), o cupom do consumidor. Esta consulta atende só NF-e modelo 55."
        : `A chave indica o modelo ${key.slice(20, 22)}. Esta consulta atende só NF-e modelo 55.`;
    case "state":
      return `As duas primeiras posições (${key.slice(0, 2)}) não são o código de uma UF.`;
    case "month":
      return `O mês de emissão (posições 5 e 6) é ${key.slice(4, 6)}, que não existe.`;
    case "number":
      return "O número da nota (posições 26 a 34) está zerado.";
    case "emission":
      return `O tipo de emissão (posição 35) é ${key[34]}, que não existe na NF-e.`;
    case "issuer":
      return "O CNPJ ou CPF do emitente (posições 7 a 20) não é válido.";
  }
}

/** A phone photo has a few MB; past this the file is not a DANFE picture worth decoding. */
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

type Photo =
  | { state: "idle" }
  | { state: "reading" }
  | { state: "refused"; title: string; message: string; tips?: boolean; tone?: "info" }
  | { state: "choose"; keys: string[] };

/** "10", "10 e 36", "10, 36 e 45". */
function listed(numbers: readonly number[]): string {
  return numbers.length > 1
    ? `${numbers.slice(0, -1).join(", ")} e ${numbers.at(-1)}`
    : String(numbers[0]);
}

/** Why the CODE-128 read is not a key: the lengths that are not 44, and a 44 with odd characters. */
function notKeyReason({ lengths, malformed }: { lengths: number[]; malformed: boolean }): string {
  const odd = "caracteres que uma chave não tem";
  if (!lengths.length) return `O código lido tem 44 posições, mas com ${odd}.`;
  const sizes =
    lengths.length > 1
      ? `Os códigos lidos têm ${listed(lengths)} posições`
      : `O código lido tem ${lengths[0]} ${lengths[0] === 1 ? "posição" : "posições"}`;
  return malformed ? `${sizes}, e o de 44 posições tem ${odd}.` : `${sizes}; a chave tem 44.`;
}

/** What a reading that does not fill the field tells the person; `one` fills it instead. */
function photoOutcome(reading: Exclude<BarcodeReading, { kind: "one" }>): Photo {
  switch (reading.kind) {
    case "none":
      return {
        state: "refused",
        title: "Não encontrei o código de barras da chave nesta imagem.",
        message: "Tente outra foto ou digite a chave no campo abaixo.",
        tips: true,
      };
    case "not_key":
      return {
        state: "refused",
        title: "O código de barras lido não é a chave de acesso.",
        message: `${notKeyReason(reading)} Fotografe o código de barras que fica acima da chave de acesso impressa, no alto do DANFE.`,
      };
    case "nfce":
      return {
        state: "refused",
        title: "Esta imagem é de uma NFC-e (modelo 65).",
        message:
          "O QR code lido é o do cupom do consumidor, e esta consulta atende só NF-e modelo 55. Aponte a câmera do celular para o QR code do cupom: ele abre a consulta da Sefaz do estado.",
      };
    case "many":
      return { state: "choose", keys: reading.keys };
  }
}
function photoAnnouncement(photo: Photo): string {
  if (photo.state === "refused") return `${photo.title} ${photo.message}`;
  if (photo.state === "choose")
    return `Encontrei ${photo.keys.length} chaves diferentes nesta imagem. Escolha a que você quer conferir.`;
  return "";
}

/**
 * Starts a check of an NF-e from its DANFE (#296): the person types or pastes the access key, or
 * reads it from the barcode of a photo, reviews it in groups of four and opens the public summary
 * in the official portal. Nothing here reads or writes platform data, so any member of the
 * organization can use it. The key stays in this component's state: never in the console
 * address, storage, logs or analytics. The photo is read in this tab (`danfe-photo.ts`) and not
 * kept: no reference to it survives the reading.
 */
export function DanfeLookup({ org }: { org: Organization }) {
  const id = useId();
  const field = `${id}-key`;
  const input = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  // Each refused check is read out, also the same refusal again on Enter with the focus already
  // in the field (focus() would then say nothing): a no-break space alternates at the end.
  const [announcement, setAnnouncement] = useState("");
  const [photo, setPhoto] = useState<Photo>({ state: "idle" });
  // The field holds a key read from the photo's barcode, not changed since: the person is asked
  // to compare it with the printed one.
  const [fromPhoto, setFromPhoto] = useState(false);
  // Set by a change in the field while a photo is read: its result then does not replace it.
  const editedWhileReading = useRef(false);
  const photoField = `${id}-photo`;
  const reading = photo.state === "reading";
  const typed = normalizeKeyInput(value).length;
  const error = checked && !checked.ok ? checked.message : undefined;
  const imports = org.capabilities.operateDocuments;
  // Back to where this role came from: imports, documents or, for a developer, the home.
  const back = imports
    ? ({ to: "/app/$organizationSlug/imports", label: "Importar XML" } as const)
    : org.capabilities.readDocuments
      ? ({ to: "/app/$organizationSlug/documents", label: "Documentos" } as const)
      : ({ to: "/app/$organizationSlug", label: "Início" } as const);

  function submit(event?: { preventDefault(): void }, text = value, photoKey = false) {
    event?.preventDefault();
    const result = check(text);
    setChecked(result);
    // Shows what was read, in the DANFE's groups of four, in the field the person corrects.
    const key = normalizeKeyInput(text);
    if (key && !/[^0-9A-Z]/.test(key)) setValue(key.replace(/(.{4})(?=.)/g, "$1 "));
    if (result.ok) {
      // The result's heading takes the focus and is read out: no status line on top of it, but
      // for a key from a photo, the request to compare it with the printed one.
      setAnnouncement(photoKey ? COMPARE : "");
      return;
    }
    // Moving the focus to the field reads its description, which holds the refusal; the status
    // line speaks only when the focus is already there, so the message is not read twice.
    if (document.activeElement !== input.current) {
      setAnnouncement("");
      input.current?.focus();
      return;
    }
    setAnnouncement((previous) =>
      previous === result.message ? `${result.message} ` : result.message,
    );
  }

  /** A key read from the photo goes to the field and through the same check as a typed one. */
  function takeKey(key: string) {
    setPhoto({ state: "idle" });
    setFromPhoto(true);
    submit(undefined, key, true);
  }

  function refusePhoto(next: Photo) {
    setPhoto(next);
    // The same outcome twice in a row is read again, like a repeated refusal of a typed key.
    const message = photoAnnouncement(next);
    setAnnouncement((previous) => (previous === message ? `${message} ` : message));
  }

  async function readFile(files: readonly File[]) {
    if (reading || !files.length) return;
    const file = files[0]!;
    if (files.length > 1)
      return refusePhoto({
        state: "refused",
        title: "Escolha uma imagem por vez.",
        message: "Solte ou escolha só a foto do DANFE que você quer conferir.",
      });
    // No type is common for HEIC/AVIF photos: the header check decides those.
    if (file.type && !file.type.startsWith("image/"))
      return refusePhoto({
        state: "refused",
        title: "Este arquivo não é uma imagem.",
        message: "Escolha uma foto ou uma captura de tela do DANFE, em JPEG, PNG ou WebP.",
      });
    if (file.size > MAX_PHOTO_BYTES)
      return refusePhoto({
        state: "refused",
        title: "A imagem passa de 25 MB.",
        message: "Use uma foto menor ou uma captura de tela do DANFE.",
      });
    setPhoto({ state: "reading" });
    setAnnouncement("Lendo a imagem…");
    editedWhileReading.current = false;
    let read: PhotoRead;
    try {
      // Loaded on the first photo, with its WebAssembly, from the console's own address.
      const { readPhoto } = await import("./danfe-photo");
      read = await readPhoto(file);
    } catch {
      return refusePhoto({
        state: "refused",
        title: "Não consegui ler a imagem.",
        message:
          "O leitor de código de barras não carregou ou parou no meio. Tente de novo, ou digite a chave no campo abaixo.",
      });
    }
    if (read.kind === "unreadable")
      return refusePhoto({
        state: "refused",
        title: "Não consegui abrir esta imagem.",
        message:
          "Tente uma foto em JPEG ou PNG. Fora do Safari, fotos em HEIC podem não abrir; uma captura de tela da foto resolve.",
      });
    if (read.kind === "too_large")
      return refusePhoto({
        state: "refused",
        title: `A imagem tem ${read.megapixels} megapixels; o limite é ${read.limit}.`,
        message: "Use uma foto em resolução menor ou uma captura de tela do DANFE.",
      });
    // The person typed in the field while the photo was read: what they typed stays.
    if (editedWhileReading.current)
      return refusePhoto({
        state: "refused",
        tone: "info",
        title: "Mantive o que você digitou.",
        message:
          "Você mexeu no campo enquanto a foto era lida, então a leitura não trocou a chave. Para usar a foto, escolha a imagem de novo.",
      });
    const result = readingFrom(read.codes);
    if (result.kind === "one") takeKey(result.key);
    else refusePhoto(photoOutcome(result));
  }

  return (
    <Page>
      <Link
        to={back.to}
        params={{ organizationSlug: org.slug }}
        className={buttonClass({ variant: "ghost", size: "sm", className: "fiscal-back" })}
      >
        <Icon name="arrowLeft" />
        {back.label}
      </Link>
      <PageHeader
        eyebrow="Consulta pública da NF-e"
        title="Consultar NF-e pelo DANFE"
        description="Tem só o DANFE, em papel ou foto? Leia a chave de acesso pelo código de barras ou digite, confira e abra o resumo da nota no Portal da NF-e."
      />
      <Card title="Chave de acesso">
        <form className="fiscal-stack" noValidate onSubmit={submit}>
          <div
            className="fiscal-dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void readFile(Array.from(event.dataTransfer.files));
            }}
          >
            {/* No `capture`: on a phone the picker offers the camera and also the gallery, where
                a screenshot of a PDF DANFE is. Never natively disabled while reading: the input
                keeps the focus, and the click that would open the picker is refused. */}
            <input
              id={photoField}
              className="ui-visually-hidden"
              type="file"
              accept="image/*"
              aria-disabled={reading || undefined}
              aria-describedby={`${photoField}-help`}
              onClick={(event) => {
                if (reading) event.preventDefault();
              }}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                // Drops the browser's reference to the file; choosing the same one again reads it again.
                event.target.value = "";
                void readFile(files);
              }}
            />
            <span className="fiscal-dropzone__icon" aria-hidden="true">
              {reading ? <span className="ui-spinner" /> : <Icon name="upload" />}
            </span>
            <label className="fiscal-dropzone__label" htmlFor={photoField}>
              {reading ? "Lendo a imagem…" : "Ler a chave pela foto"}
            </label>
            <p id={`${photoField}-help`} className="ui-help">
              Fotografe o código de barras do DANFE ou escolha uma imagem. A leitura acontece neste
              navegador: a imagem não é enviada nem guardada.
            </p>
          </div>
          {photo.state === "refused" && (
            <Callout tone={photo.tone ?? "warning"} title={photo.title}>
              {photo.message}
              {photo.tips && (
                <ul className="ui-callout__list">
                  <li>
                    Enquadre o código de barras inteiro, com uma margem branca dos lados. Ele fica
                    acima da chave de acesso impressa, no alto do DANFE.
                  </li>
                  <li>Use boa luz, sem reflexo nem sombra sobre as barras.</li>
                  <li>Segure firme e espere o foco: as barras precisam sair nítidas.</li>
                </ul>
              )}
            </Callout>
          )}
          {photo.state === "choose" && (
            <Callout title={`Encontrei ${photo.keys.length} chaves diferentes nesta imagem`}>
              Escolha a do DANFE que você quer conferir e compare com a chave impressa.
              <ul className="fiscal-key-choices" aria-label="Chaves lidas da imagem">
                {photo.keys.map((key) => (
                  <li key={key}>
                    <Button className="fiscal-key-choice" onClick={() => takeKey(key)}>
                      <span className="ui-visually-hidden">Usar a chave </span>
                      <code>{groupKey(key)}</code>
                    </Button>
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          <FormField
            id={field}
            label="Chave de acesso da NF-e"
            help={`${fromPhoto ? `${COMPARE} ` : ""}44 posições, como impressas no DANFE. Espaços, pontos, hífens, barras e quebras de linha são ignorados. ${typed} de 44.`}
            error={error}
          >
            <Textarea
              {...controlProps(field, error, true)}
              ref={input}
              rows={2}
              value={value}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              className="ui-mono"
              onChange={(event) => {
                setValue(event.target.value);
                // A corrected key is checked again before the portal opens, and is the person's.
                setChecked(null);
                setFromPhoto(false);
                if (reading) editedWhileReading.current = true;
              }}
              onKeyDown={(event) => {
                // A key never has a line break: Enter checks it, like in a one-line field. Not
                // while an input method composes text, where Enter confirms the composition.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing)
                  submit(event);
              }}
            />
          </FormField>
          <p className="ui-visually-hidden" role="status" aria-live="polite">
            {announcement}
          </p>
          <div className="ui-actions">
            <Button type="submit" variant={checked?.ok ? "secondary" : "primary"}>
              Conferir chave
            </Button>
          </div>
        </form>
      </Card>
      {checked?.ok && (
        <Result
          key={checked.key}
          keyValue={checked.key}
          parts={checked.parts}
          fromPhoto={fromPhoto}
        />
      )}
      <Callout title="Esta consulta não importa a nota">
        Abrir o portal não traz a nota para a plataforma nem muda nada nela.{" "}
        {imports ? (
          <>
            Para guardar o documento com os itens e o histórico, importe o XML em{" "}
            <Link
              className="ui-link"
              to="/app/$organizationSlug/imports"
              params={{ organizationSlug: org.slug }}
            >
              Importar XML
            </Link>
            .
          </>
        ) : (
          "Para guardar o documento com os itens e o histórico, o XML precisa ser importado por quem tem papel de Operador, Administrador ou Proprietário, ou por uma integração."
        )}
      </Callout>
    </Page>
  );
}

function issuerRow(issuer: AccessKeyIssuer) {
  switch (issuer.kind) {
    case "CNPJ":
      return { term: "CNPJ do emitente", value: formatCnpj(issuer.document) };
    case "CPF":
      return { term: "CPF do emitente", value: formatCpf(issuer.document) };
    case "CNPJ_OR_CPF":
      // The key does not say which one: both readings of the same 14 positions.
      return {
        term: "CNPJ ou CPF do emitente",
        value: `${formatCnpj(issuer.document)} ou ${formatCpf(issuer.document.slice(3))}`,
      };
  }
}
function Result({
  keyValue,
  parts,
  fromPhoto,
}: {
  keyValue: string;
  parts: AccessKeyParts;
  fromPhoto: boolean;
}) {
  const issuer = issuerRow(parts.issuer);
  const heading = useRef<HTMLHeadingElement>(null);
  // Mounted on each valid check (keyed by the key): the person lands on what was read.
  useEffect(() => heading.current?.focus(), []);
  return (
    <Card
      title="Lido da chave"
      titleRef={heading}
      description={`${fromPhoto ? `${COMPARE} ` : ""}O dígito verificador confere. Isso mostra que a chave está bem formada, não que a NF-e exista ou esteja autorizada.`}
      actions={<StatusBadge tone="info">Não consultada</StatusBadge>}
    >
      <div className="fiscal-stack">
        <div className="fiscal-key">
          <code>{groupKey(keyValue)}</code>
          <CopyButton value={keyValue} label="Copiar chave" />
        </div>
        <DescriptionList
          items={[
            { term: "UF", value: `${parts.state} (código ${parts.stateCode})` },
            {
              term: "Mês de emissão",
              value: `${parts.yearMonth.slice(2)}/20${parts.yearMonth.slice(0, 2)}`,
            },
            { term: "Modelo", value: "55 (NF-e)" },
            { term: "Série", value: parts.series },
            { term: "Número", value: parts.number },
            { term: issuer.term, value: <span className="ui-mono">{issuer.value}</span> },
            { term: "Tipo de emissão", value: emissionLabels[parts.emission] ?? parts.emission },
          ]}
        />
        <div className="ui-actions">
          <a
            className={buttonClass({ variant: "primary" })}
            href={portalUrl(keyValue)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Consultar no Portal da NF-e
            <Icon name="arrowRight" />
            <span className="ui-visually-hidden"> (abre em nova aba)</span>
          </a>
        </div>
        <Callout title="O que acontece no portal">
          <ul className="ui-callout__list">
            <li>
              O portal oficial abre em outra aba, com a chave preenchida. Se o campo vier vazio,
              cole a chave copiada.
            </li>
            <li>
              Você resolve o CAPTCHA lá, e o resultado fica no portal: nada volta para o console.
            </li>
            <li>
              No resumo, dados do destinatário e dos produtos podem aparecer parcialmente ocultos.
            </li>
            <li>
              A Consulta Completa e o download do XML exigem certificado digital no próprio portal.
            </li>
          </ul>
        </Callout>
      </div>
    </Card>
  );
}
