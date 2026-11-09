/**
 * What each code of the NF-e capture means to the person (#432): the reason, in plain words, and
 * what to do about it. One place for the capture panel, its action refusals and the Início. The
 * words avoid the internals (cursor, stream, NSU, lote): the person reads documents, queries and
 * the Receita. Without React, so tests and other screens import it as data.
 */
/**
 * What solves the cause (#432), which picks the panel's main action:
 * - `resume`: "Retomar captura" does;
 * - `certificate`: sending or activating the A1, in Certificado;
 * - `usage`: the plan or its quota, in Uso e limites;
 * - `transfer`: a transfer code from the organization that has the capture;
 * - `release`: turning the fiscal capture on again, above;
 * - `support`: only the Freecorps can fix it;
 * - `environment`: nothing, this environment does not query (the Sandbox without a source);
 * - `wait`: the capture goes on by itself, now or after a while;
 * - `none`: information, nothing to do.
 * The server accepts a resume of any cause but a missing A1 or the Receita's block (656) still
 * running; `support`, `usage` and `environment` would only stop again, so there "Retomar captura"
 * is not the main button. A stop with a `wait` or `none` code goes on only when resumed.
 */
export type CaptureAction =
  | "resume"
  | "certificate"
  | "usage"
  | "transfer"
  | "release"
  | "support"
  | "environment"
  | "wait"
  | "none";
export type CaptureMessage = {
  reason: string;
  action: CaptureAction;
  /** "O que fazer: …"; absent when there is nothing to do or to wait for. */
  todo?: string;
  /** When the refusal of an action asks for something else than the panel would. */
  actionTodo?: string;
  /**
   * What the person still does before the resume, on a capture an integration activated, where
   * the integration resumes (#607, `forOrigin`). Also on a code that is not a `resume` but whose
   * `todo` asks to resume.
   */
  beforeResume?: string;
  /** What comes after the resume, which `forOrigin` keeps after the integration's. */
  afterResume?: string;
  /** A condition the integration's resume starts with, when resuming is optional. */
  resumeIf?: string;
};

const SUPPORT =
  "Fale com o suporte da Freecorps antes de retomar, com os detalhes técnicos abaixo.";
const AGAIN =
  "Se acontecer de novo, fale com o suporte da Freecorps com os detalhes técnicos abaixo.";
/** Resume, and support if it stops again: the integration's capture keeps the second part. */
const AGAIN_OR_SUPPORT = { todo: `Retome a captura. ${AGAIN}`, afterResume: AGAIN };
const MANAGERS = "Somente Proprietário ou Administrador pode fazer isso.";

/** The source the capture reads: the Receita in Produção, the synthetic one in the Sandbox. */
function source(production: boolean) {
  const of = production ? "a Receita" : "a fonte de teste";
  return {
    of,
    Of: of[0]!.toUpperCase() + of.slice(1),
    from: production ? "da Receita" : "da fonte de teste",
  };
}

/**
 * Which quota a capture's `QUOTA_EXCEEDED` is: the queries; the notes (`notesQuota`); or, on a
 * plan that counts notes but did not stop on them (`countsNotes` without `notesQuota`), another
 * limit of the plan, said without naming it.
 */
