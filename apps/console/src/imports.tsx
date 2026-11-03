import { importCodeMessages } from "./import-messages";
import { RefusedFiles } from "./refused-files";
import {
  usageMessages,
  usageFailure,
  isUsageCode,
  UsageGuidance,
  type UsageOrg,
} from "./usage-errors";
import { usageErrorCode } from "./usage-messages";
import { environmentNames, useDeployment } from "./deployment";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConvex, useMutation } from "convex/react";
import { useQuery } from "./convex-query";
import { Link, useSearch, useNavigate } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import { useContent } from "./content";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { Organization } from "./organizations";
import { integrationManaged, originLabel, ScopeSteps } from "./product-components";
import {
  CompanyContext,
  RoleNotice,
  integrationRecordMessage,
  useCompanyChoice,
  type CompanyScope,
} from "./company-context";
import { formatDateTime } from "./format";
import { batchSummary } from "./import-summary";
import { importFileOutcome } from "../../../platform/convex/lib/importOutcome";
import {
  Button,
  Callout,
  Card,
  CodeBlock,
  DisabledReason,
  Disclosure,
  EmptyState,
  Icon,
  Page,
  PageHeader,
  Progress,
  SkeletonBlock,
  buttonClass,
  StatusBadge,
  type Tone,
} from "./ui";
type Scope = CompanyScope;
type Result = NonNullable<FunctionReturnType<typeof api.imports.selected>>;
type Recent = FunctionReturnType<typeof api.imports.recent>[number];
type LocalFile = { file: File; sha256: string };
/** One press of "Importar"/"Retomar". Cancelling stops it for good; a new attempt is a new run. */
type UploadRun = { stopped: boolean };
/**
 * What the server answered to a cancel. With `focus`, moving the focus reads it out, so it is not
 * also a live region (that would read it twice); without it, the live region announces it.
 */
type CancelOutcome = { notice: string; failure: string; focus: boolean };
/**
 * While the browser hands the XML over, an upload that shows no progress for this long is
 * abandoned. Idle time, not total time: a slow link keeps reporting progress, a hung one stops.
 */
const UPLOAD_IDLE_MS = 30_000;
/**
 * After the last byte leaves the browser, progress says nothing: the bytes may still sit in the
 * socket while a slow link drains them. The answer then gets one minute for the server plus one
 * second per 8 KiB (64 kbit/s, the slowest link assumed): 2 MiB waits about 5 min 16 s, within
 * the 15-minute upload ticket.
 */
const uploadAnswerLimit = (size: number) => 60_000 + Math.ceil(size / 8192) * 1000;
/** Why an upload request ended without the server's 200, with the server's code when it refused. */
class UploadFailure extends Error {
  readonly kind: "timeout" | "network" | "refused" | "aborted";
  readonly code: string | null;
  constructor(kind: UploadFailure["kind"], code: string | null = null) {
    super(`Upload ${kind}`);
    this.kind = kind;
    this.code = code;
  }
}
/** The server's error code in an upload reply (`{ error: { code } }`), when there is one. */
function replyCode(body: string) {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}
/**
 * Why the server refused a file, by what fixes it. Only a lapsed upload ticket or a passing
 * failure gets better with "Retomar"; the others say what has to change. `gone` is a file whose
 * reservation no longer takes an upload (expired, cancelled or already accepted).
 */
type Refusal = "ticket" | "reservation" | "content" | "stored" | "access" | "other" | "gone";
/**
 * The refusal behind a server code. `upload` is the upload route's reply (the console sees
 * `ACCESS_REVOKED` there; `SCOPE_DENIED` comes only from API-key uploads); `ticket` and `confirm`
 * are Convex errors, where `SCOPE_DENIED` means the role or the company grant changed and
 * `INVALID_FILE` at the confirmation means the stored original does not match the reservation.
 * A code outside these, from Convex, is left to the usual failure message (quota, integration…).
 */
function refusalOf(
  code: string | null | undefined,
  step: "upload" | "ticket" | "confirm",
): Refusal | null {
  if (code === "UPLOAD_EXPIRED") return step === "upload" ? "ticket" : "reservation";
  if (code === "SCOPE_DENIED") return "access";
  if (step === "confirm") return code === "INVALID_FILE" ? "stored" : null;
  if (code === "ACCESS_REVOKED") return "access";
  if (step === "ticket") return null;
  return code === "INVALID_FILE" || code === "FILE_TOO_LARGE" ? "content" : "other";
}
/** Refusals that no new upload or confirmation gets past: the row stops offering either. */
const unconfirmable = new Set<Refusal>(["reservation", "stored"]);
/** One sentence per refusal for every file it names, in singular or plural. */
function refusalAction(kind: Refusal, names: string[]) {
  const files = listNames(names),
    one = names.length === 1;
  switch (kind) {
    case "ticket":
      return one
        ? `O prazo do envio de ${files} terminou antes de o arquivo chegar. “Retomar esta importação” pede um prazo novo e envia de novo.`
        : `Os prazos dos envios de ${files} terminaram antes de os arquivos chegarem. “Retomar esta importação” pede prazos novos e envia de novo.`;
    case "reservation":
      return one
        ? `A reserva de ${files} venceu. Inicie uma “Nova importação” e escolha o arquivo de novo.`
        : `As reservas de ${files} venceram. Inicie uma “Nova importação” e escolha os arquivos de novo.`;
    case "content":
      return one
        ? `O conteúdo de ${files} não confere mais com o escolhido ou não pôde ser lido; o arquivo pode ter mudado depois de escolhido. Escolha-o de novo; se ele mudou, inicie uma “Nova importação”.`
        : `O conteúdo de ${files} não confere mais com o escolhido ou não pôde ser lido; os arquivos podem ter mudado depois de escolhidos. Escolha-os de novo, todos de uma vez; se mudaram, inicie uma “Nova importação”.`;
    case "stored":
      return one
        ? `O original guardado de ${files} não confere com a reserva e não pode ser confirmado. Inicie uma “Nova importação” e escolha o arquivo de novo.`
        : `Os originais guardados de ${files} não conferem com as reservas e não podem ser confirmados. Inicie uma “Nova importação” e escolha os arquivos de novo.`;
    case "access":
      return `${one ? "O envio" : "Os envios"} de ${files} ${one ? "foi recusado" : "foram recusados"} porque o acesso a esta empresa mudou. “Retomar esta importação” confere de novo; se a retomada for recusada, peça a quem administra a organização para conferir sua permissão.`;
    case "other":
      return `O servidor não aceitou ${one ? "o envio" : "os envios"} de ${files} agora. “Retomar esta importação” confere o estado e tenta de novo.`;
    case "gone":
      return one
        ? `A reserva de ${files} já não aceita envio; o estado atual está na linha do arquivo.`
        : `As reservas de ${files} já não aceitam envio; o estado atual está na linha de cada arquivo.`;
  }
}
/** Uploads that ended with no answer and that the server has not registered. */
const unansweredAction = (names: string[]) =>
  names.length === 1
    ? `O envio de ${names[0]} parou sem resposta no prazo ou perdeu a conexão, e o servidor ainda não registrou o arquivo. “Retomar esta importação” confere o estado de novo e só envia o que não chegou, sem duplicar.`
    : `Os envios de ${listNames(names)} pararam sem resposta no prazo ou perderam a conexão, e o servidor ainda não registrou esses arquivos. “Retomar esta importação” confere o estado de novo e só envia o que não chegou, sem duplicar.`;