export type CaptureQuota = "queries" | "notes" | "plan";
export const captureQuota = (stream: {
  countsNotes?: boolean | undefined;
  notesQuota?: boolean | undefined;
}): CaptureQuota => (stream.notesQuota ? "notes" : stream.countsNotes ? "plan" : "queries");
const quotaReasons: Record<CaptureQuota, string> = {
  queries: "A organização chegou ao limite de consultas do plano neste período.",
  notes: "A organização chegou ao limite de notas novas do mês em Produção.",
  plan: "A organização chegou a um limite do plano neste período.",
};
function messages(
  production: boolean,
  quota: CaptureQuota = "queries",
): Record<string, CaptureMessage> {
  const s = source(production);
  return {
    // Waits and information of a capture that keeps going.
    SOURCE_COOLDOWN: {
      action: "wait",
      reason: `${s.Of} só aceita a próxima consulta depois de um intervalo.`,
      todo: "Aguarde o horário da próxima consulta; a captura consulta sozinha.",
    },
    SITE_CAPTURE_HOURLY_LIMIT: {
      action: "wait",
      reason: "A captura chegou ao limite de consultas por hora desta empresa.",
      todo: "Nada: ela continua sozinha na hora seguinte.",
    },
    CERTIFICATE_CHANGED: {
      action: "none",
      reason: "O certificado A1 da empresa foi trocado.",
      todo: "Nada: a próxima consulta já usa o certificado novo.",
    },
    NO_DOCUMENTS: { action: "none", reason: "A última consulta não encontrou documentos novos." },
    HISTORY_LIMITED: {
      action: "none",
      reason: `O histórico começa no primeiro registro que ${s.of} ainda tinha.`,
    },
    NSU_GAP: {
      action: "wait",
      reason: "Faltam registros na sequência recebida.",
      todo: `Nada: a captura vai buscá-los um a um, abaixo do limite de consultas ${s.from}.`,
    },
    RECONCILING_GAP: {
      action: "wait",
      reason: `Buscando os registros que faltaram na sequência, abaixo do limite de consultas ${s.from}.`,
    },
    SOURCE_RESULT_UNCERTAIN: {
      action: "wait",
      reason: `Uma consulta saiu, mas a resposta ${s.from} não chegou.`,
      todo: `Nada: a captura confere o que ${s.of} respondeu antes de seguir.`,
    },
    SOURCE_HTTP_ERROR: {
      action: "wait",
      reason: `${s.Of} não respondeu como esperado.`,
      todo: "Nada: a captura confere e tenta de novo em uma hora.",
    },
    CAPTURE_CHANGED: {
      action: "wait",
      reason: "A captura mudou enquanto uma consulta estava em andamento.",
      todo: "Nada: a resposta é conferida antes de seguir.",
    },
    OPERATION_CHANGED: {
      action: "wait",
      reason: "A captura mudou enquanto uma consulta estava em andamento.",
      todo: "Nada: a resposta é conferida antes de seguir.",
    },
    CAPTURE_FISCAL_HALTED: {
      action: "wait",
      reason: "A Freecorps parou por um tempo a captura fiscal de todas as empresas.",
      todo: "Nada. Ela volta sozinha, sem ação sua; os documentos recebidos continuam disponíveis.",
    },
    CAPTURE_TERMS_PENDING: {
      action: "release",
      reason: "Os termos da captura fiscal mudaram e o prazo para aceitar a nova versão terminou.",
      todo: "Um Proprietário ou Administrador aceita os novos termos acima; as consultas voltam em até uma hora. Os documentos recebidos continuam disponíveis.",
    },
    TRANSFERRED: {
      action: "resume",
      reason: "Captura recebida de outra organização.",
      todo: "Retome a captura para continuar do ponto em que ela parou.",
    },
    PAUSED_BY_USER: {
      action: "resume",
      reason: "Uma pessoa da organização pausou a captura.",
      todo: "Retome a captura para voltar a receber documentos.",
    },
    CAPTURE_RELEASE_WITHDRAWN: {
      action: "release",
      reason: "A captura fiscal foi desativada; os documentos recebidos continuam disponíveis.",
      todo: "Reative a captura fiscal acima para voltar a consultar a Receita.",
    },
    // Stops that wait for a person.
    FISCAL_TRANSPORT_DISABLED: production
      ? {
          action: "support",
          reason: "A consulta à Receita está desligada neste ambiente da Freecorps.",
          todo: "Fale com o suporte da Freecorps e retome a captura só depois que o suporte confirmar a correção. Os documentos recebidos continuam disponíveis.",
          beforeResume: "Fale com o suporte da Freecorps e espere a confirmação da correção.",
          afterResume: "Os documentos recebidos continuam disponíveis.",
        }
      : {
          action: "environment",
          reason:
            "O Sandbox não consulta a Receita: a consulta fiscal está desligada neste ambiente.",
          todo: "Nada a fazer aqui. Para testar com notas, use Importar XML.",
        },
    SOURCE_CONSUMPTION_BLOCKED: {
      action: "resume",
      reason: `${s.Of} bloqueou por cerca de uma hora as consultas deste CNPJ, por excesso de consultas de todos os sistemas que consultam a empresa.`,
      todo: production
        ? "Retome a captura depois de uma hora. Se outro sistema, como o ERP ou o contador, também consulta a Receita por este CNPJ, aumente o intervalo mínimo da captura fiscal."
        : "Retome a captura depois de uma hora.",
      beforeResume: production
        ? "Espere uma hora. Se outro sistema, como o ERP ou o contador, também consulta a Receita por este CNPJ, aumente o intervalo mínimo da captura fiscal."
        : "Espere uma hora.",
      actionTodo: "Tente de novo depois do horário da próxima consulta.",
    },
    REPEATED_NSU: {
      action: "resume",
      reason: `${s.Of} devolveu de novo documentos que a captura já tinha recebido, e a captura parou para não perder nada.`,
      todo: `Confira se outro sistema, como o ERP ou o contador, consulta ${s.of} por este CNPJ e retome a captura.`,
      beforeResume: `Confira se outro sistema, como o ERP ou o contador, consulta ${s.of} por este CNPJ.`,
    },
    SOURCE_CURSOR_REGRESSION: {
      action: "support",
      reason: `${s.Of} respondeu a partir de um ponto anterior ao que a captura já tinha recebido, e a captura parou para não repetir nem perder documentos.`,
      todo: SUPPORT,
    },
    BATCH_UNAVAILABLE: {
      action: "support",
      reason: `Uma resposta ${s.from} guardada pela captura não pôde ser lida de novo. A captura parou sem perder o ponto em que estava.`,
      todo: SUPPORT,
    },
    BATCH_HASH_MISMATCH: {
      action: "support",
      reason: `Uma resposta ${s.from} guardada pela captura não confere com a recebida. A captura parou sem perder o ponto em que estava.`,
      todo: SUPPORT,
    },
    NSU_CONTENT_CONFLICT: {
      action: "support",
      reason: `${s.Of} mandou um conteúdo diferente para um registro que a captura já tinha recebido. Os documentos anteriores foram mantidos.`,
      todo: SUPPORT,
    },
    SOURCE_RESPONSE_INVALID: {
      action: "support",
      reason: `A resposta ${s.from} veio num formato que a captura não reconhece. Ela foi guardada para conferência.`,
      todo: SUPPORT,
    },
    SOURCE_CURSOR_UNKNOWN: {
      action: "resume",
      reason: `Chegaram documentos, mas a captura ainda não sabe até onde ${s.of} respondeu.`,
      ...AGAIN_OR_SUPPORT,
    },
    RECONCILIATION_INCOMPLETE: {
      action: "resume",
      reason: "A conferência de uma consulta sem resposta não terminou.",
      ...AGAIN_OR_SUPPORT,
    },
    RECONCILIATION_REQUIRED: {
      action: "resume",
      reason: "Uma consulta sem resposta ainda precisa ser conferida.",
      ...AGAIN_OR_SUPPORT,
      actionTodo: "Retome a captura e espere a conferência terminar antes de transferir.",
    },
    RECONCILIATION_UNAVAILABLE: {
      action: "resume",
      reason: `${s.Of} não tem mais um registro que faltou na sequência.`,
      todo: "Retome a captura para localizar até onde vai o trecho perdido; depois, decida se aceita a perda.",
      // On an integration's capture too, the owner accepts the loss here (#442).
      afterResume:
        "A captura localiza até onde vai o trecho perdido, e depois o Proprietário decide aqui se aceita a perda.",
    },
    ATTEMPTS_EXHAUSTED: {
      action: "resume",
      reason:
        "A consulta falhou em todas as tentativas permitidas. Nenhum documento recebido foi perdido.",
      ...AGAIN_OR_SUPPORT,
    },
    TASK_FAILED: {
      action: "resume",
      reason: "A consulta falhou por um erro interno. Nenhum documento recebido foi perdido.",
      ...AGAIN_OR_SUPPORT,
    },
    RECOVERY_BUDGET_EXHAUSTED: {
      action: "support",
      reason:
        "A recuperação automática chegou ao limite de tentativas. Nenhum documento recebido foi perdido.",
      todo: SUPPORT,
    },
    ACCESS_REVOKED: {
      action: "resume",
      reason:
        "Mudou o acesso que mantinha a captura: o papel de quem a iniciou, a integração que a ativou ou o certificado.",
      todo: "Confira os acessos e o certificado e retome a captura.",
      beforeResume: "Confira os acessos e o certificado.",
    },
    CERTIFICATE_UNAVAILABLE: {
      action: "certificate",
      reason: "A empresa não tem um certificado A1 válido e ativo.",
      todo: production
        ? "Envie ou ative o certificado A1 da empresa em Certificado; a captura volta sozinha."
        : "Envie ou ative o certificado A1 da empresa em Certificado e retome a captura.",
      ...(production
        ? {}
        : { beforeResume: "Envie ou ative o certificado A1 da empresa em Certificado." }),
      actionTodo: "Envie ou ative o certificado A1 da empresa em Certificado e tente de novo.",
    },
    CAPTURE_FISCAL_DENIED: {
      action: "resume",
      reason:
        "A captura fiscal não pôde consultar a Receita: a ativação ou o certificado A1 da empresa não vale mais.",
      todo: "Confira a captura fiscal e o certificado A1 da empresa e retome a captura.",
      beforeResume: "Confira a captura fiscal e o certificado A1 da empresa.",
    },
    QUOTA_EXCEEDED: {
      action: "usage",
      reason: quotaReasons[quota],
      todo: production
        ? "A captura volta sozinha quando houver cota ou capacidade disponível. Cotas mensais renovam no próximo período; estoque ocupado exige revisão."
        : "Retome a captura quando houver cota.",
      ...(production ? {} : { beforeResume: "Espere até haver cota." }),
    },
    PLAN_INACTIVE: {
      action: "usage",
      reason: "A organização não tem um plano em vigência.",
      todo: production
        ? "Nada: a captura volta sozinha quando um plano estiver em vigência."
        : "Retome a captura quando houver um plano em vigência.",
      ...(production ? {} : { beforeResume: "Espere até haver um plano em vigência." }),
    },
    PLAN_REQUIRED: {
      action: "usage",
      reason:
        "Esta captura exige um plano atribuído à organização, com cotas de consultas e de bytes, inclusive no plano gratuito.",
      todo: "Solicite o plano à Freecorps; a captura volta sozinha quando ele for atribuído.",
      actionTodo: "Solicite o plano à Freecorps; os documentos já recebidos continuam disponíveis.",
    },
    CAPACITY_INVENTORY_REQUIRED: {
      action: "usage",
      reason: "O inventário de capacidade da organização está pendente.",
      todo: "Solicite a conferência à Freecorps. A captura volta a ser avaliada após o inventário.",
    },
    CAPTURE_INACTIVE: {
      action: "resume",
      reason: "A captura não estava mais ativa quando a consulta ia sair.",
      todo: "Retome a captura se quiser voltar a receber documentos.",
      resumeIf: "Se quiser voltar a receber documentos",
    },
    FISCAL_PROOF_DENIED: {
      action: "support",
      reason: "Esta consulta da prova fiscal não foi autorizada.",
      todo: "Fale com o suporte da Freecorps.",
    },
    FISCAL_PROOF_STEP_COMPLETE: {
      action: "support",
      reason: "A etapa autorizada da prova fiscal terminou.",
      todo: "A próxima etapa depende de nova autorização da Freecorps.",
    },
    // Refusals of an action.
    STREAM_CONFLICT: {
      action: "transfer",
      reason: "Outra organização já captura esta empresa.",
      todo: "Peça a ela um código de transferência.",
    },
    TRANSFER_NOT_FOUND: {
      action: "transfer",
      reason: "Nenhuma outra organização tem uma captura desta empresa para transferir.",
      todo: `Confira o código com a organização de origem. Se não houver transferência, use ${production ? "Iniciar captura fiscal" : "Ativar captura no sandbox"}.`,
    },
    OPERATION_CONFLICT: {
      action: "none",
      reason: "A captura mudou em outra sessão.",
      todo: "Confira os dados atualizados e tente de novo.",
    },
    GAP_NOT_ACCEPTABLE: {
      action: "none",
      reason: "A captura mudou e não há perda a aceitar agora.",
      todo: "Confira os dados atualizados.",
    },
    GAP_CONFIRMATION_MISMATCH: {
      action: "none",
      reason: "O trecho perdido mudou desde que você abriu a confirmação.",
      todo: "Confira os dados atualizados.",
    },
    GAP_REASON_INVALID: {
      action: "none",
      reason:
        "O motivo não foi aceito: ele precisa ter texto, sem caracteres especiais, em até 500 caracteres.",
      todo: "Revise o motivo e confirme de novo. Nada foi aceito.",
    },
    INTEGRATION_ACCESS_REVOKED: {
      action: "none",
      reason:
        "A integração que ativou esta captura perdeu o acesso a ela: a chave foi revogada ou venceu, a integração foi desativada ou a concessão da empresa mudou.",
      todo: "Nada foi aceito. Peça a quem administra a integração que retome a captura com uma chave válida; depois, a perda pode ser aceita aqui.",
    },
    CAPTURE_PAUSED: {
      action: "resume",
      reason: "A captura está pausada.",
      todo: "Retome a captura antes de sincronizar.",
    },
    CAPTURE_DEMONSTRATION_DENIED: {
      action: "none",
      reason: "Empresas de demonstração não usam a captura.",
    },
    ORGANIZATION_CLOSED: { action: "none", reason: "A organização está em encerramento." },
    RATE_LIMITED: {
      action: "wait",
      reason: "Muitas tentativas seguidas.",
      todo: "Aguarde um minuto e tente de novo.",
    },
    ACCESS_DENIED: { action: "none", reason: MANAGERS },
    SCOPE_DENIED: { action: "none", reason: MANAGERS },
  };
}

/** The panel's words for a code, or `null` without one. An unknown code still says something. */
export function captureMessage(
  code: string | null | undefined,
  production: boolean,
  /** Which quota a `QUOTA_EXCEEDED` is (`captureQuota`). */
  quota: CaptureQuota = "queries",
): CaptureMessage | null {
  if (!code) return null;
  // Own entries only: a code like "toString" is not a message.
  const all = messages(production, quota);
  if (Object.hasOwn(all, code)) return all[code]!;
  // A refusal of the source by its own code (cStat), kept by the stream as `SOURCE_<cStat>`.
  const status = /^SOURCE_(\d{3})$/.exec(code)?.[1];
  const s = source(production);
  if (status === "108" || status === "109")
    return {
      action: "wait",
      reason: `${s.Of} está fora do ar ou em manutenção (código ${status}).`,
      todo: "Nada: a captura tenta de novo em uma hora.",
    };
  // The capture retries a 999 by itself and stops only on the third in a row (#195).
  if (status === "999")
    return {
      action: "resume",
      reason: `${s.Of} respondeu com um erro dela, sem apontar problema na consulta (código 999). A captura tenta de novo sozinha duas vezes; no terceiro erro seguido, ela para.`,
      ...AGAIN_OR_SUPPORT,
    };
  if (status)
    return {
      action: "support",
      reason: `${s.Of} recusou a consulta (código ${status}).`,
      todo: SUPPORT,
    };
  return {
    action: "support",
    reason: "A captura parou por um motivo que este painel ainda não descreve.",
    todo: SUPPORT,
  };
}