/** Choosing files replaces the earlier choice, so the missing ones are asked for together. */
const missingAction = (names: string[]) =>
  names.length === 1
    ? `Falta o XML original de ${names[0]}: selecione-o de novo para enviá-lo.`
    : `Faltam os XMLs originais de ${listNames(names)}: selecione todos de uma vez, porque uma nova escolha substitui a anterior.`;
/** Whether the chosen file can still be read: a file changed on disk may fail here. */
async function readable(file: File) {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}
/** The XML chosen in this tab that is the reserved file: same name and same SHA-256. */
const localCopy = (chosen: LocalFile[], remote: { name: string; sha256: string }) =>
  chosen.find((item) => item.file.name === remote.name && item.sha256 === remote.sha256);
/**
 * What a file still waiting for its upload needs next, from its persisted state and the XMLs
 * chosen in this tab. The browser keeps no XML across a reload, so a reserved file needs its
 * original chosen again; an uploaded one only needs the confirmation, never a new upload. A file
 * this tab saw the server refuse for good (`stuck`) offers neither.
 */
function uploadStep(
  remote: { id: string; state: string; name: string; sha256: string },
  chosen: LocalFile[],
  stuck: ReadonlySet<string>,
): { ready: boolean; needsFile: boolean; hint: string } | null {
  if (remote.state !== "reserved" && remote.state !== "uploaded") return null;
  // Refused for good in this tab (lapsed reservation, stored original that does not match):
  // neither a new upload nor the confirmation would get past it.
  if (stuck.has(remote.id))
    return {
      ready: false,
      needsFile: false,
      hint: "O servidor não aceita mais o envio nem a confirmação deste arquivo. Inicie uma “Nova importação” e escolha-o de novo.",
    };
  if (remote.state === "uploaded")
    return {
      ready: true,
      needsFile: false,
      hint: "O servidor já recebeu este arquivo. “Retomar esta importação” confirma sem enviar de novo.",
    };
  if (localCopy(chosen, remote))
    return {
      ready: true,
      needsFile: false,
      hint: "XML original selecionado. “Retomar esta importação” envia.",
    };
  if (chosen.some((item) => item.file.name === remote.name))
    return {
      ready: false,
      needsFile: true,
      hint: `O ${remote.name} escolhido tem conteúdo diferente do reservado. Selecione o arquivo original ou, para importar este, inicie uma “Nova importação” e escolha-o de novo.`,
    };
  return {
    ready: false,
    needsFile: true,
    hint: `Selecione de novo o XML original ${remote.name} para enviá-lo; o navegador não guarda os arquivos ao recarregar a página.`,
  };
}
/** Each file with the SHA-256 the reservation declares, read from its bytes. */
async function prepare(selected: File[]): Promise<LocalFile[]> {
  const prepared = [];
  for (const file of selected) {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    prepared.push({
      file,
      sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      ),
    });
  }
  return prepared;
}
/** The synthetic NF-e of the demonstration company, served by the console itself. */
const EXAMPLE_PATH = "/examples/nfe-demonstracao.xml",
  EXAMPLE_NAME = "nfe-demonstracao.xml",
  EXAMPLE_TIMEOUT_MS = 15_000;
const EXAMPLE_MAX_BYTES = 2 * 1024 * 1024;
/**
 * The fetched example looks like the NF-e it should be: within the import limit and XML from the
 * first byte (`Blob.text()` already drops a UTF-8 BOM).
 */