/**
 * A production capture stopped by the Freecorps cut by variable, with the capture on again
 * (#601): the server marks it (`captures.get`, `freecorpsCut`), since its code alone
 * (`ACCESS_REVOKED`, `FISCAL_TRANSPORT_DISABLED`) is also a real loss of access.
 */
const FREECORPS_CUT: CaptureMessage = {
  action: "resume",
  reason:
    "A Freecorps pausou a captura fiscal de todas as empresas, e esta captura parou durante a pausa. Nenhum documento recebido foi perdido.",
  todo: "Retome a captura: ela continua do ponto em que parou.",
  afterResume: "A captura continua do ponto em que parou.",
};

/** What the panel says of a stopped capture without a known code. */
export const UNEXPLAINED_STOP: CaptureMessage = {
  action: "resume",
  reason: "A captura parou e não consulta a fonte até alguém agir.",
  ...AGAIN_OR_SUPPORT,
};

/** The words for a stopped capture: the Freecorps cut when the server says so, else its code. */
export function stopMessage(
  stream: {
    code?: string | null | undefined;
    freecorpsCut?: boolean | undefined;
    notesQuota?: boolean | undefined;
    countsNotes?: boolean | undefined;
  },
  production: boolean,
): CaptureMessage | null {
  return production && stream.freecorpsCut
    ? FREECORPS_CUT
    : captureMessage(stream.code, production, captureQuota(stream));
}

/** Who activated a capture, as `captures.get` and the Início say it (`recordOrigin`). */
export type CaptureOrigin = { kind: "console" | "integration"; integration: string | null };

/** The resume of an integration's capture, which only the integration does, by the API (#607). */
export function integrationResume(integration: string | null, condition?: string) {
  const sentence = integration
    ? `a integração “${integration}” precisa retomar a captura, com a ação resume em POST /v1/connections/nfe.`
    : "a integração que ativou a captura precisa retomá-la, com a ação resume em POST /v1/connections/nfe.";
  return condition ? `${condition}, ${sentence}` : sentence[0]!.toUpperCase() + sentence.slice(1);
}

/**
 * "O que fazer" of an integration's capture (#607), where the console has no "Retomar captura":
 * what the person still does, that the integration resumes, then `after` (by default what
 * follows the resume on the card). `null` when the console's words stay: a console capture, or a
 * cause the resume does not solve.
 */
export function integrationTodo(
  message: CaptureMessage,
  origin: CaptureOrigin,
  after = message.afterResume,
): string | null {
  if (origin.kind === "console" || (message.action !== "resume" && !message.beforeResume))
    return null;
  return [message.beforeResume, integrationResume(origin.integration, message.resumeIf), after]
    .filter(Boolean)
    .join(" ");
}