function exampleShaped(size: number, head: string) {
  return size > 0 && size <= EXAMPLE_MAX_BYTES && /^<(\?xml|NFe\b|nfeProc\b)/.test(head);
}
/** Up to three names, then how many more: a 20-file batch stays one readable line. */
const listNames = (names: string[]) => {
  const shown = names.slice(0, 3),
    more = names.length - shown.length;
  if (more) return `${shown.join(", ")} e mais ${more}`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} e ${shown.at(-1)}` : (shown[0] ?? "");
};

export { importCodeMessages } from "./import-messages";
/** The file's content decides these: the same original with the same processor fails again. */
const contentCodes = new Set([
  "COMPANY_MISMATCH",
  "IDENTITY_INVALID",
  "RESULT_TOO_LARGE",
  ...Object.keys(importCodeMessages).filter(
    (code) => code.startsWith("XML_") || code.startsWith("NFSE_"),
  ),
]);
export type FileOutcome = {
  tone: "success" | "warning" | "danger" | "pending";
  title: string;
  /** Result code for support, when there is one. */
  code: string | null;
  /** What the person can do about it, when anything. */
  hint: string;
};
const pendingStates: Record<string, string> = {
  reserved: "Aguardando envio",
  uploaded: "Enviado, aguardando confirmação",
  accepted: "Na fila de processamento",
  queued: "Na fila de processamento",
  running: "Processando",
  retry_wait: "Aguardando nova tentativa automática",
  reconciling: "Conferindo o processamento",
};
/**
 * State of one file, in words and tone; never "concluído" for a rejected XML. Which outcome it is
 * comes from the rule the Início also uses (`importFileOutcome`, #507).
 */
export function fileOutcome(file: { state: string; code: string | null }): FileOutcome {
  const code = file.code;
  switch (importFileOutcome(file)) {
    case "not-sent":
      return {
        tone: "warning",
        title: "Envio não concluído",
        code: null,
        hint: "A reserva expirou ou foi cancelada antes do envio. Importe o arquivo de novo.",
      };
    case "paused":
      return {
        tone: "warning",
        title: "Processamento pausado",
        code,
        hint: code ? (importCodeMessages[code] ?? "") : "",
      };
    case "failed":
      return {
        tone: "danger",
        title: "Falha no processamento",
        code,
        hint: code
          ? (importCodeMessages[code] ??
            usageMessages[code] ??
            "Erro não identificado; informe o código ao suporte.")
          : "",
      };
    case "running":
      return {
        tone: "pending",
        title: pendingStates[file.state] ?? "Em andamento",
        code,
        hint: "",
      };
    case "imported":
    case "duplicate":
      return { tone: "success", title: importCodeMessages[code!]!, code, hint: "" };
    case "caveat":
      return {
        tone: "warning",
        title: "Importado com ressalva",
        code,
        hint: importCodeMessages[code!]!,
      };
    case "refused":
      return {
        tone: "danger",
        title: "XML recusado",
        code,
        hint:
          (code && importCodeMessages[code]) ??
          "O processamento terminou sem documento reconhecido. Informe o código ao suporte.",
      };
  }
}
/** Tone of the badge: what is still running reads as neutral, never as a result. */
const badgeTone = (tone: FileOutcome["tone"]): Tone => (tone === "pending" ? "neutral" : tone);
export { batchSummary };
function formatImportResult(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return (
      "Resultado armazenado com JSON inválido. Conteúdo preservado para conferência:\n" + value
    );
  }
}
/** State of the reprocessing operation just requested. */
const operationStates: Record<string, string> = {
  queued: "na fila",
  running: "processando",
  retry_wait: "aguardando nova tentativa",
  reconciling: "conferindo o processamento",
  paused: "pausado",
  failed: "falhou",
  succeeded: "concluído; o resultado acima já é o novo",
};
export function Imports({ org, contextKey }: { org: Organization; contextKey: string }) {
  const search = useSearch({ strict: false }),
    navigate = useNavigate();
  const select = (id: Id<"companies">) => {
    void navigate({
      to: "/app/$organizationSlug/imports",
      params: { organizationSlug: org.slug },
      search: { company: id },
    });
  };
  // The steps follow the company in use, also when it came from memory or is the only one.
  const choice = useCompanyChoice(org, contextKey, search.company ?? "");
  const { environment } = useDeployment();
  return (
    <Page>
      <PageHeader
        eyebrow={`Documentos / ${environmentNames[environment]}`}
        title="Importar XML"
        description="Envie até 20 XMLs de NF-e modelo 55, com até 2 MiB cada."
        actions={
          <Link
            to="/app/$organizationSlug/imports/danfe"
            params={{ organizationSlug: org.slug }}
            className={buttonClass()}
          >
            Consultar pelo DANFE
          </Link>
        }
      />
      {/* The steps guide the choice of a company; once it is made they would only repeat the
          picker below, as in Documentos. */}
      {choice.candidate && choice.company !== null ? null : (
        <ScopeSteps company={false} finalLabel="Enviar arquivos" />
      )}
      <CompanyContext
        org={org}
        contextKey={contextKey}
        selected={search.company ?? ""}
        onSelect={select}
        id="import-company"
        label="Empresa participante do XML"
        choice={choice}
      >
        {(company, scope) => (
          <>
            <RoleNotice org={org} company={company} action="enviar XML" />
            <ImportFlow
              organizationSlug={org.slug}
              key={company.id}
              scope={scope}
              writable={company.canWrite}
              demonstration={company.kind === "demonstration"}
              org={org}
            />
          </>
        )}
      </CompanyContext>
    </Page>
  );
}
export function ImportFlow({
  scope,
  writable,
  organizationSlug,
  org,
  demonstration = false,
}: {
  scope: Scope;
  writable: boolean;
  organizationSlug: string;
  /** The demonstration company: its synthetic example can be imported in one step. */
  demonstration?: boolean;
  /** Who reads the quota notice: managers get the link to Uso e limites, the others a manager. */
  org?: UsageOrg;
}) {
  const convex = useConvex();
  const reserve = useMutation(api.imports.reserve),
    ticket = useMutation(api.imports.upload),
    confirm = useMutation(api.imports.confirm),
    cancel = useMutation(api.imports.cancel);
  const recent = useQuery(api.imports.recent, scope);
  const [allRecent, setAllRecent] = useState(false);
  const search = useSearch({ strict: false }),
    navigate = useNavigate();
  const rawImportId = search.batch ?? null;
  const [navigating, setNavigating] = useState(false);
  const setImportId = (id: Id<"imports"> | null, onSuccess?: () => void) => {
    setNavigating(true);
    void navigate({
      to: "/app/$organizationSlug/imports",
      params: { organizationSlug },
      search: { company: scope.companyId, batch: id ?? undefined },
      replace: true,
    })
      .then(() => {
        if (alive.current) onSuccess?.();
      })
      .catch(() => {
        if (alive.current) setError("Não foi possível trocar a importação. Tente novamente.");
      })
      .finally(() => {
        if (alive.current) setNavigating(false);
      });
  };
  const [intent, setIntent] = useState(() => crypto.randomUUID());
  const [files, setFiles] = useState<LocalFile[]>([]),
    [error, setError] = useState<ReactNode>("");
  const [busy, setBusy] = useState(false),
    [reading, setReading] = useState(false),
    [cancelling, setCancelling] = useState(false),
    [cancelOutcome, setCancelOutcome] = useState<CancelOutcome | null>(null),
    [progress, setProgress] = useState<Record<string, number>>({}),
    [exampleRunning, setExampleRunning] = useState(false),
    // The example attempts that failed in a row (each one a new alert, read again) and why the
    // last one did: no answer, or an answer that is not the file.
    [exampleFailure, setExampleFailure] = useState<{
      count: number;
      content: boolean;
    } | null>(null),
    // The server already holds this intent with other files: only a new import goes on.
    [conflicted, setConflicted] = useState(false),
    // The chosen files are the example this panel fetched, not files the person picked.
    [exampleChosen, setExampleChosen] = useState(false);
  // Files whose upload or confirmation the server refused for good in this tab.
  const [stuck, setStuck] = useState<ReadonlySet<string>>(() => new Set());
  const alive = useRef(true),
    requests = useRef(new Set<XMLHttpRequest>()),
    run = useRef<UploadRun | null>(null),
    exampleTaken = useRef(false),
    // Each set of files sent for reservation in this import and the intent it went under: a
    // reservation whose answer was lost is recovered with its own key, never another batch.
    intents = useRef(new Map<string, ReturnType<typeof crypto.randomUUID>>()),
    // What the example re-checks after its fetch: the render it started from is stale by then.
    latest = useRef({ blocked: false, batch: false }),
    sendArea = useRef<HTMLDivElement>(null),
    outcome = useRef<HTMLDivElement>(null);
  // The cancel button leaves with the pending uploads; focus goes to what the server answered.
  useEffect(() => {
    if (cancelOutcome?.focus) outcome.current?.focus();
  }, [cancelOutcome]);
  const result = useQuery(
    api.imports.selected,
    rawImportId !== null ? { ...scope, batch: rawImportId, includeResults: false } : "skip",
  );
  const importId = result?.id ?? null;
  // A URL with a batch is never a request to create another import.
  const unavailableSelection = rawImportId !== null && !result;
  const controlsBlocked = navigating || unavailableSelection;
  latest.current = { blocked: cancelling || controlsBlocked, batch: rawImportId !== null };
  const pendingUploads = result?.files.some((file) =>
    ["reserved", "uploaded"].includes(file.state),
  );
  // An integration's batch is read here but managed by the integration; the server agrees.
  const integrationBatch = result?.origin.kind === "integration";
  // Resuming only offers what can move: a confirmation, or an upload whose original is chosen.
  const waiting = (result?.files ?? []).map((file) => ({
    file,
    step: uploadStep(file, files, stuck),
  }));
  const unchosen = waiting.filter(({ step }) => step?.needsFile).map(({ file }) => file.name);
  const resumable = waiting.some(({ step }) => step?.ready);
  const submitBlocked =
    busy ||
    cancelling ||
    controlsBlocked ||
    integrationBatch ||
    (!files.length && !importId) ||
    (!!importId && !resumable);
  const submitReason = busy
    ? ""
    : cancelling
      ? "Aguarde a resposta do cancelamento."
      : navigating
        ? "Aguarde a troca de importação."
        : unavailableSelection
          ? "Esta importação não está disponível; escolha outra ou inicie uma nova."
          : integrationBatch && result
            ? integrationManaged(result.origin)
            : !files.length && !importId
              ? "Escolha de 1 a 20 arquivos XML para importar."
              : importId && !pendingUploads
                ? "Nenhum arquivo desta importação aguarda envio. Use “Nova importação” para enviar outros XMLs."
                : importId && !resumable
                  ? unchosen.length === 1
                    ? `Para retomar, selecione de novo o XML original de ${unchosen[0]}.`
                    : unchosen.length
                      ? `Para retomar, selecione de uma vez os XMLs originais de ${listNames(unchosen)}; uma nova escolha substitui a anterior.`
                      : "O servidor não aceita mais o envio nem a confirmação dos arquivos pendentes. Use “Nova importação” para enviá-los de novo."
                  : "";
  // A blocked drop area says why in place of its limits, on the same line, so nothing below
  // moves. Reading and sending are its own waits; any other block repeats the reason under the
  // buttons, which stays the one assistive technology reads.
  const selectBlocked = busy || cancelling || controlsBlocked;
  const selectReason = reading
    ? "Aguarde a leitura dos arquivos."
    : busy
      ? "Aguarde o fim do envio."
      : selectBlocked
        ? submitReason
        : "";
  const selectReasonOwn = reading || busy;
  // The example starts a new import of its own: never on an open batch, never over chosen files.
  const exampleReason = busy
    ? ""
    : importId
      ? "Uma importação está aberta. Para importar o exemplo de novo, use “Nova importação”."
      : files.length && conflicted
        ? "Esta tentativa já foi registrada com outros arquivos. Use “Nova importação” para importar o exemplo."
        : files.length && exampleChosen
          ? "O exemplo já está escolhido. Use “Importar arquivos” para tentar o exemplo de novo."
          : files.length
            ? "Há arquivos escolhidos. Importe-os ou use “Nova importação” para importar o exemplo."
            : selectBlocked
              ? submitReason
              : "";
  const exampleBlocked = busy || selectBlocked || !!exampleReason;
  useEffect(() => {
    alive.current = true;
    const active = requests.current;
    return () => {
      alive.current = false;
      for (const request of active) request.abort();
    };
  }, []);
  async function select(selected: File[]) {
    if (busy || cancelling || controlsBlocked) return;
    setError("");
    setExampleFailure(null);
    if (
      !selected.length ||
      selected.length > 20 ||
      selected.some(
        (file) => !/\.xml$/i.test(file.name) || file.size < 1 || file.size > 2 * 1024 * 1024,
      )
    ) {
      setError("Escolha de 1 a 20 arquivos XML, com até 2 MiB cada. ZIP não é aceito.");
      return;
    }
    setBusy(true);
    setReading(true);
    try {
      const prepared = await prepare(selected);
      if (alive.current) {
        setFiles(prepared);
        setExampleChosen(false);
        setConflicted(false);
      }
    } finally {
      if (alive.current) {
        setBusy(false);
        setReading(false);
      }
    }
  }
  function send(url: string, token: string, file: File, id: string) {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      requests.current.add(xhr);
      let timer: ReturnType<typeof setTimeout> | undefined,
        expired = false,
        handedOver = false;
      // Two limits: silence while the bytes are handed over, then the wait for the answer.
      const arm = (limit: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          expired = true;
          xhr.abort();
        }, limit);
      };
      xhr.open("POST", url);
      xhr.setRequestHeader("X-Upload-Token", token);
      xhr.setRequestHeader("Content-Type", "application/xml");
      xhr.upload.onprogress = (event) => {
        if (!handedOver) arm(UPLOAD_IDLE_MS);
        if (event.lengthComputable && alive.current)
          setProgress((value) => ({
            ...value,
            [id]: Math.round((event.loaded * 100) / event.total),
          }));
      };
      xhr.upload.onload = () => {
        handedOver = true;
        arm(uploadAnswerLimit(file.size));
      };
      const done = () => {
        clearTimeout(timer);
        requests.current.delete(xhr);
      };
      xhr.onload = () => {
        done();
        if (xhr.status === 200) resolve();
        else reject(new UploadFailure("refused", replyCode(xhr.responseText)));
      };
      xhr.onerror = () => {
        done();
        reject(new UploadFailure("network"));
      };
      xhr.onabort = () => {
        done();
        reject(new UploadFailure(expired ? "timeout" : "aborted"));
      };
      xhr.send(file);
      arm(UPLOAD_IDLE_MS);
    });
  }
  /** The persisted state of one file now: what to do after an answer that never came. */
  async function persisted(importId: Id<"imports">, fileId: Id<"importFiles">) {
    const batch = await convex.query(api.imports.get, {
      importId,
      expectedScope: scope,
      includeResults: false,
    });
    return batch.files.find((file) => file.id === fileId)?.state ?? null;
  }
  /**
   * The synthetic example, imported like a chosen file: the same reservation, upload and
   * confirmation, so usage, limits and the outcome are those of any import. Only the reading
   * differs: the browser fetches the public file instead of the person choosing it.
   */
  async function importExample() {
    // The ref holds a second click that lands before `busy` reaches the render.
    if (exampleTaken.current || exampleBlocked) return;
    exampleTaken.current = true;
    try {
      await runExample();
    } finally {
      exampleTaken.current = false;
    }
  }
  async function runExample() {
    setBusy(true);
    setReading(true);
    setExampleRunning(true);
    setError("");
    let prepared: LocalFile[] | null = null,
      shapeFailed = false;
    try {
      // A hung request ends as a failure the person can retry, not as a spinner forever.
      const response = await fetch(EXAMPLE_PATH, {
        signal: AbortSignal.timeout(EXAMPLE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Example ${response.status}`);
      // A declared size past the limit is refused before reading the body.
      shapeFailed = true;
      if (Number(response.headers.get("Content-Length") ?? 0) > EXAMPLE_MAX_BYTES)
        throw new Error("Example size");
      // Reading the body may still fail on the network.
      shapeFailed = false;
      const blob = await response.blob();
      shapeFailed = true;
      // Whatever answered in place of the file (an error page, a proxy) is never reserved.
      if (!exampleShaped(blob.size, await blob.slice(0, 512).text()))
        throw new Error("Example content");
      shapeFailed = false;
      prepared = await prepare([new File([blob], EXAMPLE_NAME, { type: "application/xml" })]);
    } catch {
      // Nothing was reserved: the person can try again, and the download stays as a fallback.
    }
    if (!alive.current) return;
    setReading(false);
    // Opening a batch or cancelling meanwhile wins: the example reserves nothing over it.
    if (latest.current.blocked || latest.current.batch) {
      setExampleRunning(false);
      setBusy(false);
      return;
    }
    if (!prepared) {
      setExampleFailure((last) => ({ count: (last?.count ?? 0) + 1, content: shapeFailed }));
      setExampleRunning(false);
      setBusy(false);
      return;
    }
    setExampleFailure(null);
    setFiles(prepared);
    setExampleChosen(true);
    try {
      // `busy` stays set from the click on: the controls never reopen between reading and sending.
      await submit(prepared, true);
    } finally {
      if (alive.current) setExampleRunning(false);
    }
  }
  /** Reserves (or resumes) the import of `chosen`, the files prepared for this run. */
  async function submit(chosen: LocalFile[], started = false) {
    if (!started && (busy || cancelling || controlsBlocked)) return;
    const current: UploadRun = { stopped: false };
    run.current = current;
    // Any await may end after a cancel or after leaving the page; its answer then starts nothing.
    const halted = () => !alive.current || current.stopped;
    setBusy(true);
    setError("");
    setCancelOutcome(null);
    try {
      let id = importId;
      if (!id) {
        const files = chosen.map(({ file, sha256 }) => ({
          name: file.name,
          size: file.size,
          sha256,
        }));
        // A reservation whose answer was lost may exist for each set sent in this import: the
        // same files reuse their key, other files get a new one instead of an
        // `IDEMPOTENCY_CONFLICT`.
        const signature = JSON.stringify(files);
        let key = intents.current.get(signature);
        if (!key) {
          key = [...intents.current.values()].includes(intent) ? crypto.randomUUID() : intent;
          intents.current.set(signature, key);
        }
        if (key !== intent) setIntent(key);
        const reservation = await reserve({ ...scope, key, files });
        if (halted()) return;
        id = reservation.importId;
        setImportId(id);
      }
      const batch = await convex.query(api.imports.get, {
        importId: id,
        expectedScope: scope,
        includeResults: false,
      });
      // What each file still needs is said by name at the end; one file does not stop the others.
      const unchosen: string[] = [],
        unanswered: string[] = [],
        refused = new Map<Refusal, string[]>();
      const refuse = (kind: Refusal, name: string) =>
        refused.set(kind, [...(refused.get(kind) ?? []), name]);
      let failure: unknown = null;
      for (const remote of batch.files) {
        if (halted()) return;
        if (remote.state !== "reserved" && remote.state !== "uploaded") continue;
        let step: "ticket" | "confirm" = "confirm";
        try {
          if (remote.state === "reserved") {
            const local = localCopy(chosen, remote);
            if (!local) {
              unchosen.push(remote.name);
              continue;
            }
            step = "ticket";
            let upload: { url: string; token: string } | null;
            try {
              upload = await ticket({ fileId: remote.id });
            } catch (error) {
              if (halted()) return;
              if (usageErrorCode(error) !== "UPLOAD_EXPIRED") throw error;
              // An earlier attempt's late upload may have landed since the batch was read.
              const now = await persisted(id, remote.id);
              if (halted()) return;
              if (now === "reserved") throw error;
              if (now !== "uploaded") {
                refuse("gone", remote.name);
                continue;
              }
              upload = null;
            }
            if (halted()) return;
            step = "confirm";
            if (upload)
              try {
                await send(upload.url, upload.token, local.file, remote.id);
              } catch (error) {
                if (halted()) return;
                setProgress((value) => {
                  const next = { ...value };
                  delete next[remote.id];
                  return next;
                });
                // No answer does not prove the bytes did not arrive: ask the server before deciding.
                // Uploaded means confirm it now; anything else is never sent again in this run.
                const now = await persisted(id, remote.id);
                if (halted()) return;
                if (now !== "uploaded") {
                  if (now !== "reserved") {
                    refuse("gone", remote.name);
                    continue;
                  }
                  const failed = error as UploadFailure;
                  const kind =
                    failed.kind === "refused"
                      ? refusalOf(failed.code, "upload")!
                      : failed.kind === "network" && !(await readable(local.file))
                        ? "content"
                        : null;
                  if (halted()) return;
                  if (!kind) unanswered.push(remote.name);
                  else refuse(kind, remote.name);
                  // These bytes would be refused again: the row asks for the file once more.
                  if (kind === "content")
                    setFiles((chosen) => chosen.filter((item) => item !== local));
                  continue;
                }
              }
          }
          if (halted()) return;
          await confirm({ fileId: remote.id });
        } catch (error) {
          // An upload aborted or refused because of the cancel is the cancel, not a failure.
          if (halted()) return;
          const kind = refusalOf(usageErrorCode(error), step);
          if (kind) refuse(kind, remote.name);
          else failure ??= error;
          // Repeating what the server refused for good would only repeat the refusal.
          if (kind && unconfirmable.has(kind)) setStuck((value) => new Set(value).add(remote.id));
        }
      }
      const problems: ReactNode[] = [
        unanswered.length ? unansweredAction(unanswered) : null,
        ...Array.from(refused, ([kind, names]) => refusalAction(kind, names)),
        unchosen.length ? missingAction(unchosen) : null,
        failure
          ? usageFailure(
              failure,
              org,
              integrationRecordMessage(failure) ??
                "Um ou mais arquivos não foram confirmados. Confira o estado de cada arquivo abaixo e use “Retomar esta importação”.",
            )
          : null,
      ].filter(Boolean);
      if (problems.length)
        setError(
          problems.length === 1 ? (
            problems[0]
          ) : (
            <>
              {problems.map((problem, index) => (
                <p key={index}>{problem}</p>
              ))}
            </>
          ),
        );
    } catch (error) {
      if (!halted() && usageErrorCode(error) === "IDEMPOTENCY_CONFLICT") setConflicted(true);
      if (!halted())
        setError(
          usageFailure(
            error,
            org,
            integrationRecordMessage(error) ??
              (usageErrorCode(error) === "IDEMPOTENCY_CONFLICT"
                ? "Esta tentativa já foi registrada com outros arquivos. Use “Nova importação” e escolha os arquivos de novo."
                : "Não foi possível confirmar a solicitação. Tente novamente para recuperar a mesma importação."),
          ),
        );
    } finally {
      // A cancelled run that ends late does not release the controls of a newer run.
      if (alive.current && run.current === current) {
        run.current = null;
        setBusy(false);
      }
    }
  }
  async function cancelUploads() {
    if (cancelling) return;
    const stopped = run.current;
    run.current = null;
    for (const request of requests.current) request.abort();
    // Every upload was aborted: no file keeps a progress bar frozen where it stopped.
    setProgress({});
    if (stopped) {
      // The run ends now; `cancelling` keeps new sends out until the server answers.
      stopped.stopped = true;
      setBusy(false);
    }
    if (!result) return;
    setCancelling(true);
    setError("");
    setCancelOutcome(null);
    // Each file is cancelled on its own: one already accepted does not keep the others going.
    let cancelled = 0,
      accepted = 0,
      failure: unknown = null;
    for (const file of result.files) {
      if (file.state !== "reserved" && file.state !== "uploaded") continue;
      try {
        await cancel({ fileId: file.id });
        cancelled++;
      } catch (error) {
        if (usageErrorCode(error) === "ALREADY_ACCEPTED") accepted++;
        else failure ??= error;
      }
    }
    if (!alive.current) return;
    setCancelling(false);
    // Focus is taken only from the send area (or from nowhere): whoever moved on keeps their place.
    const active = document.activeElement;
    setCancelOutcome({
      notice: cancelNotice(cancelled, accepted),
      failure: failure
        ? (integrationRecordMessage(failure) ??
          "Não foi possível cancelar todos os envios pendentes. Confira o estado de cada arquivo e cancele de novo.")
        : "",
      focus: !active || active === document.body || !!sendArea.current?.contains(active),
    });
  }
  const cancelable = cancelling || (!!importId && !!pendingUploads && !integrationBatch);
  return (
    <>
      <Card title="Enviar arquivos">
        <div ref={sendArea} className="fiscal-stack">
          {writable ? (
            <>
              <div
                className="fiscal-dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void select(Array.from(event.dataTransfer.files));
                }}
              >
                {/* A new intent (a new import, or other files after a lost reservation) remounts
                    the input, so choosing the same file again still fires `change`. Never
                    natively disabled: the input keeps the focus through the reading of what it
                    chose (#535); the click that would open the picker is refused while blocked,
                    and `select` refuses a drop. */}
                <input
                  key={intent}
                  id="import-files"
                  className="ui-visually-hidden"
                  type="file"
                  accept=".xml,application/xml,text/xml"
                  multiple
                  aria-disabled={selectBlocked || undefined}
                  onClick={(event) => {
                    if (selectBlocked) event.preventDefault();
                  }}
                  aria-describedby={
                    !selectReason
                      ? "import-files-limits"
                      : selectReasonOwn
                        ? "import-files-reason"
                        : "import-submit-reason"
                  }
                  onChange={(event) => void select(Array.from(event.target.files ?? []))}
                />
                <span className="fiscal-dropzone__icon" aria-hidden="true">
                  <Icon name="upload" />
                </span>
                <label className="fiscal-dropzone__label" htmlFor="import-files">
                  Arraste os XMLs aqui ou escolha os arquivos
                </label>
                {!selectReason ? (
                  <p id="import-files-limits" className="ui-help">
                    Até 20 arquivos · 2 MiB por XML
                  </p>
                ) : selectReasonOwn ? (
                  <DisabledReason id="import-files-reason">{selectReason}</DisabledReason>
                ) : (
                  <DisabledReason aria-hidden>{selectReason}</DisabledReason>
                )}
              </div>
              {files.length ? (
                <ul className="fiscal-file-list" aria-label="Arquivos escolhidos">
                  {files.map((item, index) => (
                    <li key={`${item.sha256}:${index}`}>
                      <Icon name="document" />
                      <span className="fiscal-file-list__name">{item.file.name}</span>
                      <span className="fiscal-num">{Math.ceil(item.file.size / 1024)} KiB</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="ui-actions">
                <Button
                  variant="primary"
                  icon="upload"
                  loading={busy && !exampleRunning}
                  onClick={() => void submit(files)}
                  disabled={submitBlocked}
                  aria-describedby={submitReason ? "import-submit-reason" : undefined}
                >
                  {reading
                    ? "Lendo arquivos…"
                    : busy
                      ? "Enviando…"
                      : importId
                        ? "Retomar esta importação"
                        : "Importar arquivos"}
                </Button>
                {cancelable ? (
                  <Button
                    disabled={navigating}
                    loading={cancelling}
                    loadingLabel="Cancelando…"
                    onClick={() => void cancelUploads()}
                  >
                    Cancelar uploads pendentes
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  icon="plus"
                  disabled={busy || cancelling || navigating}
                  onClick={() => {
                    setImportId(null, () => {
                      setFiles([]);
                      setStuck(new Set());
                      setExampleChosen(false);
                      setConflicted(false);
                      intents.current.clear();
                      setIntent(crypto.randomUUID());
                      setProgress({});
                      setError("");
                      setExampleFailure(null);
                      setCancelOutcome(null);
                    });
                  }}
                >
                  Nova importação
                </Button>
              </div>
              {submitReason ? (
                <DisabledReason id="import-submit-reason">{submitReason}</DisabledReason>
              ) : null}
              {cancelable ? (
                <p className="ui-help">
                  “Cancelar uploads pendentes” interrompe a sequência e encerra os envios que ainda
                  não terminaram. O processamento já aceito continua registrado.
                </p>
              ) : null}
              {/* Secondary to sending one's own files: the synthetic example, for a first try. */}
              <div className="fiscal-import-example">
                {demonstration && !integrationBatch ? (
                  <div className="fiscal-stack">
                    <div className="ui-actions">
                      {/* Never natively disabled: the button keeps the focus through the attempt,
                          its failure and the batch it opens; the handler refuses what is blocked. */}
                      <Button
                        icon={exampleRunning ? undefined : "document"}
                        aria-disabled={exampleBlocked || undefined}
                        aria-busy={exampleRunning || undefined}
                        aria-describedby={exampleReason ? "import-example-reason" : undefined}
                        onClick={() => void importExample()}
                      >
                        {exampleRunning ? <span className="ui-spinner" aria-hidden="true" /> : null}
                        Importar o XML de exemplo
                      </Button>
                    </div>
                    <p className="ui-help">
                      A NF-e sintética desta empresa passa pelo mesmo envio de qualquer XML e conta
                      no uso. Se preferir,{" "}
                      <a className="ui-link" href={EXAMPLE_PATH} download>
                        baixe o XML sintético
                      </a>
                      .
                    </p>
                    {exampleReason ? (
                      <DisabledReason id="import-example-reason">{exampleReason}</DisabledReason>
                    ) : null}
                    {exampleFailure ? (
                      <Callout tone="danger">
                        {/* A new node per failure: each one is announced, the Callout stays. */}
                        <span key={exampleFailure.count} role="alert">
                          {exampleFailure.content
                            ? "O arquivo de exemplo não veio como esperado. Nada foi enviado; baixe o XML sintético pelo link acima."
                            : "Não foi possível carregar o XML de exemplo. Nada foi enviado; confira a conexão e use “Importar o XML de exemplo” de novo."}
                        </span>
                      </Callout>
                    ) : null}
                  </div>
                ) : (
                  <p className="ui-help">
                    <a className="ui-link" href={EXAMPLE_PATH} download>
                      Baixar XML sintético de demonstração
                    </a>
                    . Use com a Empresa de demonstração, CNPJ{" "}
                    <span className="ui-mono">12ABC34501DE35</span>.
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="ui-help">
              Seu perfil permite acompanhar importações. Solicite a um operador o envio dos
              arquivos.
            </p>
          )}
          <p className="ui-help fiscal-import-privacy">
            <Icon name="info" />
            <span>
              O XML original fica privado. Importar não comprova autorização fiscal. Nenhum
              certificado é necessário para experimentar com dados sintéticos.
            </span>
          </p>
          {/* Mounted empty from the start: a live region that appears already filled may go unread. */}
          <p id="import-cancel-status" role="status" className="ui-visually-hidden">
            {cancelOutcome && !cancelOutcome.focus ? cancelOutcome.notice : ""}
          </p>
          {cancelOutcome && (cancelOutcome.notice || cancelOutcome.failure) ? (
            <div ref={outcome} tabIndex={-1} className="fiscal-stack">
              {cancelOutcome.notice ? (
                // Unfocused, the live region above carries the text: the copy here is read once.
                <div aria-hidden={cancelOutcome.focus ? undefined : true}>
                  <Callout tone="info">{cancelOutcome.notice}</Callout>
                </div>
              ) : null}
              {cancelOutcome.failure ? (
                <Callout tone="danger" role={cancelOutcome.focus ? undefined : "alert"}>
                  {cancelOutcome.failure}
                </Callout>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          ) : null}
        </div>
      </Card>
      {unavailableSelection ? (
        result === undefined ? (
          <Card>
            <SkeletonBlock label="Carregando importação…" lines={3} />
          </Card>
        ) : (
          <Callout tone="warning" role="alert">
            Importação indisponível neste contexto. Selecione outro lote ou inicie uma nova
            importação.
          </Callout>
        )
      ) : null}
      {result ? (
        <ImportResults
          // Another batch starts folded again.
          key={importId ?? ""}
          result={result}
          progress={progress}
          chosen={files}
          stuck={stuck}
          busy={busy || cancelling}
          writable={writable}
          disabled={controlsBlocked}
          scope={scope}
          organizationSlug={organizationSlug}
          org={org}
        />
      ) : null}
      <Card
        title="Importações recentes"
        description="As 10 últimas da empresa, do console e das integrações. Abra uma para ver o resultado por arquivo ou retomar envios pendentes."
        flush
      >
        {recent === undefined ? (
          <div className="fiscal-recent-imports__state">
            <SkeletonBlock label="Carregando importações…" lines={3} />
          </div>
        ) : !recent.length ? (
          <EmptyState
            icon="upload"
            headingLevel={3}
            title="Nenhuma importação nesta empresa ainda."
            description="As importações enviadas pelo console ou pelas integrações aparecem aqui."
          />
        ) : (
          <ul className="fiscal-recent-imports">
            {recentShown(recent, importId, allRecent).map((batch) => (
              <RecentImport
                key={batch.id}
                batch={batch}
                current={batch.id === importId}
                disabled={busy || cancelling || navigating}
                open={() =>
                  setImportId(batch.id, () => {
                    setFiles([]);
                    setExampleChosen(false);
                    setConflicted(false);
                    setStuck(new Set());
                    setProgress({});
                    setError("");
                    setExampleFailure(null);
                    setCancelOutcome(null);
                  })
                }
              />
            ))}
          </ul>
        )}
        {recent && !allRecent && recentShown(recent, importId, false).length < recent.length ? (
          <div className="fiscal-recent-imports__more">
            <Button size="sm" variant="ghost" icon="chevronDown" onClick={() => setAllRecent(true)}>
              {`Mostrar as ${recent.length} últimas`}
            </Button>
          </div>
        ) : null}
      </Card>
      {/* The refusals need the organization (its slug and capabilities) for their actions. */}
      {org ? <RefusedFiles org={org} scope={scope} /> : null}
    </>
  );
}
/** Recent batches shown before "Mostrar as 10 últimas". */
const SHOWN_RECENT = 5;
/**
 * The newest few, plus the batch open on the page and any with a file still running past them,
 * whatever its badge: those are the ones a person comes back for, so they never hide behind the
 * button.
 */
function recentShown(recent: Recent[], openId: string | null, all: boolean) {
  if (all) return recent;
  return recent.filter(
    (batch, index) =>
      index < SHOWN_RECENT ||
      batch.id === openId ||
      batch.files.some((file) => fileOutcome(file).tone === "pending"),
  );
}
/** Only what the server confirmed: files it cancelled and files it had already accepted. */
function cancelNotice(cancelled: number, accepted: number) {
  const done =
    cancelled === 1
      ? "1 envio cancelado; esse arquivo não será processado."
      : cancelled
        ? `${cancelled} envios cancelados; esses arquivos não serão processados.`
        : "";
  const kept =
    accepted === 1
      ? "1 arquivo já tinha sido aceito para processamento e segue normalmente."
      : accepted
        ? `${accepted} arquivos já tinham sido aceitos para processamento e seguem normalmente.`
        : "";
  return !done && kept ? `Nada foi cancelado: ${kept}` : [done, kept].filter(Boolean).join(" ");
}
function RecentImport({
  batch,
  current,
  disabled,
  open,
}: {
  batch: Recent;
  current: boolean;
  disabled: boolean;
  open: () => void;
}) {
  const summary = batchSummary(batch.files);
  const count = batch.files.length;
  return (
    <li className="fiscal-recent-import" aria-current={current ? "true" : undefined}>
      <div className="fiscal-recent-import__main">
        <Button variant="link" className="fiscal-num" disabled={disabled || current} onClick={open}>
          {formatDateTime(batch.createdAt)}
        </Button>
        <span className="fiscal-note">
          {originLabel(batch.origin)}
          {current ? " · aberta abaixo" : ""}
        </span>
      </div>
      <span className="fiscal-recent-import__count">
        {count} {count === 1 ? "arquivo" : "arquivos"} · {summary.detail}
      </span>
      <StatusBadge tone={badgeTone(summary.tone)}>{summary.label}</StatusBadge>
    </li>
  );
}
function ImportResults({
  result,
  progress,
  chosen,
  stuck,
  busy,
  writable,
  disabled,
  scope,
  organizationSlug,
  org,
}: {
  result: Result;
  progress: Record<string, number>;
  /** XMLs chosen in this tab, matched against each reserved file. */
  chosen: LocalFile[];
  /** Files whose upload or confirmation the server refused for good. */
  stuck: ReadonlySet<string>;
  /** Sending or cancelling: "Retomar … envia" would describe a button that is not there. */
  busy: boolean;
  writable: boolean;
  disabled: boolean;
  scope: Scope;
  organizationSlug: string;
  org?: UsageOrg;
}) {
  const summary = batchSummary(result.files);
  // Every file that needs the person stays in view; past the first few, the imported ones fold
  // behind one button, so a batch of 20 good files does not push the rest of the page away.
  const [allShown, setAllShown] = useState(false);
  const ordered = attentionFirst(result.files);
  const imported = ordered.filter((file) => fileOutcome(file).tone === "success");
  const folded = allShown ? 0 : Math.max(0, imported.length - SHOWN_IMPORTED);
  const shown = folded ? ordered.slice(0, ordered.length - folded) : ordered;
  return (
    <Card title="Resultado por arquivo">
      <div className="fiscal-stack">
        <p role="status" aria-live="polite" className="fiscal-import-summary">
          <StatusBadge tone={badgeTone(summary.tone)}>{summary.label}</StatusBadge>
          <span>
            {summary.detail}. Importação de{" "}
            <span className="fiscal-num">{formatDateTime(result.createdAt)}</span> ·{" "}
            {originLabel(result.origin)}.
          </span>
        </p>
        {result.origin.kind === "integration" ? (
          <Callout tone="info">{integrationManaged(result.origin)}</Callout>
        ) : null}
        {/* What needs the person comes first; files of the same kind keep the batch's order. */}
        <ul className="fiscal-import-results">
          {shown.map((file) => {
            const outcome = fileOutcome(file);
            const step =
              writable && result.origin.kind === "console" ? uploadStep(file, chosen, stuck) : null;
            return (
              <li key={file.id} className="fiscal-import-file" data-tone={outcome.tone}>
                <div className="fiscal-import-file__head">
                  <strong className="fiscal-item__title fiscal-import-file__name">
                    {file.name}
                  </strong>
                  {file.documentId ? (
                    <Link
                      className="ui-link fiscal-import-file__open"
                      to="/app/$organizationSlug/documents"
                      params={{ organizationSlug }}
                      search={{
                        company: scope.companyId,
                        env: scope.environment,
                        document: file.documentId,
                      }}
                    >
                      Consultar documento
                    </Link>
                  ) : null}
                  <StatusBadge tone={badgeTone(outcome.tone)}>{outcome.title}</StatusBadge>
                </div>
                {file.state === "failed" && isUsageCode(outcome.code) ? (
                  <p>
                    <UsageGuidance code={outcome.code} org={org} />
                  </p>
                ) : outcome.hint ? (
                  <p>{outcome.hint}</p>
                ) : null}
                {step && !((busy || disabled) && step.ready) ? <p>{step.hint}</p> : null}
                {/* A success says itself in the badge; the code is for support, when it failed. */}
                {outcome.code && outcome.tone !== "success" ? (
                  <p className="fiscal-note">
                    Código para suporte: <code className="ui-mono">{outcome.code}</code>
                  </p>
                ) : null}
                {progress[file.id] !== undefined && file.state === "reserved" ? (
                  <Progress value={progress[file.id]!} label={`Envio de ${file.name}`} />
                ) : null}
                {file.documents?.length ? (
                  <div className="ui-stack">
                    <p>
                      {file.documents.length} NFS-e registradas. A importação não comprova
                      autorização fiscal.
                    </p>
                    <ul className="fiscal-import-documents">
                      {file.documents.map((document) => (
                        <li key={document.versionId}>
                          <Link
                            className="ui-link"
                            to="/app/$organizationSlug/documents"
                            params={{ organizationSlug }}
                            search={{
                              company: scope.companyId,
                              env: scope.environment,
                              document: document.documentId,
                            }}
                          >
                            NFS-e {document.number}
                          </Link>
                          <span className="fiscal-note">
                            {importCodeMessages[document.code] ?? document.code}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <ProcessingActions
                  key={file.id}
                  file={file}
                  detail={
                    file.versionId ? (
                      <ImportDetail
                        key={`${file.id}:${file.versionId}`}
                        fileId={file.id}
                        versionId={file.versionId}
                        name={file.name}
                        scope={scope}
                      />
                    ) : null
                  }
                  outcome={outcome}
                  writable={writable && result.origin.kind === "console"}
                  currentProcessor={result.currentProcessor}
                  disabled={disabled}
                  org={org}
                />
              </li>
            );
          })}
        </ul>
        {folded ? (
          <div className="ui-actions">
            <Button size="sm" variant="ghost" icon="chevronDown" onClick={() => setAllShown(true)}>
              {`Mostrar os outros ${folded} importados`}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
/** The order of the file results: refusals, then warnings, then the ones still running, then the
 * imported ones; the same kind keeps the order of the batch. */
const outcomeOrder = { danger: 0, warning: 1, pending: 2, success: 3 } as const;
/** Imported files shown before the rest of them fold. */
const SHOWN_IMPORTED = 5;
function attentionFirst<File extends Parameters<typeof fileOutcome>[0]>(files: File[]) {
  return files
    .map((file, index) => ({ file, index, rank: outcomeOrder[fileOutcome(file).tone] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ file }) => file);
}
function ResultJson({ result, label }: { result: string; label: string }) {
  const formatted = useMemo(() => formatImportResult(result), [result]);
  return <CodeBlock label={label}>{formatted}</CodeBlock>;
}
function HistoricalResult({
  summary,
  result,
  label,
}: {
  summary: ReactNode;
  result: string;
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Disclosure summary={summary} open={expanded} onOpenChange={setExpanded}>
      {expanded ? <ResultJson result={result} label={label} /> : null}
    </Disclosure>
  );
}
function ImportDetail({
  fileId,
  versionId,
  name,
  scope,
}: {
  fileId: Id<"importFiles">;
  versionId: Id<"documentVersions">;
  name: string;
  scope: Scope;
}) {
  const [expanded, setExpanded] = useState(false);
  const detail = useContent(
    api.contentRead.importDetailToken,
    api.documentContentNode.importDetailRead,
    expanded ? { fileId, versionId, expectedScope: scope } : "skip",
  );
  return (
    <Disclosure
      summary={
        <>
          Resultado do processamento <span className="ui-visually-hidden">de {name}</span>
        </>
      }
      open={expanded}
      onOpenChange={setExpanded}
    >
      {expanded ? (
        detail === undefined ? (
          <SkeletonBlock label="Carregando resultado…" lines={2} />
        ) : detail === null ? (
          <p role="status" className="ui-help">
            Resultado indisponível. Aguarde a conclusão do processamento.
          </p>
        ) : (
          <ResultJson result={detail.result} label={`Resultado de ${name}`} />
        )
      ) : null}
    </Disclosure>
  );
}
/**
 * Reprocessing reads the same original again: worth it after a processor update, or to refresh
 * an imported document; a content refusal with the current processor would fail the same way.
 */
export function reprocessChoice(
  file: { state: string; code: string | null; processorVersion: string | null },
  outcome: FileOutcome,
  currentProcessor: string,
): { offer: boolean; reason: string } {
  if (file.state !== "succeeded") return { offer: false, reason: "" };
  // The ABRASF reader is retired: the server refuses to reprocess an imported NFS-e batch.
  if (file.code === "NFSE_BATCH_IMPORTED")
    return {
      offer: false,
      reason:
        "A plataforma não lê mais lotes NFS-e ABRASF. As notas deste lote continuam disponíveis para consulta.",
    };
  if (outcome.tone === "success" || outcome.tone === "warning") return { offer: true, reason: "" };
  if (file.processorVersion && file.processorVersion !== currentProcessor)
    return { offer: true, reason: "" };
  return {
    offer: false,
    reason:
      // A refusal by the reader, not by the content: a newer reader may accept it (#499).
      file.code === "XML_EVENT_UNSUPPORTED" || file.code === "XML_SCHEMA_UNSUPPORTED"
        ? "Recusado pelo leitor de NF-e da época. Depois de uma atualização do leitor, use “Reprocessar recusas técnicas” em “Arquivos recusados”, no fim desta página."
        : file.code && contentCodes.has(file.code)
          ? "Reprocessar este arquivo repetiria o mesmo resultado. Corrija o XML e importe-o de novo em “Nova importação”."
          : "Reprocessar repetiria o mesmo resultado com a versão atual de processamento.",
  };
}
function ProcessingActions({
  file,
  detail,
  outcome,
  writable,
  currentProcessor,
  disabled,
  org,
}: {
  file: Result["files"][number];
  /** The result of the current version, shown in the same group as the history. */
  detail: ReactNode;
  outcome: FileOutcome;
  /** Role that writes, on a batch of the console. */
  writable: boolean;
  currentProcessor: string;
  disabled: boolean;
  org?: UsageOrg;
}) {
  const choice = reprocessChoice(file, outcome, currentProcessor);
  const reprocess = useMutation(api.importProcessing.reprocess),
    control = useMutation(api.operations.control);
  const [key] = useState(() => crypto.randomUUID());
  const [operationId, setOperationId] = useState<Id<"operations"> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<ReactNode>("");
  const [expanded, setExpanded] = useState(false);
  const operation = useQuery(api.operations.get, operationId ? { operationId } : "skip");
  const history = useContent(
    api.contentRead.importHistoryToken,
    api.documentContentNode.importHistoryRead,
    expanded ? { fileId: file.id } : "skip",
  );
  async function processAgain() {
    setBusy(true);
    setError("");
    try {
      const value = await reprocess({ fileId: file.id, key });
      setOperationId(value.operationId);
      setExpanded(true);
    } catch (error) {
      setError(
        usageFailure(
          error,
          org,
          integrationRecordMessage(error) ??
            "Não foi possível iniciar. Tente novamente para recuperar a mesma solicitação.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    if (!file.operationId) return;
    setBusy(true);
    setError("");
    try {
      await control({
        operationId: file.operationId,
        action: "retry",
        expectedGeneration: file.generation,
      });
    } catch (error) {
      setError(
        integrationRecordMessage(error) ??
          "Não foi possível retomar. Confira se o acesso permanece válido.",
      );
    } finally {
      setBusy(false);
    }
  }
  const resumable = writable && file.state === "paused";
  const reprocessable = writable && choice.offer;
  return (
    <>
      {resumable || reprocessable ? (
        <div className="ui-actions">
          {resumable ? (
            <Button size="sm" disabled={busy || disabled} onClick={() => void retry()}>
              Retomar processamento <span className="ui-visually-hidden">de {file.name}</span>
            </Button>
          ) : null}
          {reprocessable ? (
            <Button
              size="sm"
              disabled={busy || disabled || !!operationId}
              onClick={() => void processAgain()}
            >
              Reprocessar <span className="ui-visually-hidden">{file.name}</span>
            </Button>
          ) : null}
        </div>
      ) : null}
      {writable && choice.reason ? <p className="ui-help">{choice.reason}</p> : null}
      {operation ? (
        <p role="status" className="ui-help">
          Reprocessamento: {operationStates[operation.state] ?? operation.state}.
        </p>
      ) : null}
      {error ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}
      {detail || file.operationId ? (
        <div className="fiscal-import-file__details">
          {detail}
          {file.operationId ? (
            <Disclosure
              summary={
                <>
                  Histórico de processamento{" "}
                  <span className="ui-visually-hidden">de {file.name}</span>
                </>
              }
              open={expanded}
              onOpenChange={setExpanded}
            >
              <div className="ui-stack">
                <p className="ui-help">
                  Até dez versões recentes. Os resultados anteriores permanecem preservados.
                </p>
                {expanded && history === undefined ? (
                  <SkeletonBlock label="Carregando histórico…" lines={2} />
                ) : null}
                {history?.map((version) => (
                  <HistoricalResult
                    key={version.id}
                    result={version.result}
                    label={`Resultado da versão ${version.processorVersion} de ${file.name}`}
                    summary={
                      <>
                        <span className="ui-mono">{version.processorVersion}</span> ·{" "}
                        <span className="fiscal-num">{formatDateTime(version.completedAt)}</span> ·{" "}
                        {importCodeMessages[version.code] ?? version.code}
                      </>
                    }
                  />
                ))}
              </div>
            </Disclosure>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