/** The words for whoever reads a capture of `origin`; the reason and the `action` stay. */
export function forOrigin(message: CaptureMessage, origin: CaptureOrigin): CaptureMessage {
  const todo = integrationTodo(message, origin);
  return todo === null ? message : { ...message, todo };
}

/** Whether `code` is one the panel knows by name (unknown ones get the generic words). */
export const knownCaptureCode = (code: string, production: boolean) =>
  Object.hasOwn(messages(production), code) || /^SOURCE_\d{3}$/.test(code);

/** A refused action in one sentence or two: why, then what to do. */
export function captureFailureText(code: string, production: boolean): string | null {
  if (!knownCaptureCode(code, production)) return null;
  const message = captureMessage(code, production)!;
  const todo = message.actionTodo ?? message.todo;
  return todo ? `${message.reason} ${todo}` : message.reason;
}

/** Refusals of turning the fiscal capture on or off, or of changing its interval. */
const releaseMessages: Record<string, string> = {
  CAPTURE_RELEASE_UNAVAILABLE: "A captura fiscal não está disponível neste ambiente.",
  CAPTURE_RELEASE_DEMONSTRATION_DENIED: "Empresas de demonstração não usam a captura fiscal.",
  CAPTURE_RELEASE_TERMS_REQUIRED: "Leia e aceite os termos atuais antes de ativar.",
  CAPTURE_RELEASE_INTERVAL_INVALID: "Escolha um intervalo entre 1 e 24 horas.",
  CAPTURE_RELEASE_CERTIFICATE_REQUIRED:
    "Envie e ative o certificado A1 da própria empresa, com o mesmo CNPJ, antes de ativar.",
  CAPTURE_RELEASE_BLOCKED:
    "A Freecorps suspendeu a captura fiscal desta empresa. Fale com o suporte para reativar.",
  CAPTURE_RELEASE_ALREADY_RELEASED: "A captura fiscal já está ativa.",
  CAPTURE_RELEASE_NOT_RELEASED: "A captura fiscal já está desativada.",
  CAPTURE_TERMS_ALREADY_ACCEPTED: "Os termos atuais já foram aceitos para esta empresa.",
  ORGANIZATION_CLOSED: "A organização está em encerramento.",
  RATE_LIMITED: "Muitas tentativas seguidas. Aguarde um minuto.",
  SCOPE_DENIED: "Somente Proprietário ou Administrador ativa, desativa ou muda a captura fiscal.",
};
export const releaseFailureText = (code: string) =>
  (Object.hasOwn(releaseMessages, code) ? releaseMessages[code] : undefined) ??
  "Não foi possível concluir a ação. Confira seu acesso e tente novamente.";

/**
 * The situation of a capture in one badge (#432, #433): the panel's words and, where the screen
 * mixes both captures or shows no panel (the list of companies, the company's header), the same
 * words naming the fiscal capture. One vocabulary and one tone for each situation.
 */
export type CaptureSituation =
  | "none"
  | "not-started"
  | "active"
  | "paused"
  | "attention"
  | "halted"
  | "terms";
export type SituationTone = "neutral" | "success" | "warning";
const situations: Record<CaptureSituation, { label: string; fiscal: string; tone: SituationTone }> =
  {
    none: { label: "Sem captura", fiscal: "Captura fiscal desativada", tone: "neutral" },
    "not-started": {
      label: "Captura não iniciada",
      fiscal: "Captura fiscal não iniciada",
      tone: "neutral",
    },
    active: { label: "Captura ativa", fiscal: "Captura fiscal ativa", tone: "success" },
    paused: { label: "Captura pausada", fiscal: "Captura fiscal pausada", tone: "neutral" },
    attention: {
      label: "Captura precisa de atenção",
      fiscal: "Captura fiscal precisa de atenção",
      tone: "warning",
    },
    halted: {
      label: "Parada pela Freecorps",
      fiscal: "Captura fiscal parada pela Freecorps",
      tone: "neutral",
    },
    terms: {
      label: "Aguardando novos termos",
      fiscal: "Captura fiscal aguardando novos termos",
      tone: "warning",
    },
  };
/** The badge of a situation: `label` in the panel, `fiscal` outside it. */
export const captureSituation = (situation: CaptureSituation) => situations[situation];

/** One query of the history (#433), as `captures.history` answers it. */
export type QueryEntry = {
  kind: "query" | "recovery";
  outcome: "answered" | "refused" | "not-sent" | "stopped" | "unanswered" | "running";
  status: string | null;
  code: string | null;
};
/**
 * What came back from one query, in the panel's words: a short result and, when it needs one, the
 * reason, from the same messages the panel uses for the code.
 */
export function queryOutcome(
  entry: QueryEntry,
  production: boolean,
): { result: string; detail?: string } {
  const s = source(production);
  const reason = (code: string | null) => (code ? captureMessage(code, production)?.reason : "");
  switch (entry.outcome) {
    case "answered":
      return { result: "Respondida" };
    case "refused":
      if (entry.status === "656")
        return {
          result: "Bloqueada por uma hora",
          detail: captureMessage("SOURCE_CONSUMPTION_BLOCKED", production)!.reason,
        };
      if (entry.status === "108" || entry.status === "109")
        return {
          result: `${production ? "Receita" : "Fonte de teste"} fora do ar (código ${entry.status})`,
        };
      return { result: `Recusada (código ${entry.status ?? "não informado"})` };
    case "not-sent":
      return {
        result: "Não enviada",
        detail:
          reason(entry.code) || `Nada chegou ${production ? "à Receita" : "à fonte de teste"}.`,
      };
    case "stopped":
      return { result: "Não concluída", detail: reason(entry.code) || undefined };
    case "unanswered":
      return {
        result: "Sem resposta",
        detail: `A resposta ${s.from} não chegou; a captura confere antes de seguir.`,
      };
    case "running":
      return { result: "Em andamento" };
  }
}
